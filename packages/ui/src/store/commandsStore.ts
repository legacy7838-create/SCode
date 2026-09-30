import { create } from "zustand";
import type {
  CommandCreateParams,
  CommandDeleteParams,
  CommandSetEnabledParams,
  CommandUpdateParams,
  UserCommand,
  ZCodeCommand,
} from "@zcode/shared";
import type { ICommandsService } from "@zcode/services";

interface CommandsStoreState {
  workspacePath: string | null;
  workspaceIdentity: string | null;
  loadedWorkspacePath: string | null;
  loadedWorkspaceIdentity: string | null;
  commands: ZCodeCommand[];
  userCommands: UserCommand[];
  pluginCommands: ZCodeCommand[];
  capability: { userScopeAvailable: boolean };
  loading: boolean;
  error: string | null;
  operatingCommandId: string | null;
  initialize: (
    workspacePath: string | undefined,
    commandsService: ICommandsService,
    workspaceIdentity?: string,
  ) => Promise<void>;
  refresh: (commandsService: ICommandsService) => Promise<void>;
  createCommand: (
    params: CommandCreateParams,
    commandsService: ICommandsService,
  ) => Promise<UserCommand | null>;
  updateCommand: (
    params: CommandUpdateParams,
    commandsService: ICommandsService,
  ) => Promise<UserCommand | null>;
  deleteCommand: (
    params: CommandDeleteParams,
    commandsService: ICommandsService,
  ) => Promise<boolean>;
  toggleCommand: (
    params: CommandSetEnabledParams,
    commandsService: ICommandsService,
  ) => Promise<void>;
}

const inflightLists = new Map<string, Promise<void>>();

type StoreGet = () => CommandsStoreState;

function listKey(workspacePath: string | undefined, workspaceIdentity?: string): string {
  return workspaceIdentity?.trim() || workspacePath || "__no_workspace__";
}

// The store is a singleton, and the Scope menu can switch targets on the same page. Any asynchronous results must be compared before being written back
// The target key when launching, otherwise the list of slow targets will overwrite the current projection, and then delete/toggle will take the old host
// The filePath is executed on the host of the current target.
function currentListKey(get: StoreGet): string {
  const { workspacePath, workspaceIdentity } = get();
  return listKey(workspacePath ?? undefined, workspaceIdentity ?? undefined);
}

export const useCommandsStore = create<CommandsStoreState>((set, get) => ({
  workspacePath: null,
  workspaceIdentity: null,
  loadedWorkspacePath: null,
  loadedWorkspaceIdentity: null,
  commands: [],
  userCommands: [],
  pluginCommands: [],
  capability: { userScopeAvailable: true },
  loading: false,
  error: null,
  operatingCommandId: null,

  initialize: async (workspacePath, commandsService, workspaceIdentity) => {
    const normalizedWorkspaceIdentity = workspaceIdentity?.trim() || null;
    set({ workspacePath: workspacePath ?? null, workspaceIdentity: normalizedWorkspaceIdentity });
    const key = listKey(workspacePath, normalizedWorkspaceIdentity ?? undefined);
    const existing = inflightLists.get(key);
    if (existing) {
      await existing;
      return;
    }
    const promise = (async () => {
      set({ loading: true, error: null });
      try {
        const result = await commandsService.list({
          workspacePath,
          ...(normalizedWorkspaceIdentity
            ? { workspaceIdentity: normalizedWorkspaceIdentity }
            : {}),
        });
        if (currentListKey(get) !== key) return;
        set({
          commands: result.commands,
          userCommands: result.userCommands,
          pluginCommands: result.pluginCommands,
          capability: result.capability,
          loadedWorkspacePath: workspacePath ?? null,
          loadedWorkspaceIdentity: normalizedWorkspaceIdentity,
          loading: false,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (currentListKey(get) !== key) return;
        set({ loading: false, error: message });
      } finally {
        inflightLists.delete(key);
      }
    })();
    inflightLists.set(key, promise);
    await promise;
  },

  refresh: async (commandsService) => {
    const { workspacePath, workspaceIdentity } = get();
    const key = currentListKey(get);
    set({ loading: true, error: null });
    try {
      const result = await commandsService.list({
        workspacePath: workspacePath ?? undefined,
        ...(workspaceIdentity ? { workspaceIdentity } : {}),
      });
      if (currentListKey(get) !== key) return;
      set({
        commands: result.commands,
        userCommands: result.userCommands,
        pluginCommands: result.pluginCommands,
        capability: result.capability,
        loadedWorkspacePath: workspacePath,
        loadedWorkspaceIdentity: workspaceIdentity,
        loading: false,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (currentListKey(get) !== key) return;
      set({ loading: false, error: message });
    }
  },

  createCommand: async (params, commandsService) => {
    const key = currentListKey(get);
    set({ error: null });
    try {
      const { command } = await commandsService.writeCommandFile(params);
      // The writing is completed on the target host when initiated, but if the Scope is switched during the process,
      // The results cannot be merged into the current target's projection, otherwise the list will be mixed with commands from other hosts.
      if (currentListKey(get) !== key) return command;
      const { commands, userCommands } = get();
      set({
        commands: [...commands, command],
        userCommands: [...userCommands, command],
      });
      return command;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (currentListKey(get) !== key) throw err;
      set({ error: message });
      throw err;
    }
  },

  updateCommand: async (params, commandsService) => {
    const key = currentListKey(get);
    set({ operatingCommandId: params.commandId, error: null });
    try {
      const { command } = await commandsService.updateCommandFile(params);
      if (currentListKey(get) !== key) {
        set({ operatingCommandId: null });
        return command;
      }
      const { commands, userCommands } = get();
      set({
        commands: commands.map((c) => (c.id === params.commandId ? command : c)),
        userCommands: userCommands.map((c) => (c.id === params.commandId ? command : c)),
        operatingCommandId: null,
      });
      return command;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      set(
        currentListKey(get) === key
          ? { operatingCommandId: null, error: message }
          : { operatingCommandId: null },
      );
      throw err;
    }
  },

  deleteCommand: async (params, commandsService) => {
    const key = currentListKey(get);
    set({ operatingCommandId: params.commandId, error: null });
    try {
      await commandsService.deleteCommandFile(params);
      if (currentListKey(get) !== key) {
        set({ operatingCommandId: null });
        return true;
      }
      const { commands, userCommands } = get();
      set({
        commands: commands.filter((c) => c.id !== params.commandId),
        userCommands: userCommands.filter((c) => c.id !== params.commandId),
        operatingCommandId: null,
      });
      return true;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      set(
        currentListKey(get) === key
          ? { operatingCommandId: null, error: message }
          : { operatingCommandId: null },
      );
      throw err;
    }
  },

  toggleCommand: async (params, commandsService) => {
    const key = currentListKey(get);
    set({ operatingCommandId: params.commandId, error: null });
    try {
      await commandsService.setCommandEnabled(params);
      if (currentListKey(get) !== key) {
        set({ operatingCommandId: null });
        return;
      }
      const { commands, userCommands } = get();
      set({
        commands: commands.map((command) =>
          command.id === params.commandId ? { ...command, enabled: params.enabled } : command,
        ),
        userCommands: userCommands.map((command) =>
          command.id === params.commandId ? { ...command, enabled: params.enabled } : command,
        ),
        operatingCommandId: null,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      set(
        currentListKey(get) === key
          ? { operatingCommandId: null, error: message }
          : { operatingCommandId: null },
      );
      throw err;
    }
  },
}));
