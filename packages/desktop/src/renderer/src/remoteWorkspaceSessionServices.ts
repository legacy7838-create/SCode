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
    // 远端附件必须由当前 workspace host 上传并改写路径；沿用本地服务会把
    // 桌面机的绝对路径原样传给 SSH/WSL/Docker 中的 CLI，导致附件无法读取。
    promptAttachmentTransferService: remoteServices.promptAttachmentTransferService,
    // MCP / 插件状态检查走 zcodeAgentService 的控制面 app-server。
    // SSH 远端如果沿用本机 base service，会把远端 MCP 配置拿到本机 app-server 里检查，
    // 其 PATH / cwd 都不是远端环境，导致同步后仍显示 `spawn npx ENOENT`。
    zcodeAgentService: remoteServices.zcodeAgentService,
    zcodeTaskService: remoteServices.zcodeTaskService,
    zcodeSessionService: remoteServices.zcodeSessionService,
    // 分享使用本地登录/API，但 Rows 与文件必须绑定当前远端 connection scope。
    conversationShareService: remoteServices.conversationShareService,
    fileWatcherService: remoteServices.fileWatcherService,
    // Provider/Model 事实属于目标 Environment；不能因 merge 先展开 baseServices 而回落到本地。
    modelSelectionService: remoteServices.modelSelectionService,
    providerSettingsService: remoteServices.providerSettingsService,
    // SSH/Docker remote 项目的 skills/plugins/commands 目录位于远端文件系统。
    // 之前这里沿用本机 base services，会拿远端 workspacePath 去本机扫描，导致项目级能力读不到。
    skillsService: remoteServices.skillsService,
    // 远端 skill 同步的 import 必须写入 SSH 主机的 ~/.zcode/skills。
    // 如果继续沿用 base service，UI 会显示同步成功但实际写到本机 ~/.zcode/skills。
    skillSyncService: remoteServices.skillSyncService,
    // 远端 MCP 同步的 import 必须写入 SSH 主机的 ~/.zcode/cli/config.json。
    // 这里与 skillSyncService 一样走 remote service，避免把远端配置写回本机用户目录。
    mcpSyncService: remoteServices.mcpSyncService,
    commandsService: remoteServices.commandsService,
  };
}
