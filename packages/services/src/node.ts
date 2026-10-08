/* eslint-disable max-lines -- host process 服务注册和启动装配需要集中维护，拆散后会更难追踪依赖注入顺序 */
// Node.js service implementations — NOT safe to import in browser code
import { join } from "node:path";
import {
  createNodeProviderRuntimePathEnv,
  NodeModelSelectionConfigRepository,
  PERSONAL_PROVIDER_CONFIG_FILE_NAME,
} from "@zcode/provider-node";
import { getAppConfigDir as resolveAppConfigDir } from "./paths.js";
import {
  buildLocalMediaPreviewUrl,
  isProviderProvisioningAccountCredentialKey,
  type ProviderProvisioningTrigger,
} from "@zcode/shared";

export {
  materializeZCodeBuiltinProviderConfig,
  ZCODE_BUILTIN_PROVIDER_CONFIG_FILE_ENV,
} from "@zcode/provider-node";

export { createFileService } from "./file/fileService.js";
export {
  attributeHostProcessTree,
  createProcessResourceSampler,
  createProcessResourceTableReader,
  type HostResourceUsageAgent,
  type ProcessResourceSample,
  type ProcessResourceSampler,
} from "./process/processResourceSampler.js";
export { createMediaPreviewService } from "./media-preview/mediaPreview.js";
export type { CreateFileServiceOptions } from "./file/fileService.js";
export {
  defaultWorkspaceFileSearchFilter,
  type WorkspaceFileSearchDecision,
  type WorkspaceFileSearchEntry,
  type WorkspaceFileSearchFilter,
} from "./file/workspaceFileMentionFilter.js";
export {
  createFsFaultInjector,
  getProcessFsFaultInjector,
  maybeThrowInjectedFsFault,
  parseFsFaultRulesFromEnvValue,
  resetProcessFsFaultInjectorForTests,
  setFsFaultInjectorForTests,
  ZCODE_E2E_FS_FAULTS_ALLOW_ENV,
  ZCODE_E2E_FS_FAULTS_ENV,
} from "./fs/fsFaultInjection.js";
export type {
  FsFaultCheckInput,
  FsFaultHit,
  FsFaultInjector,
  FsFaultOperation,
  FsFaultRuleConfig,
  InjectedFsFaultError,
} from "./fs/fsFaultInjection.js";
export {
  setDataBaseDir,
  getDataBaseDir,
  getZCodeDataRootDir,
  getConversationWorkspaceDir,
  getAppConfigDir,
  getExportLogStageDir,
  getExportLogDir,
  getFeedbackRootDir,
  getFeedbackAttachmentDir,
  getFeedbackLogArchiveDir,
  getGitCheckpointIndexRootDir,
  copyDataDirectory,
  validateDataBaseDirTarget,
  ZCODE_WINDOWS_APP_INSTALL_DIR_ENV,
} from "./paths.js";
export { createGitService } from "./git/gitService.js";
export { GitCommitMessageGenerator } from "./git/gitCommitMessageGenerator.js";
export { createGitCheckpointService } from "./git/gitCheckpointService.js";
export { createSystemService } from "./system/systemService.js";
export { listSSHConfigAliasesFromLocalConfig } from "./system/sshConfigAlias.js";
export { createTerminalService } from "./terminal/terminalService.js";
export {
  createSettingService,
  createSettingServiceWithMigrations,
} from "./setting/settingService.js";
export { createCredentialService } from "./credential/credentialService.js";
export { createBroadcastService } from "./broadcast/broadcastService.js";
export { createZCodeAgentService } from "./zcode-agent/zcodeAgentService.js";
export { createZCodeTaskServiceAdapter } from "./zcode-agent/zcodeTaskServiceAdapter.js";
export { createZCodeSessionService } from "./zcode-session/zcodeSessionService.js";
export {
  resolveDefaultZCodeAgentCommand,
  ZCodeAgentProcessManager,
} from "./zcode-agent/zcodeAgentProcessManager.js";
export type {
  ZCodeAgentCommand,
  ZCodeAgentCommandResolver,
  ZCodeAgentCommandResolverContext,
  ZCodeAgentProcessManagerOptions,
} from "./zcode-agent/zcodeAgentProcessManager.js";
export { ZCodeProtocolClient } from "./zcode-agent/zcodeProtocolClient.js";
export type { ZCodeProtocolTransport } from "./zcode-agent/zcodeProtocolTransport.js";
export { ZCodeStdioTransport } from "./zcode-agent/zcodeStdioTransport.js";
export {
  getZCodeStdioTapDevLogDir,
  readZCodeStdioTapDevState,
  setZCodeStdioTapDevEnabled,
} from "./zcode-agent/zcodeStdioTapDevConfig.js";
export type { ZCodeStdioTapDevState } from "@zcode/shared";
export { createFileWatcherService } from "./fileWatcher/fileWatcherService.js";
export { createBotsService } from "./bots/botsService.js";
export { createOAuthService } from "./oauth/oauthService.js";
export { createOAuthProviderLogoutHandler } from "./oauth/oauthProviderLogout.js";
export { OAuthCredentialRepo } from "./oauth/repo/oauthCredentialRepo.js";
export { ensureDeviceMid } from "./device/deviceMid.js";
export type { EnsureDeviceMidOptions } from "./device/deviceMid.js";
export type { AccountRequestAuthResolver } from "./model-provider/accountProviderRequestAuthService.js";
export { createAccountProviderCredentialStore } from "./model-provider/accountProviderCredentialStore.js";
export type {
  AccountProviderCredentialStore,
  AccountProviderCredentialStoreOptions,
} from "./model-provider/accountProviderCredentialStore.js";
export { importLegacyPersonalProviderConfig } from "./model-provider/legacyPersonalProviderConfigImporter.js";
export {
  createAccountProviderConfigSource,
  createAccountProviderConnectionResolver,
  createCodingPlanFamilyAvailabilityResolver,
  resolveCurrentAccountAccess,
} from "./model-provider/accountProviderConnectionResolver.js";
export { bindAccountProviderInvalidation } from "./model-provider/accountProviderInvalidation.js";
export type {
  AccountProviderConfigSourceOptions,
  AccountProviderConnectionResolverOptions,
  AccountProviderConnectionSettings,
  AccountProviderFamilyAvailabilityInput,
  AccountProviderFamilyAvailabilityResolver,
  CodingPlanFamilyAvailabilityResolverOptions,
} from "./model-provider/accountProviderConnectionResolver.js";
export {
  createProviderConfigRuntime,
  ProviderConfigRuntime,
} from "./model-provider/providerConfigRuntime.js";
export type { ProviderConfigRuntimeOptions } from "./model-provider/providerConfigRuntime.js";
export {
  createProviderRuntime,
  createProviderRuntimeFromConfigRuntime,
  EmptyAccountProviderConfigSource,
  ProviderRuntime,
} from "./model-provider/providerRuntime.js";
export type {
  ProviderRuntimeDependencies,
  ProviderRuntimeOptions,
} from "./model-provider/providerRuntime.js";
export {
  createProviderProvisioningSource,
  listProviderProvisioningCredentialKeys,
  resolveCredentialFilePath,
  type ProviderProvisioningSource,
  type ProviderProvisioningSourceOptions,
} from "./model-provider/providerProvisioningSource.js";
export {
  createProviderProvisioningTarget,
  type ProviderProvisioningTargetOptions,
} from "./model-provider/providerProvisioningTarget.js";
export {
  createModelSelectionService,
  createProviderSettingsService,
  IModelSelectionService,
  IProviderSettingsService,
} from "./model-provider/providerFacadeServices.js";
export { createAccountRequestAuthService } from "./model-provider/accountRequestAuthService.js";
export type { IAccountRequestAuthService } from "./model-provider/accountRequestAuthService.js";
export { createAccountProviderRequestAuthService } from "./model-provider/accountProviderRequestAuthService.js";
export { resolveAccountTeamPlanRuntimeApiKey } from "./model-provider/accountProviderTeamPlanRequestKey.js";
export { createAccountProviderCredentialService } from "./model-provider/accountProviderCredentialService.js";
export { createUsageStatsService } from "./usage-stats/usageStatsService.js";
// Storage：service 与 adapters 工厂；desktop host 负责组装（Worker runner 在 desktop 包内）
export { createStorageService } from "./storage/app/storageService.js";
export type {
  FsCleanerPort as StorageFsCleanerPort,
  RootsResolverPort as StorageRootsResolverPort,
  ScanRunnerPort as StorageScanRunnerPort,
  StorageScanProgress,
  StorageScanRunRequest,
} from "./storage/app/ports.js";
export { createFsStorageCleaner } from "./storage/adapters/fsCleaner.js";
export {
  createStorageRootsResolver,
  resolveStorageRoots,
} from "./storage/adapters/rootsResolver.js";
export { createFsVolumeProbe } from "./storage/adapters/volumeProbe.js";
export { runStorageScan } from "./storage/adapters/inProcessScanRunner.js";
export { createCodingPlanSubscriptionService } from "./coding-plan-subscription/codingPlanSubscriptionService.js";
export { createClientConfigService } from "./client-config/clientConfigService.js";
export { createClientScenesService } from "./client-scenes/clientScenesService.js";
export { createSkillsService } from "./skills/skillsService.js";
export { createSkillSyncService } from "./skill-sync/skillSyncService.js";
export { createMcpSyncService } from "./mcp-sync/mcpSyncService.js";
export { createSubagentsService } from "./subagents/subagentsService.js";
export { createCommandsService } from "./commands/commandsService.js";
export { createSettingsSyncService } from "./settings-sync/settingsSyncService.js";
export { createFeedbackDiagnosticArchive } from "./feedback/feedbackLogArchive.js";
export { createFeedbackService } from "./feedback/feedbackService.js";
export type { CreateFeedbackServiceOptions } from "./feedback/feedbackService.js";
export { createLocalPromptAttachmentTransferService } from "./prompt-attachment-transfer/promptAttachmentTransferService.js";
export {
  createLocalConversationShareArtifactSource,
  createRemoteConversationShareArtifactSource,
} from "./conversation-share/conversationShareArtifactSource.js";
export { createNodeApiClient, NodeApiClient } from "./providers/api/nodeApiClient.js";
export {
  createHostApiNetworkTransport,
  type HostApiNetworkTransport,
} from "./providers/api/nodeApiNetwork.js";
export {
  buildRuntimeProcessEnvPatch,
  captureLoginShellEnvSnapshot,
  normalizeRuntimeProcessEnv,
  prepareRuntimeProcessEnvPatch,
} from "./runtime-tools/runtimeCommandEnv.js";

// 定时任务管理与 scheduler 共用同一套 node-only 存储和 cron 语义。
export {
  AutomationRepo,
  DISPATCH_RETRY_BASE_MS,
  DISPATCH_RETRY_CAP_MS,
  DISPATCH_MAX_ATTEMPTS,
  CLAIM_STALE_MS,
  computeRetryAt,
} from "./session/automationRepo.js";
export { AutomationService, InvalidCronExprError } from "./session/automationService.js";
// 闲时任务与 automation 同库不同表；类型/常量全独立。
export { OffPeakTaskRepo, OFF_PEAK_CLAIM_STALE_MS } from "./session/offPeakTaskRepo.js";
// host 域终态回填 files_changed 复用现有 task diff 汇总。
export { buildTaskChangeSummary } from "./session/taskChangeSummary.js";
export { OffPeakTaskService } from "./session/offPeakTaskService.js";
export { IOffPeakTaskService } from "./session/offPeakTask.js";
export { createOffPeakServerClient, OffPeakServerError } from "./session/offPeakServerClient.js";
export { isOffPeakMockEnabled, startOffPeakMockGateway } from "./session/offPeakMockGateway.js";
export {
  buildOffPeakRequestAuth,
  createOffPeakOriginResolver,
  resolveOffPeakCredentials,
  resolveOffPeakCodingPlanSupport,
  resolveOffPeakMockUpstream,
  OffPeakCodingPlanUnavailableError,
  OffPeakCredentialsUnavailableError,
  OffPeakModelUnavailableError,
  OffPeakPermanentDispatchError,
} from "./session/offPeakRuntimeModel.js";
export { createServiceLogger } from "./logger/serviceLogger.js";
export {
  buildOfficialMcpAuthHeaders,
  createOfficialMcpAuthHeadersResolver,
  resolveOfficialMcpCredentials,
} from "./official-mcp/officialMcpCredentials.js";
export {
  computeAutomationNextRunAt,
  computeNextRunAt,
  computeScheduleRuleNextRunAt,
  isOneShotAutomation,
  isValidCronExpr,
} from "./session/automationCron.js";

import { ServiceCollection } from "./collection.js";
import { IFileService } from "./file/file.js";
import { IMediaPreviewService } from "./media-preview/mediaPreview.js";
import { IGitService } from "./git/git.js";
import { IGitCheckpointService } from "./git/gitCheckpoint.js";
import { ISystemService } from "./system/system.js";
import { ITerminalService } from "./terminal/terminal.js";
import { ISettingService } from "./setting/setting.js";
import { IOnboardingRecordService } from "./onboarding/onboardingRecord.js";
import { ICredentialService } from "./credential/credential.js";
import { IBroadcastService } from "./broadcast/broadcast.js";
import { IZCodeTaskService } from "./session/zcodeTaskService.js";
import { IZCodeAgentService } from "./zcode-agent/zcodeAgent.js";
import {
  createUnsupportedConversationShareService,
  IConversationShareService,
  type IConversationShareService as IConversationShareServiceType,
} from "./conversation-share/conversationShare.js";
import {
  ConversationShareService,
  conversationShareConnectionScopeFactory,
} from "./conversation-share/conversationShareService.js";
import { createLocalConversationShareArtifactSource } from "./conversation-share/conversationShareArtifactSource.js";
import { ConversationShareHttpClient } from "./conversation-share/conversationShareHttpClient.js";
import { IBotsService } from "./bots/bots.js";
import { IFileWatcherService } from "./fileWatcher/fileWatcher.js";
import { IOAuthService } from "./oauth/oauth.js";
import { IUsageStatsService } from "./usage-stats/usageStats.js";
import { ICodingPlanSubscriptionService } from "./coding-plan-subscription/codingPlanSubscription.js";
import { IClientScenesService } from "./client-scenes/clientScenes.js";
import { IZCodeSessionService } from "./zcode-session/zcodeSession.js";
import { ISkillsService } from "./skills/skills.js";
import { ISkillSyncService } from "./skill-sync/skillSync.js";
import { IMcpSyncService } from "./mcp-sync/mcpSync.js";
import { ISubagentsService } from "./subagents/subagents.js";
import { ICommandsService } from "./commands/commands.js";
import { ISettingsSyncService } from "./settings-sync/settingsSync.js";
import { IFeedbackService } from "./feedback/feedback.js";
import { IPromptAttachmentTransferService } from "./prompt-attachment-transfer/promptAttachmentTransfer.js";
import { createFileService } from "./file/fileService.js";
import { createMediaPreviewService } from "./media-preview/mediaPreview.js";
import type { WorkspaceFileSearchFilter } from "./file/workspaceFileMentionFilter.js";
import { createGitService } from "./git/gitService.js";
import { GitCommitMessageGenerator } from "./git/gitCommitMessageGenerator.js";
import { createGitCheckpointService } from "./git/gitCheckpointService.js";
import { createSystemService } from "./system/systemService.js";
import { createTerminalService } from "./terminal/terminalService.js";
import { createSettingServiceWithMigrations } from "./setting/settingService.js";
import { createOnboardingRecordService } from "./onboarding/onboardingRecordService.js";
import { createLegacyTeamOrganizationResolver } from "./model-provider/legacyTeamOrganizationResolver.js";
import { createObservableSettingService } from "./setting/observableSettingService.js";
import { createCredentialService } from "./credential/credentialService.js";
import { createBroadcastService } from "./broadcast/broadcastService.js";
import { createZCodeAgentService } from "./zcode-agent/zcodeAgentService.js";
import type { ZCodeAgentCommandResolver } from "./zcode-agent/zcodeAgentProcessManager.js";
import { resolveZCodeAgentPresentationSurface } from "./zcode-agent/zcodeAgentPresentationSurface.js";
import { createZCodeTaskServiceAdapter } from "./zcode-agent/zcodeTaskServiceAdapter.js";
import { createZCodeSessionService } from "./zcode-session/zcodeSessionService.js";
import { createZCodeTaskIndexSyncer } from "./zcode-agent/zcodeTaskIndexSyncer.js";
import { TaskIndexRepo } from "./session/taskIndexRepo.js";
import { createBotsService } from "./bots/botsService.js";
import { createBotRemoteWorkspaceService } from "./bots/botRemoteWorkspaceBridge.js";
import type { SessionMessageSendRequested } from "#src/session/sessionMailbox.js";
import { createFileWatcherService } from "./fileWatcher/fileWatcherService.js";
import { createOAuthService } from "./oauth/oauthService.js";
import { isCurrentOAuthCredentialRequest } from "#src/oauth/oauthUnauthorizedRequest.js";
import { createOAuthProviderLogoutHandler } from "./oauth/oauthProviderLogout.js";
import { OAuthCredentialRepo } from "./oauth/repo/oauthCredentialRepo.js";
import { readLegacyZCodeConfigProviders } from "./model-provider/legacyZCodeConfigProviderReader.js";
import { resolveAccountTeamPlanRuntimeApiKey } from "./model-provider/accountProviderTeamPlanRequestKey.js";
import { createAccountProviderCredentialStore } from "./model-provider/accountProviderCredentialStore.js";
import { createAccountProviderCredentialService } from "./model-provider/accountProviderCredentialService.js";
import { createAccountProviderRequestAuthService } from "./model-provider/accountProviderRequestAuthService.js";
import {
  createAccountProviderConfigSource,
  createCodingPlanFamilyAvailabilityResolver,
  resolveCurrentAccountAccess,
} from "./model-provider/accountProviderConnectionResolver.js";
import { bindAccountProviderInvalidation } from "./model-provider/accountProviderInvalidation.js";
import { AccountProviderApiClient } from "./model-provider/accountProviderApiClient.js";
import { AccountProviderApiKeyResolver } from "./model-provider/accountProviderApiKeyResolver.js";
import { createProviderConfigRuntime } from "./model-provider/providerConfigRuntime.js";
import { fetchZCodeBuiltinRemoteRelease } from "./model-provider/zcodeBuiltinRemoteConfig.js";
import {
  createProviderRuntimeFromConfigRuntime,
  type ProviderRuntime,
} from "./model-provider/providerRuntime.js";
import {
  IModelSelectionService,
  IProviderSettingsService,
} from "./model-provider/providerFacadeServices.js";
import { createProviderSettingsConnectivityTester } from "./model-provider/providerSettingsConnectivity.js";
import {
  createProviderProvisioningSource,
  listProviderProvisioningCredentialKeys,
  PROVIDER_PROVISIONING_OAUTH_CREDENTIAL_KEYS,
  resolveCredentialFilePath,
  type ProviderProvisioningSource,
} from "./model-provider/providerProvisioningSource.js";
import { createProviderProvisioningTarget } from "./model-provider/providerProvisioningTarget.js";
import { IProviderProvisioningTargetService } from "./model-provider/providerProvisioning.js";
import { buildOffPeakModelSelectionView } from "./model-provider/offPeakModelSelectionView.js";
import { resolveClientConfigPlatform } from "./runtime-tools/clientPlatform.js";
import {
  createAccountRequestAuthService,
  type IAccountRequestAuthService,
} from "./model-provider/accountRequestAuthService.js";
import { createUsageStatsService } from "./usage-stats/usageStatsService.js";
import { createCodingPlanSubscriptionService } from "./coding-plan-subscription/codingPlanSubscriptionService.js";
import { createClientConfigService } from "./client-config/clientConfigService.js";
import { IClientConfigService } from "./client-config/clientConfig.js";
import { createClientScenesService } from "./client-scenes/clientScenesService.js";
import { createSkillsService } from "./skills/skillsService.js";
import { createSkillSyncService } from "./skill-sync/skillSyncService.js";
import { createMcpSyncService } from "./mcp-sync/mcpSyncService.js";
import { createSubagentsService } from "./subagents/subagentsService.js";
import { createCommandsService } from "./commands/commandsService.js";
import { createSettingsSyncService } from "./settings-sync/settingsSyncService.js";
import {
  createFeedbackService,
  type CreateFeedbackServiceOptions,
} from "./feedback/feedbackService.js";
import { createLocalPromptAttachmentTransferService } from "./prompt-attachment-transfer/promptAttachmentTransferService.js";
import { createNodeApiClient } from "./providers/api/nodeApiClient.js";
import {
  createHostApiNetworkTransport,
  type HostApiNetworkTransport,
} from "./providers/api/nodeApiNetwork.js";
import type {
  RuntimeProcessLifecycleReporter,
  RuntimeTaskReporter,
} from "#src/process/runtimeProcessLifecycle.js";
import { initializeRuntimeProcessEnv } from "./runtime-tools/runtimeCommandEnv.js";
import {
  buildAgentEndpointOriginEnv,
  buildAgentRuntimeEnv,
} from "./runtime-tools/agentProxyEnv.js";
import { ensureAppCaCert } from "./runtime-tools/appCaCert.js";
import { createServiceLogger } from "#src/logger/serviceLogger.js";
import { IOffPeakTaskService } from "./session/offPeakTask.js";
import { OffPeakTaskService } from "./session/offPeakTaskService.js";
import { OffPeakTaskRepo } from "./session/offPeakTaskRepo.js";
import { createOffPeakServerClient } from "./session/offPeakServerClient.js";
import {
  buildOffPeakRequestAuth,
  createOffPeakOriginResolver,
  resolveOffPeakCredentials,
  resolveOffPeakCodingPlanSupport,
  resolveOffPeakMockUpstream,
} from "./session/offPeakRuntimeModel.js";
import {
  createOfficialMcpAuthHeadersResolver,
  resolveOfficialMcpCredentials,
} from "./official-mcp/officialMcpCredentials.js";
import {
  createOfficialMcpTrustedOriginRegistry,
  OFFICIAL_MCP_DEV_TRUSTED_ORIGINS_ENV,
} from "@zcode/shared";
import {
  DEFAULT_ZCODE_MODEL_CONTEXT_BUDGET_STRATEGY,
  resolveSafeEndpointHostname,
  ZCODE_JWT_INVALID_BROADCAST_CHANNEL,
  formatLogPrefix,
  isCredentialDecryptError,
  isStartPlanModelProviderId,
  OFF_PEAK_PROVIDER_IDS,
  BIGMODEL_PROVIDER_ID,
  type ProviderFamilyDomain,
  type ServiceAuthorityMode,
  resolveRuntimeZCodeEndpointOrigin,
  type ZCodeAutomation,
  type ZCodeAutomationRun,
  ZCODE_DESKTOP_CONTEXT_PROMPT_ENABLED_ENV,
  ZAI_PROVIDER_ID,
  zcodeAccountAccessSchema,
  zcodeProviderAccountAccessSchema,
  ZCODE_VERSION,
  buildRuntimeZCodeApiUrl,
} from "@zcode/shared";

// 这些 conversation-share 实现依赖 Node 文件系统；仅通过 @zcode/services/node 暴露，
// 防止 browser-safe 根入口把 node:* 依赖带进 renderer。
export {
  ConversationShareService,
  ConversationShareHttpClient,
  conversationShareConnectionScopeFactory,
};

interface ServiceWithDisposeAll {
  disposeAll: () => void;
}

interface ServiceWithDisposeAllAndWait {
  disposeAllAndWait: () => Promise<void>;
}

function hasDisposeAll(instance: unknown): instance is ServiceWithDisposeAll {
  return (
    typeof instance === "object" &&
    instance !== null &&
    "disposeAll" in instance &&
    typeof (instance as { disposeAll?: unknown }).disposeAll === "function"
  );
}

function hasDisposeAllAndWait(instance: unknown): instance is ServiceWithDisposeAllAndWait {
  return (
    typeof instance === "object" &&
    instance !== null &&
    typeof (instance as { disposeAllAndWait?: unknown }).disposeAllAndWait === "function"
  );
}

// 它不是 IPC 服务，不进 ServiceCollection 的 disposeAll 列表，但 host 释放时必须显式终止它，否则会以
// 已授权主体常驻、甚至在 services 重建时再起一个 → 多实例/孤儿/权限主体泄漏。用与 ServiceCollection 绑定
// 的 WeakMap 侧表登记，dispose 时统一终止（best-effort，不阻断其它资源回收）。
const providerProvisioningSources = new WeakMap<ServiceCollection, ProviderProvisioningSource>();
const providerProvisioningTriggerDisposers = new WeakMap<
  ServiceCollection,
  readonly (() => void)[]
>();
// TaskIndexRepo / OffPeakTaskRepo 等各自持有 tasks-index.sqlite 的连接句柄；
// dispose 链必须统一关闭：Windows 上句柄悬着会让宿主回收后临时目录 rm 撞 EBUSY
// （stdioDesktopPresentationSurface 单测稳定复现），Linux 的 unlink-while-open 语义掩盖了泄漏。
// 与其它侧表一样按 ServiceCollection 登记并在 dispose 时统一 close。
const sharedSqliteRepos = new WeakMap<ServiceCollection, ReadonlyArray<{ close(): void }>>();
const accountRequestAuthServices = new WeakMap<ServiceCollection, IAccountRequestAuthService>();
export type OffPeakRequestAuthBuilder = (
  ticketId: string,
) => Promise<{ apiKey: string; headers: Record<string, string> }>;
const offPeakRequestAuthBuilders = new WeakMap<ServiceCollection, OffPeakRequestAuthBuilder>();

/** Local Host 进程内能力；不会随 ServiceCollection 暴露到通用 RPC Channel。 */
export function getAccountRequestAuthService(
  services: ServiceCollection,
): IAccountRequestAuthService | undefined {
  return accountRequestAuthServices.get(services);
}

/** Local Host 进程内的 Provisioning Source；不会把凭据通过通用 RPC 暴露给 Renderer。 */
export function getProviderProvisioningSource(
  services: ServiceCollection,
): ProviderProvisioningSource | undefined {
  return providerProvisioningSources.get(services);
}

/** Local Host 私有的闲时请求鉴权装配；复用正式 Registry/Account Access 解析，不进入 RPC。 */
export function getOffPeakRequestAuthBuilder(
  services: ServiceCollection,
): OffPeakRequestAuthBuilder | undefined {
  return offPeakRequestAuthBuilders.get(services);
}
const providerRuntimes = new WeakMap<ServiceCollection, ProviderRuntime>();
const managedHostApiNetworkTransports = new WeakMap<ServiceCollection, HostApiNetworkTransport>();

export function registerHostApiNetworkTransportForDispose(
  services: ServiceCollection,
  transport: HostApiNetworkTransport,
): void {
  managedHostApiNetworkTransports.set(services, transport);
}

/**
 * 创建包含所有本地服务的 ServiceCollection
 *
 * @param options.parentPort - Electron host process 的 parentPort，
 *        用于 BroadcastService 跨窗口中转。传 null 则广播为空操作。
 */
export function createLocalServices(options: {
  parentPort?: Parameters<typeof createBroadcastService>[0];
  /** Host 装配层注入的设置权威；与网络 transport 必须来自同一 Window Host 生命周期。 */
  settingService?: ISettingService;
  /** 与注入的本地 Setting 共用写队列；外部远端 Setting 不传，由其权威 Host 完成迁移。 */
  prepareLegacyAccountConnections?: ReturnType<
    typeof createSettingServiceWithMigrations
  >["prepareLegacyAccountConnections"];
  /** 注入后由 ServiceCollection 接管释放，并供 Host 其它 app-managed 下载复用。 */
  hostApiNetworkTransport?: HostApiNetworkTransport;
  /** Desktop Host 请求 Main 登记 Agent 已授权的精确本地视频路径。 */
  authorizeLocalMediaPreviewPath?: (path: string) => Promise<string>;
  feedback?: Partial<
    Omit<CreateFeedbackServiceOptions, "apiClient" | "credentialService" | "oauthService">
  >;
  processLifecycleReporter?: RuntimeProcessLifecycleReporter;
  taskRuntimeReporter?: RuntimeTaskReporter;
  /** workspace 文件搜索默认使用内置过滤器；后续规则来源只需在 Host 装配时注入最终实现。 */
  workspaceFileSearchFilter?: WorkspaceFileSearchFilter;
  forwardSessionMessageSendRequested?: (
    request: SessionMessageSendRequested,
  ) => Promise<void> | void;
  /** desktop local host 在 manual run 落库后直接派发，不经过 scheduler 正常路径。 */
  onAutomationManualRunRequested?: (params: {
    automation: ZCodeAutomation;
    run: ZCodeAutomationRun;
  }) => Promise<void>;
  /** 闲时任务翻 schedulable 后请求宿主立即唤醒 scheduler（desktop host 注入 parentPort 转发）。 */
  onOffPeakSchedulerWakeRequested?: () => void;
  // 注入点：默认 resolver 已能覆盖 dev/桌面/SSH 远端三类形态；
  // 测试或特殊宿主想强制走自定义 binary/参数时从这里注入。
  zcodeAgentCommandResolver?: ZCodeAgentCommandResolver;
  /** Desktop Main 提前异步采集的本机 runtime 环境；Local Host 注入后不再同步启动 login shell。 */
  runtimeProcessEnvPatch?: Record<string, string>;
  /** 本地桌面上次 workspace 缺失时，仅用于 Agent 子进程 spawn.cwd 兜底。 */
  zcodeAgentSpawnFallbackCwd?: string;
  /** desktop-attached remote server 从 Desktop Host 收到的一次性 Agent 网络配置。 */
  remoteAgentNetwork?: {
    httpProxy?: string;
    noProxy?: string;
  };
  /** 所属 Environment 的 ZCode Built-in Provider Config 物理路径。 */
  zcodeBuiltinProviderConfigFilePath: string;
  /** HTTP Server 只有在调用方明确配置认证时才暴露跨 Environment Provisioning target。 */
  providerProvisioningTargetEnabled?: boolean;
  /** Desktop Host 私有通知；只在 Source 成功持久化后请求 Main 调度远端镜像。 */
  onProviderProvisioningSourceChanged?: (
    trigger: Exclude<ProviderProvisioningTrigger, "environment-online">,
  ) => void;
  serviceAuthorityMode?: ServiceAuthorityMode;
  agentRuntimeContext?: {
    getDeviceMid?: () => string | undefined;
    runtimeSurface?: "desktop_local_host" | "remote_workspace_host";
  };
}): ServiceCollection {
  const isDesktopAttachedRemote = options?.serviceAuthorityMode === "desktop-attached-remote";
  // host / remote server 以前直接沿用当前进程环境启动后续服务。
  // GUI 启动的 desktop、SSH/WSL/Docker 拉起的 remote server 往往拿不到用户 login shell 里的 PATH，
  // 导致 bun 这类只在 shell profile 里追加的命令在 ZCode Agent/终端里不可见。
  // 这里在所有本地服务启动前统一修正运行时环境，并顺带把内置 rg 注入 PATH，
  // 让 ZCode Agent、终端、认证 runtime 共用同一套命令解析结果。
  initializeRuntimeProcessEnv(options?.runtimeProcessEnvPatch);

  const desktopContextPromptEnabledRaw =
    process.env[ZCODE_DESKTOP_CONTEXT_PROMPT_ENABLED_ENV]?.trim();
  const desktopContextPromptEnabled =
    desktopContextPromptEnabledRaw === "1"
      ? true
      : desktopContextPromptEnabledRaw === "0"
        ? false
        : undefined;

  // app 自签 CA：首次启动生成一份根 CA（幂等），供 agent 子进程经 NODE_EXTRA_CA_CERTS 信任、
  // 出口代理用其私钥重签。生成失败不应阻断启动（例如只读文件系统），仅记录日志后继续。
  try {
    ensureAppCaCert();
  } catch (error) {
    console.error(formatLogPrefix("appCaCert", process.pid), "ensure app CA cert failed:", error);
  }

  const localSettings = options?.settingService ? null : createSettingServiceWithMigrations();
  const settingService = createObservableSettingService(
    options?.settingService ?? localSettings!.service,
  );
  const resolveCurrentZCodeEndpointOrigin = async () =>
    resolveRuntimeZCodeEndpointOrigin(process.env, {
      overrideOrigin: (await settingService.get()).zcodeEndpointOrigin,
    });
  const provisioningOAuthKeys = new Set<string>(PROVIDER_PROVISIONING_OAUTH_CREDENTIAL_KEYS);
  const credentialService = createCredentialService({
    onDidMutate: ({ key }) => {
      if (provisioningOAuthKeys.has(key) || isProviderProvisioningAccountCredentialKey(key)) {
        options.onProviderProvisioningSourceChanged?.("credential");
      }
    },
  });
  const accountProviderCredentialStore = createAccountProviderCredentialStore({
    credentialService,
  });
  const broadcastService = createBroadcastService(options?.parentPort ?? null);
  const gitCheckpointService = createGitCheckpointService();
  const hostApiNetworkTransport =
    options?.hostApiNetworkTransport ??
    createHostApiNetworkTransport(async () => {
      const settings = await settingService.get();
      return {
        httpProxy: settings.httpProxy,
        noProxy: settings.httpProxyNoProxy,
        caCertPath: settings.httpProxyCaCertPath,
      };
    });
  const zcodeJwtLogoutHandlerRef: {
    current: ((input: string | URL, headers: Headers) => void) | null;
  } = { current: null };
  const apiClient = createNodeApiClient({
    fetchImpl: hostApiNetworkTransport.fetch,
    onZcodeJwtInvalid: (input, headers) => zcodeJwtLogoutHandlerRef.current?.(input, headers),
    isZcodeJwtRequest: (input, headers) =>
      isCurrentOAuthCredentialRequest({ input, headers, credentialService }),
    resolveZCodeEndpointOrigin: resolveCurrentZCodeEndpointOrigin,
  });
  const systemService = createSystemService();
  // onboarding 资格与任务列表共用同一份全局 tasks-index；repo 懒加载数据库，提前构造不会
  // 增加启动 I/O，后续 session syncer 也继续复用这一实例。
  const taskIndexRepo = new TaskIndexRepo();
  // onboarding 完成记录：userId 由登录态补全（apikey/未登录为 null）。
  const onboardingRecordService = createOnboardingRecordService({
    loadUserId: async () => (await oauthCredentialRepo.loadActiveUserProfile())?.id ?? null,
    hasExistingLocalTask: async () => (await taskIndexRepo.listTaskMetas({})).length > 0,
  });
  let handleOAuthProviderLogout: ReturnType<typeof createOAuthProviderLogoutHandler> | null = null;
  const oauthCredentialRepo = new OAuthCredentialRepo(credentialService, {
    onCorruptOAuthSessionCleared: async (providers) => {
      // telemetry 之外的后台路径可能先读到损坏 OAuth 凭据。
      // 这类恢复也必须等价于 logout，复用同一 handler 清理派生模型 provider key。
      await Promise.all(
        providers.map((provider) => handleOAuthProviderLogout?.(provider) ?? Promise.resolve()),
      );
    },
  });
  const accountProviderApiKeyRemoteClient = new AccountProviderApiClient(apiClient);
  const accountProviderApiKeyResolver = new AccountProviderApiKeyResolver(
    accountProviderApiKeyRemoteClient.fetchRemoteData.bind(accountProviderApiKeyRemoteClient),
  );
  const accountProviderCredentialService = createAccountProviderCredentialService({
    credentialStore: accountProviderCredentialStore,
    async loadOAuthAccessToken(family) {
      const oauthProviderId = family === "zai" ? ZAI_PROVIDER_ID : BIGMODEL_PROVIDER_ID;
      return (await oauthCredentialRepo.loadTokenSet(oauthProviderId))?.accessToken ?? null;
    },
    resolveProviderApiKey: (family, accessToken) =>
      accountProviderApiKeyResolver.resolveProviderApiKey(
        family === "zai" ? ZAI_PROVIDER_ID : BIGMODEL_PROVIDER_ID,
        accessToken,
      ),
  });
  const resolveLegacyTeamOrganization = createLegacyTeamOrganizationResolver({
    apiClient,
    loadOAuthTokenSet: (family) =>
      oauthCredentialRepo.loadTokenSet(family === "zai" ? ZAI_PROVIDER_ID : BIGMODEL_PROVIDER_ID),
  });
  const readAccountProviderSettings = async () => {
    // 迁移只在账号事实入口协调。ApiClient 的代理/端点仍读普通 Setting，不递归等待迁移。
    // 外部注入的 Setting（远端 attachment）由其所属 Host 管理，不读取本机旧文件。
    const prepare =
      options?.prepareLegacyAccountConnections ?? localSettings?.prepareLegacyAccountConnections;
    const unresolvedFamilies = (await prepare?.(resolveLegacyTeamOrganization)) ?? [];
    const settings = await settingService.get();
    return {
      providerFamilyDomain: settings.providerFamilyDomain ?? null,
      selections: settings.providerFamilyConnectionSelections ?? {},
      unresolvedFamilies,
    };
  };
  const loadAccountIdentity = async (family: ProviderFamilyDomain) => {
    const oauthProviderId = family === "zai" ? ZAI_PROVIDER_ID : BIGMODEL_PROVIDER_ID;
    return (await oauthCredentialRepo.loadUserProfile(oauthProviderId))?.id ?? null;
  };
  const accountRequestAuthService = createAccountRequestAuthService(
    createAccountProviderRequestAuthService({
      resolveCurrentAccountAccess: (access) =>
        resolveCurrentAccountAccess({
          access,
          readSettings: readAccountProviderSettings,
          loadAccountIdentity,
        }),
      loadOAuthTokenSet: (providerId) => oauthCredentialRepo.loadTokenSet(providerId),
      async loadIndividualPlanApiKey(providerId, family) {
        const oauthProviderId = family === "zai" ? ZAI_PROVIDER_ID : BIGMODEL_PROVIDER_ID;
        const accountIdentity = (await oauthCredentialRepo.loadUserProfile(oauthProviderId))?.id;
        if (!accountIdentity) return null;
        return accountProviderCredentialService.loadCodingPlanApiKey({
          providerId,
          family,
          accountIdentity,
        });
      },
      resolveTeamPlanApiKey: (access) =>
        resolveAccountTeamPlanRuntimeApiKey({ apiClient, credentialService, access }),
    }),
  );
  const providerConfigLog = createServiceLogger("provider-config");
  const clientConfigPlatform = resolveClientConfigPlatform();
  const providerConfigRuntime = createProviderConfigRuntime({
    zcodeBuiltinFilePath: options.zcodeBuiltinProviderConfigFilePath,
    zcodeBuiltinEnvironment: {
      environmentConfigRoot: resolveAppConfigDir(),
      platform: clientConfigPlatform,
      appVersion: ZCODE_VERSION,
      resolveEndpointOrigin: resolveCurrentZCodeEndpointOrigin,
      onRefreshResult: (event) => {
        if (event.result === "updated")
          providerConfigLog.info(undefined, "ZCode Built-in CDN 配置已更新", event);
        else providerConfigLog.debug(undefined, "ZCode Built-in 刷新检查", event);
      },
      fetchRelease: (endpointOrigin, signal) =>
        fetchZCodeBuiltinRemoteRelease({
          apiClient,
          endpointOrigin,
          signal,
          appVersion: ZCODE_VERSION,
          platform: clientConfigPlatform,
        }),
    },
    onZCodeBuiltinRefreshError: (error) => {
      providerConfigLog.warn(undefined, "ZCode Built-in Config 远端刷新失败", { error });
    },
    onPersonalConfigRecovery: (event) => {
      providerConfigLog.warn(
        undefined,
        "Personal Provider Config 加载失败，已保留磁盘状态并以内存空配置降级",
        {
          error: event.error,
        },
      );
    },
    onPersonalConfigPollingError: (error) => {
      // 轮询错误只在进入失败状态时回调一次；下一轮仍会自行重试，避免持续故障刷盘。
      providerConfigLog.warn(undefined, "Personal Provider Config 轮询暂时失败，将继续重试", {
        error,
      });
    },
    // 已发布 config.json 保存的是 ZCode 用户配置；清理第三方 ACP 不能移除这条升级路径。
    // Repository 仅在新 Personal 配置不存在时导入，并保留旧文件以便回滚。
    readLegacyProviders: () => readLegacyZCodeConfigProviders(),
  });
  const accountProviderConfigSource = createAccountProviderConfigSource({
    configSource: providerConfigRuntime.configService,
    readSettings: readAccountProviderSettings,
    async loadCodingPlanApiKey(providerId, family, accountIdentity, forceRefresh) {
      if (isStartPlanModelProviderId(providerId)) return null;
      return accountProviderCredentialService.loadCodingPlanApiKey({
        providerId,
        family,
        accountIdentity,
        forceRefresh,
      });
    },
    loadAccountIdentity,
    resolveFamilyAvailability: createCodingPlanFamilyAvailabilityResolver({
      apiClient,
      credentialService,
    }),
  });
  const accountProviderRuntimeLog = createServiceLogger("account-provider-runtime");
  const modelSelectionConfiguredDefaultSource = new NodeModelSelectionConfigRepository({
    personalRepository: providerConfigRuntime.personalRepository,
  });
  const providerProvisioningSource = createProviderProvisioningSource({
    personalRepository: providerConfigRuntime.personalRepository,
    settingService,
    credentialFilePath: resolveCredentialFilePath(resolveAppConfigDir()),
    personalConfigFilePath: join(resolveAppConfigDir(), PERSONAL_PROVIDER_CONFIG_FILE_NAME),
  });
  const providerProvisioningDisposers = [
    providerConfigRuntime.configService.onDidChange((reason) => {
      // 每个 Window Host 都会轮询同一文件；只把本进程成功提交的 updated
      // 作为同步触发，避免其它 Host 的 poll-changed 把一次保存重复计入多个代际。
      if (reason === "personal:updated") {
        options.onProviderProvisioningSourceChanged?.("personal-config");
      }
    }),
    settingService.onDidUpdate((event) => {
      if (
        event.keys.includes("providerFamilyDomain") ||
        event.keys.includes("providerFamilyConnectionSelections")
      ) {
        options.onProviderProvisioningSourceChanged?.("account-settings");
      }
    }),
  ];
  const disposeAccountProviderInvalidation = bindAccountProviderInvalidation({
    onDidUpdateSetting: (listener) => settingService.onDidUpdate(listener),
    refresh: (reason) => accountProviderConfigSource.refresh(reason),
  });
  const accountProviderRefreshErrorDispose = accountProviderConfigSource.onDidRefreshError(
    (event) => {
      accountProviderRuntimeLog.warn(undefined, "account provider source refresh failed", {
        error: event.error,
        reasons: event.reasons,
      });
    },
  );
  let providerConnectivityAgentService:
    | Pick<IZCodeAgentService, "testModelConnectivity">
    | undefined;
  const providerRuntime = createProviderRuntimeFromConfigRuntime({
    configRuntime: providerConfigRuntime,
    accountSource: accountProviderConfigSource,
    modelSelectionConfiguredDefaultSource,
    disposeModelSelectionConfiguredDefaultSource: () =>
      modelSelectionConfiguredDefaultSource.dispose(),
    testConnectivity: createProviderSettingsConnectivityTester({
      testModelConnectivity: async (input) => {
        if (!providerConnectivityAgentService) {
          throw new Error("Agent Service 尚未完成模型连通性测试装配");
        }
        return providerConnectivityAgentService.testModelConnectivity(input);
      },
    }),
    disposeAccountSource: () => {
      disposeAccountProviderInvalidation();
      accountProviderRefreshErrorDispose();
      accountProviderConfigSource.dispose();
    },
  });
  handleOAuthProviderLogout = createOAuthProviderLogoutHandler({
    accountProviderCredentialStore,
    refreshAccountProviders: (reason: string) => accountProviderConfigSource.refresh(reason),
  });
  // 官方 Server MCP 的凭证解析源。MCP 调用的身份头与 MCP 额度查询（/api/v1/mcp/usage）
  // 必须共用这一份实现，否则两处对"当前选中的 Coding Plan 连接"的判定会分叉。
  // 额度侧注入的是凭证解析而非 resolveHeaders：归属校验需要 providerFamily，
  // 而身份头里没有 family；身份头仍由同一个 buildOfficialMcpAuthHeaders 构造。
  const officialMcpCredentialSource = {
    resolve: () =>
      resolveOfficialMcpCredentials({
        accountRequestAuthService,
        credentialService,
        modelSelectionService: providerRuntime.modelSelection,
      }),
  };
  // mcpSync 里引用 zcodeAgentService 的闭包是惰性调用，声明顺序不影响初始化。
  const skillsService = createSkillsService({ isDesktopRuntime: true });
  const mcpSyncService = createMcpSyncService({
    // mcp/list 的 host 消费点收拢到 mcpSync 服务；真实状态检查仍在 agent 进程。
    listMcpServerStatuses: (params) => zcodeAgentService.listMcpServerStatuses(params),
  });
  const subagentsService = createSubagentsService({
    isDesktopRuntime: true,
  });
  const commandsService = createCommandsService({ isDesktopRuntime: true });
  // 只要当前进程已经装配 Provider Runtime，就由该 Environment 自己的 Selection View
  // 决定执行就绪状态。Desktop-attached remote 也读取远端自己的 Config/Account Facts。
  const modelSelectionReadinessSource = providerRuntime.modelSelection;
  const agentAccountProviderConfigSource = accountProviderConfigSource;
  const codingPlanSubscriptionService = createCodingPlanSubscriptionService({
    apiClient,
    credentialService,
    resolveOffPeakModelSelectionView: async () => {
      await providerRuntime.start();
      return buildOffPeakModelSelectionView(providerRuntime.registryService.getView());
    },
  });
  // OffPeakTaskService 单例在下方 DI register IIFE 中创建（晚于 agent service）；
  // 用前向引用 holder 惰性绑定——offPeak/create 协议请求只会发生在服务集合装配完成后。
  let offPeakTaskServiceForAgent: OffPeakTaskService | undefined;
  // desktop-attached-remote 装配不暴露 Off-Peak 工具面（远程不在支持范围）。
  const offPeakToolWiring =
    options?.serviceAuthorityMode === "desktop-attached-remote"
      ? {}
      : {
          resolveOffPeakClientConfig: () => codingPlanSubscriptionService.getOffPeakClientConfig(),
          resolveOffPeakTaskService: () => offPeakTaskServiceForAgent,
        };
  const zcodeAgentService = createZCodeAgentService({
    ...(agentAccountProviderConfigSource
      ? { accountProviderConfigSource: agentAccountProviderConfigSource }
      : {}),
    accountRequestAuthService,
    ...(modelSelectionReadinessSource ? { modelSelectionReadinessSource } : {}),
    authorizeLocalMediaPreviewPath: options?.authorizeLocalMediaPreviewPath,
    ...offPeakToolWiring,
    // 动态工作流灰度：与 Off-Peak 不同，
    // 这里不按 serviceAuthorityMode 裁剪——SSH/WSL/Docker 的 desktop-attached-remote Host
    // 是它自己那些 workspace 的唯一裁决者，灰度开启时远程 workspace 同样提供工作流。
    resolveDynamicWorkflowClientConfig: () =>
      codingPlanSubscriptionService.getDynamicWorkflowClientConfig(),
    commandResolver: options?.zcodeAgentCommandResolver,
    presentationSurface: resolveZCodeAgentPresentationSurface({
      runtimeSurface: options?.agentRuntimeContext?.runtimeSurface,
      serviceAuthorityMode: options?.serviceAuthorityMode,
      desktopContextPromptEnabled,
    }),
    onAutomationManualRunRequested: options?.onAutomationManualRunRequested,
    // createLocalServices 虽然暴露了 reporter 注入点，旧装配却没有继续传给
    // ZCodeAgentProcessManager，导致 host 永远不向 main 上报 Agent spawn/exit，进程监控器
    // 因而看不到实际运行的 Agent，也无法验证只读到可写升级是否复用同一进程。
    processLifecycleReporter: options?.processLifecycleReporter,
    spawnFallbackCwd: options?.zcodeAgentSpawnFallbackCwd,
    // 官方 Server MCP 身份头：host 是唯一身份权威，Agent 经反向请求索取。
    // Provider 存在性读取正式 Model Selection View；不恢复旧 Provider Snapshot。
    officialMcpAuthHeadersResolver: createOfficialMcpAuthHeadersResolver({
      accountRequestAuthService,
      credentialService,
      modelSelectionService: providerRuntime.modelSelection,
    }),
    // host 是身份权威边界：provenance/origin 必须在这里再校验一次，不能只依赖 agent
    // adapter 的 fetch wrapper。判定实现与 CLI 侧共用 @zcode/shared 的同一份，避免分叉。
    // origin 解析复用 resolveCurrentZCodeEndpointOrigin——与闲时任务同口径（含 settings
    // 覆盖），否则会出现"闲时任务能连、官方 MCP 连不上"。
    // dev 开关必须同样传入，否则本地自测会被 host 单方面拒绝。
    officialMcpTrustedOrigins: createOfficialMcpTrustedOriginRegistry({
      devTrustedOriginsRaw: process.env[OFFICIAL_MCP_DEV_TRUSTED_ORIGINS_ENV],
      resolveZCodeApiOrigin: resolveCurrentZCodeEndpointOrigin,
    }),
    resolveSpawnEnv: async (context) => {
      const [settings] = await Promise.all([settingService.get(), providerRuntime.start()]);
      // 内置 Subagent 的旧覆盖必须在 CLI 独立读取之前导入，不能等待设置页操作。
      await subagentsService.prepareRuntimeState();
      const agentNetwork =
        isDesktopAttachedRemote && options?.remoteAgentNetwork
          ? options.remoteAgentNetwork
          : {
              httpProxy: settings.httpProxy,
              noProxy: settings.httpProxyNoProxy,
            };
      // Host 是旧配置迁移的唯一写入者。Agent spawn 前等待初始化完成，避免 Worker
      // 先拿到尚不存在的 provider_config.json 并发布短暂空 Registry。
      await providerConfigRuntime.start();
      return {
        ...buildAgentRuntimeEnv({
          httpProxy: agentNetwork.httpProxy,
          noProxy: agentNetwork.noProxy,
          caCertPath: settings.httpProxyCaCertPath,
        }),
        // 把 host 解析出的权威 origin（含 settings 覆盖）下发给 agent，否则 agent 侧只按
        // env 推导，test env + 自定义端点时两侧信任判定的输入分叉、官方 MCP 整体 fail closed。
        ...buildAgentEndpointOriginEnv(await resolveCurrentZCodeEndpointOrigin()),
        ...createNodeProviderRuntimePathEnv({
          // Built-in Active 路径按当前 Endpoint 隔离，不能通过同步的固定路径
          // getter 读取；Agent spawn 必须等待本轮 Endpoint Source 完成解析和物化。
          zcodeBuiltinFilePath: await providerConfigRuntime.resolveZCodeBuiltinActiveFilePath(),
          personalFilePath: join(resolveAppConfigDir(), PERSONAL_PROVIDER_CONFIG_FILE_NAME),
        }),
      };
    },
    ...(isDesktopAttachedRemote
      ? { sessionRuntimePreferencesAuthority: "external" as const }
      : {
          sessionRuntimePreferencesAuthority: "local" as const,
          resolveSessionRuntimePreferences: async (scope) => {
            // 预算已统一，不能把可选远端配置作为本地/手机 shared-host 建会话的前置条件。
            const settings = await settingService.get();
            const modelContextBudgetStrategy = DEFAULT_ZCODE_MODEL_CONTEXT_BUDGET_STRATEGY;
            return {
              askUserQuestionAutoResolutionEnabled:
                settings.askUserQuestionAutoResolutionEnabled !== false,
              nativeSearchEnhancementsEnabled: settings.nativeSearchEnhancementsEnabled !== false,
              modelContextBudgetStrategy,
              // user-execution 只消费 Shell；共享默认策略是统一 result schema 的兼容占位，
              // 不会覆盖 runtime-materialization 阶段已经固定的 strategy。
              ...(scope === "user-execution" && settings.integratedTerminalShell
                ? { integratedTerminalShell: settings.integratedTerminalShell }
                : {}),
            };
          },
        }),
  });
  providerConnectivityAgentService = zcodeAgentService;
  // desktop-continuous UI 直接订阅 zcodeSessionService，绕开 ZCode task adapter 的
  // mapServiceEvent 路径，导致 task_complete 永远不会写回 sqlite，侧边栏 spinner 不停。
  // 在 services 层装配一个共享的 taskIndexRepo + syncer，session 任意入口都会唤醒
  // shadow 订阅，把 runtime 终态收敛进 sqlite。
  const zcodeTaskIndexSyncer = createZCodeTaskIndexSyncer({
    agentService: zcodeAgentService,
    taskIndexRepo,
  });
  const zcodeSessionService = createZCodeSessionService({
    agentService: zcodeAgentService,
    taskIndexSyncer: zcodeTaskIndexSyncer,
  });
  const gitCommitMessageGenerator = new GitCommitMessageGenerator({
    currentModelProvider: {
      async readCurrentModel() {
        // Git sidecar 属于目标 Environment；初始模型直接读取同一 Host View，
        // 不再通过临时 Agent workspace state 反推模型与 reasoning。
        return (await providerRuntime.modelSelection.getView()).preferredSelection ?? null;
      },
    },
    textGenerator: {
      async generateText(params) {
        return await zcodeAgentService.generateWorkspaceText({
          workspacePath: params.workspacePath,
          ...(params.workspaceIdentity ? { workspaceIdentity: params.workspaceIdentity } : {}),
          selection: params.selection,
          prompt: params.prompt,
          querySource: params.querySource,
        });
      },
    },
    logger: createServiceLogger("git-commit-message"),
  });
  const gitService = createGitService({
    commitMessageGenerator: gitCommitMessageGenerator,
  });
  // task wrapper 由 ZCode task service adapter 提供；核心 session 状态由 ZCode agent server 维护。
  const zcodeTaskService = createZCodeTaskServiceAdapter({
    zcodeAgentService,
    taskIndexRepo,
    taskIndexSyncer: zcodeTaskIndexSyncer,
    settingService,
  });
  const botRemoteWorkspaceService = createBotRemoteWorkspaceService({
    parentPort: options?.parentPort,
    settingService,
    credentialService,
  });
  const oauthService = createOAuthService(credentialService, {
    apiClient,
    onProviderLogout: handleOAuthProviderLogout,
  });
  const zcodeJwtLogoutLogger = createServiceLogger("zcode-jwt-logout");
  zcodeJwtLogoutHandlerRef.current = (input, headers) => {
    // 条件退出本身已串行去重；不能丢弃等待旧候选期间到来的新凭据 401。
    void oauthService
      .logoutIfCurrentCredentialRequest(input, headers)
      .then((invalidated) => {
        // 401 分类后可能已完成新登录；只有队列内真正清理的旧会话才广播过期。
        if (invalidated) {
          void broadcastService.send({
            channel: ZCODE_JWT_INVALID_BROADCAST_CHANNEL,
            payload: {},
          });
        }
      })
      .catch((error) => {
        zcodeJwtLogoutLogger.warn("ZCode JWT logout failed", { error });
      });
  };
  // Desktop Host 曾从 Settings View 再扫描一次 Account Provider，既绕开
  // Registry 的 entitlement/executable 事实，也在多个套餐同时可见时无法唯一选择。
  // 闲时服务与 Host 派发必须共享同一个 Registry-backed 凭据解析闭包。
  const offPeakCredentialResolverDeps = {
    credentialService,
    accountRequestAuthService,
    resolveAccountProvider: async () => {
      await providerRuntime.start();
      // start 缓存的是首次就绪；账号后到或切换后必须读 Registry 最近完成的快照。
      const snapshot = providerRuntime.registryService.getSnapshot()!;
      const providers = snapshot.resolution.registryProviders.filter(
        (candidate) =>
          candidate.config.access.type === "zhipu-account" &&
          (candidate.config.access.mode === "individual-coding-plan" ||
            candidate.config.access.mode === "team-coding-plan"),
      );
      if (providers.length !== 1) return null;
      const provider = providers[0]!;
      const config = provider.config;
      const staticAccess = zcodeProviderAccountAccessSchema.parse(config.access.toJSON());
      const access = await accountRequestAuthService.resolveAccessCurrent(staticAccess);
      if (!access) return null;
      return {
        providerId: provider.providerId,
        access: zcodeAccountAccessSchema.parse(access),
        ...(config.api?.baseUrl ? { baseURL: config.api.baseUrl } : {}),
      };
    },
  };
  const buildOffPeakRequestAuthForTicket: OffPeakRequestAuthBuilder = async (ticketId) =>
    buildOffPeakRequestAuth({
      credentials: await resolveOffPeakCredentials(offPeakCredentialResolverDeps),
      ticketId,
    });
  const fileService = createFileService({
    workspaceFileSearchFilter: options?.workspaceFileSearchFilter,
  });
  const mediaPreviewService = createMediaPreviewService({
    fileService,
    authorizeLocalMediaPreviewPath: options?.authorizeLocalMediaPreviewPath,
    createLocalMediaPreviewUrl: buildLocalMediaPreviewUrl,
  });
  const conversationShareClient = new ConversationShareHttpClient({
    // 分享运行时始终走真实 API；测试/Mock 场景应在 service 单测或 Web fixture 中显式注入，
    // 不能让开发环境默认生成仅存在于进程内存的 mock-share 链接。
    apiClient,
    baseUrl: buildRuntimeZCodeApiUrl(process.env, "/api/v1"),
    tokenProvider: async (): Promise<string | null> => {
      const activeProvider = await oauthCredentialRepo.getActiveProvider();
      if (!activeProvider) {
        return null;
      }
      const tokenSet = await oauthCredentialRepo.loadTokenSet(activeProvider);
      return tokenSet?.zcodeJwtToken ?? tokenSet?.accessToken ?? null;
    },
  });
  const conversationShareService: IConversationShareServiceType = isDesktopAttachedRemote
    ? createUnsupportedConversationShareService({
        message: "Conversation publishing is not available for remote workspaces",
      })
    : new ConversationShareService({
        zcodeAgentService,
        zcodeSessionService,
        client: conversationShareClient,
        artifactSource: createLocalConversationShareArtifactSource(),
      });
  // 注册链上的懒工厂（如 OffPeak）会各自创建 tasks-index sqlite repo；先收集到本数组，
  // services 集合建好后在 return 前统一登记进 sharedSqliteRepos 侧表
  const sqliteReposToClose: Array<{ close(): void }> = [];
  const services = new ServiceCollection()
    .register(IFileService, fileService)
    .register(IMediaPreviewService, mediaPreviewService)
    .register(IGitService, gitService)
    .register(IGitCheckpointService, gitCheckpointService)
    .register(ISystemService, systemService)
    .register(ITerminalService, createTerminalService({ settingService }))
    .register(ISettingService, settingService)
    .register(IOnboardingRecordService, onboardingRecordService)
    .register(ICredentialService, credentialService)
    .register(IBroadcastService, broadcastService)
    .register(IZCodeTaskService, zcodeTaskService)
    .register(IZCodeAgentService, zcodeAgentService)
    .register(IZCodeSessionService, zcodeSessionService)
    .register(IConversationShareService, conversationShareService)
    .register(
      IBotsService,
      createBotsService({
        credentialService,
        zcodeTaskService,
        broadcastService,
        settingService,
        modelSelectionService: providerRuntime.modelSelection,
        remoteWorkspaceService: botRemoteWorkspaceService,
        // 远端与本地 Bot 都读取所属 Environment 的 Model Selection View。
        // 远端启动期不再轮询旧 Preset，避免重新制造一套模型候选事实。
        runStartupBackgroundTasks: !isDesktopAttachedRemote,
      }),
    )
    .register(IFileWatcherService, createFileWatcherService())
    .register(IOAuthService, oauthService)
    .register(
      IUsageStatsService,
      createUsageStatsService({
        apiClient,
        accountRequestAuthService,
        credentialService,
        zcodeAgentService,
        officialMcpCredentialSource,
      }),
    )
    .register(ICodingPlanSubscriptionService, codingPlanSubscriptionService)
    .register(
      IClientConfigService,
      createClientConfigService({
        apiClient,
        resolveRequestContext: async () => ({
          endpointOrigin: await resolveCurrentZCodeEndpointOrigin(),
          appVersion: ZCODE_VERSION,
          platform: `${process.platform}-${process.arch}`,
        }),
      }),
    )
    .register(IClientScenesService, createClientScenesService({ apiClient }))
    .register(
      IOffPeakTaskService,
      (() => {
        // 闲时任务编排服务（与 automation 服务面独立）：
        // 单例属主在本集合，renderer 经 ProxyChannel 直连，host 派发经 getOptional 取同一实例。
        const offPeakLogger = createServiceLogger("off-peak");
        const resolveCredentials = () => resolveOffPeakCredentials(offPeakCredentialResolverDeps);
        const originResolver = createOffPeakOriginResolver({
          logger: offPeakLogger,
          resolveUpstream: () => resolveOffPeakMockUpstream(offPeakCredentialResolverDeps),
        });
        const offPeakTaskRepo = new OffPeakTaskRepo();
        // OffPeakTaskRepo 也持有 tasks-index.sqlite 连接；收集到链前数组，services 建好后统一登记
        // （工厂在注册链求值期执行，此时 services 常量尚未初始化，不能直接引用）
        sqliteReposToClose.push(offPeakTaskRepo);
        const offPeakTaskService = new OffPeakTaskService({
          repo: offPeakTaskRepo,
          client: createOffPeakServerClient({
            resolveOrigin: originResolver.resolveOrigin,
            resolveCredentials,
            logger: offPeakLogger,
          }),
          resolveCodingPlanSupport: () =>
            resolveOffPeakCodingPlanSupport(offPeakCredentialResolverDeps),
          resolveTelemetryProviderName: async () =>
            resolveSafeEndpointHostname(await originResolver.resolveOrigin()),
          resolveModelSelection: async (input) => {
            await providerRuntime.start();
            const support = await resolveOffPeakCodingPlanSupport(offPeakCredentialResolverDeps);
            const providerId = support.supported
              ? OFF_PEAK_PROVIDER_IDS[support.providerFamily]
              : undefined;
            const provider = providerId
              ? providerRuntime.registryService
                  .getView()
                  .providers.find((candidate) => candidate.providerId === providerId)
              : undefined;
            const modelId = input.modelId ?? provider?.models[0]?.modelId;
            if (!provider || !modelId) {
              return {
                ok: false as const,
                validation: {
                  ok: false as const,
                  code: "provider-not-found" as const,
                  providerId: OFF_PEAK_PROVIDER_IDS.zai,
                },
              };
            }
            // 旧行没有 Provider 身份；只能复用当前账号凭据链已裁定的 Account Family，
            // 不能靠 Registry/JSON 顺序在 Z.ai 与 BigModel 间猜测。
            const selection = {
              providerId: provider.providerId,
              modelId,
              ...(input.reasoningLevel
                ? { options: { reasoningLevel: input.reasoningLevel } }
                : {}),
            };
            const validation = providerRuntime.registryService.validateSelection(selection);
            return validation.ok
              ? { ok: true as const, selection }
              : { ok: false as const, validation };
          },
          logger: offPeakLogger,
          requestSchedulerWake: options?.onOffPeakSchedulerWakeRequested,
          stopRunningTask: async (params) => {
            await zcodeTaskService.stopGeneration({
              taskId: params.conversationId,
              workspacePath: params.workspacePath,
              ...(params.workspaceIdentity ? { workspaceIdentity: params.workspaceIdentity } : {}),
            });
          },
          onDispose: () => {
            void originResolver.close().catch(() => undefined);
          },
        });
        offPeakTaskService.startSync();
        // 回写前向引用，供 zcodeAgentService 的 offPeak/create、offPeak/list 协议 handler 调用。
        offPeakTaskServiceForAgent = offPeakTaskService;
        return offPeakTaskService;
      })(),
    )
    .register(ISkillsService, skillsService)
    .register(ISkillSyncService, createSkillSyncService())
    .register(IMcpSyncService, mcpSyncService)
    .register(ISubagentsService, subagentsService)
    .register(ICommandsService, createCommandsService({ isDesktopRuntime: true }))
    .register(ISettingsSyncService, createSettingsSyncService({ settingService }))
    .register(
      IFeedbackService,
      createFeedbackService({
        ...options?.feedback,
        apiClient,
        credentialService,
        oauthService,
      }),
    )
    .register(IPromptAttachmentTransferService, createLocalPromptAttachmentTransferService());

  registerHostApiNetworkTransportForDispose(services, hostApiNetworkTransport);

  accountRequestAuthServices.set(services, accountRequestAuthService);
  offPeakRequestAuthBuilders.set(services, buildOffPeakRequestAuthForTicket);

  providerRuntimes.set(services, providerRuntime);
  providerProvisioningSources.set(services, providerProvisioningSource);
  providerProvisioningTriggerDisposers.set(services, providerProvisioningDisposers);
  services
    .register(IProviderSettingsService, providerRuntime.providerSettings)
    .register(IModelSelectionService, providerRuntime.modelSelection);
  if (isDesktopAttachedRemote || options.providerProvisioningTargetEnabled === true) {
    services.register(
      IProviderProvisioningTargetService,
      createProviderProvisioningTarget({
        providerRuntime,
        personalRepository: providerConfigRuntime.personalRepository,
        accountProviderSource: accountProviderConfigSource,
        credentialService,
        settingService,
        personalConfigFilePath: join(resolveAppConfigDir(), PERSONAL_PROVIDER_CONFIG_FILE_NAME),
        stateFilePath: join(resolveAppConfigDir(), "runtime", "provider", "provisioning.json"),
        listProvisioningCredentialKeys: () =>
          listProviderProvisioningCredentialKeys(resolveCredentialFilePath(resolveAppConfigDir())),
      }),
    );
  }
  const log = createServiceLogger("provider-runtime");
  void providerRuntime.start().then(
    () => {
      const snapshot = providerRuntime.registryService.getSnapshot()!;
      log.info("Provider Registry 已就绪", {
        configRevision: snapshot.sourceRevisions.config,
        providerCount: snapshot.registry.providers.length,
      });
    },
    (error: unknown) => {
      log.error("Provider 配置事实初始化失败", error);
    },
  );

  // 见 sharedSqliteRepos 声明处注释：登记全部 tasks-index sqlite 句柄，dispose 链统一关闭
  sqliteReposToClose.push(taskIndexRepo);
  sharedSqliteRepos.set(services, sqliteReposToClose);
  return services;
}

export function createTelemetryUserIdLoader(
  credentialService: Pick<ICredentialService, "load">,
): () => Promise<string> {
  const log = createServiceLogger("telemetry-user-id");
  return async () => {
    try {
      const activeProvider = (await credentialService.load("oauth:active_provider"))?.trim() ?? "";
      if (!activeProvider) {
        return "";
      }

      const rawUserInfo = await credentialService.load(`oauth:${activeProvider}:user_info`);
      return readTelemetryOAuthUserId(rawUserInfo);
    } catch (error) {
      if (!isCredentialDecryptError(error)) {
        throw error;
      }

      // Bugfix: telemetry 只是只读 userId 上报入口，不能抢在 host OAuthService 前
      // 对损坏凭据做半套清理；否则会漏掉派生模型 provider key 的 logout 收口。
      log.warn(undefined, "skip telemetry user id: OAuth credential decrypt failed", error);
      return "";
    }
  };
}

/** 仅给同一事件账号返回当前 ZCode JWT；不缓存、不修改登录凭据。 */
export function createTelemetryAuthorizationLoader(
  credentialService: Pick<ICredentialService, "load">,
): (userId: string) => Promise<string | null> {
  return async (userId) => {
    if (!userId) return null;
    try {
      const provider = (await credentialService.load("oauth:active_provider"))?.trim();
      if (provider !== "zai" && provider !== "bigmodel") return null;
      const readUserId = async () =>
        readTelemetryOAuthUserId(await credentialService.load(`oauth:${provider}:user_info`));
      if ((await readUserId()) !== userId) return null;
      const jwt = (await credentialService.load("zcodejwttoken"))?.trim();
      // 退出/切账号可能发生在异步读取期间；禁止将旧身份的 token 附到其他账号事件上。
      if (
        (await credentialService.load("oauth:active_provider"))?.trim() !== provider ||
        (await readUserId()) !== userId
      )
        return null;
      return jwt && /^[\x21-\x7e]+$/.test(jwt) ? `Bearer ${jwt}` : null;
    } catch {
      return null;
    }
  };
}

export function createTelemetryMarketingParamsLoader(
  credentialService: ICredentialService,
): () => Promise<import("@zcode/shared").OAuthLoginAttribution | null> {
  // 恢复原因：固定返回 null 会丢掉已保存的渠道归因，数仓应读取 OAuth 的同一份事实。
  const repo = new OAuthCredentialRepo(credentialService);
  return () => repo.loadLoginAttribution();
}

function readTelemetryOAuthUserId(rawUserInfo: string | null): string {
  if (!rawUserInfo) {
    return "";
  }

  try {
    const parsed = JSON.parse(rawUserInfo) as {
      id?: unknown;
      user_id?: unknown;
    };
    const id = typeof parsed.id === "string" ? parsed.id : "";
    const userId = typeof parsed.user_id === "string" ? parsed.user_id : "";
    return id.trim() || userId.trim();
  } catch {
    return "";
  }
}

export function disposeServiceResources(services: ServiceCollection): void {
  // host process 退出前以前没有统一遍历本地服务做资源回收，
  // terminal/task wrapper 这类会拉起子进程的服务只能等宿主进程自己结束，时序上可能留下短暂残留。
  // 这里集中调用各服务的本地 disposeAll 钩子，把“退出 app = 回收所有托管资源”落成机械动作。
  const disposableServices = [
    services.getOptional(ITerminalService),
    services.getOptional(IZCodeTaskService),
    services.getOptional(IZCodeAgentService),
    services.getOptional(IZCodeSessionService),
    services.getOptional(IBotsService),
    services.getOptional(IFileWatcherService),
    services.getOptional(IOffPeakTaskService),
  ].filter((service) => service !== undefined);

  for (const service of disposableServices) {
    if (hasDisposeAll(service)) {
      service.disposeAll();
    }
  }

  // 关闭共享 tasks-index sqlite 句柄（Windows 上悬着句柄会让后续目录清理撞 EBUSY）
  for (const repo of sharedSqliteRepos.get(services) ?? []) repo.close();
  sharedSqliteRepos.delete(services);
  providerRuntimes.get(services)?.dispose();
  for (const dispose of providerProvisioningTriggerDisposers.get(services) ?? []) dispose();
  providerProvisioningTriggerDisposers.delete(services);
  providerProvisioningSources.delete(services);
  managedHostApiNetworkTransports.get(services)?.dispose();
}

export async function disposeServiceResourcesAndWait(services: ServiceCollection): Promise<void> {
  // app 关闭时 host 需要等 agent 进程树完成 graceful + force 清理。
  // 旧的同步 dispose 会在 host 退出时丢掉强杀 timer，导致 zcode-cli/app-server 变成孤儿进程。
  const disposableServices = [
    services.getOptional(ITerminalService),
    services.getOptional(IZCodeTaskService),
    services.getOptional(IZCodeAgentService),
    services.getOptional(IZCodeSessionService),
    services.getOptional(IBotsService),
    services.getOptional(IFileWatcherService),
    services.getOptional(IOffPeakTaskService),
  ].filter((service) => service !== undefined);

  for (const service of disposableServices) {
    if (hasDisposeAllAndWait(service)) {
      await service.disposeAllAndWait();
    } else if (hasDisposeAll(service)) {
      service.disposeAll();
    }
  }

  // 关闭共享 tasks-index sqlite 句柄（同 disposeServiceResources，异步收口路径也要释放）
  for (const repo of sharedSqliteRepos.get(services) ?? []) repo.close();
  sharedSqliteRepos.delete(services);
  providerRuntimes.get(services)?.dispose();
  for (const dispose of providerProvisioningTriggerDisposers.get(services) ?? []) dispose();
  providerProvisioningTriggerDisposers.delete(services);
  providerProvisioningSources.delete(services);
  await managedHostApiNetworkTransports
    .get(services)
    ?.disposeAndWait()
    .catch(() => {});
}
