// Structured reasoning-effort handling for Kiro runtime requests.

import { KIRO_EFFORT_ORDER, type KiroEffort, type KiroModelSpec } from "./types.js";

export type KiroEffortField = "reasoning" | "output_config";

export interface KiroEffortConfig {
  field: KiroEffortField;
  values: readonly string[];
  summarizedThinking: boolean;
}

export type KiroAdditionalModelRequestFields =
  | { reasoning: { effort: string } }
  | {
      output_config: { effort: string };
      thinking: { type: "adaptive"; display?: "summarized" };
    };

const GPT_EFFORT_VALUES = ["low", "medium", "high", "xhigh"] as const;
const CLAUDE_EXTENDED_EFFORT_VALUES = ["low", "medium", "high", "xhigh", "max"] as const;
const CLAUDE_MAX_EFFORT_VALUES = ["low", "medium", "high", "max"] as const;

const CLAUDE_EXTENDED_EFFORT_MODELS = new Set([
  "claude-opus-4.8",
  "claude-opus-4.7",
  "claude-sonnet-5",
  "claude-fable-5",
]);
const CLAUDE_MAX_EFFORT_MODELS = new Set([
  "claude-opus-4.6",
  "claude-sonnet-4.6",
  "claude-opus-4.6-1m",
  "claude-sonnet-4.6-1m",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Derive Kiro's structured effort field and allowed enum from an authenticated catalog schema. */
export function deriveKiroEffort(schema: unknown): KiroEffortConfig | undefined {
  if (!isRecord(schema) || !isRecord(schema.properties)) return undefined;

  for (const field of ["reasoning", "output_config"] as const) {
    const fieldSchema = schema.properties[field];
    if (!isRecord(fieldSchema) || !isRecord(fieldSchema.properties)) continue;

    const effortSchema = fieldSchema.properties.effort;
    if (!isRecord(effortSchema) || !Array.isArray(effortSchema.enum) || effortSchema.enum.length === 0) continue;
    if (!effortSchema.enum.every((value) => typeof value === "string" && value.length > 0)) continue;

    const thinkingSchema = schema.properties.thinking;
    const displaySchema =
      isRecord(thinkingSchema) && isRecord(thinkingSchema.properties) ? thinkingSchema.properties.display : undefined;
    const summarizedThinking =
      isRecord(displaySchema) && Array.isArray(displaySchema.enum) && displaySchema.enum.includes("summarized");

    return { field, values: [...new Set(effortSchema.enum as string[])], summarizedThinking };
  }

  return undefined;
}

/** Known-model compatibility used only before catalog schema metadata is available. */
export function fallbackKiroEffort(kiroModelId: string): KiroEffortConfig | undefined {
  const normalizedId = kiroModelId.toLowerCase().replace(/(\d)-(\d)/g, "$1.$2");
  if (normalizedId.startsWith("openai-gpt")) {
    return { field: "reasoning", values: GPT_EFFORT_VALUES, summarizedThinking: false };
  }
  if (CLAUDE_EXTENDED_EFFORT_MODELS.has(normalizedId)) {
    return { field: "output_config", values: CLAUDE_EXTENDED_EFFORT_VALUES, summarizedThinking: true };
  }
  if (CLAUDE_MAX_EFFORT_MODELS.has(normalizedId)) {
    return { field: "output_config", values: CLAUDE_MAX_EFFORT_VALUES, summarizedThinking: false };
  }
  return undefined;
}

/** Prefer catalog schema; fall back only when it is absent. */
export function getKiroEffortConfig(schema: unknown, kiroModelId: string): KiroEffortConfig | undefined {
  if (schema !== undefined) return deriveKiroEffort(schema);
  return fallbackKiroEffort(kiroModelId);
}

/**
 * Clamp a requested effort to what the model declares. Hosts each ship their
 * own clamp over their own model type; the core repeats it over
 * {@link KiroModelSpec} so a projection is the only thing an adapter owes.
 */
export function clampKiroEffort(model: KiroModelSpec, requested: KiroEffort | undefined): KiroEffort | undefined {
  if (!requested || !model.reasoning) return undefined;
  const supported = model.efforts;
  if (!supported || supported.length === 0) return requested;
  if (supported.includes(requested)) return requested;

  // Nearest supported neighbour, preferring the more intensive side so a
  // request for more thinking is never silently answered with less than the
  // model's own minimum.
  const requestedRank = KIRO_EFFORT_ORDER.indexOf(requested);
  let best: KiroEffort | undefined;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const candidate of supported) {
    const distance = Math.abs(KIRO_EFFORT_ORDER.indexOf(candidate) - requestedRank);
    if (distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }
  return best;
}

/** Map a clamped effort onto a value present in the selected model's Kiro enum. */
export function mapEffortToKiroValue(
  model: KiroModelSpec,
  level: KiroEffort,
  config: KiroEffortConfig,
): string | undefined {
  if (config.values.length === 0) return undefined;

  const explicitlyMapped = model.effortMap?.[level];
  if (typeof explicitlyMapped === "string" && config.values.includes(explicitlyMapped)) {
    return explicitlyMapped;
  }

  const target = level === "minimal" ? "low" : level;
  if (config.values.includes(target)) return target;

  const targetIndex = KIRO_EFFORT_ORDER.indexOf(target);
  if (targetIndex >= 0) {
    for (let index = targetIndex; index < KIRO_EFFORT_ORDER.length; index++) {
      const candidate = KIRO_EFFORT_ORDER[index];
      if (candidate && config.values.includes(candidate)) return candidate;
    }
    for (let index = targetIndex - 1; index >= 0; index--) {
      const candidate = KIRO_EFFORT_ORDER[index];
      if (candidate && config.values.includes(candidate)) return candidate;
    }
  }

  return config.values[0];
}

/** Build the top-level Kiro runtime field for one requested reasoning level. */
export function buildKiroAdditionalModelRequestFields(
  model: KiroModelSpec,
  kiroModelId: string,
  level: KiroEffort | undefined,
): KiroAdditionalModelRequestFields | undefined {
  if (!level || !model.reasoning) return undefined;

  const config = getKiroEffortConfig(model.additionalModelRequestFieldsSchema, kiroModelId);
  if (!config) return undefined;
  const clamped = clampKiroEffort(model, level);
  if (!clamped) return undefined;
  const effort = mapEffortToKiroValue(model, clamped, config);
  if (!effort) return undefined;

  return config.field === "output_config"
    ? {
        output_config: { effort },
        thinking: {
          type: "adaptive",
          ...(config.summarizedThinking ? { display: "summarized" as const } : {}),
        },
      }
    : { reasoning: { effort } };
}
