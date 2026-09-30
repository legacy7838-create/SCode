import type {
  ApiClient,
  OAuthCallbackParams,
  OAuthProviderId,
  OAuthProviderMeta,
  OAuthTokenSet,
  OAuthUserProfile,
} from "@zcode/shared";

/** Provider execution context */
export interface OAuthProviderContext {
  providerId: OAuthProviderId;
  state: string;
  redirectUri: string;
  now: () => number;
}

/** OAuth provider adapter: isolates protocol differences */
export interface OAuthProviderAdapter {
  readonly providerId: OAuthProviderId;
  readonly meta: OAuthProviderMeta;
  readonly redirectUri: string;
  readonly apiClient: ApiClient;

  parseCallbackParams(url: string): OAuthCallbackParams;
  buildAuthorizeUrl(context: OAuthProviderContext): string;
  exchangeToken(params: OAuthCallbackParams, context: OAuthProviderContext): Promise<OAuthTokenSet>;
  /** Normalizes the provider token returned by backend polling into Desktop persistence semantics. */
  normalizePolledTokenSet?(tokenSet: OAuthTokenSet): Promise<OAuthTokenSet>;
  fetchUserInfo?(tokenSet: OAuthTokenSet, context: OAuthProviderContext): Promise<OAuthUserProfile>;
  refreshToken?(tokenSet: OAuthTokenSet, context: OAuthProviderContext): Promise<OAuthTokenSet>;

  /** provider-level legacy credential read (for upgrade compatibility) */
  loadLegacyTokenSet?(
    loadCredential: (key: string) => Promise<string | null>,
  ): Promise<OAuthTokenSet | null>;

  normalizeError(error: unknown): Error;
}
