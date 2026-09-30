import type { IPluginManagementService } from "@zcode/services";
import type { ZCodePluginScope } from "@zcode/shared";
import { logger } from "@/logger.js";
import type { PluginManagementState } from "@/store/pluginManagementStore.js";

function toMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function buildWorkspaceKey(workspacePath: string, workspaceIdentity: string | null): string {
  return workspaceIdentity?.trim() || workspacePath;
}

const inFlightLoads = new Map<string, Promise<void>>();

export async function runWorkspaceOperation(
  set: (partial: Partial<PluginManagementState>) => void,
  get: () => PluginManagementState,
  pluginService: IPluginManagementService,
  operationId: string,
  operation: (workspace: { workspacePath: string; workspaceIdentity?: string }) => Promise<void>,
): Promise<boolean> {
  const { workspacePath, workspaceIdentity, configScope } = get();
  if (!workspacePath) return false;
  const operationVersion = get().operationVersion + 1;
  set({ operationId, operationVersion, error: null, lastFailedPluginId: null });
  const isCurrentContext = (): boolean => {
    const current = get();
    return (
      current.workspacePath === workspacePath &&
      current.workspaceIdentity === workspaceIdentity &&
      current.configScope === configScope
    );
  };
  const ownsVisibleOperation = (): boolean =>
    isCurrentContext() && get().operationId === operationId;
  try {
    await operation({
      workspacePath,
      ...(workspaceIdentity ? { workspaceIdentity } : {}),
    });
    // operationId is just a shared UI busy indicator. Autorefresh may overwrite the current operation before it completes,
    // However, the add/installation operation that has been successfully downloaded cannot be reported as a failure because of this, otherwise the caller will retain the pop-up window.
    if (!isCurrentContext()) return false;
    await loadInto(set, get, {
      workspacePath,
      workspaceIdentity,
      configScope,
      pluginService,
    });
    return isCurrentContext();
  } catch (error) {
    // Common operations such as marketplace add/update failed: no plug-in target, attribution cleared.
    logger.error("[plugins] operation failed", { operationId, error: toMessage(error) });
    // Old operations cannot overwrite the error status of new operations in the same configuration layer; only operations that still hold a visible operationId are written back.
    if (ownsVisibleOperation()) {
      set({ error: toMessage(error), lastFailedPluginId: null });
    }
    return false;
  } finally {
    // Prevent the busy status of subsequent operations from being cleared when the old operation ends.
    // The current context may have changed after Scope/workspace switching, and isCurrentContext can no longer be used to determine;
    // As long as the operationId still belongs to this completed operation, it should be cleared. Otherwise the user is in User
    // If you switch to Workspace when the configuration is saved and the refresh is not completed, the new configuration view will always be locked as read-only by the old operation.
    if (get().operationId === operationId && get().operationVersion === operationVersion) {
      set({ operationId: null });
    }
  }
}

export async function loadInto(
  set: (partial: Partial<PluginManagementState>) => void,
  get: () => PluginManagementState,
  params: {
    workspacePath: string;
    workspaceIdentity: string | null;
    configScope: ZCodePluginScope | null;
    pluginService: IPluginManagementService;
  },
): Promise<void> {
  const workspaceKey = buildWorkspaceKey(params.workspacePath, params.workspaceIdentity);
  const loadKey = `${workspaceKey}\u0000${params.configScope ?? "effective"}`;
  const existing = inFlightLoads.get(loadKey);
  if (existing) {
    logger.debug("[plugins] join in-flight list", {
      configScope: params.configScope,
      workspaceKey,
    });
    await existing;
    return;
  }
  const loadTask = runLoadInto(set, get, { ...params, workspaceKey });
  inFlightLoads.set(loadKey, loadTask);
  try {
    await loadTask;
  } finally {
    if (inFlightLoads.get(loadKey) === loadTask) {
      inFlightLoads.delete(loadKey);
    }
  }
}

async function runLoadInto(
  set: (partial: Partial<PluginManagementState>) => void,
  get: () => PluginManagementState,
  params: {
    workspacePath: string;
    workspaceIdentity: string | null;
    configScope: ZCodePluginScope | null;
    workspaceKey: string;
    pluginService: IPluginManagementService;
  },
): Promise<void> {
  const setIfCurrent = (partial: Partial<PluginManagementState>): void => {
    const current = get();
    if (
      current.workspacePath !== params.workspacePath ||
      current.workspaceIdentity !== params.workspaceIdentity ||
      current.configScope !== params.configScope
    ) {
      return;
    }
    set(partial);
  };
  try {
    // React StrictMode, settings service reference refresh or quickly switch settings page,
    // The same workspace will trigger initialize concurrently. If each trigger is sent to an independent plugins/list,
    // When the agent is stale, these requests will be queued and generate multiple 30s timeouts. Reuse in-flight by workspaceKey
    // request, and only write back the results when you are still in the same workspace to avoid expired responses from overwriting the current settings page.
    const [listResult, overviewResult] = await Promise.all([
      params.pluginService.listPlugins({
        workspacePath: params.workspacePath,
        ...(params.workspaceIdentity ? { workspaceIdentity: params.workspaceIdentity } : {}),
        ...(params.configScope ? { configScope: params.configScope } : {}),
      }),
      params.pluginService.getPluginsOverview({
        workspacePath: params.workspacePath,
        ...(params.workspaceIdentity ? { workspaceIdentity: params.workspaceIdentity } : {}),
        ...(params.configScope ? { configScope: params.configScope } : {}),
      }),
    ]);
    const diagnostics = [...listResult.diagnostics, ...overviewResult.diagnostics];
    setIfCurrent({
      plugins: listResult.plugins,
      marketplaces: overviewResult.marketplaces,
      marketplaceAvailabilityKnown: true,
      availablePlugins: overviewResult.availablePlugins,
      installedPlugins: overviewResult.installedPlugins,
      restorableBuiltins: overviewResult.restorableBuiltins,
      diagnostics,
      loading: false,
    });
  } catch (error) {
    logger.error("[plugins] overview/list failed", {
      workspacePath: params.workspacePath,
      workspaceKey: params.workspaceKey,
      lastFailedPluginId: null,
      error: error instanceof Error ? error.message : String(error),
    });
    try {
      const result = await params.pluginService.listPlugins({
        workspacePath: params.workspacePath,
        ...(params.workspaceIdentity ? { workspaceIdentity: params.workspaceIdentity } : {}),
        ...(params.configScope ? { configScope: params.configScope } : {}),
      });
      setIfCurrent({
        plugins: result.plugins,
        marketplaces: [],
        // Overview failed spatiotemporal array means "source status unknown", not "all sources deleted".
        // Keep this boundary to avoid official/cache plug-ins returned by list fallback from being misjudged as orphan installations in batches.
        marketplaceAvailabilityKnown: false,
        availablePlugins: [],
        installedPlugins: [],
        restorableBuiltins: [],
        diagnostics: result.diagnostics,
        loading: false,
      });
      return;
    } catch (listError) {
      logger.error("[plugins] list fallback failed", {
        workspacePath: params.workspacePath,
        workspaceKey: params.workspaceKey,
        lastFailedPluginId: null,
        error: listError instanceof Error ? listError.message : String(listError),
      });
      setIfCurrent({
        loading: false,
        marketplaceAvailabilityKnown: false,
        lastFailedPluginId: null,
        error: listError instanceof Error ? listError.message : String(listError),
      });
    }
  }
}
