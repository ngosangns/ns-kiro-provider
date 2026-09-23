// ABOUTME: Opt-in usage estimation policy — dollar value and cache-read estimation.
// ABOUTME: The host supplies the settings record; the core never reads a file itself.

import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_ESTIMATED_CACHE_TIMEOUT_MS,
  DEFAULT_USD_PER_CREDIT,
  estimateKiroCreditCost,
  KIRO_USAGE_TRACKING_DISABLED,
  resolveKiroUsageTracking,
} from "../src/usage-tracking.js";

describe("resolveKiroUsageTracking", () => {
  it("is disabled when the host supplies no section", () => {
    expect(resolveKiroUsageTracking(undefined)).toEqual(KIRO_USAGE_TRACKING_DISABLED);
    expect(resolveKiroUsageTracking(null)).toEqual(KIRO_USAGE_TRACKING_DISABLED);
    expect(resolveKiroUsageTracking("yes")).toEqual(KIRO_USAGE_TRACKING_DISABLED);
  });

  it("enables dollar-value estimation with the default rate", () => {
    expect(resolveKiroUsageTracking({ estimateDollarValue: true })).toMatchObject({
      estimateDollarValue: true,
      usdPerCredit: DEFAULT_USD_PER_CREDIT,
      estimateCacheUsage: false,
    });
  });

  it("honors a custom rate including zero", () => {
    expect(resolveKiroUsageTracking({ estimateDollarValue: true, usdPerCredit: 0 }).usdPerCredit).toBe(0);
    expect(resolveKiroUsageTracking({ estimateDollarValue: true, usdPerCredit: 0.05 }).usdPerCredit).toBe(0.05);
  });

  it("accepts legacy enabled as a deprecated alias for dollar estimation", () => {
    const resolved = resolveKiroUsageTracking({ enabled: true });
    expect(resolved.estimateDollarValue).toBe(true);
    expect(resolved.estimateCacheUsage).toBe(false);
  });

  it("enables cache estimation independently", () => {
    const resolved = resolveKiroUsageTracking({ estimateCacheUsage: true });
    expect(resolved).toMatchObject({
      estimateDollarValue: false,
      estimateCacheUsage: true,
      estimatedCacheTimeout: DEFAULT_ESTIMATED_CACHE_TIMEOUT_MS,
    });
  });

  it("honors a custom cache timeout including zero (no expiry)", () => {
    expect(resolveKiroUsageTracking({ estimateCacheUsage: true, estimatedCacheTimeout: 0 }).estimatedCacheTimeout).toBe(
      0,
    );
  });

  it("fails closed on a malformed rate", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const resolved = resolveKiroUsageTracking({ estimateDollarValue: true, usdPerCredit: -1 });
    expect(resolved.estimateDollarValue).toBe(false);
    expect(warn).toHaveBeenCalledOnce();
  });

  it("fails closed on a malformed cache timeout", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const resolved = resolveKiroUsageTracking({ estimateCacheUsage: true, estimatedCacheTimeout: "5m" });
    expect(resolved.estimateCacheUsage).toBe(false);
    expect(warn).toHaveBeenCalledOnce();
  });
});

describe("estimateKiroCreditCost", () => {
  const enabled = { ...KIRO_USAGE_TRACKING_DISABLED, estimateDollarValue: true };

  it("converts credits at the configured rate", () => {
    expect(estimateKiroCreditCost(enabled, { credits: 3, unit: "credit" })).toBeCloseTo(0.12, 10);
  });

  it("accepts plural mixed-case units and zero credits", () => {
    expect(estimateKiroCreditCost(enabled, { credits: 2, unit: "Credits" })).toBeCloseTo(0.08, 10);
    expect(estimateKiroCreditCost(enabled, { credits: 0, unit: "credit" })).toBe(0);
  });

  it("returns undefined when dollar estimation is disabled", () => {
    expect(estimateKiroCreditCost(KIRO_USAGE_TRACKING_DISABLED, { credits: 3, unit: "credit" })).toBeUndefined();
  });

  it.each([
    ["a token unit", { credits: 3, unit: "token" }],
    ["a missing unit", { credits: 3 }],
    ["a missing credit count", { unit: "credit" }],
    ["a negative count", { credits: -1, unit: "credit" }],
    ["a NaN count", { credits: Number.NaN, unit: "credit" }],
    ["an infinite count", { credits: Number.POSITIVE_INFINITY, unit: "credit" }],
  ])("returns undefined for %s", (_label, metering) => {
    expect(estimateKiroCreditCost(enabled, metering)).toBeUndefined();
  });
});
