/* eslint-disable max-lines -- Root currently centralizes startup and workspace shell wiring;
 * keeping the entry point consolidated for now avoids scattering state across layers.
 */
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { LucideProvider, RefreshCw } from "lucide-react";
import {
  APP_RUNTIME_PREFERENCES_CHANGED_BROADCAST_CHANNEL,
  DesktopCommandIds,
  appRuntimePreferencesChangedBroadcastPayloadSchema,
  type RemoteTarget,
} from "@zcode/shared";
import { TooltipProvider } from "@/components/ui/tooltip.js";
import { Button } from "@/components/ui/button.js";
import { PlatformProvider } from "@/hooks/usePlatform.js";
import { ServiceProvider } from "@/hooks/useServices.js";
import { useDynamicWorkflowAvailabilityLoader } from "@/hooks/useDynamicWorkflowAvailability.js";
import { DirectoryBrowser } from "@/DirectoryBrowser.js";
import { useTabPersistence } from "@/hooks/useTabPersistence.js";
import { useTokenRefresh } from "@/hooks/useTokenRefresh.js";
import { useWorkspaceServices } from "@/hooks/useWorkspaceServices.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { SSHDialog } from "@/SSHDialog.js";
import { SettingsPage } from "@/SettingsPage.js";
import { CodingPlanUpgradeDialogProvider } from "@/settings/CodingPlanUpgradeDialogProvider.js";
import { WelcomeScreen, type LoginCompleteReason } from "@/WelcomeScreen.js";
import { setDefaultFileDisplayBasePath } from "@/lib/fileDisplay.js";
import { readRendererLaunchTimings, shouldReportLaunchToInput } from "@/lib/launchToInputReport.js";
import { reportUiLaunchToInput } from "@/lib/uiPerfArmsTelemetry.js";
import { countAllUnreadTasks } from "@/lib/unreadTaskCount.js";
import {
  isProviderStartupSyncPending,
  shouldEnableProviderAvailabilityLoginEntryGuard,
  shouldResolveProviderStartupState,
  shouldBlockRootRender,
  shouldShowRootStartupLoading,
  shouldOpenFallbackWorkspaceAfterCreate,
} from "@/lib/rootStartupGate.js";
import { StoreProvider, useZCodeStore } from "@/store/StoreProvider.js";
import { setMcpStorePlatform } from "@/store/mcpStore.js";
import { useZCodeSessionStore } from "@/store/zcodeSessionStore.js";
import { TabStoreProvider, useTabStore, useTabStoreApi } from "@/store/TabStoreProvider.js";
import { isSettingsTab, isWorkspaceTab, type WorkspaceTabState } from "@/store/tabStore.js";
import { logger } from "@/logger.js";
import { RootShell } from "@/root/RootShell.js";
import { RootWorkspaceContent } from "@/root/RootWorkspaceContent.js";
import { resolveRootWorkspaceShellTarget } from "@/root/rootWorkspaceShellTarget.js";
import { OccupationOnboarding } from "@/onboarding/OccupationOnboarding.js";
import { OnboardingDialog } from "@/onboarding/OnboardingDialog.js";
import { useRemoteWorkspaceHistory } from "@/root/useRemoteWorkspaceHistory.js";
import { useRemoteWorkspaceTabLifecycle } from "@/root/useRemoteWorkspaceTabLifecycle.js";
import { useRootProviderStateRefresh } from "@/root/useRootProviderStateRefresh.js";
import { useModelSelectionServiceView } from "@/hooks/useModelSelectionView.js";
import { useRootProviderSettingsSnapshot } from "@/root/useRootProviderSettingsSnapshot.js";
import { useRootOAuthEffects } from "@/root/useRootOAuthEffects.js";
import { consumeZcodeJwtInvalidRestartMarker } from "@/root/zcodeJwtInvalidRestartMarker.js";
import { useDesktopNativeThemeSync } from "@/root/useDesktopNativeThemeSync.js";
import { useRootPlatformEffects } from "@/root/useRootPlatformEffects.js";
import { useRootWorkspaceActions } from "@/root/useRootWorkspaceActions.js";
import { useBotBroadcastEffects } from "@/root/useBotBroadcastEffects.js";
import { registerBaseWorkspaceServices } from "@/store/remoteWorkspaceSessionStore.js";
import type { RootProps } from "@/root/types.js";
import { DiffsWorkerPoolProvider } from "@/root/DiffsWorkerPoolProvider.js";
import { useGlobalTaskList } from "@/hooks/useGlobalTaskList.js";
import { ScopedErrorBoundary } from "@/ErrorBoundary.js";
import { useRemoteConnectionLogs } from "@/hooks/useRemoteConnectionLogs.js";
import {
  CODE_COMMENT_REMOVE_BROADCAST_CHANNEL,
  CODE_COMMENT_PREVIEW_RESTORE_BROADCAST_CHANNEL,
  isCodeCommentPayload,
  isCodeCommentRemovePayload,
  markCodeCommentRemoved,
} from "@/lib/codeCommentContext.js";
import { useCodeCommentPreviewStore } from "@/store/codeCommentPreviewStore.js";
import { setUiPerfArmsReporter } from "@/lib/uiPerfArmsTelemetry.js";
import { setSessionOpenArmsReporter } from "@/lib/sessionOpenArmsTelemetry.js";
import { setSendFunnelArmsReporter } from "@/lib/sendFunnelArmsTelemetry.js";
import { RootStartupLoading } from "@/root/RootStartupLoading.js";
import { resolveProviderAvailabilityState } from "@/lib/modelProviderAvailability.js";
import { useProviderAvailabilityLoginEntryGuard } from "@/root/useProviderAvailabilityLoginEntryGuard.js";
import { ensureProviderFamilyDomainMigration } from "@/lib/providerFamilyDomainMigration.js";
import { useSettings } from "@/hooks/useSettingService.js";
import { CLOSE_ACTIVE_CONTEXT_REQUEST_EVENT } from "@/lib/closeActiveContext.js";
import { AssistantCodeCommentFeatureProvider } from "@/AssistantCodeCommentFeatureProvider.js";
import {
  disposeConversationTelemetrySupervisors,
  reconcileConversationTelemetryWorkspaceScopes,
} from "@/v4/telemetry/ConversationTelemetryAttachment.js";

const DEFAULT_LUCIDE_STROKE_WIDTH = 1.5;
interface RemoteConnectionOpenPreference {
  preferredKind?: RemoteTarget["kind"];
}

type WelcomeScreenOpenReason =
  | "startup-provider-required"
  | "manual-login"
  | "provider-request"
  | "logout-provider-required"
  | "session-expired";

/**
 * Root —— the app's root component
 *
 * The outer layer mounts StoreProvider (the connection broadcast service) + TabStoreProvider; the
 * inner layer handles authentication and routing.
 */
export function Root(props: RootProps) {
  return (
    <LucideProvider strokeWidth={DEFAULT_LUCIDE_STROKE_WIDTH}>
      {/*
       * Every icon used to be wrapped by lucide.tsx to pin the default strokeWidth to 1.5. Now that
       * the wrapper file is gone, without a single injection at the root layer the Lucide icons in
       * buttons, lists, and toolbars would fall back to 2, which makes the same set of size classes
       * look heavier and more cramped. Here the official LucideProvider keeps the default while
       * still letting individual icons override strokeWidth explicitly.
       */}
      <TooltipProvider>
        {/*
         * Large-conversation message actions render a lot of tooltips. If the provider were created
         * per tooltip instance, clicking to switch tasks would synchronously build a Radix context
         * tree of the same order of magnitude in React; sharing one at the root layer keeps the
         * zero-latency setup.
         */}
        <ServiceProvider services={props.services}>
          <PlatformProvider platform={props.platform}>
            <StoreProvider
              broadcastService={props.services.broadcastService}
              initialIsRestoringOAuthSession
            >
              <TabStoreProvider>
                <DiffsWorkerPoolProvider>
                  <AssistantCodeCommentFeatureProvider
                    enabled={props.assistantCodeCommentCardsEnabled}
                  >
                    <CodingPlanUpgradeDialogProvider>
                      <RootInner {...props} />
                    </CodingPlanUpgradeDialogProvider>
                  </AssistantCodeCommentFeatureProvider>
                </DiffsWorkerPoolProvider>
              </TabStoreProvider>
            </StoreProvider>
          </PlatformProvider>
        </ServiceProvider>
      </TooltipProvider>
    </LucideProvider>
  );
}

function RootInner({
  services,
  platform,
  initialWorkspaceAbsPath,
  unavailableWorkspacePath,
  initialWorkspaceIdentity,
  initialWorkspacePurpose,
  initialTaskId,
  isDesktop,
  isMacDesktop,
  isWindowsDesktop,
  restoreSession = true,
  supportsSettings = true,
  allowOpenWorkspace = true,
  preferDirectoryBrowser,
  supportsEmbeddedBrowser: explicitSupportsEmbeddedBrowser,
  allowRemoteWorkspace = true,
  initialWorkspaceLoadingFallback,
}: RootProps) {
  useEffect(() => {
    setMcpStorePlatform(platform);
    // Dialog UI perf is only desktop-continuous; Web/mobile does not install reporter even if it can see the authoritative status.
    setUiPerfArmsReporter(isDesktop ? platform : null);
    setSessionOpenArmsReporter(isDesktop ? platform : null);
    // The same applies to the sending funnel: it is only reported on the Electron desktop, and the reportArmsCustomEvent of Web/mobile is an empty implementation.
    setSendFunnelArmsReporter(isDesktop ? platform : null);
    return () => {
      setMcpStorePlatform(null);
      setUiPerfArmsReporter(null);
      setSessionOpenArmsReporter(null);
      setSendFunnelArmsReporter(null);
    };
  }, [isDesktop, platform]);

  useEffect(
    () => () => {
      disposeConversationTelemetrySupervisors();
    },
    [],
  );

  // The only point to take a grayscale snapshot of dynamic workflow:
  // Place it in the app-level ServiceProvider layer and retrieve it once. The automation page and run panel are read-only. The consumer may be located in
  // In the workspace-level ServiceProvider (the accessor of the remote Host), if they retrieve the number, they will get the answer of the other Host.
  useDynamicWorkflowAvailabilityLoader(services.codingPlanSubscriptionService);

  const { intl, locale } = useZCodeIntl();
  const theme = useZCodeStore((state) => state.theme);
  const user = useZCodeStore((state) => state.user);
  const isRestoringOAuthSession = useZCodeStore((state) => state.isRestoringOAuthSession);
  const setUser = useZCodeStore((state) => state.setUser);
  const setIsRestoringOAuthSession = useZCodeStore((state) => state.setIsRestoringOAuthSession);
  const setOAuthError = useZCodeStore((state) => state.setOAuthError);
  const oauthPollingActive = useZCodeStore((state) => state.oauthPollingActive);
  const setOAuthPollingActive = useZCodeStore((state) => state.setOAuthPollingActive);
  const markOAuthSuccess = useZCodeStore((state) => state.markOAuthSuccess);
  const {
    settings: appSettings,
    refresh: refreshAppSettings,
    update: updateAppSettings,
  } = useSettings();
  const [welcomeScreenOpenReason, setWelcomeScreenOpenReason] =
    useState<WelcomeScreenOpenReason | null>(() =>
      consumeZcodeJwtInvalidRestartMarker() ? "session-expired" : null,
    );
  const [providerFamilyDomainMigrationComplete, setProviderFamilyDomainMigrationComplete] =
    useState(false);
  const loginEntryRequest = useZCodeStore((state) => state.loginEntryRequest);
  const rootModelSelectionRead = useModelSelectionServiceView(services.modelSelectionService);
  const rootModelSelectionView =
    rootModelSelectionRead.state.status === "ready" ? rootModelSelectionRead.state.view : null;
  const rootModelSelectionErrorNode =
    rootModelSelectionRead.state.status === "error" ? (
      <div className="fixed right-4 bottom-4 z-50 flex max-w-sm items-center gap-3 rounded-lg border border-destructive/30 bg-surface-raised px-3 py-2 text-ui-base text-foreground shadow-lg">
        <span className="min-w-0 flex-1">
          {intl.formatMessage({ id: "root.modelSelection.loadFailed" })}
        </span>
        <Button type="button" variant="ghost" size="sm" onClick={rootModelSelectionRead.reload}>
          <RefreshCw className="size-3.5" aria-hidden="true" />
          {intl.formatMessage({ id: "common.retry" })}
        </Button>
      </div>
    ) : null;
  const readRootModelSelectionView = useCallback(
    () => services.modelSelectionService.getView(),
    [services.modelSelectionService],
  );
  const [remoteConnectionDialogOpen, setRemoteConnectionDialogOpen] = useState(false);
  const [remoteConnectionOpenPreference, setRemoteConnectionOpenPreference] =
    useState<RemoteConnectionOpenPreference | null>(null);
  const [directoryBrowserOpen, setDirectoryBrowserOpen] = useState(false);
  const [remoteConnectionInProgress, setRemoteConnectionInProgress] = useState(false);
  const [remoteConnectionRequestId, setRemoteConnectionRequestId] = useState<string | null>(null);
  const [isCreatingFallbackWorkspace, setIsCreatingFallbackWorkspace] = useState(false);
  const { connectionLogs: remoteConnectionLogs, resetConnectionLogs: resetRemoteConnectionLogs } =
    useRemoteConnectionLogs(remoteConnectionRequestId);
  const [isBootstrappingInitialWorkspace, setIsBootstrappingInitialWorkspace] = useState(
    Boolean(initialWorkspaceAbsPath),
  );
  const acknowledgingReleaseNotesVersionRef = useRef<string | null>(null);
  const previousRemoteConnectionInProgressRef = useRef(false);
  const didRequestFallbackWorkspaceRef = useRef(false);
  const rootInnerMountedRef = useRef(true);
  const [hasEnteredNativeThemeSyncSurface, setHasEnteredNativeThemeSyncSurface] = useState(false);

  useEffect(() => {
    return () => {
      rootInnerMountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    const disposable = services.broadcastService.onMessage((message) => {
      if (message.channel === APP_RUNTIME_PREFERENCES_CHANGED_BROADCAST_CHANNEL) {
        const parsed = appRuntimePreferencesChangedBroadcastPayloadSchema.safeParse(
          message.payload,
        );
        if (!parsed.success) {
          logger.warn("[settings] dropped invalid runtime preferences broadcast", {
            issues: parsed.error.issues,
          });
          return;
        }
        void refreshAppSettings();
        void services.zcodeAgentService.syncAppRuntimePreferences(parsed.data).catch((error) => {
          logger.warn("[settings] failed to sync cross-window runtime preferences", error);
        });
        void services.botsService.syncAppRuntimePreferences(parsed.data).catch((error) => {
          logger.warn("[settings] failed to sync cross-window bot runtime preferences", error);
        });
        return;
      }

      if (message.channel === CODE_COMMENT_PREVIEW_RESTORE_BROADCAST_CHANNEL) {
        if (!isCodeCommentPayload(message.payload) || !message.payload.id) {
          return;
        }
        useCodeCommentPreviewStore.getState().restoreCommentFromAttachment({
          ...message.payload,
          id: message.payload.id,
        });
        return;
      }

      if (message.channel !== CODE_COMMENT_REMOVE_BROADCAST_CHANNEL) {
        return;
      }

      if (!isCodeCommentRemovePayload(message.payload)) {
        return;
      }

      // PreviewPane will be uninstalled after closing the file tab, and you can no longer rely on PreviewPane to listen for cross-window cleanup events.
      // Here, the renderer-level preview store is cleaned synchronously during the Root life cycle to avoid re-opening the file after sending and restoring the old comment.
      markCodeCommentRemoved(message.payload);
      useCodeCommentPreviewStore.getState().removeCommentBySource(message.payload);
    });

    return () => {
      disposable.dispose();
    };
  }, [
    refreshAppSettings,
    services.botsService,
    services.broadcastService,
    services.zcodeAgentService,
  ]);

  useEffect(() => {
    if (!appSettings) {
      return;
    }
    void services.zcodeAgentService
      .syncAppRuntimePreferences({
        askUserQuestionAutoResolutionEnabled:
          appSettings.askUserQuestionAutoResolutionEnabled !== false,
        modelIoFullRetentionEnabled: appSettings.modelIoFullRetentionEnabled === true,
      })
      .catch((error) => {
        logger.warn("[settings] failed to init runtime preferences", error);
      });
    void services.botsService
      .syncAppRuntimePreferences({
        askUserQuestionAutoResolutionEnabled:
          appSettings.askUserQuestionAutoResolutionEnabled !== false,
        modelIoFullRetentionEnabled: appSettings.modelIoFullRetentionEnabled === true,
      })
      .catch((error) => {
        logger.warn("[settings] failed to init bot runtime preferences", error);
      });
  }, [
    appSettings?.askUserQuestionAutoResolutionEnabled,
    appSettings?.modelIoFullRetentionEnabled,
    services.botsService,
    services.zcodeAgentService,
  ]);

  const tabs = useTabStore((state) => state.tabs);
  const windowWorkspaceTabs = useMemo(() => tabs.filter(isWorkspaceTab), [tabs]);
  const activeTabId = useTabStore((state) => state.activeTabId);
  const activeWorkspacePath = useTabStore((state) => state.activeWorkspacePath);
  const activeWorkspaceIdentity = useTabStore((state) => state.activeWorkspaceIdentity);
  const activeTab = activeTabId ? (tabs.find((tab) => tab.id === activeTabId) ?? null) : null;
  const activeWorkspaceTab = activeTab && isWorkspaceTab(activeTab) ? activeTab : null;
  const isSettingsTabActive = activeTab ? isSettingsTab(activeTab) : false;
  const {
    workspaceShellPath,
    workspaceIdentity: workspaceShellIdentity,
    workspaceRemoteSessionId: workspaceShellRemoteSessionId,
  } = resolveRootWorkspaceShellTarget({
    activeWorkspaceTab,
    activeWorkspacePath,
    activeWorkspaceIdentity,
    // When overriding Settings, the complete remote identity of the overwritten tab is still used to avoid duplicate subscriptions between notifications and the sidebar.
    workspaceTabs: windowWorkspaceTabs,
  });
  const workspaceScopedServices = useWorkspaceServices(
    workspaceShellPath,
    workspaceShellRemoteSessionId,
    workspaceShellIdentity,
  );

  const localWorkspacePathForRemoteConnection = useTabStore((state) => {
    const activeTab = state.activeTabId
      ? state.tabs.find((tab) => tab.id === state.activeTabId)
      : null;
    if (
      !activeTab ||
      !isWorkspaceTab(activeTab) ||
      activeTab.remoteSessionId ||
      activeTab.remoteTarget ||
      activeTab.workspaceIdentity ||
      activeTab.workspacePurpose === "conversation"
    ) {
      return undefined;
    }
    return activeTab.workspacePath;
  });
  const totalUnreadTaskCount = useZCodeSessionStore((state) =>
    countAllUnreadTasks(state.workspaces),
  );
  const addTab = useTabStore((state) => state.addTab);
  const activateTabByPath = useTabStore((state) => state.activateTabByPath);
  const tabStoreApi = useTabStoreApi();
  const refreshProviderState = useRootProviderStateRefresh(services);
  useRootProviderSettingsSnapshot(services);
  useEffect(() => {
    let disposed = false;

    void (async () => {
      try {
        await ensureProviderFamilyDomainMigration(services);
      } catch (error) {
        logger.warn("[Root] provider family domain migration failed, continuing startup", {
          error,
        });
      } finally {
        if (!disposed) {
          setProviderFamilyDomainMigrationComplete(true);
          try {
            await refreshAppSettings();
            await refreshProviderState();
          } catch (refreshError) {
            logger.warn("[Root] failed to refresh state after provider family domain migration", {
              error: refreshError,
            });
          }
        }
      }
    })();

    return () => {
      disposed = true;
    };
  }, [refreshAppSettings, refreshProviderState, services]);

  const shouldPreferDirectoryBrowser = Boolean(preferDirectoryBrowser);
  const supportsEmbeddedBrowser = explicitSupportsEmbeddedBrowser ?? Boolean(isDesktop);
  const isResolvingStartupAuthState = isRestoringOAuthSession;
  const rootProviderAvailability = resolveProviderAvailabilityState({
    modelSelectionView: rootModelSelectionView,
  });
  const providerStartupSyncPending = isProviderStartupSyncPending({
    providerFamilyDomainMigrationComplete,
    modelSelectionViewHydrated:
      rootProviderAvailability.hydrated || rootModelSelectionRead.state.status === "error",
  });
  const providerAvailabilityLoginEntryGuardEnabled =
    shouldEnableProviderAvailabilityLoginEntryGuard();
  const { startupCheckCompleted: providerAvailabilityStartupCheckCompleted } =
    useProviderAvailabilityLoginEntryGuard({
      enabled: providerAvailabilityLoginEntryGuardEnabled,
      user,
      isRestoringOAuthSession: isResolvingStartupAuthState || providerStartupSyncPending,
      providerFamilyDomain: appSettings?.providerFamilyDomain,
      modelSelectionView: rootModelSelectionView,
      modelSelectionError:
        rootModelSelectionRead.state.status === "error"
          ? rootModelSelectionRead.state.error
          : undefined,
      refreshProviderState,
      readModelSelectionView: readRootModelSelectionView,
      setLoginEntryOpen: (open) => {
        setWelcomeScreenOpenReason((currentReason) => {
          if (open) {
            return "startup-provider-required";
          }
          // After the JWT expiration prompt is confirmed, session-expired will be written first, and then the provider
          // Starting the access control ends with open=false. If cleared unconditionally, the re-login page will be overwritten and returned to the workspace.
          // The access control can only close the startup login state it owns, and cannot clear the reasons from other interaction sources.
          return currentReason === "startup-provider-required" ? null : currentReason;
        });
      },
    });
  const isResolvingProviderStartupState = shouldResolveProviderStartupState({
    providerStartupSyncPending,
    providerAvailabilityStartupCheckCompleted,
  });
  const isStartupProviderLoginEntryOpen = welcomeScreenOpenReason === "startup-provider-required";
  // When installing for the first time, the provider login entrance is determined to be injected later than the workspace. ChatView will be mounted first and trigger draft warm-up.
  // Here, the provider startup check is incorporated into the workspace recovery access control to avoid starting the ZCode session before the account is connected.
  const canRestoreWorkspaceSession =
    !isResolvingStartupAuthState &&
    !isResolvingProviderStartupState &&
    !isStartupProviderLoginEntryOpen;

  useEffect(() => {
    // Cross-workspace task lists require a stable "local/root services" entry.
    // The desktop renderer will be registered once when it is started, but the web and test portals will also be directly rooted;
    // Here, Root props are used to register to prevent the local list from misusing the remote host when the remote workspace is currently activated.
    registerBaseWorkspaceServices(services);
  }, [services]);

  useBotBroadcastEffects(services, tabStoreApi);

  const handleOpenRemoteConnection = useCallback((preference?: RemoteConnectionOpenPreference) => {
    setRemoteConnectionOpenPreference(preference ?? null);
    setRemoteConnectionDialogOpen(true);
  }, []);
  const handleOpenDirectoryBrowser = useCallback(() => {
    setDirectoryBrowserOpen(true);
  }, []);
  const handleReauthenticationRequired = useCallback(() => {
    setWelcomeScreenOpenReason("session-expired");
  }, []);
  const {
    setWorkspaceActionError,
    startDraftInWorkspace,
    startNewTaskFromActiveWorkspace,
    handleLogout,
    handleSelectProject,
    handleSelectConversationWorkspace,
    handleResolveConversationWorkspace,
    handleEnsureConversationWorkspace,
    handleCreateConversationTask,
    handleOpenWorkspace,
    handleOpenFolderFromWorkspaceMenu,
    handleCreateScratchWorkspace,
    handleCreateTask,
    handleBackFromSettings,
  } = useRootWorkspaceActions({
    intl,
    platform,
    services,
    tabStoreApi,
    addTab,
    activeWorkspacePath,
    activeWorkspaceIdentity,
    supportsSettings,
    allowOpenWorkspace,
    preferDirectoryBrowser: shouldPreferDirectoryBrowser,
    openDirectoryBrowser: handleOpenDirectoryBrowser,
    refreshProviderState,
    updateAppSettings,
    setOAuthError,
    setUser,
    onProviderFamilyDomainClearedAfterLogout: () => {
      setWelcomeScreenOpenReason("logout-provider-required");
    },
    userId: user?.id,
    onOpenRemoteConnection: allowRemoteWorkspace ? handleOpenRemoteConnection : undefined,
  });
  const handleRemoteWorkspaceActivated = useCallback(
    ({
      workspacePath,
      workspaceIdentity,
    }: {
      workspacePath: string;
      workspaceIdentity: string;
    }) => {
      startDraftInWorkspace(workspacePath, workspaceIdentity);
    },
    [startDraftInWorkspace],
  );

  const {
    remoteWorkspaceSessions,
    reconnectingRemoteWorkspaceKeys,
    remoteWorkspaceErrorByWorkspaceKey,
    reconnectingRemoteWorkspaceLogsByWorkspaceKey,
    buildPersistedTabPatch,
    restorePersistedSession,
    handleCancelRemoteProject,
    handleSelectRemoteProject,
    handleConnectRemote,
    handleReconnectRemoteWorkspace,
    handleRemoteWorkspaceTabsClosed,
  } = useRemoteWorkspaceHistory({
    intl,
    services,
    platform,
    supportsSettings,
    allowRemoteWorkspace,
    // conversation backing workspace only belongs to the local desktop primary recovery link; remote windows and mobile phones
    // A shared-host attachment cannot therefore create a separate local runtime or change replayable boundaries.
    ensureConversationWorkspaceOnRestore: isDesktop && restoreSession && !initialWorkspaceIdentity,
    deferInactiveWorkspaceRestore: isDesktop && restoreSession && !initialWorkspaceIdentity,
    unavailableWorkspacePath,
    tabStoreApi,
    activateTabByPath,
    addTab,
    onWorkspaceActivated: handleRemoteWorkspaceActivated,
  });

  useEffect(() => {
    // When fileDisplay does not pass basePath by default, it needs to fall into the "currently activated workspace".
    // Previously, the pure tool layer could not get the workspace context in the window and could only return the absolute path, which resulted in the mention/file display in the input box being not concise enough.
    // Here, Root synchronizes a copy of the current context when switching workspaces, which not only retains the reusability of the tool layer, but also does not force Zustand dependencies into tool functions.
    setDefaultFileDisplayBasePath(activeWorkspacePath);
  }, [activeWorkspacePath]);

  useEffect(() => {
    if (!activeWorkspacePath) {
      return;
    }

    setWorkspaceActionError(null);
  }, [activeWorkspacePath, setWorkspaceActionError]);

  const { isRestoring, hasCompletedInitialRestore, hasCompletedFullRestore } = useTabPersistence({
    settingService: supportsSettings ? services.settingService : undefined,
    // When the account is not connected for the first time, the provider login entry will be determined later than the workspace is restored.
    // If the workspace is restored first, ChatView mount will trigger draft session warm-up and report an error behind the login page.
    restoreSession: restoreSession && canRestoreWorkspaceSession,
    persistSession: restoreSession && canRestoreWorkspaceSession,
    restorePersistedSession,
    buildPersistPatch: buildPersistedTabPatch,
  });

  useEffect(() => {
    if (!isDesktop || !hasCompletedFullRestore) return;
    // Reason for the bug: The single workspace of active-first is just the first screen projection of Renderer. If it is synchronized to the outside immediately,
    // The telemetry scope of other workspaces will be temporarily revoked. The full collection will be released only after it is completely completed.
    reconcileConversationTelemetryWorkspaceScopes(
      windowWorkspaceTabs.map((tab) => ({
        workspacePath: tab.workspacePath,
        ...(tab.workspaceIdentity ? { workspaceIdentity: tab.workspaceIdentity } : {}),
        ...(tab.remoteSessionId ? { remoteSessionId: tab.remoteSessionId } : {}),
      })),
    );
  }, [hasCompletedFullRestore, isDesktop, windowWorkspaceTabs]);

  const { tryRefresh, clearCredentials } = useTokenRefresh();
  void tryRefresh;
  void clearCredentials;
  // Startup blocking is the desktop window protection period, and the mobile web remote control has a pairing/loading page before entering Root.
  // If the web side continues to use this gate, an empty RootShell will be rendered before the workspace tab is injected, exposing the white background of the browser.
  const isStartupRenderBlocked = shouldShowRootStartupLoading({
    isDesktop,
    welcomeScreenOpen: Boolean(welcomeScreenOpenReason),
    isResolvingStartupAuthState,
    isResolvingProviderStartupState,
    isRestoring,
    isBootstrappingInitialWorkspace: isBootstrappingInitialWorkspace || isCreatingFallbackWorkspace,
  });

  const launchReportedRef = useRef(false);
  useEffect(() => {
    if (
      !shouldReportLaunchToInput({
        isStartupRenderBlocked,
        welcomeScreenOpen: Boolean(welcomeScreenOpenReason),
        alreadyReported: launchReportedRef.current,
      })
    ) {
      return;
    }
    launchReportedRef.current = true;
    const timings = readRendererLaunchTimings();
    if (!timings || !timings.marks) {
      return; // Anchors are missing (non-desktop/marks not injected), the entire batch is skipped
    }
    reportUiLaunchToInput({
      marks: timings.marks,
      rendererStart: timings.rendererStart,
      reactCommit: timings.reactCommit,
      inputReady: Date.now(), // T6
      sessionId: `launch-${timings.marks.createdAt}`,
    });
  }, [isStartupRenderBlocked, welcomeScreenOpenReason]);

  useRootPlatformEffects({
    initialWorkspaceAbsPath,
    initialWorkspaceIdentity,
    initialWorkspacePurpose,
    initialTaskId,
    // When system right-click/Service cold start is passed in initialWorkspacePath, historical tabs must be restored first.
    // Then merge the target workspace and activate it. Otherwise, addTab will be completely replaced by restoreTabs;
    // Directly disabling restoreSession will cause all other workspaces to disappear.
    canBootstrapInitialWorkspace: canRestoreWorkspaceSession && hasCompletedInitialRestore,
    addTab,
    setIsBootstrappingInitialWorkspace,
    platform,
    activateTabByPath,
    startDraftInWorkspace,
    startNewTaskFromActiveWorkspace,
    openWorkspace: handleOpenWorkspace,
    openWorkspacePath: (path) => {
      void handleSelectProject(path);
    },
    setWorkspaceActionError,
    allowOpenWorkspace,
    isDesktop,
    locale,
    tabs,
    activeWorkspacePath,
    activeWorkspaceIdentity,
    reconnectingRemoteWorkspaceKeys,
    remoteWorkspaceErrorByWorkspaceKey,
    totalUnreadTaskCount,
    hasCompletedFullTabRestore: hasCompletedFullRestore,
    intl,
    isRestoringOAuthSession: isResolvingStartupAuthState || providerStartupSyncPending,
  });

  useEffect(() => {
    if (!platform.onCloseActiveContextRequest) {
      return;
    }

    return platform.onCloseActiveContextRequest(() => {
      const event = new Event(CLOSE_ACTIVE_CONTEXT_REQUEST_EVENT, { cancelable: true });
      window.dispatchEvent(event);
      if (event.defaultPrevented) {
        return;
      }

      // The closing request is first broadcast to the workspace layer to determine the side pane active tab.
      // When there is no visible workspace or there is no side pane tab that can be closed, it falls back to window closing semantics.
      void platform.executeDesktopCommand(DesktopCommandIds.CloseWindow);
    });
  }, [platform]);

  useRootOAuthEffects({
    accountIntentKey: JSON.stringify([
      user?.id,
      appSettings?.providerFamilyDomain,
      appSettings?.providerFamilyConnectionSelections,
    ]),
    platform,
    services,
    refreshProviderState,
    refreshAppSettings,
    setUser,
    setIsRestoringOAuthSession,
    setOAuthError,
    oauthPollingActive,
    setOAuthPollingActive,
    markOAuthSuccess,
    onReauthenticationRequired: handleReauthenticationRequired,
  });

  useEffect(
    () =>
      platform.onPostUpdateReleaseNotes((payload) => {
        logger.info("[Root] received release notes, acknowledging silently", {
          version: payload.version,
          title: payload.title,
        });
        if (acknowledgingReleaseNotesVersionRef.current === payload.version) {
          return;
        }

        // Automatic updates will go here every time the release notes are hit to be displayed.
        // Previously, Root would immediately send the payload into the dialog state, causing users to be interrupted by forced pop-ups every time they updated.
        // This time the requirement is only to remove the pop-up window itself, so here it is changed to silently ack directly after receiving it.
        // It does not affect the "Update downloaded" button/menu/installation link, nor does it prevent the pending state from remaining until the next startup and triggering it again.
        acknowledgingReleaseNotesVersionRef.current = payload.version;
        void platform
          .acknowledgePostUpdateReleaseNotes(payload.version)
          .then(() => {
            logger.info("[Root] release notes acknowledged silently", {
              version: payload.version,
            });
          })
          .catch((error) => {
            logger.error("[Root] failed to acknowledge release notes silently", {
              version: payload.version,
              error,
            });
          })
          .finally(() => {
            if (acknowledgingReleaseNotesVersionRef.current === payload.version) {
              acknowledgingReleaseNotesVersionRef.current = null;
            }
          });
      }),
    [platform],
  );

  const canEnterNativeThemeSyncSurface = Boolean(
    !isStartupRenderBlocked &&
    !welcomeScreenOpenReason &&
    (workspaceShellPath || isSettingsTabActive),
  );

  useEffect(() => {
    if (!canEnterNativeThemeSyncSurface) {
      return;
    }

    // macOS nativeTheme affects window vibrancy. Wait here for RootStartupLoading
    // Allow synchronization after actually exiting and entering the main interface/settings page to prevent the startup shell background from being rewritten in advance by the application theme.
    setHasEnteredNativeThemeSyncSurface(true);
  }, [canEnterNativeThemeSyncSurface]);

  useDesktopNativeThemeSync({
    enabled: hasEnteredNativeThemeSyncSurface,
    isDesktop,
    platform,
    theme,
  });

  useRemoteWorkspaceTabLifecycle({
    tabs,
    activeWorkspaceTab,
    platform,
    onRemoteWorkspaceTabsClosed: handleRemoteWorkspaceTabsClosed,
  });

  useEffect(() => {
    if (
      shouldBlockRootRender({
        isResolvingStartupAuthState,
        isResolvingProviderStartupState,
        isRestoring,
        isBootstrappingInitialWorkspace,
      }) ||
      isStartupProviderLoginEntryOpen ||
      workspaceShellPath ||
      isSettingsTabActive ||
      !allowOpenWorkspace ||
      didRequestFallbackWorkspaceRef.current
    ) {
      return;
    }

    didRequestFallbackWorkspaceRef.current = true;
    setIsCreatingFallbackWorkspace(true);
    // The previous default empty state of the tab store would bring Root to the middle page of the open workspace.
    // After deleting the whole page process, the startup recovery is empty or the entry does not pass initialWorkspacePath. It must be in Root.
    // Go to the default workspace to prevent users from seeing an "open workspace" middle page or a blank page first.
    // The cleanup of the current effect cannot be used here as an asynchronous cancellation mark: setIsCreatingFallbackWorkspace
    // Or any change in workspaceShellPath after addTab will cause React to run cleanup first. If finally is skipped,
    // Enabling the loading gate will always remain true.
    services.fileService
      .ensureConversationWorkspace()
      .then((result) => {
        // The creation of the directory may be initiated earlier than the session recovery is initiated and returned later than the recovery is completed.
        // After returning, you must press the latest active workspace in the tab store to judge again to prevent the late default project from grabbing the last restored tab.
        if (
          !shouldOpenFallbackWorkspaceAfterCreate({
            isMounted: rootInnerMountedRef.current,
            activeWorkspacePath: tabStoreApi.getState().activeWorkspacePath,
          })
        ) {
          return;
        }
        handleSelectConversationWorkspace(result.path);
      })
      .catch((error) => {
        if (!rootInnerMountedRef.current) {
          return;
        }
        logger.error("[Root] failed to create default workspace during startup fallback", {
          error,
        });
        setWorkspaceActionError(error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        if (rootInnerMountedRef.current) {
          setIsCreatingFallbackWorkspace(false);
        }
      });
  }, [
    allowOpenWorkspace,
    handleSelectConversationWorkspace,
    isBootstrappingInitialWorkspace,
    isResolvingProviderStartupState,
    isResolvingStartupAuthState,
    isRestoring,
    isSettingsTabActive,
    isStartupProviderLoginEntryOpen,
    services.fileService,
    setWorkspaceActionError,
    tabStoreApi,
    workspaceShellPath,
  ]);

  useEffect(() => {
    if (!workspaceShellPath) {
      return;
    }

    logger.info(
      `[Root] settings view ${isSettingsTabActive ? "open" : "closed"} workspace=${workspaceShellPath}`,
    );
  }, [isSettingsTabActive, workspaceShellPath]);

  useEffect(() => {
    if (!loginEntryRequest) {
      return;
    }
    // The login portal has converged from modal pop-up window to WelcomeScreen.
    // The provider connection request must still exit the first boot boot semantics first to avoid accidentally creating a default workspace after the connection is completed.
    setWelcomeScreenOpenReason("provider-request");
  }, [loginEntryRequest]);

  const handleOpenLoginEntry = () => {
    setWelcomeScreenOpenReason("manual-login");
  };
  const handleWelcomeScreenComplete = useCallback(
    async (reason: LoginCompleteReason) => {
      await refreshAppSettings();
      if (
        welcomeScreenOpenReason !== "startup-provider-required" ||
        workspaceShellPath ||
        !allowOpenWorkspace
      ) {
        setWelcomeScreenOpenReason(null);
        return;
      }

      try {
        await handleEnsureConversationWorkspace();
      } catch (error) {
        logger.error("[Root] failed to create default workspace after sign-in", {
          error,
          reason,
        });
      } finally {
        setWelcomeScreenOpenReason(null);
      }
    },
    [
      allowOpenWorkspace,
      handleEnsureConversationWorkspace,
      refreshAppSettings,
      welcomeScreenOpenReason,
      workspaceShellPath,
    ],
  );
  const handleRemoteConnectionDialogOpenChange = useCallback((open: boolean) => {
    setRemoteConnectionDialogOpen(open);
    if (!open) {
      setRemoteConnectionOpenPreference(null);
    }
  }, []);

  const remoteConnectionDialog = allowRemoteWorkspace ? (
    <SSHDialog
      onConnect={handleConnectRemote}
      onSelectProject={handleSelectRemoteProject}
      onCancelSession={handleCancelRemoteProject}
      localWorkspacePath={localWorkspacePathForRemoteConnection}
      remoteWorkspaceSessions={remoteWorkspaceSessions}
      open={remoteConnectionDialogOpen}
      onOpenChange={handleRemoteConnectionDialogOpenChange}
      onFlowActiveChange={setRemoteConnectionInProgress}
      onFlowRequestIdChange={setRemoteConnectionRequestId}
      preferredKind={remoteConnectionOpenPreference?.preferredKind}
      hideTriggerWhenClosed
    />
  ) : null;
  const directoryBrowserDialog = directoryBrowserOpen ? (
    <ScopedErrorBoundary
      scope="directory-browser"
      resetKeys={["directory-browser"]}
      variant="silent"
    >
      <DirectoryBrowser
        services={services}
        onCancel={() => setDirectoryBrowserOpen(false)}
        onSelect={(path) => {
          setDirectoryBrowserOpen(false);
          void handleSelectProject(path);
        }}
      />
    </ScopedErrorBoundary>
  ) : null;

  useEffect(() => {
    const wasInProgress = previousRemoteConnectionInProgressRef.current;
    if (!wasInProgress && remoteConnectionInProgress) {
      resetRemoteConnectionLogs();
    }
    previousRemoteConnectionInProgressRef.current = remoteConnectionInProgress;
  }, [remoteConnectionInProgress, resetRemoteConnectionLogs]);

  const settingsLayerProps = {
    isDesktop,
    isMacDesktop,
    isWindowsDesktop,
    captionWorkspacePath: activeWorkspacePath,
    onBack: activeWorkspacePath ? handleBackFromSettings : undefined,
    onCreateTask: handleCreateTask,
    onOpenWorkspace: handleOpenWorkspace,
    allowOpenWorkspace,
    onLogin: !user ? handleOpenLoginEntry : undefined,
    onLogout: user ? handleLogout : undefined,
    user,
  };

  if (isStartupRenderBlocked) {
    const loadingLabel = intl.formatMessage({ id: "common.loading" });
    return (
      <RootShell>
        {rootModelSelectionErrorNode}
        {remoteConnectionDialog}
        {directoryBrowserDialog}
        {/* The HTML startup shell already renders the ZCode SVG, but once React takes over the root the old
            shell is replaced wholesale. It used to re-render a plain-text "Loading..." while
            blocking tab restore / initial workspace injection, so startup was split into two
            separate loading experiences. Here the same SVG startup screen is reused and the wording
            is kept only in the aria-label, so the visuals stay continuous without sacrificing
            accessibility.
            */}
        <RootStartupLoading label={loadingLabel} />
      </RootShell>
    );
  }

  if (welcomeScreenOpenReason) {
    return (
      <RootShell>
        {rootModelSelectionErrorNode}
        {remoteConnectionDialog}
        {directoryBrowserDialog}
        <WelcomeScreen onComplete={handleWelcomeScreenComplete} />
      </RootShell>
    );
  }

  if (
    !workspaceShellPath &&
    !isDesktop &&
    initialWorkspaceAbsPath &&
    initialWorkspaceLoadingFallback
  ) {
    // The workspace tab of non-desktop entrance is injected by effect, and the first frame cannot return null.
    // Continue the entry loading here, and wait until the task list has workspaceShellPath before switching to avoid exposing the white background of the browser.
    return (
      <RootShell>
        {rootModelSelectionErrorNode}
        {initialWorkspaceLoadingFallback}
        {directoryBrowserDialog}
      </RootShell>
    );
  }

  return (
    <RootShell>
      {rootModelSelectionErrorNode}
      {remoteConnectionDialog}
      {directoryBrowserDialog}
      <OccupationOnboarding
        showWindowControls={Boolean(isWindowsDesktop || (isDesktop && !isMacDesktop))}
        showChildrenWhileLoading={!workspaceShellPath && isSettingsTabActive}
        isMacDesktop={isMacDesktop}
        isWindowsDesktop={isWindowsDesktop}
      >
        {/* The new onboarding is an app-level preference; it must be mounted even when there is no project, so it can answer manual open requests from the settings page. */}
        {!workspaceShellPath ? (
          isSettingsTabActive ? (
            <ScopedErrorBoundary
              scope="settings-page"
              resetKeys={["settings-root"]}
              variant="panel"
              className="h-full"
            >
              <SettingsPage {...settingsLayerProps} />
            </ScopedErrorBoundary>
          ) : null
        ) : (
          <RootWorkspaceContent
            workspaceScopedServices={workspaceScopedServices}
            baseFeedbackService={services.feedbackService}
            workspaceShellPath={workspaceShellPath}
            workspaceIdentity={workspaceShellIdentity}
            workspaceRemoteSessionId={workspaceShellRemoteSessionId}
            activeWorkspacePath={activeWorkspacePath}
            isSettingsTabActive={isSettingsTabActive}
            handleConnectRemote={handleConnectRemote}
            handleSelectRemoteProject={handleSelectRemoteProject}
            handleCancelRemoteProject={handleCancelRemoteProject}
            handleReconnectRemoteWorkspace={handleReconnectRemoteWorkspace}
            handleCreateTask={handleCreateTask}
            handleCreateConversationTask={handleCreateConversationTask}
            handleResolveConversationWorkspace={handleResolveConversationWorkspace}
            handleOpenWorkspace={handleOpenWorkspace}
            handleOpenFolderFromWorkspaceMenu={handleOpenFolderFromWorkspaceMenu}
            handleOpenRemoteWorkspace={
              allowRemoteWorkspace ? handleOpenRemoteConnection : undefined
            }
            handleCreateScratchWorkspace={handleCreateScratchWorkspace}
            remoteConnectionInProgress={remoteConnectionInProgress}
            remoteWorkspaceSessions={remoteWorkspaceSessions}
            allowRemoteWorkspace={allowRemoteWorkspace}
            handleBackFromSettings={handleBackFromSettings}
            handleLogout={user ? handleLogout : undefined}
            onLogin={!user ? handleOpenLoginEntry : undefined}
            user={user}
            reconnectingRemoteWorkspaceKeys={reconnectingRemoteWorkspaceKeys}
            remoteWorkspaceErrorByWorkspaceKey={remoteWorkspaceErrorByWorkspaceKey}
            reconnectingRemoteWorkspaceLogsByWorkspaceKey={
              reconnectingRemoteWorkspaceLogsByWorkspaceKey
            }
            remoteConnectionLogs={remoteConnectionLogs}
            allowOpenWorkspace={allowOpenWorkspace}
            isDesktop={isDesktop}
            isMacDesktop={isMacDesktop}
            isWindowsDesktop={isWindowsDesktop}
            supportsEmbeddedBrowser={supportsEmbeddedBrowser}
          />
        )}
        <ScopedErrorBoundary
          scope="onboarding-dialog"
          resetKeys={[workspaceShellIdentity?.trim() || workspaceShellPath]}
          variant="silent"
        >
          <OnboardingDialog
            workspacePath={workspaceShellPath || undefined}
            workspaceIdentity={workspaceShellIdentity}
            isDesktop={isDesktop}
          />
        </ScopedErrorBoundary>
      </OccupationOnboarding>
    </RootShell>
  );
}
