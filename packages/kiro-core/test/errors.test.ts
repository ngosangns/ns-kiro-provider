// ABOUTME: Typed KiroApiError classification and the reason-code extraction contract.
// ABOUTME: parseRetryAfterMs is fully covered in retry.test.ts; here only its re-export.

import { describe, expect, it } from "vitest";
import { extractKiroReasonCode, KiroApiError, parseRetryAfterMs } from "../src/errors.js";

describe("KiroApiError", () => {
  it("keeps Error semantics for consumers that only read the string", () => {
    const error = new KiroApiError("Kiro API error: 429 Too Many Requests", 429, "MONTHLY_REQUEST_COUNT", 1500, {
      credentialRefresh: 1,
      capacity: 2,
    });

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("KiroApiError");
    expect(error.message).toBe("Kiro API error: 429 Too Many Requests");
    expect(error.status).toBe(429);
    expect(error.reasonCode).toBe("MONTHLY_REQUEST_COUNT");
    expect(error.retryAfterMs).toBe(1500);
    expect(error.providerAttempts).toEqual({ credentialRefresh: 1, capacity: 2 });
  });

  it("leaves optional classification undefined when the throw site had none", () => {
    const error = new KiroApiError("Kiro API error: 500", 500);
    expect(error.reasonCode).toBeUndefined();
    expect(error.retryAfterMs).toBeUndefined();
    expect(error.providerAttempts).toBeUndefined();
  });
});

describe("extractKiroReasonCode", () => {
  it("prefers the parsed JSON reason field over text scanning", () => {
    expect(extractKiroReasonCode('{"message":"Improperly formed request.","reason":"REQUEST_BODY_INVALID"}')).toBe(
      "REQUEST_BODY_INVALID",
    );
  });

  it("accepts the reasonCode spelling", () => {
    expect(extractKiroReasonCode('{"reasonCode":"MONTHLY_REQUEST_COUNT"}')).toBe("MONTHLY_REQUEST_COUNT");
  });

  it("passes through an unrecognized reason verbatim", () => {
    expect(extractKiroReasonCode('{"reason":"SOME_FUTURE_CODE"}')).toBe("SOME_FUTURE_CODE");
  });

  it("falls back to a marker scan for non-JSON and wrapped bodies", () => {
    expect(extractKiroReasonCode("upstream said MONTHLY_REQUEST_COUNT somewhere")).toBe("MONTHLY_REQUEST_COUNT");
    // A truncated JSON body still classifies via the marker scan.
    expect(extractKiroReasonCode('{"reason":"INSUFFICIENT_MODEL_CAPACI')).toBeUndefined();
    expect(extractKiroReasonCode("prefix INSUFFICIENT_MODEL_CAPACITY suffix")).toBe("INSUFFICIENT_MODEL_CAPACITY");
  });

  it("returns undefined rather than inventing a code", () => {
    expect(extractKiroReasonCode("")).toBeUndefined();
    expect(extractKiroReasonCode("Request entity too large")).toBeUndefined();
    // A classification marker with no reason code must not become one.
    expect(extractKiroReasonCode("Input is too long")).toBeUndefined();
  });
});

describe("parseRetryAfterMs", () => {
  it("is the retry module's canonical parser", () => {
    expect(parseRetryAfterMs(new Headers({ "retry-after-ms": "1500" }))).toBe(1500);
    expect(parseRetryAfterMs(undefined)).toBeUndefined();
  });
});
