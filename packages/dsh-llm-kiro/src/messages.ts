// ABOUTME: Projects the Harness conversation vocabulary onto the neutral one kiro-core reads.

import type { AttachmentStore } from "@deepseek-ai/dsh-attachment";
import type { ContentBlock, Message, ToolResultBlock } from "@deepseek-ai/dsh-llm";
import type { KiroAssistantContent, KiroMessage, KiroUserContent } from "kiro-core";

/**
 * Harness images live in the attachment service, so their bytes are read here
 * rather than carried on the block. A store is optional: without one the images
 * are dropped and the rest of the turn still reaches the model, which is the
 * behaviour a text-only deployment wants.
 */
export interface MessageProjectionContext {
  attachments?: AttachmentStore;
  signal?: AbortSignal;
}

async function userContent(
  blocks: readonly ContentBlock[],
  context: MessageProjectionContext,
): Promise<KiroUserContent[]> {
  const out: KiroUserContent[] = [];
  for (const block of blocks) {
    if (block.type === "text") out.push({ type: "text", text: block.text });
    else if (block.type === "reasoning") out.push({ type: "text", text: block.text });
    else if (block.type === "image" && context.attachments) {
      const stored = await context.attachments.readImage(block.attachment, context.signal);
      out.push({
        type: "image",
        data: Buffer.from(stored.data).toString("base64"),
        mimeType: block.attachment.mediaType,
      });
    }
  }
  return out;
}

function isToolResult(block: ContentBlock): block is ToolResultBlock {
  return block.type === "tool-result";
}

/**
 * Flatten one Harness history into the neutral shape.
 *
 * Two structural differences drive the whole mapping. The Harness has no
 * `toolResult` role — a result is a `tool-result` block inside a user message —
 * so those blocks are lifted into their own neutral messages. And its system
 * prompt travels as a `system`-role message rather than a request field, so
 * system text is returned separately for the caller to pass as the system slot.
 */
export async function toKiroMessages(
  messages: readonly Message[],
  context: MessageProjectionContext = {},
): Promise<{ messages: KiroMessage[]; system?: string }> {
  const out: KiroMessage[] = [];
  const systemParts: string[] = [];

  for (const message of messages) {
    if (message.role === "system") {
      for (const block of message.content) if (block.type === "text") systemParts.push(block.text);
      continue;
    }

    if (message.role === "assistant") {
      const content: KiroAssistantContent[] = [];
      for (const block of message.content) {
        if (block.type === "text") content.push({ type: "text", text: block.text });
        else if (block.type === "reasoning") content.push({ type: "thinking", thinking: block.text });
        else if (block.type === "tool-call") {
          let args: Record<string, unknown>;
          try {
            args = JSON.parse(block.arguments || "{}") as Record<string, unknown>;
          } catch {
            // A stored call whose arguments no longer parse is still part of the
            // exchange the model must see; sending it with empty arguments keeps
            // the call/result pairing Kiro validates, which dropping would break.
            args = {};
          }
          content.push({ type: "toolCall", id: block.id, name: block.name, arguments: args });
        }
      }
      out.push({ role: "assistant", content });
      continue;
    }

    const results = message.content.filter(isToolResult);
    const plain = message.content.filter((block) => !isToolResult(block));
    if (plain.length > 0) out.push({ role: "user", content: await userContent(plain, context) });
    for (const result of results) {
      out.push({
        role: "toolResult",
        toolCallId: result.toolCallId,
        // The Harness correlates a result by id alone and carries no tool name
        // on the block. Kiro's wire format does not read the name back either —
        // `toolUseId` is the whole pairing — so a placeholder is honest here.
        toolName: "tool",
        content: await userContent(result.content, context),
        isError: result.isError === true,
      });
    }
  }

  return { messages: out, ...(systemParts.length > 0 ? { system: systemParts.join("\n\n") } : {}) };
}
