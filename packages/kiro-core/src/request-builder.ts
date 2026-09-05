// ABOUTME: Builds the Kiro runtime request body from a neutral conversation.
// ABOUTME: Pure and side-effect free, so request shaping is testable without a transport.

import { debugLog } from "./debug.js";
import type { KiroAdditionalModelRequestFields } from "./effort.js";
import {
  addPlaceholderTools,
  assertHistoryWithinLimit,
  HISTORY_LIMIT,
  HISTORY_LIMIT_CONTEXT_WINDOW,
  prepareHistory,
} from "./history.js";
import { isKiroToolStructureRule, kiroConversationEntries, repairKiroConversation } from "./history-validator.js";
import type { KiroModel } from "./models.js";
import {
  buildHistory,
  convertImagesToKiro,
  convertToolsToKiro,
  EMPTY_CONTENT_PLACEHOLDER,
  extractImages,
  getContentText,
  type KiroHistoryEntry,
  type KiroImage,
  type KiroToolResult,
  type KiroToolSpec,
  type KiroUserInputMessage,
  normalizeMessages,
  relocateDisplacedToolResults,
  sanitizeSurrogates,
  TOOL_RESULT_LIMIT,
  toKiroToolUseId,
  truncate,
} from "./transform.js";
import { TRUNCATION_NOTICE, wasPreviousResponseTruncated } from "./truncation.js";
import type { KiroMessage, KiroTool } from "./types.js";

export interface KiroRequest {
  conversationState: {
    chatTriggerType: "MANUAL";
    agentTaskType: "vibe";
    conversationId: string;
    currentMessage: { userInputMessage: KiroUserInputMessage };
    history?: KiroHistoryEntry[];
  };
  additionalModelRequestFields?: KiroAdditionalModelRequestFields;
  profileArn: string;
  agentMode?: string;
}

export interface BuildKiroRequestParams {
  messages: KiroMessage[];
  model: KiroModel;
  kiroModelId: string;
  /** Already carries any thinking markers the caller decided to prepend. */
  systemPrompt: string;
  tools?: KiroTool[];
  conversationId: string;
  profileArn: string;
  additionalModelRequestFields?: KiroAdditionalModelRequestFields;
}

/**
 * The request plus what was actually put on the wire.
 *
 * The counts describe the post-repair body, not the caller's input: they exist
 * to be correlated against a rejection, so they must describe the bytes sent.
 */
export interface BuiltKiroRequest {
  request: KiroRequest;
  wireHistoryLength: number;
  wireContentLength: number;
  hasImages: boolean;
  toolResultCount: number;
}

type KiroUserInputMessageContext = { toolResults?: KiroToolResult[]; tools?: KiroToolSpec[] };

function toolResultOf(message: Extract<KiroMessage, { role: "toolResult" }>): KiroToolResult {
  return {
    content: [{ text: truncate(getContentText(message), TOOL_RESULT_LIMIT) }],
    status: message.isError ? "error" : "success",
    toolUseId: toKiroToolUseId(message.toolCallId),
  };
}

/**
 * Assemble the body for one Kiro runtime call.
 *
 * Throws when the local history exceeds its budget, rather than silently
 * dropping context the caller believes it sent.
 */
export function buildKiroRequest(params: BuildKiroRequestParams): BuiltKiroRequest {
  const { messages, model, kiroModelId, systemPrompt, tools, conversationId, profileArn } = params;

  // Relocate a tool result that arrived behind a later assistant turn than the
  // one that called it, before anything positional runs. Interleaved concurrent
  // tool executions produce that shape, and `sanitizeHistory` pairs
  // POSITIONALLY, so without this pass the displaced result's issuing assistant
  // is dropped and the real tool output is discarded.
  const normalized = relocateDisplacedToolResults(normalizeMessages(messages));
  const {
    history: rawHistory,
    systemPrepended,
    currentMsgStartIdx,
  } = buildHistory(normalized, kiroModelId, systemPrompt);
  // Preserve semantic context locally; the host owns lossy compaction.
  const history = prepareHistory(rawHistory, model.input.includes("image"));
  const dynamicHistoryLimit = Math.floor((model.contextWindow / HISTORY_LIMIT_CONTEXT_WINDOW) * HISTORY_LIMIT);
  const currentMessages = normalized.slice(currentMsgStartIdx);
  const firstMsg = currentMessages[0];
  let currentContent = "";
  const currentToolResults: KiroToolResult[] = [];
  let currentImages: KiroImage[] | undefined;

  if (firstMsg?.role === "assistant") {
    let armContent = "";
    const armToolUses: Array<{ name: string; toolUseId: string; input: Record<string, unknown> }> = [];
    for (const block of firstMsg.content) {
      if (block.type === "text") armContent += block.text;
      // Reasoning is deliberately NOT serialized into the assistant text
      // channel, matching `buildHistory`. Flattening it to
      // `<thinking>...</thinking>` writes literal markup into the string the
      // model reads back as its own prior speech.
      else if (block.type === "toolCall") {
        armToolUses.push({ name: block.name, toolUseId: toKiroToolUseId(block.id), input: block.arguments });
      }
    }
    if (armContent || armToolUses.length > 0) {
      const prevArm = history[history.length - 1]?.assistantResponseMessage;
      if (history.length > 0 && !history[history.length - 1]?.userInputMessage && prevArm) {
        // Merge into previous assistant message to maintain alternation
        // without synthetic padding. Join only non-empty sides: a turn that
        // carried only reasoning or only a tool call leaves `armContent`
        // empty, and an unconditional separator would append a bare `\n\n`
        // onto text the model actually produced.
        prevArm.content =
          prevArm.content && armContent ? `${prevArm.content}\n\n${armContent}` : prevArm.content || armContent;
        if (armToolUses.length > 0) prevArm.toolUses = [...(prevArm.toolUses || []), ...armToolUses];
      } else {
        history.push({
          assistantResponseMessage: {
            content: armContent,
            ...(armToolUses.length > 0 ? { toolUses: armToolUses } : {}),
          },
        });
      }
    }
    const toolResultImages = [];
    for (let i = 1; i < currentMessages.length; i++) {
      const m = currentMessages[i];
      if (m?.role !== "toolResult") continue;
      currentToolResults.push(toolResultOf(m));
      toolResultImages.push(...extractImages(m));
    }
    if (toolResultImages.length > 0) currentImages = convertImagesToKiro(toolResultImages);
    // A tool turn carries its payload in `userInputMessageContext.toolResults`,
    // so it needs no text. Leaving this empty also leaves the fallback below
    // free to fill in only genuinely payload-less turns.
    currentContent = "";
  } else if (firstMsg?.role === "toolResult") {
    const toolResultImages = [];
    for (const m of currentMessages) {
      if (m.role !== "toolResult") continue;
      currentToolResults.push(toolResultOf(m));
      toolResultImages.push(...extractImages(m));
    }
    if (toolResultImages.length > 0) currentImages = convertImagesToKiro(toolResultImages);
    // Empty by design — `toolResults` is this turn's payload.
    currentContent = "";
  } else if (firstMsg?.role === "user") {
    currentContent = getContentText(firstMsg);
    if (systemPrompt && !systemPrepended) currentContent = `${systemPrompt}\n\n${currentContent}`;
  }

  // Current assistant tool calls are outbound history too, so enforce the
  // budget only after they have been appended.
  assertHistoryWithinLimit(history, dynamicHistoryLimit);
  if (wasPreviousResponseTruncated(messages)) {
    currentContent = currentContent === "" ? TRUNCATION_NOTICE : `${TRUNCATION_NOTICE}\n\n${currentContent}`;
  }
  // Always synthesize placeholder specs for tool names referenced in history,
  // even when the caller declares none. Without this, a call that inherits a
  // tool-rich conversation but declares no current tools is rejected by Kiro
  // as "Improperly formed request", because history references toolUses with
  // no tool catalog.
  let uimc: KiroUserInputMessageContext | undefined;
  const baseTools = tools?.length ? convertToolsToKiro(tools) : [];
  const finalTools = history.length > 0 ? addPlaceholderTools(baseTools, history) : baseTools;
  if (currentToolResults.length > 0 || finalTools.length > 0) {
    uimc = {};
    if (currentToolResults.length > 0) uimc.toolResults = currentToolResults;
    if (finalTools.length > 0) uimc.tools = finalTools;
  }
  if (firstMsg?.role === "user") {
    const imgs = extractImages(firstMsg);
    if (imgs.length > 0) currentImages = convertImagesToKiro(imgs);
  }
  // A turn with neither text nor tool results has no payload at all: an
  // image-only user message, or an empty-text one. Send a neutral prompt so
  // its attachments still reach the model.
  //
  // The `currentToolResults` guard is load-bearing. Without it this line
  // refills every tool turn that deliberately left `currentContent` empty.
  // Kiro's rule is content **or** tool results — see EMPTY_CONTENT_PLACEHOLDER.
  if (currentContent === "" && currentToolResults.length === 0) currentContent = EMPTY_CONTENT_PLACEHOLDER;

  // Pre-send REPAIR against the rules first-party Kiro Agent enforces.
  // `prepareHistory` covers the shapes this provider itself produces, but not
  // every shape a caller can hand us: `sanitizeHistory` tests tool pairing by
  // POSITION, so an assistant entry with `toolUses` survives whenever the next
  // entry carries any `toolResults` at all, matching ids or not, and
  // `injectSyntheticToolCalls` only rescues orphaned RESULTS. A mismatched
  // pair — both partners present, paired with each other's counterpart —
  // passes both passes untouched and is rejected on the wire with
  // `400 TOOL_USE_RESULT_MISMATCH`.
  //
  // Repair runs on the WHOLE conversation and is split back afterwards.
  // Repairing `history` alone would be wrong in the ordinary case: its last
  // entry is normally the assistant whose `toolUses` this very request
  // answers, so rule 4 would synthesize a FAILED result for a call whose real
  // output is sitting in the current message.
  const conversationEntries = kiroConversationEntries(history, {
    content: currentContent,
    modelId: kiroModelId,
    origin: "KIRO_CLI",
    ...(uimc ? { userInputMessageContext: uimc } : {}),
  });
  const repair = repairKiroConversation(conversationEntries);
  if (repair.diagnostics.length > 0) {
    debugLog("request.invariants", { errors: repair.diagnostics, remaining: repair.remaining });
  }
  // Split back. Repair keeps the current message last in every case but total
  // collapse, where a conversation that is *only* a bare tool-result carrier
  // has no valid opening entry and step 1 consumes it.
  const repairedCurrent = repair.entries[repair.entries.length - 1]?.userInputMessage;
  // Read the repaired context EXACTLY, including when repair removed it. A
  // `?? uimc` fallback would undo the repair in the one case that matters
  // most: stripping every orphaned tool result leaves a turn with no context
  // at all, and falling back would put the orphans — the shape the backend
  // rejects — straight back onto the wire.
  let wireHistory: KiroHistoryEntry[];
  let wireContent: string;
  let wireUimc: KiroUserInputMessageContext | undefined;
  if (repairedCurrent) {
    wireHistory = repair.entries.slice(0, -1);
    wireContent = repairedCurrent.content;
    wireUimc = repairedCurrent.userInputMessageContext;
  } else {
    // Collapsed. Apply what repair would have applied to a lone carrier: drop
    // the results that answer nothing, keep any tool catalog, and give the
    // empty turn the neutral prompt.
    wireHistory = [];
    wireContent = currentContent || EMPTY_CONTENT_PLACEHOLDER;
    wireUimc = uimc?.tools?.length ? { tools: uimc.tools } : undefined;
  }
  if (repair.remaining.length > 0) {
    const structural = repair.remaining.filter((e) => isKiroToolStructureRule(e.rule));
    if (structural.length > 0) {
      console.warn(
        `[kiro-core] outbound history still violates ${structural
          .map((e) => `${e.rule}@${e.index}`)
          .join(", ")} after repair — Kiro may reject this request`,
      );
    }
  }

  return {
    request: {
      conversationState: {
        chatTriggerType: "MANUAL",
        agentTaskType: "vibe",
        conversationId,
        currentMessage: {
          userInputMessage: {
            content: sanitizeSurrogates(wireContent),
            modelId: kiroModelId,
            origin: "KIRO_CLI",
            ...(currentImages ? { images: currentImages } : {}),
            ...(wireUimc ? { userInputMessageContext: wireUimc } : {}),
          },
        },
        ...(wireHistory.length > 0 ? { history: wireHistory } : {}),
      },
      ...(params.additionalModelRequestFields
        ? { additionalModelRequestFields: params.additionalModelRequestFields }
        : {}),
      profileArn,
      agentMode: "vibe",
    },
    wireHistoryLength: wireHistory.length,
    wireContentLength: wireContent.length,
    hasImages: !!currentImages,
    toolResultCount: wireUimc?.toolResults?.length ?? 0,
  };
}
