import type { WebZaiOAuthProviderConfig } from "./zaiWebOAuthProvider.js";
import {
  buildZCodeEndpointUrls,
  DEFAULT_ZCODE_ENDPOINT_ORIGIN,
  resolveBigModelApiOrigin,
} from "@zcode/shared";

interface WebImportMetaEnv {
  VITE_DEV_ORIGIN?: string;
  VITE_ZAI_OAUTH_CLIENT_ID?: string;
  VITE_ZAI_OAUTH_ORIGIN?: string;
  VITE_BIGMODEL_OAUTH_ORIGIN?: string;
  VITE_BIGMODEL_OAUTH_APP_ID?: string;
  VITE_ZCODE_BASE_URL?: string;
  VITE_ZCODE_ENDPOINT_ORIGIN?: string;
  VITE_WEB_REMOTE_ALLOW_DEV_RETURN_TO?: string;
}

export interface WebZaiOAuthConfig extends WebZaiOAuthProviderConfig {
  devOrigin?: string;
  shareRedirectUri: string;
  allowDevReturnToRedirect: boolean;
}

function normalizeZaiOAuthOrigin(value: string): string {
  return new URL(value.trim()).origin;
}

function buildZaiOAuthAuthorizeUrl(origin: string | undefined): string {
  return `${normalizeZaiOAuthOrigin(origin?.trim() || "https://chat.z.ai")}/api/oauth/authorize`;
}

/**
 * Authorization portal for BigModel.
 *
 * Must follow the environment: the test environment is programmed hard and bigmodel.cn will bring the test account to the production authorization page. The construction period consists of
 * vite.config uses resolveBigModelApiOrigin to inject VITE_BIGMODEL_OAUTH_ORIGIN; here
 * resolveBigModelApiOrigin({}) is just the last resort (equivalent to producing origin).
 */
function buildBigModelAuthorizeUrl(origin: string | undefined): string {
  const trimmed = origin?.trim();
  return `${trimmed ? new URL(trimmed).origin : resolveBigModelApiOrigin({})}/login`;
}

function createWebZaiOAuthConfig(env: WebImportMetaEnv = {}): WebZaiOAuthConfig {
  const devOrigin = env.VITE_DEV_ORIGIN?.trim().replace(/\/$/, "");
  const zcodeEndpointUrls = buildZCodeEndpointUrls(
    env.VITE_ZCODE_BASE_URL?.trim() ||
      env.VITE_ZCODE_ENDPOINT_ORIGIN?.trim() ||
      DEFAULT_ZCODE_ENDPOINT_ORIGIN,
  );

  return {
    // ZAI's current OAuth authorization entrance uses the /api/oauth prefix. If you continue to use /auth/oauth, the old entrance will be opened.
    authorizeUrl: buildZaiOAuthAuthorizeUrl(env.VITE_ZAI_OAUTH_ORIGIN),
    tokenUrl: "/api/v1/oauth/token",
    // client_id will appear in the authorization URL and is a public configuration; VITE_ injection is allowed here, but secret/token cannot be placed.
    clientId: env.VITE_ZAI_OAUTH_CLIENT_ID?.trim() || "client_P8X5CMWmlaRO9gyO-KSqtg",
    bigmodelAuthorizeUrl: buildBigModelAuthorizeUrl(env.VITE_BIGMODEL_OAUTH_ORIGIN),
    // BigModel uses appId instead of client_id, and the default value is "zcode" used on the desktop.
    bigmodelAppId: env.VITE_BIGMODEL_OAUTH_APP_ID?.trim() || "zcode",
    redirectUri: zcodeEndpointUrls.webShareCallbackUrl,
    shareRedirectUri: zcodeEndpointUrls.webShareCallbackUrl,
    ...(devOrigin ? { devOrigin } : {}),
    allowDevReturnToRedirect: env.VITE_WEB_REMOTE_ALLOW_DEV_RETURN_TO === "true",
  };
}

const env = ((import.meta as ImportMeta & { env?: WebImportMetaEnv }).env ??
  {}) as WebImportMetaEnv;

export const WEB_ZAI_OAUTH_CONFIG: WebZaiOAuthConfig = createWebZaiOAuthConfig(env);

export function resolveWebAuthDevReturnTo(config: WebZaiOAuthConfig): string | undefined {
  return config.devOrigin ? `${config.devOrigin}/share/callback` : undefined;
}
