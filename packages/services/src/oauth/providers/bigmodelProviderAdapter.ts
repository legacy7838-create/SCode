import {
  ApiError,
  BIGMODEL_PROVIDER_ID,
  type ApiClient,
  type OAuthCallbackParams,
  type OAuthProviderMeta,
  type OAuthTokenSet,
  type OAuthUserProfile,
} from "@zcode/shared";
import { readApiJson } from "../../providers/api/apiJson.js";
import { createServiceLogger } from "../../logger/serviceLogger.js";
import { parseOAuthLoginAttribution } from "../callbackAttribution.js";
import type { OAuthProviderRuntimeConfig } from "../runtimeConfig.js";
import type { OAuthProviderAdapter, OAuthProviderContext } from "./providerAdapter.js";

interface BigModelZcodeTokenEnvelope {
  code?: number;
  msg?: string;
  data?: {
    token?: string | null;
    access_token?: string | null;
    accessToken?: string | null;
    bigmodel?: {
      access_token?: string | null;
      accessToken?: string | null;
      refresh_token?: string | null;
      refreshToken?: string | null;
    } | null;
  } | null;
}

interface BigModelCustomerInfo {
  customerNumber?: unknown;
  customerName?: unknown;
  nickName?: unknown;
  avatar?: unknown;
}

/** Longest wait allowed for OAuth startup recovery (1 minute) */
const OAUTH_USERINFO_TIMEOUT_MS = 60_000;
const log = createServiceLogger("bigmodelOAuth");

function maskOAuthCode(code: string): string {
  if (code.length <= 8) {
    return "*".repeat(code.length);
  }

  return `${code.slice(0, 4)}...${code.slice(-4)}`;
}

function readOptionalString(value: unknown): string | undefined {
  // BigModel userinfo is remote runtime data, and exception types cannot participate in trim or be persisted as display fields.
  return typeof value === "string" ? value : undefined;
}

function readTrimmedString(value: unknown): string {
  return readOptionalString(value)?.trim() || "";
}

function resolveBigModelDisplayName(customer: BigModelCustomerInfo): string {
  const customerName = readTrimmedString(customer.customerName);
  const nickName = readTrimmedString(customer.nickName);
  return customerName || nickName || "user";
}

/** BigModel OAuth protocol adapter */
export class BigModelProviderAdapter implements OAuthProviderAdapter {
  readonly providerId = BIGMODEL_PROVIDER_ID;
  readonly meta: OAuthProviderMeta;
  readonly redirectUri: string;
  readonly apiClient: ApiClient;

  constructor(
    private config: OAuthProviderRuntimeConfig,
    apiClient: ApiClient,
  ) {
    this.meta = {
      id: config.id,
      displayName: config.displayName,
      enabled: config.enabled,
      order: config.order,
    };
    this.redirectUri = config.redirectUri;
    this.apiClient = apiClient;
  }

  async normalizePolledTokenSet(tokenSet: OAuthTokenSet): Promise<OAuthTokenSet> {
    // Polling ready has returned the BigModel business token; Z.AI's secondary business token exchange is not required.
    return tokenSet;
  }

  parseCallbackParams(url: string): OAuthCallbackParams {
    const parsed = new URL(url);
    // Historically, BigModel online callback used authCode, but the new version may fall back to code.
    // This is compatible with both fields to avoid direct client login failure when the console switches parameter names.
    const code = parsed.searchParams.get("authCode") ?? parsed.searchParams.get("code");
    const state = parsed.searchParams.get("state");

    if (!code || !state) {
      throw new Error("OAuth callback is missing the authCode/code or state parameter");
    }

    const attribution = parseOAuthLoginAttribution(parsed.searchParams);

    return { code, state, ...(attribution ? { attribution } : {}) };
  }

  buildAuthorizeUrl(context: OAuthProviderContext): string {
    const query = new URLSearchParams({
      redirect: context.redirectUri,
      appId: this.config.appId,
      state: context.state,
    });

    return `${this.config.authorizeUrl}?${query.toString()}`;
  }

  async exchangeToken(
    params: OAuthCallbackParams,
    _context: OAuthProviderContext,
  ): Promise<OAuthTokenSet> {
    const tokenSet = await this.exchangeZcodeJwtToken(params, _context);

    return {
      ...tokenSet,
    };
  }

  private async exchangeZcodeJwtToken(
    params: OAuthCallbackParams,
    context: OAuthProviderContext,
  ): Promise<OAuthTokenSet> {
    log.info(undefined, "zcode token request", {
      method: "POST",
      url: this.config.tokenUrl,
      headers: { "Content-Type": "application/json" },
      body: {
        provider: BIGMODEL_PROVIDER_ID,
        code: maskOAuthCode(params.code),
        codeLength: params.code.length,
        redirect_uri: context.redirectUri,
        state: context.state,
      },
    });

    try {
      const payload = await readApiJson<BigModelZcodeTokenEnvelope>(
        this.apiClient,
        this.config.tokenUrl,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          // The backend token routing of zcode JWT is parsed according to the OAuth callback authorization code semantics.
          // BigModel Start Plan cannot be redeemed twice with access_token in the subsequent balance query phase.
          // Otherwise the body is inconsistent with the Z.ai login link and triggers HTTP 400. provider uses shared
          // The OAuth provider enumeration value in the OAuth provider prevents the front-end and back-end from guessing the identity only by redirect_uri after adding more providers.
          body: JSON.stringify({
            provider: BIGMODEL_PROVIDER_ID,
            code: params.code,
            redirect_uri: context.redirectUri,
            state: context.state,
          }),
        },
      );
      if (payload.code !== undefined && payload.code !== 0) {
        // BigModel's one-time authCode is now only given to the zcode token route.
        // If this fails, you cannot continue to save the semi-login state, otherwise Start Plan will still show not connected.
        log.warn(undefined, "zcode token business response rejected", {
          code: payload.code,
          msg: payload.msg,
        });
        throw new Error(
          payload.msg?.trim() || `BigModel zcode token exchange failed (code: ${payload.code})`,
        );
      }
      const zcodeJwtToken = payload.data?.token?.trim() || "";
      if (!zcodeJwtToken) {
        log.warn(undefined, "zcode token response missing data.token", {
          code: payload.code,
          msg: payload.msg,
        });
        throw new Error("BigModel zcode token exchange failed: response is missing data.token");
      }
      const accessToken = resolveBigModelBusinessAccessToken(payload);
      if (!accessToken) {
        // The Coding Plan paid package still calls the bigmodel.cn business interface and can only be used
        // BigModel business access token; zcode JWT can only be written to zcodejwttoken for use by Start Plan.
        // If you continue to write zcode JWT into oauth:bigmodel:access_token, the package preview will steadily report "Token has expired".
        log.warn(undefined, "zcode token response missing bigmodel access token", {
          code: payload.code,
          msg: payload.msg,
        });
        throw new Error(
          "BigModel zcode token exchange failed: response is missing data.bigmodel.access_token",
        );
      }

      const refreshToken =
        payload.data?.bigmodel?.refresh_token?.trim() ??
        payload.data?.bigmodel?.refreshToken?.trim() ??
        "";
      return {
        accessToken,
        ...(refreshToken ? { refreshToken } : {}),
        zcodeJwtToken,
      };
    } catch (error) {
      // BigModel callback code is one-time use and cannot be called by the client again.
      // tokenByAuthCode consumes it; when the zcode token exchange fails, the login is directly aborted and the link header is recorded.
      log.warn(undefined, "zcode token request failed", {
        message: error instanceof Error ? error.message : String(error),
        ...(error instanceof ApiError
          ? {
              method: error.method,
              status: error.status,
              url: error.url,
              responseHeaders: error.responseHeaders ?? {},
            }
          : {}),
      });
      throw error;
    }
  }

  async fetchUserInfo(
    tokenSet: OAuthTokenSet,
    _context: OAuthProviderContext,
  ): Promise<OAuthUserProfile> {
    if (tokenSet.zcodeJwtToken && tokenSet.accessToken === tokenSet.zcodeJwtToken) {
      // There is no BigModel access token in the callback phase after removing tokenByAuthCode.
      // zcode JWT cannot call the customer interface of bigmodel.cn to avoid meaningless authentication failure requests.
      return {
        id: "unknown",
        username: "user",
        displayName: "User",
      };
    }

    const userinfoPayload = await readApiJson<{
      data?: BigModelCustomerInfo;
    }>(this.apiClient, this.config.userinfoUrl, {
      method: "GET",
      // Starting to restore the login state relies on this userinfo verification link.
      // If there is no timeout, the network layer may be pending for a long time, causing the UI to always display "Recovering".
      // A 1-minute timeout is fixed here to ensure that the failed path can be settled in time to avoid infinite loading.
      timeoutMs: OAUTH_USERINFO_TIMEOUT_MS,
      headers: {
        // BigModel customer information interface requires Authorization to pass token directly.
        // The Bearer prefix cannot be used, otherwise authentication failure will be returned stably.
        Authorization: tokenSet.accessToken,
        "Content-Type": "application/json",
      },
    });
    const customer = userinfoPayload.data;

    if (!customer) {
      return {
        id: "unknown",
        username: "user",
        displayName: "User",
      };
    }

    // BigModel customerName is the real display name of the account, and nickName is just the nickname;
    // An empty string is equivalent to missing in API semantics and must be trimmed before selecting to prevent the account from being displayed as blank.
    const username = resolveBigModelDisplayName(customer);

    return {
      id: readOptionalString(customer.customerNumber) ?? "unknown",
      username,
      displayName: username,
      avatarUrl: readOptionalString(customer.avatar),
    };
  }

  async loadLegacyTokenSet(
    loadCredential: (key: string) => Promise<string | null>,
  ): Promise<OAuthTokenSet | null> {
    const accessToken = await loadCredential("auth_token");
    if (!accessToken) {
      return null;
    }

    const refreshToken = await loadCredential("refresh_token");

    // The old version of BigModel only writes auth_token/refresh_token in the login state.
    // If compatibility is not implemented at the provider layer, it will be misjudged as "no token" after the upgrade.
    return {
      accessToken,
      ...(refreshToken ? { refreshToken } : {}),
    };
  }

  normalizeError(error: unknown): Error {
    if (error instanceof Error) {
      return error;
    }

    return new Error(`BigModel OAuth error: ${String(error)}`);
  }
}

function resolveBigModelBusinessAccessToken(payload: BigModelZcodeTokenEnvelope): string {
  return (
    payload.data?.bigmodel?.access_token?.trim() ??
    payload.data?.bigmodel?.accessToken?.trim() ??
    payload.data?.access_token?.trim() ??
    payload.data?.accessToken?.trim() ??
    ""
  );
}
