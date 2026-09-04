// Kiro credentials and token refresh.
//
// Auth methods:
//   - "idc": AWS Builder ID or IAM Identity Center (SSO)
//   - "desktop": Google/GitHub social login via the Kiro auth service
//   - "external-idp": enterprise OIDC (e.g. Okta)
//   - "apikey": a long-lived `ksk_` bearer token
//
// Sessions are established by `kiro-cli login` or the Kiro IDE; this package
// reads and refreshes them rather than running its own interactive login.

import { formatSafeError } from "./debug.js";
import { resolveApiRegion } from "./endpoints.js";
import { getKiroIdeCredentials } from "./kiro-ide.js";

export const SSO_OIDC_ENDPOINT = "https://oidc.us-east-1.amazonaws.com";
export const BUILDER_ID_START_URL = "https://view.awsapps.com/start";
export const BUILDER_ID_PROFILE_ARN = "arn:aws:codewhisperer:us-east-1:638616132270:profile/AAAACCCCXXXX";
export const KIRO_DESKTOP_REFRESH_URL = "https://prod.{region}.auth.desktop.kiro.dev/refreshToken";
export const SSO_SCOPES = [
  "codewhisperer:completions",
  "codewhisperer:analysis",
  "codewhisperer:conversations",
  "codewhisperer:transformations",
  "codewhisperer:taskassist",
];

const EXPIRES_BUFFER_MS = 5 * 60 * 1000;

export type KiroAuthMethod = "idc" | "desktop" | "external-idp" | "apikey";

export interface KiroCredentials {
  /** Bearer token sent on every runtime and management request. */
  access: string;
  /** Pipe-packed refresh material; the last segment names the auth method. */
  refresh: string;
  /** Epoch milliseconds, already reduced by {@link EXPIRES_BUFFER_MS}. */
  expires: number;
  clientId: string;
  clientSecret: string;
  region: string;
  authMethod: KiroAuthMethod;
  /** Required for Google/GitHub social profiles; ListAvailableProfiles may return empty for these tokens. */
  profileArn?: string;
  startUrl?: string;
  isEnterprise?: boolean;
}

export const KIRO_DESKTOP_USER_AGENT = "Kiro-Desktop/0.2.13 (darwin; arm64)";

export function kiroUserAgent(service: string, sdkVersion: string): Record<string, string> {
  return {
    "User-Agent": `aws-sdk-js/3.714.0 os/macos/24.3.0 lang/js md/nodejs/22.14.0 api/${service}/3.714.0 exec-env/kiro-cli/2.7.0 m/E`,
    "amz-sdk-invocation-id": "00000000-0000-0000-0000-000000000000",
    "amz-sdk-request": `attempt=1; max=${sdkVersion}`,
  };
}

export function kiroAuthHeaders(token: string): Record<string, string> {
  const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
  if (isApiKey(token)) headers.tokentype = "API_KEY";
  return headers;
}

export function isApiKey(token: string): boolean {
  return token.startsWith("ksk_");
}

/**
 * Validate a `ksk_` API key and resolve the profile it bills against.
 *
 * Unlike an SSO session this needs no browser round trip, so it is the one
 * credential this package can establish on its own: GetProfile with an empty
 * body returns the key's own profile, which both proves the key works and
 * supplies the ARN every runtime request needs.
 */
export async function loginKiroWithApiKey(
  apiKey: string,
  onProgress?: (message: string) => void,
): Promise<KiroCredentials> {
  if (!apiKey.startsWith("ksk_")) {
    throw new Error("Invalid API key format. Kiro API keys start with 'ksk_'.");
  }

  onProgress?.("Validating API key...");

  // API keys are issued for the us-east-1 control plane.
  const region = "us-east-1";
  const managementUrl = `https://management.${resolveApiRegion(region)}.kiro.dev/`;

  const response = await fetch(managementUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-amz-json-1.0",
      "X-Amz-Target": "AmazonCodeWhispererService.GetProfile",
      ...kiroAuthHeaders(apiKey),
      ...kiroUserAgent("codewhispererruntime", "F,C"),
    },
    body: "{}",
  });

  if (!response.ok) {
    let detail = "";
    try {
      detail = await response.text();
    } catch {
      detail = "";
    }
    if (response.status === 401 || response.status === 403 || /Invalid token/i.test(detail)) {
      throw new Error("API key was rejected by Kiro. Check that the key is valid and not expired.");
    }
    throw new Error(`Kiro GetProfile failed: ${response.status} ${response.statusText} ${detail}`.trim());
  }

  const data = (await response.json()) as { profile?: { arn?: string } };
  const profileArn = data.profile?.arn;

  return {
    access: apiKey,
    refresh: `${apiKey}|apikey`,
    expires: Date.now() + 365 * 24 * 60 * 60 * 1000,
    clientId: "",
    clientSecret: "",
    region,
    authMethod: "apikey",
    ...(profileArn ? { profileArn } : {}),
  };
}

export function isExpired(credentials: KiroCredentials): boolean {
  return Date.now() >= credentials.expires;
}

/**
 * Refresh a session and kick off a catalog refresh for its region. The catalog
 * call is deliberately not awaited: a stale catalog degrades model metadata,
 * while a slow one would delay every request that had to reauthenticate.
 */
export async function refreshKiroToken(credentials: KiroCredentials): Promise<KiroCredentials> {
  const refreshed = await refreshKiroTokenInternal(credentials);
  if (!process.env.VITEST) {
    try {
      const { updateKiroModelsCache } = await import("./models.js");
      const region = resolveApiRegion(refreshed.region);
      updateKiroModelsCache(refreshed.access, region, refreshed.profileArn).catch((error) => {
        console.warn(`[kiro-core] Failed to refresh Kiro model catalog in ${region}: ${formatSafeError(error)}`);
      });
    } catch (error) {
      console.warn(`[kiro-core] Failed to start Kiro model catalog refresh: ${formatSafeError(error)}`);
    }
  }
  return refreshed;
}

async function refreshKiroTokenInternal(credentials: KiroCredentials): Promise<KiroCredentials> {
  const {
    getKiroCliCredentials,
    getKiroCliCredentialsAllowExpired,
    saveKiroCliCredentials,
    getKiroCliSocialToken,
    getKiroCliSocialTokenAllowExpired,
  } = await import("./kiro-cli.js");
  const credentialAuthMethod =
    credentials.authMethod ?? (credentials.refresh.split("|").at(-1) === "desktop" ? "desktop" : "idc");
  const getValidCliCredentials = (): KiroCredentials | undefined => {
    if (credentialAuthMethod === "desktop") return getKiroCliSocialToken();
    const cliCreds = getKiroCliCredentials();
    return cliCreds?.authMethod === "idc" ? cliCreds : undefined;
  };
  const getExpiredCliCredentials = (): KiroCredentials | undefined => {
    if (credentialAuthMethod === "desktop") return getKiroCliSocialTokenAllowExpired();
    const cliCreds = getKiroCliCredentialsAllowExpired();
    return cliCreds?.authMethod === "idc" ? cliCreds : undefined;
  };

  // API key credentials are long-lived bearer tokens — there is nothing to
  // refresh. Return them unchanged so the same key keeps being used.
  if (credentials.authMethod === "apikey" || isApiKey(credentials.access)) return credentials;

  // Kiro IDE credentials are IDC credentials. Only consult them for IDC
  // credential refresh — never replace a stored social/desktop session with
  // the IDE's potentially unrelated account.
  if (credentialAuthMethod === "idc") {
    const ideCreds = getKiroIdeCredentials();
    if (ideCreds) return ideCreds;
  }

  // Prefer a fresh CLI token only when it belongs to the same auth family.
  const preCheckCreds = getValidCliCredentials();
  if (preCheckCreds) return preCheckCreds;

  try {
    const refreshed = await refreshKiroTokenDirect(credentials);
    // Write refreshed tokens back to kiro-cli's store so both stay in sync.
    saveKiroCliCredentials(refreshed);
    return refreshed;
  } catch (refreshError) {
    // The CLI may have rotated the refresh token between the pre-check and the
    // network call. Re-read only the matching auth family.
    const retryCreds = getValidCliCredentials();
    if (retryCreds) return retryCreds;

    // The CLI may have a newer refresh token with an expired access token.
    const expiredCliCreds = getExpiredCliCredentials();
    if (expiredCliCreds && expiredCliCreds.refresh !== credentials.refresh) {
      try {
        const refreshedFromCli = await refreshKiroTokenDirect(expiredCliCreds);
        saveKiroCliCredentials(refreshedFromCli);
        return refreshedFromCli;
      } catch {
        // Also failed; continue to the remaining fallbacks.
      }
    }

    // `expires` carries a 5-minute buffer, so the actual token may still work.
    const actualExpiry = credentials.expires + EXPIRES_BUFFER_MS;
    if (credentials.access && Date.now() < actualExpiry) {
      return { ...credentials, expires: actualExpiry };
    }

    throw refreshError;
  }
}

async function refreshKiroTokenDirect(credentials: KiroCredentials): Promise<KiroCredentials> {
  const parts = credentials.refresh.split("|");
  const refreshToken = parts[0] ?? "";
  const authMethod = (parts[parts.length - 1] ?? "idc") as KiroAuthMethod;
  const region = credentials.region || "us-east-1";

  if (authMethod === "apikey") return credentials;

  if (authMethod === "desktop") {
    // Kiro desktop app tokens use a different refresh endpoint.
    const url = KIRO_DESKTOP_REFRESH_URL.replace("{region}", region);
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": KIRO_DESKTOP_USER_AGENT },
      body: JSON.stringify({ refreshToken }),
    });
    if (!response.ok) throw new Error(`Desktop token refresh failed: ${response.status}`);
    const data = (await response.json()) as {
      accessToken: string;
      refreshToken?: string;
      expiresIn: number;
      profileArn?: string;
    };
    if (!data.accessToken) throw new Error("Desktop token refresh: missing accessToken");
    return {
      refresh: `${data.refreshToken || refreshToken}|desktop`,
      access: data.accessToken,
      expires: Date.now() + data.expiresIn * 1000 - EXPIRES_BUFFER_MS,
      clientId: "",
      clientSecret: "",
      region,
      authMethod: "desktop",
      profileArn: data.profileArn || credentials.profileArn,
      startUrl: credentials.startUrl,
    };
  }

  // External IdP (enterprise OIDC, e.g. Okta) — standard public-client refresh
  // against the customer's own token endpoint. kiro-cli does the same:
  // form-encoded grant_type/client_id/refresh_token, snake_case response, and
  // no client secret because the OIDC app is a public PKCE client.
  if (authMethod === "external-idp") {
    const idpClientId = parts[1] ?? "";
    const tokenEndpoint = parts[2] ?? "";
    if (!tokenEndpoint) throw new Error("External IdP token refresh: missing token endpoint");
    const response = await fetch(tokenEndpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
        "User-Agent": "kiro-core",
      },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: idpClientId,
        refresh_token: refreshToken,
      }).toString(),
    });
    if (!response.ok) throw new Error(`External IdP token refresh failed: ${response.status}`);
    const data = (await response.json()) as {
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
    };
    if (!data.access_token) throw new Error("External IdP token refresh: missing access_token");
    const expiresIn = typeof data.expires_in === "number" ? data.expires_in : 3600;
    return {
      refresh: `${data.refresh_token || refreshToken}|${idpClientId}|${tokenEndpoint}|external-idp`,
      access: data.access_token,
      expires: Date.now() + expiresIn * 1000 - EXPIRES_BUFFER_MS,
      clientId: idpClientId,
      clientSecret: "",
      region,
      authMethod: "external-idp",
      profileArn: credentials.profileArn,
    };
  }

  // IDC auth method — SSO OIDC refresh.
  const clientId = parts[1] ?? "";
  const clientSecret = parts[2] ?? "";
  const ssoEndpoint = `https://oidc.${region}.amazonaws.com`;
  const response = await fetch(`${ssoEndpoint}/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...kiroUserAgent("ssooidc", "E") },
    body: JSON.stringify({ clientId, clientSecret, refreshToken, grantType: "refresh_token" }),
  });
  if (!response.ok) throw new Error(`Token refresh failed: ${response.status}`);
  const data = (await response.json()) as { accessToken: string; refreshToken: string; expiresIn: number };
  return {
    refresh: `${data.refreshToken}|${clientId}|${clientSecret}|idc`,
    access: data.accessToken,
    expires: Date.now() + data.expiresIn * 1000 - EXPIRES_BUFFER_MS,
    clientId,
    clientSecret,
    region,
    authMethod: "idc",
    profileArn: credentials.profileArn,
    startUrl: credentials.startUrl,
    isEnterprise: credentials.isEnterprise,
  };
}

/**
 * Resolve a usable session from the stores this machine already has: the
 * kiro-cli database first, then the Kiro IDE's token file. Expired material is
 * accepted and refreshed rather than rejected, because a refresh token outlives
 * its access token and rejecting here would ask the user to log in again for a
 * session that is still good.
 */
export async function resolveKiroCredentials(): Promise<KiroCredentials | undefined> {
  const { getKiroCliCredentials, getKiroCliCredentialsAllowExpired } = await import("./kiro-cli.js");
  const fresh = getKiroCliCredentials() ?? getKiroIdeCredentials();
  if (fresh) return fresh;

  const stale = getKiroCliCredentialsAllowExpired();
  if (!stale) return undefined;
  return refreshKiroToken(stale);
}
