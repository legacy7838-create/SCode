import type { ProviderConfigLayerSnapshot, ProviderSource } from "@zcode/provider";
import {
  normalizeZCodeBuiltinEndpointOrigin,
  resolveZCodeBuiltinCachePaths,
} from "./zcode-builtin-cache-paths.js";
import { NodeZCodeBuiltinProviderConfigSource } from "./zcode-builtin-provider-config-source.js";
import {
  ZCodeBuiltinRemoteSynchronizer,
  type ZCodeBuiltinRefreshResult,
  type ZCodeBuiltinRemoteSynchronizerOptions,
} from "./zcode-builtin-remote-synchronizer.js";

export interface EndpointScopedZCodeBuiltinSourceOptions {
  readonly bundledFilePath: string;
  readonly environmentConfigRoot: string;
  readonly platform: string;
  readonly appVersion: string;
  readonly resolveEndpointOrigin: () => string | Promise<string>;
  readonly fetchRelease: ZCodeBuiltinRemoteSynchronizerOptions["fetchRelease"];
  readonly onRefreshResult?: ZCodeBuiltinRemoteSynchronizerOptions["onRefreshResult"];
  readonly watch?: boolean;
}

/**
 * Lets the Environment's ZCode control-plane Endpoint determine both the Active/LKG pair and the
 * refresh control path. Switching Endpoints only replaces the current Source; it never reads the
 * previous Endpoint's cache.
 */
export class EndpointScopedZCodeBuiltinSource implements ProviderSource<ProviderConfigLayerSnapshot> {
  readonly #options: EndpointScopedZCodeBuiltinSourceOptions;
  readonly #listeners = new Set<(reason: string) => void>();
  #current: CurrentEndpointSource | null = null;
  #ensureInFlight: Promise<CurrentEndpointSource> | null = null;
  #disposed = false;

  constructor(options: EndpointScopedZCodeBuiltinSourceOptions) {
    this.#options = options;
  }

  async read(): Promise<ProviderConfigLayerSnapshot> {
    return (await this.#ensureCurrent()).source.read();
  }

  onDidChange(listener: (reason: string) => void): () => void {
    this.#assertNotDisposed();
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async refresh(options?: { readonly force?: boolean }): Promise<ZCodeBuiltinRefreshResult> {
    return (await this.#ensureCurrent()).synchronizer.refresh(options);
  }

  /** Returns the fully materialized Active Config path for the current Environment Endpoint. */
  async resolveActiveFilePath(): Promise<string> {
    return (await this.#ensureCurrent()).activeFilePath;
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#current?.dispose();
    this.#current = null;
    this.#listeners.clear();
  }

  async #ensureCurrent(): Promise<CurrentEndpointSource> {
    this.#assertNotDisposed();
    if (this.#ensureInFlight) return this.#ensureInFlight;
    const ensure = this.#resolveCurrent().finally(() => {
      if (this.#ensureInFlight === ensure) this.#ensureInFlight = null;
    });
    this.#ensureInFlight = ensure;
    return ensure;
  }

  async #resolveCurrent(): Promise<CurrentEndpointSource> {
    const endpointOrigin = normalizeZCodeBuiltinEndpointOrigin(
      await this.#options.resolveEndpointOrigin(),
    );
    const paths = resolveZCodeBuiltinCachePaths({
      environmentConfigRoot: this.#options.environmentConfigRoot,
      platform: this.#options.platform,
      appVersion: this.#options.appVersion,
      zcodeEndpointOrigin: endpointOrigin,
    });
    if (this.#current?.activeFilePath === paths.activeFilePath) return this.#current;

    const source = new NodeZCodeBuiltinProviderConfigSource({
      bundledFilePath: this.#options.bundledFilePath,
      activeFilePath: paths.activeFilePath,
      watch: this.#options.watch,
    });
    const sourceDispose = source.onDidChange((reason) => this.#emit(reason));
    const synchronizer = new ZCodeBuiltinRemoteSynchronizer({
      source,
      controlFilePath: paths.controlFilePath,
      resolveEndpointKey: async () =>
        normalizeZCodeBuiltinEndpointOrigin(await this.#options.resolveEndpointOrigin()),
      fetchRelease: this.#options.fetchRelease,
      onRefreshResult: this.#options.onRefreshResult,
    });
    try {
      await source.read();
      this.#assertNotDisposed();
    } catch (error) {
      sourceDispose();
      synchronizer.dispose();
      source.dispose();
      throw error;
    }

    const previous = this.#current;
    const current = new CurrentEndpointSource(
      paths.activeFilePath,
      source,
      synchronizer,
      sourceDispose,
    );
    this.#current = current;
    previous?.dispose();
    if (previous) this.#emit("endpoint-changed");
    return current;
  }

  #emit(reason: string): void {
    if (this.#disposed) return;
    for (const listener of this.#listeners) listener(reason);
  }

  #assertNotDisposed(): void {
    if (this.#disposed) throw new Error("EndpointScopedZCodeBuiltinSource has been disposed");
  }
}

class CurrentEndpointSource {
  constructor(
    readonly activeFilePath: string,
    readonly source: NodeZCodeBuiltinProviderConfigSource,
    readonly synchronizer: ZCodeBuiltinRemoteSynchronizer,
    readonly sourceDispose: () => void,
  ) {}

  dispose(): void {
    this.sourceDispose();
    this.synchronizer.dispose();
    this.source.dispose();
  }
}
