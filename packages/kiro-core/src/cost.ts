// ABOUTME: Cost attribution over the neutral model descriptor.
// ABOUTME: Each host ships its own calculator; the core repeats it so the seam stays one-way.

import type { KiroCost, KiroUsage } from "./types.js";

const PER_MILLION = 1_000_000;

/**
 * Fill in {@link KiroUsage.cost} from the model's per-million rates.
 *
 * Cache tokens are billed only when Kiro reported them; an unreported count
 * contributes nothing rather than being charged at the input rate.
 */
export function calculateKiroCost(cost: KiroCost, usage: KiroUsage): KiroUsage["cost"] {
  const input = (usage.input * cost.input) / PER_MILLION;
  const output = (usage.output * cost.output) / PER_MILLION;
  const cacheRead = ((usage.cacheRead ?? 0) * cost.cacheRead) / PER_MILLION;
  const cacheWrite = ((usage.cacheWrite ?? 0) * cost.cacheWrite) / PER_MILLION;
  return { input, output, cacheRead, cacheWrite, total: input + output + cacheRead + cacheWrite };
}
