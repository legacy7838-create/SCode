/* eslint-disable max-lines -- The boundary replaces the 17-module packages/provider-node package: hydration, the injected-callback wiring and the adapter classes are one contract, split only by the package.json subpath, so the size is the actual surface of the boundary, not accidental growth. */
/**
 * `@zcode/rust/provider-node` — the Node consumer surface of the ported
 * `packages/provider-node`, over the `zcode-provider-node` binary.
 *
 * Spec: `docs/specs/rust-native-provider-node.md`.
 *
 * This module is a **boundary**, deliberately. The file plane, the network
 * boundary, the cache-path derivation, the refresh cadence and the legacy
 * reasoning resolver all live in Rust — there is no TypeScript implementation
 * left to fall back to, so `loadNative` throwing is the only correct failure
 * (invariant 1). What stays here is the half that is not provider-node's
 * compute at all:
 *
 * - **Hydration.** `@zcode/provider`'s domain objects (`ProviderConfigMap`,
 *   `ModelConfigRules`, …) have methods, and the config service consumes them.
 *   The boundary carries their *file form*, and this module rehydrates it with
 *   the same parse functions the deleted TS codec used — identical bytes, so
 *   identical domain objects. That is not a second implementation: the schema
 *   lives in Rust, and this re-parses what Rust already validated.
 * - **Wiring injected callbacks.** The network (`request`), the legacy import,
 *   the endpoint resolvers, the change listeners: each is a host function the
 *   native side calls back into. This module only passes them through.
 */
import { loadNative } from "./loader.js";

import {
  ModelSelectionFacade,
  ProviderConfigService,
  parsePersonalModelConfigRules,
  parsePersonalProviderConfigMap,
  parseZCodeBuiltinModelConfigRules,
  parseZCodeBuiltinProviderConfigRules,
  type ModelSelection,
  type PersonalProviderConfigRepository,
  type ProviderConfigLayerSnapshot,
  type ProviderConfigLayerUpdate,
  type ProviderRegistryFacadeSource,
  type ProviderRegistryServiceSnapshot,
  type ProviderSource,
} from "@zcode/provider";
import {
  isBuiltinModelProviderId,
  isStartPlanModelProviderId,
  OFF_PEAK_PROVIDER_IDS,
} from "@zcode/shared";

// ---------------------------------------------------------------------------
// The native module
// ---------------------------------------------------------------------------

/** One observer call: a change reason or an error message. */
type Observer = (message: string) => void;

/** The personal snapshot as the native side reports it. */
interface NativeLayerSnapshot {
  revision: string;
  providerConfigRules: unknown;
  modelConfigRules: unknown;
  providerOrder?: string[];
  defaultModelSelection?: ModelSelection;
}

/** One update answer: the file form the transform returns. */
interface NativeLayerUpdate {
  providerConfigRules: unknown;
  modelConfigRules: unknown;
  providerOrder?: string[];
  defaultModelSelection?: ModelSelection;
}

/** The builtin snapshot as the native side reports it. */
interface NativeBuiltinSnapshot {
  revision: string;
  release: unknown;
}

export interface ZCodeBuiltinRefreshEvent {
  readonly result: "updated" | "unchanged" | "stale" | "missing" | "skipped" | "disposed";
  readonly reason?: "lease-held" | "not-due" | "endpoint-changed";
  readonly revision?: number;
}

export interface PersonalProviderConfigRecoveryEvent {
  readonly error: unknown;
}

/**
 * A builtin release as it crosses this boundary: the **stored envelope**
 * (`{ schemaVersion, revision, config: { providerConfigRules, modelConfigRules } }`),
 * decoded natively when it is applied. Not the domain form — nothing outside
 * the native side reads its fields, callers only forward it back.
 */
export interface ZCodeBuiltinRelease {
  readonly schemaVersion: number;
  readonly revision: number;
  readonly config: {
    readonly providerConfigRules: unknown;
    readonly modelConfigRules: unknown;
  };
}

/** The stored `provider_config.json` document shape. */
export interface ProviderConfigFileDocument {
  readonly schemaVersion: 1;
  readonly config: {
    readonly providerOrder?: string[];
    readonly providerConfigRules: unknown;
    readonly modelConfigRules: unknown;
    readonly defaultModelSelection?: ModelSelection;
  };
}

interface NativePersonalProviderConfigRepository {
  read(): Promise<string>;
  update(transform: (current: string) => Promise<string>): Promise<string>;
  saveConfiguredDefault(selectionJson: string | null): Promise<string>;
  subscribe(listener: (message: string) => void): number;
  unsubscribe(id: number): void;
  dispose(): void;
}

interface NativeProviderConfigRuntime {
  readBuiltinSnapshot(): Promise<string>;
  start(): void;
  refreshZcodeBuiltin(force?: boolean): Promise<string>;
  resolveZcodeBuiltinActiveFilePath(): Promise<string>;
  readPersonalSnapshot(): Promise<string>;
  updatePersonal(transform: (current: string) => Promise<string>): Promise<string>;
  saveConfiguredDefault(selectionJson: string | null): Promise<string>;
  subscribe(listener: (message: string) => void): number;
  onDidCheckZcodeBuiltin(listener: () => Promise<string>): number;
  dispose(): void;
}

interface NativeZCodeBuiltinProviderConfigSource {
  read(): Promise<string>;
  applyRemoteRelease(releaseJson: string): Promise<"updated" | "unchanged" | "stale">;
  readonly activeFilePath: string;
  subscribe(listener: (message: string) => void): number;
  unsubscribe(id: number): void;
  dispose(): void;
}

interface NativeProviderNodeModule {
  readonly ZCODE_BUILTIN_PROVIDER_CONFIG_FILE_ENV: string;
  readonly ZCODE_BUILTIN_PROVIDER_BUNDLED_CONFIG_FILE_ENV: string;
  readonly ZCODE_PERSONAL_PROVIDER_CONFIG_FILE_ENV: string;
  readonly PERSONAL_PROVIDER_CONFIG_FILE_NAME: string;
  decodeProviderConfigFile(inputJson: string): string;
  encodeProviderConfigFile(inputJson: string): string;
  decodeZcodeBuiltinRelease(inputJson: string): string;
  serializeZcodeBuiltinRelease(inputJson: string): string;
  materializeZcodeBuiltinProviderConfig(environmentConfigRoot: string, content: string): string;
  resolveZcodeBuiltinClientPlatform(): string;
  createZcodeBuiltinEndpointKey(zcodeEndpointOrigin: string): string;
  normalizeZcodeBuiltinEndpointOrigin(value: string): string;
  resolveZcodeBuiltinCachePaths(optionsJson: string): string;
  createNodeProviderRuntimePathEnv(pathsJson: string): string;
  resolveNodeProviderRuntimePaths(envJson: string): string;
  classifyModelProviderKind(providerId: string): string;
  resolveLegacyReasoningLevel(inputJson: string): string;
  downloadZcodeBuiltinRelease(
    optionsJson: string,
    request: (requestJson: string) => Promise<string>,
    abort: (url: string) => void,
  ): Promise<string>;
  NativePersonalProviderConfigRepository: new (
    filePath: string,
    pollingIntervalMs: number | null,
    importLegacy: ((answerJson: string) => Promise<string | null>) | null,
    onRecovery: Observer | null,
    onPollingError: Observer | null,
  ) => NativePersonalProviderConfigRepository;
  NativeZCodeBuiltinProviderConfigSource: new (
    bundledFilePath: string,
    activeFilePath: string | null,
    watch: boolean,
  ) => NativeZCodeBuiltinProviderConfigSource;
  NativeProviderConfigRuntime: new (
    optionsJson: string,
    importLegacy: ((snapshotJson: string) => Promise<string | null>) | null,
    resolveEndpointKey: (() => Promise<string>) | null,
    resolveEndpointOrigin: (() => Promise<string>) | null,
    fetchRelease: ((endpointKey: string) => Promise<string>) | null,
    onRemoteRefreshError: Observer | null,
    onPersonalRecovery: Observer | null,
    onPersonalPollingError: Observer | null,
    onRefreshResult: ((eventJson: string) => void) | null,
  ) => NativeProviderConfigRuntime;
}

let cached: NativeProviderNodeModule | null = null;

function native(): NativeProviderNodeModule {
  cached ??= loadNative<NativeProviderNodeModule>("zcode-provider-node");
  return cached;
}

// ---------------------------------------------------------------------------
// Hydration — the only place a snapshot becomes a domain object
// ---------------------------------------------------------------------------

/**
 * Rehydrates a personal snapshot. `parsePersonalProviderConfigMap` and
 * `parsePersonalModelConfigRules` are the exact functions
 * `decodeProviderConfigFile` used, so the domain objects are identical to the
 * ones the deleted TS codec produced from the same file.
 */
function hydrateLayer(snapshot: NativeLayerSnapshot): ProviderConfigLayerSnapshot {
  return Object.freeze({
    revision: snapshot.revision,
    providers: parsePersonalProviderConfigMap(snapshot.providerConfigRules as never),
    models: parsePersonalModelConfigRules(snapshot.modelConfigRules as never),
    providerOrder: snapshot.providerOrder,
    ...(snapshot.defaultModelSelection === undefined
      ? {}
      : { defaultModelSelection: snapshot.defaultModelSelection }),
  });
}

/** The inverse direction: a domain update flattened to the file form. */
function dehydrateUpdate(update: ProviderConfigLayerUpdate): NativeLayerUpdate {
  return {
    providerConfigRules: { providerRules: update.providers.toJSON() },
    modelConfigRules: update.models.toPersonalJSON(),
    ...(update.providerOrder === undefined ? {} : { providerOrder: [...update.providerOrder] }),
    ...(update.defaultModelSelection === undefined
      ? {}
      : { defaultModelSelection: update.defaultModelSelection }),
  };
}

/** The builtin snapshot: the release envelope decoded by the same parsers. */
function hydrateBuiltin(snapshot: NativeBuiltinSnapshot): ProviderConfigLayerSnapshot {
  const release = snapshot.release as {
    revision: number;
    config: { providerConfigRules: unknown; modelConfigRules: unknown };
  };
  const { providers, providerTemplates } = parseZCodeBuiltinProviderConfigRules(
    release.config.providerConfigRules as never,
  );
  return Object.freeze({
    revision: snapshot.revision,
    providers,
    providerTemplates,
    models: parseZCodeBuiltinModelConfigRules(release.config.modelConfigRules as never),
  });
}

// ---------------------------------------------------------------------------
// Environment contract (re-exported, natively defined)
// ---------------------------------------------------------------------------

export const ZCODE_BUILTIN_PROVIDER_CONFIG_FILE_ENV =
  native().ZCODE_BUILTIN_PROVIDER_CONFIG_FILE_ENV;
export const ZCODE_BUILTIN_PROVIDER_BUNDLED_CONFIG_FILE_ENV =
  native().ZCODE_BUILTIN_PROVIDER_BUNDLED_CONFIG_FILE_ENV;
export const ZCODE_PERSONAL_PROVIDER_CONFIG_FILE_ENV =
  native().ZCODE_PERSONAL_PROVIDER_CONFIG_FILE_ENV;
export const PERSONAL_PROVIDER_CONFIG_FILE_NAME = native().PERSONAL_PROVIDER_CONFIG_FILE_NAME;

// ---------------------------------------------------------------------------
// The codec
// ---------------------------------------------------------------------------

/** Decodes a stored `provider_config.json` document into an update. */
export function decodeProviderConfigFile(input: unknown): ProviderConfigLayerUpdate {
  const update: NativeLayerUpdate = JSON.parse(
    native().decodeProviderConfigFile(JSON.stringify(input)),
  );
  return Object.freeze({
    providers: parsePersonalProviderConfigMap(update.providerConfigRules as never),
    models: parsePersonalModelConfigRules(update.modelConfigRules as never),
    providerOrder: update.providerOrder,
    ...(update.defaultModelSelection === undefined
      ? {}
      : { defaultModelSelection: update.defaultModelSelection }),
  });
}

/** Encodes an update into the stored document shape. */
export function encodeProviderConfigFile(
  update: ProviderConfigLayerUpdate,
): ProviderConfigFileDocument {
  return JSON.parse(native().encodeProviderConfigFile(JSON.stringify(dehydrateUpdate(update))));
}

/** Validates a builtin release envelope and returns it re-encoded. */
export function decodeZCodeBuiltinRelease(input: unknown): ZCodeBuiltinRelease {
  return JSON.parse(native().decodeZcodeBuiltinRelease(JSON.stringify(input)));
}

export function serializeZCodeBuiltinRelease(release: unknown): string {
  return native().serializeZcodeBuiltinRelease(JSON.stringify(release));
}

// ---------------------------------------------------------------------------
// Materialisation, cache paths, client platform
// ---------------------------------------------------------------------------

export function materializeZCodeBuiltinProviderConfig(options: {
  environmentConfigRoot: string;
  content: string;
}): string {
  return native().materializeZcodeBuiltinProviderConfig(
    options.environmentConfigRoot,
    options.content,
  );
}

export function resolveZCodeBuiltinClientPlatform(): string {
  return native().resolveZcodeBuiltinClientPlatform();
}

export function createZCodeBuiltinEndpointKey(zcodeEndpointOrigin: string): string {
  return native().createZcodeBuiltinEndpointKey(zcodeEndpointOrigin);
}

export function normalizeZCodeBuiltinEndpointOrigin(value: string): string {
  return native().normalizeZcodeBuiltinEndpointOrigin(value);
}

export function resolveZCodeBuiltinCachePaths(options: {
  environmentConfigRoot: string;
  platform: string;
  appVersion: string;
  zcodeEndpointOrigin: string;
}): { activeFilePath: string; controlFilePath: string } {
  return JSON.parse(native().resolveZcodeBuiltinCachePaths(JSON.stringify(options)));
}

// ---------------------------------------------------------------------------
// Runtime path env
// ---------------------------------------------------------------------------

export interface NodeProviderRuntimePaths {
  zcodeBuiltinFilePath: string;
  personalFilePath: string;
}

export function createNodeProviderRuntimePathEnv(
  paths: NodeProviderRuntimePaths,
): Record<string, string> {
  return JSON.parse(native().createNodeProviderRuntimePathEnv(JSON.stringify(paths)));
}

export function resolveNodeProviderRuntimePaths(
  env: Readonly<Record<string, string | undefined>>,
): NodeProviderRuntimePaths | null {
  const subset = {
    [ZCODE_BUILTIN_PROVIDER_CONFIG_FILE_ENV]: env[ZCODE_BUILTIN_PROVIDER_CONFIG_FILE_ENV] ?? null,
    [ZCODE_PERSONAL_PROVIDER_CONFIG_FILE_ENV]: env[ZCODE_PERSONAL_PROVIDER_CONFIG_FILE_ENV] ?? null,
  };
  return JSON.parse(native().resolveNodeProviderRuntimePaths(JSON.stringify(subset)));
}

// ---------------------------------------------------------------------------
// The download boundary
// ---------------------------------------------------------------------------

export interface ZCodeBuiltinDownloadOptions {
  endpointOrigin: string;
  appVersion: string;
  platform: string;
  request: (url: string, init: RequestInit) => Promise<Response>;
  signal?: AbortSignal;
}

/**
 * Downloads the builtin release. The URL, the budget, the schema and the error
 * vocabulary are native; the `request` function is the host's network, which is
 * why the init shape is built here and handed over verbatim — the native side
 * asks for `GET`, `credentials: "omit"`, `redirect: "error"`.
 */
export async function downloadZCodeBuiltinRelease(
  options: ZCodeBuiltinDownloadOptions,
): Promise<ZCodeBuiltinRelease | null> {
  const controller = new AbortController();
  if (options.signal) {
    if (options.signal.aborted) controller.abort(options.signal.reason);
    else
      options.signal.addEventListener("abort", () => controller.abort(options.signal?.reason), {
        once: true,
      });
  }
  const release = native().downloadZcodeBuiltinRelease(
    JSON.stringify({
      endpointOrigin: options.endpointOrigin,
      appVersion: options.appVersion,
      platform: options.platform,
    }),
    // The request crosses as one JSON string: napi hands a tuple `T` to
    // JavaScript as a single array value, so a split signature would arrive as
    // `[url, stage]` in one parameter.
    async (requestJson: string) => {
      const { url, stage } = JSON.parse(requestJson) as {
        url: string;
        stage: string;
      };
      if (controller.signal.aborted) throw new Error("cancelled");
      const response = await options.request(url, {
        method: "GET",
        signal: controller.signal,
        credentials: "omit",
        redirect: "error",
      });
      void stage;
      if (!response.ok) {
        // The status is the answer: the native side owns the taxonomy.
        await response.body?.cancel().catch(() => {});
        return JSON.stringify({ status: response.status, body: "" });
      }
      const body = await response.text();
      return JSON.stringify({ status: response.status, body });
    },
    () => {
      // Budget spent natively; the in-flight request is cancelled here so the
      // socket is not left running.
      controller.abort(new Error("timeout"));
    },
  );
  try {
    const answer = await release;
    return answer === "null" ? null : (JSON.parse(answer) as ZCodeBuiltinRelease);
  } finally {
    controller.abort();
  }
}

// ---------------------------------------------------------------------------
// The personal repository
// ---------------------------------------------------------------------------

export interface NodePersonalProviderConfigRepositoryOptions {
  readonly filePath: string;
  readonly importLegacy?: () => Promise<ProviderConfigLayerUpdate | null>;
  readonly onRecovery?: (event: PersonalProviderConfigRecoveryEvent) => void;
  readonly onPollingError?: (error: unknown) => void;
  readonly pollingIntervalMs?: number | false;
}

/**
 * The personal config file's single owner. Reads, updates, invalidation
 * notifications and the legacy import all go through it; the native side holds
 * the lock, so an `update` transform that arrives late cannot overwrite a newer
 * write.
 */
export class NodePersonalProviderConfigRepository implements PersonalProviderConfigRepository {
  readonly #native: NativePersonalProviderConfigRepository;
  readonly #subscriptions = new Map<number, (reason: string) => void>();
  #disposed = false;

  constructor(options: NodePersonalProviderConfigRepositoryOptions) {
    if (!options.filePath.trim()) {
      throw new Error("Personal Provider Config filePath must not be empty");
    }
    const NativeRepository = native().NativePersonalProviderConfigRepository;
    this.#native = new NativeRepository(
      options.filePath,
      options.pollingIntervalMs === false ? null : (options.pollingIntervalMs ?? 1_000),
      options.importLegacy
        ? async () => {
            const imported = await options.importLegacy!();
            return imported === null ? null : JSON.stringify(dehydrateUpdate(imported));
          }
        : null,
      options.onRecovery ? (message: string) => options.onRecovery!({ error: message }) : null,
      options.onPollingError ? (message: string) => options.onPollingError!(message) : null,
    );
  }

  async read(): Promise<ProviderConfigLayerSnapshot> {
    this.#assertNotDisposed();
    return hydrateLayer(JSON.parse(await this.#native.read()));
  }

  async update(
    transform: (current: ProviderConfigLayerSnapshot) => ProviderConfigLayerUpdate,
  ): Promise<ProviderConfigLayerSnapshot> {
    this.#assertNotDisposed();
    // The transform runs natively, inside the file lock: it receives the locked
    // current content and its answer is validated before the write.
    const snapshot = await this.#native.update(async (currentJson: string) => {
      const next = transform(hydrateLayer(JSON.parse(currentJson)));
      return JSON.stringify(dehydrateUpdate(next));
    });
    return hydrateLayer(JSON.parse(snapshot));
  }

  onDidChange(listener: (reason: string) => void): () => void {
    this.#assertNotDisposed();
    const id = this.#native.subscribe(listener);
    const dispose = () => {
      if (!this.#subscriptions.delete(id)) return;
      this.#native.unsubscribe(id);
    };
    this.#subscriptions.set(id, listener);
    return dispose;
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const id of this.#subscriptions.keys()) this.#native.unsubscribe(id);
    this.#subscriptions.clear();
    this.#native.dispose();
  }

  #assertNotDisposed(): void {
    if (this.#disposed) throw new Error("NodePersonalProviderConfigRepository has been disposed");
  }
}

export function createNodePersonalProviderConfigRepository(
  options: NodePersonalProviderConfigRepositoryOptions,
): NodePersonalProviderConfigRepository {
  return new NodePersonalProviderConfigRepository(options);
}

/** The default selection is one field of the personal file. */
export class NodeModelSelectionConfigRepository {
  readonly #personal: PersonalProviderConfigRepository;
  readonly #subscriptions = new Set<() => void>();
  #disposed = false;

  constructor(options: { readonly personalRepository: PersonalProviderConfigRepository }) {
    this.#personal = options.personalRepository;
  }

  async read(): Promise<ModelSelection | undefined> {
    this.#assertNotDisposed();
    return (await this.#personal.read()).defaultModelSelection;
  }

  async saveConfiguredDefault(
    selection: ModelSelection | undefined,
  ): Promise<ModelSelection | undefined> {
    this.#assertNotDisposed();
    // When the repository is the native one, the transform runs there and the
    // whole layer never round-trips through this process.
    const native = this.#personal as unknown as NativePersonalProviderConfigRepository;
    if (typeof native.saveConfiguredDefault !== "function") {
      const snapshot = await this.#personal.update((current) => ({
        ...current,
        defaultModelSelection: selection,
      }));
      return snapshot.defaultModelSelection;
    }
    const snapshot = hydrateLayer(
      JSON.parse(await native.saveConfiguredDefault(selection ? JSON.stringify(selection) : null)),
    );
    return snapshot.defaultModelSelection;
  }

  onDidChange(listener: (reason: string) => void): () => void {
    this.#assertNotDisposed();
    const unsubscribe = this.#personal.onDidChange(listener);
    const dispose = () => {
      this.#subscriptions.delete(dispose);
      unsubscribe();
    };
    this.#subscriptions.add(dispose);
    return dispose;
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const dispose of this.#subscriptions) dispose();
    // The shared Personal Repository is not destroyed; it is still managed by
    // the Config Runtime life cycle.
  }

  #assertNotDisposed(): void {
    if (this.#disposed) throw new Error("NodeModelSelectionConfigRepository has been disposed");
  }
}

// ---------------------------------------------------------------------------
// The builtin source
// ---------------------------------------------------------------------------

export interface NodeZCodeBuiltinProviderConfigSourceOptions {
  readonly bundledFilePath: string;
  readonly activeFilePath?: string;
  readonly watch?: boolean;
}

/**
 * Bundled, Active/LKG and Remote share one release, published as the config
 * snapshot the service reads. Active is only a cache: an unreadable Active is
 * bypassed for the bundled baseline rather than being able to stop startup.
 */
export class NodeZCodeBuiltinProviderConfigSource implements ProviderSource<ProviderConfigLayerSnapshot> {
  readonly #native: NativeZCodeBuiltinProviderConfigSource;
  readonly #subscriptions = new Map<number, (reason: string) => void>();
  #disposed = false;

  constructor(options: NodeZCodeBuiltinProviderConfigSourceOptions) {
    if (!options.bundledFilePath.trim()) {
      throw new Error("ZCode Built-in bundledFilePath must not be empty");
    }
    const NativeSource = native().NativeZCodeBuiltinProviderConfigSource;
    this.#native = new NativeSource(
      options.bundledFilePath,
      options.activeFilePath?.trim() || null,
      options.watch !== false,
    );
  }

  get activeFilePath(): string {
    return this.#native.activeFilePath;
  }

  async read(): Promise<ProviderConfigLayerSnapshot> {
    this.#assertNotDisposed();
    return hydrateBuiltin(JSON.parse(await this.#native.read()));
  }

  async applyRemoteRelease(release: unknown): Promise<"updated" | "unchanged" | "stale"> {
    this.#assertNotDisposed();
    return this.#native.applyRemoteRelease(JSON.stringify(release));
  }

  onDidChange(listener: (reason: string) => void): () => void {
    this.#assertNotDisposed();
    const id = this.#native.subscribe(listener);
    const dispose = () => {
      if (!this.#subscriptions.delete(id)) return;
      this.#native.unsubscribe(id);
    };
    this.#subscriptions.set(id, listener);
    return dispose;
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const id of this.#subscriptions.keys()) this.#native.unsubscribe(id);
    this.#subscriptions.clear();
    this.#native.dispose();
  }

  #assertNotDisposed(): void {
    if (this.#disposed) {
      throw new Error("NodeZCodeBuiltinProviderConfigSource has been disposed");
    }
  }
}

export function createNodeZCodeBuiltinProviderConfigSource(
  options: NodeZCodeBuiltinProviderConfigSourceOptions,
): NodeZCodeBuiltinProviderConfigSource {
  return new NodeZCodeBuiltinProviderConfigSource(options);
}

export type ApplyZCodeBuiltinReleaseResult = "updated" | "unchanged" | "stale";

// ---------------------------------------------------------------------------
// The runtime
// ---------------------------------------------------------------------------

export interface EndpointScopedZCodeBuiltinSourceOptions {
  readonly bundledFilePath: string;
  readonly environmentConfigRoot: string;
  readonly platform: string;
  readonly appVersion: string;
  readonly resolveEndpointOrigin: () => string | Promise<string>;
  /** The runtime supplies a signal that aborts when the runtime is disposed. */
  readonly fetchRelease: (
    endpointKey: string,
    signal: AbortSignal,
  ) => Promise<ZCodeBuiltinRelease | null>;
  readonly onRefreshResult?: (event: ZCodeBuiltinRefreshEvent) => void;
  readonly watch?: boolean;
}

export interface NodeProviderConfigRuntimeOptions {
  readonly zcodeBuiltinFilePath: string;
  readonly zcodeBuiltinActiveFilePath?: string;
  readonly zcodeBuiltinRemote?: {
    readonly controlFilePath: string;
    readonly resolveEndpointKey: () => string | Promise<string>;
    /** The runtime supplies a signal that aborts when the runtime is disposed. */
    readonly fetchRelease: (
      endpointKey: string,
      signal: AbortSignal,
    ) => Promise<ZCodeBuiltinRelease | null>;
    readonly onRefreshResult?: (event: ZCodeBuiltinRefreshEvent) => void;
    readonly successIntervalMs?: number;
    readonly leaseDurationMs?: number;
    readonly failureBaseDelayMs?: number;
    readonly failureMaxDelayMs?: number;
  };
  readonly zcodeBuiltinEnvironment?: Omit<
    EndpointScopedZCodeBuiltinSourceOptions,
    "bundledFilePath"
  >;
  readonly onZCodeBuiltinRefreshError?: (error: unknown) => void;
  readonly onPersonalConfigRecovery?: (event: PersonalProviderConfigRecoveryEvent) => void;
  readonly onPersonalConfigPollingError?: (error: unknown) => void;
  readonly personalFilePath: string;
  readonly personalPollingIntervalMs?: number | false;
  readonly importLegacy?: (
    zcodeBuiltin: ProviderConfigLayerSnapshot,
  ) => Promise<ProviderConfigLayerUpdate | null>;
  readonly watch?: boolean;
}

/**
 * The personal repository as this runtime exposes it: one native owner, so the
 * config service, the poll loop and every consumer read the same document.
 * The wrapper keeps the `PersonalProviderConfigRepository` interface so callers
 * do not care which owner they hold.
 */
export class RuntimePersonalRepository implements PersonalProviderConfigRepository {
  readonly #native: NativeProviderConfigRuntime;
  readonly #listeners = new Set<(reason: string) => void>();

  constructor(native: NativeProviderConfigRuntime) {
    this.#native = native;
  }

  /** Dispatches a personal reason that arrived through the shared registry. */
  dispatch(reason: string): void {
    for (const listener of this.#listeners) listener(reason);
  }

  async read(): Promise<ProviderConfigLayerSnapshot> {
    return hydrateLayer(JSON.parse(await this.#native.readPersonalSnapshot()));
  }

  async update(
    transform: (current: ProviderConfigLayerSnapshot) => ProviderConfigLayerUpdate,
  ): Promise<ProviderConfigLayerSnapshot> {
    const snapshot = await this.#native.updatePersonal(async (currentJson: string) => {
      const next = transform(hydrateLayer(JSON.parse(currentJson)));
      return JSON.stringify(dehydrateUpdate(next));
    });
    return hydrateLayer(JSON.parse(snapshot));
  }

  /** The native transform for "set the default selection", when it exists. */
  async saveConfiguredDefaultNative(
    selection: ModelSelection | undefined,
  ): Promise<ModelSelection | undefined> {
    const snapshot = hydrateLayer(
      JSON.parse(
        await this.#native.saveConfiguredDefault(selection ? JSON.stringify(selection) : null),
      ),
    );
    return snapshot.defaultModelSelection;
  }

  onDidChange(listener: (reason: string) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  dispose(): void {
    this.#listeners.clear();
  }
}

/** The builtin snapshot as a `ProviderSource`, read through the runtime. */
export class RuntimeBuiltinSource implements ProviderSource<ProviderConfigLayerSnapshot> {
  readonly #native: NativeProviderConfigRuntime;
  readonly #listeners = new Set<(reason: string) => void>();

  constructor(native: NativeProviderConfigRuntime) {
    this.#native = native;
  }

  /** Dispatches a builtin reason that arrived through the shared registry. */
  dispatch(reason: string): void {
    for (const listener of this.#listeners) listener(reason);
  }

  read(): Promise<ProviderConfigLayerSnapshot> {
    return this.#native.readBuiltinSnapshot().then((json) => hydrateBuiltin(JSON.parse(json)));
  }

  onDidChange(listener: (reason: string) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
}

/** The personal reasons the shared native registry carries. */
const PERSONAL_REASONS = new Set(["updated", "poll-changed", "poll-error"]);

/**
 * The built-in/personal config runtime shared inside one process: it owns the
 * sources, the refresh cadence, the periodic check task and the one personal
 * repository. `configService` is the `@zcode/provider` service composed over
 * this runtime's two sources — the same composition the deleted TS runtime
 * performed, over the same single owner.
 */
export class NodeProviderConfigRuntime {
  readonly #native: NativeProviderConfigRuntime;
  readonly #checkListeners = new Map<number, () => Promise<void>>();
  /** Aborted on `dispose`, mirroring the TS synchronizer's AbortController. */
  readonly #fetchAbort = new AbortController();
  #startPromise: Promise<void> | null = null;
  #disposed = false;

  constructor(options: NodeProviderConfigRuntimeOptions) {
    const remote = options.zcodeBuiltinRemote;
    const environment = options.zcodeBuiltinEnvironment;
    const NativeRuntime = native().NativeProviderConfigRuntime;
    this.#native = new NativeRuntime(
      JSON.stringify({
        zcodeBuiltinFilePath: options.zcodeBuiltinFilePath,
        ...(options.zcodeBuiltinActiveFilePath
          ? { zcodeBuiltinActiveFilePath: options.zcodeBuiltinActiveFilePath }
          : {}),
        ...(remote
          ? {
              remote: {
                controlFilePath: remote.controlFilePath,
                ...(remote.successIntervalMs
                  ? { successIntervalMs: remote.successIntervalMs }
                  : {}),
                ...(remote.leaseDurationMs ? { leaseDurationMs: remote.leaseDurationMs } : {}),
                ...(remote.failureBaseDelayMs
                  ? { failureBaseDelayMs: remote.failureBaseDelayMs }
                  : {}),
                ...(remote.failureMaxDelayMs
                  ? { failureMaxDelayMs: remote.failureMaxDelayMs }
                  : {}),
              },
            }
          : {}),
        ...(environment
          ? {
              environment: {
                environmentConfigRoot: environment.environmentConfigRoot,
                platform: environment.platform,
                appVersion: environment.appVersion,
              },
            }
          : {}),
        personalFilePath: options.personalFilePath,
        ...(options.personalPollingIntervalMs === false
          ? { personalPollingIntervalMs: null }
          : options.personalPollingIntervalMs === undefined
            ? {}
            : { personalPollingIntervalMs: options.personalPollingIntervalMs }),
        ...(options.watch === undefined ? {} : { watch: options.watch }),
      }),
      // The rlib supplies the current builtin snapshot to the import, exactly
      // as the TS runtime passed `await builtinSource.read()`.
      options.importLegacy
        ? async (snapshotJson: string) => {
            if (!snapshotJson) return null;
            const builtinSnapshot = hydrateBuiltin(JSON.parse(snapshotJson));
            const imported = await options.importLegacy!(builtinSnapshot);
            return imported === null ? null : JSON.stringify(dehydrateUpdate(imported));
          }
        : null,
      remote ? async () => (await remote.resolveEndpointKey()).trim() : null,
      environment ? async () => (await environment.resolveEndpointOrigin()).trim() : null,
      remote
        ? async (endpointKey: string) => {
            const release = await remote.fetchRelease(endpointKey, this.#fetchAbort.signal);
            return release === null ? "null" : JSON.stringify(release);
          }
        : environment
          ? async (endpointKey: string) => {
              const release = await environment.fetchRelease(endpointKey, this.#fetchAbort.signal);
              return release === null ? "null" : JSON.stringify(release);
            }
          : null,
      options.onZCodeBuiltinRefreshError
        ? (message: string) => options.onZCodeBuiltinRefreshError!(message)
        : null,
      options.onPersonalConfigRecovery
        ? (message: string) => options.onPersonalConfigRecovery!({ error: message })
        : null,
      options.onPersonalConfigPollingError
        ? (message: string) => options.onPersonalConfigPollingError!(message)
        : null,
      remote?.onRefreshResult
        ? (eventJson: string) =>
            remote.onRefreshResult!(JSON.parse(eventJson) as ZCodeBuiltinRefreshEvent)
        : environment?.onRefreshResult
          ? (eventJson: string) =>
              environment.onRefreshResult!(JSON.parse(eventJson) as ZCodeBuiltinRefreshEvent)
          : null,
    );
    this.personalRepository = new RuntimePersonalRepository(this.#native);
    this.zcodeBuiltinSource = new RuntimeBuiltinSource(this.#native);
    // One native subscription; the wrapper dispatches by reason so a personal
    // subscriber never sees a builtin reason and vice versa.
    this.#native.subscribe((reason: string) => {
      if (PERSONAL_REASONS.has(reason)) this.personalRepository.dispatch(reason);
      else this.zcodeBuiltinSource.dispatch(reason);
    });
    this.configService = new ProviderConfigService({
      zcodeBuiltinSource: this.zcodeBuiltinSource,
      personalRepository: this.personalRepository,
    });
  }

  /** The one personal repository; the service reads and updates through it. */
  readonly personalRepository: RuntimePersonalRepository;

  /** The builtin source as `ProviderConfigService` consumes it. */
  readonly zcodeBuiltinSource: RuntimeBuiltinSource;

  /** The composed service — builtin snapshot + personal layer, one owner each. */
  readonly configService: ProviderConfigService;

  async start(): Promise<void> {
    if (this.#disposed) throw new Error("NodeProviderConfigRuntime has been disposed");
    this.#startPromise ??= (async () => {
      // The TS order: the config service reads first, then the background
      // checks arm. A failed first read clears the promise so a retry re-runs.
      try {
        await this.configService.read();
      } catch (error) {
        this.#startPromise = null;
        throw error;
      }
      this.#native.start();
    })();
    return this.#startPromise;
  }

  async refreshZCodeBuiltin(options?: {
    readonly force?: boolean;
  }): Promise<"updated" | "unchanged" | "stale" | "missing" | "skipped" | "disposed"> {
    if (this.#disposed) return "disposed";
    const result = await this.#native.refreshZcodeBuiltin(options?.force === true);
    return result as "updated" | "unchanged" | "stale" | "missing" | "skipped" | "disposed";
  }

  resolveZCodeBuiltinActiveFilePath(): Promise<string> {
    return this.#native.resolveZcodeBuiltinActiveFilePath();
  }

  /** Environment restores unaligned dependencies within the same periodic
   * check — not blocked by the download TTL or by a failure. */
  onDidCheckZCodeBuiltin(listener: () => Promise<void>): () => void {
    const id = this.#native.onDidCheckZcodeBuiltin(async () => {
      await listener();
      return "";
    });
    const dispose = () => {
      this.#checkListeners.delete(id);
    };
    this.#checkListeners.set(id, listener);
    return dispose;
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    // Cancels any in-flight fetch, as the TS synchronizer's controller did.
    this.#fetchAbort.abort(new Error("NodeProviderConfigRuntime disposed"));
    this.#checkListeners.clear();
    this.personalRepository.dispose();
    this.configService.dispose();
    this.#native.dispose();
  }
}

export function createNodeProviderConfigRuntime(
  options: NodeProviderConfigRuntimeOptions,
): NodeProviderConfigRuntime {
  return new NodeProviderConfigRuntime(options);
}

// ---------------------------------------------------------------------------
// Model selection classification and the legacy reasoning level
// ---------------------------------------------------------------------------

/** How the facade classifies a provider identity. */
export type ProviderKind = "ordinary" | "account-plan" | "account-offpeak";

/**
 * The host and the managed worker share the same identity classification.
 * Start is resolved by its real id and cannot join the paid-connection
 * uniqueness judgment, so it is decided before the account-plan branch.
 */
export function classifyModelProviderKind(providerId: string): ProviderKind {
  return native().classifyModelProviderKind(providerId) as ProviderKind;
}

/**
 * Restores the historic Built-in `reasoningLevel` value range for old
 * selections. It exists only to map `off`/`nothink` back to `disabled` for
 * models that used to publish it; it never relaxes validation elsewhere.
 *
 * The inputs are the snapshot facts the deleted TS resolver read off the
 * registry snapshot: the selection, the personal and builtin model rules in
 * their file form, and the effective provider facts.
 */
export function resolveLegacyReasoningLevel(input: {
  readonly selection: ModelSelection;
  readonly personalModelRules: unknown;
  readonly builtinModelRules: unknown;
  readonly providers: readonly {
    readonly providerId: string;
    readonly templateId?: string | null;
    readonly apiType?: string | null;
    readonly baseUrl?: string | null;
  }[];
}): string | undefined {
  const answer = native().resolveLegacyReasoningLevel(
    JSON.stringify({
      selection: input.selection,
      personalModelRules: input.personalModelRules,
      builtinModelRules: input.builtinModelRules,
      providers: input.providers,
    }),
  );
  return answer === "null" ? undefined : answer;
}

/**
 * The snapshot facts the native resolver needs, projected off a registry
 * snapshot. The two rule sets cross as their file form (the same
 * `toPersonalJSON` / `toZCodeBuiltinJSON` the codecs used), and each effective
 * provider contributes its template and api facts — everything the resolver
 * used to read off the domain objects.
 */
function legacyReasoningInputs(snapshot: RegistrySnapshotLike, selection: ModelSelection) {
  const providers = snapshot.resolution.effectiveProviders.rules().map((rule) => {
    const config = snapshot.resolution.effectiveProviders.get(rule.providerId);
    return {
      providerId: rule.providerId,
      templateId: rule.templateId ?? null,
      apiType: config?.api?.type ?? null,
      baseUrl: config?.api?.baseUrl ?? null,
    };
  });
  return {
    selection,
    personalModelRules: snapshot.config.personalModels.toPersonalJSON(),
    builtinModelRules: snapshot.config.zcodeBuiltinModelRules.toZCodeBuiltinJSON(),
    providers,
  };
}

/** The snapshot shape this module reads; the concrete type is `@zcode/provider`'s. */
interface RegistrySnapshotLike {
  readonly config: {
    readonly personalModels: { toPersonalJSON(): unknown };
    readonly zcodeBuiltinModelRules: { toZCodeBuiltinJSON(): unknown };
  };
  readonly resolution: {
    readonly effectiveProviders: {
      rules(): readonly { providerId: string; templateId?: string | null }[];
      get(providerId: string): { api?: { type?: string; baseUrl?: string } | null } | undefined;
    };
  };
}

/**
 * Assembles the `@zcode/provider` `ModelSelectionFacade` with the native
 * classification and the native legacy-reasoning resolver. The facade class
 * itself stays TypeScript (spec §2) — its view assembly is `@zcode/provider`'s
 * compute, not provider-node's — so what this function owns is the two
 * decisions provider-node contributed.
 */
export function createNodeModelSelectionFacade(
  source: ProviderRegistryFacadeSource,
): ModelSelectionFacade {
  return new ModelSelectionFacade(
    source,
    classifyModelProviderKind,
    (snapshot: ProviderRegistryServiceSnapshot, selection: ModelSelection) =>
      resolveLegacyReasoningLevel(
        legacyReasoningInputs(snapshot as unknown as RegistrySnapshotLike, selection),
      ),
  );
}

/**
 * The parity assertion for the classification table the native side mirrors.
 * `@zcode/shared` owns the identity tables; this exists so the mirror cannot
 * drift without a failing check rather than a silent behaviour change.
 */
export function classificationMatchesSharedProviderIds(): boolean {
  // The TS closure's decision order, restated from `@zcode/shared`: Start by
  // its real id first (it never joins the paid-connection judgment), then the
  // account-plan table, then the off-peak pair.
  const classifyViaShared = (id: string): ProviderKind => {
    if (isStartPlanModelProviderId(id)) return "ordinary";
    if (isBuiltinModelProviderId(id)) return "account-plan";
    if (Object.values(OFF_PEAK_PROVIDER_IDS).some((offPeak) => offPeak === id)) {
      return "account-offpeak";
    }
    return "ordinary";
  };
  const candidates = [
    ...Object.values(OFF_PEAK_PROVIDER_IDS),
    "account:zai-individual-coding-plan",
    "account:zai-team-coding-plan",
    "account:zai-start-plan",
    "account:bigmodel-individual-coding-plan",
    "account:bigmodel-team-coding-plan",
    "account:bigmodel-start-plan",
    "custom:api-key",
    "builtin:zai",
    "account:unknown-plan",
  ];
  return candidates.every((id) => classifyModelProviderKind(id) === classifyViaShared(id));
}
