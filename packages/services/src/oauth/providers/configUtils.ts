import {
  ZCODE_VERSION,
  buildRuntimeZCodeApiUrl,
  buildRuntimeZCodeEndpointUrls,
} from "@zcode/shared";

const DESKTOP_OAUTH_CALLBACK_URI = "zcode://oauth/callback";

export function readEnv(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const value = env[key];
  if (!value) {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

export function readBoolean(env: NodeJS.ProcessEnv, key: string, fallback: boolean): boolean {
  const raw = readEnv(env, key);
  if (raw == null) {
    return fallback;
  }

  return raw !== "0" && raw.toLowerCase() !== "false";
}

export function buildZCodeApiUrlFromEnv(env: NodeJS.ProcessEnv, path: string): string {
  // OAuth provider is a runtime configuration and must be passed in env.ZCODE_ENV;
  // The address comes from the general variable of .env, which is online by default; login and token exchange must use the same configuration source.
  return buildRuntimeZCodeApiUrl(env, path);
}

export function buildDesktopOAuthRedirectUriFromEnv(env: NodeJS.ProcessEnv): string {
  const url = new URL("/app/oauth/login", buildRuntimeZCodeEndpointUrls(env).origin);
  url.searchParams.set("redirect", DESKTOP_OAUTH_CALLBACK_URI);
  // The website needs to decide whether to turn off automatic deep links based on the App version; when the version is missing, it must be compatible with the old client behavior.
  url.searchParams.set("app_version", ZCODE_VERSION);
  return url.toString();
}
