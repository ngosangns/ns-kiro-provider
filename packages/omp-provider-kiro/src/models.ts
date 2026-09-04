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
  };
}

export function kiroBaseUrl(region: string): string {
  return getKiroEndpoints(region).runtime;
}
