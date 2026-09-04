// ABOUTME: Tests the projection from OMP's conversation vocabulary onto the neutral one.

import type { Message, Tool } from "@oh-my-pi/pi-ai";
import { describe, expect, it } from "vitest";
import { toKiroMessages, toKiroTools } from "../src/messages.js";

const ts = Date.now();

describe("toKiroMessages", () => {
  it("keeps a string user message as one text block", () => {
    const out = toKiroMessages([{ role: "user", content: "hello", timestamp: ts }] as Message[]);
    expect(out).toEqual([{ role: "user", content: [{ type: "text", text: "hello" }] }]);
  });

  it("drops an empty string message rather than sending an empty text block", () => {
    const out = toKiroMessages([{ role: "user", content: "", timestamp: ts }] as Message[]);
    expect(out).toEqual([{ role: "user", content: [] }]);
  });

  it("maps a developer message onto the user role", () => {
    const out = toKiroMessages([{ role: "developer", content: "system-ish", timestamp: ts }] as Message[]);
    expect(out[0]?.role).toBe("user");
  });

  it("carries images with their media type", () => {
    const out = toKiroMessages([
      {
        role: "user",
        content: [
          { type: "text", text: "look" },
          { type: "image", data: "AAAA", mimeType: "image/png" },
        ],
        timestamp: ts,
      },
    ] as Message[]);
    expect(out[0]?.content).toEqual([
      { type: "text", text: "look" },
      { type: "image", data: "AAAA", mimeType: "image/png" },
    ]);
  });

  it("preserves the assistant stop reason so truncation stays detectable", () => {
    const out = toKiroMessages([
      {
        role: "assistant",
        content: [{ type: "text", text: "cut" }],
        api: "kiro-api",
        provider: "kiro",
        model: "m",
        usage: {},
        stopReason: "length",
        timestamp: ts,
      },
    ] as unknown as Message[]);
    expect(out[0]).toMatchObject({ role: "assistant", stopReason: "length" });
  });

  it("parses tool-call arguments that arrive as a JSON string", () => {
    const out = toKiroMessages([
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "c1", name: "read", arguments: '{"path":"a.txt"}' }],
        api: "kiro-api",
        provider: "kiro",
        model: "m",
        usage: {},
        stopReason: "toolUse",
        timestamp: ts,
      },
    ] as unknown as Message[]);
    expect(out[0]?.content[0]).toEqual({
      type: "toolCall",
      id: "c1",
      name: "read",
      arguments: { path: "a.txt" },
    });
  });

  it("drops assistant blocks with no Kiro wire slot instead of flattening them to text", () => {
    const out = toKiroMessages([
      {
        role: "assistant",
        content: [
          { type: "redactedThinking", data: "opaque" },
          { type: "text", text: "kept" },
        ],
        api: "kiro-api",
        provider: "kiro",
        model: "m",
        usage: {},
        stopReason: "stop",
        timestamp: ts,
      },
    ] as unknown as Message[]);
    expect(out[0]?.content).toEqual([{ type: "text", text: "kept" }]);
  });

  it("carries a tool result with its error flag", () => {
    const out = toKiroMessages([
      {
        role: "toolResult",
        toolCallId: "c1",
        toolName: "read",
        content: [{ type: "text", text: "boom" }],
        isError: true,
        timestamp: ts,
      },
    ] as Message[]);
    expect(out[0]).toEqual({
      role: "toolResult",
      toolCallId: "c1",
      toolName: "read",
      content: [{ type: "text", text: "boom" }],
      isError: true,
    });
  });
});

describe("toKiroTools", () => {
  it("returns undefined for an absent or empty catalog", () => {
    expect(toKiroTools(undefined)).toBeUndefined();
    expect(toKiroTools([])).toBeUndefined();
  });

  it("projects name, description, and schema", () => {
    const tools = [{ name: "read", description: "read a file", parameters: { type: "object" } }] as Tool[];
    expect(toKiroTools(tools)).toEqual([{ name: "read", description: "read a file", parameters: { type: "object" } }]);
  });
});
