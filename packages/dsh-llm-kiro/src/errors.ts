// ABOUTME: Maps Kiro's failure vocabulary onto the Harness LlmError taxonomy.

import { LlmError } from "@deepseek-ai/dsh-llm";
import { isCapacityError, isNonRetryableBodyError, KIRO_REASON_CODES } from "kiro-core";

const STATUS_PATTERN = /Kiro API error: (\d{3})\b/;

/**
 * Classify a core failure for the Harness.
 *
 * The core throws `Error` with Kiro's own wording because it serves two hosts
 * with different error types. This is where that wording becomes one of the
 * Harness's routing codes — the loop branches on `code`, so a mislabelled
 * failure either retries forever or gives up on something transient.
 */
export function toLlmError(error: unknown): LlmError {
  if (error instanceof LlmError) return error;
  const cause = error instanceof Error ? error : undefined;
  const message = cause?.message ?? String(error);

  if (cause?.name === "AbortError") return new LlmError(message, "ABORTED", { cause });

  const status = Number(STATUS_PATTERN.exec(message)?.[1]);
  const options = { cause, ...(Number.isFinite(status) ? { status } : {}) };

  if (message.includes("context_length_exceeded")) return new LlmError(message, "CONTEXT_OVERFLOW", options);
  if (message.includes(KIRO_REASON_CODES.MONTHLY_REQUEST_COUNT) || isNonRetryableBodyError(message)) {
    return new LlmError(message, "QUOTA_EXCEEDED", options);
  }
  if (isCapacityError(message)) return new LlmError(message, "OVERLOADED", options);
  if (message.includes(KIRO_REASON_CODES.USER_REQUEST_RATE_EXCEEDED) || status === 429) {
    return new LlmError(message, "RATE_LIMIT", options);
  }
  if (message.includes("credentials not set") || status === 401 || status === 403) {
    return new LlmError(message, "AUTH", options);
  }
  if (message.includes("timeout")) return new LlmError(message, "TIMEOUT", options);
  return new LlmError(message, "PROVIDER_ERROR", options);
}
