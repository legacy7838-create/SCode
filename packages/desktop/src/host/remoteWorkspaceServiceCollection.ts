/* eslint-disable max-lines -- Remote workspace service registration is maintained in one place to preserve the dependency injection order. */
import {
  ServiceCollection,
  IFileService,
  IMediaPreviewService,
  IGitService,
  IGitCheckpointService,
  ISystemService,
  ITerminalService,
  ISettingService,
  ICredentialService,
  IBroadcastService,
  IZCodeTaskService,
  IZCodeAgentService,
  IZCodeSessionService,
  IConversationShareService,
  IBotsService,
  IFileWatcherService,
  IOAuthService,
  IModelSelectionService,
  IProviderSettingsService,
  IUsageStatsService,
  ICodingPlanSubscriptionService,
  IClientConfigService,
  IClientScenesService,
  ISkillsService,
  ISkillSyncService,
  IMcpSyncService,
  IPluginSyncService,
  IPluginsService,
  IPluginManagementService,
  ISubagentsService,
  ICommandsService,
  IHooksService,
  IMemoryService,
  ISettingsSyncService,
  IPromptAttachmentTransferService,
  type IServiceAccessor,
} from "@zcode/services";
import {
  ConversationShareHttpClient,
  ConversationShareService,
  createSettingService,
  createCredentialService,
  createBroadcastService,
  createNodeApiClient,
  createHostApiNetworkTransport,
  registerHostApiNetworkTransportForDispose,
  createOAuthService,
  createOAuthProviderLogoutHandler,
  createAccountProviderCredentialStore,
  createAccountProviderCredentialService,
  createAccountProviderRequestAuthService,
  createAccountRequestAuthService,
  resolveCurrentAccountAccess,
  resolveAccountTeamPlanRuntimeApiKey,
  createSettingsSyncService,
  createBotsService,
  createUsageStatsService,
  createMediaPreviewService,
  createCodingPlanSubscriptionService,
  createClientScenesService,
  createServiceLogger,
  createSubagentsService,
  createMemoryService,
  createRemoteConversationShareArtifactSource,
  OAuthCredentialRepo,
} from "@zcode/services/node";
import {
  BIGMODEL_PROVIDER_ID,
  buildRuntimeZCodeApiUrl,
  DEFAULT_ZCODE_MODEL_CONTEXT_BUDGET_STRATEGY,
  type ProviderFamilyDomain,
  type ZCodeSessionRuntimePreferencesResult,
  ZAI_PROVIDER_ID,
} from "@zcode/shared";
import { assertLegacyRemoteWorkspaceRpcContract } from "./legacyRemoteWorkspaceRpcContract.js";
import {
  createRemoteProviderProvisioningExecutorFromWorkspace,
  registerRemoteProviderProvisioningExecutor,
} from "./remoteProviderProvisioningService.js";

const runtimePreferencesLogger = createServiceLogger("remote-runtime-preferences");
const ZCODE_JWT_TOKEN_KEY = "zcodejwttoken";

export function createRemoteWorkspaceServiceCollection(params: {
  clientConfigService: IClientConfigService;
  connectionServices: IServiceAccessor;
  sourceServices?: ServiceCollection;
  parentPort: Parameters<typeof createBroadcastService>[0];
  createReportingRemoteZCodeTaskService: <T extends object>(service: T) => T;
  createRemotePromptAttachmentTaskService: <T extends object>(service: T) => T;
  createRemotePromptAttachmentSessionService: <T extends object>(service: T) => T;
  promptAttachmentTransferService: IPromptAttachmentTransferService;
  runtimePreferencesBridge: {
    onError: (error: unknown) => void;
  };
}): ServiceCollection {
  assertLegacyRemoteWorkspaceRpcContract(params.connectionServices);
  const localSettingService = createSettingService();
  const localCredentialService = createCredentialService();
  const localAccountProviderCredentialStore = createAccountProviderCredentialStore({
    credentialService: localCredentialService,
  });
  const hostApiNetworkTransport = createHostApiNetworkTransport(async () => {
    const settings = await localSettingService.get();
    return {
      httpProxy: settings.httpProxy,
      noProxy: settings.httpProxyNoProxy,
      caCertPath: settings.httpProxyCaCertPath,
    };
  });
  const localApiClient = createNodeApiClient({
    fetchImpl: hostApiNetworkTransport.fetch,
  });
  const localBroadcastService = createBroadcastService(params.parentPort);
  let handleOAuthProviderLogout: ReturnType<typeof createOAuthProviderLogoutHandler> | null = null;
  const localOAuthCredentialRepo = new OAuthCredentialRepo(localCredentialService, {
    onCorruptOAuthSessionCleared: async (providers) => {
      // The remote workspace host reads and writes native OAuth credentials.
      // Damage recovery must clean up the Start/Coding Plan derived provider in the same way as the local host to avoid old keys remaining in the mobile phone remote.
      await Promise.all(
        providers.map((provider) => handleOAuthProviderLogout?.(provider) ?? Promise.resolve()),
      );
    },
  });
  const localAccountProviderCredentialService = createAccountProviderCredentialService({
    credentialStore: localAccountProviderCredentialStore,
    async loadOAuthAccessToken(family) {
      const providerId = family === "zai" ? ZAI_PROVIDER_ID : BIGMODEL_PROVIDER_ID;
      return (await localOAuthCredentialRepo.loadTokenSet(providerId))?.accessToken ?? null;
    },
    // desktop-attached remote only reuses keys that have been parsed or stored on the local machine or in old storage; remote refresh is still handled by the official account chain of the local machine.
    resolveProviderApiKey: async () => null,
  });
  const readLocalAccountProviderSettings = async () => {
    const settings = await localSettingService.get();
    return {
      providerFamilyDomain: settings.providerFamilyDomain ?? null,
      selections: settings.providerFamilyConnectionSelections ?? {},
    };
  };
  const loadLocalAccountIdentity = async (family: ProviderFamilyDomain) => {
    const providerId = family === "zai" ? ZAI_PROVIDER_ID : BIGMODEL_PROVIDER_ID;
    return (await localOAuthCredentialRepo.loadUserProfile(providerId))?.id ?? null;
  };
  const localAccountRequestAuthService = createAccountRequestAuthService(
    createAccountProviderRequestAuthService({
      resolveCurrentAccountAccess: (access) =>
        resolveCurrentAccountAccess({
          access,
          readSettings: readLocalAccountProviderSettings,
          loadAccountIdentity: loadLocalAccountIdentity,
        }),
      loadOAuthTokenSet: (providerId) => localOAuthCredentialRepo.loadTokenSet(providerId),
      async loadIndividualPlanApiKey(providerId, family) {
        const oauthProviderId = family === "zai" ? ZAI_PROVIDER_ID : BIGMODEL_PROVIDER_ID;
        const accountIdentity = (await localOAuthCredentialRepo.loadUserProfile(oauthProviderId))
          ?.id;
        if (!accountIdentity) return null;
        return localAccountProviderCredentialService.loadCodingPlanApiKey({
          providerId,
          family,
          accountIdentity,
        });
      },
      resolveTeamPlanApiKey: (access) =>
        resolveAccountTeamPlanRuntimeApiKey({
          apiClient: localApiClient,
          credentialService: localCredentialService,
          access,
        }),
    }),
  );
  const localCodingPlanSubscriptionService = createCodingPlanSubscriptionService({
    apiClient: localApiClient,
    credentialService: localCredentialService,
  });
  handleOAuthProviderLogout = createOAuthProviderLogoutHandler({
    accountProviderCredentialStore: localAccountProviderCredentialStore,
  });
  const conversationShareClient = new ConversationShareHttpClient({
    // Sharing of remote workspaces must also use real APIs; local mocks are only used for single testing and do not generate links that cannot be accessed across processes.
    apiClient: localApiClient,
    baseUrl: buildRuntimeZCodeApiUrl(process.env, "/api/v1"),
    tokenProvider: async () =>
      (await localCredentialService.load(ZCODE_JWT_TOKEN_KEY))?.trim() || null,
  });
  const conversationShareService = new ConversationShareService({
    zcodeAgentService: params.connectionServices.zcodeAgentService,
    client: conversationShareClient,
    artifactSource: createRemoteConversationShareArtifactSource(
      params.connectionServices.fileService,
    ),
  });
  const reportingRemoteZCodeTaskService = params.createReportingRemoteZCodeTaskService(
    params.connectionServices.zcodeTaskService,
  );
  // The replayable mirror of the mobile phone remote publishes user messages in the reporting wrapper;
  // Attachment materialization must be wrapped in the reporting layer to ensure that the mirror and the prompt actually sent to the remote agent use the same remote path.
  const remoteZCodeTaskService = params.createRemotePromptAttachmentTaskService(
    reportingRemoteZCodeTaskService,
  );
  const remoteZCodeSessionService = params.createRemotePromptAttachmentSessionService(
    params.connectionServices.zcodeSessionService,
  );
  const remoteProviderProvisioningService =
    createRemoteProviderProvisioningExecutorFromWorkspace(params);

  // The agent of desktop-attached remote is running on the remote end, but the app-global setting authority is still there
  // desktop shared host. By narrowing the runtime-preferences request, return to the original path to avoid the remote end from reading its own settings.
  const { onError } = params.runtimePreferencesBridge;
  params.connectionServices.zcodeAgentService.onDynamicSessionRuntimePreferencesRequest()(
    (request) => {
      const startedAt = Date.now();
      const requestContext = {
        event: "zcode_protocol.runtime_preferences.host_request_received",
        module: "desktop.host.remote_workspace",
        requestId: request.requestId,
        scope: request.scope,
        sessionId: request.sessionId,
      };
      // Diagnosis: Timeout on the Agent side only means that no response is received; here records whether the Host receives the request,
      // Use "received but no response" to distinguish between transport packet loss and setting read stuck.
      runtimePreferencesLogger.info(
        undefined,
        "runtime preferences host request received",
        requestContext,
      );
      void (async () => {
        const trackStage = <T>(stage: string, promise: Promise<T>): Promise<T> => {
          const stageStartedAt = Date.now();
          return promise.then(
            (value) => {
              runtimePreferencesLogger.debug(
                undefined,
                "runtime preferences host stage completed",
                {
                  ...requestContext,
                  durationMs: Math.max(0, Date.now() - stageStartedAt),
                  stage,
                },
              );
              return value;
            },
            (error: unknown) => {
              runtimePreferencesLogger.warn(undefined, "runtime preferences host stage failed", {
                ...requestContext,
                durationMs: Math.max(0, Date.now() - stageStartedAt),
                error: error instanceof Error ? error.message : String(error),
                stage,
              });
              throw error;
            },
          );
        };
        let resolution:
          | { status: "resolved"; preferences: ZCodeSessionRuntimePreferencesResult }
          | { status: "failed"; message: string };
        try {
          // Same origin as the local Host: the fixed budget does not depend on configuring the gateway, and the remote/mobile preference response no longer waits for the network serially.
          const settings = await trackStage("settings", localSettingService.get());
          const modelContextBudgetStrategy = DEFAULT_ZCODE_MODEL_CONTEXT_BUDGET_STRATEGY;
          resolution = {
            status: "resolved",
            preferences: {
              askUserQuestionAutoResolutionEnabled:
                settings.askUserQuestionAutoResolutionEnabled !== false,
              nativeSearchEnhancementsEnabled: settings.nativeSearchEnhancementsEnabled !== false,
              memoryEnabled: settings.memoryEnabled === true,
              modelContextBudgetStrategy,
              // The remote workspace maintains the same scope boundary as the local Host, and the first execution must not wait for the client config again.
              ...(request.scope === "user-execution" && settings.integratedTerminalShell
                ? { integratedTerminalShell: settings.integratedTerminalShell }
                : {}),
            },
          };
        } catch (error) {
          resolution = {
            status: "failed",
            message: error instanceof Error ? error.message : String(error),
          };
          runtimePreferencesLogger.warn(undefined, "runtime preferences host resolution failed", {
            ...requestContext,
            durationMs: Math.max(0, Date.now() - startedAt),
            error: resolution.message,
          });
        }
        // Only the setting read failure is encoded as -32603; the sending failure is handed over to the final onError record, and the same request cannot be retried.
        await params.connectionServices.zcodeAgentService.respondSessionRuntimePreferences({
          requestId: request.requestId,
          resolution,
        });
        runtimePreferencesLogger.info(undefined, "runtime preferences host response sent", {
          ...requestContext,
          durationMs: Math.max(0, Date.now() - startedAt),
          resolutionStatus: resolution.status,
        });
      })().catch((error: unknown) => {
        runtimePreferencesLogger.warn(undefined, "runtime preferences host response failed", {
          ...requestContext,
          durationMs: Math.max(0, Date.now() - startedAt),
          error: error instanceof Error ? error.message : String(error),
        });
        onError(error);
      });
    },
  );

  // When entering the SSH task remotely through the Web mobile phone, it only connects to the remote workspace host.
  // There is no desktop renderer layer `baseServices + remoteServices` merge.
  // Therefore, the local global channel is supplemented here for the remote workspace host; files, terminals, and ZCode Agent still come from the remote end.
  // Settings, credentials, OAuth, model providers, and settings-sync continue to read and write native configuration.
  const services = new ServiceCollection()
    .register(IFileService, params.connectionServices.fileService)
    .register(IGitService, params.connectionServices.gitService)
    .register(IGitCheckpointService, params.connectionServices.gitCheckpointService)
    .register(ISystemService, params.connectionServices.systemService)
    .register(ITerminalService, params.connectionServices.terminalService)
    .register(ISettingService, localSettingService)
    .register(ICredentialService, localCredentialService)
    .register(IBroadcastService, localBroadcastService)
    .register(IZCodeTaskService, remoteZCodeTaskService)
    .register(IZCodeAgentService, params.connectionServices.zcodeAgentService)
    .register(IZCodeSessionService, remoteZCodeSessionService)
    .register(IConversationShareService, conversationShareService)
    .register(
      IBotsService,
      createBotsService({
        credentialService: localCredentialService,
        zcodeTaskService: remoteZCodeTaskService,
        broadcastService: localBroadcastService,
        settingService: localSettingService,
        modelSelectionService: params.connectionServices.modelSelectionService,
        // Reason for repair: remote workspace host first screen only requires remote file/agent capabilities;
        // If the bot starts a background task and polls or getAll immediately, it will repeatedly pull the local preset and amplify the SSH connection time.
        runStartupBackgroundTasks: false,
      }),
    )
    .register(IFileWatcherService, params.connectionServices.fileWatcherService)
    .register(
      IOAuthService,
      createOAuthService(localCredentialService, {
        apiClient: localApiClient,
        onProviderLogout: handleOAuthProviderLogout,
      }),
    )
    // Provider/Model facts belong to the target Environment. Remote workspace selection and settings view
    // The remote Registry must be read directly, and the Desktop local Provider cannot continue to be displayed.
    .register(IModelSelectionService, params.connectionServices.modelSelectionService)
    .register(IProviderSettingsService, params.connectionServices.providerSettingsService)
    .register(
      IUsageStatsService,
      createUsageStatsService({
        apiClient: localApiClient,
        accountRequestAuthService: localAccountRequestAuthService,
        credentialService: localCredentialService,
        zcodeAgentService: params.connectionServices.zcodeAgentService,
      }),
    )
    .register(ICodingPlanSubscriptionService, localCodingPlanSubscriptionService)
    .register(IClientConfigService, params.clientConfigService)
    .register(IClientScenesService, createClientScenesService({ apiClient: localApiClient }))
    // The project-level skills/plugins/commands of the remote workspace are located in the SSH file system.
    // The remote service must be exposed here to prevent the local service from using the remote workspacePath to scan the local directory.
    .register(ISkillsService, params.connectionServices.skillsService)
    .register(ISkillSyncService, params.connectionServices.skillSyncService)
    .register(IMcpSyncService, params.connectionServices.mcpSyncService)
    .register(IPluginSyncService, params.connectionServices.pluginSyncService)
    .register(IPluginsService, params.connectionServices.pluginsService)
    // Plug-in management on the remote settings page must also be directed to the remote agent (the plug-in directory is in the remote file system).
    .register(IPluginManagementService, params.connectionServices.pluginManagementService)
    .register(ICommandsService, params.connectionServices.commandsService)
    .register(ISubagentsService, createSubagentsService({ isDesktopRuntime: true }))
    .register(IHooksService, params.connectionServices.hooksService)
    .register(IMemoryService, createMemoryService())
    .register(
      ISettingsSyncService,
      createSettingsSyncService({ settingService: localSettingService }),
    )
    .register(IPromptAttachmentTransferService, params.promptAttachmentTransferService);
  registerHostApiNetworkTransportForDispose(services, hostApiNetworkTransport);
  registerRemoteProviderProvisioningExecutor(services, remoteProviderProvisioningService);
  return services;
}
