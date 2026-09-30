import {
  ProviderConfig,
  ProviderConfigMap,
  ProviderTemplateMap,
  ZhipuAccountAccessConfig,
  type ModelConfigRules,
} from "./config/index.js";
import type { AccountProviderStates } from "./account-provider-state.js";

export interface ProviderSource<TSnapshot> {
  read(): Promise<TSnapshot>;
  onDidChange(listener: (reason: string) => void): () => void;
}

export interface ProviderConfigSnapshot {
  readonly revision: string;
  readonly zcodeBuiltinRevision: string;
  readonly personalRevision: string;
  readonly zcodeBuiltinProviders: ProviderConfigMap;
  readonly zcodeBuiltinProviderTemplates: ProviderTemplateMap;
  readonly personalProviders: ProviderConfigMap;
  readonly zcodeBuiltinModelRules: ModelConfigRules;
  readonly personalModels: ModelConfigRules;
  readonly personalProviderOrder?: readonly string[];
}

export interface AccountProviderConfigSnapshot {
  readonly revision: string;
  readonly basedOnZCodeBuiltinRevision: string;
  readonly providers: ProviderConfigMap;
  readonly states?: AccountProviderStates;
}

/** Produces a publishable fail-closed Overlay based on the current Built-in, for the case where the first Account facts have not arrived yet. */
export function createFailClosedAccountProviderConfigSnapshot(
  config: ProviderConfigSnapshot,
): AccountProviderConfigSnapshot {
  const unentitledProviders = new ProviderConfigMap(
    config.zcodeBuiltinProviders.entries().flatMap(([providerId, provider]) =>
      provider.access?.type === "zhipu-account"
        ? ([
            [
              providerId,
              new ProviderConfig({
                access: new ZhipuAccountAccessConfig({ entitled: false }),
              }),
            ],
          ] as const)
        : [],
    ),
  );
  return createAccountProviderConfigSnapshot(config.zcodeBuiltinRevision, unentitledProviders);
}

export function createAccountProviderConfigSnapshot(
  basedOnZCodeBuiltinRevision: string,
  providers: ProviderConfigMap,
  states?: AccountProviderStates,
): AccountProviderConfigSnapshot {
  return Object.freeze({
    revision: `account:${JSON.stringify([basedOnZCodeBuiltinRevision, providers.toJSON(), states])}`,
    basedOnZCodeBuiltinRevision,
    providers,
    ...(states ? { states } : {}),
  });
}

const EMPTY_ACCOUNT_PROVIDER_CONFIG_SNAPSHOT: AccountProviderConfigSnapshot = Object.freeze({
  revision: "empty-account-config-v1",
  basedOnZCodeBuiltinRevision: "uninitialized",
  providers: ProviderConfigMap.empty(),
});

/**
 * The account Provider availability scope, updated by the adapter that surrounds the process.
 *
 * The Source only stores the third-layer Provider Config Overlay projected from the account state.
 * models is the account entitlement constraint; Token, API Key, Header and the account identity must never be written into Config.
 */
export class MutableAccountProviderConfigSource implements ProviderSource<AccountProviderConfigSnapshot> {
  readonly #listeners = new Set<(reason: string) => void>();
  #snapshot: AccountProviderConfigSnapshot = EMPTY_ACCOUNT_PROVIDER_CONFIG_SNAPSHOT;

  async read(): Promise<AccountProviderConfigSnapshot> {
    return this.#snapshot;
  }

  onDidChange(listener: (reason: string) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  replace(snapshot: AccountProviderConfigSnapshot, reason = "replace"): boolean {
    if (snapshot.revision === this.#snapshot.revision) return false;
    this.#snapshot = freezeAccountProviderConfigSnapshot(snapshot);
    for (const listener of this.#listeners) listener(reason);
    return true;
  }
}

function freezeAccountProviderConfigSnapshot(
  snapshot: AccountProviderConfigSnapshot,
): AccountProviderConfigSnapshot {
  return Object.freeze({
    revision: snapshot.revision,
    basedOnZCodeBuiltinRevision: snapshot.basedOnZCodeBuiltinRevision,
    providers: snapshot.providers,
    ...(snapshot.states ? { states: snapshot.states } : {}),
  });
}
