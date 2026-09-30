import {
  ZAI_PROVIDER_ID,
  buildRuntimeZaiBusinessUrl,
  buildRuntimeZaiOAuthUrl,
  resolveZaiOAuthClientId,
} from "@zcode/shared";
import type { OAuthProviderRuntimeConfig } from "../runtimeConfig.js";
import {
  buildDesktopOAuthRedirectUriFromEnv,
  buildZCodeApiUrlFromEnv,
  readBoolean,
  readEnv,
} from "./configUtils.js";

const ZAI_OAUTH_PROVIDER_CONFIG: Omit<OAuthProviderRuntimeConfig, "appSecret"> = {
  id: ZAI_PROVIDER_ID,
  displayName: "Z.ai",
  enabled: true,
  order: 1,
  // ZAI's current OAuth authorization entrance uses the /api/oauth prefix. If you continue to use /auth/oauth, the old entrance will be opened.
  authorizeUrl: "https://chat.z.ai/api/oauth/authorize",
  tokenUrl: "https://zcode.z.ai/api/v1/oauth/token",
  userinfoUrl: "https://chat.z.ai/api/oauth/userinfo",
  businessLoginUrl: "https://api.z.ai/api/auth/z/login",
  // The production client_id is not a secret, but keeping the fallback prevents old builds without env configured from being unable to log in directly.
  appId: "client_P8X5CMWmlaRO9gyO-KSqtg",
  redirectUri: "zcode://oauth/callback",
};

export function createZaiProviderRuntimeConfig(env: NodeJS.ProcessEnv): OAuthProviderRuntimeConfig {
  return {
    ...ZAI_OAUTH_PROVIDER_CONFIG,
    enabled: readBoolean(env, "ZAI_OAUTH_ENABLED", ZAI_OAUTH_PROVIDER_CONFIG.enabled),
    authorizeUrl:
      readEnv(env, "ZAI_OAUTH_AUTHORIZE_URL") ??
      buildRuntimeZaiOAuthUrl(env, "/api/oauth/authorize"),
    tokenUrl:
      readEnv(env, "ZAI_OAUTH_TOKEN_URL") ?? buildZCodeApiUrlFromEnv(env, "/api/v1/oauth/token"),
    userinfoUrl: resolveZaiUserinfoUrl(env),
    businessLoginUrl:
      readEnv(env, "ZAI_BUSINESS_LOGIN_URL") ??
      buildRuntimeZaiBusinessUrl(env, "/api/auth/z/login"),
    appId:
      // client_id is the public OAuth app identifier, which is covered by the environment to avoid mixed use of test/production OAuth applications.
      resolveZaiOAuthClientId(env),
    redirectUri: buildDesktopOAuthRedirectUriFromEnv(env),
  };
}

export function resolveZaiUserinfoUrl(env: NodeJS.ProcessEnv): string {
  return (
    readEnv(env, "ZAI_OAUTH_USERINFO_URL") ?? buildRuntimeZaiOAuthUrl(env, "/api/oauth/userinfo")
  );
}
