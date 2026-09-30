/* eslint-disable max-lines -- the plugin marketplace, install, uninstall, and enable/disable state
 * have to be maintained in one place so that state for concurrent operations does not scatter
 */
import { create } from "zustand";
import type {
  AvailablePluginSummary,
  InstalledPluginSummary,
  PluginMarketplaceSummary,
  PluginScope,
  PluginsCapability,
} from "@zcode/shared";
import type { IPluginsService } from "@zcode/services";
import { logger } from "@/logger.js";

function buildPluginOperationId(
  scope: PluginScope,
  pluginName: string,
  marketplace: string,
): string {
  return `${scope}:${pluginName}@${marketplace}`;
}

interface PluginStoreState {
  workspacePath: string | null;
  workspaceIdentity: string | null;
  loadedWorkspacePath: string | null;
  loadedWorkspaceIdentity: string | null;
  marketplaces: PluginMarketplaceSummary[];
  availablePlugins: AvailablePluginSummary[];
  installedPlugins: InstalledPluginSummary[];
  capability: PluginsCapability | null;
  loading: boolean;
  refreshing: boolean;
  error: string | null;
  addingMarketplaceSource: string | null;
  removingMarketplaceName: string | null;
  updatingMarketplaceName: string | null;
  installingPluginId: string | null;
  uninstallingPluginId: string | null;
  settingPluginEnabledId: string | null;
  settingPluginEnabledValue: boolean | null;
  initialize: (
    workspacePath: string,
    pluginsService: IPluginsService,
    workspaceIdentity?: string,
  ) => Promise<void>;
  refresh: (pluginsService: IPluginsService, workspaceIdentity?: string) => Promise<void>;
  addMarketplace: (
    source: string,
    pluginsService: IPluginsService,
    workspaceIdentity?: string,
  ) => Promise<boolean>;
  removeMarketplace: (
    marketplace: string,
    pluginsService: IPluginsService,
    workspaceIdentity?: string,
  ) => Promise<boolean>;
  updateMarketplace: (
    marketplace: string | null,
    pluginsService: IPluginsService,
    workspaceIdentity?: string,
  ) => Promise<boolean>;
  installPlugin: (
    pluginName: string,
    marketplace: string,
    scopeOrPluginsService: InstalledPluginSummary["scope"] | IPluginsService,
    maybePluginsService?: IPluginsService,
    workspaceIdentity?: string,
  ) => Promise<boolean>;
  uninstallPlugin: (
    pluginName: string,
    marketplace: string,
    scopeOrPluginsService: InstalledPluginSummary["scope"] | IPluginsService,
    maybePluginsService?: IPluginsService,
    workspaceIdentity?: string,
  ) => Promise<boolean>;
  setPluginEnabled: (
    pluginName: string,
    marketplace: string,
    scopeOrEnabled: InstalledPluginSummary["scope"] | boolean,
    enabledOrPluginsService: boolean | IPluginsService,
    maybePluginsService?: IPluginsService,
    workspaceIdentity?: string,
    nativeScope?: InstalledPluginSummary["nativeScope"],
  ) => Promise<boolean>;
  resetWorkspaceContext: () => void;
}

export const usePluginStore = create<PluginStoreState>((set, get) => ({
  workspacePath: null,
  workspaceIdentity: null,
  loadedWorkspacePath: null,
  loadedWorkspaceIdentity: null,
  marketplaces: [],
  availablePlugins: [],
  installedPlugins: [],
  capability: null,
  loading: false,
  refreshing: false,
  error: null,
  addingMarketplaceSource: null,
  removingMarketplaceName: null,
  updatingMarketplaceName: null,
  installingPluginId: null,
  uninstallingPluginId: null,
  settingPluginEnabledId: null,
  settingPluginEnabledValue: null,
  resetWorkspaceContext() {
    set({
      workspacePath: null,
      workspaceIdentity: null,
      loadedWorkspacePath: null,
      loadedWorkspaceIdentity: null,
      marketplaces: [],
      availablePlugins: [],
      installedPlugins: [],
      capability: null,
      loading: false,
      refreshing: false,
      error: null,
      addingMarketplaceSource: null,
      removingMarketplaceName: null,
      updatingMarketplaceName: null,
      installingPluginId: null,
      uninstallingPluginId: null,
      settingPluginEnabledId: null,
      settingPluginEnabledValue: null,
    });
  },
  async initialize(
    workspacePath: string,
    pluginsService: IPluginsService,
    workspaceIdentity?: string,
  ) {
    const currentState = get();
    const normalizedWorkspaceIdentity = workspaceIdentity?.trim() || null;
    const hasCachedData =
      currentState.loadedWorkspacePath === workspacePath &&
      currentState.loadedWorkspaceIdentity === normalizedWorkspaceIdentity &&
      (currentState.marketplaces.length > 0 ||
        currentState.availablePlugins.length > 0 ||
        currentState.installedPlugins.length > 0 ||
        currentState.capability !== null);
    // Remote workspaces with the same path will share the same workspacePath.
    // If the plug-in cache is only reused by path, the market and switch status of the previous machine will be briefly displayed to the current remote end.
    // Here, workspaceIdentity is included in the hit condition to ensure strict isolation of different hosts on the same path.
    set({
      workspacePath,
      workspaceIdentity: normalizedWorkspaceIdentity,
      marketplaces: hasCachedData ? currentState.marketplaces : [],
      availablePlugins: hasCachedData ? currentState.availablePlugins : [],
      installedPlugins: hasCachedData ? currentState.installedPlugins : [],
      capability: hasCachedData ? currentState.capability : null,
      loading: !hasCachedData,
      refreshing: false,
      error: null,
    });
    try {
      const result = await pluginsService.getOverview({
        workspacePath,
        ...(normalizedWorkspaceIdentity ? { workspaceIdentity: normalizedWorkspaceIdentity } : {}),
      });
      set({
        marketplaces: result.marketplaces,
        availablePlugins: result.availablePlugins,
        installedPlugins: result.installedPlugins,
        capability: result.capability,
        loading: false,
        refreshing: false,
        loadedWorkspacePath: workspacePath,
        loadedWorkspaceIdentity: normalizedWorkspaceIdentity,
      });
    } catch (error) {
      set({
        loading: false,
        refreshing: false,
        error: error instanceof Error ? error.message : String(error),
        loadedWorkspacePath: workspacePath,
        loadedWorkspaceIdentity: normalizedWorkspaceIdentity,
      });
    }
  },
  async refresh(pluginsService: IPluginsService, workspaceIdentity?: string) {
    const workspacePath = get().workspacePath;
    if (!workspacePath) {
      return;
    }
    const workspaceIdentityFromState =
      workspaceIdentity?.trim() || get().workspaceIdentity || undefined;
    const state = get();
    const hasCachedData =
      state.marketplaces.length > 0 ||
      state.availablePlugins.length > 0 ||
      state.installedPlugins.length > 0;
    // After the plug-in is switched/uninstalled, refresh will occur. Forced loading=true before will cause the list to be cut to an empty state and then restored, causing a "flash".
    // Here, the existing list is retained for background refresh, and loading is only displayed when there is no cached data for the first time.
    set({ loading: !hasCachedData, refreshing: true, error: null });
    try {
      const result = await pluginsService.getOverview({
        workspacePath,
        ...(workspaceIdentityFromState ? { workspaceIdentity: workspaceIdentityFromState } : {}),
      });
      set({
        marketplaces: result.marketplaces,
        availablePlugins: result.availablePlugins,
        installedPlugins: result.installedPlugins,
        capability: result.capability,
        loading: false,
        refreshing: false,
        loadedWorkspacePath: workspacePath,
        loadedWorkspaceIdentity: workspaceIdentityFromState ?? null,
      });
    } catch (error) {
      set({
        loading: false,
        refreshing: false,
        error: error instanceof Error ? error.message : String(error),
        loadedWorkspacePath: workspacePath,
        loadedWorkspaceIdentity: workspaceIdentityFromState ?? null,
      });
    }
  },
  async addMarketplace(
    source: string,
    pluginsService: IPluginsService,
    workspaceIdentity?: string,
  ) {
    const workspacePath = get().workspacePath;
    const trimmedSource = source.trim();
    if (!workspacePath || !trimmedSource) {
      return false;
    }
    const workspaceIdentityFromState =
      workspaceIdentity?.trim() || get().workspaceIdentity || undefined;
    set({ error: null, addingMarketplaceSource: trimmedSource });
    try {
      await pluginsService.addMarketplace({
        workspacePath,
        ...(workspaceIdentityFromState ? { workspaceIdentity: workspaceIdentityFromState } : {}),
        source: trimmedSource,
      });
      await get().refresh(pluginsService, workspaceIdentityFromState);
      return true;
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error) });
      return false;
    } finally {
      set({ addingMarketplaceSource: null });
    }
  },
  async removeMarketplace(
    marketplace: string,
    pluginsService: IPluginsService,
    workspaceIdentity?: string,
  ) {
    const workspacePath = get().workspacePath;
    if (!workspacePath) {
      return false;
    }
    const workspaceIdentityFromState =
      workspaceIdentity?.trim() || get().workspaceIdentity || undefined;
    set({ error: null, removingMarketplaceName: marketplace });
    try {
      await pluginsService.removeMarketplace({
        workspacePath,
        ...(workspaceIdentityFromState ? { workspaceIdentity: workspaceIdentityFromState } : {}),
        marketplace,
      });
      await get().refresh(pluginsService, workspaceIdentityFromState);
      return true;
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error) });
      return false;
    } finally {
      set({ removingMarketplaceName: null });
    }
  },
  async updateMarketplace(
    marketplace: string | null,
    pluginsService: IPluginsService,
    workspaceIdentity?: string,
  ) {
    const workspacePath = get().workspacePath;
    if (!workspacePath) {
      return false;
    }
    const workspaceIdentityFromState =
      workspaceIdentity?.trim() || get().workspaceIdentity || undefined;
    set({
      error: null,
      updatingMarketplaceName: marketplace ?? "__all__",
    });
    try {
      const result = await pluginsService.updateMarketplace({
        workspacePath,
        ...(workspaceIdentityFromState ? { workspaceIdentity: workspaceIdentityFromState } : {}),
        marketplace: marketplace || undefined,
      });
      await get().refresh(pluginsService, workspaceIdentityFromState);
      // Although the legacy usePlugins entry has been retired, it is still a public hook; it must be related to the PluginManagementStore
      // They share some success semantics and cannot unconditionally report success after the Agent returns error diagnostic.
      const blockingDiagnostic = result?.diagnostics?.find(
        (diagnostic) => diagnostic.severity === "error",
      );
      if (blockingDiagnostic) {
        set({ error: blockingDiagnostic.message });
        return false;
      }
      return true;
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error) });
      return false;
    } finally {
      set({ updatingMarketplaceName: null });
    }
  },
  async installPlugin(
    pluginName: string,
    marketplace: string,
    scopeOrPluginsService: InstalledPluginSummary["scope"] | IPluginsService,
    maybePluginsService?: IPluginsService,
    workspaceIdentity?: string,
  ) {
    const workspacePath = get().workspacePath;
    if (!workspacePath) {
      // When the settings page has not been bound to the workspace, the previous cache list may still be in the store;
      // Directly returning false will make clicking to install seem unresponsive. Here, write an explicit error message first.
      set({ error: "Open a workspace before installing plugins" });
      return false;
    }
    const workspaceIdentityFromState =
      workspaceIdentity?.trim() || get().workspaceIdentity || undefined;
    const scope = typeof scopeOrPluginsService === "string" ? scopeOrPluginsService : "user";
    const pluginsService =
      typeof scopeOrPluginsService === "string" ? maybePluginsService : scopeOrPluginsService;
    if (!pluginsService) {
      set({ error: "pluginsService is required" });
      return false;
    }
    const pluginId = buildPluginOperationId(scope, pluginName, marketplace);
    set({ error: null, installingPluginId: pluginId });
    logger.info("[Plugins] install start", { pluginId, workspacePath });
    try {
      await pluginsService.installPlugin({
        workspacePath,
        ...(workspaceIdentityFromState ? { workspaceIdentity: workspaceIdentityFromState } : {}),
        pluginName,
        marketplace,
        scope,
      });
      await get().refresh(pluginsService, workspaceIdentityFromState);
      logger.info("[Plugins] install success", { pluginId, workspacePath });
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error("[Plugins] install failed", { pluginId, workspacePath, message });
      set({ error: message });
      return false;
    } finally {
      set({ installingPluginId: null });
    }
  },
  async uninstallPlugin(
    pluginName: string,
    marketplace: string,
    scopeOrPluginsService: InstalledPluginSummary["scope"] | IPluginsService,
    maybePluginsService?: IPluginsService,
    workspaceIdentity?: string,
  ) {
    const workspacePath = get().workspacePath;
    if (!workspacePath) {
      set({ error: "Open a workspace before uninstalling plugins" });
      return false;
    }
    const workspaceIdentityFromState =
      workspaceIdentity?.trim() || get().workspaceIdentity || undefined;
    const scope = typeof scopeOrPluginsService === "string" ? scopeOrPluginsService : "user";
    const pluginsService =
      typeof scopeOrPluginsService === "string" ? maybePluginsService : scopeOrPluginsService;
    if (!pluginsService) {
      set({ error: "pluginsService is required" });
      return false;
    }
    const pluginId = buildPluginOperationId(scope, pluginName, marketplace);
    set({ error: null, uninstallingPluginId: pluginId });
    try {
      await pluginsService.uninstallPlugin({
        workspacePath,
        ...(workspaceIdentityFromState ? { workspaceIdentity: workspaceIdentityFromState } : {}),
        pluginName,
        marketplace,
        scope,
      });
      await get().refresh(pluginsService, workspaceIdentityFromState);
      return true;
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error) });
      return false;
    } finally {
      set({ uninstallingPluginId: null });
    }
  },
  async setPluginEnabled(
    pluginName: string,
    marketplace: string,
    scopeOrEnabled: InstalledPluginSummary["scope"] | boolean,
    enabledOrPluginsService: boolean | IPluginsService,
    maybePluginsService?: IPluginsService,
    workspaceIdentity?: string,
    nativeScope?: InstalledPluginSummary["nativeScope"],
  ) {
    const workspacePath = get().workspacePath;
    if (!workspacePath) {
      set({ error: "Open a workspace before changing plugin status" });
      return false;
    }
    const workspaceIdentityFromState =
      workspaceIdentity?.trim() || get().workspaceIdentity || undefined;
    const legacyCall = typeof scopeOrEnabled === "boolean";
    const scope = legacyCall ? "user" : scopeOrEnabled;
    const enabled = legacyCall ? scopeOrEnabled : (enabledOrPluginsService as boolean);
    const pluginsService = legacyCall
      ? (enabledOrPluginsService as IPluginsService)
      : maybePluginsService;
    if (!pluginsService) {
      set({ error: "pluginsService is required" });
      return false;
    }
    const pluginId = buildPluginOperationId(scope, pluginName, marketplace);
    set({
      error: null,
      settingPluginEnabledId: pluginId,
      settingPluginEnabledValue: enabled,
    });
    try {
      await pluginsService.setPluginEnabled({
        workspacePath,
        ...(workspaceIdentityFromState ? { workspaceIdentity: workspaceIdentityFromState } : {}),
        pluginName,
        marketplace,
        scope,
        ...(nativeScope ? { nativeScope } : {}),
        enabled,
      });
      await get().refresh(pluginsService, workspaceIdentityFromState);
      return true;
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error) });
      return false;
    } finally {
      set({
        settingPluginEnabledId: null,
        settingPluginEnabledValue: null,
      });
    }
  },
}));
