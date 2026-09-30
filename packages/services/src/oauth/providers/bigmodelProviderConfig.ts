import { BIGMODEL_PROVIDER_ID, buildBigModelApiUrl } from "@zcode/shared";
import type { OAuthProviderRuntimeConfig } from "../runtimeConfig.js";
import {
  buildDesktopOAuthRedirectUriFromEnv,
  buildZCodeApiUrlFromEnv,
  readBoolean,
  readEnv,
} from "./configUtils.js";

const BIGMODEL_USERINFO_PATH = "/api/biz/customer/getCustomerInfo";
const BIGMODEL_AUTHORIZE_PATH = "/login";

const BIGMODEL_OAUTH_PROVIDER_CONFIG: Omit<OAuthProviderRuntimeConfig, "appSecret"> = {
  id: BIGMODEL_PROVIDER_ID,
  displayName: "BigModel",
  enabled: true,
  order: 0,
  authorizeUrl: "https://bigmodel.cn/login",
  tokenUrl: "https://zcode.z.ai/api/v1/oauth/token",
  userinfoUrl: buildBigModelApiUrl({ ZCODE_ENV: "production" }, BIGMODEL_USERINFO_PATH),
  appId: "zcode",
  redirectUri: "zcode://oauth/callback",
};

export function createBigModelProviderRuntimeConfig(
  env: NodeJS.ProcessEnv,
): OAuthProviderRuntimeConfig {
  return {
    ...BIGMODEL_OAUTH_PROVIDER_CONFIG,
    enabled: readBoolean(env, "BIGMODEL_OAUTH_ENABLED", BIGMODEL_OAUTH_PROVIDER_CONFIG.enabled),
    authorizeUrl:
      readEnv(env, "BIGMODEL_OAUTH_AUTHORIZE_URL") ??
      buildBigModelApiUrl(env, BIGMODEL_AUTHORIZE_PATH),
    tokenUrl:
      readEnv(env, "BIGMODEL_OAUTH_TOKEN_URL") ??
      buildZCodeApiUrlFromEnv(env, "/api/v1/oauth/token"),
    userinfoUrl: resolveBigModelUserinfoUrl(env),
    appId: readEnv(env, "BIGMODEL_OAUTH_APP_ID") ?? BIGMODEL_OAUTH_PROVIDER_CONFIG.appId,
    redirectUri: buildDesktopOAuthRedirectUriFromEnv(env),
    // Historical fallback secret has been deprecated, and the built-in key can no longer be entered into the runtime configuration.
    // Currently BigModel callback only consumes zcode OAuth token routes, explicit appSecret is reserved only for
    // The old interface is compatible with scenarios and must remain undefined when missing.
    appSecret: readEnv(env, "BIGMODEL_OAUTH_APP_SECRET"),
  };
}

export function resolveBigModelUserinfoUrl(env: NodeJS.ProcessEnv): string {
  return (
    readEnv(env, "BIGMODEL_OAUTH_USERINFO_URL") ?? buildBigModelApiUrl(env, BIGMODEL_USERINFO_PATH)
  );
}
