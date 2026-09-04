// ABOUTME: Tests for truncation detection and recovery notice injection.
// ABOUTME: Validates wasPreviousResponseTruncated and TRUNCATION_NOTICE.

import { describe, expect, it } from "vitest";
import { TRUNCATION_NOTICE, wasPreviousResponseTruncated } from "../src/truncation.js";
import type { KiroMessage, KiroStopReason } from "../src/types.js";

function user(text: string): KiroMessage {
  return { role: "user", content: [{ type: "text", text }] };
}

function assistant(stopReason: KiroStopReason): KiroMessage {
  return { role: "assistant", content: [{ type: "text", text: "some response" }], stopReason };
}

describe("wasPreviousResponseTruncated", () => {
  it("returns true when last assistant message has stopReason 'length'", () => {
    expect(wasPreviousResponseTruncated([user("Hello"), assistant("length"), user("Continue")])).toBe(true);
  });

  it("returns false when last assistant message has stopReason 'stop'", () => {
    expect(wasPreviousResponseTruncated([user("Hello"), assistant("stop"), user("Next")])).toBe(false);
  });

  it("returns false when there are no assistant messages", () => {
    expect(wasPreviousResponseTruncated([user("Hello")])).toBe(false);
  });

  it("returns false for empty messages array", () => {
    expect(wasPreviousResponseTruncated([])).toBe(false);
  });

  it("checks the most recent assistant, not earlier ones", () => {
    expect(
      wasPreviousResponseTruncated([
        user("Hello"),
        assistant("length"),
        user("Continue"),
        assistant("stop"),
        user("Thanks"),
      ]),
    ).toBe(false);
  });

  it("returns true when the most recent assistant was truncated with messages after", () => {
    expect(
      wasPreviousResponseTruncated([
        user("Hello"),
        assistant("stop"),
        user("Continue"),
        assistant("length"),
        user("Keep going"),
      ]),
    ).toBe(true);
  });

  it("treats a turn with no recorded stop reason as untruncated", () => {
    expect(wasPreviousResponseTruncated([user("Hello"), { role: "assistant", content: [] }])).toBe(false);
  });
});

describe("TRUNCATION_NOTICE", () => {
  it("is a non-empty string", () => {
    expect(TRUNCATION_NOTICE.length).toBeGreaterThan(0);
  });

  it("mentions truncation or continuation", () => {
    const lower = TRUNCATION_NOTICE.toLowerCase();
    expect(lower.includes("truncat") || lower.includes("continu") || lower.includes("cut off")).toBe(true);
  });
});
