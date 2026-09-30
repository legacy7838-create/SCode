import type {
  OAuthCachedSessionRestoreResult,
  OAuthCallbackResult,
  OAuthProviderId,
  OAuthProviderMeta,
  OAuthStartResponse,
  UserInfo,
} from "@zcode/shared";
import { ServiceChannels } from "@zcode/shared";
import { createServiceDescriptor } from "../descriptors.js";

/**
 * OAuth authentication service
 *
 * Runs in the host process and owns all the OAuth flow business logic:
 * provider management, state lifecycle, token exchange, credential storage.
 */
export interface IOAuthService {
  /** Gets the list of available providers (only those with enabled=true are returned) */
  getProviders(): Promise<OAuthProviderMeta[]>;

  /** Gets the current active provider */
  getActiveProvider(): Promise<OAuthProviderId | null>;

  /** On startup, restores the session display state from the local cache: returns the user info on success, with no remote token validation */
  restoreCachedSession(): Promise<UserInfo | null>;

  /** Restores the local display state and distinguishes "never signed in" from "JWT expired, needs re-authentication". */
  restoreCachedSessionState(): Promise<OAuthCachedSessionRestoreResult>;

  /** Explicitly validates the current provider session: returns the user info on success, null on failure or expiry */
  restoreSession(): Promise<UserInfo | null>;

  /**
   * Starts OAuth: takes the provider, generates the state, and returns the authorize URL
   * The renderer reports the state to the main process for deep link routing
   */
  startOAuth(provider: OAuthProviderId): Promise<OAuthStartResponse>;

  /** Starts OAuth through the backend short-lived flow; currently only Z.AI supports it, other providers keep the original flow. */
  startOAuthWithPolling(provider: OAuthProviderId): Promise<OAuthStartResponse>;

  /** Queries the current backend OAuth flow; returns null before the query time, while still pending, or when there is no flow. */
  pollPendingOAuth(): Promise<OAuthCallbackResult | null>;

  /**
   * Handles the OAuth callback: validates the state; with a code it exchanges the token and stores the
   * credential, with only attribution parameters it persists the attribution info. When an already
   * received callback is invalidated by a cancellation or a new flow it returns null, and the caller
   * silently ignores it.
   * @param url - The full deep link URL
   */
  handleCallback(url: string): Promise<OAuthCallbackResult | null>;

  /**
   * Refreshes the token
   * @param provider - Optional; when omitted the active provider is used
   */
  refreshToken(provider?: OAuthProviderId): Promise<void>;

  /**
   * Logs out the provider
   * @param provider - Optional; when omitted the active provider is logged out
   */
  logout(provider?: OAuthProviderId): Promise<void>;

  /** Logs out every provider */
  logoutAll(): Promise<void>;

  /**
   * Cancels the pending OAuth
   * @param provider - Optional; when omitted the current pending one is cancelled
   */
  cancelPending(provider?: OAuthProviderId): Promise<void>;
}

export const IOAuthService = createServiceDescriptor<IOAuthService>(ServiceChannels.OAuth);
