import type { IServiceAccessor } from "@zcode/services";

export function buildRemoteWorkspaceSessionServices(
  baseServices: IServiceAccessor,
  remoteServices: IServiceAccessor,
): IServiceAccessor {
  return {
    ...baseServices,
    fileService: remoteServices.fileService,
    mediaPreviewService: remoteServices.mediaPreviewService,
    gitService: remoteServices.gitService,
    gitCheckpointService: remoteServices.gitCheckpointService,
    systemService: remoteServices.systemService,
    terminalService: remoteServices.terminalService,
    // Remote attachments must be uploaded by the current workspace host and the path rewritten; using the local service will
    // The absolute path of the desktop computer is passed unchanged to the CLI in SSH/WSL, causing the attachment to be unreadable.
    promptAttachmentTransferService: remoteServices.promptAttachmentTransferService,
    // MCP/plugin status check goes to zcodeAgentService's control plane app-server.
    // If the SSH remote end continues to use the local base service, the remote MCP configuration will be checked in the local app-server.
    // Its PATH / cwd are not remote environments, causing `spawn npx ENOENT` to still be displayed after synchronization.
    zcodeAgentService: remoteServices.zcodeAgentService,
    zcodeTaskService: remoteServices.zcodeTaskService,
    zcodeSessionService: remoteServices.zcodeSessionService,
    // Sharing uses local login/API, but Rows and files must be bound to the current remote connection scope.
    conversationShareService: remoteServices.conversationShareService,
    fileWatcherService: remoteServices.fileWatcherService,
    // Provider/Model facts belong to the target Environment; they cannot fall back to local because merge expands baseServices first.
    modelSelectionService: remoteServices.modelSelectionService,
    providerSettingsService: remoteServices.providerSettingsService,
    // The skills/plugins/commands directory of the SSH remote project is located on the remote file system.
    // Previously, the local base services were used here, and the remote workspacePath was scanned locally, resulting in project-level capabilities not being read.
    skillsService: remoteServices.skillsService,
    // The import of remote skill synchronization must be written to ~/.zcode/skills of the SSH host.
    // If you continue to use the base service, the UI will show that the synchronization is successful but it will actually be written to the local ~/.zcode/skills.
    skillSyncService: remoteServices.skillSyncService,
    // The import for remote MCP synchronization must be written to ~/.zcode/cli/config.json of the SSH host.
    // Here, we use remote service like skillSyncService to avoid writing the remote configuration back to the local user directory.
    mcpSyncService: remoteServices.mcpSyncService,
    // Remote plugin synchronization will be written to ~/.zcode/plugins and plugins.dirs of the SSH host;
    // The remote service must be used like skill/MCP, and the local base service cannot be used.
    pluginSyncService: remoteServices.pluginSyncService,
    pluginsService: remoteServices.pluginsService,
    // The plug-in management of the settings page is the same as the pluginsService and must be sent to the remote end (the plug-in directory is in the remote file system).
    pluginManagementService: remoteServices.pluginManagementService,
    commandsService: remoteServices.commandsService,
    // The SSH workspace's hooks statement, trust status, and pending items are all located on the remote file system.
    // hooksService must override the local service in baseServices, otherwise the local file system will be scanned using the remote path.
    // Unable to read remote pending Hook.
    // Both hooks reading and writing (loadHooks/saveHooks) and grantWorkspaceHookTrust authorization must go to the remote host.
    hooksService: remoteServices.hooksService,
  };
}
