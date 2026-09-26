// Message transformation: neutral conversation shapes onto Kiro's wire format.

import { createHash } from "node:crypto";

import type { KiroImageContent, KiroMessage, KiroTool, KiroToolResultMessage } from "./types.js";

export interface KiroImage {
  format: string;
  source: { bytes: string };
}
export interface KiroToolUse {
  name: string;
  toolUseId: string;
  input: Record<string, unknown>;
}
export interface KiroToolResult {
  content: Array<{ text: string }>;
  status: "success" | "error";
  toolUseId: string;
}
export interface KiroToolSpec {
  toolSpecification: { name: string; description: string; inputSchema: { json: Record<string, unknown> } };
}
export interface KiroUserInputMessage {
  content: string;
  modelId: string;
  origin: "KIRO_CLI";
  images?: KiroImage[];
  userInputMessageContext?: { toolResults?: KiroToolResult[]; tools?: KiroToolSpec[] };
}
export interface KiroAssistantResponseMessage {
  content: string;
  toolUses?: KiroToolUse[];
}
export interface KiroHistoryEntry {
  userInputMessage?: KiroUserInputMessage;
  assistantResponseMessage?: KiroAssistantResponseMessage;
}

export const TOOL_RESULT_LIMIT = 250000;

/** Kiro's own requirement is content **or** tool results, not content
 *  unconditionally. First-party Kiro Agent states it as an explicit invariant
 *  — `NON_EMPTY_USER_MESSAGE`: "User messages must have either content or tool
 *  results" — and its validator implements `hasContent || hasToolResults`.
 *  It ships `content: ''` on synthesized and consolidated tool turns.
 *
 *  A tool turn therefore needs no text: its payload is
 *  `userInputMessageContext.toolResults`.
 *
 *  This placeholder remains for the case it was added for: a turn that reaches
 *  the request builder with neither text nor tool results — an image-only user
 *  message, or an empty-text user message. Send a neutral prompt there so the
 *  attachments still reach the model. Do not apply it to tool turns; that
 *  fabricates a user utterance the model reads as human. */
export const EMPTY_CONTENT_PLACEHOLDER = "Please proceed with the task.";

export function sanitizeSurrogates(text: string): string {
  // Replace unpaired high surrogates (0xD800-0xDBFF not followed by low surrogate)
  // Replace unpaired low surrogates (0xDC00-0xDFFF not preceded by high surrogate)
  // Properly paired surrogates (e.g. emoji like 🙈) are preserved.
  return text.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "");
}

export function truncate(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const half = Math.floor(limit / 2);
  return `${text.substring(0, half)}\n... [TRUNCATED] ...\n${text.substring(text.length - half)}`;
}

const KIRO_TOOL_USE_ID_PATTERN = /^[a-zA-Z0-9_.:-]{1,64}$/;

/**
 * Preserve native Kiro tool IDs, but deterministically remap IDs from providers
 * whose syntax Kiro rejects (for example OpenAI Responses' 83-character
 * `call_…|fc_…` IDs). Tool uses and results are transformed independently, so
 * the mapping must be stable rather than random.
 */
export function toKiroToolUseId(toolUseId: string): string {
  if (KIRO_TOOL_USE_ID_PATTERN.test(toolUseId)) return toolUseId;
  const digest = createHash("sha256").update(toolUseId).digest("base64url").slice(0, 32);
  return `pi_${digest}`;
}

/**
 * Kiro's tool-name contract, probed against the live service (2026-09-27): any
 * name outside this shape is rejected before the turn runs with
 * `400 {"message":"Invalid tool use format."}` — colons, dots, spaces,
 * non-ASCII, and names over 64 characters all fail, while a leading digit, a
 * hyphen, and an underscore are accepted. The ID pattern above deliberately
 * does NOT apply: it admits `:` and `.`, both rejected here.
 */
const KIRO_TOOL_NAME_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;

/**
 * Project a host's tool name onto the wire-legal space, deterministically so a
 * name sanitizes identically in the spec catalog and in history `toolUses` of
 * the same request and every later one. The digest suffix keeps distinct names
 * distinct after the character rewrite collapses them (`a:b` vs `a.b`), and
 * keeps a >64-char name unique after truncation. The caller maps emitted tool
 * calls back through {@link kiroToolNameAliases}.
 */
export function toKiroToolName(name: string): string {
  if (KIRO_TOOL_NAME_PATTERN.test(name)) return name;
  const clean = name.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 55);
  const digest = createHash("sha256").update(name).digest("base64url").slice(0, 8);
  return `${clean || "tool"}_${digest}`;
}

/**
 * Wire name → host name for every tool whose name {@link toKiroToolName}
 * changed, so a tool call Kiro echoes back under the sanitized alias is
 * reported to the host under the name it actually registered. Names that were
 * already legal need no entry — the wire form IS the host form.
 */
export function kiroToolNameAliases(tools: readonly KiroTool[] | undefined): Map<string, string> {
  const aliases = new Map<string, string>();
  for (const tool of tools ?? []) {
    const wire = toKiroToolName(tool.name);
    if (wire !== tool.name) aliases.set(wire, tool.name);
  }
  return aliases;
}

export function normalizeMessages(messages: KiroMessage[]): KiroMessage[] {
  return messages.filter((msg) => {
    if (msg.role !== "assistant") return true;
    return msg.stopReason !== "error" && msg.stopReason !== "aborted";
  });
}

/**
 * Move each `toolResult` to sit immediately after the assistant turn that
 * issued its `toolCall`, matching by id.
 *
 * Concurrent tool executions appending to one transcript can interleave, so a
 * result arrives behind a LATER assistant turn than the one that called it:
 *
 *     assistant(toolUses=[A]) / user(text) / assistant(toolUses=[B]) / toolResult(A)
 *
 * Bedrock requires the message after a tool use to carry that use's results,
 * matched by id, so this shape is rejected with `400 TOOL_USE_RESULT_MISMATCH`.
 * Without this pass the downstream repair still makes the request sendable, but
 * only by discarding `A`'s real output: `sanitizeHistory` tests pairing
 * POSITIONALLY and drops `assistant(toolUses=[A])` because its next entry is
 * the interjection, after which `A`'s result answers nothing and is stripped.
 *
 * This is a pure reorder. Nothing is fabricated, dropped, or rewritten, and a
 * result whose `toolCall` appears nowhere is left in place for
 * `injectSyntheticToolCalls` to handle. A well-formed transcript — where every
 * result already follows its call — is returned unchanged.
 *
 * The cost is wire chronology: a user turn that interrupted between the call
 * and its result now appears AFTER that result. That misplaces when the user
 * spoke, which is a fidelity loss, but it is not fabrication and it is strictly
 * less lossy than discarding real tool output the model is waiting on.
 */
export function relocateDisplacedToolResults(messages: KiroMessage[]): KiroMessage[] {
  const out: KiroMessage[] = [];
  const pending = [...messages];
  while (pending.length > 0) {
    const msg = pending.shift();
    if (!msg) break;
    out.push(msg);
    if (msg.role !== "assistant") continue;
    // Emit this turn's results in the order the turn declared its calls, so a
    // multi-call turn keeps its results contiguous behind it.
    for (const block of msg.content) {
      if (block.type !== "toolCall") continue;
      const id = block.id;
      // Search only what is still pending: a result already emitted belongs to
      // an earlier turn and must not be pulled forward.
      const at = pending.findIndex((p) => p.role === "toolResult" && p.toolCallId === id);
      if (at >= 0) out.push(...pending.splice(at, 1));
    }
  }
  return out;
}

export function extractImages(msg: KiroMessage): KiroImageContent[] {
  return msg.content.filter((c): c is KiroImageContent => c.type === "image");
}

export function getContentText(msg: KiroMessage): string {
  return msg.content
    .map((c) => {
      if (c.type === "text") return c.text;
      if (c.type === "thinking") return c.thinking;
      return "";
    })
    .join("");
}

/**
 * Bedrock requires a tool's root schema to declare `type: "object"` and rejects
 * the whole request otherwise (`REQUEST_BODY_INVALID`). A host may hand a
 * bare `{}` — valid JSON Schema, and the natural spelling of a no-argument
 * tool — so a missing `type` is filled in rather than relayed verbatim. A
 * schema that already declares one is passed through untouched, whatever it
 * says: the host's declaration wins over a guess here.
 */
function toKiroInputSchema(parameters: Record<string, unknown>): Record<string, unknown> {
  if (parameters && typeof parameters === "object" && !Array.isArray(parameters)) {
    return parameters.type === undefined ? { type: "object", ...parameters } : parameters;
  }
  return { type: "object", properties: {} };
}

export function convertToolsToKiro(tools: KiroTool[]): KiroToolSpec[] {
  return tools.map((tool) => ({
    toolSpecification: {
      name: toKiroToolName(tool.name),
      description: tool.description,
      inputSchema: { json: toKiroInputSchema(tool.parameters) },
    },
  }));
}

export function convertImagesToKiro(images: Array<{ mimeType: string; data: string }>): KiroImage[] {
  return images.map((img) => ({ format: img.mimeType.split("/")[1] || "png", source: { bytes: img.data } }));
}

function toolResultOf(msg: KiroToolResultMessage): KiroToolResult {
  return {
    content: [{ text: truncate(getContentText(msg), TOOL_RESULT_LIMIT) }],
    status: msg.isError ? "error" : "success",
    toolUseId: toKiroToolUseId(msg.toolCallId),
  };
}

export function buildHistory(
  messages: KiroMessage[],
  modelId: string,
  systemPrompt?: string,
): { history: KiroHistoryEntry[]; systemPrepended: boolean; currentMsgStartIdx: number } {
  const history: KiroHistoryEntry[] = [];
  let systemPrepended = false;

  let currentMsgStartIdx = messages.length - 1;
  while (currentMsgStartIdx > 0 && messages[currentMsgStartIdx]?.role === "toolResult") currentMsgStartIdx--;
  const boundary = messages[currentMsgStartIdx];
  if (boundary?.role === "assistant" && !boundary.content.some((b) => b.type === "toolCall")) {
    currentMsgStartIdx++;
  }

  const historyMessages = messages.slice(0, currentMsgStartIdx);

  for (let i = 0; i < historyMessages.length; i++) {
    const msg = historyMessages[i];
    if (!msg) continue;
    if (msg.role === "user") {
      let content = getContentText(msg);
      if (systemPrompt && !systemPrepended) {
        content = `${systemPrompt}\n\n${content}`;
        systemPrepended = true;
      }
      const images = extractImages(msg);
      const uim: KiroUserInputMessage = {
        content: sanitizeSurrogates(content),
        modelId,
        origin: "KIRO_CLI",
        ...(images.length > 0 ? { images: convertImagesToKiro(images) } : {}),
      };
      const prevUim = history[history.length - 1]?.userInputMessage;
      if (prevUim) {
        // Merge into previous user message to maintain alternation without
        // synthetic padding.
        //
        // Join only NON-EMPTY sides. A tool-result carrier has `content: ""`,
        // so an unconditional separator would turn a real user utterance into
        // `"\n\ncontinue"` on the wire — fabricating text onto a message the
        // user actually wrote. Two real utterances still get the separator.
        prevUim.content =
          prevUim.content && uim.content ? `${prevUim.content}\n\n${uim.content}` : prevUim.content || uim.content;
        if (uim.images) prevUim.images = [...(prevUim.images || []), ...uim.images];
      } else {
        history.push({ userInputMessage: uim });
      }
    } else if (msg.role === "assistant") {
      let armContent = "";
      const armToolUses: KiroToolUse[] = [];
      // Tracks whether the turn had *any* block at all. A turn whose only block
      // was thinking yields `armContent === ""`, which the drop guard below
      // would otherwise read as "nothing to say" and delete — silently removing
      // a real turn and breaking ALTERNATING_MESSAGES for the very validator
      // this provider runs pre-send.
      let armHadBlocks = false;
      for (const block of msg.content) {
        if (block.type === "text") {
          armContent += block.text;
          armHadBlocks = true;
        } else if (block.type === "thinking") {
          // Deliberately NOT serialized. Reasoning is excluded from the text
          // channel, matching first-party Kiro Agent's `extractTextContent`,
          // which type-filters to `text` before joining. Flattening it to
          // `<thinking>...</thinking>` writes literal markup into the model's
          // own remembered speech — a dialect this provider would then read
          // back out again in `thinking-parser.ts`.
          armHadBlocks = true;
        } else if (block.type === "toolCall") {
          armToolUses.push({
            name: toKiroToolName(block.name),
            toolUseId: toKiroToolUseId(block.id),
            input: block.arguments,
          });
          armHadBlocks = true;
        }
      }
      // Drop only a turn that genuinely carried nothing. A thinking-only turn is
      // retained with `content: ""`, which is what first-party sends for the
      // same shape.
      if (!armContent && armToolUses.length === 0 && !armHadBlocks) continue;
      history.push({
        assistantResponseMessage: { content: armContent, ...(armToolUses.length > 0 ? { toolUses: armToolUses } : {}) },
      });
    } else {
      const toolResults: KiroToolResult[] = [toolResultOf(msg)];
      const trImages: KiroImageContent[] = [...extractImages(msg)];
      let j = i + 1;
      while (j < historyMessages.length) {
        const next = historyMessages[j];
        if (next?.role !== "toolResult") break;
        toolResults.push(toolResultOf(next));
        trImages.push(...extractImages(next));
        j++;
      }
      i = j - 1;
      const prevTr = history[history.length - 1]?.userInputMessage;
      if (prevTr) {
        // Merge tool results into the previous user message to maintain
        // alternation without synthetic padding. Its `content` is the text a
        // user actually wrote (or a prior turn's tool carrier) — leave it
        // byte-identical. `toolResults` is the payload; text is not needed to
        // carry it, and appending narration here rewrites a human utterance.
        if (trImages.length > 0) prevTr.images = [...(prevTr.images || []), ...convertImagesToKiro(trImages)];
        if (!prevTr.userInputMessageContext) prevTr.userInputMessageContext = {};
        prevTr.userInputMessageContext.toolResults = [
          ...(prevTr.userInputMessageContext.toolResults || []),
          ...toolResults,
        ];
      } else {
        history.push({
          userInputMessage: {
            // Empty by design: `toolResults` is this turn's payload. See
            // EMPTY_CONTENT_PLACEHOLDER for the content-or-toolResults rule.
            content: "",
            modelId,
            origin: "KIRO_CLI",
            ...(trImages.length > 0 ? { images: convertImagesToKiro(trImages) } : {}),
            userInputMessageContext: { toolResults },
          },
        });
      }
    }
  }
  return { history, systemPrepended, currentMsgStartIdx };
}
