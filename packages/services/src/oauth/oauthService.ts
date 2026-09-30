/* eslint-disable max-lines -- OAuthService centrally maintains the OAuth session lifecycle and the provider-switching boundary; the current review fix only narrows the background-migration write conditions. */
import { randomBytes } from "node:crypto";
import {
  ApiError,
  formatLogPrefix,
  type ApiClient,
  BIGMODEL_PROVIDER_ID,
  ZAI_PROVIDER_ID,
  type OAuthCallbackResult,
  type OAuthCachedSessionRestoreResult,
  type OAuthProviderId,
  type OAuthProviderMeta,
  type OAuthStartResponse,
  type OAuthTokenSet,
  type OAuthUserProfile,
  type UserInfo,
  resolveJwtExpiration,
} from "@zcode/shared";
import type { ICredentialService } from "../credential/credential.js";
import { createServiceLogger } from "../logger/serviceLogger.js";
import { readApiJson } from "../providers/api/apiJson.js";
import type { IOAuthService } from "./oauth.js";
import { isCurrentOAuthCredentialRequest } from "#src/oauth/oauthUnauthorizedRequest.js";
import { hasOAuthAuthorizationCode, parseOAuthLoginAttribution } from "./callbackAttribution.js";
import {
  refreshLegacyBigModelCachedProfile,
  withProviderProfileSchema,
} from "./oauthProfileSchema.js";
import { createOAuthProviderAdapters, type OAuthProviderAdapter } from "./providers/index.js";
import { OAuthCredentialRepo } from "./repo/oauthCredentialRepo.js";
import { createOAuthRuntimeConfig } from "./runtimeConfig.js";
import {
  buildDesktopOAuthRedirectUriFromEnv,
  buildZCodeApiUrlFromEnv,
} from "./providers/configUtils.js";

/** OAuth timeout (5 minutes) */
const OAUTH_TIMEOUT_MS = 5 * 60 * 1000;
const COMPLETED_POLLING_STATE_GRACE_MS = 30 * 1000;
const ZCODE_JWT_TOKEN_KEY = "zcodejwttoken";
const log = (...args: unknown[]) =>
  console.log(formatLogPrefix("oauthService", process.pid), ...args);
const serviceLog = createServiceLogger("oauthService");

interface PendingState {
  state: string;
  provider: OAuthProviderId;
  timeout: NodeJS.Timeout;
  phase: "awaiting-attribution-or-code" | "awaiting-code-after-attribution";
  completionPromise?: Promise<OAuthCallbackResult | null>;
  polling?: {
    expiresAt: number;
    flowId: string;
    nextPollAt: number;
    pollIntervalMs: number;
    pollToken: string;
    pollUrl: string;
  };
}

interface OAuthFlowEnvelope {
  code?: unknown;
  msg?: unknown;
  data?: unknown;
}

interface OAuthServiceDependencies {
  adapters?: OAuthProviderAdapter[];
  apiClient?: ApiClient;
  now?: () => number;
  env?: NodeJS.ProcessEnv;
  onProviderLogout?: (provider: OAuthProviderId, accountIdentity?: string | null) => Promise<void>;
}

function readTrimmedString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function toUserInfo(profile: OAuthUserProfile): UserInfo {
  return {
    id: profile.id,
    username: profile.username,
    displayName: profile.displayName,
    ...(profile.avatarUrl ? { avatarUrl: profile.avatarUrl } : {}),
  };
}

function isSameOAuthProfile(left: OAuthUserProfile, right: OAuthUserProfile): boolean {
  return (
    left.id === right.id &&
    left.username === right.username &&
    left.displayName === right.displayName &&
    left.avatarUrl === right.avatarUrl &&
    JSON.stringify(left.rawProfile ?? null) === JSON.stringify(right.rawProfile ?? null)
  );
}

function resolveInactiveOAuthProvider(provider: OAuthProviderId): OAuthProviderId | null {
  if (provider === ZAI_PROVIDER_ID) {
    return BIGMODEL_PROVIDER_ID;
  }
  if (provider === BIGMODEL_PROVIDER_ID) {
    return ZAI_PROVIDER_ID;
  }
  return null;
}

/**
 * OAuth authentication service implementation
 *
 * Runs in the host process and manages the full lifecycle of the OAuth flow.
 */
export class OAuthService implements IOAuthService {
  private readonly credentialService: ICredentialService;
  private readonly repo: OAuthCredentialRepo;
  private readonly adapters = new Map<OAuthProviderId, OAuthProviderAdapter>();
  private readonly now: () => number;
  private readonly onProviderLogout?: (
    provider: OAuthProviderId,
    accountIdentity?: string | null,
  ) => Promise<void>;
  private readonly apiClient?: ApiClient;
  private readonly env: NodeJS.ProcessEnv;
  private pendingState: PendingState | null = null;
  private oauthFlowStartGeneration = 0;
  private oauthFlowStartProvider: OAuthProviderId | null = null;
  private oauthSessionGeneration = 0;
  private sessionMutationQueue: Promise<unknown> = Promise.resolve();
  private recentlyCompletedPollingState: {
    generation: number;
    expiresAt: number;
    provider: OAuthProviderId;
    state: string;
  } | null = null;

  constructor(credentialService: ICredentialService, dependencies: OAuthServiceDependencies = {}) {
    this.credentialService = credentialService;
    this.now = dependencies.now ?? Date.now;
    this.onProviderLogout = dependencies.onProviderLogout;
    this.apiClient = dependencies.apiClient;
    this.env = dependencies.env ?? process.env;

    const adapters =
      dependencies.adapters ??
      createOAuthProviderAdapters(createOAuthRuntimeConfig(dependencies.env), {
        apiClient: dependencies.apiClient,
      });

    for (const adapter of adapters) {
      this.adapters.set(adapter.providerId, adapter);
    }
    this.repo = new OAuthCredentialRepo(credentialService, {
      providerIds: adapters.map((adapter) => adapter.providerId),
      onCorruptOAuthSessionCleared: async (providers) => {
        // Failure to decrypt local OAuth credentials is equivalent to forcing a logout.
        // The repo can only clear the OAuth namespace, and the derived Start/Coding Plan provider key must be returned to the service layer for cleaning.
        await this.notifyProvidersLogout(providers);
      },
    });
  }

  async getProviders(): Promise<OAuthProviderMeta[]> {
    return [...this.adapters.values()]
      .map((adapter) => adapter.meta)
      .filter((meta) => meta.enabled)
      .sort((a, b) => a.order - b.order);
  }

  async getActiveProvider(): Promise<OAuthProviderId | null> {
    return this.repo.getActiveProvider();
  }

  async restoreCachedSession(): Promise<UserInfo | null> {
    const result = await this.restoreCachedSessionState();
    return result.status === "authenticated" ? result.userInfo : null;
  }

  async restoreCachedSessionState(): Promise<OAuthCachedSessionRestoreResult> {
    const restoreGeneration = this.oauthSessionGeneration;
    const activeProvider = await this.repo.getActiveProvider();
    if (!activeProvider) {
      log("restoreCachedSession skipped: no active provider");
      return { status: "signed-out" };
    }

    const adapter = this.adapters.get(activeProvider);
    if (!adapter || !adapter.meta.enabled) {
      log(
        "restoreCachedSession aborted: provider unavailable, clearing active provider:",
        activeProvider,
      );
      await this.repo.setActiveProvider(null);
      return { status: "signed-out" };
    }

    const profile = await this.repo.loadActiveUserProfile();
    if (!profile) {
      // OAuth tokens such as zai / bigmodel have a very short life cycle. If they rely heavily on remote userinfo verification during startup,
      // Although the user has just logged in, he or she may be misjudged as not logged in because the access_token has expired.
      // Here, the priority is to read the user_info that is persisted when the login is successful. As long as the user does not log out manually, the display state is restored according to the cache.
      log("restoreCachedSession skipped: missing cached user profile:", activeProvider);
      return { status: "signed-out" };
    }

    // To start cache recovery, you only need to check the shared zcode JWT; if you read it through loadActiveTokenSet,
    // The provider access token will re-block the BigModel profile migration originally executed in the background to the first screen recovery link.
    const zcodeJwtToken = (await this.credentialService.load(ZCODE_JWT_TOKEN_KEY))?.trim() ?? "";
    if (zcodeJwtToken && resolveJwtExpiration(zcodeJwtToken, this.now()).kind === "expired") {
      serviceLog.info("cached session invalidated because zcode JWT expired", {
        provider: activeProvider,
      });
      const invalidated = await this.invalidateExpiredCachedSession(
        restoreGeneration,
        activeProvider,
        profile,
        zcodeJwtToken,
      );
      if (!invalidated) {
        return this.restoreCachedSessionState();
      }
      return { status: "reauthentication-required", reason: "jwt-expired" };
    }

    if (activeProvider === BIGMODEL_PROVIDER_ID) {
      const migrationGeneration = this.oauthSessionGeneration;
      void refreshLegacyBigModelCachedProfile({
        adapter,
        cachedProfile: profile,
        loadTokenSet: () =>
          this.loadBigModelCachedProfileMigrationTokenSet(migrationGeneration, profile),
        now: this.now,
        runWithAdapterError: (run) => this.runWithAdapterError(adapter, run),
        saveProfile: (nextProfile) =>
          this.saveBigModelCachedProfileMigration(migrationGeneration, profile, nextProfile),
      })
        .then((migratedProfile) => {
          if (migratedProfile !== profile) {
            log(
              "restoreCachedSession migrated cached profile:",
              activeProvider,
              migratedProfile.id,
            );
          }
        })
        .catch((error: unknown) => {
          log(
            "restoreCachedSession background profile migration failed:",
            activeProvider,
            error instanceof Error ? error.message : String(error),
          );
        });
    }

    if (activeProvider === ZAI_PROVIDER_ID) {
      if (!zcodeJwtToken) {
        // The sidebar only looks at the cached user_info before logging in, and the status of "lack of zcodejwttoken" will be misjudged as logged in.
        // The zcodejwttoken threshold is added here to ensure that when there is no backend JWT, it will be treated as not logged in.
        log("restoreCachedSession skipped: missing zcodejwttoken:", activeProvider);
        return { status: "signed-out" };
      }
    }

    log("restoreCachedSession restored:", activeProvider, profile.id);
    return { status: "authenticated", userInfo: toUserInfo(profile) };
  }

  private async invalidateExpiredCachedSession(
    expectedGeneration: number,
    expectedProvider: OAuthProviderId,
    expectedProfile: OAuthUserProfile,
    expectedJwt: string,
  ): Promise<boolean> {
    const invalidated = await this.runSessionMutation(async () => {
      const currentProvider = await this.repo.getActiveProvider();
      const currentProfile = await this.repo.loadUserProfile(expectedProvider);
      const currentJwt = (await this.credentialService.load(ZCODE_JWT_TOKEN_KEY))?.trim() ?? "";
      if (
        this.oauthSessionGeneration !== expectedGeneration ||
        currentProvider !== expectedProvider ||
        !currentProfile ||
        !isSameOAuthProfile(currentProfile, expectedProfile) ||
        currentJwt !== expectedJwt
      ) {
        // After initiating recovery to read expired credentials, a new login or provider switch may have completed;
        // The old recovery task can only clean up sessions that are still completely consistent with its snapshot, and cannot accidentally delete the new authentication state that was just written.
        serviceLog.info("skipped stale expired JWT session invalidation", {
          provider: expectedProvider,
        });
        return false;
      }
      this.oauthSessionGeneration += 1;
      await this.repo.clearActiveSession();
      return true;
    });
    if (!invalidated) {
      return false;
    }
    await this.cancelPending(expectedProvider);
    try {
      await this.notifyProviderLogout(expectedProvider, expectedProfile.id);
    } catch (error) {
      // When the JWT has expired, the main authentication fact must be invalidated first; the derived provider's cleanup failure cannot leave the UI in a pseudo login state.
      serviceLog.warn("expired JWT derived provider cleanup failed", {
        provider: expectedProvider,
        error,
      });
    }
    return true;
  }

  private async loadBigModelCachedProfileMigrationTokenSet(
    expectedGeneration: number,
    expectedCachedProfile: OAuthUserProfile,
  ): Promise<OAuthTokenSet | null> {
    return this.runSessionMutation(async () => {
      if (this.oauthSessionGeneration !== expectedGeneration) {
        log("restoreCachedSession skipped stale BigModel token migration");
        return null;
      }

      const activeProvider = await this.repo.getActiveProvider();
      const currentProfile = await this.repo.loadUserProfile(BIGMODEL_PROVIDER_ID);
      if (
        activeProvider !== BIGMODEL_PROVIDER_ID ||
        !currentProfile ||
        !isSameOAuthProfile(currentProfile, expectedCachedProfile)
      ) {
        // The migration request target is fixed to BigModel, and the token must also be fixed to read the BigModel namespace;
        // Review the persistence snapshot before sending a request to avoid sending other provider tokens to BigModel after switching to ZAI.
        log("restoreCachedSession skipped stale BigModel token migration:", activeProvider);
        return null;
      }

      return this.repo.loadTokenSet(BIGMODEL_PROVIDER_ID);
    });
  }

  private async saveBigModelCachedProfileMigration(
    expectedGeneration: number,
    expectedCachedProfile: OAuthUserProfile,
    nextProfile: OAuthUserProfile,
  ): Promise<void> {
    await this.runSessionMutation(async () => {
      if (this.oauthSessionGeneration !== expectedGeneration) {
        log("restoreCachedSession skipped stale BigModel profile migration");
        return;
      }

      const activeProvider = await this.repo.getActiveProvider();
      if (activeProvider !== BIGMODEL_PROVIDER_ID) {
        log("restoreCachedSession skipped stale BigModel profile migration:", activeProvider);
        return;
      }

      const currentProfile = await this.repo.loadUserProfile(BIGMODEL_PROVIDER_ID);
      if (!currentProfile || !isSameOAuthProfile(currentProfile, expectedCachedProfile)) {
        // BigModel old cache migration is completed in the background. During this period, users may logout or switch to ZAI.
        // Or log in to BigModel again. Only when the current cache is still the old cache at startup, the old migration results are allowed to be written to disk.
        log("restoreCachedSession skipped outdated BigModel profile migration");
        return;
      }

      await this.repo.saveUserProfile(BIGMODEL_PROVIDER_ID, nextProfile);
    });
  }

  private runSessionMutation<T>(run: () => Promise<T>): Promise<T> {
    // Backend profile migration, logout, and provider switching will all change OAuth credentials;
    // Must be serialized to avoid old migrations from writing back user_info after exit or switch cleanup.
    const next = this.sessionMutationQueue.catch(() => undefined).then(run);
    this.sessionMutationQueue = next.catch(() => undefined);
    return next;
  }

  private async persistOAuthSession(
    provider: OAuthProviderId,
    tokenSet: OAuthTokenSet,
    profile: OAuthUserProfile,
    isStillCurrent?: () => boolean,
  ): Promise<void> {
    const inactiveProvider = resolveInactiveOAuthProvider(provider);
    const previousTokenSet = await this.repo.loadTokenSet(provider);
    const previousProfile = await this.repo.loadUserProfile(provider);
    const previousInactiveTokenSet = inactiveProvider
      ? await this.repo.loadTokenSet(inactiveProvider)
      : null;
    const previousInactiveProfile = inactiveProvider
      ? await this.repo.loadUserProfile(inactiveProvider)
      : null;
    const previousActiveProvider = await this.repo.getActiveProvider();
    const rollback = async () => {
      if (previousTokenSet) await this.repo.saveTokenSet(provider, previousTokenSet);
      else await this.repo.clearProvider(provider);
      if (previousProfile) await this.repo.saveUserProfile(provider, previousProfile);
      else await this.repo.clearUserProfile(provider);
      if (inactiveProvider) {
        if (previousInactiveTokenSet)
          await this.repo.saveTokenSet(inactiveProvider, previousInactiveTokenSet);
        else await this.repo.clearProvider(inactiveProvider);
        if (previousInactiveProfile)
          await this.repo.saveUserProfile(inactiveProvider, previousInactiveProfile);
        else await this.repo.clearUserProfile(inactiveProvider);
      }
      if (previousActiveProvider) await this.repo.setActiveProvider(previousActiveProvider);
      else await this.repo.setActiveProvider(null);
    };
    const assertCurrent = async () => {
      if (isStillCurrent && !isStillCurrent()) {
        await rollback();
        throw new Error("OAuth flow was cancelled");
      }
    };
    this.oauthSessionGeneration += 1;
    if (inactiveProvider) {
      await assertCurrent();
      // ZAI and BigModel are mutually exclusive identity domains. When switching providers, you must first clear the old provider.
      // Then save the current token; reversing the order will cause clearProvider to delete the shared zcodejwttoken by mistake.
      await this.repo.clearProvider(inactiveProvider);
    }
    await assertCurrent();
    await this.repo.saveTokenSet(provider, tokenSet);
    await assertCurrent();
    await this.repo.saveUserProfile(provider, withProviderProfileSchema(provider, profile));
    await assertCurrent();
    await this.repo.setActiveProvider(provider);
    if (isStillCurrent && !isStillCurrent()) {
      // The active provider write cannot be canceled by the underlying credential IO; the invalid flow cannot just press
      // Provider cleanup, otherwise the new flow with the same provider may be accidentally deleted by the old flow.
      await rollback();
      throw new Error("OAuth flow was cancelled");
    }
  }

  private async runPendingSessionCompletion(
    pending: PendingState,
    complete: () => Promise<{ tokenSet: OAuthTokenSet; profile: OAuthUserProfile }>,
    preserveAttribution?: () => Promise<void>,
  ): Promise<OAuthCallbackResult | null> {
    const completion = this.runSessionMutation(async () => {
      // Polling and deep linking may be completed at the same time, or a new login may be started while waiting.
      // Only paths that still point to the same pending object can be dropped, preventing late results from overwriting updated login selections.
      if (this.pendingState !== pending) {
        if (
          !this.pendingState &&
          this.recentlyCompletedPollingState?.state === pending.state &&
          this.recentlyCompletedPollingState.generation === this.oauthFlowStartGeneration
        ) {
          // The callback has passed the validity check when it is enqueued, and attribution cannot be lost because the queue waits beyond the deduplication window.
          await preserveAttribution?.();
          return { kind: "duplicate" as const, provider: pending.provider };
        }
        return null;
      }
      await preserveAttribution?.();
      if (this.pendingState !== pending) return null;
      const { tokenSet, profile } = await complete();
      // During the exchangeToken period, the user may cancel or switch to a new flow; the old request must be verified again after returning.
      // Otherwise canceled logins will still write the old credentials back locally.
      if (this.pendingState !== pending) {
        return null;
      }
      await this.persistOAuthSession(
        pending.provider,
        tokenSet,
        profile,
        () => this.pendingState === pending,
      );
      if (this.pendingState === pending) {
        this.clearPendingState();
      }
      this.recentlyCompletedPollingState = {
        generation: this.oauthFlowStartGeneration,
        expiresAt: this.now() + COMPLETED_POLLING_STATE_GRACE_MS,
        provider: pending.provider,
        state: pending.state,
      };
      return {
        kind: "session" as const,
        provider: pending.provider,
        userInfo: toUserInfo(profile),
      };
    });
    // Sharing the first redeemed Promise causes the failure to propagate to another path that already has credentials.
    // Multiplexed session serial queues, each candidate executes independently; failure is only reported to the UI after all queued candidates have failed.
    pending.completionPromise = completion;
    try {
      return await completion;
    } catch (error) {
      const fallback = pending.completionPromise;
      if (fallback && fallback !== completion) {
        try {
          await fallback;
        } catch {
          // When both paths fail, their respective errors are retained, and the backup path cannot overwrite the first failure reason.
          throw error;
        }
        if (
          !this.pendingState &&
          this.recentlyCompletedPollingState?.state === pending.state &&
          this.recentlyCompletedPollingState.generation === this.oauthFlowStartGeneration
        ) {
          return { kind: "duplicate", provider: pending.provider };
        }
        if (this.pendingState !== pending) return null;
      }
      throw error;
    } finally {
      if (pending.completionPromise === completion) pending.completionPromise = undefined;
    }
  }

  async restoreSession(): Promise<UserInfo | null> {
    const activeProvider = await this.repo.getActiveProvider();
    if (!activeProvider) {
      log("restoreSession skipped: no active provider");
      return null;
    }

    log("restoreSession started:", activeProvider);

    const adapter = this.adapters.get(activeProvider);
    if (!adapter || !adapter.meta.enabled) {
      log(
        "restoreSession aborted: provider unavailable, clearing active provider:",
        activeProvider,
      );
      await this.repo.setActiveProvider(null);
      return null;
    }

    let tokenSet = await this.repo.loadActiveTokenSet();
    if (!tokenSet && adapter.loadLegacyTokenSet) {
      log("restoreSession fallback: trying provider legacy token set:", activeProvider);
      tokenSet = await adapter.loadLegacyTokenSet((key) => this.credentialService.load(key));

      // After multi-provider transformation, the old version of BigModel may still retain only the legacy token key.
      // Here, the namespace key is backfilled after the provider compatible read is successful to avoid repeating the legacy branch every time it is started.
      if (tokenSet) {
        log("restoreSession fallback hit: migrating legacy token set:", activeProvider);
        await this.repo.saveActiveTokenSet(tokenSet);
        await this.repo.saveTokenSet(activeProvider, tokenSet);
      }
    }

    if (!tokenSet || !adapter.fetchUserInfo) {
      log(
        "restoreSession failed: missing token or user-info capability, logging out:",
        activeProvider,
      );
      await this.logout();
      return null;
    }

    try {
      log("restoreSession validating token with provider userinfo endpoint:", activeProvider);
      const profile = await this.runWithAdapterError(adapter, () =>
        adapter.fetchUserInfo!(tokenSet, {
          providerId: activeProvider,
          state: "",
          redirectUri: adapter.redirectUri,
          now: this.now,
        }),
      );

      await this.repo.saveActiveUserProfile(withProviderProfileSchema(activeProvider, profile));
      await this.repo.setActiveProvider(activeProvider);
      log("restoreSession validated:", activeProvider, profile.id);
      return toUserInfo(profile);
    } catch (error) {
      const normalized = adapter.normalizeError(error);

      // If you start recovery and only look at local credentials, "expired token" will be misjudged as logged in.
      // When the remote end clearly returns unauthorized (401/403), immediately clear the local login status according to the exit process.
      if (this.isUnauthorizedError(normalized)) {
        log("restoreSession unauthorized, logging out:", activeProvider, normalized.message);
        await this.logout();
        return null;
      }

      log("restoreSession validation error:", activeProvider, normalized.message);

      throw normalized;
    }
  }

  async startOAuth(provider: OAuthProviderId): Promise<OAuthStartResponse> {
    return this.startOAuthInternal(provider);
  }

  async startOAuthWithPolling(provider: OAuthProviderId): Promise<OAuthStartResponse> {
    if (provider !== ZAI_PROVIDER_ID && provider !== BIGMODEL_PROVIDER_ID) {
      return this.startOAuthInternal(provider);
    }

    const adapter = this.getEnabledAdapter(provider);
    if (!this.apiClient) {
      throw new Error(
        "ApiClient is not injected: OAuth polling must receive an apiClient through Providers",
      );
    }
    // When two init are concurrent, the old response sent first but returned later will overwrite the newer pending flow.
    // Generation lets the last user operation own the flow, and the old response only ends with its own caller.
    const startGeneration = ++this.oauthFlowStartGeneration;
    this.oauthFlowStartProvider = provider;
    this.clearPendingState();
    const pollToken = randomBytes(32).toString("hex");
    const initUrl = buildZCodeApiUrlFromEnv(this.env, "/api/v1/oauth/cli/init");
    const envelope = await readApiJson<OAuthFlowEnvelope>(this.apiClient, initUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${pollToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ provider }),
    });
    if (this.oauthFlowStartGeneration !== startGeneration) {
      throw new Error("OAuth flow was superseded by a new sign-in request");
    }
    this.oauthFlowStartProvider = null;
    const data = envelope.data;
    if (
      envelope.code !== 0 ||
      !isUnknownRecord(data) ||
      !readTrimmedString(data.flow_id) ||
      !readTrimmedString(data.authorize_url) ||
      !Number.isFinite(data.expires_at) ||
      !Number.isFinite(data.poll_interval_sec)
    ) {
      throw new Error(readTrimmedString(envelope.msg) || "OAuth flow init response is invalid");
    }

    const flowId = readTrimmedString(data.flow_id)!;
    const authorizeUrlString = readTrimmedString(data.authorize_url)!;
    const expiresAt = (data.expires_at as number) * 1_000;
    const pollIntervalMs = (data.poll_interval_sec as number) * 1_000;
    let authorizeUrl: URL;
    try {
      authorizeUrl = new URL(authorizeUrlString);
    } catch {
      throw new Error("OAuth flow init response is invalid");
    }
    if (provider === BIGMODEL_PROVIDER_ID) {
      // The failure page of BigModel CLI callback will truncate the original Desktop deep link callback experience.
      // The flow is still polled by the Host, but the browser callback is restored to the official website transfer page, and then transparently transmitted to zcode://oauth/callback.
      authorizeUrl.searchParams.set("redirect", buildDesktopOAuthRedirectUriFromEnv(this.env));
    } else if (provider === ZAI_PROVIDER_ID) {
      // Z.AI backend init may still return provider-specific callback, causing the bounce behavior to be inconsistent with BigModel.
      // Desktop is uniformly rewritten as the official website transfer page, and then transparently transmitted from the official website to zcode://oauth/callback.
      authorizeUrl.searchParams.set("redirect_uri", buildDesktopOAuthRedirectUriFromEnv(this.env));
    }
    const state = authorizeUrl.searchParams.get("state")?.trim();
    const remainingLifetimeMs = expiresAt - this.now();
    if (
      authorizeUrl.protocol !== "https:" ||
      !state ||
      !Number.isFinite(expiresAt) ||
      !Number.isFinite(pollIntervalMs) ||
      remainingLifetimeMs <= 0 ||
      pollIntervalMs < 1_000 ||
      pollIntervalMs >= remainingLifetimeMs
    ) {
      throw new Error("OAuth flow init response is invalid");
    }

    const timeoutMs = Math.min(OAUTH_TIMEOUT_MS, remainingLifetimeMs);
    const timeout = setTimeout(() => {
      const pending = this.pendingState;
      // When the polling flow times out, it must be closed immediately and cannot wait for the next UI polling; at the same time, the flowId is verified to prevent the old timer from clearing the new flow.
      if (pending?.state === state && pending.polling?.flowId === flowId) {
        this.clearPendingState();
      }
    }, timeoutMs);
    this.pendingState = {
      state,
      provider: adapter.providerId,
      timeout,
      phase: "awaiting-attribution-or-code",
      polling: {
        expiresAt,
        flowId,
        nextPollAt: this.now(),
        pollIntervalMs,
        pollToken,
        pollUrl: buildZCodeApiUrlFromEnv(
          this.env,
          `/api/v1/oauth/cli/poll/${encodeURIComponent(flowId)}`,
        ),
      },
    };

    serviceLog.info("OAuth polling flow started", {
      expiresInMs: timeoutMs,
      pollIntervalMs,
      provider,
    });
    return { provider, authorizeUrl: authorizeUrl.toString(), state };
  }

  async pollPendingOAuth(): Promise<OAuthCallbackResult | null> {
    const apiClient = this.apiClient;
    if (!apiClient) {
      return null;
    }
    const pending = this.pendingState;
    const polling = pending?.polling;
    if (!pending || !polling) {
      return null;
    }
    if (this.now() >= polling.expiresAt) {
      this.clearPendingState();
      throw new Error("OAuth flow has expired");
    }
    if (this.now() < polling.nextPollAt) {
      return null;
    }
    polling.nextPollAt = this.now() + polling.pollIntervalMs;

    let envelope: OAuthFlowEnvelope;
    try {
      envelope = await readApiJson<OAuthFlowEnvelope>(apiClient, polling.pollUrl, {
        headers: { Authorization: `Bearer ${polling.pollToken}` },
      });
    } catch (error) {
      if (this.pendingState !== pending) return null;
      if (
        error instanceof ApiError &&
        error.status &&
        error.status >= 400 &&
        error.status < 500 &&
        error.status !== 408 &&
        error.status !== 429
      ) {
        try {
          return await this.runPendingSessionCompletion(pending, async () => {
            throw error;
          });
        } catch (terminalError) {
          if (this.pendingState === pending) this.clearPendingState();
          throw terminalError;
        }
      }
      // Polling is a reliable path when the deep link is lost. A single network outage or 5xx cannot cancel the flow immediately.
      // Keep the query interval issued by the server and continue trying in the next round; only debug is recorded in high-frequency status to avoid production log expansion.
      serviceLog.debug("OAuth polling request will retry", {
        error: error instanceof Error ? error.message : String(error),
        provider: pending.provider,
      });
      return null;
    }
    if (this.pendingState !== pending) {
      return null;
    }
    if (
      envelope.code === 0 &&
      isUnknownRecord(envelope.data) &&
      readTrimmedString(envelope.data.status) === "pending"
    ) {
      return null;
    }
    try {
      const result = await this.runPendingSessionCompletion(pending, async () => {
        const pollData = envelope.data;
        if (envelope.code !== 0 || !isUnknownRecord(pollData)) {
          throw new Error(readTrimmedString(envelope.msg) || "OAuth flow poll response is invalid");
        }
        const status = readTrimmedString(pollData.status);
        if (status === "failed") {
          throw new Error("OAuth flow authorization failed");
        }
        if (status !== "ready") {
          throw new Error("OAuth flow poll response is invalid");
        }

        const ready = pollData;
        const user = isUnknownRecord(ready.user) ? ready.user : null;
        const zai = isUnknownRecord(ready.zai) ? ready.zai : null;
        const bigmodel = isUnknownRecord(ready.bigmodel) ? ready.bigmodel : null;
        const providerAccessToken =
          pending.provider === ZAI_PROVIDER_ID
            ? readTrimmedString(zai?.access_token)
            : readTrimmedString(bigmodel?.access_token) || readTrimmedString(bigmodel?.accessToken);
        const zcodeJwtToken = readTrimmedString(ready.token);
        const userId = readTrimmedString(user?.user_id);
        if (!zcodeJwtToken || !providerAccessToken || !userId) {
          throw new Error("OAuth flow poll response is invalid");
        }
        const username = readTrimmedString(user?.name) || readTrimmedString(user?.email) || userId;
        const avatarUrl = readTrimmedString(user?.avatar);
        const profile: OAuthUserProfile = {
          id: userId,
          username,
          displayName: username,
          ...(avatarUrl ? { avatarUrl } : {}),
          rawProfile: user,
        };
        const adapter = this.getAdapter(pending.provider);
        const refreshToken =
          pending.provider === BIGMODEL_PROVIDER_ID
            ? readTrimmedString(bigmodel?.refresh_token) ||
              readTrimmedString(bigmodel?.refreshToken)
            : undefined;
        const tokenSet = adapter.normalizePolledTokenSet
          ? await adapter.normalizePolledTokenSet({
              accessToken: providerAccessToken,
              zcodeJwtToken,
              ...(refreshToken ? { refreshToken } : {}),
            })
          : {
              accessToken: providerAccessToken,
              zcodeJwtToken,
              ...(refreshToken ? { refreshToken } : {}),
            };
        return { tokenSet, profile };
      });
      if (result?.kind === "session") {
        serviceLog.info("OAuth polling flow completed", { provider: pending.provider });
      }
      return result;
    } catch (error) {
      if (this.pendingState === pending) this.clearPendingState();
      throw error;
    }
  }

  private async startOAuthInternal(provider: OAuthProviderId): Promise<OAuthStartResponse> {
    const adapter = this.getEnabledAdapter(provider);

    // When clicking different providers in the same window quickly and continuously, if the old state is not canceled first,
    // Two concurrent processes will share the same callback channel, causing the later callback to preempt the previous callback and trigger state mismatch.
    await this.runSessionMutation(async () => {
      this.oauthFlowStartGeneration += 1;
      this.oauthFlowStartProvider = null;
      this.clearPendingState();
    });

    const state = randomBytes(32).toString("hex");
    const timeout = setTimeout(() => {
      if (this.pendingState?.state === state) {
        this.pendingState = null;
      }
    }, OAUTH_TIMEOUT_MS);

    this.pendingState = {
      state,
      provider: adapter.providerId,
      timeout,
      phase: "awaiting-attribution-or-code",
    };

    const authorizeUrl = adapter.buildAuthorizeUrl({
      providerId: adapter.providerId,
      state,
      redirectUri: adapter.redirectUri,
      now: this.now,
    });

    return {
      provider: adapter.providerId,
      authorizeUrl,
      state,
    };
  }

  async handleCallback(url: string): Promise<OAuthCallbackResult | null> {
    const pending = this.pendingState;
    if (!pending) {
      const callbackState = new URL(url).searchParams.get("state")?.trim();
      const completed = this.recentlyCompletedPollingState;
      if (
        callbackState &&
        completed?.state === callbackState &&
        completed.generation === this.oauthFlowStartGeneration &&
        this.now() < completed.expiresAt
      ) {
        const attribution = parseOAuthLoginAttribution(new URL(url).searchParams);
        await this.runSessionMutation(async () => {
          // Reason for fix: Browser attribution still needs to be saved when polling succeeds first, and login deduplication cannot be regarded as discarding the entire callback.
          if (
            !this.pendingState &&
            this.recentlyCompletedPollingState === completed &&
            completed.generation === this.oauthFlowStartGeneration &&
            attribution
          ) {
            await this.repo.saveLoginAttribution(attribution);
          }
        });
        return { kind: "duplicate", provider: completed.provider };
      }
      throw new Error("OAuth state does not match or has expired");
    }

    const parsedUrl = new URL(url);
    const state = parsedUrl.searchParams.get("state");
    if (!state || state !== pending.state) {
      throw new Error("OAuth state does not match or has expired");
    }
    if (pending.polling && this.now() >= pending.polling.expiresAt) {
      this.clearPendingState();
      throw new Error("OAuth flow has expired");
    }

    const attribution = parseOAuthLoginAttribution(parsedUrl.searchParams);
    if (attribution && !hasOAuthAuthorizationCode(parsedUrl.searchParams)) {
      if (pending.phase === "awaiting-code-after-attribution") {
        throw new Error("OAuth attribution callback was already handled");
      }

      // Reason for repair: Pure attribution callback is a transit step before the final authorization code, and the state that still needs to be logged in cannot be cleared;
      // However, if the phase is not explicitly advanced, the same state can be repeatedly written and attributed and the pending life cycle is implicitly reused.
      pending.phase = "awaiting-code-after-attribution";
      try {
        await this.repo.saveLoginAttribution(attribution);
      } catch (error) {
        if (this.pendingState === pending) {
          pending.phase = "awaiting-attribution-or-code";
        }
        throw error;
      }
      return {
        kind: "attribution",
        provider: pending.provider,
        attribution,
      };
    }

    const adapter = this.getAdapter(pending.provider);
    const fallbackProfile: OAuthUserProfile = {
      id: "unknown",
      username: "user",
      displayName: "User",
    };

    return this.runPendingSessionCompletion(
      pending,
      async () => {
        const callback = adapter.parseCallbackParams(url);
        const context = {
          providerId: adapter.providerId,
          state: callback.state,
          redirectUri: adapter.redirectUri,
          now: this.now,
        };
        const tokenSet = await this.runWithAdapterError(adapter, () =>
          adapter.exchangeToken(callback, context),
        );
        let profile = fallbackProfile;
        if (adapter.fetchUserInfo) {
          try {
            profile = await this.runWithAdapterError(adapter, () =>
              adapter.fetchUserInfo!(tokenSet, context),
            );
          } catch {
            // Failure to obtain user information does not block login
          }
        }
        return { tokenSet, profile };
      },
      attribution ? () => this.repo.saveLoginAttribution(attribution) : undefined,
    );
  }

  async refreshToken(provider?: OAuthProviderId): Promise<void> {
    const generation = this.oauthSessionGeneration;
    const targetProvider = await this.resolveProvider(provider);
    if (!targetProvider) {
      throw new Error("No sign-in provider is currently available");
    }

    const adapter = this.getEnabledAdapter(targetProvider);
    if (!adapter.refreshToken) {
      throw new Error(
        `${adapter.meta.displayName} OAuth does not provide a refresh token exchange yet; please sign in again`,
      );
    }

    const activeProvider = await this.repo.getActiveProvider();
    if (targetProvider !== activeProvider) {
      throw new Error(
        "Only the provider signed in to this app can be refreshed; please sign in again",
      );
    }

    const tokenSet = await this.repo.loadActiveTokenSet();
    if (!tokenSet?.refreshToken) {
      throw new Error("The current account has no refresh_token; please sign in again");
    }

    const refreshed = await this.runWithAdapterError(adapter, () =>
      adapter.refreshToken!(tokenSet, {
        providerId: targetProvider,
        state: "",
        redirectUri: adapter.redirectUri,
        now: this.now,
      }),
    );

    await this.runSessionMutation(async () => {
      // Flush writebacks that bypass the session queue will insert a 401 verification/cleanup window, or resurrect credentials after exiting.
      if (
        this.oauthSessionGeneration !== generation ||
        (await this.repo.getActiveProvider()) !== targetProvider ||
        (await this.credentialService.load(`oauth:${targetProvider}:access_token`)) !==
          tokenSet.accessToken
      )
        return;
      await this.repo.saveActiveTokenSet(refreshed);
    });
  }

  /** Host-local 401 submission entry point; it does not extend IOAuthService's cross-endpoint contract. */
  logoutIfCurrentCredentialRequest(input: string | URL, headers: Headers): Promise<boolean> {
    return this.logoutActiveSession(() =>
      isCurrentOAuthCredentialRequest({
        input,
        headers,
        credentialService: this.credentialService,
        env: this.env,
      }),
    );
  }

  private async logoutActiveSession(isCurrent?: () => Promise<boolean>): Promise<boolean> {
    const result = await this.runSessionMutation(async () => {
      // True for async classification is not a cleanup authorization; credential review and cleanup must share the same queue as the login write.
      if (isCurrent && !(await isCurrent())) return null;
      const activeProvider = await this.repo.getActiveProvider();
      // Merge boundary: Keep the original account identity before cleaning. You cannot return to clean only by platform or guess the identity after exiting.
      const accountIdentity = activeProvider
        ? ((await this.repo.loadUserProfile(activeProvider))?.id ?? null)
        : null;
      this.oauthSessionGeneration += 1;
      await this.repo.clearActiveSession();
      return { activeProvider, accountIdentity };
    });
    if (!result) return false;
    if (result.activeProvider) {
      await this.cancelPending(result.activeProvider);
      try {
        await this.notifyProviderLogout(result.activeProvider, result.accountIdentity);
      } catch (error) {
        if (!isCurrent) throw error;
        // The credentials have been cleared. Failure to derive the configuration cannot swallow the original expiration prompt; manual exit still retains the original error semantics.
        serviceLog.warn("Unauthorized session provider cleanup failed", { error });
      }
    }
    return true;
  }

  async logout(provider?: OAuthProviderId): Promise<void> {
    if (!provider) {
      await this.logoutActiveSession();
      return;
    }

    const loggedOutIdentity = await this.runSessionMutation(async () => {
      const activeProvider = await this.repo.getActiveProvider();
      if (provider !== activeProvider) {
        return undefined;
      }
      const accountIdentity = (await this.repo.loadUserProfile(provider))?.id ?? null;
      this.oauthSessionGeneration += 1;
      // ZAI/BigModel provider's Unlink has converged to App logout.
      // Only the current active provider represents the login fact, preventing the old unlink path from accidentally deleting non-current provider tokens.
      await this.repo.clearActiveSession();
      return accountIdentity;
    });
    if (loggedOutIdentity !== undefined) {
      await this.notifyProviderLogout(provider, loggedOutIdentity);
    }
    await this.cancelPending(provider);
  }

  async logoutAll(): Promise<void> {
    const providers = [...this.adapters.keys()];
    const accountIdentities = await this.runSessionMutation(async () => {
      const identities = new Map<OAuthProviderId, string | null>();
      for (const provider of providers) {
        identities.set(provider, (await this.repo.loadUserProfile(provider))?.id ?? null);
      }
      this.oauthSessionGeneration += 1;
      await this.repo.clearAll(providers);
      return identities;
    });
    await this.cancelPending();
    await this.notifyProvidersLogout(providers, accountIdentities);
  }

  async cancelPending(provider?: OAuthProviderId): Promise<void> {
    if (!this.pendingState) {
      if (provider && this.oauthFlowStartProvider && this.oauthFlowStartProvider !== provider)
        return;
      this.oauthFlowStartGeneration += 1;
      this.oauthFlowStartProvider = null;
      return;
    }
    if (provider && this.pendingState.provider !== provider) return;
    this.oauthFlowStartGeneration += 1;
    this.oauthFlowStartProvider = null;
    this.clearPendingState();
  }

  private clearPendingState(): void {
    if (!this.pendingState) {
      return;
    }

    clearTimeout(this.pendingState.timeout);
    this.pendingState = null;
  }

  private async notifyProviderLogout(
    provider: OAuthProviderId,
    accountIdentity?: string | null,
  ): Promise<void> {
    if (!this.onProviderLogout) {
      return;
    }

    await this.onProviderLogout(provider, accountIdentity);
  }

  private async notifyProvidersLogout(
    providers: readonly OAuthProviderId[],
    accountIdentities: ReadonlyMap<OAuthProviderId, string | null> = new Map(),
  ): Promise<void> {
    await Promise.all(
      providers.map((provider) =>
        this.notifyProviderLogout(provider, accountIdentities.get(provider)),
      ),
    );
  }

  private getAdapter(provider: OAuthProviderId): OAuthProviderAdapter {
    const adapter = this.adapters.get(provider);
    if (!adapter) {
      throw new Error(`Unsupported OAuth provider: ${provider}`);
    }

    return adapter;
  }

  private getEnabledAdapter(provider: OAuthProviderId): OAuthProviderAdapter {
    const adapter = this.getAdapter(provider);
    if (!adapter.meta.enabled) {
      throw new Error(`OAuth provider is not enabled: ${provider}`);
    }

    return adapter;
  }

  private async resolveProvider(provider?: OAuthProviderId): Promise<OAuthProviderId | null> {
    if (provider) {
      return provider;
    }

    return this.repo.getActiveProvider();
  }

  private async runWithAdapterError<T>(
    adapter: OAuthProviderAdapter,
    run: () => Promise<T>,
  ): Promise<T> {
    try {
      return await run();
    } catch (error) {
      throw adapter.normalizeError(error);
    }
  }

  private isUnauthorizedError(error: Error): boolean {
    const lowerMessage = error.message.toLowerCase();
    return (
      /\b401\b|\b403\b/.test(lowerMessage) ||
      lowerMessage.includes("unauthorized") ||
      lowerMessage.includes("forbidden")
    );
  }
}

/**
 * Factory function: creates an OAuthService instance
 */
export function createOAuthService(
  credentialService: ICredentialService,
  dependencies: Omit<OAuthServiceDependencies, "adapters"> = {},
): OAuthService {
  return new OAuthService(credentialService, {
    ...dependencies,
    adapters: createOAuthProviderAdapters(createOAuthRuntimeConfig(dependencies.env), {
      apiClient: dependencies.apiClient,
    }),
  });
}
