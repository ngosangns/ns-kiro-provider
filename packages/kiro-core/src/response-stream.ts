// ABOUTME: Reads Kiro's AWS event-stream response into parsed wire events.
// ABOUTME: Owns framing and the stall timeouts; block assembly lives elsewhere.

import { UniversalEventStreamMarshaller } from "@smithy/core/event-streams";
import type { Message } from "@smithy/types";
import { debugEnabled, debugLog } from "./debug.js";
import { type KiroWireEvent, parseKiroEvent } from "./event-parser.js";

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
}

export interface KiroWireEventFrame {
  event: KiroWireEvent;
  /** The frame verbatim, for logging fields this package does not model. */
  payload: Record<string, unknown>;
}

export interface KiroEventStreamOptions {
  firstTokenTimeoutMs: number;
  idleTimeoutMs?: number;
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
 */
export function readKiroEventStream(
  body: ReadableStream<Uint8Array>,
  options: KiroEventStreamOptions,
): KiroEventStreamReader {
  const outcome: KiroEventStreamOutcome = { firstTokenTimedOut: false, idleTimedOut: false, error: null };
  const idleTimeoutMs = options.idleTimeoutMs ?? IDLE_TIMEOUT;
  const bodyReader = body.getReader();

  async function* frames(): AsyncGenerator<KiroWireEventFrame> {
    let idleTimer: ReturnType<typeof setTimeout> | null = null;
    const resetIdle = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        outcome.idleTimedOut = true;
        void bodyReader.cancel().catch(() => {});
      }, idleTimeoutMs);
    };

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

    let gotFirstToken = false;
    const FIRST_TOKEN_SENTINEL = Symbol("firstTokenTimeout");

    try {
      while (true) {
        let iterResult: IteratorResult<Record<string, unknown>>;
        try {
          if (!gotFirstToken) {
            const readPromise = iterator.next();
            const result = await Promise.race([
              readPromise,
              new Promise<typeof FIRST_TOKEN_SENTINEL>((resolve) =>
                setTimeout(() => resolve(FIRST_TOKEN_SENTINEL), options.firstTokenTimeoutMs),
              ),
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
          } else {
            iterResult = await iterator.next();
          }
        } catch (e) {
          // Smithy throws on `:message-type` error/exception headers.
          outcome.error =
            e instanceof Error
              ? e.message
              : (typeof e === "object" && e !== null ? JSON.stringify(e) : String(e)) || "Unknown stream error";
          return;
        }

        const { done, value } = iterResult;
        if (done) return;
        resetIdle();
        const payload = Object.values(value as Record<string, unknown>)[0] as Record<string, unknown>;
        const event = parseKiroEvent(payload);
        if (!event) continue;
        if (debugEnabled()) debugLog("stream.events", [event]);
        if (event.type === "error") {
          outcome.error = event.data.message ? `${event.data.error}: ${event.data.message}` : event.data.error;
          void bodyReader.cancel().catch(() => {});
          return;
        }
        yield { event, payload };
      }
    } finally {
      if (idleTimer) clearTimeout(idleTimer);
    }
  }

  return { frames: frames(), outcome };
}
