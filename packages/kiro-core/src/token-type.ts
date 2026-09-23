// ABOUTME: Derives the `tokentype` request header Kiro requires for external IdP bearer tokens.
// ABOUTME: Kiro rejects an external IdP access token with 403 unless the header is present.

import { getKiroCliExternalIdpCredentials } from "./kiro-cli.js";

/**
 * Audience used by some Kiro external IdP integrations. Other tenants can use
 * their own audience, so the Kiro CLI's typed credential record is also checked.
 */
const EXTERNAL_IDP_AUDIENCE = "api://kiro";

/**
 * True when the access token is an external IdP (enterprise OIDC) JWT.
 *
 * Preserve recognition of the known audience. For tenant-specific audiences,
 * only accept an exact match with the token in Kiro CLI's External IdP slot;
 * never infer the auth method from an arbitrary JWT.
 */
export function isExternalIdpAccessToken(accessToken: string | undefined): boolean {
  if (typeof accessToken !== "string" || !accessToken) return false;
  const segments = accessToken.split(".");
  const payloadSegment = segments[1];
  if (segments.length === 3 && payloadSegment) {
    try {
      const payload = JSON.parse(
        Buffer.from(payloadSegment.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf-8"),
      ) as { aud?: unknown };
      if (
        payload.aud === EXTERNAL_IDP_AUDIENCE ||
        (Array.isArray(payload.aud) && payload.aud.includes(EXTERNAL_IDP_AUDIENCE))
      ) {
        return true;
      }
    } catch {
      // Opaque tokens can still have an authoritative local credential type.
    }
  }
  try {
    return getKiroCliExternalIdpCredentials()?.access === accessToken;
  } catch {
    return false;
  }
}

/**
 * Extra headers Kiro's management and runtime APIs require for the given token.
 *
 * kiro-cli sends `tokentype: EXTERNAL_IDP` on every request made with an
 * external IdP token (its `TokenTypeInterceptor`); without it both
 * `management.*.kiro.dev` and `runtime.*.kiro.dev` answer 403 "Invalid token".
 * Returns an empty object for AWS SSO and desktop tokens, which must not carry
 * the header.
 */
export function kiroTokenTypeHeaders(accessToken: string | undefined): Record<string, string> {
  return isExternalIdpAccessToken(accessToken) ? { tokentype: "EXTERNAL_IDP" } : {};
}
