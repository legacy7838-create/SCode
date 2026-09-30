import { Buffer } from "node:buffer";
import {
  ApiError,
  type ApiClient,
  formatLogPrefix,
  ZAI_PROVIDER_ID,
  type OAuthCallbackParams,
  type OAuthProviderMeta,
  type OAuthTokenSet,
  type OAuthUserProfile,
} from "@zcode/shared";
import { readApiJson } from "../../providers/api/apiJson.js";
import { ZaiBusinessTokenResolver } from "../../providers/zaiBusinessTokenResolver.js";
import { parseOAuthLoginAttribution } from "../callbackAttribution.js";
import type { OAuthProviderRuntimeConfig } from "../runtimeConfig.js";
import type { OAuthProviderAdapter, OAuthProviderContext } from "./providerAdapter.js";

interface ZaiBackendTokenPayload {
  code?: number;
  msg?: string;
  data?: {
    token?: string;
    zai?: {
      access_token?: string;
    } | null;
    expires_in?: number;
    user?: ZaiBackendUserPayload;
  } | null;
}

interface ZaiBackendUserPayload {
  user_id?: string;
  email?: string;
  avatar?: string;
  name?: string;
  created_at?: string;
}

interface ZaiUserInfoPayload {
  data?: {
    sub?: string;
    id?: string;
    name?: string;
    preferred_username?: string;
    email?: string;
    picture?: string;
  };
  sub?: string;
  id?: string;
  name?: string;
  preferred_username?: string;
  email?: string;
  picture?: string;
}

/** Longest wait allowed for OAuth startup restoration (1 minute) */
const OAUTH_USERINFO_TIMEOUT_MS = 60_000;
const ZAI_BUSINESS_TOKEN_TIMEOUT_MS = 10_000;
const log = (...args: unknown[]) => console.log(formatLogPrefix("zaiOAuth", process.pid), ...args);

function normalizeExpiresIn(raw: number | undefined, now: () => number): number | undefined {
  if (!raw || !Number.isFinite(raw)) {
    return undefined;
  }

  return now() + raw * 1000;
}

function inferBase64ImageMimeType(decoded: Buffer): string {
  if (
    decoded.length >= 8 &&
    decoded[0] === 0x89 &&
    decoded[1] === 0x50 &&
    decoded[2] === 0x4e &&
    decoded[3] === 0x47
  ) {
    return "image/png";
  }

  if (decoded.length >= 3 && decoded[0] === 0xff && decoded[1] === 0xd8 && decoded[2] === 0xff) {
    return "image/jpeg";
  }

  if (decoded.length >= 6 && decoded.toString("ascii", 0, 3) === "GIF") {
    return "image/gif";
  }

  if (
    decoded.length >= 12 &&
    decoded.toString("ascii", 0, 4) === "RIFF" &&
    decoded.toString("ascii", 8, 12) === "WEBP"
  ) {
    return "image/webp";
  }

  return "image/png";
}

function toBase64ImageDataUrl(raw: string): string | null {
  const normalized = raw.replace(/\s/g, "");
  if (normalized.length < 16 || !/^[A-Za-z0-9+/]+={0,2}$/.test(normalized)) {
    return null;
  }

  const decoded = Buffer.from(normalized, "base64");
  if (decoded.length === 0) {
    return null;
  }

  const encoded = decoded.toString("base64").replace(/=+$/, "");
  if (encoded !== normalized.replace(/=+$/, "")) {
    return null;
  }

  return `data:${inferBase64ImageMimeType(decoded)};base64,${normalized}`;
}

function normalizeBackendAvatarUrl(avatar: string | undefined): string | undefined {
  const trimmed = avatar?.trim();
  if (!trimmed) {
    return undefined;
  }

  if (/^data:image\/[^;]+;base64,/i.test(trimmed) || /^https?:\/\//i.test(trimmed)) {
    return trimmed;
  }

  const dataUrl = toBase64ImageDataUrl(trimmed);
  if (dataUrl) {
    return dataUrl;
  }

  // The ZAI backend now reliably returns displayable URLs or base64, and continuing to spell the chat.z.ai prefix on the client will change server-side semantics.
  // Only the original value is retained here to avoid secondary processing of the avatar returned by the backend into an incorrect address.
  return trimmed;
}

function toBackendUserProfile(user: ZaiBackendUserPayload | undefined): OAuthUserProfile {
  if (!user) {
    return {
      id: "unknown",
      username: "user",
      displayName: "User",
    };
  }

  const id = user.user_id ?? "unknown";
  // The user.name in the ZAI backend token body is the user's visible nickname. Previously, only email was readable.
  // As a result, after successful login, the phone.local email address is displayed in the sidebar and logs; avatar only performs necessary base64 display format normalization.
  const username = user.name?.trim() || user.email || id;
  const avatarUrl = normalizeBackendAvatarUrl(user.avatar);

  return {
    id,
    username,
    displayName: username,
    ...(avatarUrl ? { avatarUrl } : {}),
    rawProfile: user,
  };
}

function hasMeaningfulBackendUser(
  user: ZaiBackendUserPayload | undefined,
): user is ZaiBackendUserPayload {
  if (!user) {
    return false;
  }

  return Boolean(
    user.user_id?.trim() || user.email?.trim() || user.name?.trim() || user.avatar?.trim(),
  );
}

function maskOAuthCode(code: string): string {
  if (code.length <= 8) {
    return "*".repeat(code.length);
  }

  return `${code.slice(0, 4)}...${code.slice(-4)}`;
}

function maskAccessToken(token: string): string {
  if (token.length <= 8) {
    return "*".repeat(token.length);
  }

  return `${token.slice(0, 4)}...${token.slice(-4)}`;
}

function sanitizeTokenPayloadForLog(tokenPayload: ZaiBackendTokenPayload): unknown {
  if (!tokenPayload.data) {
    return tokenPayload;
  }

  const token = tokenPayload.data.token;
  const zaiAccessToken = tokenPayload.data.zai?.access_token;

  return {
    ...tokenPayload,
    data: {
      ...tokenPayload.data,
      ...(token
        ? {
            token: maskAccessToken(token),
            tokenLength: token.length,
          }
        : {}),
      ...(tokenPayload.data.zai
        ? {
            zai: {
              ...tokenPayload.data.zai,
              ...(zaiAccessToken
                ? {
                    access_token: maskAccessToken(zaiAccessToken),
                    accessTokenLength: zaiAccessToken.length,
                  }
                : {}),
            },
          }
        : {}),
    },
  };
}

function logTokenResponseError(error: unknown): void {
  if (!(error instanceof ApiError)) {
    return;
  }

  // Backend 4xx/5xx troubleshooting requires the request id in the response; directly recording the complete headers will delete sensitive values ​​such as cookies.
  // readApiJson only reveals the secure link tracking headers. Here they are printed together with the status code to facilitate the backend to locate by x-request-id.
  log("token response error", {
    method: error.method,
    url: error.url,
    status: error.status,
    responseHeaders: error.responseHeaders ?? {},
  });
}

/** ZAI OAuth protocol adapter */
export class ZaiProviderAdapter implements OAuthProviderAdapter {
  readonly providerId = ZAI_PROVIDER_ID;
  readonly meta: OAuthProviderMeta;
  readonly redirectUri: string;
  readonly apiClient: ApiClient;
  private readonly businessTokenResolver: ZaiBusinessTokenResolver;
  private lastBackendUserProfile: {
    state: string;
    profile: OAuthUserProfile;
  } | null = null;

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
    this.businessTokenResolver = new ZaiBusinessTokenResolver({
      apiClient,
      // The ZAI access_token returned by the test OAuth app needs to be transferred to the test business domain to exchange for the business token;
      // If you continue to hardcode the production api.z.ai, the local test login will fail after the OAuth token succeeds.
      loginUrl: config.businessLoginUrl ?? "https://api.z.ai/api/auth/z/login",
      timeoutMs: ZAI_BUSINESS_TOKEN_TIMEOUT_MS,
    });
  }

  parseCallbackParams(url: string): OAuthCallbackParams {
    const parsed = new URL(url);
    const code = parsed.searchParams.get("code") ?? parsed.searchParams.get("authCode");
    const state = parsed.searchParams.get("state");

    if (!code || !state) {
      throw new Error("OAuth callback is missing the code/authCode or state parameter");
    }

    const attribution = parseOAuthLoginAttribution(parsed.searchParams);

    return { code, state, ...(attribution ? { attribution } : {}) };
  }

  buildAuthorizeUrl(context: OAuthProviderContext): string {
    const query = new URLSearchParams({
      redirect_uri: context.redirectUri,
      response_type: "code",
      client_id: this.config.appId,
      state: context.state,
    });

    return `${this.config.authorizeUrl}?${query.toString()}`;
  }

  async normalizePolledTokenSet(tokenSet: OAuthTokenSet): Promise<OAuthTokenSet> {
    // The ready.access_token of CLI flow is still the Z.AI OAuth token, and the Desktop
    // The existing contract of oauth:zai:access_token is the business token returned by /api/auth/z/login.
    // Polling and deep link must be converted at the same adapter boundary to avoid semantic split between the two login methods.
    return {
      ...tokenSet,
      accessToken: await this.businessTokenResolver.resolve(tokenSet.accessToken),
    };
  }

  async exchangeToken(
    params: OAuthCallbackParams,
    context: OAuthProviderContext,
  ): Promise<OAuthTokenSet> {
    // When troubleshooting the backend OAuth token routing, the original log only recorded the 404 result, and the actual request form of the client could not be seen.
    // The method/url/headers/body structure is recorded here, and the one-time code is desensitized to prevent sensitive authorization codes from being left on the disk.
    log("token request", {
      method: "POST",
      url: this.config.tokenUrl,
      headers: { "Content-Type": "application/json" },
      body: {
        provider: ZAI_PROVIDER_ID,
        code: maskOAuthCode(params.code),
        codeLength: params.code.length,
        redirect_uri: context.redirectUri,
        state: context.state,
      },
    });

    let tokenPayload: ZaiBackendTokenPayload;
    try {
      tokenPayload = await readApiJson<ZaiBackendTokenPayload>(
        this.apiClient,
        this.config.tokenUrl,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          // The zcode OAuth token backend now serves both Z.ai and BigModel.
          // Explicitly pass the provider enumeration value to avoid relying solely on redirect_uri to infer the login domain, resulting in wrong routing.
          body: JSON.stringify({
            provider: ZAI_PROVIDER_ID,
            code: params.code,
            redirect_uri: context.redirectUri,
            state: context.state,
          }),
        },
      );
    } catch (error) {
      logTokenResponseError(error);
      throw error;
    }

    // The ZAI token response will be immediately mapped to OAuthTokenSet in the adapter, and the Root layer can only see the normalized login result.
    // Therefore, the final response body cannot be seen when checking the online return structure. Here, the desensitized body is printed before mapping, and the code/msg/data structure is retained.
    // At the same time, avoid placing the complete access token on the disk.
    log("token final response body", sanitizeTokenPayloadForLog(tokenPayload));

    if (tokenPayload.code !== 0) {
      throw new Error(tokenPayload.msg?.trim() || "ZAI backend token exchange failed");
    }

    const zcodeJwtToken = tokenPayload.data?.token;
    if (!zcodeJwtToken) {
      throw new Error("Token exchange failed: response is missing data.token");
    }

    const accessToken = tokenPayload.data?.zai?.access_token;
    if (!accessToken) {
      throw new Error("Token exchange failed: response is missing data.zai.access_token");
    }
    // The Z.AI business interface only recognizes the platform JWT returned by /api/auth/z/login.
    // The conversion is completed during the login phase, and what makes oauth:zai:access_token persistent is the business token. There will be no secondary exchange in the future.
    const businessAccessToken = await this.businessTokenResolver.resolve(accessToken);

    const backendUser = tokenPayload.data?.user ?? undefined;
    if (hasMeaningfulBackendUser(backendUser)) {
      this.lastBackendUserProfile = {
        state: context.state,
        profile: toBackendUserProfile(backendUser),
      };
    } else {
      // When the backend occasionally does not return data.user (or only returns an empty object), unknown/User will be cached and subsequent userinfo will be short-circuited.
      // In this way, after logging in, the UI will display the cover text for a long time. Do not cache when a valid user is missing, allowing fetchUserInfo to go to the remote end to compensate.
      this.lastBackendUserProfile = null;
    }
    const expiresAt = normalizeExpiresIn(tokenPayload.data?.expires_in, context.now);

    return {
      accessToken: businessAccessToken,
      zcodeJwtToken,
      ...(expiresAt ? { expiresAt } : {}),
    };
  }

  async fetchUserInfo(
    tokenSet: OAuthTokenSet,
    _context: OAuthProviderContext,
  ): Promise<OAuthUserProfile> {
    if (this.lastBackendUserProfile?.state === _context.state) {
      const profile = this.lastBackendUserProfile.profile;
      this.lastBackendUserProfile = null;
      return profile;
    }

    const userinfoPayload = await readApiJson<ZaiUserInfoPayload>(
      this.apiClient,
      this.config.userinfoUrl,
      {
        method: "GET",
        // Starting the recovery login state will block the "recovering" setting of the UI.
        // If there is no timeout here, the request under a weak network may hang for a long time, and the interface will always stop loading.
        // The unified limit here is 1 minute. After timeout, the convergence status of the failed path will be used to avoid infinite waiting.
        timeoutMs: OAUTH_USERINFO_TIMEOUT_MS,
        headers: {
          Authorization: `Bearer ${tokenSet.accessToken}`,
          "Content-Type": "application/json",
        },
      },
    );
    const user = userinfoPayload.data ?? userinfoPayload;

    const id = user.sub ?? user.id ?? "unknown";
    const username = user.name ?? user.preferred_username ?? user.email ?? id;

    return {
      id,
      username,
      displayName: username,
      avatarUrl: user.picture,
    };
  }

  normalizeError(error: unknown): Error {
    if (error instanceof Error) {
      return error;
    }

    return new Error(`ZAI OAuth error: ${String(error)}`);
  }
}
