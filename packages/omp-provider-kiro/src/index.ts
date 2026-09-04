// Extension entry point: registers the Kiro provider with OMP.

import type { Api, Model, OAuthCredentials } from "@oh-my-pi/pi-ai";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import {
  formatSafeError,
  getCachedModels,
  isCacheStale,
  type KiroCredentials,
  kiroModels,
  resolveApiRegion,
  updateKiroModelsCache,
} from "kiro-core";
import { getKiroApiKey, loginKiro, refreshKiroCredentials, resolveRequestCredentials } from "./auth.js";
import { kiroBaseUrl, toOmpModelConfig } from "./models.js";
import { streamKiroForOmp } from "./stream.js";
import { kiroUsageProvider } from "./usage.js";

export { toKiroMessages, toKiroTools } from "./messages.js";
export { toOmpModelConfig } from "./models.js";
export { streamKiroForOmp } from "./stream.js";
export { kiroUsageProvider, toUsageReport } from "./usage.js";

const DEFAULT_REGION = "us-east-1";

/**
 * OMP's own catalog cache keys on the provider name and calls this with the
 * resolved key, so discovery runs here rather than through a credential-aware
 * hook. The regional catalog is fetched only when the local one has gone stale;
 * a failure serves what is cached instead of emptying the model list.
 */
async function fetchDynamicKiroModels(apiKey: string | undefined) {
  let credentials: Awaited<ReturnType<typeof resolveRequestCredentials>> | undefined;
  try {
    credentials = await resolveRequestCredentials(apiKey);
  } catch {
    // Discovery runs before a login too; the bootstrap catalog stands in until
    // there is a credential to fetch the real one with.
    return getCachedModels(DEFAULT_REGION).map(toOmpModelConfig);
  }

  const region = credentials.region;
  if (isCacheStale(region)) {
    try {
      await updateKiroModelsCache(credentials.accessToken, region, credentials.profileArn);
    } catch (error) {
      console.warn(`[omp-provider-kiro] Failed to refresh the Kiro model catalog: ${formatSafeError(error)}`);
    }
  }
  return getCachedModels(region).map(toOmpModelConfig);
}

export default function (pi: ExtensionAPI) {
  pi.registerProvider("kiro", {
    baseUrl: kiroBaseUrl(DEFAULT_REGION),
    api: "kiro-api" as Api,
    apiKey: "$KIRO_API_KEY",
    models: kiroModels.map(toOmpModelConfig),
    fetchDynamicModels: fetchDynamicKiroModels,
    streamSimple: streamKiroForOmp,
    usage: kiroUsageProvider,
    oauth: {
      // The name reflects every method that lands a session kiro-cli can hold.
      name: "Kiro (Builder ID / IAM Identity Center / Google / GitHub)",
      login: loginKiro,
      refreshToken: refreshKiroCredentials,
      getApiKey: getKiroApiKey,
      modifyModels: (models: Model<Api>[], credentials: OAuthCredentials) => {
        // A credential decides the region, and the region decides both the
        // endpoint and which models are actually served — so the catalog is
        // re-projected here rather than at registration, when no credential
        // exists yet.
        const kiroCredentials = credentials as unknown as KiroCredentials;
        const region = resolveApiRegion(kiroCredentials.region);
        const others = models.filter((model) => model.provider !== "kiro");
        const kiro = getCachedModels(region).map(
          (model): Record<string, unknown> => ({
            ...toOmpModelConfig(model),
            api: "kiro-api" as Api,
            provider: "kiro",
            baseUrl: kiroBaseUrl(region),
            kiroModelId: model.kiroModelId,
            kiroRegion: region,
            ...(kiroCredentials.profileArn ? { kiroProfileArn: kiroCredentials.profileArn } : {}),
            ...(model.additionalModelRequestFieldsSchema
              ? { additionalModelRequestFieldsSchema: model.additionalModelRequestFieldsSchema }
              : {}),
          }),
        );
        return [...others, ...(kiro as unknown as Model<Api>[])];
      },
    },
  });
}
