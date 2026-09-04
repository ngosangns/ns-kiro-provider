// ABOUTME: Projects the kiro-core catalog onto OMP's provider-model configuration.

import type { Model } from "@oh-my-pi/pi-ai";
import { getKiroEndpoints, type KiroModel } from "ns-kiro-core";

/** The subset of OMP's `ProviderModelConfig` this provider fills in. */
export interface OmpKiroModelConfig {
  id: string;
  name: string;
  reasoning: boolean;
  thinking?: Model["thinking"];
  input: ("text" | "image")[];
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
  contextWindow: number;
  maxTokens: number;
  /**
   * Wire id Kiro accepts, when it differs from {@link id}. Registration and
   * dynamic-discovery models carry no per-credential region or profile, but
   * request time still needs the exact catalog id — a model absent from
   * kiro-core's bootstrap list would otherwise fall back to guessing the wire
   * id from the dash-spelled local `id`, which Kiro rejects as `INVALID_MODEL_ID`.
   */
  kiroModelId: string;
  /** Catalog schema this model's structured effort/thinking fields derive from. */
  additionalModelRequestFieldsSchema?: Record<string, unknown>;
}

export function toOmpModelConfig(model: KiroModel): OmpKiroModelConfig {
  return {
    id: model.id,
    name: model.name,
    reasoning: model.reasoning,
    ...(model.efforts?.length
      ? {
          thinking: {
            mode: "effort",
            efforts: [...model.efforts],
            ...(model.supportsSummarizedThinking ? { supportsDisplay: true } : {}),
          } as Model["thinking"],
        }
      : {}),
    input: [...model.input],
    cost: { ...model.cost },
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    kiroModelId: model.kiroModelId,
    ...(model.additionalModelRequestFieldsSchema
      ? { additionalModelRequestFieldsSchema: model.additionalModelRequestFieldsSchema }
      : {}),
  };
}

export function kiroBaseUrl(region: string): string {
  return getKiroEndpoints(region).runtime;
}
