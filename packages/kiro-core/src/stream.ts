// ABOUTME: Core streaming integration for Kiro API requests and responses.
// ABOUTME: Handles request building, retry logic, event parsing, and token counting.

import { debugLog, formatSafeError, redactSensitiveText } from "./debug.js";
import { buildKiroAdditionalModelRequestFields, clampKiroEffort, getKiroEffortConfig } from "./effort.js";
import { getKiroEndpoints } from "./endpoints.js";
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
import { buildKiroRequest } from "./request-builder.js";
import { KiroResponseAssembler } from "./response-assembler.js";
import { readKiroEventStream } from "./response-stream.js";
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
import { kiroTokenTypeHeaders } from "./token-type.js";
import { abortableDelay, createResponseHeaderDeadline, logCapacityEvent } from "./transport.js";
import type { KiroEffort, KiroMessage, KiroStreamEvent, KiroTool } from "./types.js";

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
  // Legacy fallback for turning the thinking stream on, kept only where nothing
  // better exists. When the request already carries the catalog's own `thinking`
  // field, the markers are pure duplication: they restate in prose what the
  // structured field states, and prepend an effort-dependent budget to the front
  // of the system prompt for no gain.
  //
  // Verified 2026-09-06 against claude-sonnet-5 at effort `high`: dropping the
  // markers left the thinking stream intact — one block, comparable length —
  // in both arrangements.
  //
  // This does NOT buy back Kiro's server-side prompt cache. Measured the same
  // day: a repeated prefix bills ~0.035 credits against ~0.066 for a fresh one,
  // but changing effort misses even when the system prompt is byte-identical,
  // and each effort then warms its own entry. The effort travels in
  // `additionalModelRequestFields`, so it is part of the cache key no matter
  // what the prompt says.
  //
  // Still emitted when Kiro offers no structured control: a model whose catalog
  // entry carries no effort schema, or a Claude turn with no effort selected,
  // has nothing else to switch thinking on with. Models keyed off `reasoning`
  // (the GPT family) never wanted the markers at all.
  const sendsThinkingField = !!additionalModelRequestFields && "thinking" in additionalModelRequestFields;
  if (thinkingEnabled && effortConfig?.field !== "reasoning" && !sendsThinkingField) {
    const budget =
      effort === "xhigh" || effort === "max" ? 50000 : effort === "high" ? 30000 : effort === "medium" ? 20000 : 10000;
    systemPrompt = `<thinking_mode>enabled</thinking_mode><max_thinking_length>${budget}</max_thinking_length>${systemPrompt ? `\n${systemPrompt}` : ""}`;
  }

  const assembler = new KiroResponseAssembler(model, thinkingEnabled);
  let retryCount = 0;
  const maxRetries = 3;
  const conversationId = request.sessionId ?? crypto.randomUUID();

  requestLoop: while (retryCount <= maxRetries) {
    if (signal?.aborted) throw signal.reason;
    const built = buildKiroRequest({
      messages: request.messages,
      model,
      kiroModelId,
      systemPrompt,
      tools: request.tools,
      conversationId,
      profileArn,
      ...(additionalModelRequestFields ? { additionalModelRequestFields } : {}),
    });
    const kiroRequest = built.request;

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
        historyLen: built.wireHistoryLength,
        currentContentLen: built.wireContentLength,
        hasImages: built.hasImages,
        toolResultCount: built.toolResultCount,
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
    assembler.beginAttempt();

    const { frames, outcome } = readKiroEventStream(response.body as ReadableStream<Uint8Array>, {
      firstTokenTimeoutMs: model.firstTokenTimeout ?? firstTokenTimeoutForModel(model.id),
    });

    for await (const frame of frames) {
      assembler.handle(frame);
      yield* assembler.takeEvents();
    }
    yield* assembler.takeEvents();

    if (outcome.firstTokenTimedOut || outcome.idleTimedOut || outcome.error) {
      // Timed out or received an error mid-stream: retry with backoff.
      if (retryCount < maxRetries) {
        retryCount++;
        await abortableDelay(exponentialBackoff(retryCount - 1, 1000, MAX_RETRY_DELAY), signal);
        continue;
      }
      if (outcome.error) throw new Error(`Kiro API stream error after max retries: ${outcome.error}`);
      throw new Error(
        `Kiro API error: ${outcome.firstTokenTimedOut ? "first token" : "idle"} timeout after max retries`,
      );
    }

    const summary = assembler.endTurn();
    yield* assembler.takeEvents();

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
    if (summary.isEmpty || summary.isEchoLoop) {
      // Retrying an echo loop means unsaying text already delivered, which only
      // a host that can discard emitted blocks may do. Elsewhere, go straight to
      // the terminal behaviour: strip the echo so the agent loop does not read
      // "Continue" as a continuation signal.
      const mayRetry = retryCount < maxRetries && (!summary.isEchoLoop || request.canDiscardEmittedBlocks === true);
      if (mayRetry) {
        retryCount++;
        console.warn(
          `[kiro-core] ${summary.isEchoLoop ? 'Echo loop detected (model responded with just "Continue")' : "Empty response (no text, no tool calls)"} — retrying (${retryCount}/${maxRetries})`,
        );
        assembler.discard();
        yield* assembler.takeEvents();
        await abortableDelay(exponentialBackoff(retryCount - 1, 1000, MAX_RETRY_DELAY), signal);
        continue;
      }
      if (summary.isEchoLoop) {
        assembler.stripEcho();
        console.warn(`[kiro-core] Echo loop — stripping "Continue" response`);
      } else {
        // The stop reason is still decided below, and an empty turn that never
        // carried a contextUsage frame is reported as `length` rather than
        // `stop` — say so, instead of promising a normal stop this branch does
        // not actually guarantee.
        console.warn(`[kiro-core] Empty response after ${maxRetries} retries — giving up on this turn`);
      }
    }

    const { stopReason, usage } = assembler.complete();
    yield* assembler.takeEvents();
    yield { type: "usage", usage };
    yield { type: "done", stopReason };
    return;
  }
}
