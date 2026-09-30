import type {
  ICommandsService,
  IMcpSyncService,
  ISkillsService,
  IZCodeAgentService,
  IZCodeSessionService,
} from "@zcode/services";
import { logger } from "@/logger.js";
import { invalidateDeferredDraftSessionForSkillChange } from "@/lib/zcodeDraftSkillInvalidation.js";
import { refreshSharedSkillStoreForWorkspace } from "@/lib/skillStoreRefresh.js";
import { mergeSlashCommandsAfterCommandRefresh } from "@/settings/pluginSlashCommandRefresh.js";
import { useCommandsStore } from "@/store/commandsStore.js";
import { useMcpStore } from "@/store/mcpStore.js";
import { usePluginManagementStore } from "@/store/pluginManagementStore.js";
import { useZCodeSessionStore } from "@/store/zcodeSessionStore.js";

function toMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function refreshSlashCommandsAfterRemotePluginSync(params: {
  commandsService: ICommandsService;
  reason: string;
  workspacePath: string;
  workspaceIdentity: string | null;
}): Promise<void> {
  const { commandsService, reason, workspacePath, workspaceIdentity } = params;
  const workspaceIdentityParam = workspaceIdentity ?? undefined;

  try {
    const result = await commandsService.list({
      workspacePath,
      ...(workspaceIdentityParam ? { workspaceIdentity: workspaceIdentityParam } : {}),
    });

    const commandsStore = useCommandsStore.getState();
    if (
      commandsStore.workspacePath === workspacePath &&
      commandsStore.workspaceIdentity === workspaceIdentity
    ) {
      useCommandsStore.setState({
        commands: result.commands,
        userCommands: result.userCommands,
        pluginCommands: result.pluginCommands,
        capability: result.capability,
        loadedWorkspacePath: workspacePath,
        loadedWorkspaceIdentity: workspaceIdentity,
        loading: false,
        error: null,
      });
    }

    const zcodeSessionStore = useZCodeSessionStore.getState();
    const currentSlashCommands = zcodeSessionStore.getWorkspaceState(
      workspacePath,
      workspaceIdentityParam,
    ).slashCommands;
    // The remote plug-in synchronization portal may not have opened the command settings page, and commandsStore may not have been initialized yet.
    // The input box `/` panel reads zcodeSessionStore.slashCommands, so it must be directly
    // Pull commands from the current remote workspace and write back slashCommands. You cannot just refresh the settings page store.
    zcodeSessionStore.setSlashCommands(
      workspacePath,
      mergeSlashCommandsAfterCommandRefresh(currentSlashCommands, result.commands),
      workspaceIdentityParam,
    );
  } catch (error) {
    const commandsStore = useCommandsStore.getState();
    if (
      commandsStore.workspacePath === workspacePath &&
      commandsStore.workspaceIdentity === workspaceIdentity
    ) {
      useCommandsStore.setState({
        loading: false,
        error: toMessage(error),
      });
    }
    logger.warn("[plugins] refresh slash commands after remote plugin sync failed", {
      reason,
      workspaceIdentity,
      workspacePath,
      error: toMessage(error),
    });
  }
}

export async function refreshWorkspacePluginCapabilitiesAfterRemoteSync(params: {
  commandsService: ICommandsService;
  mcpSyncService: IMcpSyncService;
  reason: string;
  skillsService: ISkillsService;
  workspaceIdentity?: string | null;
  workspacePath?: string | null;
  zcodeAgentService: IZCodeAgentService;
  zcodeSessionService: Pick<IZCodeSessionService, "closeSession">;
}): Promise<void> {
  const workspacePath = params.workspacePath;
  if (!workspacePath) {
    return;
  }
  const workspaceIdentity = params.workspaceIdentity?.trim() || null;
  const workspaceIdentityParam = workspaceIdentity ?? undefined;
  const pluginStore = usePluginManagementStore.getState();

  if (
    pluginStore.workspacePath === workspacePath &&
    pluginStore.workspaceIdentity === workspaceIdentity
  ) {
    await pluginStore.refresh(params.zcodeAgentService);
  }

  await invalidateDeferredDraftSessionForSkillChange({
    zcodeSessionService: params.zcodeSessionService,
    workspacePath,
    workspaceIdentity: workspaceIdentityParam,
    reason: params.reason,
  });
  await refreshSharedSkillStoreForWorkspace({
    workspacePath,
    workspaceIdentity: workspaceIdentityParam,
    skillsService: params.skillsService,
  });
  await refreshSlashCommandsAfterRemotePluginSync({
    commandsService: params.commandsService,
    reason: params.reason,
    workspacePath,
    workspaceIdentity,
  });
  await useMcpStore
    .getState()
    .ensureLoadedForWorkspace(workspacePath, params.mcpSyncService, workspaceIdentityParam);
}
