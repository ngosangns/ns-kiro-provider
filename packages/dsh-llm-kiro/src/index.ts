/**
 * Kiro adapter plugin for the DeepSeek Harness LLM seam.
 *
 * Kiro speaks its own streaming protocol — AWS event-stream framing over
 * `generateAssistantResponse` — which no configurable route can describe, so
 * this registers a real adapter rather than a profile on a generic one.
 *
 * Sessions come from the machine: `kiro-cli login` (Builder ID, IAM Identity
 * Center, Google, GitHub, enterprise OIDC) or the Kiro IDE. This plugin reads
 * that session, refreshes it when it expires, and writes the refresh back so
 * both tools stay on the same token.
 *
 * ```yaml
 * - id: llm-kiro
 *   name: 'dsh-llm-kiro'
 *   config:
 *     provider: kiro
 *     region: us-east-1
 * ```
 *
 * @module dsh-llm-kiro
 */

import type { Context } from "@deepseek-ai/cordis";
import type { AttachmentStore } from "@deepseek-ai/dsh-attachment";
import { LlmError } from "@deepseek-ai/dsh-llm";
import z from "@deepseek-ai/schemastery";
import { isExpired, type KiroCredentials, refreshKiroToken, resolveKiroCredentials } from "kiro-core";
import { KiroAdapter } from "./adapter.js";

export { KiroAdapter, type KiroAdapterOptions } from "./adapter.js";
export { toLlmError } from "./errors.js";
export { toKiroMessages } from "./messages.js";

export const name = "llm-kiro";

/**
 * Only `llm` is a hard dependency. Cordis's object form of `inject` maps a
 * service name to intercept config rather than marking it optional, and reading
 * an uninjected service throws — so the optional attachment store is picked up
 * through a scoped `ctx.inject` inside {@link apply} instead.
 */
export const inject = ["llm"];

export interface Config {
  /** Provider route to register the adapter under. */
  provider: string;
  /** Display name for selectors and status labels. */
  displayName: string;
  /**
   * Kiro API region. Absent derives it from the credential, which is what a
   * single-account machine wants; pin it when one account spans regions.
   */
  region?: string;
}

export const Config: z<Config> = z.object({
  provider: z.string().default("kiro").description("Provider route to register the adapter under."),
  displayName: z.string().default("Kiro").description("Display name shown in model selectors."),
  region: z.string().description("Kiro API region; derived from the credential when absent."),
});

/**
 * Resolve the current session for one request.
 *
 * Sessions are re-read rather than cached: kiro-cli rotates the token from
 * another process, and a cached copy would send a token the service has already
 * replaced. The read is a local file, so the cost is not worth the staleness.
 */
async function currentCredentials(): Promise<KiroCredentials> {
  const credentials = await resolveKiroCredentials();
  if (!credentials) {
    throw new LlmError(
      "No Kiro session found. Sign in with `kiro-cli login`, or install the Kiro IDE and sign in there.",
      "MISSING_CREDENTIAL",
    );
  }
  return isExpired(credentials) ? refreshKiroToken(credentials) : credentials;
}

export function apply(ctx: Context, config: Config): void {
  // Held here rather than read per request: a deployment without the attachment
  // service never mounts it, and reading an uninjected service throws. The
  // scoped fiber below sets it while the service exists and clears it when the
  // service goes away, so an image-capable deployment gains image support
  // without a text-only one failing to boot.
  let attachments: AttachmentStore | undefined;
  ctx.inject(["attachments"], (scope) => {
    attachments = scope.attachments;
    scope.effect(
      () => () => {
        attachments = undefined;
      },
      "dsh-llm-kiro attachment store",
    );
  });

  const adapter = new KiroAdapter({
    provider: config.provider,
    displayName: config.displayName,
    credentials: currentCredentials,
    attachments: () => attachments,
    ...(config.region ? { region: config.region } : {}),
  });

  ctx.llm.registerAdapter([config.provider], adapter);
}
