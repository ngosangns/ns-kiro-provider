// ABOUTME: Core streaming integration for Kiro API requests and responses.
// ABOUTME: Handles request building, retry logic, event parsing, and token counting.

import { createHash } from "node:crypto";
import { applyCacheEstimate } from "./cache-estimator.js";
import { debugEnabled, debugLog, formatSafeError, redactSensitiveText } from "./debug.js";
import { buildKiroAdditionalModelRequestFields, clampKiroEffort, getKiroEffortConfig } from "./effort.js";
import { getKiroEndpoints, getKiroRegionFromProfileArn } from "./endpoints.js";
import { extractKiroReasonCode, KiroApiError, parseRetryAfterMs } from "./errors.js";
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
import { estimateKiroCreditCost, KIRO_USAGE_TRACKING_DISABLED, type KiroUsageTracking } from "./usage-tracking.js";

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
  /**
   * Opt-in usage estimates (credit→USD value, cache-read estimation). Absent
   * means disabled; the core never reads a settings file on its own — the host
   * resolves the policy and passes it here.
   */
  usageTracking?: KiroUsageTracking;
}

/**
 * Pluralise an observed-attempt count for a diagnostic. The count is what was
 * actually seen, not the configured retry budget: the two diverge whenever a
 * 403 refresh, a timeout or a mid-stream error already spent part of the shared
 * budget, and a diagnostic that exists to explain a silent failure must not
 * itself assert something that did not happen.
 *
 * Deliberately not worded as "consecutive": the degenerate attempts need not be
 * adjacent. A 403 credential refresh or a mid-stream error can land between two
 * of them and spend the same shared budget, so an unqualified count is the only
 * claim the counter can actually support.
 */
function describeAttempts(count: number): string {
  return count === 1 ? "1 attempt" : `${count} attempts`;
}

/**
 * Cap for wire-derived echo text quoted into a persisted `errorMessage`. The
 * echo pattern `/^\s*(continue|\.+)\s*$/i` admits an arbitrarily long run of
 * dots, and this string is written into the stream's terminal diagnostic.
 * Matches the 200-char cap used for raw tool input in the assembler's parse
 * warning. Tool-name collections use their own whole-value policy in
 * `describeDroppedToolNames`; they are never sliced into partial identities.
 */
const DIAGNOSTIC_QUOTE_LIMIT = 200;

/**
 * INVARIANT: no unbounded integer may be interpolated into a persisted
 * `errorMessage`. Consumers classify that string by pattern-matching its text,
 * and retryable-error predicates in the wild match bare `429|500|502|503|504`
 * with NO word boundary. So a `(5000 chars total)` annotation makes a
 * diagnostic that says "terminal, do not retry" read as a transient HTTP 500
 * and get suppressed — precisely the silent failure these diagnostics exist to
 * defeat, reintroduced by the diagnostic itself.
 *
 * Hence the truncation marker carries no length: the exact length goes to
 * `console.warn`, which no classifier reads. The only integer these diagnostics
 * interpolate is the observed-attempt count, bounded by `maxRetries + 1` = 4.
 *
 * Wire-derived tool names can carry the same trigger text, so they are encoded
 * before entering this diagnostic. See `encodeToolNameForDiagnostic`.
 */
function clampForDiagnostic(text: string): string {
  return text.length <= DIAGNOSTIC_QUOTE_LIMIT ? text : `${text.slice(0, DIAGNOSTIC_QUOTE_LIMIT)}… (truncated)`;
}

/**
 * Encode untrusted bytes without letting their text change how a consumer
 * classifies the surrounding error. Each byte is represented by two letters,
 * A through P, for its high and low nibbles. That alphabet contains no digits
 * and cannot spell any alternative in a retryable-error predicate.
 */
function encodeBytesForDiagnostic(bytes: Uint8Array): string {
  let encoded = "";
  for (const byte of bytes) {
    encoded += String.fromCharCode(65 + (byte >> 4), 65 + (byte & 0x0f));
  }
  return encoded;
}

/**
 * Encode one tool-name identity reversibly from its UTF-16 code units. String
 * names retain their exact value. A malformed non-string wire name is prefixed
 * with its runtime type and JSON representation, so it stays distinguishable
 * from a legitimate string with the same rendered text.
 *
 * Using `TextEncoder` here would replace an unpaired surrogate with U+FFFD,
 * corrupting the only persisted identity of a dropped call; JSON permits that
 * escaped shape and the event parser carries it through as a JavaScript string.
 * Quoting any identity verbatim is unsafe: values such as `set_timeout` and
 * `http500_probe` make a terminal diagnostic look transient to consumers.
 */
function encodeToolNameForDiagnostic(name: unknown): string {
  const identity = typeof name === "string" ? name : `${typeof name}:${JSON.stringify(name)}`;
  let encoded = "";
  for (let i = 0; i < identity.length; i++) {
    const codeUnit = identity.charCodeAt(i);
    encoded += String.fromCharCode(
      65 + (codeUnit >> 12),
      65 + ((codeUnit >> 8) & 0x0f),
      65 + ((codeUnit >> 4) & 0x0f),
      65 + (codeUnit & 0x0f),
    );
  }
  return encoded;
}

/**
 * Describe the complete dropped-name set without unbounded output or partial
 * identities. A set that fits is reversible name by name. If the complete set
 * would exceed the diagnostic limit, replace all names with one SHA-256
 * fingerprint. The explicit marker means no valid-looking name prefix can be
 * mistaken for the whole identity, while the fingerprint still lets two
 * records be compared exactly.
 */
function describeDroppedToolNames(names: unknown[]): string {
  const encoded = names.map((name) => `A-P:${encodeToolNameForDiagnostic(name)}`).join(", ");
  if (encoded.length <= DIAGNOSTIC_QUOTE_LIMIT) return encoded;
  const digest = createHash("sha256").update(JSON.stringify(names)).digest();
  return `A-P-DIGEST:${encodeBytesForDiagnostic(digest)} (tool identities fingerprinted)`;
}

/**
 * What the turn's blocks look like, for the exhausted-empty-response
 * diagnostic. "No text and no tool calls" does NOT imply empty content: a
 * reasoning turn that emits only `thinkingText` and then ends is degenerate by
 * that test while a thinking block still exists, and a `ThinkingTagParser`
 * turn can leave a zero-length text block behind. Claiming `empty content`
 * there would assert something not observed.
 *
 * Block TYPES only, never a count: a count is an unbounded integer, which the
 * invariant above forbids.
 */
function describeReturnedContent(kinds: string[]): string {
  const unique = [...new Set(kinds)].sort();
  if (unique.length === 0) return "returning empty content";
  return `returning only ${unique.join(" and ")} content`;
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

  // ListAvailableProfiles probes across regions (#104, #131), so an SSO login
  // in one region can legitimately resolve a profile owned by another. The
  // runtime host and the catalog have to follow the profile: sending a
  // cross-region profile ARN to the runtime API fails the whole request with
  // a generic `Improperly formed request.`.
  let runtimeRegion = getKiroRegionFromProfileArn(profileArn) ?? region;
  let endpoint = new URL("generateAssistantResponse", getKiroEndpoints(runtimeRegion).runtime).toString();

  // Refresh the catalog in the background when it has gone stale.
  if (!process.env.VITEST && isCacheStale(runtimeRegion)) {
    updateKiroModelsCache(accessToken, runtimeRegion, profileArn).catch((error) => {
      console.warn(`[kiro-core] Failed to refresh Kiro model catalog in ${runtimeRegion}: ${formatSafeError(error)}`);
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
  const usageTracking = request.usageTracking ?? KIRO_USAGE_TRACKING_DISABLED;
  let retryCount = 0;
  const maxRetries = 3;
  /** Degenerate attempts, counted BY SHAPE. Both are counted separately from
   *  `retryCount`, which is the shared retry budget also spent by 403 credential
   *  refreshes, idle/first-token timeouts and mid-stream errors — so
   *  `maxRetries + 1` is NOT the number of empty attempts, and reporting it as
   *  such overstates what was observed.
   *
   *  Split rather than pooled because the two shapes are not interchangeable and
   *  the exhaustion diagnostic is worded from the LAST attempt's shape only. The
   *  model can echo on one attempt and return nothing on the next; a single
   *  pooled counter would then make "returned no text ... on 4 attempts" out of
   *  three empty attempts and one that did carry text, or claim four echoes from
   *  one. Each diagnostic reports its own shape's count and, when the other shape
   *  also occurred, names it separately. */
  let emptyAttempts = 0;
  let echoAttempts = 0;

  // Cumulative provider-internal retry tallies reported on KiroApiError.
  // `retryCount` cannot stand in for either: it is also consumed by stream
  // errors, idle/first-token timeouts, and empty-response retries, and
  // `capacityRetryCount` resets on every outer iteration.
  let credentialRefreshTotal = 0;
  let capacityRetryTotal = 0;
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
          capacityRetryTotal++;
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
          credentialRefreshTotal++;
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
          // A replacement credential can carry a profile in another region,
          // so re-pin the runtime host before retrying.
          runtimeRegion = getKiroRegionFromProfileArn(profileArn) ?? region;
          endpoint = new URL("generateAssistantResponse", getKiroEndpoints(runtimeRegion).runtime).toString();
          await abortableDelay(exponentialBackoff(retryCount - 1, 500, MAX_RETRY_DELAY), signal);
          break; // break inner loop, continue outer loop
        }
        // Known quota/capacity body markers must not be re-read by a host's own
        // outer auto-retry as a generic retryable 429. This covers both hard
        // quota (MONTHLY_REQUEST_COUNT) and exhausted capacity retries
        // (INSUFFICIENT_MODEL_CAPACITY).
        //
        // The three throws below carry identical `message` text to what this
        // provider has always emitted — host adapters and downstream consumers
        // string-match it. KiroApiError adds the classification as typed fields
        // alongside that text; it never changes it.
        const errorMeta = {
          reasonCode: extractKiroReasonCode(errText),
          retryAfterMs: parseRetryAfterMs(response.headers),
          providerAttempts: { credentialRefresh: credentialRefreshTotal, capacity: capacityRetryTotal },
        };
        if (isNonRetryableBodyError(errText) || isCapacityError(errText)) {
          throw new KiroApiError(
            `Kiro API error: ${errText || safeStatusText}`,
            response.status,
            errorMeta.reasonCode,
            errorMeta.retryAfterMs,
            errorMeta.providerAttempts,
          );
        }
        // Phrase overflow so a host's context-overflow detector recognizes it.
        if (isTooBigError(response.status, errText)) {
          throw new KiroApiError(
            `Kiro API error: context_length_exceeded (${response.status} ${errText})`,
            response.status,
            errorMeta.reasonCode,
            errorMeta.retryAfterMs,
            errorMeta.providerAttempts,
          );
        }
        throw new KiroApiError(
          `Kiro API error: ${response.status} ${safeStatusText} ${errText}`,
          response.status,
          errorMeta.reasonCode,
          errorMeta.retryAfterMs,
          errorMeta.providerAttempts,
        );
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
      signal,
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
        if (outcome.errorData && debugEnabled()) {
          debugLog("stream.error.typed", [outcome.errorData]);
        }
        // The assembler outlives the retry loop, so anything the aborted
        // attempt already emitted survives into the next one. A typed error
        // frame (throttling/validation/serviceUnavailable) can arrive after
        // partial text, which would otherwise concatenate the abandoned prefix
        // onto the retried response. The degenerate-response retry below
        // discards for the same reason. The usage figures are cleared by
        // `beginAttempt` at the next loop top.
        //
        // The event protocol has no retraction event, so deltas already pushed
        // for the abandoned attempt cannot be withdrawn. The signals a
        // consumer does get are the `reset` event and the fresh `start`
        // emitted for the retried attempt.
        assembler.discard();
        yield* assembler.takeEvents();
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
    const degenerate = summary.isEmpty || summary.isEchoLoop;
    if (summary.isEchoLoop) echoAttempts++;
    else if (degenerate) emptyAttempts++;
    let errorMessage: string | undefined;
    if (degenerate) {
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
      // Retries are spent (or the host cannot discard an echo) and the turn
      // still carries nothing usable. The stopReason stays in the existing
      // union — a new member would break every consumer — so the only channel
      // that can say a turn failed while it still looks successful is the
      // `errorMessage` carried on the terminal `done` event. Without it these
      // turns are indistinguishable from an ordinary completion.
      //
      // Deliberately NOT worded as a transient/transport failure: this is
      // terminal, so consumer retry classifiers must not match it and hand it
      // another doomed attempt.
      if (summary.isEchoLoop) {
        // Strip the echo text to prevent the agent loop from interpreting
        // "Continue" as a continuation signal.
        assembler.stripEcho();
        const alsoEmpty = emptyAttempts > 0 ? ` (plus ${describeAttempts(emptyAttempts)} with no text at all)` : "";
        console.warn(
          `[kiro-core] Echo loop persisted across ${describeAttempts(echoAttempts)}${alsoEmpty} — stripping "Continue" response (${summary.responseText.length} chars)`,
        );
        errorMessage = `Kiro model echoed its own continuation prompt (${JSON.stringify(
          clampForDiagnostic(summary.responseText),
        )}) on ${describeAttempts(
          echoAttempts,
        )}${alsoEmpty} and emitted no tool calls; retry budget exhausted, text stripped, stopReason:"${
          summary.stopReason
        }"`;
      } else {
        const alsoEchoed =
          echoAttempts > 0 ? ` (plus ${describeAttempts(echoAttempts)} that echoed the continuation prompt)` : "";
        console.warn(
          `[kiro-core] Empty response on ${describeAttempts(emptyAttempts)}${alsoEchoed}, retry budget exhausted — returning stopReason:"${summary.stopReason}" to avoid agent loop stall`,
        );
        errorMessage = `Kiro returned no text and no tool calls on ${describeAttempts(
          emptyAttempts,
        )}${alsoEchoed}; retry budget exhausted, ${describeReturnedContent(
          assembler.contentKinds(),
        )} with stopReason:"${summary.stopReason}"`;
      }
    }
    // A tool call the model DID make never reached the host: its arguments
    // would not parse, so the assembler dropped it. Nothing else records this
    // — `sawAnyToolCalls` is already true, which is exactly what suppresses the
    // empty-response retry above and the text-dialect fallback — and the block
    // stream simply lacks the call. Unlike the two exhaustion cases, this one
    // is unrecoverable downstream: the call is gone before the events are
    // persisted.
    if (summary.droppedToolCalls.length > 0) {
      const names = describeDroppedToolNames(summary.droppedToolCalls);
      // The reversible names or whole-set fingerprint identify the drops, so
      // the count is not printed: it is unbounded (a turn may carry any
      // number of malformed calls) and unbounded or wire-controlled text
      // here can collide with a consumer's retryable-error pattern.
      const one = summary.droppedToolCalls.length === 1;
      const dropDiagnostic = `Kiro sent ${one ? "a tool call" : "tool calls"} with unparseable arguments (${names}); ${
        one ? "it was" : "they were"
      } dropped and never reached the agent, stopReason:"${summary.stopReason}"`;
      // Concatenation is defensive: today the two diagnostics are mutually
      // exclusive, because any drop sets `sawAnyToolCalls` and `degenerate`
      // requires `!sawAnyToolCalls`. Kept so that loosening either predicate
      // appends rather than silently overwriting an exhaustion diagnostic.
      errorMessage = errorMessage ? `${errorMessage}. ${dropDiagnostic}` : dropDiagnostic;
    }

    const { stopReason, usage, wireUsage, metering } = assembler.complete();
    yield* assembler.takeEvents();
    if (!errorMessage) {
      const estimatedRead = applyCacheEstimate(conversationId, usage, wireUsage, usageTracking);
      if (estimatedRead > 0) {
        debugLog("usage.estimate", {
          conversationId,
          estimatedRead,
          input: usage.input,
          cacheRead: usage.cacheRead,
        });
      }
      const estimatedCost = estimateKiroCreditCost(usageTracking, metering);
      if (estimatedCost !== undefined) usage.cost.total = estimatedCost;
    }
    yield { type: "usage", usage };
    yield { type: "done", stopReason, ...(errorMessage ? { errorMessage } : {}) };
    return;
  }
}
