import { describe, expect, it } from "vitest";
import { KiroBlockBuffer } from "../src/blocks.js";
import { ThinkingTagParser } from "../src/thinking-parser.js";
import type { KiroStreamEvent } from "../src/types.js";

function run(chunks: string[]): KiroStreamEvent[] {
  const events: KiroStreamEvent[] = [];
  const parser = new ThinkingTagParser(new KiroBlockBuffer((event) => events.push(event)));
  for (const c of chunks) parser.processChunk(c);
  parser.finalize();
  return events;
}

function deltas(events: KiroStreamEvent[], type: string): string {
  return events
    .filter((e) => e.type === type)
    .map((e) => (e as { delta?: string }).delta)
    .join("");
}

/**
 * Maps every emitted index to the block family that used it, failing if one
 * index is ever claimed by both the text and thinking families.
 */
function indexOwners(events: KiroStreamEvent[]): Map<number, string> {
  const owner = new Map<number, string>();
  for (const e of events) {
    const idx = (e as { index?: number }).index;
    if (idx === undefined) continue;
    const kind = e.type.startsWith("thinking") ? "thinking" : "text";
    const existing = owner.get(idx);
    if (existing === undefined) owner.set(idx, kind);
    else expect(existing).toBe(kind);
  }
  return owner;
}

type AssembledBlock = { type: "text"; text: string } | { type: "thinking"; thinking: string };

const textOf = (block: AssembledBlock | undefined): string | undefined =>
  block?.type === "text" ? block.text : undefined;
const thinkingOf = (block: AssembledBlock | undefined): string | undefined =>
  block?.type === "thinking" ? block.thinking : undefined;

/** Rebuild the block list a host would assemble from the emitted events. */
function assemble(events: KiroStreamEvent[]): AssembledBlock[] {
  const byIndex = new Map<number, AssembledBlock>();
  for (const e of events) {
    if (e.type === "text_start") byIndex.set(e.index, { type: "text", text: "" });
    else if (e.type === "thinking_start") byIndex.set(e.index, { type: "thinking", thinking: "" });
    else if (e.type === "text_delta") {
      const block = byIndex.get(e.index);
      if (block?.type === "text") block.text += e.delta;
    } else if (e.type === "thinking_delta") {
      const block = byIndex.get(e.index);
      if (block?.type === "thinking") block.thinking += e.delta;
    }
  }
  return [...byIndex.keys()].sort((a, b) => a - b).map((i) => byIndex.get(i) as AssembledBlock);
}

function makeParser(): { parser: ThinkingTagParser; events: KiroStreamEvent[] } {
  const events: KiroStreamEvent[] = [];
  return { parser: new ThinkingTagParser(new KiroBlockBuffer((event) => events.push(event))), events };
}

describe("Feature 7: Thinking Tag Parser", () => {
  it("emits thinking then text for content with thinking block", async () => {
    const events = run(["<thinking>Let me think</thinking>\n\nAnswer"]);
    const types = events.map((e) => e.type);
    expect(types).toContain("thinking_start");
    expect(types).toContain("text_start");
    expect(deltas(events, "thinking_delta")).toContain("Let me think");
    expect(deltas(events, "text_delta")).toContain("Answer");
  });

  it("emits only text when no thinking block", async () => {
    const events = run(["Just plain text"]);
    expect(events.map((e) => e.type)).not.toContain("thinking_start");
    expect(deltas(events, "text_delta")).toBe("Just plain text");
  });

  it("flushes plain text immediately without waiting for finalize", () => {
    const { parser, events } = makeParser();

    parser.processChunk("Hello world");

    expect(assemble(events)[0]?.type).toBe("text");
    expect(textOf(assemble(events)[0])).toBe("Hello world");
  });

  it("retains only a trailing possible opening-tag prefix between chunks", () => {
    const { parser, events } = makeParser();

    parser.processChunk("Hello <thin");

    expect(assemble(events)[0]?.type).toBe("text");
    expect(textOf(assemble(events)[0])).toBe("Hello ");

    parser.processChunk("king>deep thought</thinking>");
    parser.finalize();

    // Text keeps the index it was created with; thinking is appended after it.
    expect(textOf(assemble(events)[0])).toBe("Hello ");
    expect(assemble(events)[1]?.type).toBe("thinking");
    expect(thinkingOf(assemble(events)[1])).toBe("deep thought");
  });

  it("detects thinking start tag split across chunks", async () => {
    const events = run(["<thin", "king>deep thought</thinking>"]);
    expect(deltas(events, "thinking_delta")).toContain("deep thought");
  });

  it("detects thinking end tag split across chunks", async () => {
    const events = run(["<thinking>thought</thi", "nking>\n\nAnswer"]);
    expect(events.map((e) => e.type)).toContain("thinking_end");
    expect(deltas(events, "text_delta")).toContain("Answer");
  });

  it("strips double newline between thinking and text", async () => {
    const events = run(["<thinking>t</thinking>\n\nAnswer"]);
    expect(deltas(events, "text_delta")).toBe("Answer");
  });

  it("getTextBlockIndex returns null before text emitted", () => {
    const { parser } = makeParser();
    expect(parser.getTextBlockIndex()).toBeNull();
  });

  it("getTextBlockIndex returns 0 for text-only content", () => {
    const { parser } = makeParser();
    parser.processChunk("hello");
    parser.finalize();
    expect(parser.getTextBlockIndex()).toBe(0);
  });

  it("getTextBlockIndex returns 1 after thinking block", () => {
    const { parser } = makeParser();
    parser.processChunk("<thinking>t</thinking>\n\ntext");
    parser.finalize();
    expect(parser.getTextBlockIndex()).toBe(1);
  });

  // =========================================================================
  // Additional thinking tag variants (Task 2.1)
  // =========================================================================

  it("recognizes <think> tags", async () => {
    const events = run(["<think>Let me think</think>\n\nAnswer"]);
    const types = events.map((e) => e.type);
    expect(types).toContain("thinking_start");
    expect(types).toContain("text_start");
    expect(deltas(events, "thinking_delta")).toContain("Let me think");
    expect(deltas(events, "text_delta")).toContain("Answer");
  });

  it("recognizes <reasoning> tags", async () => {
    const events = run(["<reasoning>Step by step</reasoning>\n\nResult"]);
    const types = events.map((e) => e.type);
    expect(types).toContain("thinking_start");
    expect(types).toContain("text_start");
    expect(deltas(events, "thinking_delta")).toContain("Step by step");
    expect(deltas(events, "text_delta")).toContain("Result");
  });

  it("recognizes <thought> tags", async () => {
    const events = run(["<thought>Hmm</thought>\n\nDone"]);
    const types = events.map((e) => e.type);
    expect(types).toContain("thinking_start");
    expect(types).toContain("text_start");
    expect(deltas(events, "thinking_delta")).toContain("Hmm");
    expect(deltas(events, "text_delta")).toContain("Done");
  });

  it("handles <think> split across chunks", async () => {
    const events = run(["<thi", "nk>deep thought</think>\n\nText"]);
    expect(deltas(events, "thinking_delta")).toContain("deep thought");
    expect(deltas(events, "text_delta")).toContain("Text");
  });

  it("handles <reasoning> split across chunks", async () => {
    const events = run(["<reason", "ing>logic</reasoning>\n\nOutput"]);
    expect(deltas(events, "thinking_delta")).toContain("logic");
    expect(deltas(events, "text_delta")).toContain("Output");
  });

  it("handles close tag split across chunks for <think>", async () => {
    const events = run(["<think>idea</th", "ink>\n\nText"]);
    expect(events.map((e) => e.type)).toContain("thinking_end");
    expect(deltas(events, "text_delta")).toContain("Text");
  });

  // =========================================================================
  // Wire order (Kiro API can send text before thinking)
  // =========================================================================

  it("keeps text that arrived before the first thinking region ahead of it", async () => {
    const { parser, events } = makeParser();

    // Simulate Kiro API: text content arrives before thinking
    parser.processChunk("Hello world");
    parser.processChunk("<thinking>reasoning</thinking>");
    parser.finalize();

    // The content array is a record of what the model emitted and when, so the
    // text the model produced first stays first. An earlier revision spliced
    // the thinking block in ahead of it to drive UI order; that made the
    // persisted order contradict the wire and invalidated already-emitted
    // content indices.
    expect(assemble(events).map((b) => b.type)).toEqual(["text", "thinking"]);
    expect((assemble(events)[0] as { text: string }).text).toBe("Hello world");
    expect((assemble(events)[1] as { thinking: string }).thinking).toBe("reasoning");
  });

  it("never reuses a index for two different blocks", async () => {
    const events = run(["Hello world", "<thinking>reasoning</thinking>"]);

    // Each index must name exactly one block for the life of the stream.
    // Splicing a block into the middle of the array broke this: text_start@0
    // and thinking_start@0 were both emitted, so a consumer rebuilding content
    // from events wrote the thinking block over the text it had at index 0.
    const owner = indexOwners(events);
    expect(owner.get(0)).toBe("text");
    expect(owner.get(1)).toBe("thinking");
  });

  it("preserves order for a text -> thinking -> text message", async () => {
    const { parser, events } = makeParser();

    parser.processChunk("before<thinking>mid</thinking>\n\nafter");
    parser.finalize();

    expect(assemble(events).map((b) => b.type)).toEqual(["text", "thinking", "text"]);
    expect((assemble(events)[0] as { text: string }).text).toBe("before");
    expect((assemble(events)[1] as { thinking: string }).thinking).toBe("mid");
    expect((assemble(events)[2] as { text: string }).text).toBe("after");

    // This is the shape the splice aliased worst: it emitted text_start@0 then
    // thinking_start@0 then text_start@2, so index 0 named a text block and a
    // thinking block in the same stream while index 1 was never announced.
    // Order alone does not pin that — assert index ownership as well.
    const owner = indexOwners(events);
    expect([...owner.entries()].sort(([a], [b]) => a - b)).toEqual([
      [0, "text"],
      [1, "thinking"],
      [2, "text"],
    ]);
  });

  it("getTextBlockIndex points at the first text block when text arrives first", () => {
    const { parser } = makeParser();

    parser.processChunk("Hello");
    parser.processChunk("<thinking>t</thinking>");
    parser.finalize();

    // No splice, so the text block keeps the index it was created with.
    expect(parser.getTextBlockIndex()).toBe(0);
  });

  // =========================================================================
  // Multiple thinking regions in a single streamed message
  // =========================================================================

  it("recognizes a second thinking region in the same message", async () => {
    const events = run(["<thinking>first</thinking>\n\nmiddle<thinking>second</thinking>\n\nend"]);
    const thinking = deltas(events, "thinking_delta");
    expect(thinking).toContain("first");
    expect(thinking).toContain("second");
  });

  it("never leaks literal tag text into visible text after the first region", async () => {
    const events = run(["<thinking>first</thinking>\n\nmiddle<thinking>second</thinking>\n\nend"]);
    const text = deltas(events, "text_delta");
    expect(text).not.toContain("<thinking>");
    expect(text).not.toContain("</thinking>");
    expect(text).toBe("middleend");
  });

  it("files each thinking region as its own thinking block", async () => {
    const { parser, events } = makeParser();

    parser.processChunk("<thinking>first</thinking>\n\nmiddle<thinking>second</thinking>\n\nend");
    parser.finalize();

    const thinkingBlocks = assemble(events).filter((b) => b.type === "thinking");
    expect(thinkingBlocks.map((b) => (b as { thinking: string }).thinking)).toEqual(["first", "second"]);
  });

  it("files every region in wire order, alternating with the text between them", async () => {
    const { parser, events } = makeParser();

    parser.processChunk("<thinking>first</thinking>\n\nmiddle<thinking>second</thinking>\n\nend");
    parser.finalize();

    expect(assemble(events).map((b) => b.type)).toEqual(["thinking", "text", "thinking", "text"]);
  });

  it("recognizes a second region using a different tag variant", async () => {
    const events = run(["<think>a</think>\n\nmid<reasoning>b</reasoning>\n\nz"]);
    const thinking = deltas(events, "thinking_delta");
    expect(thinking).toContain("a");
    expect(thinking).toContain("b");
    expect(deltas(events, "text_delta")).toBe("midz");
  });

  it("detects a second region whose open tag is split across chunks", async () => {
    const events = run(["<thinking>a</thinking>\n\nmid<thin", "king>b</thinking>\n\nz"]);
    const thinking = deltas(events, "thinking_delta");
    expect(thinking).toContain("a");
    expect(thinking).toContain("b");
    expect(deltas(events, "text_delta")).toBe("midz");
  });

  it("emits a thinking_end for every region", async () => {
    const events = run(["<thinking>a</thinking>\n\nmid<thinking>b</thinking>\n\nz"]);
    expect(events.filter((e) => e.type === "thinking_end")).toHaveLength(2);
    expect(events.filter((e) => e.type === "thinking_start")).toHaveLength(2);
  });

  it("preserves empty first and later regions as distinct thinking blocks", () => {
    const { parser, events } = makeParser();

    parser.processChunk("<thought></thought>mid<reasoning></reasoning>end");
    parser.finalize();

    expect(assemble(events)).toEqual([
      { type: "thinking", thinking: "" },
      { type: "text", text: "mid" },
      { type: "thinking", thinking: "" },
      { type: "text", text: "end" },
    ]);
  });

  it("emits start and end events for empty first and later regions", async () => {
    const events = run(["<thou", "ght></thought>mid<reasoning></reasoning>end"]);
    const thinkingStarts = events.filter((event) => event.type === "thinking_start");
    const thinkingEnds = events.filter((event) => event.type === "thinking_end");

    expect(thinkingStarts.map((event) => event.index)).toEqual([0, 2]);
    expect(thinkingEnds.map((event) => event.index)).toEqual([0, 2]);
    expect(thinkingEnds.map((event) => event.thinking)).toEqual(["", ""]);
    expect(deltas(events, "text_delta")).toBe("midend");
  });

  it("materializes an empty region after text without moving it ahead of that text", async () => {
    const { parser, events } = makeParser();

    // The intersection of the two guarantees: an empty region must still
    // become its own block, and it must still be appended. The close tag is
    // what materializes it, so this is the one shape where materialization and
    // wire ordering are decided by the same call.
    parser.processChunk("Hello<thinking></thinking>");
    parser.finalize();

    expect(assemble(events)).toEqual([
      { type: "text", text: "Hello" },
      { type: "thinking", thinking: "" },
    ]);
    expect(parser.getTextBlockIndex()).toBe(0);
  });

  it("keeps the text index stable when an empty region follows text", async () => {
    const events = run(["Hello<thinking></thin", "king>"]);
    const owner = new Map<number, string>();
    for (const event of events) {
      const index = (event as { index?: number }).index;
      if (index === undefined) continue;
      const kind = event.type.startsWith("thinking") ? "thinking" : "text";
      const existing = owner.get(index);
      if (existing === undefined) owner.set(index, kind);
      else expect(existing).toBe(kind);
    }

    expect(owner.get(0)).toBe("text");
    expect(owner.get(1)).toBe("thinking");
  });

  it("getTextBlockIndex points at the last text block across regions", () => {
    const { parser, events } = makeParser();

    parser.processChunk("<thinking>a</thinking>\n\nmid<thinking>b</thinking>\n\nz");
    parser.finalize();

    // content: [thinking a, text mid, thinking b, text z]
    expect(parser.getTextBlockIndex()).toBe(3);
    expect((assemble(events)[3] as { text: string }).text).toBe("z");
  });

  it("keeps the last text index when back-to-back regions have no text between them", () => {
    const { parser, events } = makeParser();

    parser.processChunk("<thinking>a</thinking>\n\nmid<thinking>b</thinking><thinking>c</thinking>");
    parser.finalize();

    // content: [thinking a, text mid, thinking b, thinking c]. Closing region c
    // must not erase the index of the "mid" text block: stream.ts relies on it
    // for text_end, bracket tool-call recovery and echo stripping.
    expect(assemble(events).map((b) => b.type)).toEqual(["thinking", "text", "thinking", "thinking"]);
    expect(parser.getTextBlockIndex()).toBe(1);
    expect((assemble(events)[1] as { text: string }).text).toBe("mid");
  });

  it("handles text-before-thinking across multiple chunks", async () => {
    const { parser, events } = makeParser();

    parser.processChunk("Hey! ");
    parser.processChunk("What can I help with?");
    parser.processChunk("<thinking>Let me think about this</thinking>");
    parser.finalize();

    expect(assemble(events).map((b) => b.type)).toEqual(["text", "thinking"]);
    expect((assemble(events)[0] as { text: string }).text).toBe("Hey! What can I help with?");
    expect((assemble(events)[1] as { thinking: string }).thinking).toBe("Let me think about this");
  });
});
