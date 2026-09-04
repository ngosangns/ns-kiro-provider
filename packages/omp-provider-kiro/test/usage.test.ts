// ABOUTME: Tests the projection from Kiro account usage onto OMP's usage report.

import type { KiroProviderUsage, KiroProviderUsageBucket } from "kiro-core";
import { describe, expect, it } from "vitest";
import { toUsageReport } from "../src/usage.js";

const bucket = (overrides: Partial<KiroProviderUsageBucket> = {}): KiroProviderUsageBucket => ({
  id: "CREDIT",
  label: "Credits",
  resourceType: "CREDIT",
  used: 120,
  limit: 1000,
  usedDisplay: "120",
  limitDisplay: "1000",
  unit: "credit",
  ...overrides,
});

const usage = (overrides: Partial<KiroProviderUsage> = {}): KiroProviderUsage => ({
  subscriptionTitle: "Kiro Pro",
  resetAt: "2026-10-01T00:00:00.000Z",
  daysUntilReset: 27,
  manageUrl: "https://app.kiro.dev/account/usage",
  usageBuckets: [bucket()],
  ...overrides,
});

describe("toUsageReport", () => {
  it("carries raw amounts rather than the display strings", () => {
    const report = toUsageReport("kiro", usage(), 1000);
    expect(report.limits[0]?.amount).toEqual({ used: 120, limit: 1000, unit: "credits" });
    expect(report.fetchedAt).toBe(1000);
    expect(report.provider).toBe("kiro");
  });

  it("falls back to the account reset when a bucket declares none", () => {
    expect(toUsageReport("kiro", usage()).limits[0]?.window?.resetsAt).toBe(Date.parse("2026-10-01T00:00:00.000Z"));
  });

  it("omits the window when neither the bucket nor the account has a reset", () => {
    expect(toUsageReport("kiro", usage({ resetAt: undefined })).limits[0]?.window).toBeUndefined();
  });

  it("reports an unknown unit rather than guessing", () => {
    const report = toUsageReport("kiro", usage({ usageBuckets: [bucket({ unit: "widget" })] }));
    expect(report.limits[0]?.amount.unit).toBe("unknown");
  });

  it("marks a fully consumed bucket exhausted and everything else ok", () => {
    expect(toUsageReport("kiro", usage()).limits[0]?.status).toBe("ok");
    const spent = usage({ usageBuckets: [bucket({ used: 1000 })] });
    expect(toUsageReport("kiro", spent).limits[0]?.status).toBe("exhausted");
  });

  it("keeps a limitless bucket out of the exhausted state", () => {
    const unbounded = usage({ usageBuckets: [bucket({ limit: undefined })] });
    expect(toUsageReport("kiro", unbounded).limits[0]?.status).toBe("ok");
  });

  it("surfaces overage and bonus detail as notes", () => {
    const withExtras = usage({
      usageBuckets: [
        bucket({
          overagesDisplay: "12",
          overageChargesDisplay: "$4.80",
          bonus: { label: "Bonus credits", usedDisplay: "5", limitDisplay: "50" },
        }),
      ],
    });
    expect(toUsageReport("kiro", withExtras).limits[0]?.notes).toEqual([
      "Overage: 12",
      "Overage charges: $4.80",
      "Bonus credits: 5 / 50",
    ]);
  });

  it("reports no limits for an account with no buckets", () => {
    expect(toUsageReport("kiro", usage({ usageBuckets: [] })).limits).toEqual([]);
  });
});
