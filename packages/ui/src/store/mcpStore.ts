/* eslint-disable max-lines -- MCP store centrally maintains configuration loading, persistence, state refresh, and runtime state merging. Splitting will increase the complexity of cross-state synchronization. */
/**
 * MCP (Model Context Protocol) UI State Store
 */
import { create } from "zustand";
import type {
  ZCodeAgentMcpServer,
  CliMcpSource,
  McpConfig,
  McpScope,
  McpServerConfig,
  McpServerStatus,
  McpSource,
  NativeMcpServerRecord,
  ZCodeMcpListMode,
  ZCodeMcpServerStatusSnapshot,
  ZCodeMcpServer,
} from "@zcode/shared";
import { convertToZCodeAgentMcpServer } from "@zcode/shared";
import { logger } from "@/logger.js";
import {
  fetchNativeMcpServers,
  migrateLegacyCommonMcpFromDesktop,
  persistCliMcpToUserDirectory,
  type McpDirectoryService,
  type McpPlatformService,
  type MigrateLegacyResult,
} from "@/store/mcpStoreDesktop.js";
import {
  importLegacyCommonServersToZCodeAgent,
  migrateStoredCommonMcpToZCodeAgent,
} from "@/store/mcpStoreMigration.js";
import {
  buildServerList,
  DEFAULT_MCP_CONFIG,
  getServerPriority,
  loadPersistedConfig,
  makeServerId,
  MCP_DELETED_PRELOAD_KEY,
  safeReadJson,
  safeWriteJson,
} from "@/store/mcpStoreHelpers.js";
import { isRemoteWorkspaceDisconnectedError } from "@/lib/remoteWorkspaceServiceError.js";
import { mergeMcpServerStatusSnapshots } from "@/store/mcpStoreStatusList.js";

let mcpPlatformService: McpPlatformService | null = null;
let mcpDirectoryService: McpDirectoryService | null = null;

export function setMcpStorePlatform(platform: McpPlatformService | null): void {
  mcpPlatformService = platform;
}

export function setMcpStoreDirectoryService(service: McpDirectoryService | null): void {
  mcpDirectoryService = service;
}

interface UpdateServerStatusOptions {
  invalidateStatusListRequests?: boolean;
}

interface McpStoreState {
  config: McpConfig;
  nativeServers: NativeMcpServerRecord[];
  servers: ZCodeMcpServer[];
  statusSnapshots: Record<string, ZCodeMcpServerStatusSnapshot>;
  currentProjectPath: string;
  currentWorkspaceIdentity?: string;
  enabledStates: Record<string, boolean>;
  deletedPreloadMcpServers: Set<string>;
  isConfigLoaded: boolean;
  currentSessionId: string | null;
  loadConfig: () => void;
  loadMcpFromUserDirectory: (
    directoryService?: McpDirectoryService | null,
    workspaceIdentity?: string,
  ) => Promise<boolean>;
  ensureLoadedForWorkspace: (
    workspacePath?: string,
    directoryService?: McpDirectoryService | null,
    workspaceIdentity?: string,
  ) => Promise<boolean>;
  saveConfig: () => void;
  addMcpServer: (name: string, config: McpServerConfig) => void;
  updateMcpServer: (name: string, config: McpServerConfig) => void;
  deleteMcpServer: (name: string) => void;
  addScopedMcpServer: (
    source: McpSource,
    name: string,
    config: McpServerConfig,
    projectPath?: string,
  ) => Promise<void>;
  updateScopedMcpServer: (
    source: McpSource,
    name: string,
    config: McpServerConfig,
    projectPath?: string,
  ) => Promise<void>;
  deleteScopedMcpServer: (source: McpSource, name: string, projectPath?: string) => void;
  addZCodeAgentMcpServer: (name: string, config: McpServerConfig, projectPath?: string) => void;
  updateZCodeAgentMcpServer: (name: string, config: McpServerConfig, projectPath?: string) => void;
  deleteZCodeAgentMcpServer: (name: string, projectPath?: string) => void;
  toggleServer: (id: string, enabled: boolean) => Promise<void>;
  updateServerStatus: (
    id: string,
    status: McpServerStatus,
    error?: string,
    options?: UpdateServerStatusOptions,
  ) => void;
  beginServerStatusListRefresh: (mode?: ZCodeMcpListMode) => number;
  markServerStatusListRefreshFailed: (
    error: string,
    requestEpoch: number,
    mode?: ZCodeMcpListMode,
  ) => void;
  mergeServerStatusSnapshots: (
    statuses: Record<string, ZCodeMcpServerStatusSnapshot>,
    requestEpoch: number,
    mode?: "connect" | "status",
  ) => void;
  getServer: (id: string) => ZCodeMcpServer | undefined;
  setCurrentProjectPath: (
    path: string,
    workspaceIdentity?: string,
    directoryService?: McpDirectoryService | null,
  ) => void;
  getEnabledMcpServersForZCode: (provider: string) => ZCodeAgentMcpServer[];
  checkAllServerStatus: (
    tester: (config: McpServerConfig) => Promise<{ success: boolean; error?: string }>,
  ) => Promise<void>;
  mergePreloadedMcpServers: (preloaded: Record<string, McpServerConfig>) => void;
  deletePreloadedMcpServer: (source: McpSource, name: string) => void;
  setCurrentSessionId: (sessionId: string | null) => void;
  migrateLegacyCommonMcp: () => Promise<MigrateLegacyResult>;
}

export const useMcpStore = create<McpStoreState>((set, get) => {
  let loadMcpPromise: Promise<boolean> | null = null;
  let loadMcpWorkspaceKey: string | null = null;
  const statusListEpochs: Record<ZCodeMcpListMode, number> = {
    connect: 0,
    status: 0,
  };

  function invalidateStatusListRequests(): void {
    statusListEpochs.connect += 1;
    statusListEpochs.status += 1;
  }

  function resolveMcpDirectoryService(
    directoryService?: McpDirectoryService | null,
    workspaceIdentity?: string | null,
  ): McpDirectoryService | null {
    const effectiveWorkspaceIdentity = workspaceIdentity ?? get().currentWorkspaceIdentity;
    if (!effectiveWorkspaceIdentity?.trim()) {
      // The local workspace still needs to take the desktop platform path to execute the old common MCP
      // Migration to user-level ZCode Agent MCP; directory service is only used for remote workspace overlay routing.
      return null;
    }
    return directoryService ?? mcpDirectoryService;
  }

  function commitState(partial: {
    config?: McpConfig;
    nativeServers?: NativeMcpServerRecord[];
  }): Partial<McpStoreState> {
    const state = get();
    const nextConfig = partial.config ?? state.config;
    const nextNativeServers = partial.nativeServers ?? state.nativeServers;
    return {
      config: nextConfig,
      nativeServers: nextNativeServers,
      servers: buildServerList(
        nextConfig,
        nextNativeServers,
        state.enabledStates,
        state.deletedPreloadMcpServers,
        state.servers,
      ),
    };
  }

  function updateNativeServer(
    source: CliMcpSource,
    name: string,
    config: McpServerConfig,
    projectPath?: string,
  ) {
    const nativeServers = get().nativeServers.slice();
    const targetIndex = nativeServers.findIndex(
      (server) =>
        server.source === source && server.name === name && server.projectPath === projectPath,
    );
    if (targetIndex >= 0) {
      const existing = nativeServers[targetIndex];
      if (!existing) {
        return;
      }
      nativeServers[targetIndex] = {
        ...existing,
        config,
      };
    } else {
      // Add new server record
      const scope: McpScope = projectPath ? "workspace" : "user";
      nativeServers.push({
        source,
        scope,
        name,
        config,
        enabled: true,
        projectPath,
      });
    }
    set(commitState({ nativeServers }));
  }

  async function persistScopedChange(
    source: McpSource,
    payload: {
      action: "upsert" | "delete";
      source: CliMcpSource;
      name: string;
      config?: McpServerConfig;
      projectPath?: string;
    },
  ): Promise<void> {
    if (source === "mcp") {
      return;
    }

    await persistCliMcpToUserDirectory(
      mcpPlatformService,
      payload,
      resolveMcpDirectoryService(),
    ).catch((error) => {
      logger.warn(`[mcpStore] persist ${source} MCP failed`, String(error));
    });
  }

  return {
    config: { ...DEFAULT_MCP_CONFIG },
    nativeServers: [],
    servers: [],
    statusSnapshots: {},
    currentProjectPath: "",
    currentWorkspaceIdentity: undefined,
    enabledStates: {},
    deletedPreloadMcpServers: new Set(),
    isConfigLoaded: false,
    currentSessionId: null,

    loadConfig: () => {
      const config = loadPersistedConfig();
      // The MCP start and stop status has been migrated to ~/.zcode/cli/config.json, and the old localStorage can no longer be read.
      // Otherwise the old local switches will overwrite the new ZCode Agent configuration source.
      const enabledStates: Record<string, boolean> = {};
      const deletedPreload = new Set<string>(safeReadJson<string[]>(MCP_DELETED_PRELOAD_KEY, []));
      const servers = buildServerList(config, [], enabledStates, deletedPreload, []);
      set({
        config,
        nativeServers: [],
        enabledStates,
        deletedPreloadMcpServers: deletedPreload,
        servers,
        statusSnapshots: {},
        isConfigLoaded: true,
      });
    },

    loadMcpFromUserDirectory: async (directoryService, workspaceIdentity) => {
      if (typeof window === "undefined") {
        return false;
      }

      const requestWorkspacePath = get().currentProjectPath || undefined;
      const requestWorkspaceIdentity = workspaceIdentity ?? get().currentWorkspaceIdentity;
      const requestWorkspaceKey = requestWorkspaceIdentity?.trim() || requestWorkspacePath || "";
      if (loadMcpPromise && loadMcpWorkspaceKey === requestWorkspaceKey) {
        return await loadMcpPromise;
      }
      if (loadMcpPromise) {
        await loadMcpPromise;
      }

      const latestWorkspacePath = get().currentProjectPath || undefined;
      const latestWorkspaceIdentity = get().currentWorkspaceIdentity;
      const latestWorkspaceKey = latestWorkspaceIdentity?.trim() || latestWorkspacePath || "";
      if (latestWorkspaceKey !== requestWorkspaceKey) {
        // This call has switched from B to C when waiting for the last round of load; B calls the remote held by
        // DirectoryService must not continue to read C and leave it to the ensure/load call initiated by C itself.
        return false;
      }
      // It is possible to switch again while waiting for the previous workspace load; the directory service must be
      // After re-selecting the latest identity, B's remote service cannot be used to read the path of C.
      const activeDirectoryService = resolveMcpDirectoryService(
        directoryService,
        latestWorkspaceIdentity,
      );
      if (loadMcpPromise && loadMcpWorkspaceKey === latestWorkspaceKey) {
        return await loadMcpPromise;
      }

      loadMcpWorkspaceKey = latestWorkspaceKey;
      loadMcpPromise = (async () => {
        try {
          logger.info(
            `[mcpStore] loadMcpFromUserDirectory workspace=${latestWorkspacePath ?? "<none>"} identity=${latestWorkspaceIdentity ?? "<none>"}`,
          );
          let servers = await fetchNativeMcpServers(
            mcpPlatformService,
            { workspacePath: latestWorkspacePath },
            activeDirectoryService,
          );
          if (!activeDirectoryService) {
            servers = await migrateStoredCommonMcpToZCodeAgent(
              mcpPlatformService,
              servers,
              latestWorkspacePath,
            );
          }
          const currentState = get();
          const currentWorkspaceKey =
            currentState.currentWorkspaceIdentity?.trim() || currentState.currentProjectPath;
          if (currentWorkspaceKey !== latestWorkspaceKey) {
            // Asynchronous directory reads from workspace A may return later than switching to B;
            // The old result contains env/header/OAuth secret and cannot be written back to the shared store and consumed by B's Agent.
            return false;
          }
          set(commitState({ nativeServers: servers }));
          return true;
        } catch (e) {
          // Read failure is not "Configuration is empty"; the caller must keep the workspace not-ready,
          // Otherwise, empty mcpServers will be explicitly delivered and replace will be triggered, disconnecting the still running MCP.
          // The remote session attachment can only get the disconnection agent before binding; this is the initialization sequence, not
          // MCP configuration read failed. Filter only the exact error code to avoid swallowing real directory or RPC failures.
          if (!isRemoteWorkspaceDisconnectedError(e)) {
            logger.warn("[mcpStore] loadMcpFromUserDirectory failed", String(e));
          }
          return false;
        } finally {
          loadMcpPromise = null;
          loadMcpWorkspaceKey = null;
        }
      })();

      return await loadMcpPromise;
    },

    ensureLoadedForWorkspace: async (workspacePath, directoryService, workspaceIdentity) => {
      if (!get().isConfigLoaded) {
        get().loadConfig();
      }

      const normalizedWorkspacePath = workspacePath ?? "";
      const normalizedWorkspaceIdentity = workspaceIdentity?.trim() || undefined;
      if (
        normalizedWorkspacePath !== get().currentProjectPath ||
        normalizedWorkspaceIdentity !== get().currentWorkspaceIdentity
      ) {
        get().setCurrentProjectPath(
          normalizedWorkspacePath,
          normalizedWorkspaceIdentity,
          directoryService,
        );
      }

      return await get().loadMcpFromUserDirectory(directoryService, normalizedWorkspaceIdentity);
    },

    saveConfig: () => {
      const { deletedPreloadMcpServers } = get();
      safeWriteJson(MCP_DELETED_PRELOAD_KEY, Array.from(deletedPreloadMcpServers));
    },

    addMcpServer: (name, config) => get().addZCodeAgentMcpServer(name, config),
    updateMcpServer: (name, config) => get().updateZCodeAgentMcpServer(name, config),
    deleteMcpServer: (name) => get().deleteZCodeAgentMcpServer(name),
    addScopedMcpServer: async (source, name, config, projectPath) => {
      invalidateStatusListRequests();
      const targetSource: CliMcpSource = source === "mcp" ? "zcodeagentmcp" : source;
      // After the settings page is saved, the agent-side mcp/list reconnection will be triggered immediately.
      // Wait for the configuration to be downloaded first, and then update the local store to prevent the agent from displaying the old health status after reading the old timeoutMs.
      await persistScopedChange(targetSource, {
        action: "upsert",
        source: targetSource,
        name,
        config,
        projectPath,
      });
      updateNativeServer(targetSource, name, config, projectPath);
    },
    updateScopedMcpServer: async (source, name, config, projectPath) => {
      invalidateStatusListRequests();
      const targetSource: CliMcpSource = source === "mcp" ? "zcodeagentmcp" : source;
      // Local state changes drive health state refreshes, which must occur after disk configuration updates.
      await persistScopedChange(targetSource, {
        action: "upsert",
        source: targetSource,
        name,
        config,
        projectPath,
      });
      updateNativeServer(targetSource, name, config, projectPath);
    },
    deleteScopedMcpServer: (source, name, projectPath) => {
      invalidateStatusListRequests();
      const targetSource: CliMcpSource = source === "mcp" ? "zcodeagentmcp" : source;
      persistScopedChange(targetSource, {
        action: "delete",
        source: targetSource,
        name,
        projectPath,
      });
      set(
        commitState({
          nativeServers: get().nativeServers.filter(
            (server) =>
              !(
                server.source === targetSource &&
                server.name === name &&
                server.projectPath === projectPath
              ),
          ),
        }),
      );
    },
    addZCodeAgentMcpServer: (name, config, projectPath) =>
      get().addScopedMcpServer("zcodeagentmcp", name, config, projectPath),
    updateZCodeAgentMcpServer: (name, config, projectPath) =>
      get().updateScopedMcpServer("zcodeagentmcp", name, config, projectPath),
    deleteZCodeAgentMcpServer: (name, projectPath) =>
      get().deleteScopedMcpServer("zcodeagentmcp", name, projectPath),

    toggleServer: async (id, enabled) => {
      invalidateStatusListRequests();
      const targetServer = get().servers.find((server) => server.id === id);
      if (targetServer && targetServer.source !== "mcp") {
        // The switch change will trigger the agent side mcp/list to read the disk configuration and make a real connection.
        // You must wait for the enable status to be written to the disk before updating the local list driver refresh, otherwise the agent will read the old switch.
        await persistCliMcpToUserDirectory(
          mcpPlatformService,
          {
            action: "set-enabled",
            source: targetServer.source,
            name: targetServer.name,
            enabled,
            projectPath: targetServer.projectPath,
            location: targetServer.location,
          },
          resolveMcpDirectoryService(),
        ).catch((error) => {
          logger.warn("[mcpStore] persist MCP enabled override failed", String(error));
        });
      }

      set((state) => {
        const nextEnabledStates = { ...state.enabledStates, [id]: enabled };
        return {
          enabledStates: nextEnabledStates,
          servers: state.servers.map((s) => (s.id === id ? { ...s, enabled } : s)),
        };
      });
    },

    updateServerStatus: (id, status, error, options) => {
      if (options?.invalidateStatusListRequests !== false) {
        invalidateStatusListRequests();
      }
      set((state) => ({
        servers: state.servers.map((s) =>
          s.id === id
            ? {
                ...s,
                status,
                authorization: undefined,
                error,
                failureKind: status === "error" ? "connection_failed" : undefined,
                serverRequestId: undefined,
                toolCount: status === "connected" ? s.toolCount : undefined,
                changed: status === "error" ? s.changed : false,
                lastConnected: status === "connected" ? new Date() : s.lastConnected,
              }
            : s,
        ),
      }));
    },

    beginServerStatusListRefresh: (mode = "connect") => {
      statusListEpochs[mode] += 1;
      const requestEpoch = statusListEpochs[mode];
      if (mode === "status") {
        // OAuth 1s status-only polling only reads the runtime snapshot; it cannot be cleared repeatedly
        // authorization/toolCount or project other MCPs edited by the user into connecting.
        return requestEpoch;
      }
      // The agent side mcp/list will wait for all MCP connections to be completed before returning; if the plug-in MCP is still in the 30s timeout,
      // After modifying timeoutMs, the local list will stop at unknown for a long time, and it seems that it is not rechecked immediately.
      set((state) => ({
        servers: state.servers.map((server) => {
          const enabled = state.enabledStates[server.id] ?? server.enabled;
          if (
            server.source !== "zcodeagentmcp" ||
            !enabled ||
            (!server.changed && server.status !== "unknown")
          ) {
            return server;
          }
          return {
            ...server,
            status: "connecting",
            authorization: undefined,
            error: undefined,
            failureKind: undefined,
            serverRequestId: undefined,
            toolCount: undefined,
          };
        }),
      }));
      return requestEpoch;
    },

    markServerStatusListRefreshFailed: (error, requestEpoch, mode = "connect") => {
      if (requestEpoch !== statusListEpochs[mode] || mode === "status") {
        // OAuth polling is a read-only best-effort status request; temporary failure cannot clear existing
        // authorization snapshot, and cannot mark MCPs still connected in the same list red in batches.
        return;
      }
      set((state) => ({
        statusSnapshots: {},
        servers: state.servers.map((server) => {
          const enabled = state.enabledStates[server.id] ?? server.enabled;
          if (server.source !== "zcodeagentmcp" || !enabled || server.status !== "connecting") {
            return server;
          }
          return {
            ...server,
            status: "error",
            authorization: undefined,
            error,
            failureKind: "status_unavailable",
            serverRequestId: undefined,
            toolCount: undefined,
          };
        }),
      }));
    },

    mergeServerStatusSnapshots: (statuses, requestEpoch, mode = "connect") => {
      if (requestEpoch !== statusListEpochs[mode]) {
        return;
      }
      set((state) => {
        const nextStatusSnapshots =
          mode === "status" ? { ...state.statusSnapshots, ...statuses } : statuses;
        return {
          statusSnapshots: nextStatusSnapshots,
          servers: mergeMcpServerStatusSnapshots(state.servers, nextStatusSnapshots, {
            // A status-only response from an OAuth poll may only contain the pending subset.
            // Missing items cannot be processed as the full mcp/list, otherwise other MCPs will be mistakenly marked as agent and not returned.
            markMissingConnectingAsError: mode !== "status",
          }),
        };
      });
    },

    getServer: (id) => get().servers.find((s) => s.id === id),

    setCurrentProjectPath: (path, workspaceIdentity, directoryService) => {
      invalidateStatusListRequests();
      const {
        config,
        currentProjectPath,
        currentWorkspaceIdentity,
        deletedPreloadMcpServers,
        enabledStates,
        isConfigLoaded,
        nativeServers,
        servers,
      } = get();
      const normalizedWorkspaceIdentity = workspaceIdentity?.trim() || undefined;
      const workspaceChanged =
        path !== currentProjectPath || normalizedWorkspaceIdentity !== currentWorkspaceIdentity;
      const nextNativeServers = workspaceChanged ? [] : nativeServers;
      set({
        currentProjectPath: path,
        currentWorkspaceIdentity: normalizedWorkspaceIdentity,
        nativeServers: nextNativeServers,
        statusSnapshots: {},
        servers: buildServerList(
          config,
          nextNativeServers,
          enabledStates,
          deletedPreloadMcpServers,
          workspaceChanged ? [] : servers,
        ),
      });
      if (isConfigLoaded && workspaceChanged) {
        // After switching to the remote workspace, the configuration loading is asynchronous; during the waiting period, A must be cleared first
        // User-level MCP cannot temporarily store its env/header/OAuth clientSecret as B's sendable configuration.
        void get().loadMcpFromUserDirectory(directoryService, normalizedWorkspaceIdentity);
      }
    },

    getEnabledMcpServersForZCode: (_provider) => {
      const { servers, enabledStates, currentProjectPath } = get();
      const candidates = new Map<string, ZCodeMcpServer>();

      for (const server of servers) {
        const isEnabled = enabledStates[server.id] ?? server.enabled;
        if (!isEnabled) continue;
        if (server.source !== "zcodeagentmcp") continue;
        if (server.scope === "workspace" && server.projectPath !== currentProjectPath) continue;

        const existing = candidates.get(server.name);
        if (!existing || getServerPriority(server) > getServerPriority(existing)) {
          candidates.set(server.name, server);
        }
      }

      const result: ZCodeAgentMcpServer[] = [];
      for (const server of candidates.values()) {
        const zcodeAgentServer = convertToZCodeAgentMcpServer(server.name, server.config);
        if (zcodeAgentServer) result.push(zcodeAgentServer);
      }
      return result;
    },

    checkAllServerStatus: async (tester) => {
      for (const server of get().servers) {
        const isEnabled = get().enabledStates[server.id] ?? server.enabled;
        if (!isEnabled || (!server.changed && server.status !== "unknown")) continue;

        get().updateServerStatus(server.id, "connecting");
        try {
          const result = await tester(server.config);
          get().updateServerStatus(
            server.id,
            result.success ? "connected" : "error",
            result.success ? undefined : (result.error ?? "Connection failed"),
          );
        } catch (e) {
          get().updateServerStatus(server.id, "error", String(e));
        }
      }
    },

    mergePreloadedMcpServers: (preloaded) => {
      const { deletedPreloadMcpServers, nativeServers } = get();
      const targetSource: CliMcpSource = "zcodeagentmcp";
      const nextNativeServers = nativeServers.slice();
      let changed = false;

      for (const [name, cfg] of Object.entries(preloaded)) {
        const serverId = makeServerId(targetSource, name);
        const exists = nextNativeServers.some(
          (server) => server.source === targetSource && server.name === name && !server.projectPath,
        );
        if (deletedPreloadMcpServers.has(serverId) || exists) continue;
        nextNativeServers.push({
          source: targetSource,
          scope: "user",
          name,
          config: cfg,
          enabled: true,
        });
        persistScopedChange(targetSource, {
          action: "upsert",
          source: targetSource,
          name,
          config: cfg,
        });
        changed = true;
      }

      if (!changed) return;
      set(commitState({ nativeServers: nextNativeServers }));
    },

    deletePreloadedMcpServer: (source, name) => {
      const targetSource: CliMcpSource = source === "mcp" ? "zcodeagentmcp" : source;
      const key = makeServerId(targetSource, name);
      persistScopedChange(targetSource, { action: "delete", source: targetSource, name });
      set((state) => {
        const nextDeleted = new Set(state.deletedPreloadMcpServers);
        nextDeleted.add(key);
        safeWriteJson(MCP_DELETED_PRELOAD_KEY, Array.from(nextDeleted));
        const nextNativeServers = state.nativeServers.filter(
          (server) =>
            !(server.source === targetSource && server.name === name && !server.projectPath),
        );
        return {
          deletedPreloadMcpServers: nextDeleted,
          nativeServers: nextNativeServers,
          servers: buildServerList(
            state.config,
            nextNativeServers,
            state.enabledStates,
            nextDeleted,
            state.servers,
          ),
        };
      });
    },

    setCurrentSessionId: (sessionId) => set({ currentSessionId: sessionId }),

    migrateLegacyCommonMcp: async () => {
      const result = await migrateLegacyCommonMcpFromDesktop(mcpPlatformService);
      const latestWorkspacePath = get().currentProjectPath || undefined;
      const currentNativeServers =
        get().nativeServers.length > 0
          ? get().nativeServers
          : await fetchNativeMcpServers(mcpPlatformService, { workspacePath: latestWorkspacePath });
      const migration = await importLegacyCommonServersToZCodeAgent(
        mcpPlatformService,
        result.servers ?? {},
        currentNativeServers,
        result.sourcePath,
      );
      if (migration.changed) {
        const servers = await fetchNativeMcpServers(mcpPlatformService, {
          workspacePath: latestWorkspacePath,
        });
        set(commitState({ nativeServers: servers }));
      }
      return migration;
    },
  };
});
