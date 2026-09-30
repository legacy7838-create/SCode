import { useCallback, useEffect, useMemo } from "react";
import type { ICommandsService } from "@zcode/services";
import { useCommandsStore } from "@/store/commandsStore.js";
import type {
  CommandAgentSource,
  CommandConfig,
  CommandCreateParams,
  CommandDeleteParams,
  CommandSetEnabledParams,
  CommandUpdateParams,
} from "@zcode/shared";

interface UseCommandsOptions {
  // The service was previously taken implicitly from useServices(), while workspacePath was passed by the caller per the Scope target,
  // so B's path could be sent to A's remote host. Now both are required, resolved per target by the caller and injected here.
  commandsService: ICommandsService;
  workspacePath?: string;
  workspaceIdentity?: string;
  enabled?: boolean;
}

export function useCommands(options: UseCommandsOptions) {
  const { commandsService, workspacePath, workspaceIdentity, enabled = true } = options;

  const commands = useCommandsStore((state) => state.commands);
  const userCommands = useCommandsStore((state) => state.userCommands);
  const pluginCommands = useCommandsStore((state) => state.pluginCommands);
  const capability = useCommandsStore((state) => state.capability);
  const loading = useCommandsStore((state) => state.loading);
  const error = useCommandsStore((state) => state.error);
  const operatingCommandId = useCommandsStore((state) => state.operatingCommandId);
  const loadedWorkspacePath = useCommandsStore((state) => state.loadedWorkspacePath);
  const loadedWorkspaceIdentity = useCommandsStore((state) => state.loadedWorkspaceIdentity);
  // commandsStore is a singleton and the Scope can switch targets on the same page. Until the projection matches the current target,
  // we must not hand the previous host's commands to the caller for rendering — those rows' filePath belongs to another host, and a
  // delete/toggle would execute against the current target's host with the stale path.
  const projectionMatchesTarget =
    (loadedWorkspaceIdentity?.trim() || loadedWorkspacePath || "") ===
    (workspaceIdentity?.trim() || workspacePath || "");
  const initialize = useCommandsStore((state) => state.initialize);
  const refreshStore = useCommandsStore((state) => state.refresh);
  const createStore = useCommandsStore((state) => state.createCommand);
  const updateStore = useCommandsStore((state) => state.updateCommand);
  const deleteStore = useCommandsStore((state) => state.deleteCommand);
  const toggleStore = useCommandsStore((state) => state.toggleCommand);

  useEffect(() => {
    if (!enabled) {
      return;
    }
    void initialize(workspacePath, commandsService, workspaceIdentity);
  }, [enabled, workspacePath, workspaceIdentity, commandsService, initialize]);

  const refresh = useCallback(() => refreshStore(commandsService), [commandsService, refreshStore]);

  const createCommand = useCallback(
    (
      config: CommandConfig,
      agentSource?: CommandAgentSource,
      params?: Omit<CommandCreateParams, "config" | "agentSource">,
    ) => createStore({ agentSource, config, ...params }, commandsService),
    [commandsService, createStore],
  );

  const updateCommand = useCallback(
    (params: CommandUpdateParams) => updateStore(params, commandsService),
    [commandsService, updateStore],
  );

  const deleteCommand = useCallback(
    (params: CommandDeleteParams) => deleteStore(params, commandsService),
    [commandsService, deleteStore],
  );

  const toggleCommand = useCallback(
    (params: CommandSetEnabledParams) => toggleStore(params, commandsService),
    [commandsService, toggleStore],
  );

  return useMemo(
    () => ({
      commands,
      userCommands,
      pluginCommands,
      capability,
      loading,
      error,
      operatingCommandId,
      projectionMatchesTarget,
      refresh,
      createCommand,
      updateCommand,
      deleteCommand,
      toggleCommand,
    }),
    [
      commands,
      userCommands,
      pluginCommands,
      capability,
      loading,
      error,
      operatingCommandId,
      projectionMatchesTarget,
      refresh,
      createCommand,
      updateCommand,
      deleteCommand,
      toggleCommand,
    ],
  );
}
