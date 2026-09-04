// ABOUTME: Login and refresh for OMP's /login flow, over the sessions this machine already has.

import type { OAuthCredentials, OAuthLoginCallbacks } from "@oh-my-pi/pi-ai";
import {
  isApiKey,
  type KiroCredentials,
  loginKiroWithApiKey,
  refreshKiroToken,
  resolveApiRegion,
  resolveKiroCredentials,
} from "kiro-core";

const NO_SESSION_MESSAGE =
  "No Kiro session found. Sign in with `kiro-cli login` (Builder ID, IAM Identity Center, Google, or GitHub), " +
  "then run /login kiro again — or paste a Kiro API key below.";

/**
 * v0.1 establishes no browser flow of its own. Every interactive method Kiro
 * supports already lands a session in the kiro-cli store or the Kiro IDE token
 * file, so this reads one of those and refreshes it. The one credential with no
 * browser step — an API key — is accepted directly.
 */
export async function loginKiro(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
  callbacks.onProgress?.("Looking for an existing Kiro session…");
  const existing = await resolveKiroCredentials();
  if (existing) {
    callbacks.onProgress?.(`Using the ${existing.authMethod} session from kiro-cli.`);
    return existing as unknown as OAuthCredentials;
  }

  if (!callbacks.onPrompt) throw new Error(NO_SESSION_MESSAGE);
  const apiKey = (
    await callbacks.onPrompt({ message: NO_SESSION_MESSAGE, placeholder: "ksk_…", allowEmpty: true })
  ).trim();
  if (!apiKey) throw new Error(NO_SESSION_MESSAGE);
  return (await loginKiroWithApiKey(apiKey, callbacks.onProgress)) as unknown as OAuthCredentials;
}

export async function refreshKiroCredentials(credentials: OAuthCredentials): Promise<OAuthCredentials> {
  return (await refreshKiroToken(credentials as unknown as KiroCredentials)) as unknown as OAuthCredentials;
}

export function getKiroApiKey(credentials: OAuthCredentials): string {
  return credentials.access;
}

/** The token, region, and profile one request runs on. */
export interface ResolvedKiroRequestCredentials {
  accessToken: string;
  region: string;
  profileArn?: string;
}

/**
 * Decide which credential a request or catalog fetch runs on.
 *
 * The key OMP resolves for the provider is the session this package returned
 * from `/login kiro` — but it is also `$KIRO_API_KEY` verbatim when that
 * variable is unset, and Kiro answers a bogus bearer with a 403 the core then
 * has to recover from. So a host key is trusted only when it is recognizably a
 * Kiro credential; anything else defers to the store, which is where the
 * session actually lives.
 *
 * The stored record also carries the region and the profile ARN, and passing
 * the ARN skips the ListAvailableProfiles round trip that a social login cannot
 * answer anyway.
 */
export async function resolveRequestCredentials(hostKey: string | undefined): Promise<ResolvedKiroRequestCredentials> {
  const stored = await resolveKiroCredentials();
  const region = resolveApiRegion(stored?.region);
  if (hostKey && (isApiKey(hostKey) || hostKey === stored?.access)) {
    return { accessToken: hostKey, region, ...(stored?.profileArn ? { profileArn: stored.profileArn } : {}) };
  }
  if (stored) {
    return {
      accessToken: stored.access,
      region,
      ...(stored.profileArn ? { profileArn: stored.profileArn } : {}),
    };
  }
  if (hostKey) return { accessToken: hostKey, region };
  throw new Error("Kiro credentials not set. Run `kiro-cli login`, or set KIRO_API_KEY to a `ksk_` API key.");
}
