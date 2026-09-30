/**
 * OAuth domain type definitions
 *
 * Note: sensitive information (such as appSecret) and provider default endpoint configuration
 * may only live in the provider modules under services, never in the shared layer.
 */

/** Built-in BigModel provider id */
export const BIGMODEL_PROVIDER_ID = "bigmodel" as const;

/** Built-in ZAI provider id */
export const ZAI_PROVIDER_ID = "zai" as const;

/** Error prefix for credential decryption failures */
export const CREDENTIAL_DECRYPT_ERROR_PREFIX = "Failed to decrypt credential: " as const;

/** Stable error code for credential decryption failures */
export const CREDENTIAL_DECRYPT_ERROR_CODE = "ZCODE_CREDENTIAL_DECRYPT_FAILED" as const;

/** Whether the error came from a local credential decryption failure */
export function isCredentialDecryptError(error: unknown): boolean {
  const code = readCredentialErrorCode(error);
  if (code) {
    return code === CREDENTIAL_DECRYPT_ERROR_CODE;
  }

  // Compatible with old payloads with historical errors and cross-border loss of code; new errors should give priority to carrying stable code.
  if (readCredentialErrorMessage(error).startsWith(CREDENTIAL_DECRYPT_ERROR_PREFIX)) {
    return true;
  }

  return false;
}

function readCredentialErrorCode(error: unknown): string {
  if (typeof error === "object" && error !== null && "code" in error) {
    return String((error as { code?: unknown }).code ?? "");
  }

  return "";
}

function readCredentialErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  if (typeof error === "object" && error !== null && "message" in error) {
    return String((error as { message?: unknown }).message ?? "");
  }

  return "";
}

/** OAuth provider identifier */
export type OAuthProviderId =
  | typeof BIGMODEL_PROVIDER_ID
  | typeof ZAI_PROVIDER_ID
  | (string & { readonly __oauthProviderBrand?: never });

/** Provider display metadata */
export interface OAuthProviderMeta {
  id: OAuthProviderId;
  displayName: string;
  enabled: boolean;
  order: number;
}

/** OAuth start request */
export interface OAuthStartRequest {
  provider: OAuthProviderId;
}

/** OAuth start response */
export interface OAuthStartResponse {
  provider: OAuthProviderId;
  authorizeUrl: string;
  state: string;
}

/** App login callback result */
export interface OAuthSessionCallbackResult {
  kind: "session";
  provider: OAuthProviderId;
  userInfo: {
    id: string;
    username: string;
    displayName: string;
    avatarUrl?: string;
  };
}

/** OAuth deep link callback result carrying only attribution parameters */
export interface OAuthAttributionCallbackResult {
  kind: "attribution";
  provider: OAuthProviderId;
  attribution: OAuthLoginAttribution;
}

/** A deep link that arrived late because polling already completed the same login; callers only need to ignore it. */
export interface OAuthDuplicateCallbackResult {
  kind: "duplicate";
  provider: OAuthProviderId;
}

/** Normalized OAuth callback result */
export type OAuthCallbackResult =
  | OAuthSessionCallbackResult
  | OAuthAttributionCallbackResult
  | OAuthDuplicateCallbackResult;

/** The state registration structure the Main process uses when routing a deep link */
export interface OAuthStateRegistration {
  state: string;
  provider?: OAuthProviderId;
}

/** Normalized callback parameters */
export interface OAuthCallbackParams {
  state: string;
  code: string;
  attribution?: OAuthLoginAttribution;
}

/** OAuth login attribution parameters: they come from the official site redirect page or a campaign link */
export interface OAuthLoginAttribution {
  channel_id?: string;
  utm_source?: string;
  utm_campaign?: string;
}

/** Normalized token structure */
export interface OAuthTokenSet {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  zcodeJwtToken?: string;
}

export interface UserInfo {
  id: string;
  username: string;
  displayName: string;
  avatarUrl?: string;
}

export type OAuthCachedSessionRestoreResult =
  | { status: "authenticated"; userInfo: UserInfo }
  | { status: "signed-out" }
  | { status: "reauthentication-required"; reason: "jwt-expired" };

/** Channel the Host uses to tell the Renderer, after detecting an invalid ZCode JWT, to show a confirmation and restart. */
export const ZCODE_JWT_INVALID_BROADCAST_CHANNEL = "auth:zcode-jwt-invalid";

export type JwtExpirationResult =
  | { kind: "valid"; expiresAt: number }
  | { kind: "expired"; expiresAt: number }
  | { kind: "unknown" };

/**
 * Parses only the JWT's exp to judge the local lifetime; it performs no signature verification.
 * Historical or non-standard tokens that cannot be proven expired stay compatible — final
 * validity is still decided by the server.
 */
export function resolveJwtExpiration(
  token: string,
  now = Date.now(),
  clockSkewMs = 30_000,
): JwtExpirationResult {
  try {
    const payloadSegment = token.split(".")[1];
    if (!payloadSegment) {
      return { kind: "unknown" };
    }

    const normalized = payloadSegment.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
    const decoded = globalThis.atob(padded);
    const bytes = Uint8Array.from(decoded, (character) => character.charCodeAt(0));
    const payload = JSON.parse(new TextDecoder().decode(bytes)) as { exp?: unknown };
    if (typeof payload.exp !== "number" || !Number.isFinite(payload.exp) || payload.exp <= 0) {
      return { kind: "unknown" };
    }

    const expiresAt = payload.exp * 1_000;
    return now + Math.max(0, clockSkewMs) >= expiresAt
      ? { kind: "expired", expiresAt }
      : { kind: "valid", expiresAt };
  } catch {
    return { kind: "unknown" };
  }
}

/** Normalized user info */
export interface OAuthUserProfile {
  id: string;
  username: string;
  displayName: string;
  avatarUrl?: string;
  rawProfile?: unknown;
}

/** Logout scope */
export type OAuthLogoutScope = "active" | "all";
