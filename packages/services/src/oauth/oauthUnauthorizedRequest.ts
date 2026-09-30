import {
  BIGMODEL_PROVIDER_ID,
  ZAI_PROVIDER_ID,
  buildBigModelApiUrl,
  buildRuntimeZaiBusinessUrl,
} from "@zcode/shared";
import type { ICredentialService } from "#src/credential/credential.js";
import { resolveBigModelUserinfoUrl } from "#src/oauth/providers/bigmodelProviderConfig.js";
import { resolveZaiUserinfoUrl } from "#src/oauth/providers/zaiProviderConfig.js";

function tryResolveHttpUrl(resolve: () => string | URL): URL | null {
  try {
    const url = new URL(resolve());
    return url.protocol === "http:" || url.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

// Only candidate requests are determined here; the actual exit must be reviewed by OAuthService in the session change queue and cannot rely on asynchronous old snapshots.
export async function isCurrentOAuthCredentialRequest(options: {
  input: string | URL;
  headers: Headers;
  credentialService: Pick<ICredentialService, "load">;
  env?: NodeJS.ProcessEnv;
}): Promise<boolean> {
  const authorization = options.headers.get("authorization")?.trim() ?? "";
  if (!authorization) return false;
  const currentJwt = (await options.credentialService.load("zcodejwttoken"))?.trim() ?? "";
  if (currentJwt && authorization === `Bearer ${currentJwt}`) return true;

  // The original observer only recognizes ZCode JWT, userinfo 401 of business access token
  // It will just become a normal request error. Only expand user/team identity query to avoid payment and API key interfaces following global exit.
  const provider = await options.credentialService.load("oauth:active_provider");
  if (provider !== BIGMODEL_PROVIDER_ID && provider !== ZAI_PROVIDER_ID) return false;
  const env = options.env ?? process.env;
  const requestUrl = tryResolveHttpUrl(() => options.input);
  if (!requestUrl) return false;
  const customerInfoPath = "/api/biz/customer/getCustomerInfo";
  // Failure in constructing a single candidate URL blocked 401 recognition of otherwise valid interfaces.
  // Delay construction and parsing respectively, and only read the required configuration of userinfo to avoid exceptions related to authorization/login configuration.
  const urls =
    provider === BIGMODEL_PROVIDER_ID
      ? [() => buildBigModelApiUrl(env, customerInfoPath), () => resolveBigModelUserinfoUrl(env)]
      : [() => buildRuntimeZaiBusinessUrl(env, customerInfoPath), () => resolveZaiUserinfoUrl(env)];
  if (
    !urls.some((resolve) => {
      const expected = tryResolveHttpUrl(resolve);
      return (
        expected !== null &&
        requestUrl.origin === expected.origin &&
        requestUrl.pathname === expected.pathname
      );
    })
  )
    return false;

  const accessToken = (
    await options.credentialService.load(`oauth:${provider}:access_token`)
  )?.trim();
  if (!accessToken || (authorization !== accessToken && authorization !== `Bearer ${accessToken}`))
    return false;
  // The platform may be switched while reading the disk, and the current login cannot be cleared with 401 of the remaining tokens from the previous platform.
  return (await options.credentialService.load("oauth:active_provider")) === provider;
}
