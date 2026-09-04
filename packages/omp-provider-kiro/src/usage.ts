// ABOUTME: Projects Kiro's account usage onto OMP's normalized usage report.

import type { UsageFetchParams, UsageProvider, UsageReport, UsageUnit } from "@oh-my-pi/pi-ai";
import { fetchKiroUsage, type KiroCredentials, type KiroProviderUsage, type KiroProviderUsageBucket } from "kiro-core";

/** Kiro reports credit consumption; anything else it names is passed through as unknown. */
function toUsageUnit(unit: string | undefined): UsageUnit {
  switch (unit?.toLowerCase()) {
    case "credit":
    case "credits":
      return "credits";
    case "request":
    case "requests":
      return "requests";
    case "token":
    case "tokens":
      return "tokens";
    case "usd":
      return "usd";
    default:
      return "unknown";
  }
}

function toResetMs(iso: string | undefined): number | undefined {
  if (!iso) return undefined;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? undefined : ms;
}

function toLimit(provider: string, bucket: KiroProviderUsageBucket, usage: KiroProviderUsage) {
  const resetsAt = toResetMs(bucket.resetAt ?? usage.resetAt);
  const exhausted = bucket.limit !== undefined && bucket.used >= bucket.limit;
  const notes: string[] = [];
  if (bucket.overagesDisplay) notes.push(`Overage: ${bucket.overagesDisplay}`);
  if (bucket.overageChargesDisplay) notes.push(`Overage charges: ${bucket.overageChargesDisplay}`);
  if (bucket.bonus?.limitDisplay) {
    notes.push(`${bucket.bonus.label}: ${bucket.bonus.usedDisplay ?? "0"} / ${bucket.bonus.limitDisplay}`);
  }

  return {
    id: bucket.id,
    label: bucket.label,
    scope: { provider, ...(bucket.resourceType ? { tier: bucket.resourceType } : {}) },
    ...(resetsAt !== undefined ? { window: { id: "billing-period", label: "Billing period", resetsAt } } : {}),
    amount: {
      used: bucket.used,
      ...(bucket.limit !== undefined ? { limit: bucket.limit } : {}),
      unit: toUsageUnit(bucket.unit),
    },
    // `warning` is deliberately never reported: Kiro exposes no threshold of its
    // own, and inventing one here would put a warning in front of the user that
    // the service never raised.
    status: exhausted ? ("exhausted" as const) : ("ok" as const),
    ...(notes.length > 0 ? { notes } : {}),
  };
}

/**
 * OMP's `/settings` usage panel over Kiro's GetUsageLimits response.
 *
 * The credential arrives from the host's auth storage rather than the kiro-cli
 * store, because a user may hold several Kiro accounts and the panel reports
 * the one it is asking about.
 */
export function toUsageReport(provider: string, usage: KiroProviderUsage, fetchedAt = Date.now()): UsageReport {
  return {
    provider,
    fetchedAt,
    limits: (usage.usageBuckets ?? []).map((bucket) => toLimit(provider, bucket, usage)),
    ...(usage.subscriptionTitle ? { notes: [usage.subscriptionTitle] } : {}),
    metadata: {
      ...(usage.manageUrl ? { manageUrl: usage.manageUrl } : {}),
      ...(usage.overageStatus ? { overageStatus: usage.overageStatus } : {}),
      ...(usage.daysUntilReset !== undefined ? { daysUntilReset: usage.daysUntilReset } : {}),
    },
    raw: usage.raw,
  };
}

export const kiroUsageProvider: UsageProvider = {
  id: "kiro",

  async fetchUsage(params: UsageFetchParams): Promise<UsageReport | null> {
    const token = params.credential.accessToken ?? params.credential.apiKey;
    if (!token) return null;

    const usage = await fetchKiroUsage({
      access: token,
      refresh: "",
      expires: params.credential.expiresAt ?? 0,
      clientId: "",
      clientSecret: "",
      // GetUsageLimits is regional to the profile, and the core's resolver
      // probes the canonical regions from this starting point.
      region: "us-east-1",
      authMethod: params.credential.type === "api_key" ? "apikey" : "idc",
    } satisfies KiroCredentials);

    return toUsageReport(params.provider, usage);
  },

  validatesCredentials: true,
};
