import { create } from "zustand";
import type {
  ZCodeAvailablePluginSummary,
  ZCodeInstalledPluginSummary,
  ZCodePluginDiagnostic,
  ZCodePluginInfo,
  ZCodePluginMarketplaceSummary,
  ZCodePluginScope,
  ZCodePluginsDescribeResult,
} from "@zcode/shared";
import type { IPluginManagementService } from "@zcode/services";
import { logger } from "@/logger.js";
import { loadInto, runWorkspaceOperation } from "@/store/pluginManagementStoreLoading.js";
import { setPluginEnabledOptimistically } from "@/store/pluginManagementStoreEnabled.js";

// The component list cache of market details pulled on demand: record loading/data/error according to pluginId to avoid repeated requests and switching flickers.
export interface PluginDescribeEntry {
  status: "loading" | "loaded" | "error";
  data?: ZCodePluginsDescribeResult;
  error?: string;
}

// Data source of "Plug-in Management" in the settings page: provided by zcode-cli via IPluginManagementService (list + enable/disable).
// The UI no longer touches IZCodeAgentService directly; consumption of the old protocol words under plugins/* is gathered into the service implementation.
// It has nothing to do with the retired marketplace pluginStore, so a separate simplified store is built.
export interface PluginManagementState {
  workspacePath: string | null;
  workspaceIdentity: string | null;
  configScope: ZCodePluginScope | null;
  plugins: ZCodePluginInfo[];
  marketplaces: ZCodePluginMarketplaceSummary[];
  /** Whether the latest overview was successful; false indicates that the existence of the source is unknown and the isolated state cannot be deduced. */
  marketplaceAvailabilityKnown: boolean;
  availablePlugins: ZCodeAvailablePluginSummary[];
  installedPlugins: ZCodeInstalledPluginSummary[];
  restorableBuiltins: ZCodeAvailablePluginSummary[];
  diagnostics: ZCodePluginDiagnostic[];
  loading: boolean;
  error: string | null;
  /**
   * The plug-in that belongs to the latest failed operation: if the operation with pluginId (such as setEnabled) fails, write this
   * id; write null for operations without plug-in targets (marketplace add/update/validate, list loading, refresh).
   * Consumers (CUA input box buttons, etc.) should only treat errors that "the target is themselves" as their own errors and avoid sharing
   * The error field mismaps unrelated failures into its own error state.
   */
  lastFailedPluginId: string | null;
  togglingPluginId: string | null;
  operationId: string | null;
  operationVersion: number;
  describeCache: Record<string, PluginDescribeEntry>;
  initialize: (params: {
    workspacePath: string;
    workspaceIdentity?: string;
    configScope?: ZCodePluginScope;
    pluginService: IPluginManagementService;
  }) => Promise<void>;
  refresh: (pluginService: IPluginManagementService) => Promise<void>;
  addMarketplace: (source: string, pluginService: IPluginManagementService) => Promise<boolean>;
  updateMarketplace: (
    marketplace: string | null,
    pluginService: IPluginManagementService,
  ) => Promise<boolean>;
  removeMarketplace: (
    marketplace: string,
    pluginService: IPluginManagementService,
  ) => Promise<void>;
  installPlugin: (
    pluginName: string,
    marketplace: string,
    pluginService: IPluginManagementService,
    scope?: ZCodePluginScope,
  ) => Promise<void>;
  uninstallPlugin: (
    pluginId: string,
    pluginService: IPluginManagementService,
    removeCache?: boolean,
  ) => Promise<void>;
  updatePlugin: (pluginId: string, pluginService: IPluginManagementService) => Promise<void>;
  restoreBuiltin: (pluginId: string, pluginService: IPluginManagementService) => Promise<void>;
  configurePlugin: (
    pluginId: string,
    options: Record<string, string | number | boolean>,
    pluginService: IPluginManagementService,
    scope?: ZCodePluginScope,
    clearOptionKeys?: string[],
  ) => Promise<boolean>;
  resetPluginConfig: (
    pluginId: string,
    pluginService: IPluginManagementService,
    scope?: ZCodePluginScope,
  ) => Promise<boolean>;
  validateSource: (source: string, pluginService: IPluginManagementService) => Promise<void>;
  setEnabled: (
    pluginId: string,
    enabled: boolean,
    pluginService: IPluginManagementService,
    scope?: ZCodePluginScope,
  ) => Promise<boolean>;
  // Pull the plug-in component list (name + description) on demand; force skips caching and retries.
  describePlugin: (
    pluginId: string,
    pluginName: string,
    marketplace: string,
    pluginService: IPluginManagementService,
    force?: boolean,
  ) => Promise<void>;
}

function toMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function throwForErrorDiagnostic(diagnostics: ZCodePluginDiagnostic[]): void {
  const blockingDiagnostic = diagnostics.find((diagnostic) => diagnostic.severity === "error");
  if (blockingDiagnostic) {
    throw new Error(blockingDiagnostic.message);
  }
}

export const usePluginManagementStore = create<PluginManagementState>((set, get) => ({
  workspacePath: null,
  workspaceIdentity: null,
  configScope: null,
  plugins: [],
  marketplaces: [],
  marketplaceAvailabilityKnown: false,
  availablePlugins: [],
  installedPlugins: [],
  restorableBuiltins: [],
  diagnostics: [],
  loading: false,
  error: null,
  lastFailedPluginId: null,
  togglingPluginId: null,
  operationId: null,
  operationVersion: 0,
  describeCache: {},

  async initialize({ workspacePath, workspaceIdentity, configScope, pluginService }) {
    const normalizedIdentity = workspaceIdentity?.trim() || null;
    const normalizedConfigScope = configScope ?? null;
    const current = get();
    const contextChanged =
      current.workspacePath !== workspacePath ||
      current.workspaceIdentity !== normalizedIdentity ||
      current.configScope !== normalizedConfigScope;
    const hasCache =
      current.plugins.length > 0 &&
      current.workspacePath === workspacePath &&
      current.workspaceIdentity === normalizedIdentity &&
      current.configScope === normalizedConfigScope;
    set({
      workspacePath,
      workspaceIdentity: normalizedIdentity,
      configScope: normalizedConfigScope,
      // When there is cache, refresh and retain the list in the background to avoid flickering when switching workspaces; only when there is no cache, the blocked loading will be displayed.
      loading: !hasCache,
      marketplaceAvailabilityKnown: hasCache ? current.marketplaceAvailabilityKnown : false,
      error: null,
      lastFailedPluginId: null,
      // The overview refresh after the configuration is saved may not have finished yet, and the user has switched to another level of configuration view;
      // The operationId of the old layer cannot continue to gray out the input controls of the new layer. Prevented by version number when old operations end
      // It mistakenly cleans the new layer by later launching an operation of the same name.
      ...(contextChanged ? { operationId: null } : {}),
    });
    await loadInto(set, get, {
      workspacePath,
      workspaceIdentity: normalizedIdentity,
      configScope: normalizedConfigScope,
      pluginService,
    });
  },

  async refresh(pluginService) {
    const { workspacePath, workspaceIdentity, configScope } = get();
    if (!workspacePath) {
      return;
    }
    set({ error: null, lastFailedPluginId: null });
    await loadInto(set, get, {
      workspacePath,
      workspaceIdentity,
      configScope,
      pluginService,
    });
  },

  async addMarketplace(source, pluginService) {
    return runWorkspaceOperation(
      set,
      get,
      pluginService,
      `marketplace:add:${source}`,
      async (workspace) => {
        await pluginService.addPluginMarketplace({
          ...workspace,
          source,
        });
      },
    );
  },

  async updateMarketplace(marketplace, pluginService) {
    let refreshError: string | null = null;
    const succeeded = await runWorkspaceOperation(
      set,
      get,
      pluginService,
      `marketplace:update:${marketplace ?? "__all__"}`,
      async (workspace) => {
        const result = await pluginService.updatePluginMarketplace({
          ...workspace,
          ...(marketplace ? { marketplace } : {}),
        });
        // Refresh allows partial success, so reload overview still retains the success source; but only warns
        // and returns true, the desktop and mobile web will falsely report the old snapshot as a refresh success. Remember the error first, reload and then write
        // Share the visible error state of the store and return false at the same time, allowing all entries to obtain consistent partial failure semantics.
        const blockingDiagnostic = result.diagnostics?.find(
          (diagnostic) => diagnostic.severity === "error",
        );
        if (blockingDiagnostic) {
          refreshError = blockingDiagnostic.message;
          logger.warn("[plugins] marketplace refresh partially failed", {
            diagnostics: result.diagnostics,
          });
        }
      },
    );
    if (succeeded && refreshError) {
      // The list refresh failed and there is no plug-in target, and the ownership is cleared (does not point to any plug-in).
      set({ error: refreshError, lastFailedPluginId: null });
      return false;
    }
    return succeeded;
  },

  async removeMarketplace(marketplace, pluginService) {
    await runWorkspaceOperation(
      set,
      get,
      pluginService,
      `marketplace:remove:${marketplace}`,
      async (workspace) => {
        await pluginService.removePluginMarketplace({
          ...workspace,
          marketplace,
        });
      },
    );
  },

  async installPlugin(pluginName, marketplace, pluginService, scope = "user") {
    await runWorkspaceOperation(
      set,
      get,
      pluginService,
      `plugin:install:${pluginName}@${marketplace}`,
      async (workspace) => {
        const result = await pluginService.installPlugin({
          ...workspace,
          pluginName,
          marketplace,
          scope,
        });
        // CLI To preserve structured diagnostics, a successful RPC envelope will be returned on failed installations.
        // and put the actual errors into diagnostics. The old UI ignores the return value and continues to refresh, making it look like the button is unresponsive.
        // There are no error and retry entries; here the error diagnostic converges to the existing operation error state.
        throwForErrorDiagnostic(result.diagnostics);
      },
    );
  },

  async uninstallPlugin(pluginId, pluginService, removeCache = true) {
    await runWorkspaceOperation(
      set,
      get,
      pluginService,
      `plugin:uninstall:${pluginId}`,
      async (workspace) => {
        await pluginService.uninstallPlugin({
          ...workspace,
          pluginId,
          removeCache,
        });
      },
    );
  },

  async updatePlugin(pluginId, pluginService) {
    await runWorkspaceOperation(
      set,
      get,
      pluginService,
      `plugin:update:${pluginId}`,
      async (workspace) => {
        const result = await pluginService.updatePlugin({ ...workspace, pluginId });
        // update shares the same diagnostic failure contract as install. After throwing into runWorkspaceOperation it will not
        // Overwrites the current overview, so the old version and update badge are retained until the user retries successfully.
        throwForErrorDiagnostic(result.diagnostics);
      },
    );
  },

  async restoreBuiltin(pluginId, pluginService) {
    await runWorkspaceOperation(
      set,
      get,
      pluginService,
      `plugin:restore:${pluginId}`,
      async (workspace) => {
        await pluginService.restoreBuiltinPlugin({ ...workspace, pluginId });
      },
    );
  },

  async configurePlugin(pluginId, options, pluginService, scope = "user", clearOptionKeys = []) {
    return await runWorkspaceOperation(
      set,
      get,
      pluginService,
      `plugin:configure:${pluginId}`,
      async (workspace) => {
        await pluginService.configurePlugin({
          ...workspace,
          pluginId,
          options,
          scope,
          ...(clearOptionKeys.length > 0 ? { clearOptionKeys } : {}),
        });
      },
    );
  },

  async resetPluginConfig(pluginId, pluginService, scope = "workspace") {
    return await runWorkspaceOperation(
      set,
      get,
      pluginService,
      `plugin:reset-config:${pluginId}`,
      async (workspace) => {
        await pluginService.resetPluginConfig({
          ...workspace,
          pluginId,
          scope,
        });
      },
    );
  },

  async validateSource(source, pluginService) {
    const { workspacePath, workspaceIdentity } = get();
    if (!workspacePath) return;
    set({ operationId: `marketplace:validate:${source}`, error: null });
    try {
      const result = await pluginService.validatePlugin({
        workspacePath,
        ...(workspaceIdentity ? { workspaceIdentity } : {}),
        source,
      });
      set({ diagnostics: result.diagnostics });
    } catch (error) {
      logger.error("[plugins] validate source failed", { source, error: toMessage(error) });
      set({ error: toMessage(error), lastFailedPluginId: null });
    } finally {
      set({ operationId: null });
    }
  },

  async setEnabled(pluginId, enabled, pluginService, scope = "user") {
    return setPluginEnabledOptimistically(set, get, pluginId, enabled, pluginService, scope);
  },

  async describePlugin(pluginId, pluginName, marketplace, pluginService, force = false) {
    const { workspacePath, workspaceIdentity, describeCache } = get();
    if (!workspacePath) return;
    const cached = describeCache[pluginId];
    // The cache is hit when loaded or loading, and the request is not repeated; forced retry when force is used.
    if (!force && cached && cached.status !== "error") return;
    set({
      describeCache: { ...get().describeCache, [pluginId]: { status: "loading" } },
    });
    try {
      const data = await pluginService.describePlugin({
        workspacePath,
        ...(workspaceIdentity ? { workspaceIdentity } : {}),
        marketplace,
        pluginName,
      });
      const blockingDiagnostic = data.diagnostics?.find(
        (diagnostic) => diagnostic.severity === "error",
      );
      if (data.components.length === 0 && blockingDiagnostic) {
        // The CLI's describe uses diagnostics return packets instead of RPC reject for unresolvable sources.
        // The old UI caches the return packet as loaded, and the details are only blank and there is never a retry entry; there will be no component here
        // Error diagnostic is mapped to a recoverable error state while retaining normal partial successful return packets.
        set({
          describeCache: {
            ...get().describeCache,
            [pluginId]: { status: "error", error: blockingDiagnostic.message },
          },
        });
        return;
      }
      set({
        describeCache: {
          ...get().describeCache,
          [pluginId]: { status: "loaded", data },
        },
      });
    } catch (error) {
      logger.error("[plugins] describe failed", {
        pluginId,
        marketplace,
        error: toMessage(error),
      });
      set({
        describeCache: {
          ...get().describeCache,
          [pluginId]: { status: "error", error: toMessage(error) },
        },
      });
    }
  },
}));
