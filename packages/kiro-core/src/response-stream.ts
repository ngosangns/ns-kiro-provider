// ABOUTME: Reads Kiro's AWS event-stream response into parsed wire events.
// ABOUTME: Owns framing and the stall timeouts; block assembly lives elsewhere.

import { UniversalEventStreamMarshaller } from "@smithy/core/event-streams";
import type { Message } from "@smithy/types";
import { debugEnabled, debugLog } from "./debug.js";
import { type KiroErrorData, type KiroWireEvent, parseKiroEvent, parseKiroExceptionFrame } from "./event-parser.js";

/** Longest gap between two frames before the response is treated as stalled. */
export const IDLE_TIMEOUT = 300_000;

const eventStreamMarshaller = new UniversalEventStreamMarshaller({
  utf8Encoder: (input: Uint8Array) => new TextDecoder().decode(input),
  utf8Decoder: (input: string) => new TextEncoder().encode(input),
});

/**
 * Why the stream stopped. Every field is a retryable condition; all false means
 * the response ended normally.
 */
export interface KiroEventStreamOutcome {
  firstTokenTimedOut: boolean;
  idleTimedOut: boolean;
  /** Message from a Smithy protocol error or a Kiro `error` frame. */
  error: string | null;
  /**
   * Structured detail for the last modeled exception frame. The `error` string
   * stays the retry/throw contract; this keeps `kind`, `reason`, and
   * `retryAfterMilliseconds` addressable instead of only readable as prose
   * inside that string.
   */
  errorData?: KiroErrorData;
}

export interface KiroWireEventFrame {
  event: KiroWireEvent;
  /** The frame verbatim, for logging fields this package does not model. */
  payload: Record<string, unknown>;
}

export interface KiroEventStreamOptions {
  firstTokenTimeoutMs: number;
  idleTimeoutMs?: number;
  /** Caller abort — cancels the body read instead of waiting out the response. */
  signal?: AbortSignal;
}

export interface KiroEventStreamReader {
  frames: AsyncGenerator<KiroWireEventFrame>;
  /** Populated by the time `frames` completes. */
  outcome: KiroEventStreamOutcome;
}

/**
 * Turn a Kiro response body into parsed wire events.
 *
 * Terminal conditions are reported through {@link KiroEventStreamOutcome}
 * rather than thrown: the caller retries all three the same way, and a throw
 * would force it to re-classify the cause it already knows.
 *
 * A Kiro `error` frame ends the stream and is not yielded — it carries no
 * content, and every caller treats it as the same retryable failure as a
 * protocol error.
 *
 * A caller abort throws out of `frames` instead of reporting through
 * `outcome`: the interrupt is not a retryable stream condition, and surfacing
 * it as one would burn the retry budget on a cancelled turn. The throw
 * propagates through the consuming generator to the host adapter, which maps
 * it to an `aborted` stop reason.
 */
export function readKiroEventStream(
  body: ReadableStream<Uint8Array>,
  options: KiroEventStreamOptions,
): KiroEventStreamReader {
  const outcome: KiroEventStreamOutcome = { firstTokenTimedOut: false, idleTimedOut: false, error: null };
  const idleTimeoutMs = options.idleTimeoutMs ?? IDLE_TIMEOUT;
  const bodyReader = body.getReader();
  const callerSignal = options.signal;

  async function* frames(): AsyncGenerator<KiroWireEventFrame> {
    let idleTimer: ReturnType<typeof setTimeout> | null = null;
    const resetIdle = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        outcome.idleTimedOut = true;
        void bodyReader.cancel().catch(() => {});
      }, idleTimeoutMs);
    };

    // Cancel the body read as soon as the caller aborts (e.g. user presses
    // Esc mid-stream). Without this, the read loop below keeps consuming the
    // event stream until the server finishes the response, which makes an
    // interrupt appear to hang for the remainder of the generation.
    const onCallerStreamAbort = () => {
      void bodyReader.cancel().catch(() => {});
    };
    if (callerSignal?.aborted) onCallerStreamAbort();
    else callerSignal?.addEventListener("abort", onCallerStreamAbort, { once: true });

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
      // The four error members of ChatResponseStream target `@error` shapes,
      // so the service frames them as `:message-type: exception`. The
      // marshaller keys those by `:exception-type` and throws whatever this
      // callback returns, so returning the bare payload would discard the
      // modeled class. Return an Error carrying the parsed detail instead.
      if (msg.headers[":message-type"]?.value === "exception") {
        // Parsed defensively, and BEFORE the shared parse below: an exception
        // body that is empty or not JSON would otherwise throw a SyntaxError
        // out of this deserializer, and the caller would report
        // "Unexpected end of JSON input" with the modeled class gone — the
        // exact loss this routing removes. The class lives in the header, so
        // it survives a body we cannot read. The same-service client's own
        // bridge takes this position too (sse-middleware.ts: "Non-JSON body:
        // still throw a typed exception with a fallback message").
        let parsedException: Record<string, unknown> = {};
        try {
          const decoded = JSON.parse(utf8Decoder.decode(msg.body)) as unknown;
          if (decoded && typeof decoded === "object") parsedException = decoded as Record<string, unknown>;
        } catch {
          // Header-only classification below.
        }
        // An unmodeled member (a fifth error added server-side, or `$unknown`)
        // still arrives keyed by `:exception-type`. Smithy's own fail-open path
        // is unreachable here — it only triggers when the deserializer returns
        // a `$unknown` property, which this one never does — so without a
        // fallback the marshaller would throw the bare parsed body and the
        // member name would be lost in exactly the way this routing exists to
        // prevent. Synthesize the same typed shape with `kind: "unknown"`.
        const data: KiroErrorData = parseKiroExceptionFrame(key, parsedException) ?? {
          error: key,
          kind: "unknown",
          ...(typeof parsedException.message === "string" ? { message: parsedException.message } : {}),
          ...(typeof parsedException.reason === "string" ? { reason: parsedException.reason } : {}),
          ...(typeof parsedException.retryAfterMilliseconds === "number"
            ? { retryAfterMilliseconds: parsedException.retryAfterMilliseconds }
            : {}),
        };
        const error = new Error(data.message ? `${data.error}: ${data.message}` : data.error);
        error.name = data.error;
        (error as Error & { kiroError?: KiroErrorData }).kiroError = data;
        return { [key]: error } as Record<string, unknown>;
      }
      const parsed = JSON.parse(utf8Decoder.decode(msg.body)) as Record<string, unknown>;
      return { [key]: parsed } as Record<string, unknown>;
    });
    const iterator = eventStream[Symbol.asyncIterator]() as AsyncIterator<Record<string, unknown>>;

    let gotFirstToken = false;
    const FIRST_TOKEN_SENTINEL = Symbol("firstTokenTimeout");

    try {
      while (true) {
        if (callerSignal?.aborted) {
          // Surface the abort instead of treating the cancelled read as a
          // retryable stream error; the adapter maps this to a stopReason of
          // "aborted".
          throw callerSignal.reason ?? new Error("Request aborted");
        }
        let iterResult: IteratorResult<Record<string, unknown>>;
        try {
          if (!gotFirstToken) {
            const readPromise = iterator.next();
            let firstTokenTimer: ReturnType<typeof setTimeout> | undefined;
            try {
              const result = await Promise.race([
                readPromise,
                new Promise<typeof FIRST_TOKEN_SENTINEL>((resolve) => {
                  firstTokenTimer = setTimeout(() => resolve(FIRST_TOKEN_SENTINEL), options.firstTokenTimeoutMs);
                }),
              ]);
              if (result === FIRST_TOKEN_SENTINEL) {
                readPromise.catch(() => {}); // suppress dangling rejection
                void bodyReader.cancel().catch(() => {});
                outcome.firstTokenTimedOut = true;
                return;
              }
              iterResult = result as IteratorResult<Record<string, unknown>>;
              gotFirstToken = true;
              resetIdle();
            } finally {
              // The losing timeout branch of the race must not keep a ref'd
              // timer alive until it fires: an uncleared 90 s handle holds the
              // Node event loop open long after a print-mode caller has
              // finished its turn (upstream #154).
              if (firstTokenTimer !== undefined) clearTimeout(firstTokenTimer);
            }
          } else {
            iterResult = await iterator.next();
          }
        } catch (e) {
          // Smithy throws on `:message-type` error/exception headers. A modeled
          // exception frame arrives here as the Error built in the
          // deserializer above, with its parsed detail attached.
          const kiroError = (e as { kiroError?: KiroErrorData } | null)?.kiroError;
          if (kiroError) outcome.errorData = kiroError;
          outcome.error =
            e instanceof Error
              ? e.message
              : (typeof e === "object" && e !== null ? JSON.stringify(e) : String(e)) || "Unknown stream error";
          return;
        }

        const { done, value } = iterResult;
        if (done) return;
        resetIdle();
        // The marshaller keys each frame by its modeled `ChatResponseStream`
        // union member (from the `:event-type` header). Route on that key
        // instead of guessing the member from which fields are populated.
        const frameEntry = Object.entries(value as Record<string, unknown>)[0];
        if (!frameEntry) continue;
        const [frameKey, framePayload] = frameEntry;
        const event = parseKiroEvent(frameKey, (framePayload ?? {}) as Record<string, unknown>);
        if (!event) continue;
        if (event.type === "ignored") {
          if (debugEnabled()) debugLog("stream.events.ignored", [event.data.key]);
          continue;
        }
        if (debugEnabled()) debugLog("stream.events", [event]);
        if (event.type === "error") {
          outcome.error = event.data.message ? `${event.data.error}: ${event.data.message}` : event.data.error;
          outcome.errorData = event.data;
          void bodyReader.cancel().catch(() => {});
          return;
        }
        yield { event, payload: framePayload as Record<string, unknown> };
      }
    } finally {
      if (idleTimer) clearTimeout(idleTimer);
      callerSignal?.removeEventListener("abort", onCallerStreamAbort);
    }
  }

  return { frames: frames(), outcome };
}
