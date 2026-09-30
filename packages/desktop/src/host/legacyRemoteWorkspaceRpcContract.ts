import type { IServiceAccessor } from "@zcode/services";

/**
 * Only the existing remote RPC client is added to the window Host, and the zcode-server wire is not changed.
 * This narrow type fixes the legacy channel that the mixed remote workspace actually depends on, and performs integrity checks before composing the service.
 */
const LEGACY_REMOTE_WORKSPACE_RPC_CHANNELS = [
  "fileService",
  "gitService",
  "gitCheckpointService",
  "systemService",
  "terminalService",
  "zcodeTaskService",
  "zcodeAgentService",
  "zcodeSessionService",
  "fileWatcherService",
  "skillsService",
  "skillSyncService",
  "mcpSyncService",
  "pluginSyncService",
  "pluginsService",
  "pluginManagementService",
  "commandsService",
  "hooksService",
  "modelSelectionService",
  "providerSettingsService",
] as const satisfies readonly (keyof IServiceAccessor)[];

type LegacyRemoteWorkspaceRpcContract = Pick<
  IServiceAccessor,
  (typeof LEGACY_REMOTE_WORKSPACE_RPC_CHANNELS)[number]
>;

export function assertLegacyRemoteWorkspaceRpcContract(
  value: Partial<IServiceAccessor>,
): asserts value is Partial<IServiceAccessor> & LegacyRemoteWorkspaceRpcContract {
  const missing = LEGACY_REMOTE_WORKSPACE_RPC_CHANNELS.filter((channel) => {
    const service = value[channel];
    return (typeof service !== "object" || service === null) && typeof service !== "function";
  });
  if (missing.length > 0) {
    throw new Error(`Legacy remote workspace RPC channel incomplete: ${missing.join(", ")}`);
  }
}
