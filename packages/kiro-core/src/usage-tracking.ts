// ABOUTME: Opt-in usage tracking config for Kiro dollar-value and cache-usage estimates.
// ABOUTME: Converts metering credits to USD and configures conservative cache-read estimation.

/**
 * Kiro's published add-on credit rate (https://kiro.dev/pricing/). Used as the
 * conversion default so an enabled config needs no rate at all.
 */
export const DEFAULT_USD_PER_CREDIT = 0.04;

/** Match the usual prompt-cache TTL and Anthropic's default cache lifetime. */
export const DEFAULT_ESTIMATED_CACHE_TIMEOUT_MS = 5 * 60 * 1000;

/** Resolved estimation policy. Both estimates are independently opt-in. */
export interface KiroUsageTracking {
  estimateDollarValue: boolean;
  usdPerCredit: number;
  estimateCacheUsage: boolean;
  estimatedCacheTimeout: number;
}

export const KIRO_USAGE_TRACKING_DISABLED: KiroUsageTracking = Object.freeze({
  estimateDollarValue: false,
  usdPerCredit: DEFAULT_USD_PER_CREDIT,
  estimateCacheUsage: false,
  estimatedCacheTimeout: DEFAULT_ESTIMATED_CACHE_TIMEOUT_MS,
});

/** `MeteringEvent.unit` values that denote credits. The service has emitted both. */
const CREDIT_UNITS = new Set(["credit", "credits"]);

/**
 * Resolve an estimation policy from a plain settings record — the shape of
 * upstream's `usageTracking` section, but supplied by the host rather than read
 * from any particular settings file.
 *
 * Each estimate fails closed independently on malformed input.
 */
export function resolveKiroUsageTracking(section: unknown): KiroUsageTracking {
  const raw = asRecord(section);
  if (!raw) return { ...KIRO_USAGE_TRACKING_DISABLED };

  const legacyEnabled = raw.enabled === true;
  const estimateDollarValue = raw.estimateDollarValue === true || legacyEnabled;
  const estimateCacheUsage = raw.estimateCacheUsage === true;
  let usdPerCredit = DEFAULT_USD_PER_CREDIT;
  let estimatedCacheTimeout = DEFAULT_ESTIMATED_CACHE_TIMEOUT_MS;

  if (estimateDollarValue) {
    const rate = resolveNonNegativeNumber(raw.usdPerCredit, DEFAULT_USD_PER_CREDIT);
    if (rate === undefined) {
      console.warn(
        "[kiro-core] Ignoring usageTracking.estimateDollarValue: usdPerCredit must be a finite number >= 0.",
      );
    } else {
      usdPerCredit = rate;
    }
  }

  let cacheEnabled = estimateCacheUsage;
  if (estimateCacheUsage) {
    const timeout = resolveNonNegativeNumber(raw.estimatedCacheTimeout, DEFAULT_ESTIMATED_CACHE_TIMEOUT_MS);
    if (timeout === undefined) {
      console.warn(
        "[kiro-core] Ignoring usageTracking.estimateCacheUsage: estimatedCacheTimeout must be a finite number >= 0.",
      );
      cacheEnabled = false;
    } else {
      estimatedCacheTimeout = timeout;
    }
  }

  return {
    estimateDollarValue:
      estimateDollarValue && resolveNonNegativeNumber(raw.usdPerCredit, DEFAULT_USD_PER_CREDIT) !== undefined,
    usdPerCredit,
    estimateCacheUsage: cacheEnabled,
    estimatedCacheTimeout,
  };
}

/**
 * Estimated USD-equivalent value of one turn's credits, or `undefined` when the
 * record cannot be trusted.
 *
 * This is a conversion of Kiro's own credit count, NOT a billed amount: credits
 * included in a subscription may carry no marginal charge at all.
 */
export function estimateKiroCreditCost(
  tracking: KiroUsageTracking,
  metering: { credits?: number; unit?: string } | null | undefined,
): number | undefined {
  if (!tracking.estimateDollarValue || !metering) return undefined;
  if (typeof metering.unit !== "string" || !CREDIT_UNITS.has(metering.unit.toLowerCase())) return undefined;
  const { credits } = metering;
  if (typeof credits !== "number" || !Number.isFinite(credits) || credits < 0) return undefined;
  return credits * tracking.usdPerCredit;
}

function resolveNonNegativeNumber(value: unknown, defaultValue: number): number | undefined {
  if (value === undefined) return defaultValue;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return undefined;
  return value;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}
