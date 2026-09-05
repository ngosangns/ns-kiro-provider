// ABOUTME: Timing and logging primitives shared by the Kiro request loop.
// ABOUTME: Kept apart from stream.ts so the retry policy reads as policy, not plumbing.

import { appendFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const CAPACITY_LOG_DIR = join(homedir(), ".ns-kiro-provider", "logs");
const CAPACITY_LOG_FILE = join(CAPACITY_LOG_DIR, "capacity-retries.log");

let capacityLogDirCreated = false;

/**
 * Record a capacity-pressure event to its own log.
 *
 * Deliberately not awaited and deliberately not on stderr: capacity retries are
 * routine enough that surfacing them would be noise, but frequent enough that
 * losing them makes a throttled account impossible to diagnose after the fact.
 */
export function logCapacityEvent(message: string): void {
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
export function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
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

export interface ResponseHeaderDeadline {
  signal: AbortSignal;
  /** True when the deadline — not the caller — aborted the request. */
  didTimeout: () => boolean;
  cleanup: () => void;
}

/**
 * Abort a request that has not produced response headers in time, while still
 * honouring the caller's own signal.
 *
 * The two causes must stay distinguishable: a deadline abort is retried, a
 * caller abort is propagated.
 */
export function createResponseHeaderDeadline(
  callerSignal: AbortSignal | undefined,
  timeoutMs: number,
): ResponseHeaderDeadline {
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
