/* eslint-disable max-lines -- App currently orchestrates workspace-level state, navigation,
 * Git-derived data, and shell wiring in one place; the new side pane memory bridge has been
 * extracted, and the remaining split needs its own refactor along shell boundaries.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import type { GitChangeSourceId, WorkspacePurpose } from "@zcode/shared";
import { useZCodeStore } from "@/store/StoreProvider.js";
import { getVisibleTaskMetas, useZCodeSessionStore } from "@/store/zcodeSessionStore.js";
import { useTaskQueryCacheStore } from "@/store/taskQueryCacheStore.js";
import { useAppPanels } from "@/hooks/useAppPanels.js";
import { useGitAutoRefresh } from "@/hooks/useGitAutoRefresh.js";
import { useGitRepository } from "@/hooks/useGitRepository.js";
import { useAppKeyboard } from "@/hooks/useAppKeyboard.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { useWorkspaceActiveTaskState } from "@/hooks/useWorkspaceActiveTaskState.js";
import { useEnsureWorkspaceMcpLoaded } from "@/hooks/useEnsureWorkspaceMcpLoaded.js";
import { useTabStore } from "@/store/TabStoreProvider.js";
import { isWorkspaceReadOnly, isWorkspaceTab } from "@/store/tabStore.js";
import type { TaskChatMessage as TestChatMessage } from "@/lib/taskChatMessageTypes.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useIsOfficeMode } from "@/hooks/useInterfaceMode.js";
import { getPathLeaf } from "@/lib/path.js";
import {
  addPluginStoreOpenListener,
  type PluginStoreOpenTarget,
} from "@/lib/pluginStoreNavigation.js";
import { resolveWorkspaceSwitchDraftProvider } from "@/lib/workspaceDraftProvider.js";
import { useTestActions } from "@/test-actions.js";
import type { TestActions } from "@/test-actions.js";
import { useShortcutCommandLabel } from "@/shortcuts/useShortcutBindings.js";
import type { TaskFindDialogProps } from "@/quickpick/TaskFindDialog.js";
import {
  changeTaskFindSelection,
  createTaskFindNavigationState,
  navigateTaskFindSelection,
} from "@/quickpick/taskFindNavigationState.js";
import { createQuickPickCommands } from "@/quickpick/quickPickCommands.js";
import { CommandCenterDialog } from "@/command-center/CommandCenterDialog.js";
import { FeedbackHost } from "@/feedback/FeedbackHost.js";
import { useFeedbackStore } from "@/feedback/feedbackStore.js";
import {
  resolveQuickPickConversationNavigation,
  selectQuickPickConversationTaskIds,
} from "@/lib/quickPickConversationNavigation.js";
import {
  setPendingSettingsPluginIntent,
  setPendingSettingsSection,
  type SettingsSectionId,
} from "@/lib/settingsNavigation.js";
import { runWorkspaceVisibleCommand } from "@/lib/workspaceVisibleCommand.js";
import { ZCODE_PRODUCT_DOCS_URL } from "@/lib/productDocs.js";
import appLogoUrl from "@/assets/provider-icons/logo-zai.svg";
import { resolveTheme } from "@/useTheme.js";
import { WorkspaceShellLayout } from "@/app-shell/WorkspaceShellLayout.js";
import { useAppChromeState } from "@/app-shell/useAppChromeState.js";
import { useWorkspaceSessionReload } from "@/app-shell/useWorkspaceSessionReload.js";
import { useWorkspaceShellLifecycle } from "@/app-shell/useWorkspaceShellLifecycle.js";
import { useWorkspaceShellZCodeState } from "@/app-shell/useWorkspaceShellZCodeState.js";
import { useWorkspaceMainViewSettingsExit } from "@/app-shell/useWorkspaceMainViewSettingsExit.js";
import {
  useWorkspaceTaskNavigation,
  type AutomationsNavigationTarget,
} from "@/app-shell/useWorkspaceTaskNavigation.js";
import { useTaskSidePaneMemoryBridge } from "@/app-shell/useTaskSidePaneMemoryBridge.js";
import { resolveAppWorkspaceRpcTarget } from "@/app-shell/workspaceRpcTarget.js";
import { useWorkspaceServicesResolution } from "@/hooks/useWorkspaceServices.js";
import { useWorkspaceTerminalTaskNotifications } from "@/hooks/useTaskNotifications.js";
import { useOffPeakTaskNotifications } from "@/hooks/useOffPeakTaskNotifications.js";
import type { AppProps, WorkspaceMainView } from "@/app-shell/types.js";
import type {
  ChatSearchResultHighlightRequest,
  ChatViewSummaryPanelVariant,
  ConversationFindMatchState,
} from "@/v4/legacyChatViewTypes.js";
import { getActiveSidePaneTab } from "@/lib/workspaceSidePane.js";
import { logger } from "@/logger.js";
import { taskListE2EActions } from "@/lib/taskListE2EActions.js";
import {
  CLOSE_ACTIVE_CONTEXT_REQUEST_EVENT,
  getCloseActiveContextSidePaneTab,
} from "@/lib/closeActiveContext.js";
import { usePaneLayoutStore } from "@/v4/paneLayoutStore.js";
import { useWorkbenchGroupStore } from "@/v4/workbenchGroupStore.js";
import type { AssistantPreviewCardsAutoOpenRequest } from "@/lib/assistantPreviewCards.js";
import { startMemoryDiagnosticsLogger } from "@/lib/memoryDiagnostics.js";

const EMPTY_RECONNECTING_REMOTE_WORKSPACE_LOGS_BY_WORKSPACE_KEY: NonNullable<
  AppProps["reconnectingRemoteWorkspaceLogsByWorkspaceKey"]
> = {};
const EMPTY_REMOTE_CONNECTION_LOGS: NonNullable<AppProps["remoteConnectionLogs"]> = [];
const EMPTY_REMOTE_WORKSPACE_SESSIONS: NonNullable<AppProps["remoteWorkspaceSessions"]> = [];

export function App({
  services,
  baseFeedbackService,
  onConnectRemote,
  onSelectRemoteProject,
  onCancelRemoteProject,
  onReconnectRemoteWorkspace,
  onLogout,
  onLogin,
  user,
  reconnectingRemoteWorkspaceKeys,
  remoteWorkspaceErrorByWorkspaceKey,
  reconnectingRemoteWorkspaceLogsByWorkspaceKey = EMPTY_RECONNECTING_REMOTE_WORKSPACE_LOGS_BY_WORKSPACE_KEY,
  remoteConnectionLogs = EMPTY_REMOTE_CONNECTION_LOGS,
  onCreateTask,
  onCreateConversationTask,
  onResolveConversationWorkspace,
  onOpenWorkspace,
  onOpenFolderFromWorkspaceMenu,
  onOpenRemoteWorkspace,
  onCreateScratchWorkspace,
  remoteConnectionInProgress = false,
  onReturnToWorkspace,
  allowOpenWorkspace = true,
  allowRemoteWorkspace = true,
  remoteWorkspaceSessions = EMPTY_REMOTE_WORKSPACE_SESSIONS,
  workspaceAbsPath,
  workspaceRemoteSessionId,
  workspaceIdentity: explicitWorkspaceIdentity,
  isWorkspaceVisible = true,
  isDesktop,
  isMacDesktop,
  isWindowsDesktop,
  supportsEmbeddedBrowser: explicitSupportsEmbeddedBrowser,
}: AppProps) {
  // The display label is uniformly taken from the shortcut key effective table (the tooltip is updated synchronously after the user changes the key), and the key position is no longer hard-coded.
  const toggleSidebarShortcutLabel = useShortcutCommandLabel("toggleSidebar");
  const newTaskShortcutLabel = useShortcutCommandLabel("newTask");
  const goBackShortcutLabel = useShortcutCommandLabel("navigateBack");
  const goForwardShortcutLabel = useShortcutCommandLabel("navigateForward");
  const toggleTerminalShortcutLabel = useShortcutCommandLabel("toggleTerminal");
  const toggleSidePaneShortcutLabel = useShortcutCommandLabel("toggleSidePane");
  const openWorkspaceShortcutLabel = useShortcutCommandLabel("openWorkspace");
  const isLinuxDesktop = Boolean(isDesktop && !isMacDesktop && !isWindowsDesktop);
  const supportsEmbeddedBrowser = explicitSupportsEmbeddedBrowser ?? Boolean(isDesktop);
  const { intl } = useZCodeIntl();
  const isOfficeMode = useIsOfficeMode();
  const platform = usePlatform();
  // Process memory local diagnostic log: one 60s sampler per window,
  // Write the main desktop log after gating; no-op when there is no log bridge on the Web side. The same reading also sends the heap to main through the preload bridge.
  // renderer_main resource event, also no-op when there is no bridge.
  const reportRendererHeapSample = platform.reportRendererHeapSample;
  useEffect(() => {
    const memoryDiagnosticsLogger = startMemoryDiagnosticsLogger({
      reportHeapSample: reportRendererHeapSample,
    });
    return () => memoryDiagnosticsLogger.stop();
  }, [reportRendererHeapSample]);
  const activeWorkspaceRpcTarget = useTabStore(
    useShallow((state) => {
      if (!state.activeTabId) {
        return {
          workspaceIdentity: undefined,
          remoteSessionId: undefined,
          remoteTarget: undefined,
        };
      }

      const activeTab = state.tabs.find((tab) => tab.id === state.activeTabId);
      if (
        !activeTab ||
        !isWorkspaceTab(activeTab) ||
        activeTab.workspacePath !== workspaceAbsPath
      ) {
        return {
          workspaceIdentity: undefined,
          remoteSessionId: undefined,
          remoteTarget: undefined,
        };
      }

      return {
        workspaceIdentity: activeTab.workspaceIdentity,
        remoteSessionId: activeTab.remoteSessionId,
        remoteTarget: activeTab.remoteTarget,
      };
    }),
  );
  const workspaceRpcTarget = resolveAppWorkspaceRpcTarget({
    activeTarget: activeWorkspaceRpcTarget,
    explicitWorkspaceIdentity,
    explicitRemoteSessionId: workspaceRemoteSessionId,
  });
  // When the Settings tab overrides the workspace, the active tab is not the workspace tab.
  // The workspaceIdentity passed in by Root must be used here, otherwise the remote disconnection state will treat /home/... as the local base workspace to warm up.
  const workspaceIdentity = workspaceRpcTarget.workspaceIdentity;
  const { rpcReady: workspaceRpcReady } = useWorkspaceServicesResolution(
    workspaceAbsPath,
    workspaceRpcTarget.remoteSessionId,
    workspaceIdentity,
    workspaceRpcTarget.remoteTarget,
  );
  const workspaceReadOnly = useTabStore((state) =>
    isWorkspaceReadOnly(state, workspaceAbsPath, workspaceIdentity),
  );
  const workspaceReadOnlyReason = workspaceReadOnly
    ? intl.formatMessage({ id: "workspaceSidebar.unavailableLocalDirectory" })
    : undefined;
  const { workspaceShellZCodeState, reloadSessionDisabled } = useWorkspaceShellZCodeState(
    workspaceAbsPath,
    workspaceIdentity,
  );
  const activeTaskId = workspaceShellZCodeState.activeTaskId;
  // The right column isolates the ownership id by conversation: the draft activeTaskId is null, use draftSessionId to find out.
  //(draftSessionId is stable, unique for each new conversation, and will become activeTaskId after sending the first message),
  // Therefore, the new conversation will not be linked to the tab left by the previous conversation/draft, and the tab ownership will be seamless after the draft is corrected.
  const draftSessionId = useZCodeSessionStore(
    (state) => state.getWorkspaceState(workspaceAbsPath, workspaceIdentity).draftSessionId,
  );
  const sidePaneOwnerId = activeTaskId ?? draftSessionId ?? null;
  const [summaryPanelVariantOverride, setSummaryPanelVariantOverride] =
    useState<ChatViewSummaryPanelVariant | null>(null);
  const draftFocusVersion = workspaceShellZCodeState.draftFocusVersion;
  const {
    isTerminalOpen,
    setIsTerminalOpen,
    sidePaneState,
    recentClosedSidePaneTabs,
    isSidePaneCollapsed,
    setIsSidePaneCollapsed,
    isSidebarVisible,
    browserNavigationRequest,
    setBrowserNavigationRequest,
    handleOpenCodeViewer,
    handleOpenCodeViewers,
    handleOpenBrowserUrl,
    handleToggleBrowser,
    handleOpenBrowserTab,
    handleToggleGit,
    handleOpenGit,
    handleOpenTreemapping,
    handleOpenWhiteboard,
    handleOpenDeveloperTools,
    handleOpenTerminalTab,
    handleOpenSubagentSession,
    handleOpenBackgroundBash,
    handleOpenSubagentDirectory,
    handleSyncSubagentSessionTabs,
    handleOpenSelectionSideChat,
    handleOpenPlanDetail,
    handleOpenWorkflowRun,
    handleOpenWorkflowRunDirectory,
    handleOpenWorkflowActorSession,
    handleOpenWorkflowWorkspace,
    handleOpenWorkflowArtifact,
    handleToggleTerminal,
    handleToggleSidebar,
    handleToggleSidePaneCollapse,
    handleCloseCodeViewer,
    handleCloseGit,
    handleActivateSidePaneTab,
    handleReorderSidePaneTab,
    handleCloseSidePaneTab,
    handleCloseOtherSidePaneTabs,
    handleCloseAllSidePaneTabs,
    handleReopenClosedSidePaneTab,
    handleBrowserNavigationRequestHandled,
    handleBrowserPageMetadataChange,
  } = useAppPanels({
    workspaceAbsPath,
    workspaceIdentity,
    workspaceRemoteSessionId,
    activeTaskId,
    sidePaneOwnerId,
    isDesktop,
    isWorkspaceVisible,
    supportsEmbeddedBrowser,
    platform,
    defaultWhiteboardNamePrefix: intl.formatMessage({
      id: "whiteboard.defaultName",
    }),
  });
  const workspaceKey = workspaceIdentity?.trim() || workspaceAbsPath;
  const notificationEnabled = useZCodeStore((s) => s.notificationEnabled);
  useWorkspaceTerminalTaskNotifications({
    workspacePath: workspaceAbsPath,
    ...(workspaceIdentity ? { workspaceIdentity } : {}),
    ...(workspaceRemoteSessionId ? { endpointKey: workspaceRemoteSessionId } : {}),
    enabled: notificationEnabled,
    rpcReady: workspaceRpcReady,
    platform,
    formatMessage: intl.formatMessage,
  });
  // Task final status/waiting confirmation notification during idle time: only desktop local link, main process deduplicates multi-window duplication according to status:taskId.
  useOffPeakTaskNotifications({
    offPeakTaskService: services.offPeakTaskService,
    platform,
    enabled: Boolean(notificationEnabled && isDesktop),
    formatMessage: intl.formatMessage,
  });
  const lastHandledDraftSidePaneCloseRef = useRef({
    workspaceKey,
    draftFocusVersion,
  });

  useEffect(() => {
    const previous = lastHandledDraftSidePaneCloseRef.current;
    if (previous.workspaceKey !== workspaceKey) {
      lastHandledDraftSidePaneCloseRef.current = {
        workspaceKey,
        draftFocusVersion,
      };
      return;
    }

    if (previous.draftFocusVersion === draftFocusVersion) {
      return;
    }

    lastHandledDraftSidePaneCloseRef.current = {
      workspaceKey,
      draftFocusVersion,
    };
    if (draftFocusVersion === 0) {
      return;
    }

    // Creating a new task will only switch the activeTaskId to draft, and will not trigger the workspace-level memory switching of the side pane.
    // Therefore, use the incremented version number of startDraft to uniformly collapse the right panel, covering buttons, menus, shortcut keys and remote control entrances.
    const sidePaneTabCount = sidePaneState?.tabs.length ?? 0;
    if (!isSidePaneCollapsed) {
      logger.info(
        `[App] collapsing right side pane for new task workspace=${workspaceAbsPath} tabs=${sidePaneTabCount}`,
      );
      setIsSidePaneCollapsed(true);
    }
  }, [
    draftFocusVersion,
    isSidePaneCollapsed,
    setIsSidePaneCollapsed,
    sidePaneState,
    workspaceAbsPath,
    workspaceKey,
  ]);
  const [testMessages, setTestMessages] = useState<TestChatMessage[] | null>(null);
  const [isQuickPickOpen, setIsQuickPickOpen] = useState(false);
  const [isTaskFindOpen, setIsTaskFindOpen] = useState(false);
  const [taskFindFocusRequestId, setTaskFindFocusRequestId] = useState(0);
  const [conversationFindState, setConversationFindState] = useState(createTaskFindNavigationState);
  const [conversationFindMatchCount, setConversationFindMatchCount] = useState(0);
  const searchResultHighlightRequestIdRef = useRef(0);
  const [searchResultHighlightRequest, setSearchResultHighlightRequest] =
    useState<ChatSearchResultHighlightRequest | null>(null);
  const [fileChangeFindState, setFileChangeFindState] = useState(createTaskFindNavigationState);
  const [fileChangeFindMatchCount, setFileChangeFindMatchCount] = useState(0);
  const [canOpenCommunityFromQuickPick, setCanOpenCommunityFromQuickPick] = useState(false);
  const [gitSelectedSourceId, setGitSelectedSourceId] = useState<GitChangeSourceId>("unstaged");
  const [gitRefreshVersion, setGitRefreshVersion] = useState(0);
  const { browserRestoreUrls, handleBrowserUrlChange } = useTaskSidePaneMemoryBridge({
    activeTaskId,
    gitSelectedSourceId,
    setGitSelectedSourceId,
    workspaceAbsPath,
    workspaceIdentity,
  });
  const theme = useZCodeStore((s) => s.theme);
  const setTheme = useZCodeStore((s) => s.setTheme);
  const {
    isMacFullscreen,
    desktopWindowChromeState,
    macWindowControlsLeftPaddingPx,
    windowsWindowControlsRightPaddingPx,
    updateReadyVersion,
    updateState,
    sidebarContainerRef,
  } = useAppChromeState({
    isDesktop,
    isMacDesktop,
    isWindowsDesktop,
    platform,
    workspaceAbsPath,
  });
  const tabs = useTabStore((s) => s.tabs);
  const addTab = useTabStore((s) => s.addTab);
  const activateTabByPath = useTabStore((s) => s.activateTabByPath);

  const {
    resolvedActiveTaskMeta,
    activeTraceId,
    activeSessionId,
    activeTaskProvider,
    activeTaskChangeSummary,
    activeTaskTitle,
    taskNativeSessionLogFile,
    taskSessionFile,
  } = useWorkspaceActiveTaskState({
    workspaceAbsPath,
    activeTaskId,
    workspaceRemoteSessionId,
    workspaceIdentity,
    selectedProvider: workspaceShellZCodeState.selectedProvider,
    intl,
  });
  const workspaceTabs = useMemo(
    () =>
      tabs.filter(isWorkspaceTab).map((tab) => ({
        workspacePath: tab.workspacePath,
        label: tab.label,
        remoteSessionId: tab.remoteSessionId,
        remoteTarget: tab.remoteTarget,
        workspaceIdentity: tab.workspaceIdentity,
        workspacePurpose: tab.workspacePurpose,
        localWorkspacePath: tab.localWorkspacePath,
        availability: tab.availability,
      })),
    [tabs],
  );
  const commandCenterWorkspaceTabs = useMemo(() => tabs.filter(isWorkspaceTab), [tabs]);
  const activeSidePaneTab = useMemo(() => getActiveSidePaneTab(sidePaneState), [sidePaneState]);
  const isBrowserOpen = activeSidePaneTab?.type === "browser";
  const isGitOpen = activeSidePaneTab?.type === "git";
  const hasGitTab = sidePaneState?.tabs.some((tab) => tab.type === "git") ?? false;
  const handleRefreshGit = useCallback(() => {
    setGitRefreshVersion((value) => value + 1);
  }, []);
  const openSettingsTab = useTabStore((state) => state.openSettingsTab);
  const gitState = useGitRepository({
    workspacePath: workspaceAbsPath,
    activeTaskId,
    includeExtendedData: hasGitTab,
    // Key logic: Real Git only re-pulls when the workspace changes, Git pane is opened, or the user explicitly clicks refresh.
    // Task switching / last-turn summary changes only update local derived data, and no longer rerun Git commands.
    refreshToken: gitRefreshVersion,
    remoteSessionId: workspaceRpcTarget.remoteSessionId ?? null,
    remoteTarget: workspaceRpcTarget.remoteTarget,
    workspaceIdentity,
  });
  useGitAutoRefresh({
    workspacePath: workspaceAbsPath,
    workspaceIdentity,
    remoteSessionId: workspaceRpcTarget.remoteSessionId ?? null,
    gitSummary: gitState.summary,
    gitSummaryWorkspaceKey: gitState.workspaceKey,
    enabled: isWorkspaceVisible,
    onRefreshGit: handleRefreshGit,
  });
  const activeGitSourceId =
    gitState.sourceOptions.find((option) => option.id === gitSelectedSourceId)?.id ??
    gitState.sourceOptions[0]?.id ??
    "unstaged";
  const gitChangeSummaryBySourceId = useMemo(() => {
    // Key business logic: both workspace header and Git pane rely on the same set of source statistics.
    // Here, the +/- from each source is first summarized into a stable mapping to avoid display inconsistency after repeated calculations at different locations.
    return Object.fromEntries(
      gitState.sourceOptions.map((option) => {
        const dataset = gitState.datasets[option.id] ?? gitState.datasets.unstaged;
        const summary = dataset.sections
          .flatMap((section) => section.changes)
          .reduce(
            (result, change) => {
              result.added += change.added;
              result.removed += change.removed;
              return result;
            },
            { added: 0, removed: 0 },
          );
        return [option.id, summary];
      }),
    ) as Record<GitChangeSourceId, { added: number; removed: number }>;
  }, [gitState.datasets, gitState.sourceOptions]);
  const gitWorktreeChangeSummary = useMemo(() => {
    const unstaged = gitChangeSummaryBySourceId.unstaged ?? {
      added: 0,
      removed: 0,
    };
    const staged = gitChangeSummaryBySourceId.staged ?? {
      added: 0,
      removed: 0,
    };
    return {
      added: unstaged.added + staged.added,
      removed: unstaged.removed + staged.removed,
    };
  }, [gitChangeSummaryBySourceId]);
  const gitWorktreeReviewSourceId = useMemo<GitChangeSourceId | null>(() => {
    const unstaged = gitChangeSummaryBySourceId.unstaged ?? {
      added: 0,
      removed: 0,
    };
    const staged = gitChangeSummaryBySourceId.staged ?? {
      added: 0,
      removed: 0,
    };
    if (unstaged.added + unstaged.removed > 0) {
      return "unstaged";
    }
    if (staged.added + staged.removed > 0) {
      return "staged";
    }
    return null;
  }, [gitChangeSummaryBySourceId]);
  const handleOpenGitReview = useCallback(
    (sourceId?: GitChangeSourceId) => {
      if (workspaceReadOnlyReason) {
        return;
      }
      if (sourceId) {
        setGitSelectedSourceId(sourceId);
      }
      handleOpenGit();
    },
    [handleOpenGit, workspaceReadOnlyReason],
  );
  const isSidePaneOpen = !isSidePaneCollapsed;
  useEffect(() => {
    const handleCloseActiveContextRequest = (event: Event) => {
      const activeTab = getCloseActiveContextSidePaneTab({
        isWorkspaceVisible,
        isSidePaneCollapsed,
        sidePaneState,
      });
      if (!activeTab) {
        return;
      }

      // Cmd/Ctrl+W on the desktop menu will go to the main process first.
      // Here, the request is blocked at the visible workspace layer, and the active tab is closed when the side pane on the right is opened.
      // Instead of letting the Root fallback continue to close the entire window.
      event.preventDefault();
      handleCloseSidePaneTab(activeTab.id);
    };

    window.addEventListener(CLOSE_ACTIVE_CONTEXT_REQUEST_EVENT, handleCloseActiveContextRequest);
    return () => {
      window.removeEventListener(
        CLOSE_ACTIVE_CONTEXT_REQUEST_EVENT,
        handleCloseActiveContextRequest,
      );
    };
  }, [handleCloseSidePaneTab, isSidePaneCollapsed, isWorkspaceVisible, sidePaneState]);
  const handleToggleSidePane = useCallback(() => {
    // Interaction description: toggle panel only changes the visibility of the container on the right, and does not implicitly create or switch any tabs.
    // Previously, when there was no tab, diff/browser would automatically open the content, causing users to just want to open the side pane.
    // But get a new Browser or Review. Now the empty content is uniformly handed over to Open tab to handle the empty state.
    handleToggleSidePaneCollapse();
  }, [handleToggleSidePaneCollapse]);
  const runVisibleWorkspaceCommand = useCallback(
    (run: () => void) => {
      runWorkspaceVisibleCommand({
        isWorkspaceVisible,
        onReturnToWorkspace,
        run,
      });
    },
    [isWorkspaceVisible, onReturnToWorkspace],
  );
  const handleCreateTaskIfWritable = useCallback(
    (request?: Parameters<typeof onCreateTask>[0]) => {
      if (!workspaceReadOnlyReason) {
        onCreateTask(request);
      }
    },
    [onCreateTask, workspaceReadOnlyReason],
  );
  const handleToggleTerminalIfWritable = useCallback(() => {
    if (!workspaceReadOnlyReason) {
      handleToggleTerminal();
    }
  }, [handleToggleTerminal, workspaceReadOnlyReason]);
  const handleOpenTerminalTabIfWritable = useCallback(() => {
    if (!workspaceReadOnlyReason) {
      handleOpenTerminalTab();
    }
  }, [handleOpenTerminalTab, workspaceReadOnlyReason]);
  const handleOpenGitIfWritable = useCallback(() => {
    if (!workspaceReadOnlyReason) {
      handleOpenGit();
    }
  }, [handleOpenGit, workspaceReadOnlyReason]);
  const handleToggleGitIfWritable = useCallback(() => {
    if (!workspaceReadOnlyReason) {
      handleToggleGit();
    }
  }, [handleToggleGit, workspaceReadOnlyReason]);
  const handleOpenCodeViewerIfWritable = useCallback(
    (...args: Parameters<typeof handleOpenCodeViewer>) => {
      if (!workspaceReadOnlyReason) {
        handleOpenCodeViewer(...args);
      }
    },
    [handleOpenCodeViewer, workspaceReadOnlyReason],
  );
  const handleAutoOpenAssistantPptx = useCallback(
    (request: AssistantPreviewCardsAutoOpenRequest) => {
      if (!isDesktop || workspaceReadOnlyReason) {
        return;
      }
      handleOpenCodeViewers(request.sources);
    },
    [handleOpenCodeViewers, isDesktop, workspaceReadOnlyReason],
  );
  const handleOpenTreemappingIfWritable = useCallback(
    (...args: Parameters<typeof handleOpenTreemapping>) => {
      if (!workspaceReadOnlyReason) {
        handleOpenTreemapping(...args);
      }
    },
    [handleOpenTreemapping, workspaceReadOnlyReason],
  );
  const projectName = getPathLeaf(workspaceAbsPath);
  const handleOpenTaskFind = useCallback(() => {
    // The semantics of Cmd/Ctrl+F is "search dialogue". The file search entry of Cmd/Ctrl+P was mistakenly reused before.
    // This causes the user to jump to opening the file when clicking Find in quick pick or pressing a shortcut key. This is split into an independent state to avoid affecting the file search link.
    runVisibleWorkspaceCommand(() => {
      setTaskFindFocusRequestId((requestId) => requestId + 1);
      setIsTaskFindOpen(true);
    });
  }, [runVisibleWorkspaceCommand]);
  const handleTaskFindOpenChange = useCallback((open: boolean) => {
    setIsTaskFindOpen(open);
    if (!open) {
      setConversationFindState((state) => changeTaskFindSelection(state, "", -1));
      setConversationFindMatchCount(0);
      setFileChangeFindState((state) => changeTaskFindSelection(state, "", -1));
      setFileChangeFindMatchCount(0);
    }
  }, []);
  const handleConversationFindChange = useCallback((query: string, activeIndex: number) => {
    setConversationFindState((state) => changeTaskFindSelection(state, query, activeIndex));
  }, []);
  const handleConversationFindNavigate = useCallback((query: string, activeIndex: number) => {
    // Up/Down/Enter will return to the same index on a single hit; the independent version ensures that repeated navigation still triggers scrolling.
    setConversationFindState((state) => navigateTaskFindSelection(state, query, activeIndex));
  }, []);
  const handleConversationFindMatchStateChange = useCallback(
    (state: ConversationFindMatchState) => {
      setConversationFindMatchCount(state.matchCount);
      if (state.activeIndex !== undefined) {
        setConversationFindState((current) =>
          changeTaskFindSelection(current, current.query, state.activeIndex ?? -1),
        );
      }
    },
    [],
  );
  const handleSearchResultHighlightRequest = useCallback(
    (request: Omit<ChatSearchResultHighlightRequest, "requestId">) => {
      searchResultHighlightRequestIdRef.current += 1;
      setSearchResultHighlightRequest({
        ...request,
        requestId: searchResultHighlightRequestIdRef.current,
      });
    },
    [],
  );
  const handleSearchResultHighlightDone = useCallback((requestId: number) => {
    setSearchResultHighlightRequest((current) =>
      current?.requestId === requestId ? null : current,
    );
  }, []);
  const handleFileChangeFindChange = useCallback((query: string, activeIndex: number) => {
    setFileChangeFindState((state) => changeTaskFindSelection(state, query, activeIndex));
  }, []);
  const handleFileChangeFindNavigate = useCallback((query: string, activeIndex: number) => {
    // A file change scope may also have only one hit; repeated navigation must be re-expanded and focused on the same location.
    setFileChangeFindState((state) => navigateTaskFindSelection(state, query, activeIndex));
  }, []);
  const handleOpenQuickPick = useCallback(() => {
    setIsQuickPickOpen((open) => !open);
  }, []);
  const openFeedbackSubmit = useFeedbackStore((state) => state.openSubmit);
  const openFeedbackTickets = useFeedbackStore((state) => state.openTickets);
  const isLoggedIn = Boolean(user);
  const handleOpenFeedback = useCallback(() => {
    void platform.openFeedback();
  }, [platform]);

  useEffect(() => {
    // The built-in feedback center combines the two tabs "Submit Feedback/My Feedback".
    // The old OpenTicketsPanel IPC is still compatible (open the list directly) and can be reused in the future if a separate entrance is needed.
    const disposeFeedbackDialog = platform.onOpenFeedbackDialog?.(() => {
      openFeedbackSubmit();
    });
    const disposeTicketsPanel = platform.onOpenTicketsPanel?.(() => {
      openFeedbackTickets();
    });
    return () => {
      disposeFeedbackDialog?.();
      disposeTicketsPanel?.();
    };
  }, [openFeedbackSubmit, openFeedbackTickets, platform]);
  const handleOpenCommunity = useCallback(() => platform.openCommunity(), [platform]);
  const handleOpenProductDocs = useCallback(() => {
    platform.openExternal(ZCODE_PRODUCT_DOCS_URL);
  }, [platform]);
  const themeTarget = resolveTheme(theme) === "dark" ? "light" : "dark";
  const handleSwitchTheme = useCallback(() => {
    setTheme(themeTarget);
  }, [setTheme, themeTarget]);
  const handleOpenSettingsSection = useCallback(
    (section: SettingsSectionId) => {
      setPendingSettingsSection(section);
      openSettingsTab();
    },
    [openSettingsTab],
  );
  const { reloadSessionPending, handleReloadSession } = useWorkspaceSessionReload({
    intl,
    services,
    workspaceAbsPath,
    reloadSessionDisabled,
  });
  const handleStartDraftInWorkspace = useCallback(
    (
      targetWorkspacePath: string,
      targetWorkspaceIdentity?: string,
      targetWorkspacePurpose?: WorkspacePurpose,
      createSource?: import("@zcode/shared").SessionCreateSource,
    ) => {
      const store = useZCodeSessionStore.getState();
      const resolvedTargetWorkspaceIdentity =
        targetWorkspaceIdentity ??
        tabs.filter(isWorkspaceTab).find((tab) => tab.workspacePath === targetWorkspacePath)
          ?.workspaceIdentity;
      if (isWorkspaceReadOnly({ tabs }, targetWorkspacePath, resolvedTargetWorkspaceIdentity)) {
        return;
      }
      const targetSelectedProvider = resolveWorkspaceSwitchDraftProvider({
        currentSelectedProvider: workspaceShellZCodeState.selectedProvider,
        targetWorkspacePath,
        targetWorkspaceIdentity: resolvedTargetWorkspaceIdentity,
        workspaces: store.workspaces,
      });
      const currentWorkspaceState = store.getWorkspaceState(workspaceAbsPath, workspaceIdentity);
      const groupedDraftPlacement =
        currentWorkspaceState.activeTaskId === null
          ? currentWorkspaceState.groupedDraftTask?.placement
          : undefined;

      // The workspace selector in the empty state should express "Start working on this project".
      // If the target workspace has memorized its Agent, you should continue to use that choice after switching there;
      // Only when you enter for the first time and the workspace UI state has not yet been established, the Agent you are viewing in the current empty state will be inherited.
      // Otherwise, when switching back and forth between projects, the Agent just used by the target project will be overwritten, and it will look like "always reset to default values".
      // In addition, fixed entries such as Home are not guaranteed to already exist in the tab list. Previously, directly activateTabByPath would fail silently.
      // It looks like "no response after clicking". Here, first ensure that the target workspace is open, and then pass the currently empty provider to startDraft.
      // It is guaranteed that the new workspace entered for the first time can continue to use the current context.
      const targetTabOptions =
        resolvedTargetWorkspaceIdentity || targetWorkspacePurpose
          ? {
              ...(resolvedTargetWorkspaceIdentity
                ? { workspaceIdentity: resolvedTargetWorkspaceIdentity }
                : {}),
              ...(targetWorkspacePurpose ? { workspacePurpose: targetWorkspacePurpose } : {}),
            }
          : undefined;
      if (targetWorkspacePurpose) {
        // purpose is classification metadata; even if the tab already exists, it must be merged to avoid being defaulted to project when unbinding from the project for the first time.
        addTab(targetWorkspacePath, targetTabOptions);
      } else if (
        !activateTabByPath(
          targetWorkspacePath,
          resolvedTargetWorkspaceIdentity
            ? { workspaceIdentity: resolvedTargetWorkspaceIdentity }
            : undefined,
        )
      ) {
        addTab(targetWorkspacePath, targetTabOptions);
      }
      // The workspace line "New Dialog" used to be activatedTab + startDraft directly by the leaf component.
      // Workbench group/pane without exiting restart recovery. group primary binding thus can still overwrite the draft.
      // All explicit new entries return to a single primary pane first.
      useWorkbenchGroupStore.getState().deactivateActiveGroup();
      usePaneLayoutStore.getState().resetToPrimaryPane();
      store.startDraft(
        targetWorkspacePath,
        targetSelectedProvider,
        resolvedTargetWorkspaceIdentity,
        {
          groupedDraftPlacement,
          createSource: createSource ?? (groupedDraftPlacement ? "group" : "project"),
        },
      );
      if (
        groupedDraftPlacement &&
        (workspaceIdentity?.trim() || workspaceAbsPath) !==
          (resolvedTargetWorkspaceIdentity?.trim() || targetWorkspacePath)
      ) {
        // The New task line on the left side of grouped indicates the creation location selected by the user, and the workspace only modifies the draft target.
        // Clean the source bucket after migrating to the target workspace to avoid two temporary New task lines when switching back to the old workspace.
        store.clearGroupedDraftTask(workspaceAbsPath, workspaceIdentity);
      }
    },
    [
      activateTabByPath,
      addTab,
      tabs,
      workspaceAbsPath,
      workspaceIdentity,
      workspaceShellZCodeState.selectedProvider,
    ],
  );

  useWorkspaceShellLifecycle({
    workspaceAbsPath,
    workspaceIdentity,
    services,
    setBrowserNavigationRequest,
    setTestMessages,
  });

  useEnsureWorkspaceMcpLoaded(workspaceAbsPath, workspaceIdentity, workspaceRpcReady);

  const testActions = useMemo<TestActions>(
    () => ({
      ...taskListE2EActions,
      getTheme: () => theme,
      setTheme,
      getLocale: () => "en-US",
      setLocale: () => {},
      setChatMessages: (messages) => {
        setTestMessages([...messages]);
      },
      getChatMessageCount: () => testMessages?.length ?? 0,
      getPluginsOverview: (params) => services.zcodeAgentService.getPluginsOverview(params),
      addPluginMarketplace: (params) => services.zcodeAgentService.addPluginMarketplace(params),
      updatePluginMarketplace: (params) =>
        services.zcodeAgentService.updatePluginMarketplace(params),
      installPlugin: (params) => services.zcodeAgentService.installPlugin(params),
      listPlugins: (params) => services.zcodeAgentService.listPlugins(params),
      getPluginReferenceCatalog: (params) =>
        services.zcodeAgentService.getPluginReferenceCatalog(params),
    }),
    [services.zcodeAgentService, theme, setTheme, testMessages],
  );
  useTestActions(testActions);
  const [workspaceMainView, setWorkspaceMainView] = useState<WorkspaceMainView>("chat");
  const [openAutomationId, setOpenAutomationId] = useState<string | null>(null);
  const [openAutomationTab, setOpenAutomationTab] = useState<NonNullable<
    AutomationsNavigationTarget["automationTab"]
  > | null>(null);
  const [pluginStoreReturnScopeKey, setPluginStoreReturnScopeKey] = useState("user");
  const [pluginStoreOpenVersion, setPluginStoreOpenVersion] = useState(0);
  const handleNavigateToTaskMain = useCallback(() => {
    setWorkspaceMainView("chat");
  }, []);
  const { preserveNextSettingsExit } = useWorkspaceMainViewSettingsExit({
    isWorkspaceVisible,
    workspaceMainView,
    onExitSettings: handleNavigateToTaskMain,
  });
  const handleNavigateToAutomationsMain = useCallback((target: AutomationsNavigationTarget) => {
    setOpenAutomationId(target.automationId ?? null);
    setOpenAutomationTab(target.automationTab ?? null);
    setWorkspaceMainView("automations");
  }, []);
  const handleNavigateToPluginStoreMain = useCallback(() => {
    // The general entrance has no scope context and returns to User by default; the entrance with explicit scope in Settings will be in
    // After the navigation is completed, overwrite the default value this time to avoid inheriting the previous Workspace scope.
    setPluginStoreReturnScopeKey("user");
    setPluginStoreOpenVersion((version) => version + 1);
    preserveNextSettingsExit();
    setWorkspaceMainView("plugin-store");
  }, [preserveNextSettingsExit]);
  const handleOpenAutomationConsumed = useCallback(() => {
    setOpenAutomationId(null);
    setOpenAutomationTab(null);
  }, []);
  const {
    handleSelectTask,
    handleOpenAutomations,
    handleOpenPluginStore,
    handleTaskNavBack,
    handleTaskNavForward,
    canGoBack,
    canGoForward,
    canTaskNavBack,
    canTaskNavForward,
  } = useWorkspaceTaskNavigation({
    intl,
    workspaceAbsPath,
    workspaceIdentity,
    activateTabByPath,
    onNavigateToTask: handleNavigateToTaskMain,
    onNavigateToAutomations: handleNavigateToAutomationsMain,
    onNavigateToPluginStore: handleNavigateToPluginStoreMain,
  });
  const handleOpenPluginStoreForScope = useCallback(
    (_target: PluginStoreOpenTarget = {}) => {
      // Workspace Marketplace has converged into a global portal. Compatible with Workspace key in old events, but returns
      // The target is unified as User to prevent old sessionStorage/same window events from bringing the settings page back to the invalid scope.
      const returnScopeKey = "user";
      if (workspaceMainView === "plugin-store") {
        setPluginStoreReturnScopeKey(returnScopeKey);
        setPluginStoreOpenVersion((version) => version + 1);
        return;
      }
      handleOpenPluginStore();
      setPluginStoreReturnScopeKey(returnScopeKey);
    },
    [handleOpenPluginStore, workspaceMainView],
  );
  useEffect(
    () => addPluginStoreOpenListener(handleOpenPluginStoreForScope),
    [handleOpenPluginStoreForScope],
  );
  const handleSelectAdjacentConversation = useCallback(
    (direction: "previous" | "next") => {
      runVisibleWorkspaceCommand(() => {
        const sessionState = useZCodeSessionStore.getState();
        const workspaceState = sessionState.getWorkspaceState(workspaceAbsPath, workspaceIdentity);
        const fallbackTaskIds = getVisibleTaskMetas(workspaceState).map((task) => task.taskId);
        const taskQueryCacheState = useTaskQueryCacheStore.getState();
        // Performance fix: task meta is frequently written to the query cache during recovery and streaming events.
        // The previous/next session only needs the latest snapshot when the shortcut key is triggered, and the app cannot be allowed to subscribe to the entire cache and then drive the shell to re-render.
        const quickPickConversationNavigation = resolveQuickPickConversationNavigation({
          taskIds: selectQuickPickConversationTaskIds({
            workspacePath: workspaceAbsPath,
            workspaceIdentity,
            resultsByQueryKey: taskQueryCacheState.resultsByQueryKey,
            taskMetaByEntityKey: taskQueryCacheState.taskMetaByEntityKey,
            fallbackTaskIds,
          }),
          activeTaskId,
        });
        const targetTaskId =
          direction === "previous"
            ? quickPickConversationNavigation.previousTaskId
            : quickPickConversationNavigation.nextTaskId;
        if (!targetTaskId) {
          return;
        }

        handleSelectTask(workspaceAbsPath, targetTaskId, workspaceIdentity);
      });
    },
    [
      activeTaskId,
      handleSelectTask,
      runVisibleWorkspaceCommand,
      workspaceAbsPath,
      workspaceIdentity,
    ],
  );
  const handleSelectPreviousConversation = useCallback(() => {
    handleSelectAdjacentConversation("previous");
  }, [handleSelectAdjacentConversation]);
  const handleSelectNextConversation = useCallback(() => {
    handleSelectAdjacentConversation("next");
  }, [handleSelectAdjacentConversation]);
  const handleManageInstalledPlugins = useCallback(() => {
    setPendingSettingsPluginIntent("plugins", {
      origin: "plugin-store",
      scopeKey: pluginStoreReturnScopeKey,
    });
    openSettingsTab();
  }, [openSettingsTab, pluginStoreReturnScopeKey]);
  const handlePrimaryNavigationBack =
    workspaceMainView === "plugin-store" ? handleManageInstalledPlugins : handleTaskNavBack;
  const canPrimaryNavigationBack = workspaceMainView === "plugin-store" || canTaskNavBack;
  const shellPanelIds = useMemo(() => ["sidebar", "content"], []);

  useAppKeyboard({
    openCommandCenter: handleOpenQuickPick,
    // Open the settings page: shared with the settings entry button tabStore.openSettingsTab; default ⌘,/Ctrl+, (system convention)
    openSettings: openSettingsTab,
    findInTask: handleOpenTaskFind,
    toggleSidebar: () => runVisibleWorkspaceCommand(handleToggleSidebar),
    switchTheme: handleSwitchTheme,
    toggleTerminal: () => runVisibleWorkspaceCommand(handleToggleTerminalIfWritable),
    // ⌥⌘B shares the same toggle entry with the rightmost button of the header.
    // Avoid shortcut key and button behavior drift; the display of empty panels is uniformly taken over by the Open tab empty state.
    toggleSidePane: () => runVisibleWorkspaceCommand(handleToggleSidePane),
    previousConversation: handleSelectPreviousConversation,
    nextConversation: handleSelectNextConversation,
    navigateBack: canPrimaryNavigationBack
      ? () => runVisibleWorkspaceCommand(handlePrimaryNavigationBack)
      : null,
    navigateForward: canTaskNavForward
      ? () => runVisibleWorkspaceCommand(handleTaskNavForward)
      : null,
  });

  useEffect(() => {
    let disposed = false;

    void platform.canOpenCommunity().then(
      (visible) => {
        if (!disposed) {
          setCanOpenCommunityFromQuickPick(visible);
        }
      },
      () => {
        if (!disposed) {
          setCanOpenCommunityFromQuickPick(false);
        }
      },
    );

    return () => {
      disposed = true;
    };
  }, [platform]);

  const quickPickCommands = useMemo(
    () =>
      createQuickPickCommands({
        supportsTerminal: !isOfficeMode,
        supportsReview: !isOfficeMode,
        allowOpenWorkspace,
        canOpenCommunity: canOpenCommunityFromQuickPick,
        isSidebarVisible,
        supportsEmbeddedBrowser,
        // The quick pick command only cares about login boolean values.
        // If relying on a full user object, the entire set of command/run closures will be rebuilt when the auth store returns an equivalent new reference.
        isLoggedIn,
        themeTarget,
        shortcuts: {
          newTask: newTaskShortcutLabel,
          openWorkspace: openWorkspaceShortcutLabel,
          toggleSidebar: toggleSidebarShortcutLabel,
          toggleTerminal: toggleTerminalShortcutLabel,
        },
        handlers: {
          createTask: () => runVisibleWorkspaceCommand(() => handleCreateTaskIfWritable()),
          openWorkspace: () => runVisibleWorkspaceCommand(onOpenWorkspace),
          openSettings: openSettingsTab,
          openSkillsSettings: () => {
            setPendingSettingsPluginIntent("skills");
            openSettingsTab();
          },
          openMcpSettings: () => {
            setPendingSettingsPluginIntent("mcps");
            openSettingsTab();
          },
          switchTheme: handleSwitchTheme,
          openFeedback: handleOpenFeedback,
          openCommunity: handleOpenCommunity,
          openProductDocs: handleOpenProductDocs,
          login: onLogin,
          logout: onLogout,
          toggleSidebar: () => runVisibleWorkspaceCommand(handleToggleSidebar),
          toggleTerminal: () => runVisibleWorkspaceCommand(handleToggleTerminalIfWritable),
          togglePreview: () => runVisibleWorkspaceCommand(handleToggleBrowser),
          openTerminalTab: () => runVisibleWorkspaceCommand(handleOpenTerminalTabIfWritable),
          openBrowserTab: () => runVisibleWorkspaceCommand(handleOpenBrowserTab),
          openReviewTab: () => runVisibleWorkspaceCommand(handleOpenGitIfWritable),
        },
      }),
    [
      allowOpenWorkspace,
      isOfficeMode,
      canOpenCommunityFromQuickPick,
      handleOpenCommunity,
      handleOpenFeedback,
      handleOpenProductDocs,
      handleOpenSettingsSection,
      handleSwitchTheme,
      handleOpenBrowserTab,
      handleOpenGitIfWritable,
      handleOpenTerminalTabIfWritable,
      handleToggleBrowser,
      handleToggleSidebar,
      handleToggleTerminalIfWritable,
      isLoggedIn,
      isSidebarVisible,
      newTaskShortcutLabel,
      handleCreateTaskIfWritable,
      onLogin,
      onLogout,
      onOpenWorkspace,
      runVisibleWorkspaceCommand,
      openSettingsTab,
      openWorkspaceShortcutLabel,
      supportsEmbeddedBrowser,
      toggleSidebarShortcutLabel,
      toggleTerminalShortcutLabel,
      themeTarget,
    ],
  );
  const taskFindDialogProps = useMemo<TaskFindDialogProps>(
    () => ({
      open: isTaskFindOpen,
      focusRequestId: taskFindFocusRequestId,
      isMacDesktop,
      isWindowsDesktop,
      isLinuxDesktop,
      conversationMatchCount: conversationFindMatchCount,
      conversationMatchIndex: conversationFindState.activeIndex,
      fileChangeMatchCount: fileChangeFindMatchCount,
      fileChangeMatchIndex: fileChangeFindState.activeIndex,
      onOpenChange: handleTaskFindOpenChange,
      onConversationFindChange: handleConversationFindChange,
      onConversationFindNavigate: handleConversationFindNavigate,
      onFileChangeFindChange: handleFileChangeFindChange,
      onFileChangeFindNavigate: handleFileChangeFindNavigate,
      onOpenFileChanges: handleOpenGitIfWritable,
    }),
    [
      conversationFindMatchCount,
      conversationFindState.activeIndex,
      fileChangeFindMatchCount,
      fileChangeFindState.activeIndex,
      handleConversationFindChange,
      handleConversationFindNavigate,
      handleFileChangeFindChange,
      handleFileChangeFindNavigate,
      handleOpenGitIfWritable,
      handleTaskFindOpenChange,
      isLinuxDesktop,
      isMacDesktop,
      isTaskFindOpen,
      isWindowsDesktop,
      taskFindFocusRequestId,
    ],
  );

  return (
    <>
      <CommandCenterDialog
        open={isQuickPickOpen}
        commands={quickPickCommands}
        workspaceAbsPath={workspaceAbsPath}
        workspaceIdentity={workspaceIdentity}
        activeTaskId={activeTaskId}
        activeTaskChangeSummary={activeTaskChangeSummary}
        workspaceTabs={commandCenterWorkspaceTabs}
        onOpenChange={setIsQuickPickOpen}
        onSelectTask={handleSelectTask}
        onSearchResultHighlightRequest={handleSearchResultHighlightRequest}
        onOpenCodeViewer={handleOpenCodeViewerIfWritable}
      />
      {/*
          Feedback is an app-level capability and must always go through the local base host; while
          an SSH session is connecting or disconnected, workspace-scoped services switch over to a
          disconnected proxy, so feedback submission must not be invalidated by following the remote
          session.
          */}
      <FeedbackHost feedbackService={baseFeedbackService} platform={platform} />
      <WorkspaceShellLayout
        services={services}
        workspaceReadOnlyReason={workspaceReadOnlyReason}
        workspaceMainView={workspaceMainView}
        pluginStoreOpenVersion={pluginStoreOpenVersion}
        openAutomationId={openAutomationId}
        openAutomationTab={openAutomationTab}
        onWorkspaceMainViewChange={setWorkspaceMainView}
        onOpenAutomationConsumed={handleOpenAutomationConsumed}
        handleOpenAutomations={handleOpenAutomations}
        handleOpenPluginStore={handleOpenPluginStoreForScope}
        handleManageInstalledPlugins={handleManageInstalledPlugins}
        onConnectRemote={onConnectRemote}
        onSelectRemoteProject={onSelectRemoteProject}
        onCancelRemoteProject={onCancelRemoteProject}
        onReconnectRemoteWorkspace={onReconnectRemoteWorkspace}
        onLogout={onLogout}
        onLogin={onLogin}
        user={user}
        reconnectingRemoteWorkspaceKeys={reconnectingRemoteWorkspaceKeys}
        remoteWorkspaceErrorByWorkspaceKey={remoteWorkspaceErrorByWorkspaceKey}
        reconnectingRemoteWorkspaceLogsByWorkspaceKey={
          reconnectingRemoteWorkspaceLogsByWorkspaceKey
        }
        remoteConnectionLogs={remoteConnectionLogs}
        onCreateTask={handleCreateTaskIfWritable}
        onCreateConversationTask={onCreateConversationTask}
        onResolveConversationWorkspace={onResolveConversationWorkspace}
        onOpenWorkspace={onOpenWorkspace}
        onOpenFolderFromWorkspaceMenu={onOpenFolderFromWorkspaceMenu}
        onOpenRemoteWorkspace={onOpenRemoteWorkspace}
        onCreateScratchWorkspace={onCreateScratchWorkspace}
        remoteConnectionInProgress={remoteConnectionInProgress}
        allowOpenWorkspace={allowOpenWorkspace}
        allowRemoteWorkspace={allowRemoteWorkspace}
        remoteWorkspaceSessions={remoteWorkspaceSessions}
        workspaceAbsPath={workspaceAbsPath}
        workspaceRemoteSessionId={workspaceRemoteSessionId}
        workspaceIdentity={workspaceIdentity}
        isWorkspaceVisible={isWorkspaceVisible}
        isDesktop={isDesktop}
        isMacDesktop={isMacDesktop}
        isWindowsDesktop={isWindowsDesktop}
        workspaceShellZCodeState={workspaceShellZCodeState}
        theme={theme}
        isMacFullscreen={isMacFullscreen}
        desktopWindowChromeState={desktopWindowChromeState}
        macWindowControlsLeftPaddingPx={macWindowControlsLeftPaddingPx}
        windowsWindowControlsRightPaddingPx={windowsWindowControlsRightPaddingPx}
        updateReadyVersion={updateReadyVersion}
        updateState={updateState}
        sidebarContainerRef={sidebarContainerRef}
        toggleSidebarShortcutLabel={toggleSidebarShortcutLabel}
        newTaskShortcutLabel={newTaskShortcutLabel}
        goBackShortcutLabel={goBackShortcutLabel}
        goForwardShortcutLabel={goForwardShortcutLabel}
        toggleSidePaneShortcutLabel={toggleSidePaneShortcutLabel}
        canGoBack={canGoBack}
        canGoForward={canGoForward}
        canTaskNavBack={canTaskNavBack}
        canTaskNavForward={canTaskNavForward}
        isTerminalOpen={isTerminalOpen}
        isSidebarVisible={isSidebarVisible}
        isBrowserOpen={isBrowserOpen}
        supportsEmbeddedBrowser={supportsEmbeddedBrowser}
        isGitOpen={isGitOpen}
        isSidePaneOpen={isSidePaneOpen}
        summaryPanelVariantOverride={summaryPanelVariantOverride}
        onSummaryPanelVariantOverrideChange={setSummaryPanelVariantOverride}
        sidePaneState={sidePaneState}
        recentClosedSidePaneTabs={recentClosedSidePaneTabs}
        shellPanelIds={shellPanelIds}
        projectName={projectName}
        workspaceTabs={workspaceTabs}
        activeTaskId={activeTaskId}
        sidePaneOwnerId={sidePaneOwnerId}
        activeTraceId={activeTraceId}
        activeSessionId={activeSessionId}
        activeTaskProvider={activeTaskProvider}
        resolvedActiveTaskMeta={resolvedActiveTaskMeta}
        activeTaskTitle={activeTaskTitle}
        activeTaskChangeSummary={activeTaskChangeSummary}
        gitWorktreeReviewSourceId={gitWorktreeReviewSourceId}
        gitWorktreeChangeSummary={gitWorktreeChangeSummary}
        activeGitSourceId={activeGitSourceId}
        gitState={gitState}
        browserNavigationRequest={browserNavigationRequest}
        browserRestoreUrls={browserRestoreUrls}
        taskNativeSessionLogFile={taskNativeSessionLogFile}
        taskSessionFile={taskSessionFile}
        testMessages={testMessages}
        conversationFindActiveIndex={conversationFindState.activeIndex}
        conversationFindNavigationRequestId={conversationFindState.navigationRequestId}
        conversationFindQuery={conversationFindState.query}
        onConversationFindMatchStateChange={handleConversationFindMatchStateChange}
        searchResultHighlightRequest={searchResultHighlightRequest}
        onSearchResultHighlightDone={handleSearchResultHighlightDone}
        fileChangeFindActiveIndex={fileChangeFindState.activeIndex}
        fileChangeFindNavigationRequestId={fileChangeFindState.navigationRequestId}
        fileChangeFindQuery={fileChangeFindState.query}
        onFileChangeFindMatchCountChange={setFileChangeFindMatchCount}
        appLogoUrl={appLogoUrl}
        platform={platform}
        reloadSessionDisabled={reloadSessionDisabled}
        reloadSessionPending={reloadSessionPending}
        handleReloadSession={handleReloadSession}
        handleSelectTask={handleSelectTask}
        handleTaskNavBack={handleTaskNavBack}
        handleTaskNavForward={handleTaskNavForward}
        handleStartDraftInWorkspace={handleStartDraftInWorkspace}
        handleOpenCommandCenter={handleOpenQuickPick}
        handleRefreshGit={handleRefreshGit}
        handleOpenGitReview={handleOpenGitReview}
        handleBrowserUrlChange={handleBrowserUrlChange}
        handleBrowserPageMetadataChange={handleBrowserPageMetadataChange}
        handleToggleSidebar={handleToggleSidebar}
        handleToggleTerminal={handleToggleTerminalIfWritable}
        handleToggleBrowser={handleToggleBrowser}
        handleOpenBrowserTab={handleOpenBrowserTab}
        handleOpenTreemapping={handleOpenTreemappingIfWritable}
        handleOpenWhiteboard={handleOpenWhiteboard}
        handleOpenDeveloperTools={handleOpenDeveloperTools}
        handleOpenTerminalTab={handleOpenTerminalTabIfWritable}
        handleToggleGit={handleToggleGitIfWritable}
        handleToggleSidePane={handleToggleSidePane}
        handleOpenBrowserUrl={handleOpenBrowserUrl}
        handleOpenCodeViewer={handleOpenCodeViewerIfWritable}
        handleAutoOpenAssistantPptx={handleAutoOpenAssistantPptx}
        handleOpenSubagentSession={handleOpenSubagentSession}
        handleOpenBackgroundBash={handleOpenBackgroundBash}
        handleOpenSubagentDirectory={handleOpenSubagentDirectory}
        handleSyncSubagentSessionTabs={handleSyncSubagentSessionTabs}
        handleOpenSelectionSideChat={handleOpenSelectionSideChat}
        handleOpenPlanDetail={handleOpenPlanDetail}
        handleOpenWorkflowRun={handleOpenWorkflowRun}
        handleOpenWorkflowRunDirectory={handleOpenWorkflowRunDirectory}
        handleOpenWorkflowActorSession={handleOpenWorkflowActorSession}
        handleOpenWorkflowWorkspace={handleOpenWorkflowWorkspace}
        handleOpenWorkflowArtifact={handleOpenWorkflowArtifact}
        handleCloseCodeViewer={handleCloseCodeViewer}
        handleCloseGit={handleCloseGit}
        handleActivateSidePaneTab={handleActivateSidePaneTab}
        handleReorderSidePaneTab={handleReorderSidePaneTab}
        handleCloseSidePaneTab={handleCloseSidePaneTab}
        handleCloseOtherSidePaneTabs={handleCloseOtherSidePaneTabs}
        handleCloseAllSidePaneTabs={handleCloseAllSidePaneTabs}
        handleReopenClosedSidePaneTab={handleReopenClosedSidePaneTab}
        handleBrowserNavigationRequestHandled={handleBrowserNavigationRequestHandled}
        setIsTerminalOpen={setIsTerminalOpen}
        setGitSelectedSourceId={setGitSelectedSourceId}
        // taskFindDialogProps is an object prop, and creating it inline will cause the shell to see new references every round of streaming refresh.
        taskFindDialogProps={taskFindDialogProps}
      />
    </>
  );
}
