// ABOUTME: Tests the mapping from Kiro's failure wording onto Harness routing codes.

import { LlmError } from "@deepseek-ai/dsh-llm";
import { describe, expect, it } from "vitest";
import { toLlmError } from "../src/errors.js";

describe("toLlmError", () => {
  it("passes an LlmError through untouched", () => {
    const original = new LlmError("already classified", "AUTH");
    expect(toLlmError(original)).toBe(original);
  });

  it.each([
    ["Kiro API error: context_length_exceeded (400 too long)", "CONTEXT_OVERFLOW"],
    ["Kiro API error: MONTHLY_REQUEST_COUNT exhausted", "QUOTA_EXCEEDED"],
    ["Kiro API error: INSUFFICIENT_MODEL_CAPACITY", "OVERLOADED"],
    ["Kiro API error: request window retry budget exhausted (USER_REQUEST_RATE_EXCEEDED)", "RATE_LIMIT"],
    ["Kiro credentials not set. Run `kiro-cli login`.", "AUTH"],
    ["Kiro API error: first token timeout after max retries", "TIMEOUT"],
    ["Kiro API error: 500 Internal Server Error", "PROVIDER_ERROR"],
  ])("classifies %s", (message, code) => {
    expect(toLlmError(new Error(message)).code).toBe(code);
  });

  it("reads the HTTP status out of the core's wording", () => {
    expect(toLlmError(new Error("Kiro API error: 503 Service Unavailable")).failure.status).toBe(503);
  });

  it("classifies a 403 as an auth failure", () => {
    expect(toLlmError(new Error("Kiro API error: 403 Forbidden")).code).toBe("AUTH");
  });

  it("classifies an abort as ABORTED rather than a provider fault", () => {
    const aborted = new Error("The operation was aborted");
    aborted.name = "AbortError";
    expect(toLlmError(aborted).code).toBe("ABORTED");
  });

  it("accepts a non-Error throw", () => {
    expect(toLlmError("plain string").code).toBe("PROVIDER_ERROR");
  });
});
