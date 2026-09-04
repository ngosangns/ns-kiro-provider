// ABOUTME: Cost attribution over the neutral model descriptor.
// ABOUTME: Each host ships its own calculator; the core repeats it so the seam stays one-way.

import type { KiroCost, KiroUsage } from "./types.js";

const PER_MILLION = 1_000_000;

/** Fill in {@link KiroUsage.cost} from the model's per-million rates. */
export function calculateKiroCost(cost: KiroCost, usage: KiroUsage): KiroUsage["cost"] {
  const input = (usage.input * cost.input) / PER_MILLION;
  const output = (usage.output * cost.output) / PER_MILLION;
  return { input, output, cacheRead: 0, cacheWrite: 0, total: input + output };
}
