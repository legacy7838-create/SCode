import {
  BIGMODEL_PROVIDER_ID,
  ZAI_PROVIDER_ID,
  type OAuthProviderId,
  type OAuthTokenSet,
  type OAuthCachedSessionRestoreResult,
  type UserInfo,
  resolveJwtExpiration,
} from "@zcode/shared";
import { toUserInfo } from "./zaiWebOAuthProvider.js";

const ACTIVE_PROVIDER_KEY = "oauth:active_provider";
const ZCODE_JWT_TOKEN_KEY = "zcodejwttoken";
const ZAI_ACCESS_TOKEN_KEY = "oauth:zai:access_token";
const ZAI_USER_INFO_KEY = "oauth:zai:user_info";
const BIGMODEL_ACCESS_TOKEN_KEY = "oauth:bigmodel:access_token";
const BIGMODEL_USER_INFO_KEY = "oauth:bigmodel:user_info";
const OAUTH_PENDING_NONCE_KEY = "oauth_pending_nonce";
const OAUTH_PENDING_PROVIDER_KEY = "oauth_pending_provider";

/** Login providers supported by this repo. The owner identity of a private share is provider-specific, so both sides must be able to log in. */
export type WebOAuthProviderId = typeof ZAI_PROVIDER_ID | typeof BIGMODEL_PROVIDER_ID;

function isWebOAuthProviderId(value: unknown): value is WebOAuthProviderId {
  return value === ZAI_PROVIDER_ID || value === BIGMODEL_PROVIDER_ID;
}

/**
 * Each provider uses a separate key segment.
 *
 * Deliberately not reusing a set of "neutral" keys: the two keys of zai already carry the login status of /remote online. Changing the keys will
 * Let all logged-in users go offline on the day of release. Adding a bigmodel prefix is ​​a zero-risk approach, and the cost is just one more mapping.
 */
function providerKeys(provider: WebOAuthProviderId): { accessToken: string; userInfo: string } {
  return provider === BIGMODEL_PROVIDER_ID
    ? { accessToken: BIGMODEL_ACCESS_TOKEN_KEY, userInfo: BIGMODEL_USER_INFO_KEY }
    : { accessToken: ZAI_ACCESS_TOKEN_KEY, userInfo: ZAI_USER_INFO_KEY };
}

interface BrowserOAuthCredentialRepoStorage {
  localStorage: Storage;
  sessionStorage: Storage;
}

interface BrowserOAuthCredentialRepoOptions {
  now?: () => number;
}

interface WebZaiTokenSet {
  zcodeJwtToken: string;
  zaiAccessToken: string;
  expiresAt?: number;
}

function getBrowserStorage(): BrowserOAuthCredentialRepoStorage {
  return {
    localStorage: window.localStorage,
    sessionStorage: window.sessionStorage,
  };
}

function hasText(value: string | null): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/** Browser OAuth credential repository: centralizes all localStorage/sessionStorage access so auth-state checks don't sprawl through the business layers. */
export class BrowserOAuthCredentialRepo {
  private readonly localStorage: Storage;
  private readonly sessionStorage: Storage;
  private readonly now: () => number;

  constructor(
    storage: BrowserOAuthCredentialRepoStorage = getBrowserStorage(),
    options: BrowserOAuthCredentialRepoOptions = {},
  ) {
    this.localStorage = storage.localStorage;
    this.sessionStorage = storage.sessionStorage;
    this.now = options.now ?? Date.now;
  }

  saveTokenSet(tokenSet: WebZaiTokenSet | OAuthTokenSet, provider: WebOAuthProviderId): void {
    const accessToken =
      "zaiAccessToken" in tokenSet ? tokenSet.zaiAccessToken : tokenSet.accessToken;
    const zcodeJwtToken = tokenSet.zcodeJwtToken;

    this.localStorage.setItem(providerKeys(provider).accessToken, accessToken);
    if (zcodeJwtToken) {
      this.localStorage.setItem(ZCODE_JWT_TOKEN_KEY, zcodeJwtToken);
    } else {
      this.localStorage.removeItem(ZCODE_JWT_TOKEN_KEY);
    }
  }

  saveUserInfo(user: unknown, provider: WebOAuthProviderId): void {
    const rawUserInfo = JSON.stringify(user);
    this.localStorage.setItem(providerKeys(provider).userInfo, rawUserInfo);
  }

  setActiveProvider(provider: WebOAuthProviderId | null): void {
    if (!provider) {
      this.localStorage.removeItem(ACTIVE_PROVIDER_KEY);
      return;
    }

    this.localStorage.setItem(ACTIVE_PROVIDER_KEY, provider);
  }

  getActiveProvider(): OAuthProviderId | null {
    return this.localStorage.getItem(ACTIVE_PROVIDER_KEY);
  }

  loadCachedSession(): UserInfo | null {
    const result = this.loadCachedSessionState();
    return result.status === "authenticated" ? result.userInfo : null;
  }

  loadCachedSessionState(): OAuthCachedSessionRestoreResult {
    const activeProvider = this.localStorage.getItem(ACTIVE_PROVIDER_KEY);
    const zcodeJwtToken = this.localStorage.getItem(ZCODE_JWT_TOKEN_KEY);
    // There is only one activeProvider at a time (switch provider = relogin and overwrite), so press it to select the key segment to read.
    const keys = isWebOAuthProviderId(activeProvider) ? providerKeys(activeProvider) : null;
    const accessToken = keys ? this.localStorage.getItem(keys.accessToken) : null;
    const rawUserInfo = keys ? this.localStorage.getItem(keys.userInfo) : null;

    if (!keys || !hasText(zcodeJwtToken) || !hasText(accessToken) || !hasText(rawUserInfo)) {
      if (this.hasAnyStoredCredential()) {
        this.clearAll();
      }
      return { status: "signed-out" };
    }

    if (resolveJwtExpiration(zcodeJwtToken, this.now()).kind === "expired") {
      // Web localStorage previously only checked whether the JWT existed, and would still restore the pseudo-login state after expiration.
      this.clearAll();
      return { status: "reauthentication-required", reason: "jwt-expired" };
    }

    try {
      const userInfo = toUserInfo(JSON.parse(rawUserInfo));
      if (userInfo) {
        return { status: "authenticated", userInfo };
      }
    } catch {
      // localStorage may leave behind old or hand-written corrupted JSON.
      // Here, it is processed as not logged in and the incomplete status is cleared to prevent the Web remote control portal from misjudging as logged in and continuing the connection.
    }

    this.clearAll();
    return { status: "signed-out" };
  }

  loadZCodeJwtToken(): string | null {
    const session = this.loadCachedSessionState();
    if (session.status !== "authenticated") return null;
    return this.localStorage.getItem(ZCODE_JWT_TOKEN_KEY)?.trim() || null;
  }

  private hasAnyStoredCredential(): boolean {
    return Boolean(
      this.localStorage.getItem(ACTIVE_PROVIDER_KEY) ||
      this.localStorage.getItem(ZCODE_JWT_TOKEN_KEY) ||
      this.localStorage.getItem(ZAI_ACCESS_TOKEN_KEY) ||
      this.localStorage.getItem(ZAI_USER_INFO_KEY) ||
      this.localStorage.getItem(BIGMODEL_ACCESS_TOKEN_KEY) ||
      this.localStorage.getItem(BIGMODEL_USER_INFO_KEY),
    );
  }

  clearAll(): void {
    this.localStorage.removeItem(ACTIVE_PROVIDER_KEY);
    this.localStorage.removeItem(ZCODE_JWT_TOKEN_KEY);
    // Clear the key segments of both providers together: when switching providers, no fragments of the previous identity can be left behind.
    // Otherwise loadCachedSessionState may read half a set of credentials.
    this.localStorage.removeItem(ZAI_ACCESS_TOKEN_KEY);
    this.localStorage.removeItem(ZAI_USER_INFO_KEY);
    this.localStorage.removeItem(BIGMODEL_ACCESS_TOKEN_KEY);
    this.localStorage.removeItem(BIGMODEL_USER_INFO_KEY);
  }

  savePendingNonce(nonce: string): void {
    this.sessionStorage.setItem(OAUTH_PENDING_NONCE_KEY, nonce);
  }

  loadPendingNonce(): string | null {
    return this.sessionStorage.getItem(OAUTH_PENDING_NONCE_KEY);
  }

  clearPendingNonce(): void {
    this.sessionStorage.removeItem(OAUTH_PENDING_NONCE_KEY);
  }

  /**
   * Remembers which provider this outbound login is for.
   *
   * The callback page must know which provider to exchange the token with (the authorize
   * parameter names differ, as does where `access_token` sits in the token response). It lives in
   * the same sessionStorage as the nonce: the two are validated together and cleared together anyway.
   */
  savePendingProvider(provider: WebOAuthProviderId): void {
    this.sessionStorage.setItem(OAUTH_PENDING_PROVIDER_KEY, provider);
  }

  loadPendingProvider(): WebOAuthProviderId | null {
    const stored = this.sessionStorage.getItem(OAUTH_PENDING_PROVIDER_KEY);
    return isWebOAuthProviderId(stored) ? stored : null;
  }

  clearPendingProvider(): void {
    this.sessionStorage.removeItem(OAUTH_PENDING_PROVIDER_KEY);
  }
}
