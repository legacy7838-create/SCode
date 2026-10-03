import {
  AccountProviderService,
  MutableAccountProviderConfigSource,
  ProviderRegistryService,
  createFailClosedAccountProviderConfigSnapshot,
  parseAccountProviderConfigMap,
  type AccountProviderConfigSnapshot,
  type AccountProviderStates,
} from "@zcode/provider";
import {
  isBuiltinModelProviderId,
  resolveRuntimeZCodeEndpointOrigin,
  ZCODE_VERSION,
} from "@zcode/shared";
import { dirname, join } from "node:path";
import {
  NodeModelSelectionConfigRepository,
  NodeProviderConfigRuntime,
  resolveNodeProviderRuntimePaths,
  downloadZCodeBuiltinRelease,
  resolveZCodeBuiltinClientPlatform,
  ZCODE_BUILTIN_PROVIDER_BUNDLED_CONFIG_FILE_ENV,
  type ZCodeBuiltinRefreshEvent,
} from "@zcode/rust/provider-node";
import {
  createSharedZCodeCredentialStore,
  type SharedZCodeCredentialStore,
} from "@zcode/adapters/auth";
import { readLegacyCliPersonalProviderConfig } from "./legacy-cli-personal-provider-config-importer.js";
import {
  createStandaloneProviderRuntimeHeadersPort,
  readStandaloneAccountProviderConfigSnapshot,
} from "./standalone-account-provider-runtime.js";

export interface ProcessProviderRegistryRuntimeOptions {
  /** One-shot import for the standalone Prompt CLI / TUI, which owns its account credentials and legacy config itself. */
  readonly standalone?: {
    readonly credentialStore?: SharedZCodeCredentialStore;
    readonly legacyCliUserConfigFilePath?: string;
    readonly onAccountInitializationError?: (error: unknown) => void;
    readonly request?: typeof fetch;
    readonly onBuiltinRefreshError?: (error: unknown) => void;
    readonly onBuiltinRefreshResult?: (event: ZCodeBuiltinRefreshEvent) => void;
  };
}

export async function startProcessProviderRegistryRuntime(
  env: Readonly<Record<string, string | undefined>>,
  options: ProcessProviderRegistryRuntimeOptions = {},
) {
  const paths = resolveNodeProviderRuntimePaths(env);
  if (!paths) {
    throw new Error("missing ZCode Built-in / Personal Config paths for the process Provider Registry");
  }

  const accountSource = new MutableAccountProviderConfigSource();
  const credentialStore = options.standalone
    ? (options.standalone.credentialStore ?? createSharedZCodeCredentialStore({ env: { ...env } }))
    : undefined;
  let standaloneAccount: AccountProviderService | undefined;
  const bundledFile = options.standalone
    ? env[ZCODE_BUILTIN_PROVIDER_BUNDLED_CONFIG_FILE_ENV]?.trim()
    : undefined;
  // `NodeProviderRegistryRuntime` was only ever this composition: the config
  // runtime, the account source, the registry service and the start order
  // (spec rust-native-provider-node.md §2). It is assembled here now, over the
  // native-owned config runtime, so there is one owner for the file plane.
  const configRuntime = new NodeProviderConfigRuntime({
    ...paths,
    ...(bundledFile
      ? {
          zcodeBuiltinFilePath: bundledFile,
          zcodeBuiltinActiveFilePath: paths.zcodeBuiltinFilePath,
          zcodeBuiltinRemote: {
            controlFilePath: join(
              dirname(paths.zcodeBuiltinFilePath),
              "zcode-builtin-refresh.json",
            ),
            resolveEndpointKey: () => resolveRuntimeZCodeEndpointOrigin(env),
            fetchRelease: (endpointOrigin, signal) =>
              downloadZCodeBuiltinRelease({
                endpointOrigin,
                signal,
                appVersion: ZCODE_VERSION,
                platform: resolveZCodeBuiltinClientPlatform(),
                request: options.standalone?.request ?? globalThis.fetch,
              }),
            onRefreshResult: options.standalone?.onBuiltinRefreshResult,
          },
        }
      : {}),
    onZCodeBuiltinRefreshError: options.standalone?.onBuiltinRefreshError,
    ...(options.standalone
      ? {
          importLegacy: () =>
            readLegacyCliPersonalProviderConfig({
              ...(options.standalone?.legacyCliUserConfigFilePath
                ? { filePath: options.standalone.legacyCliUserConfigFilePath }
                : {}),
            }),
        }
      : {}),
  });
  // With credentials, the account source is the standalone AccountService —
  // it resolves this Environment's snapshot itself; otherwise the mutable
  // host-driven source, which the fail-closed barrier initialises on start.
  const accountSourceInstance = credentialStore
    ? (standaloneAccount = new AccountProviderService({
        configSource: configRuntime.configService,
        async resolve({ configRevision, configuredProviders }) {
          // Use Built-in captured in this round instead of asynchronously
          // reading another file and then just posting the new revision.
          const snapshot = await readStandaloneAccountProviderConfigSnapshot(
            credentialStore,
            env,
            { revision: configRevision, providers: configuredProviders },
          );
          return { providers: snapshot.providers, states: snapshot.states ?? {} };
        },
      }))
    : accountSource;
  standaloneAccount?.onDidRefreshError(({ error }) => {
    try {
      options.standalone?.onAccountInitializationError?.(error);
    } catch {
      /* Observability callbacks must not change account facts. */
    }
  });
  const registryService = new ProviderRegistryService({
    configSource: configRuntime.configService,
    accountSource: accountSourceInstance,
  });
  let startPromise: Promise<void> | null = null;
  /** Config read → fail-closed account barrier → registry start, single-flight. */
  const startRegistry = (): Promise<void> => {
    if (startPromise) return startPromise;
    startPromise = (async () => {
      try {
        await configRuntime.start();
        // An account source that has never been populated must fail closed
        // against the config revision it will be judged by, instead of
        // publishing an uninitialized overlay.
        if (accountSourceInstance instanceof MutableAccountProviderConfigSource) {
          const account = await accountSourceInstance.read();
          if (account.basedOnZCodeBuiltinRevision === "uninitialized") {
            accountSourceInstance.replace(
              createFailClosedAccountProviderConfigSnapshot(
                await configRuntime.configService.read(),
              ),
              "initial-fail-closed",
            );
          }
        }
        await registryService.start();
      } catch (error) {
        startPromise = null;
        throw error;
      }
    })();
    return startPromise;
  };
  const runtime = {
    configService: configRuntime.configService,
    personalRepository: configRuntime.personalRepository,
    registryService,
    start: startRegistry,
    refreshZCodeBuiltin: (refreshOptions?: { readonly force?: boolean }) =>
      configRuntime.refreshZCodeBuiltin(refreshOptions),
    onDidCheckZCodeBuiltin: (listener: () => Promise<void>) =>
      configRuntime.onDidCheckZCodeBuiltin(listener),
    resolveZCodeBuiltinActiveFilePath: () => configRuntime.resolveZCodeBuiltinActiveFilePath(),
    dispose: () => {
      registryService.dispose();
      configRuntime.dispose();
    },
  };
  const disposeRecovery = standaloneAccount
    ? runtime.onDidCheckZCodeBuiltin(async () => {
        const [config, account] = await Promise.all([
          runtime.configService.read(),
          standaloneAccount!.read(),
        ]);
        if (config.zcodeBuiltinRevision !== account.basedOnZCodeBuiltinRevision)
          await standaloneAccount!.refresh("builtin-account-recovery");
      })
    : undefined;
  // Reuse AccountService's serial and expired result discarding mechanism. Credential changes and Built-in changes cannot be released separately.
  const disposeCredentialSubscription = credentialStore?.onDidChange?.(async () => {
    await standaloneAccount!.refresh("standalone-credentials-changed");
    await runtime.registryService.refresh("standalone-credentials-barrier");
  });
  try {
    await runtime.start();
    const snapshot = runtime.registryService.getSnapshot()!;
    const modelSelectionConfigRepository = new NodeModelSelectionConfigRepository({
      personalRepository: runtime.personalRepository,
    });
    try {
      const configuredDefaultModelSelection = await modelSelectionConfigRepository.read();
      return Object.freeze({
        accountSource: standaloneAccount ?? accountSource,
        async syncAccountProviderConfig(next: AccountProviderConfigSnapshot): Promise<boolean> {
          if (standaloneAccount)
            throw new Error("Standalone Account is managed by this process and does not accept Host overrides");
          const changed = accountSource.replace(next, "host-account-config");
          // Source deduplication only proves that it has been collected, not that the last refresh was successful. It will still be refreshed when resubmitting; the supporting configuration has not arrived.
          // Then the Registry retains the complete old snapshot, and the receipt confirmation cannot be passed off as application confirmation.
          await runtime.registryService.refresh("host-account-config");
          return changed;
        },
        dispose() {
          disposeCredentialSubscription?.();
          disposeRecovery?.();
          standaloneAccount?.dispose();
          modelSelectionConfigRepository.dispose();
          runtime.dispose();
        },
        ...(credentialStore
          ? {
              providerRuntimeHeadersPort: createStandaloneProviderRuntimeHeadersPort(
                credentialStore,
                env,
              ),
            }
          : {}),
        runtime,
        snapshot,
        modelSelectionConfigRepository,
        configuredDefaultModelSelection,
      });
    } catch (error) {
      disposeCredentialSubscription?.();
      modelSelectionConfigRepository.dispose();
      throw error;
    }
  } catch (error) {
    disposeCredentialSubscription?.();
    disposeRecovery?.();
    standaloneAccount?.dispose();
    runtime.dispose();
    throw error;
  }
}

/** Resolves the protocol envelope into the third-layer Account Config Overlay that the process Registry uses. */
export function parseProcessAccountProviderConfigSnapshot(input: {
  readonly revision: string;
  readonly basedOnZCodeBuiltinRevision: string;
  readonly providers: unknown;
  readonly states?: AccountProviderStates;
}): AccountProviderConfigSnapshot {
  const revision = input.revision.trim();
  if (!revision) throw new Error("Account Config revision must not be empty");
  const basedOnZCodeBuiltinRevision = input.basedOnZCodeBuiltinRevision.trim();
  if (!basedOnZCodeBuiltinRevision) {
    throw new Error("Account Config Built-in revision must not be empty");
  }
  const providers = parseAccountProviderConfigMap(input.providers);
  for (const [providerId, provider] of providers.entries()) {
    // Only normal account envelopes for managed workers are constrained; current is not required for standalone CLI, API, and idle time.
    if (
      isBuiltinModelProviderId(providerId) &&
      provider.access?.type === "zhipu-account" &&
      provider.access.entitled &&
      typeof input.states?.[providerId]?.current !== "boolean"
    ) {
      throw new Error(`Account State is missing current: ${providerId}`);
    }
  }
  return Object.freeze({
    revision,
    basedOnZCodeBuiltinRevision,
    providers,
    // Belongs to the same snapshot as Overlay; you cannot just update revision but lose the current connection fact.
    ...(input.states ? { states: input.states } : {}),
  });
}
