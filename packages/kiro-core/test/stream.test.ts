// ABOUTME: End-to-end tests for streamKiro over a mocked Kiro runtime endpoint.
// ABOUTME: Covers request shape, the neutral event sequence, tool calls, and the retry ladder.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { findJsonEnd } from "../src/bracket-tool-parser.js";
import type { KiroModel } from "../src/models.js";
import { capacityRetryConfig } from "../src/retry.js";
import { type KiroStreamRequest, resetProfileArnCache, streamKiro } from "../src/stream.js";
import { EMPTY_CONTENT_PLACEHOLDER } from "../src/transform.js";
import type { KiroMessage, KiroStreamEvent } from "../src/types.js";
import { concatMessages, encodeEventMessage } from "./helpers/event-stream.js";
import { RECORD_279_COMMAND, RECORD_279_SUMMARY, RECORD_279_TEXT } from "./helpers/invoke-fixture.js";

const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

function makeModel(overrides?: Partial<KiroModel>): KiroModel {
  return {
    id: "claude-sonnet-4-5",
    kiroModelId: "claude-sonnet-4.5",
    name: "Sonnet",
    reasoning: false,
    input: ["text", "image"],
    cost: ZERO_COST,
    contextWindow: 200000,
    maxTokens: 65536,
    region: "us-east-1",
    ...overrides,
  };
}

function makeRequest(overrides?: Partial<KiroStreamRequest>): KiroStreamRequest {
  return {
    model: makeModel(),
    messages: [{ role: "user", content: [{ type: "text", text: "Hello" }] }],
    systemPrompt: "You are helpful",
    accessToken: "test-token",
    ...overrides,
  };
}

/** Split `'{"a":1}{"b":2}'` into individual objects, the way the wire concatenates them. */
function parseJsonObjects(body: string): object[] {
  const objects: object[] = [];
  let pos = 0;
  while (pos < body.length) {
    const start = body.indexOf("{", pos);
    if (start < 0) break;
    const end = findJsonEnd(body, start);
    if (end < 0) break;
    objects.push(JSON.parse(body.substring(start, end + 1)));
    pos = end + 1;
  }
  return objects;
}

function encodeBody(body: string): Uint8Array {
  return concatMessages(...parseJsonObjects(body).map((o) => encodeEventMessage(o)));
}

function makeOkResponse(body: string): Response {
  const frames = encodeBody(body);
  return {
    ok: true,
    body: {
      getReader: () => ({
        read: vi
          .fn()
          .mockResolvedValueOnce({ done: false, value: frames })
          .mockResolvedValueOnce({ done: true, value: undefined }),
        releaseLock: () => {},
      }),
      cancel: async () => {},
    },
  } as unknown as Response;
}

/**
 * A response backed by a genuine ReadableStream.
 *
 * `makeOkResponse` hands out a fresh reader on every `getReader()` call, which a
 * real body does not: the second call throws "ReadableStream is locked". Any
 * code path that takes the reader twice therefore passes against the double and
 * fails against the service, so at least one test has to use the real thing.
 */
function makeRealBodyResponse(body: string): Response {
  const frames = encodeBody(body);
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(frames);
      controller.close();
    },
  });
  return { ok: true, body: stream } as unknown as Response;
}

/** One response delivered as several reader chunks, so mid-event splits are exercised. */
function makeChunkedResponse(chunks: string[]): Response {
  const read = vi.fn();
  for (const chunk of chunks) read.mockResolvedValueOnce({ done: false, value: encodeBody(chunk) });
  read.mockResolvedValueOnce({ done: true, value: undefined });
  return {
    ok: true,
    body: { getReader: () => ({ read, releaseLock: () => {} }), cancel: async () => {} },
  } as unknown as Response;
}

function makeErrorResponse(status: number, body: string, statusText = "Error"): Response {
  return {
    ok: false,
    status,
    statusText,
    headers: new Headers(),
    text: () => Promise.resolve(body),
  } as unknown as Response;
}

function stubFetch(...responses: Response[]): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn();
  for (const response of responses) fetchMock.mockResolvedValueOnce(response);
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

async function collect(stream: AsyncGenerator<KiroStreamEvent>): Promise<KiroStreamEvent[]> {
  const events: KiroStreamEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

/**
 * Drive the generator under fake timers so the retry ladder's real backoff
 * (seconds) does not become the test's runtime. Each pull advances fake time
 * until it settles, which is what lets a retry's `abortableDelay` elapse.
 */
async function collectThroughBackoff(stream: AsyncGenerator<KiroStreamEvent>): Promise<KiroStreamEvent[]> {
  const events: KiroStreamEvent[] = [];
  const iterator = stream[Symbol.asyncIterator]();
  for (;;) {
    const next = iterator.next();
    let settled = false;
    next.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    for (let tick = 0; tick < 60 && !settled; tick++) {
      await vi.advanceTimersByTimeAsync(1000);
    }
    const result = await next;
    if (result.done) return events;
    events.push(result.value);
  }
}

function requestBody(fetchMock: ReturnType<typeof vi.fn>, call = 0): Record<string, unknown> {
  const init = fetchMock.mock.calls[call]?.[1] as RequestInit;
  return JSON.parse(init.body as string) as Record<string, unknown>;
}

function userInputMessage(fetchMock: ReturnType<typeof vi.fn>, call = 0): Record<string, unknown> {
  const body = requestBody(fetchMock, call) as {
    conversationState: { currentMessage: { userInputMessage: Record<string, unknown> } };
  };
  return body.conversationState.currentMessage.userInputMessage;
}

const TEXT_ONLY = '{"content":"Hi"}{"contextUsagePercentage":10}';

beforeEach(() => {
  resetProfileArnCache(true);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("streamKiro — request shape", () => {
  it("rejects a call with no access token before touching the network", async () => {
    const fetchMock = stubFetch();
    await expect(collect(streamKiro(makeRequest({ accessToken: "" })))).rejects.toThrow(/credentials not set/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("posts to the region's runtime endpoint with a bearer token", async () => {
    const fetchMock = stubFetch(makeOkResponse(TEXT_ONLY));
    await collect(streamKiro(makeRequest()));

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("generateAssistantResponse");
    expect(url).toContain("us-east-1");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer test-token");
    expect((init.headers as Record<string, string>).Accept).toBe("application/vnd.amazon.eventstream");
  });

  it("carries the model's profileArn instead of resolving one", async () => {
    const fetchMock = stubFetch(makeOkResponse(TEXT_ONLY));
    const profileArn = "arn:aws:codewhisperer:us-east-1:111111111111:profile/from-model";
    await collect(streamKiro(makeRequest({ model: makeModel({ profileArn }) })));

    expect(requestBody(fetchMock).profileArn).toBe(profileArn);
  });

  it("reuses sessionId as the conversationId so a session keeps one thread", async () => {
    const fetchMock = stubFetch(makeOkResponse(TEXT_ONLY));
    await collect(streamKiro(makeRequest({ sessionId: "session-42" })));

    const body = requestBody(fetchMock) as { conversationState: { conversationId: string } };
    expect(body.conversationState.conversationId).toBe("session-42");
  });

  it("sends the placeholder prompt for an image-only turn so the attachment still lands", async () => {
    const fetchMock = stubFetch(makeOkResponse(TEXT_ONLY));
    const messages: KiroMessage[] = [
      { role: "user", content: [{ type: "image", data: "aGVsbG8=", mimeType: "image/png" }] },
    ];
    await collect(streamKiro(makeRequest({ messages, systemPrompt: "" })));

    const uim = userInputMessage(fetchMock);
    expect(uim.content).toBe(EMPTY_CONTENT_PLACEHOLDER);
    expect(uim.images).toBeDefined();
  });

  it("leaves a tool-result turn's content empty, with the results as the payload", async () => {
    const fetchMock = stubFetch(makeOkResponse(TEXT_ONLY));
    const messages: KiroMessage[] = [
      { role: "user", content: [{ type: "text", text: "read it" }] },
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "/tmp/a" } }],
        stopReason: "toolUse",
      },
      {
        role: "toolResult",
        toolCallId: "call-1",
        toolName: "read",
        content: [{ type: "text", text: "file body" }],
        isError: false,
      },
    ];
    await collect(streamKiro(makeRequest({ messages, systemPrompt: "" })));

    const uim = userInputMessage(fetchMock) as {
      content: string;
      userInputMessageContext?: { toolResults?: unknown[] };
    };
    expect(uim.content).toBe("");
    expect(uim.userInputMessageContext?.toolResults).toHaveLength(1);
  });

  it("synthesizes placeholder tool specs when history references tools the caller no longer declares", async () => {
    const fetchMock = stubFetch(makeOkResponse(TEXT_ONLY));
    const messages: KiroMessage[] = [
      { role: "user", content: [{ type: "text", text: "read it" }] },
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "/tmp/a" } }],
        stopReason: "toolUse",
      },
      {
        role: "toolResult",
        toolCallId: "call-1",
        toolName: "read",
        content: [{ type: "text", text: "file body" }],
        isError: false,
      },
      { role: "user", content: [{ type: "text", text: "thanks" }] },
    ];
    await collect(streamKiro(makeRequest({ messages, tools: [], systemPrompt: "" })));

    const uim = userInputMessage(fetchMock) as {
      userInputMessageContext?: { tools?: Array<{ toolSpecification: { name: string } }> };
    };
    const names = uim.userInputMessageContext?.tools?.map((t) => t.toolSpecification.name) ?? [];
    expect(names).toContain("read");
  });

  it("strips lone surrogates from outbound content", async () => {
    const fetchMock = stubFetch(makeOkResponse(TEXT_ONLY));
    const messages: KiroMessage[] = [{ role: "user", content: [{ type: "text", text: "bad \ud800 pair" }] }];
    await collect(streamKiro(makeRequest({ messages, systemPrompt: "" })));

    const content = userInputMessage(fetchMock).content as string;
    expect(content).not.toContain("\ud800");
    expect(content).toContain("bad");
  });
});

describe("streamKiro — streamed event sequence", () => {
  it("emits start, then one text block, then usage and done", async () => {
    stubFetch(makeOkResponse('{"content":"Hello"}{"content":" world"}{"contextUsagePercentage":12}'));
    const events = await collect(streamKiro(makeRequest()));

    expect(events.map((e) => e.type)).toEqual([
      "start",
      "text_start",
      "text_delta",
      "text_delta",
      "text_end",
      "usage",
      "done",
    ]);
    const end = events.find((e) => e.type === "text_end");
    expect(end).toMatchObject({ index: 0, text: "Hello world" });
  });

  it("drops a repeated content frame instead of doubling the text", async () => {
    stubFetch(makeOkResponse('{"content":"Hi"}{"content":"Hi"}{"contextUsagePercentage":5}'));
    const events = await collect(streamKiro(makeRequest()));

    expect(events.filter((e) => e.type === "text_delta")).toHaveLength(1);
    expect(events.find((e) => e.type === "text_end")).toMatchObject({ text: "Hi" });
  });

  it("emits a native thinking block ahead of the text and keeps its signature", async () => {
    stubFetch(
      makeOkResponse('{"text":"weighing it"}{"signature":"sig-abc"}{"content":"Answer"}{"contextUsagePercentage":20}'),
    );
    const events = await collect(streamKiro(makeRequest({ model: makeModel({ reasoning: true }), effort: "high" })));

    const types = events.map((e) => e.type);
    expect(types.indexOf("thinking_start")).toBeLessThan(types.indexOf("text_start"));
    expect(events.find((e) => e.type === "thinking_end")).toMatchObject({
      thinking: "weighing it",
      signature: "sig-abc",
    });
  });

  it("ignores thinking frames when the model is not in a reasoning mode", async () => {
    stubFetch(makeOkResponse('{"text":"hidden"}{"content":"Answer"}{"contextUsagePercentage":20}'));
    const events = await collect(streamKiro(makeRequest()));

    expect(events.some((e) => e.type.startsWith("thinking"))).toBe(false);
    expect(events.find((e) => e.type === "text_end")).toMatchObject({ text: "Answer" });
  });

  it("gives every block its own monotonic index", async () => {
    stubFetch(
      makeOkResponse(
        '{"text":"think"}{"signature":"s"}{"content":"say"}' +
          '{"name":"read","toolUseId":"t1","input":"{\\"path\\":\\"/a\\"}","stop":true}' +
          '{"contextUsagePercentage":30}',
      ),
    );
    const events = await collect(streamKiro(makeRequest({ model: makeModel({ reasoning: true }), effort: "high" })));

    const indexed = events.filter((e): e is Extract<KiroStreamEvent, { index: number }> => "index" in e);
    const firstSeen = [...new Set(indexed.map((e) => e.index))];
    expect(firstSeen).toEqual([...firstSeen].sort((a, b) => a - b));
    expect(new Set(firstSeen).size).toBe(firstSeen.length);
  });
});

describe("streamKiro — tool calls", () => {
  it("emits start, delta and end with parsed arguments", async () => {
    stubFetch(
      makeOkResponse(
        '{"name":"read","toolUseId":"t1","input":"{\\"path\\":\\"/tmp/a\\"}","stop":true}{"contextUsagePercentage":10}',
      ),
    );
    const events = await collect(streamKiro(makeRequest()));

    expect(events.find((e) => e.type === "tool_call_start")).toMatchObject({ id: "t1", name: "read" });
    expect(events.find((e) => e.type === "tool_call_end")).toMatchObject({
      id: "t1",
      name: "read",
      arguments: { path: "/tmp/a" },
    });
    expect(events.find((e) => e.type === "done")).toMatchObject({ stopReason: "toolUse" });
  });

  it("assembles tool input split across frames and reader chunks", async () => {
    stubFetch(
      makeChunkedResponse([
        '{"name":"write","toolUseId":"t9","input":"{\\"path\\":"}',
        '{"input":"\\"/tmp/b\\","}',
        '{"input":"\\"body\\":\\"x\\"}"}{"stop":true}',
        '{"contextUsagePercentage":15}',
      ]),
    );
    const events = await collect(streamKiro(makeRequest()));

    expect(events.find((e) => e.type === "tool_call_end")).toMatchObject({
      arguments: { path: "/tmp/b", body: "x" },
    });
  });

  it("treats an omitted input payload as a zero-argument call", async () => {
    stubFetch(makeOkResponse('{"name":"ping","toolUseId":"t2","input":"","stop":true}{"contextUsagePercentage":10}'));
    const events = await collect(streamKiro(makeRequest()));

    expect(events.find((e) => e.type === "tool_call_end")).toMatchObject({ arguments: {} });
    expect(events.find((e) => e.type === "done")).toMatchObject({ stopReason: "toolUse" });
  });

  it("handles several calls in one response", async () => {
    stubFetch(
      makeOkResponse(
        '{"name":"read","toolUseId":"t1","input":"{\\"path\\":\\"/a\\"}","stop":true}' +
          '{"name":"read","toolUseId":"t2","input":"{\\"path\\":\\"/b\\"}","stop":true}' +
          '{"contextUsagePercentage":10}',
      ),
    );
    const events = await collect(streamKiro(makeRequest()));

    const ends = events.filter((e) => e.type === "tool_call_end");
    expect(ends).toHaveLength(2);
    expect(ends.map((e) => (e as { id: string }).id)).toEqual(["t1", "t2"]);
  });

  it("drops a call whose input never parses, and does not report a tool stop", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    stubFetch(
      makeOkResponse(
        '{"content":"here you go"}{"name":"read","toolUseId":"t3","input":"{not json","stop":true}{"contextUsagePercentage":10}',
      ),
    );
    const events = await collect(streamKiro(makeRequest()));

    expect(events.some((e) => e.type === "tool_call_end")).toBe(false);
    expect(events.find((e) => e.type === "done")).toMatchObject({ stopReason: "stop" });
    expect(warn).toHaveBeenCalled();
  });
});

// `qwen3-coder` stands in for a model the catalog leaves unmarked, where the
// fallback is wanted. Models that emit native tool-use events carry
// `recoverTextToolCalls: false` and are covered at the end of this block.
describe("streamKiro — text-dialect tool-call recovery", () => {
  it("lifts a bracket-dialect call out of the prose and cleans the text", async () => {
    stubFetch(
      makeOkResponse(
        JSON.stringify({ content: 'Sure. [Called read with args: {"path":"/tmp/a"}]' }) +
          '{"contextUsagePercentage":10}',
      ),
    );
    const events = await collect(streamKiro(makeRequest({ model: makeModel({ id: "qwen3-coder" }) })));

    expect(events.find((e) => e.type === "tool_call_end")).toMatchObject({
      name: "read",
      arguments: { path: "/tmp/a" },
    });
    expect((events.find((e) => e.type === "text_end") as { text: string }).text).not.toContain("[Called");
    expect(events.find((e) => e.type === "done")).toMatchObject({ stopReason: "toolUse" });
  });

  it("recovers the XML-dialect leak byte-exactly", async () => {
    stubFetch(makeOkResponse(JSON.stringify({ content: RECORD_279_TEXT }) + '{"contextUsagePercentage":10}'));
    const events = await collect(streamKiro(makeRequest({ model: makeModel({ id: "qwen3-coder" }) })));

    const end = events.find((e) => e.type === "tool_call_end") as {
      name: string;
      arguments: Record<string, unknown>;
    };
    expect(end.name).toBe("shell");
    expect(end.arguments.command).toBe(RECORD_279_COMMAND);
    expect(end.arguments.summary).toBe(RECORD_279_SUMMARY);
  });

  it("leaves prose alone when native tool calls already arrived", async () => {
    stubFetch(
      makeOkResponse(
        JSON.stringify({ content: 'Sure. [Called read with args: {"path":"/tmp/a"}]' }) +
          '{"name":"write","toolUseId":"t1","input":"{}","stop":true}' +
          '{"contextUsagePercentage":10}',
      ),
    );
    const events = await collect(streamKiro(makeRequest({ model: makeModel({ id: "qwen3-coder" }) })));

    const ends = events.filter((e) => e.type === "tool_call_end");
    expect(ends).toHaveLength(1);
    expect(ends[0]).toMatchObject({ name: "write" });
    expect((events.find((e) => e.type === "text_end") as { text: string }).text).toContain("[Called");
  });

  it("does not lift bracket syntax a native-tool-call model merely quoted", async () => {
    stubFetch(
      makeOkResponse(
        JSON.stringify({ content: 'You would write [Called read with args: {"path":"/tmp/a"}] to do that.' }) +
          '{"contextUsagePercentage":10}',
      ),
    );
    const events = await collect(streamKiro(makeRequest({ model: makeModel({ recoverTextToolCalls: false }) })));

    expect(events.some((e) => e.type === "tool_call_end")).toBe(false);
    expect((events.find((e) => e.type === "text_end") as { text: string }).text).toContain("[Called read with args:");
    expect(events.find((e) => e.type === "done")).toMatchObject({ stopReason: "stop" });
  });

  it("does not lift quoted XML syntax into a shell call a native-tool-call model never made", async () => {
    stubFetch(makeOkResponse(JSON.stringify({ content: RECORD_279_TEXT }) + '{"contextUsagePercentage":10}'));
    const events = await collect(streamKiro(makeRequest({ model: makeModel({ recoverTextToolCalls: false }) })));

    expect(events.some((e) => e.type === "tool_call_end")).toBe(false);
    expect(events.find((e) => e.type === "done")).toMatchObject({ stopReason: "stop" });
  });
});

describe("streamKiro — stop reason and usage", () => {
  it("reports stop when the turn is plain text", async () => {
    stubFetch(makeOkResponse(TEXT_ONLY));
    const events = await collect(streamKiro(makeRequest()));

    expect(events.find((e) => e.type === "done")).toMatchObject({ stopReason: "stop" });
  });

  it("reports length when no contextUsage frame ever arrives", async () => {
    stubFetch(makeOkResponse('{"content":"cut off"}'));
    const events = await collect(streamKiro(makeRequest()));

    expect(events.find((e) => e.type === "done")).toMatchObject({ stopReason: "length" });
  });

  it("prefers the wire usage frame and keeps totalTokens consistent", async () => {
    stubFetch(
      makeOkResponse('{"content":"Hi"}{"usage":{"inputTokens":120,"outputTokens":7}}{"contextUsagePercentage":10}'),
    );
    const events = await collect(streamKiro(makeRequest()));

    const usage = (
      events.find((e) => e.type === "usage") as { usage: { input: number; output: number; totalTokens: number } }
    ).usage;
    expect(usage.input).toBe(120);
    expect(usage.output).toBe(7);
    expect(usage.totalTokens).toBe(127);
  });

  it("reads a real ReadableStream body, taking its reader exactly once", async () => {
    stubFetch(makeRealBodyResponse('{"content":"Hi"}{"usage":{"inputTokens":9,"outputTokens":2}}'));
    const events = await collect(streamKiro(makeRequest()));

    expect(events.find((e) => e.type === "text_end")).toMatchObject({ text: "Hi" });
    expect(events.find((e) => e.type === "done")).toBeDefined();
  });

  it("surfaces cache counts the usage frame reports", async () => {
    stubFetch(
      makeOkResponse(
        '{"content":"Hi"}{"usage":{"inputTokens":1000,"outputTokens":7,"cacheReadInputTokens":900,"cacheWriteInputTokens":120}}{"contextUsagePercentage":10}',
      ),
    );
    const events = await collect(streamKiro(makeRequest()));

    const usage = (events.find((e) => e.type === "usage") as { usage: { cacheRead?: number; cacheWrite?: number } })
      .usage;
    expect(usage.cacheRead).toBe(900);
    expect(usage.cacheWrite).toBe(120);
  });

  it("leaves cache counts absent when the usage frame reports none", async () => {
    stubFetch(
      makeOkResponse('{"content":"Hi"}{"usage":{"inputTokens":120,"outputTokens":7}}{"contextUsagePercentage":10}'),
    );
    const events = await collect(streamKiro(makeRequest()));

    const usage = (events.find((e) => e.type === "usage") as { usage: { cacheRead?: number; cacheWrite?: number } })
      .usage;
    expect(usage.cacheRead).toBeUndefined();
    expect(usage.cacheWrite).toBeUndefined();
  });

  it("estimates output tokens when the wire reports none, so tool-only turns are not zero", async () => {
    stubFetch(
      makeOkResponse(
        '{"name":"read","toolUseId":"t1","input":"{\\"path\\":\\"/tmp/a\\"}","stop":true}{"contextUsagePercentage":10}',
      ),
    );
    const events = await collect(streamKiro(makeRequest()));

    const usage = (events.find((e) => e.type === "usage") as { usage: { output: number } }).usage;
    expect(usage.output).toBeGreaterThan(0);
  });

  it("derives input tokens from the reported context percentage", async () => {
    stubFetch(makeOkResponse('{"content":"Hi"}{"contextUsagePercentage":25}'));
    const events = await collect(streamKiro(makeRequest()));

    const usage = (events.find((e) => e.type === "usage") as { usage: { input: number; contextPercent?: number } })
      .usage;
    expect(usage.contextPercent).toBe(25);
    expect(usage.input).toBe(50000);
  });
});

describe("streamKiro — degenerate responses", () => {
  it("strips a Continue echo instead of retrying when the host cannot unsay blocks", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetchMock = stubFetch(makeOkResponse('{"content":"Continue"}{"contextUsagePercentage":10}'));
    const events = await collect(streamKiro(makeRequest({ canDiscardEmittedBlocks: false })));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(events.some((e) => e.type === "reset")).toBe(false);
    expect(events.find((e) => e.type === "text_end")).toMatchObject({ text: "" });
    expect(events.find((e) => e.type === "done")).toMatchObject({ stopReason: "stop" });
  });

  it("retries an echo loop and announces the discard when the host can drop blocks", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetchMock = stubFetch(
      makeOkResponse('{"content":"Continue"}{"contextUsagePercentage":10}'),
      makeOkResponse('{"content":"Real answer"}{"contextUsagePercentage":10}'),
    );
    const events = await collectThroughBackoff(streamKiro(makeRequest({ canDiscardEmittedBlocks: true })));

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(events.some((e) => e.type === "reset")).toBe(true);
    expect(events.find((e) => e.type === "text_end")).toMatchObject({ text: "Real answer" });
  });

  it("keeps block indexes moving forward across a reset", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    stubFetch(
      makeOkResponse('{"content":"Continue"}{"contextUsagePercentage":10}'),
      makeOkResponse('{"content":"Real answer"}{"contextUsagePercentage":10}'),
    );
    const events = await collectThroughBackoff(streamKiro(makeRequest({ canDiscardEmittedBlocks: true })));

    const resetAt = events.findIndex((e) => e.type === "reset");
    const before = events
      .slice(0, resetAt)
      .filter((e): e is Extract<KiroStreamEvent, { index: number }> => "index" in e);
    const after = events.slice(resetAt).filter((e): e is Extract<KiroStreamEvent, { index: number }> => "index" in e);
    expect(Math.min(...after.map((e) => e.index))).toBeGreaterThan(Math.max(...before.map((e) => e.index)));
  });

  it("retries a 200 that carried no content at all, then settles on a normal stop", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetchMock = stubFetch(
      makeOkResponse('{"contextUsagePercentage":10}'),
      makeOkResponse('{"content":"Second time"}{"contextUsagePercentage":10}'),
    );
    const events = await collectThroughBackoff(streamKiro(makeRequest()));

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(events.find((e) => e.type === "text_end")).toMatchObject({ text: "Second time" });
    expect(events.find((e) => e.type === "done")).toMatchObject({ stopReason: "stop" });
  });
});

describe("streamKiro — transport errors", () => {
  it("throws on a 400 that carries no retryable marker", async () => {
    stubFetch(makeErrorResponse(400, '{"message":"Improperly formed request"}', "Bad Request"));
    await expect(collect(streamKiro(makeRequest()))).rejects.toThrow(/Kiro API error: 400/);
  });

  it("does not mistake a malformed-request 400 for a context overflow", async () => {
    stubFetch(makeErrorResponse(400, '{"message":"Improperly formed request"}', "Bad Request"));
    await expect(collect(streamKiro(makeRequest()))).rejects.not.toThrow(/context_length_exceeded/);
  });

  it("phrases a 413 so a host's overflow detector recognizes it", async () => {
    stubFetch(makeErrorResponse(413, "Request entity too large", "Payload Too Large"));
    await expect(collect(streamKiro(makeRequest()))).rejects.toThrow(/context_length_exceeded/);
  });

  it("does not retry a 413", async () => {
    const fetchMock = stubFetch(makeErrorResponse(413, "Request entity too large", "Payload Too Large"));
    await expect(collect(streamKiro(makeRequest()))).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("keeps a quota marker out of the status channel so an outer auto-retry does not fire", async () => {
    stubFetch(makeErrorResponse(429, '{"reason":"MONTHLY_REQUEST_COUNT"}', "Too Many Requests"));
    const error = await collect(streamKiro(makeRequest())).catch((e: Error) => e);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("MONTHLY_REQUEST_COUNT");
    expect((error as Error).message).not.toContain("429");
  });

  it("retries transient capacity pressure without spending the outer retry budget", async () => {
    vi.useFakeTimers();
    const originalDelay = capacityRetryConfig.baseDelayMs;
    capacityRetryConfig.baseDelayMs = 10;
    try {
      const fetchMock = stubFetch(
        makeErrorResponse(429, '{"reason":"INSUFFICIENT_MODEL_CAPACITY"}', "Too Many Requests"),
        makeOkResponse(TEXT_ONLY),
      );
      const events = await collectThroughBackoff(streamKiro(makeRequest()));

      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(events.find((e) => e.type === "done")).toMatchObject({ stopReason: "stop" });
    } finally {
      capacityRetryConfig.baseDelayMs = originalDelay;
    }
  });

  it("gives up on capacity pressure once the budget is exhausted", async () => {
    vi.useFakeTimers();
    const originalDelay = capacityRetryConfig.baseDelayMs;
    capacityRetryConfig.baseDelayMs = 10;
    try {
      const responses = Array.from({ length: capacityRetryConfig.maxRetries + 1 }, () =>
        makeErrorResponse(429, '{"reason":"INSUFFICIENT_MODEL_CAPACITY"}', "Too Many Requests"),
      );
      const fetchMock = stubFetch(...responses);
      await expect(collectThroughBackoff(streamKiro(makeRequest()))).rejects.toThrow(/INSUFFICIENT_MODEL_CAPACITY/);
      expect(fetchMock).toHaveBeenCalledTimes(capacityRetryConfig.maxRetries + 1);
    } finally {
      capacityRetryConfig.baseDelayMs = originalDelay;
    }
  });

  it("throws when a successful response carries no body", async () => {
    stubFetch({ ok: true, body: null } as unknown as Response);
    await expect(collect(streamKiro(makeRequest()))).rejects.toThrow(/No response body/);
  });

  it("surfaces the caller's abort reason", async () => {
    const controller = new AbortController();
    controller.abort(new Error("caller went away"));
    const fetchMock = stubFetch(makeOkResponse(TEXT_ONLY));

    await expect(collect(streamKiro(makeRequest({ signal: controller.signal })))).rejects.toThrow("caller went away");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
