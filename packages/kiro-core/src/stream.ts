// ABOUTME: Core streaming integration for Kiro API requests and responses.
// ABOUTME: Handles request building, retry logic, event parsing, and token counting.

import { appendFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { UniversalEventStreamMarshaller } from "@smithy/core/event-streams";
import type { Message } from "@smithy/types";
import { KiroBlockBuffer } from "./blocks.js";
import { parseBracketToolCalls } from "./bracket-tool-parser.js";
import { calculateKiroCost } from "./cost.js";
import { debugEnabled, debugLog, formatSafeError, redactSensitiveText } from "./debug.js";
import {
  buildKiroAdditionalModelRequestFields,
  clampKiroEffort,
  getKiroEffortConfig,
  type KiroAdditionalModelRequestFields,
} from "./effort.js";
import { getKiroEndpoints } from "./endpoints.js";
import { type KiroWireUsage, parseKiroEvent } from "./event-parser.js";
import {
  addPlaceholderTools,
  assertHistoryWithinLimit,
  HISTORY_LIMIT,
  HISTORY_LIMIT_CONTEXT_WINDOW,
  prepareHistory,
} from "./history.js";
import { isKiroToolStructureRule, kiroConversationEntries, repairKiroConversation } from "./history-validator.js";
import { parseInvokeToolCalls } from "./invoke-tool-parser.js";
import { getKiroCliCredentials, getKiroCliCredentialsAllowExpired, refreshViaKiroCli } from "./kiro-cli.js";
import {
  invalidateKiroProfileArn,
  type KiroManagementAuth,
  KiroManagementHttpError,
  resetKiroProfileArnCache,
  resolveKiroProfileArn,
} from "./management.js";
import { isCacheStale, type KiroModel, resolveKiroModel, updateKiroModelsCache } from "./models.js";
import { kiroAuthHeaders } from "./oauth.js";
import {
  capacityRetryConfig,
  exponentialBackoff,
  extractKiroReason,
  firstTokenTimeoutForModel,
  isCapacityError,
  isNonRetryableBodyError,
  isTooBigError,
  KIRO_REASON_CODES,
  MAX_RETRY_DELAY,
  resolveRequestRateRetryDelay,
  retryConfig,
} from "./retry.js";
import { ThinkingTagParser } from "./thinking-parser.js";
import { kiroTokenTypeHeaders } from "./token-type.js";
import { countTokens } from "./tokenizer.js";
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
import type { KiroEffort, KiroMessage, KiroStreamEvent, KiroTool, KiroUsage } from "./types.js";

const CAPACITY_LOG_DIR = join(homedir(), ".ns-kiro-provider", "logs");
const CAPACITY_LOG_FILE = join(CAPACITY_LOG_DIR, "capacity-retries.log");

const eventStreamMarshaller = new UniversalEventStreamMarshaller({
  utf8Encoder: (input: Uint8Array) => new TextDecoder().decode(input),
  utf8Decoder: (input: string) => new TextEncoder().encode(input),
});

let capacityLogDirCreated = false;

function logCapacityEvent(message: string): void {
  // Fire-and-forget async logging to avoid blocking the event loop
  (async () => {
    try {
      if (!capacityLogDirCreated) {
        await mkdir(CAPACITY_LOG_DIR, { recursive: true });
        capacityLogDirCreated = true;
      }
      await appendFile(CAPACITY_LOG_FILE, `${new Date().toISOString()} ${message}\n`);
    } catch {
      // best-effort logging, don't break the provider
    }
  })();
}

/** Delay that rejects early if the abort signal fires. */
function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function createResponseHeaderDeadline(
  callerSignal: AbortSignal | undefined,
  timeoutMs: number,
): { signal: AbortSignal; didTimeout: () => boolean; cleanup: () => void } {
  const controller = new AbortController();
  let timedOut = false;
  const onCallerAbort = () => {
    clearTimeout(timer);
    callerSignal?.removeEventListener("abort", onCallerAbort);
    controller.abort(callerSignal?.reason);
  };
  const timer = setTimeout(() => {
    timedOut = true;
    callerSignal?.removeEventListener("abort", onCallerAbort);
    controller.abort(new DOMException("Kiro response headers timeout", "TimeoutError"));
  }, timeoutMs);

  if (callerSignal?.aborted) onCallerAbort();
  else callerSignal?.addEventListener("abort", onCallerAbort, { once: true });

  return {
    signal: controller.signal,
    didTimeout: () => timedOut,
    cleanup: () => {
      clearTimeout(timer);
      callerSignal?.removeEventListener("abort", onCallerAbort);
    },
  };
}

interface KiroRequest {
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

interface KiroToolCallState {
  toolUseId: string;
  name: string;
  input: string;
}

/** One model call, fully assembled by the host adapter. */
export interface KiroStreamRequest {
  model: KiroModel;
  messages: KiroMessage[];
  systemPrompt?: string;
  tools?: KiroTool[];
  /** Requested reasoning level; clamped against the model's own ladder. */
  effort?: KiroEffort;
  /** Bearer token for this call. */
  accessToken: string;
  /** Reused as Kiro's `conversationId`, so a session keeps one server-side thread. */
  sessionId?: string;
  profileArn?: string;
  signal?: AbortSignal;
  /**
   * Whether the host can drop blocks it has already been handed. Hosts that can
   * receive a {@link KiroStreamEvent} of type `reset` and discard everything
   * before it; hosts that cannot make the core settle for the terminal
   * behaviour instead of retrying mid-response.
   */
  canDiscardEmittedBlocks?: boolean;
}

let skipProfileResolutionForTests = false;
const TEST_PROFILE_ARN = "arn:aws:codewhisperer:us-east-1:000000000000:profile/test";

/** Reset profile resolution state — exported for stream tests. */
export function resetProfileArnCache(resolved = false): void {
  resetKiroProfileArnCache();
  skipProfileResolutionForTests = resolved;
}

/**
 * Stream one Kiro response as neutral events.
 *
 * Retries live inside this generator: transport timeouts, capacity pressure,
 * request-rate windows, 403 credential rotation, and degenerate 200s all resend
 * without the caller seeing a partial turn — except where the response had
 * already been streamed out, which {@link KiroStreamRequest.canDiscardEmittedBlocks}
 * governs.
 */
export async function* streamKiro(request: KiroStreamRequest): AsyncGenerator<KiroStreamEvent> {
  const { model, signal } = request;
  const pending: KiroStreamEvent[] = [];
  const blocks = new KiroBlockBuffer((event) => pending.push(event));
  const usage: KiroUsage = {
    input: 0,
    output: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };

  const initialAccessToken = request.accessToken;
  if (!initialAccessToken) {
    throw new Error("Kiro credentials not set. Run `kiro-cli login`, or set KIRO_API_KEY.");
  }
  let accessToken = initialAccessToken;
  const region = model.region ?? "us-east-1";
  const endpoint = new URL("generateAssistantResponse", getKiroEndpoints(region).runtime).toString();
  let managementAuth: KiroManagementAuth = { accessToken, region };

  const cliCreds = getKiroCliCredentials() ?? getKiroCliCredentialsAllowExpired();
  const cliProfileArn = cliCreds?.access === accessToken ? cliCreds.profileArn : undefined;
  const initialProfileArn = model.profileArn || request.profileArn || cliProfileArn;
  let profileArn: string;
  try {
    profileArn =
      initialProfileArn ||
      (skipProfileResolutionForTests ? TEST_PROFILE_ARN : await resolveKiroProfileArn(managementAuth));
  } catch (error) {
    if (!(error instanceof KiroManagementHttpError) || error.status !== 403) throw error;

    // The host may have captured an access token before kiro-cli rotated it.
    // Re-read the shared store first, then force a refresh only when it still
    // contains the rejected token. Profile discovery must succeed before the
    // runtime request can be constructed.
    const storedCreds = getKiroCliCredentials();
    const freshCreds = storedCreds?.access && storedCreds.access !== accessToken ? storedCreds : refreshViaKiroCli();
    if (!freshCreds?.access) throw error;

    accessToken = freshCreds.access;
    managementAuth = { accessToken, region };
    profileArn =
      freshCreds.profileArn ||
      (skipProfileResolutionForTests ? TEST_PROFILE_ARN : await resolveKiroProfileArn(managementAuth));
  }

  // Refresh the catalog in the background when it has gone stale.
  if (!process.env.VITEST && isCacheStale(region)) {
    updateKiroModelsCache(accessToken, region, profileArn).catch((error) => {
      console.warn(`[kiro-core] Failed to refresh Kiro model catalog in ${region}: ${formatSafeError(error)}`);
    });
  }

  const kiroModelId = resolveKiroModel(model.id, model.kiroModelId);
  const effort = clampKiroEffort(model, request.effort);
  const effortConfig = getKiroEffortConfig(model.additionalModelRequestFieldsSchema, kiroModelId);
  const additionalModelRequestFields = buildKiroAdditionalModelRequestFields(model, kiroModelId, request.effort);
  const thinkingEnabled = !!effort || model.reasoning;
  debugLog("request.init", {
    endpoint,
    model: model.id,
    kiroModelId,
    contextWindow: model.contextWindow,
    thinkingEnabled,
    reasoning: effort,
    messageCount: request.messages.length,
    toolCount: request.tools?.length ?? 0,
    hasSystemPrompt: !!request.systemPrompt,
    profileArn,
    sessionId: request.sessionId,
  });

  let systemPrompt = request.systemPrompt ?? "";
  // Kiro's runtime endpoint honors structured effort but only exposes Claude's
  // user-visible thinking stream when the legacy thinking markers are also
  // present. Keep both controls: structured fields select effort, while these
  // markers preserve the <thinking> content consumed by ThinkingTagParser.
  if (thinkingEnabled && effortConfig?.field !== "reasoning") {
    const budget =
      effort === "xhigh" || effort === "max" ? 50000 : effort === "high" ? 30000 : effort === "medium" ? 20000 : 10000;
    systemPrompt = `<thinking_mode>enabled</thinking_mode><max_thinking_length>${budget}</max_thinking_length>${systemPrompt ? `\n${systemPrompt}` : ""}`;
  }

  let retryCount = 0;
  const maxRetries = 3;
  const conversationId = request.sessionId ?? crypto.randomUUID();

  requestLoop: while (retryCount <= maxRetries) {
    if (signal?.aborted) throw signal.reason;
    // Relocate a tool result that arrived behind a later assistant turn than
    // the one that called it, before anything positional runs. Interleaved
    // concurrent tool executions produce that shape, and `sanitizeHistory`
    // pairs POSITIONALLY, so without this pass the displaced result's issuing
    // assistant is dropped and the real tool output is discarded.
    const normalized = relocateDisplacedToolResults(normalizeMessages(request.messages));
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
        currentToolResults.push({
          content: [{ text: truncate(getContentText(m), TOOL_RESULT_LIMIT) }],
          status: m.isError ? "error" : "success",
          toolUseId: toKiroToolUseId(m.toolCallId),
        });
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
        currentToolResults.push({
          content: [{ text: truncate(getContentText(m), TOOL_RESULT_LIMIT) }],
          status: m.isError ? "error" : "success",
          toolUseId: toKiroToolUseId(m.toolCallId),
        });
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
    if (wasPreviousResponseTruncated(request.messages)) {
      currentContent = currentContent === "" ? TRUNCATION_NOTICE : `${TRUNCATION_NOTICE}\n\n${currentContent}`;
    }
    // Always synthesize placeholder specs for tool names referenced in history,
    // even when the caller declares none. Without this, a call that inherits a
    // tool-rich conversation but declares no current tools is rejected by Kiro
    // as "Improperly formed request", because history references toolUses with
    // no tool catalog.
    let uimc: { toolResults?: KiroToolResult[]; tools?: KiroToolSpec[] } | undefined;
    const baseTools = request.tools?.length ? convertToolsToKiro(request.tools) : [];
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
    let wireUimc: typeof uimc;
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

    const kiroRequest: KiroRequest = {
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
      ...(additionalModelRequestFields ? { additionalModelRequestFields } : {}),
      profileArn,
      agentMode: "vibe",
    };

    let response!: Response;
    // Reset per outer iteration — each 403 retry gets a fresh capacity budget.
    let capacityRetryCount = 0;
    // Inner loop: retry capacity errors without consuming outer retry budget.
    while (true) {
      const mid = crypto.randomUUID().replace(/-/g, "");
      const ua = `aws-sdk-rust/1.0.0 ua/2.1 os/other lang/rust api/codewhispererstreaming#1.28.3 m/E app/AmazonQ-For-CLI md/appVersion-1.28.3-${mid}`;
      debugLog("request.send", {
        attempt: retryCount,
        capacityAttempt: capacityRetryCount,
        // Wire values, not pre-repair ones: this line is what a reader
        // correlates against a 400, so it must describe the bytes actually sent.
        historyLen: wireHistory.length,
        currentContentLen: wireContent.length,
        hasImages: !!currentImages,
        toolResultCount: wireUimc?.toolResults?.length ?? 0,
        request: kiroRequest,
      });
      const responseHeaderDeadline = createResponseHeaderDeadline(signal, retryConfig.requestHeaderTimeoutMs);
      let responseHeadersTimedOut = false;
      try {
        response = await fetch(endpoint, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/vnd.amazon.eventstream",
            ...kiroAuthHeaders(accessToken),
            ...kiroTokenTypeHeaders(accessToken),
            "x-amzn-codewhisperer-optout": "true",
            "amz-sdk-invocation-id": crypto.randomUUID(),
            "amz-sdk-request": "attempt=1; max=1",
            "x-amzn-kiro-agent-mode": "vibe",
            "x-amz-user-agent": ua,
            "user-agent": ua,
          },
          body: JSON.stringify(kiroRequest),
          signal: responseHeaderDeadline.signal,
        });
      } catch (error) {
        if (!responseHeaderDeadline.didTimeout() || signal?.aborted) throw error;
        responseHeadersTimedOut = true;
      } finally {
        responseHeaderDeadline.cleanup();
      }
      if (responseHeadersTimedOut) {
        if (retryCount >= maxRetries) throw new Error("Kiro API error: response headers timeout after max retries");
        retryCount++;
        await abortableDelay(exponentialBackoff(retryCount - 1, 1000, MAX_RETRY_DELAY), signal);
        continue requestLoop;
      }
      if (!response.ok) {
        let errText = "";
        try {
          errText = redactSensitiveText(await response.text());
        } catch {
          errText = "";
        }
        const safeStatusText = redactSensitiveText(response.statusText);
        const reasonCode = extractKiroReason(errText);
        const isRequestRateExceeded =
          response.status === 429 &&
          reasonCode === KIRO_REASON_CODES.USER_REQUEST_RATE_EXCEEDED &&
          !isNonRetryableBodyError(errText) &&
          !isCapacityError(errText);
        debugLog("response.error", {
          status: response.status,
          statusText: safeStatusText,
          ...(isRequestRateExceeded ? { reasonCode } : { body: errText }),
        });
        // Retry transient capacity errors with longer backoff.
        if (isCapacityError(errText) && capacityRetryCount < capacityRetryConfig.maxRetries) {
          capacityRetryCount++;
          const delayMs = exponentialBackoff(capacityRetryCount - 1, capacityRetryConfig.baseDelayMs, 30_000);
          logCapacityEvent(
            `INSUFFICIENT_MODEL_CAPACITY — retrying in ${delayMs}ms (${capacityRetryCount}/${capacityRetryConfig.maxRetries})`,
          );
          await abortableDelay(delayMs, signal);
          continue;
        }
        if (isCapacityError(errText)) {
          logCapacityEvent(
            `INSUFFICIENT_MODEL_CAPACITY — exhausted ${capacityRetryConfig.maxRetries} retries, giving up`,
          );
        }
        if (isRequestRateExceeded) {
          if (retryCount >= maxRetries) {
            throw new Error(
              `Kiro API error: request window retry budget exhausted (${KIRO_REASON_CODES.USER_REQUEST_RATE_EXCEEDED})`,
            );
          }
          retryCount++;
          const retryDelay = resolveRequestRateRetryDelay(response.headers);
          debugLog("request.rateWindowRetry", {
            attempt: retryCount,
            maxRetries,
            delayMs: retryDelay.delayMs,
            advertisedDelayMs: retryDelay.advertisedDelayMs,
            capped: retryDelay.capped,
            reasonCode,
          });
          await abortableDelay(retryDelay.delayMs, signal);
          continue requestLoop;
        }
        if (response.status === 403 && !isCapacityError(errText) && retryCount < maxRetries) {
          retryCount++;
          // Re-read the shared store first in case another process already
          // rotated the token. If it still contains the rejected token, force
          // kiro-cli to refresh before retrying runtime.
          invalidateKiroProfileArn(managementAuth);
          const rejectedAccessToken = accessToken;
          const rejectedProfileArn = profileArn;
          const storedCreds = getKiroCliCredentials();
          const rejectedCliCreds =
            storedCreds?.access === rejectedAccessToken
              ? storedCreds
              : cliCreds?.access === rejectedAccessToken
                ? cliCreds
                : undefined;
          const freshCreds =
            storedCreds?.access && storedCreds.access !== rejectedAccessToken ? storedCreds : refreshViaKiroCli();
          if (freshCreds?.access) accessToken = freshCreds.access;
          managementAuth = { accessToken, region };

          // Social profiles may not be discoverable through management. Carry
          // the profile used by the rejected request only across a confirmed
          // desktop-to-desktop credential replacement.
          const inheritedDesktopProfileArn =
            rejectedCliCreds?.authMethod === "desktop" && freshCreds?.authMethod === "desktop"
              ? rejectedProfileArn
              : undefined;
          profileArn =
            freshCreds?.profileArn ||
            inheritedDesktopProfileArn ||
            (skipProfileResolutionForTests ? TEST_PROFILE_ARN : await resolveKiroProfileArn(managementAuth));
          await abortableDelay(exponentialBackoff(retryCount - 1, 500, MAX_RETRY_DELAY), signal);
          break; // break inner loop, continue outer loop
        }
        // Known quota/capacity body markers must not be re-read by a host's own
        // outer auto-retry as a generic retryable 429.
        if (isNonRetryableBodyError(errText) || isCapacityError(errText)) {
          throw new Error(`Kiro API error: ${errText || safeStatusText}`);
        }
        // Phrase overflow so a host's context-overflow detector recognizes it.
        if (isTooBigError(response.status, errText)) {
          throw new Error(`Kiro API error: context_length_exceeded (${response.status} ${errText})`);
        }
        throw new Error(`Kiro API error: ${response.status} ${safeStatusText} ${errText}`);
      }
      break; // success, break inner loop
    }
    if (capacityRetryCount > 0 && response.ok) {
      logCapacityEvent(`INSUFFICIENT_MODEL_CAPACITY — succeeded after ${capacityRetryCount} retries`);
    }
    // 403 retry: continue outer loop
    if (!response.ok) continue;

    yield { type: "start" };
    if (!response.body) throw new Error("No response body");
    const bodyReader = (response.body as ReadableStream<Uint8Array>).getReader();
    let totalContent = "";
    let lastContentData = "";
    let usageEvent: KiroWireUsage | null = null;
    let receivedContextUsage = false;
    const thinkingParser = thinkingEnabled ? new ThinkingTagParser(blocks) : null;
    let nativeThinkingBlockIndex: number | null = null;
    let nativeThinkingEnded = false;
    const ensureNativeThinkingBlock = (): number => {
      if (nativeThinkingBlockIndex === null) nativeThinkingBlockIndex = blocks.openThinking();
      return nativeThinkingBlockIndex;
    };
    const endNativeThinking = (signature?: string) => {
      if (nativeThinkingBlockIndex === null || nativeThinkingEnded) return;
      nativeThinkingEnded = true;
      blocks.endThinking(nativeThinkingBlockIndex, signature);
    };
    let textBlockIndex: number | null = null;
    let emittedToolCalls = 0;
    let sawAnyToolCalls = false;
    let currentToolCall: KiroToolCallState | null = null;

    const emitToolCall = (state: KiroToolCallState): boolean => {
      if (!state.input.trim()) {
        // Kiro omits the input payload when the model calls a tool with no
        // arguments (e.g. `mcp({})`). Treat empty input as an empty object
        // rather than skipping — these are valid zero-arg calls, not truncations.
        state.input = "{}";
      }
      let args: Record<string, unknown>;
      try {
        args = JSON.parse(state.input) as Record<string, unknown>;
      } catch (e) {
        console.warn(
          `[kiro-core] Failed to parse tool input for "${state.name}" (toolUseId: ${state.toolUseId}): ${formatSafeError(e)}. Raw input (${state.input.length} chars): ${redactSensitiveText(state.input.substring(0, 200))}`,
        );
        return false;
      }
      const index = blocks.reserve();
      pending.push({ type: "tool_call_start", index, id: state.toolUseId, name: state.name });
      pending.push({ type: "tool_call_delta", index, id: state.toolUseId, argumentsDelta: state.input });
      pending.push({ type: "tool_call_end", index, id: state.toolUseId, name: state.name, arguments: args });
      return true;
    };
    const flushToolCall = () => {
      if (!currentToolCall) return;
      if (emitToolCall(currentToolCall)) emittedToolCalls++;
      currentToolCall = null;
    };

    const IDLE_TIMEOUT = 300_000;
    let idleTimer: ReturnType<typeof setTimeout> | null = null;
    let idleCancelled = false;
    const resetIdle = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        idleCancelled = true;
        void bodyReader.cancel().catch(() => {});
      }, IDLE_TIMEOUT);
    };
    let gotFirstToken = false;
    let firstTokenTimedOut = false;
    let streamError: string | null = null;
    const FIRST_TOKEN_SENTINEL = Symbol("firstTokenTimeout");

    // Smithy's marshaller handles chunk reassembly, CRC validation, protocol
    // error/exception detection, and payload deserialization.
    const bodyIterable: AsyncIterable<Uint8Array> = {
      async *[Symbol.asyncIterator]() {
        try {
          while (true) {
            const { done, value } = await bodyReader.read();
            if (done) return;
            yield value;
          }
        } finally {
          bodyReader.releaseLock();
        }
      },
    };
    const utf8Decoder = new TextDecoder();
    const eventStream = eventStreamMarshaller.deserialize(bodyIterable, async (event: Record<string, Message>) => {
      const entry = Object.entries(event)[0];
      if (!entry) throw new Error("Received an empty event stream message");
      const [key, msg] = entry;
      const parsed = JSON.parse(utf8Decoder.decode(msg.body)) as Record<string, unknown>;
      return { [key]: parsed } as Record<string, unknown>;
    });
    const iterator = eventStream[Symbol.asyncIterator]() as AsyncIterator<Record<string, unknown>>;

    while (true) {
      let iterResult: IteratorResult<Record<string, unknown>>;
      try {
        if (!gotFirstToken) {
          const readPromise = iterator.next();
          const result = await Promise.race([
            readPromise,
            new Promise<typeof FIRST_TOKEN_SENTINEL>((resolve) =>
              setTimeout(
                () => resolve(FIRST_TOKEN_SENTINEL),
                model.firstTokenTimeout ?? firstTokenTimeoutForModel(model.id),
              ),
            ),
          ]);
          if (result === FIRST_TOKEN_SENTINEL) {
            readPromise.catch(() => {}); // suppress dangling rejection
            void bodyReader.cancel().catch(() => {});
            firstTokenTimedOut = true;
            break;
          }
          iterResult = result as IteratorResult<Record<string, unknown>>;
          gotFirstToken = true;
          resetIdle();
        } else {
          iterResult = await iterator.next();
        }
      } catch (e) {
        // Smithy throws on `:message-type` error/exception headers.
        streamError =
          e instanceof Error
            ? e.message
            : (typeof e === "object" && e !== null ? JSON.stringify(e) : String(e)) || "Unknown stream error";
        break;
      }
      const { done, value } = iterResult;
      if (done) break;
      resetIdle();
      const eventPayload = Object.values(value as Record<string, unknown>)[0] as Record<string, unknown>;
      const event = parseKiroEvent(eventPayload);
      if (!event) continue;
      if (debugEnabled()) debugLog("stream.events", [event]);
      switch (event.type) {
        case "contextUsage": {
          const pct = event.data.contextUsagePercentage;
          usage.input = Math.round((pct / 100) * model.contextWindow);
          usage.contextPercent = pct;
          receivedContextUsage = true;
          break;
        }
        case "thinkingText": {
          if (!thinkingEnabled) break;
          blocks.appendThinking(ensureNativeThinkingBlock(), event.data);
          totalContent += event.data;
          break;
        }
        case "thinkingSignature": {
          if (!thinkingEnabled) break;
          ensureNativeThinkingBlock();
          endNativeThinking(event.data);
          break;
        }
        case "content": {
          endNativeThinking();
          if (event.data === lastContentData) continue;
          lastContentData = event.data;
          totalContent += event.data;
          if (thinkingParser) {
            thinkingParser.processChunk(event.data);
          } else {
            if (textBlockIndex === null) textBlockIndex = blocks.openText();
            blocks.appendText(textBlockIndex, event.data);
          }
          break;
        }
        case "toolUse": {
          const tc = event.data;
          sawAnyToolCalls = true;
          if (!currentToolCall || currentToolCall.toolUseId !== tc.toolUseId) {
            flushToolCall();
            currentToolCall = { toolUseId: tc.toolUseId, name: tc.name, input: "" };
          }
          currentToolCall.input += tc.input || "";
          if (tc.input) totalContent += tc.input;
          if (tc.stop) flushToolCall();
          break;
        }
        case "toolUseInput": {
          if (currentToolCall) currentToolCall.input += event.data.input || "";
          if (event.data.input) totalContent += event.data.input;
          break;
        }
        case "toolUseStop": {
          if (event.data.stop) flushToolCall();
          break;
        }
        case "usage": {
          usageEvent = event.data;
          // The parsed event keeps only the fields this package understands.
          // Log the frame verbatim so a field Kiro adds — cache counters above
          // all — is visible without having to guess its name first.
          if (debugEnabled()) debugLog("response.usageRaw", eventPayload);
          break;
        }
        case "error": {
          streamError = event.data.message ? `${event.data.error}: ${event.data.message}` : event.data.error;
          void bodyReader.cancel().catch(() => {});
          break;
        }
        // followupPrompt events are intentionally ignored
      }
      yield* drain(pending);
      if (streamError) break;
    }
    yield* drain(pending);
    if (idleTimer) clearTimeout(idleTimer);

    if (firstTokenTimedOut || idleCancelled || streamError) {
      // Timed out or received an error mid-stream: retry with backoff.
      if (retryCount < maxRetries) {
        retryCount++;
        await abortableDelay(exponentialBackoff(retryCount - 1, 1000, MAX_RETRY_DELAY), signal);
        continue;
      }
      if (streamError) throw new Error(`Kiro API stream error after max retries: ${streamError}`);
      throw new Error(`Kiro API error: ${firstTokenTimedOut ? "first token" : "idle"} timeout after max retries`);
    }

    if (currentToolCall && emitToolCall(currentToolCall)) emittedToolCalls++;
    currentToolCall = null;
    endNativeThinking();
    if (thinkingParser) {
      thinkingParser.finalize();
      textBlockIndex = thinkingParser.getTextBlockIndex();
    }
    yield* drain(pending);

    // Fallback: extract text-dialect tool calls from content if no native tool
    // calls arrived. Two dialects are recovered at this seam:
    //   1. Kiro's own `[Called name with args: {...}]` bracket form.
    //   2. Anthropic's `<invoke name="..."><parameter .../></invoke>` XML form,
    //      which opus-class models emit as plain text at high context.
    // Without this, the turn ends `stop` with zero tool calls — the agent loop
    // sees a finished answer and an unattended session stalls with no error
    // recorded anywhere.
    //
    // Models that emit native tool-use events opt out via
    // `recoverTextToolCalls: false`. For them this pass has nothing to rescue
    // and everything to break: prose that merely *quotes* the syntax — a model
    // explaining how a tool is called — would be lifted into a real call the
    // model never made. Absent means recover, so a model the catalog says
    // nothing about keeps the fallback.
    if (model.recoverTextToolCalls !== false && !sawAnyToolCalls && textBlockIndex !== null) {
      let text = blocks.getText(textBlockIndex);
      const recovered: Array<{ toolUseId: string; name: string; arguments: Record<string, unknown> }> = [];
      const bracketResult = parseBracketToolCalls(text);
      if (bracketResult.toolCalls.length > 0) {
        text = bracketResult.cleanedText;
        recovered.push(...bracketResult.toolCalls);
      }
      const invokeResult = parseInvokeToolCalls(text);
      if (invokeResult.toolCalls.length > 0) {
        text = invokeResult.cleanedText;
        recovered.push(...invokeResult.toolCalls);
      }
      if (recovered.length > 0) {
        blocks.setText(textBlockIndex, text);
        sawAnyToolCalls = true;
        for (const call of recovered) {
          if (emitToolCall({ toolUseId: call.toolUseId, name: call.name, input: JSON.stringify(call.arguments) })) {
            emittedToolCalls++;
          }
        }
      }
    }

    // Strip echo noise: when tool calls are present and the text content is just
    // "." or a similar short echo from history padding, remove it. This prevents
    // the echo from accumulating in conversation history and reinforcing the
    // pattern in future turns.
    if (emittedToolCalls > 0 && textBlockIndex !== null) {
      if (/^\s*(\.+|continue)\s*$/i.test(blocks.getText(textBlockIndex))) blocks.setText(textBlockIndex, "");
    }

    // Detect degenerate responses: the API returned 200 but produced no usable
    // content at all — no text and no tool calls. This happens when the stream
    // is truncated early or only a contextUsage event arrives.
    //
    // Also detect "Continue" echo loops, where the entire response is just
    // "continue" with no tool calls, taught by synthetic history padding.
    //
    // When tool calls *were* present but all got dropped (empty/unparseable
    // input), don't retry — the API did respond, it just sent malformed tool
    // calls. Retrying would likely produce the same result.
    const responseText = textBlockIndex === null ? "" : blocks.getText(textBlockIndex);
    const hasText = responseText.length > 0;
    const isEchoLoop = hasText && !sawAnyToolCalls && /^\s*(continue|\.+)\s*$/i.test(responseText);
    if ((!hasText && !sawAnyToolCalls) || isEchoLoop) {
      // Retrying an echo loop means unsaying text already delivered, which only
      // a host that can discard emitted blocks may do. Elsewhere, go straight to
      // the terminal behaviour: strip the echo so the agent loop does not read
      // "Continue" as a continuation signal.
      const mayRetry = retryCount < maxRetries && (!isEchoLoop || request.canDiscardEmittedBlocks === true);
      if (mayRetry) {
        retryCount++;
        console.warn(
          `[kiro-core] ${isEchoLoop ? 'Echo loop detected (model responded with just "Continue")' : "Empty response (no text, no tool calls)"} — retrying (${retryCount}/${maxRetries})`,
        );
        blocks.reset();
        textBlockIndex = null;
        yield* drain(pending);
        await abortableDelay(exponentialBackoff(retryCount - 1, 1000, MAX_RETRY_DELAY), signal);
        continue;
      }
      if (isEchoLoop && textBlockIndex !== null) {
        blocks.setText(textBlockIndex, "");
        console.warn(`[kiro-core] Echo loop — stripping "Continue" response`);
      } else if (!hasText && !sawAnyToolCalls) {
        console.warn(`[kiro-core] Empty response after ${maxRetries} retries — reporting a normal stop`);
      }
    }

    if (textBlockIndex !== null) blocks.endText(textBlockIndex);

    // Kiro does not reliably emit per-response output token counts. When the
    // `usage` event is missing or reports only `inputTokens`, fall back to a
    // tiktoken estimate over everything the assistant emitted — text plus
    // tool-call input JSON. Otherwise tool-call-only turns report 0 output
    // tokens and break consumers that watch it.
    if (usageEvent?.inputTokens !== undefined) usage.input = usageEvent.inputTokens;
    usage.output = usageEvent?.outputTokens ?? countTokens(totalContent);
    usage.totalTokens = usage.input + usage.output;
    // Only set when reported: leaving these absent is what tells a host that
    // Kiro said nothing about caching, rather than that nothing was cached.
    if (usageEvent?.cacheReadTokens !== undefined) usage.cacheRead = usageEvent.cacheReadTokens;
    if (usageEvent?.cacheWriteTokens !== undefined) usage.cacheWrite = usageEvent.cacheWriteTokens;
    usage.cost = calculateKiroCost(model.cost, usage);

    // Use `emittedToolCalls`, not the count seen on the wire: a turn whose calls
    // were all dropped for unparseable input must not report `toolUse`, because
    // an empty turn with a tool-use stop stalls an agent loop waiting for
    // results that will never arrive.
    const stopReason =
      !receivedContextUsage && emittedToolCalls === 0 ? "length" : emittedToolCalls > 0 ? "toolUse" : "stop";
    yield* drain(pending);
    yield { type: "usage", usage };
    yield { type: "done", stopReason };
    debugLog("response.done", {
      stopReason,
      emittedToolCalls,
      sawAnyToolCalls,
      textLen: responseText.length,
      usage,
    });
    return;
  }
}

function* drain(pending: KiroStreamEvent[]): Generator<KiroStreamEvent> {
  while (pending.length > 0) {
    const event = pending.shift();
    if (event) yield event;
  }
}
