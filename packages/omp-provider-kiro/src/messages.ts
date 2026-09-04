// ABOUTME: Projects OMP's conversation vocabulary onto the neutral one kiro-core reads.
// ABOUTME: One direction only — responses travel back as stream events, not messages.

import type { ImageContent, Message, TextContent, Tool, ToolCall } from "@oh-my-pi/pi-ai";
import type { KiroAssistantContent, KiroMessage, KiroTool, KiroUserContent } from "kiro-core";

function userContent(content: Message["content"]): KiroUserContent[] {
  if (typeof content === "string") return content ? [{ type: "text", text: content }] : [];
  const out: KiroUserContent[] = [];
  for (const block of content) {
    if (block.type === "text") out.push({ type: "text", text: (block as TextContent).text });
    else if (block.type === "image") {
      const image = block as ImageContent;
      out.push({ type: "image", data: image.data, mimeType: image.mimeType });
    }
  }
  return out;
}

/**
 * OMP carries block kinds this provider has no wire slot for — redacted
 * thinking, Anthropic fallback markers, verbatim server-tool blocks. They are
 * dropped rather than flattened into text: Kiro would read invented markup back
 * as the model's own prior speech.
 */
export function toKiroMessages(messages: Message[]): KiroMessage[] {
  const out: KiroMessage[] = [];
  for (const message of messages) {
    if (message.role === "user" || message.role === "developer") {
      out.push({ role: "user", content: userContent(message.content) });
      continue;
    }
    if (message.role === "toolResult") {
      out.push({
        role: "toolResult",
        toolCallId: message.toolCallId,
        toolName: message.toolName,
        content: userContent(message.content),
        isError: message.isError,
      });
      continue;
    }
    const content: KiroAssistantContent[] = [];
    for (const block of message.content) {
      if (block.type === "text") content.push({ type: "text", text: (block as TextContent).text });
      else if (block.type === "thinking") {
        const thinking = block as { thinking: string; thinkingSignature?: string };
        content.push({
          type: "thinking",
          thinking: thinking.thinking,
          ...(thinking.thinkingSignature ? { thinkingSignature: thinking.thinkingSignature } : {}),
        });
      } else if (block.type === "toolCall") {
        const call = block as ToolCall;
        content.push({
          type: "toolCall",
          id: call.id,
          name: call.name,
          arguments:
            typeof call.arguments === "string"
              ? (JSON.parse(call.arguments) as Record<string, unknown>)
              : call.arguments,
        });
      }
    }
    out.push({ role: "assistant", content, stopReason: message.stopReason });
  }
  return out;
}

export function toKiroTools(tools: Tool[] | undefined): KiroTool[] | undefined {
  if (!tools?.length) return undefined;
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters as Record<string, unknown>,
  }));
}
