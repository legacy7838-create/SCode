import { ProviderConfigMap } from "./config/index.js";
import type { AccountProviderStates } from "./account-provider-state.js";
import {
  createFailClosedAccountProviderConfigSnapshot,
  createAccountProviderConfigSnapshot,
  type AccountProviderConfigSnapshot,
  type ProviderConfigSnapshot,
  type ProviderSource,
} from "./sources.js";

export interface AccountProviderResolveInput {
  readonly configRevision: string;
  readonly configuredProviders: ProviderConfigMap;
  readonly previousProviders: ProviderConfigMap;
  readonly previousStates?: AccountProviderStates;
  readonly reasons?: readonly string[];
}

export type AccountProviderResolver = (
  input: AccountProviderResolveInput,
) => Promise<{ readonly providers: ProviderConfigMap; readonly states: AccountProviderStates }>;

export interface AccountProviderServiceDependencies {
  readonly configSource: ProviderSource<ProviderConfigSnapshot>;
  readonly resolve: AccountProviderResolver;
}

export interface AccountProviderServiceRefreshErrorEvent {
  readonly error: unknown;
  readonly reasons: readonly string[];
}

interface RefreshWaiter {
  readonly generation: number;
  readonly resolve: (snapshot: AccountProviderConfigSnapshot) => void;
  readonly reject: (error: unknown) => void;
}

/**
 * Maintains the third-layer Provider Config Overlay projected from the current account state.
 *
 * The service only orchestrates the Config Source, refreshing, and last-known-good publication;
 * the actual login, entitlement, and team-connection lookups are injected by outer Resolvers, so
 * this package depends on no file, network, or OAuth implementation.
 */
export class AccountProviderService implements ProviderSource<AccountProviderConfigSnapshot> {
  readonly #configSource: ProviderSource<ProviderConfigSnapshot>;
  readonly #resolve: AccountProviderResolver;
  readonly #changeListeners = new Set<(reason: string) => void>();
  readonly #errorListeners = new Set<(event: AccountProviderServiceRefreshErrorEvent) => void>();
  readonly #pendingReasons = new Set<string>();
  #configDispose: (() => void) | null = null;
  #snapshot: AccountProviderConfigSnapshot | null = null;
  #refreshInFlight: Promise<AccountProviderConfigSnapshot> | null = null;
  #requestedGeneration = 0;
  readonly #refreshWaiters: RefreshWaiter[] = [];
  #started = false;
  #disposed = false;

  constructor(dependencies: AccountProviderServiceDependencies) {
    this.#configSource = dependencies.configSource;
    this.#resolve = dependencies.resolve;
  }

  async read(): Promise<AccountProviderConfigSnapshot> {
    this.#assertNotDisposed();
    this.#ensureStarted();
    if (this.#snapshot) return this.#snapshot;
    // The concurrent first read is not a new account fact and cannot be discharged in the second round and overwrite the first fail-closed startup result.
    if (this.#refreshInFlight) return this.#refreshInFlight;
    return this.#requestRefresh("start");
  }

  refresh(reason = "explicit"): Promise<AccountProviderConfigSnapshot> {
    this.#assertNotDisposed();
    this.#ensureStarted();
    return this.#requestRefresh(reason);
  }

  onDidChange(listener: (reason: string) => void): () => void {
    this.#changeListeners.add(listener);
    return () => this.#changeListeners.delete(listener);
  }

  onDidRefreshError(
    listener: (event: AccountProviderServiceRefreshErrorEvent) => void,
  ): () => void {
    this.#errorListeners.add(listener);
    return () => this.#errorListeners.delete(listener);
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#configDispose?.();
    this.#configDispose = null;
    const error = new Error("AccountProviderService has been disposed");
    for (const waiter of this.#refreshWaiters.splice(0)) waiter.reject(error);
    this.#changeListeners.clear();
    this.#errorListeners.clear();
  }

  #ensureStarted(): void {
    if (this.#started) return;
    this.#started = true;
    this.#configDispose = this.#configSource.onDidChange((reason) => {
      void this.#requestRefresh(`config:${reason || "changed"}`).catch(() => {
        // Source-driven background failures are reported via onDidRefreshError; the last successful snapshot is retained.
      });
    });
  }

  #requestRefresh(reason: string): Promise<AccountProviderConfigSnapshot> {
    // The ongoing round started before this request, and the settings and account identities it reads may have been changed by the requesting party.
    // Subsequent write changes (for example, Provisioning first writes Setting and then changes credentials). Directly reusing the round will make its
    // Expiration failure is the result of this request. The contract of refresh is to return a round that covers the state after this request.
    const generation = this.#requestedGeneration + 1;
    this.#requestedGeneration = generation;
    this.#pendingReasons.add(reason);
    const result = new Promise<AccountProviderConfigSnapshot>((resolve, reject) => {
      this.#refreshWaiters.push({ generation, resolve, reject });
    });
    if (!this.#refreshInFlight) this.#startRefresh();
    return result;
  }

  #startRefresh(): Promise<AccountProviderConfigSnapshot> {
    const refresh = this.#runRefreshLoop();
    this.#refreshInFlight = refresh;
    void refresh.then(
      () => this.#finishRefresh(refresh),
      () => this.#finishRefresh(refresh),
    );
    return refresh;
  }

  #finishRefresh(refresh: Promise<AccountProviderConfigSnapshot>): void {
    if (this.#refreshInFlight !== refresh) return;
    this.#refreshInFlight = null;
    if (this.#disposed || this.#pendingReasons.size === 0) return;

    // If the current round fails, the refresh loop will exit early; events added during the failure are still pending.
    // The next round must be started after in-flight release, otherwise the account status will stay at the old snapshot until external events are received again.
    void this.#startRefresh().catch(() => {
      // There are no direct callers for subsequent rounds; the error has been posted via onDidRefreshError and remains last-known-good.
    });
  }

  async #runRefreshLoop(): Promise<AccountProviderConfigSnapshot> {
    let latest = this.#snapshot;
    while (this.#pendingReasons.size > 0) {
      // All requests made before the start of this round are responded to by the results of this round; requests arriving after the start of this round are left for the next round.
      const generation = this.#requestedGeneration;
      const reasons = [...this.#pendingReasons];
      this.#pendingReasons.clear();
      let config: ProviderConfigSnapshot | undefined;
      try {
        config = await this.#configSource.read();
        const configuredProviders = config.zcodeBuiltinProviders;
        const { providers, states } = await this.#resolve({
          configRevision: config.zcodeBuiltinRevision,
          configuredProviders,
          previousProviders: latest?.providers ?? ProviderConfigMap.empty(),
          previousStates: latest?.states,
          reasons: Object.freeze(reasons),
        });
        // Account Snapshot has expressed the source of Overlay, and the target and field boundaries are injected by
        // Resolver and Account Schema are responsible. If you press Built-in access.type again for access control, it will be rejected by error.
        // The account layer is an entitled-only Overlay released by the Provider during idle times, causing the entire Registry to fail to start.
        this.#assertNotDisposed();
        // Queries can be updated across Built-in/credentials; expired rounds can only be discarded and cannot be released briefly and then corrected.
        const currentConfig = await this.#configSource.read();
        this.#assertNotDisposed();
        if (
          this.#pendingReasons.size > 0 ||
          currentConfig.zcodeBuiltinRevision !== config.zcodeBuiltinRevision
        ) {
          this.#pendingReasons.add("superseded-resolution");
          continue;
        }
        const basedOnZCodeBuiltinRevision = config.zcodeBuiltinRevision;
        const next = createAccountProviderConfigSnapshot(
          basedOnZCodeBuiltinRevision,
          providers,
          states,
        );
        const revision = next.revision;
        if (latest?.revision === revision) {
          this.#resolveRefreshWaiters(generation, latest);
          continue;
        }
        const hadSnapshot = latest !== null;
        latest = next;
        this.#snapshot = latest;
        this.#resolveRefreshWaiters(generation, latest);
        if (hadSnapshot) {
          const changeReason = reasons.join(",");
          for (const listener of this.#changeListeners) listener(changeReason);
        }
      } catch (error) {
        const event = Object.freeze({ error, reasons: Object.freeze(reasons) });
        for (const listener of this.#errorListeners) listener(event);
        if (!latest && config) {
          // The first account network/credential resolution failure is treated as a ready barrier for the entire Registry.
          // Even the API/Personal Provider that does not rely on accounts cannot be started. Accounts that are unknown should only be explicitly fail-closed.
          latest = createFailClosedAccountProviderConfigSnapshot(config);
          this.#snapshot = latest;
          this.#resolveRefreshWaiters(generation, latest);
          continue;
        }
        // Only requests before the start of this round are rejected; requests arriving afterward are still pending, and #finishRefresh will start the next round of responses.
        this.#rejectRefreshWaiters(generation, error);
        throw error;
      }
    }
    if (!latest) throw new Error("Account Provider Service has not produced a snapshot yet");
    return latest;
  }

  #resolveRefreshWaiters(generation: number, snapshot: AccountProviderConfigSnapshot): void {
    const remaining: RefreshWaiter[] = [];
    for (const waiter of this.#refreshWaiters) {
      if (waiter.generation <= generation) waiter.resolve(snapshot);
      else remaining.push(waiter);
    }
    this.#refreshWaiters.splice(0, this.#refreshWaiters.length, ...remaining);
  }

  #rejectRefreshWaiters(generation: number, error: unknown): void {
    const remaining: RefreshWaiter[] = [];
    for (const waiter of this.#refreshWaiters) {
      if (waiter.generation <= generation) waiter.reject(error);
      else remaining.push(waiter);
    }
    this.#refreshWaiters.splice(0, this.#refreshWaiters.length, ...remaining);
  }

  #assertNotDisposed(): void {
    if (this.#disposed) throw new Error("AccountProviderService has been disposed");
  }
}
