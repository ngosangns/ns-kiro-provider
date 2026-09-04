// ABOUTME: Tests the projection from the Harness conversation vocabulary onto the neutral one.

import type { AttachmentId } from "@deepseek-ai/dsh-attachment";
import type { CallId, Message } from "@deepseek-ai/dsh-llm";
import { describe, expect, it } from "vitest";
import { toKiroMessages } from "../src/messages.js";

const message = (input: Partial<Message> & Pick<Message, "role" | "content">): Message =>
  ({ id: "m1", source: { kind: "user" }, ...input }) as Message;

describe("toKiroMessages", () => {
  it("lifts the system role out of the history into the system slot", async () => {
    const out = await toKiroMessages([
      message({ role: "system", content: [{ type: "text", text: "be brief" }] }),
      message({ role: "user", content: [{ type: "text", text: "hi" }] }),
    ]);
    expect(out.system).toBe("be brief");
    expect(out.messages).toEqual([{ role: "user", content: [{ type: "text", text: "hi" }] }]);
  });

  it("joins several system messages rather than letting the last one win", async () => {
    const out = await toKiroMessages([
      message({ role: "system", content: [{ type: "text", text: "first" }] }),
      message({ role: "system", content: [{ type: "text", text: "second" }] }),
    ]);
    expect(out.system).toBe("first\n\nsecond");
  });

  it("reports no system text when the history carries none", async () => {
    const out = await toKiroMessages([message({ role: "user", content: [{ type: "text", text: "hi" }] })]);
    expect(out.system).toBeUndefined();
  });

  it("lifts a tool-result block out of its user message into its own turn", async () => {
    const out = await toKiroMessages([
      message({
        role: "user",
        content: [{ type: "tool-result", toolCallId: "c1" as CallId, content: [{ type: "text", text: "ok" }] }],
      }),
    ]);
    expect(out.messages).toEqual([
      {
        role: "toolResult",
        toolCallId: "c1" as CallId,
        toolName: "tool",
        content: [{ type: "text", text: "ok" }],
        isError: false,
      },
    ]);
  });

  it("keeps plain content ahead of the results that share its message", async () => {
    const out = await toKiroMessages([
      message({
        role: "user",
        content: [
          { type: "text", text: "context" },
          { type: "tool-result", toolCallId: "c1" as CallId, content: [{ type: "text", text: "ok" }] },
        ],
      }),
    ]);
    expect(out.messages.map((m) => m.role)).toEqual(["user", "toolResult"]);
  });

  it("carries the tool-result error flag as a boolean even when absent", async () => {
    const out = await toKiroMessages([
      message({
        role: "user",
        content: [
          { type: "tool-result", toolCallId: "c1" as CallId, isError: true, content: [{ type: "text", text: "boom" }] },
        ],
      }),
    ]);
    expect(out.messages[0]).toMatchObject({ isError: true });
  });

  it("maps reasoning blocks onto thinking and parses tool-call arguments", async () => {
    const out = await toKiroMessages([
      message({
        role: "assistant",
        content: [
          { type: "reasoning", text: "hmm" },
          { type: "tool-call", id: "c1" as CallId, name: "read", arguments: '{"path":"a"}' },
        ],
      }),
    ]);
    expect(out.messages[0]?.content).toEqual([
      { type: "thinking", thinking: "hmm" },
      { type: "toolCall", id: "c1" as CallId, name: "read", arguments: { path: "a" } },
    ]);
  });

  it("keeps an unparseable tool call so its result still has a partner", async () => {
    const out = await toKiroMessages([
      message({
        role: "assistant",
        content: [{ type: "tool-call", id: "c1" as CallId, name: "read", arguments: "{not json" }],
      }),
    ]);
    expect(out.messages[0]?.content).toEqual([{ type: "toolCall", id: "c1" as CallId, name: "read", arguments: {} }]);
  });

  it("drops images when no attachment store is available", async () => {
    const out = await toKiroMessages([
      message({
        role: "user",
        content: [
          { type: "text", text: "look" },
          {
            type: "image",
            attachment: { attachmentId: "a1" as AttachmentId, mediaType: "image/png", bytes: 3, width: 1, height: 1 },
          },
        ],
      }),
    ]);
    expect(out.messages[0]?.content).toEqual([{ type: "text", text: "look" }]);
  });

  it("reads image bytes through the attachment store when one is available", async () => {
    const attachments = {
      readImage: async () => ({ data: new Uint8Array([1, 2, 3]), ref: {} }),
    } as never;
    const out = await toKiroMessages(
      [
        message({
          role: "user",
          content: [
            {
              type: "image",
              attachment: { attachmentId: "a1" as AttachmentId, mediaType: "image/png", bytes: 3, width: 1, height: 1 },
            },
          ],
        }),
      ],
      { attachments },
    );
    expect(out.messages[0]?.content).toEqual([
      { type: "image", data: Buffer.from([1, 2, 3]).toString("base64"), mimeType: "image/png" },
    ]);
  });
});
