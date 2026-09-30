/* eslint-disable max-lines -- The workspace shell currently orchestrates the layout coupling of the
 * sidebar, chat, terminal and browser pane in one file; keep it consolidated there for now, so that
 * meeting the line count does not break up key layout state.
 */
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  CSSProperties,
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent,
} from "react";
import type { PanelImperativeHandle } from "react-resizable-panels";

import { TID_APP_HEADER } from "@zcode/shared";
// Keep alive: When the workspace tab is actually closed, press the workspaceKey to recycle the side pane terminal's resident PTY/xterm.
// OpenWorkspaceKeys recycling of Terminal.tsx on the lower side of symmetry.
import { sidePaneTerminalSessionRegistry } from "@/terminal/sidePaneTerminalSessionRegistry.js";
import { V4ChatPane } from "@/v4/V4ChatPane.js";
import { V4WorkspaceChatArea } from "@/v4/V4WorkspaceChatArea.js";
import {
  V4SplitPaneEntryProvider,
  type V4SplitPaneSessionTarget,
} from "@/v4/splitPaneEntryContext.js";
import {
  WorkflowRunOpenProvider,
  type WorkflowRunOpenTarget,
} from "@/v4/workflowRunOpenContext.js";
import type { ConversationDropTargetController } from "@/v4/composer/conversationDropTarget.js";
import type { WorkbenchSessionBinding } from "@/v4/workbenchGroupStore.js";
import {
  canPlaceWorkbenchSessionInSplit,
  placeWorkbenchSessionInSplit,
  selectWorkbenchSession,
} from "@/v4/workbenchSessionPlacement.js";
import { usePaneSessionPersistence } from "@/v4/usePaneSessionPersistence.js";
import { requestV4ComposerDraftWorkspaceTransfer } from "@/v4/composer/composerDraftWorkspaceTransfer.js";
import { ChatEmptyWorkspacePreviewMenu } from "@/ChatEmptyState.js";
import { DesktopTopOverlay } from "@/DesktopTopOverlay.js";
import { DesktopWindowFrame } from "@/DesktopWindowFrame.js";
import { WorkspacePluginPreview } from "@/WorkspacePluginPreview.js";
import { useIsOfficeMode } from "@/hooks/useInterfaceMode.js";
import { GitBranchSwitcher } from "@/GitBranchSwitcher.js";
import { ScopedErrorBoundary } from "@/ErrorBoundary.js";

import { AUTOMATIONS_TOAST_ANCHOR_ID, AutomationsSection } from "@/settings/AutomationsSection.js";
import type {
  SavedWorkflowLaunchTarget,
  SavedWorkflowsOpenArtifactParams,
  SavedWorkflowsOpenRunParams,
} from "@/settings/saved-workflows/SavedWorkflowsSection.js";
import { AutomationsMainBreadcrumbFrame } from "@/settings/AutomationsMainBreadcrumbFrame.js";
import { PluginStorePage } from "@/settings/PluginStorePage.js";
import { TaskFindDialog } from "@/quickpick/TaskFindDialog.js";
import { WorkspaceHeader } from "@/WorkspaceHeader.js";
import { WorkspaceSidebar, type SidebarFileTreeOpenRequest } from "@/WorkspaceSidebar.js";
import { AnimatedSidePanePanel } from "@/app-shell/AnimatedSidePanePanel.js";
import {
  findScreenshotSurfaceTabForRender,
  useBrowserScreenshotSurfaceRequest,
} from "@/browser-use/useBrowserScreenshotSurfaceRequest.js";
import { AnimatedTerminalPanel } from "@/app-shell/AnimatedTerminalPanel.js";
import { SIDE_PANE_DEFAULT_EXPANDED_SIZE } from "@/app-shell/sidePaneLayout.js";
import { useAnimatedResizablePanel } from "@/app-shell/useAnimatedResizablePanel.js";
import { ensureTaskNavigationWorkspace } from "@/app-shell/taskNavigationWorkspace.js";

import {
  resolveWorkspaceShellPanelRadiusPx,
  resolveWorkspaceShellResizeHandleInsetPx,
  resolveWorkspaceShellWindowChromeClass,
} from "@/app-shell/workspaceShellWindowChrome.js";
import { cn } from "@/components/lib/utils.js";
import { Button } from "@/components/ui/button.js";
import { ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable.js";
import { toast } from "@/components/ui/toast.js";
import { getGitDirtyFileCount } from "@/git-branch-switcher/display.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useBaseWorkspaceServices } from "@/hooks/useWorkspaceServices.js";
import { getPathLeaf, toFileUrl } from "@/lib/path.js";
import { shouldOpenAssistantHtmlInBrowser } from "@/lib/assistantPreviewCards.js";
import { setWorkspaceSidebarResizeActive } from "@/lib/workspaceSidebarResizeState.js";
import { buildTaskWorkspaceKey } from "@/lib/taskQueryCache.js";
import {
  addWorkspacePathOpenRequestListener,
  selectWorkspacePathFileService,
  shouldFallbackWorkspacePathToCodeViewer,
  type WorkspacePathOpenRequest,
} from "@/lib/workspacePathNavigation.js";
import {
  buildSelectionSideChatKey,
  requestSelectionSideChatOpen,
} from "@/lib/selectionSideChatRuntime.js";
import { getActiveSelectionSideChatTab } from "@/lib/workspaceSidePane.js";
import { logger } from "@/logger.js";
import {
  areWorkspaceFilePathsEqual,
  isWorkspaceFilePathInside,
} from "@/workspace-file-tree/model.js";
import type { WorkspaceShellLayoutProps } from "@/app-shell/types.js";
import { useTabStoreApi } from "@/store/TabStoreProvider.js";
import { useZCodeSessionStore } from "@/store/zcodeSessionStore.js";
import type { ComposerMentionPrefill } from "@/store/zcodeSessionStoreTypes.js";

const WORKSPACE_SIDEBAR_DEFAULT_WIDTH_PX = 264;
const WORKSPACE_SIDEBAR_MIN_WIDTH_PX = 264;
const WORKSPACE_SIDEBAR_MAX_WIDTH_RATIO = 0.5;
const WORKSPACE_SIDEBAR_WIDTH_STORAGE_KEY = "zcode:workspace-shell:sidebar-width-px";
const LEGACY_WORKSPACE_SHELL_LAYOUT_STORAGE_KEY =
  "react-resizable-panels:workspace-shell-layout:sidebar:content";
const WORKSPACE_SIDEBAR_RESIZE_KEYBOARD_STEP_PX = 16;
const WORKSPACE_SIDEBAR_PANEL_WIDTH_CSS_VAR = "--workspace-sidebar-panel-width";
const WORKSPACE_SIDEBAR_WIDTH_CSS_VAR = "--workspace-sidebar-width";
const CONVERSATION_AUTO_COLLAPSE_SIDE_PANE_WIDTH_PX = 480;
// WorkspaceShellLayout is a memo component, and the default []/{} will create a new reference each time it is called by default;
// The entry defaults to reusing constants in these collections to avoid misjudgment of props changes through shallow comparison.
const EMPTY_RECONNECTING_REMOTE_WORKSPACE_LOGS_BY_WORKSPACE_KEY: NonNullable<
  WorkspaceShellLayoutProps["reconnectingRemoteWorkspaceLogsByWorkspaceKey"]
> = {};
const EMPTY_REMOTE_WORKSPACE_SESSIONS: NonNullable<
  WorkspaceShellLayoutProps["remoteWorkspaceSessions"]
> = [];
const CONVERSATION_AUTO_COLLAPSE_SIDEBAR_WIDTH_PX = 360;
const CONVERSATION_AUTO_COLLAPSE_RESIZE_IDLE_MS = 300;
// Performance fix: ResizablePanelGroup receives new panelIds array of deep equals,
// The layout context will be recalculated following the chat streaming render; the semantics of the fixed array will not change with the message.
const WORKSPACE_BODY_PANEL_IDS = ["conversation-column", "browser"];
const WORKSPACE_CONVERSATION_PANEL_IDS = ["conversation", "terminal"];

type WorkspaceSidebarResizeSession = {
  containerWidthPx: number;
  pointerId: number;
  startWidthPx: number;
  startX: number;
};

function clampWorkspaceSidebarWidth(widthPx: number, containerWidthPx?: number) {
  const maxWidthPx =
    containerWidthPx && containerWidthPx > 0
      ? Math.max(
          WORKSPACE_SIDEBAR_MIN_WIDTH_PX,
          containerWidthPx * WORKSPACE_SIDEBAR_MAX_WIDTH_RATIO,
        )
      : Number.POSITIVE_INFINITY;

  return Math.round(Math.max(WORKSPACE_SIDEBAR_MIN_WIDTH_PX, Math.min(widthPx, maxWidthPx)));
}

function readStoredWorkspaceSidebarWidthPx(): number | null {
  if (typeof window === "undefined") {
    return null;
  }

  try {
    const raw = window.localStorage.getItem(WORKSPACE_SIDEBAR_WIDTH_STORAGE_KEY);
    if (!raw) {
      return null;
    }
    const parsed = Number(raw);
    return Number.isFinite(parsed) && parsed > 0 ? clampWorkspaceSidebarWidth(parsed) : null;
  } catch {
    return null;
  }
}

function readLegacyWorkspaceSidebarWidthRatio(): number | null {
  if (typeof window === "undefined") {
    return null;
  }

  try {
    const raw = window.localStorage.getItem(LEGACY_WORKSPACE_SHELL_LAYOUT_STORAGE_KEY);
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw) as { sidebar?: unknown };
    const ratio = Number(parsed.sidebar);
    return Number.isFinite(ratio) && ratio > 0 ? ratio / 100 : null;
  } catch {
    return null;
  }
}

function persistWorkspaceSidebarWidthPx(widthPx: number) {
  if (typeof window === "undefined") {
    return;
  }

  try {
    window.localStorage.setItem(WORKSPACE_SIDEBAR_WIDTH_STORAGE_KEY, String(Math.round(widthPx)));
  } catch {
    // ignore
  }
}

export const WorkspaceShellLayout = memo(function WorkspaceShellLayoutComponent({
  services,
  workspaceReadOnlyReason,
  workspaceMainView,
  pluginStoreOpenVersion,
  openAutomationId,
  openAutomationTab,
  onWorkspaceMainViewChange,
  onOpenAutomationConsumed,
  handleOpenAutomations,
  handleOpenPluginStore,
  handleManageInstalledPlugins,
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
  onCreateTask,
  onCreateConversationTask,
  onResolveConversationWorkspace,
  onOpenWorkspace,
  onOpenFolderFromWorkspaceMenu,
  onOpenRemoteWorkspace,
  onCreateScratchWorkspace,
  allowOpenWorkspace = true,
  allowRemoteWorkspace = true,
  remoteWorkspaceSessions = EMPTY_REMOTE_WORKSPACE_SESSIONS,
  workspaceAbsPath,
  workspaceRemoteSessionId,
  workspaceIdentity,
  isWorkspaceVisible = true,
  isDesktop,
  isMacDesktop,
  isWindowsDesktop,
  workspaceShellZCodeState,
  theme,
  isMacFullscreen,
  desktopWindowChromeState,
  macWindowControlsLeftPaddingPx,
  windowsWindowControlsRightPaddingPx = 136,
  updateReadyVersion,
  updateState,
  sidebarContainerRef,
  toggleSidebarShortcutLabel,
  newTaskShortcutLabel,
  goBackShortcutLabel,
  goForwardShortcutLabel,
  toggleSidePaneShortcutLabel,
  canGoBack,
  canGoForward,
  canTaskNavBack,
  canTaskNavForward,
  isTerminalOpen,
  isSidebarVisible,
  isSidePaneOpen,
  isBrowserOpen,
  supportsEmbeddedBrowser,
  summaryPanelVariantOverride,
  onSummaryPanelVariantOverrideChange,
  sidePaneState,
  recentClosedSidePaneTabs,
  projectName,
  workspaceTabs,
  activeTaskId,
  sidePaneOwnerId,
  activeTraceId,
  activeSessionId,
  activeTaskProvider,
  resolvedActiveTaskMeta,
  activeTaskTitle,
  activeTaskChangeSummary,
  gitWorktreeReviewSourceId,
  gitWorktreeChangeSummary,
  activeGitSourceId,
  gitState,
  browserNavigationRequest,
  browserRestoreUrls,
  taskNativeSessionLogFile,
  taskSessionFile,
  testMessages,
  conversationFindActiveIndex,
  conversationFindNavigationRequestId,
  conversationFindQuery,
  onConversationFindMatchStateChange,
  searchResultHighlightRequest,
  onSearchResultHighlightDone,
  fileChangeFindActiveIndex,
  fileChangeFindNavigationRequestId,
  fileChangeFindQuery,
  onFileChangeFindMatchCountChange,
  appLogoUrl,
  platform,
  reloadSessionDisabled,
  reloadSessionPending,
  handleReloadSession,
  handleSelectTask,
  handleTaskNavBack,
  handleTaskNavForward,
  handleStartDraftInWorkspace,
  handleOpenCommandCenter,
  handleRefreshGit,
  handleBrowserUrlChange,
  handleBrowserPageMetadataChange,
  handleToggleSidebar,
  handleToggleTerminal,
  handleToggleBrowser,
  handleOpenBrowserTab,
  handleOpenTreemapping,
  handleOpenWhiteboard,
  handleOpenDeveloperTools,
  handleOpenTerminalTab,
  handleToggleGit,
  handleOpenGitReview,
  handleToggleSidePane,
  handleOpenBrowserUrl,
  handleOpenCodeViewer,
  handleAutoOpenAssistantPptx,
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
  handleCloseCodeViewer,
  handleCloseGit,
  handleActivateSidePaneTab,
  handleReorderSidePaneTab,
  handleCloseSidePaneTab,
  handleCloseOtherSidePaneTabs,
  handleCloseAllSidePaneTabs,
  handleReopenClosedSidePaneTab,
  handleBrowserNavigationRequestHandled,
  setIsTerminalOpen,
  setGitSelectedSourceId,
  taskFindDialogProps,
}: WorkspaceShellLayoutProps) {
  const { intl } = useZCodeIntl();
  const isOfficeMode = useIsOfficeMode();
  const baseServices = useBaseWorkspaceServices();
  const tabStoreApi = useTabStoreApi();
  const isLinuxDesktop = Boolean(isDesktop && !isMacDesktop && !isWindowsDesktop);
  // Windows/Linux also need to leave the outer layer blank to prevent independent panels from sticking to the edge of the window; the desktop uses a uniform 4px spacing.
  const hasDesktopPanelInset = isMacDesktop || isWindowsDesktop || isLinuxDesktop;
  const usesInlineWindowControls = Boolean(isWindowsDesktop || isLinuxDesktop);
  const workspaceShellRadiusOptions = {
    isMacDesktop,
    isWindowsDesktop,
    isLinuxDesktop,
    macOSMajorVersion: desktopWindowChromeState?.macOSMajorVersion,
  };
  const workspacePanelRadiusPx = resolveWorkspaceShellPanelRadiusPx(workspaceShellRadiusOptions);
  const workspaceResizeHandleInsetPx = resolveWorkspaceShellResizeHandleInsetPx(
    workspaceShellRadiusOptions,
  );
  const collapsedSidebarWidthPx = hasDesktopPanelInset ? 4 : 0;
  const [draftHeaderDropTargetController, setDraftHeaderDropTargetController] =
    useState<ConversationDropTargetController | null>(null);
  const fileTreeOpenRequestIdRef = useRef(0);
  const [fileTreeOpenRequest, setFileTreeOpenRequest] = useState<SidebarFileTreeOpenRequest | null>(
    null,
  );
  const [isSidebarFileTreeOpen, setIsSidebarFileTreeOpen] = useState(false);
  const workspaceKey = workspaceIdentity?.trim() || workspaceAbsPath;
  const screenshotSurfaceRequest = useBrowserScreenshotSurfaceRequest(sidePaneState?.tabs ?? []);
  const screenshotSurfaceTab = screenshotSurfaceRequest
    ? findScreenshotSurfaceTabForRender(sidePaneState?.tabs ?? [], screenshotSurfaceRequest)
    : undefined;
  // v4 pane binding persistence (refresh and restore in output): the renderer restores the last selected one after refreshing
  // session; the CLI/host process is not dead, pane re-subscribes and takes the snapshot+continue stream.
  usePaneSessionPersistence({
    workspaceKey,
    activeSessionId: activeTaskId,
    draftFocusVersion: workspaceShellZCodeState.draftFocusVersion,
    selectSession: (sessionId) => handleSelectTask(workspaceAbsPath, sessionId, workspaceIdentity),
  });
  const workspaceShellRef = useRef<HTMLDivElement | null>(null);
  const workspaceSidebarPanelElementRef = useRef<HTMLDivElement | null>(null);
  const conversationPanelElementRef = useRef<HTMLDivElement | null>(null);
  const conversationAutoCollapseStateRef = useRef({
    handleToggleSidebar,
    handleToggleSidePane,
    isSidebarVisible,
    isSidePaneOpen,
    workspaceKey,
  });
  const conversationAutoCollapseResizeTimerRef = useRef<number | null>(null);
  const workspaceSidebarResizeSessionRef = useRef<WorkspaceSidebarResizeSession | null>(null);
  const [workspaceSidebarPanelWidthPx, setWorkspaceSidebarPanelWidthPx] = useState(
    () => readStoredWorkspaceSidebarWidthPx() ?? WORKSPACE_SIDEBAR_DEFAULT_WIDTH_PX,
  );
  const workspaceSidebarPanelWidthPxRef = useRef(workspaceSidebarPanelWidthPx);
  const openWorkspaceKeys = useMemo(
    () => workspaceTabs.map((tab) => tab.workspaceIdentity?.trim() || tab.workspacePath),
    [workspaceTabs],
  );
  // Keep-alive recycling: When the workspace tab is actually closed (removed from openWorkspaceKeys), the workspace belonging to the workspace will be recycled.
  // Side pane terminal resident session (kill PTY + kill xterm) to avoid orphan process leakage.
  // Cutting the workspace will not let the workspaceKey leave this collection, so the keep-alive session will not be affected.
  // The openWorkspaceKeys recycling logic of Terminal.tsx:145-177 on the lower side of the symmetry.
  useEffect(() => {
    const retained = new Set(openWorkspaceKeys);
    sidePaneTerminalSessionRegistry.releaseByPredicate(
      (entry) => Boolean(entry.workspaceKey) && !retained.has(entry.workspaceKey),
    );
  }, [openWorkspaceKeys]);
  const isSidebarPanelVisible = isSidebarVisible;
  const {
    panelRef: terminalPanelRef,
    panelElementRef: terminalPanelElementRef,
    isVisible: isTerminalVisible,
  } = useAnimatedResizablePanel({
    open: isTerminalOpen,
    expandedSize: "30%",
    rememberExpandedSize: true,
  });
  const {
    panelRef: sidePanePanelRef,
    panelElementRef: sidePanePanelElementRef,
    isVisible: isSidePaneVisible,
  } = useAnimatedResizablePanel({
    // The size of the screenshot surface is provided by the browser-use tab's own fixed hosting layer, and the entire right side can no longer be
    // ResizablePanel is opened; otherwise, the automation page will pop up with a blank tab bar, and the guest surface will appear during the panel transition.
    // May still be deemed unsynthesizable by Chromium.
    open: workspaceMainView === "chat" && isSidePaneOpen,
    expandedSize: SIDE_PANE_DEFAULT_EXPANDED_SIZE,
    rememberExpandedSize: true,
    resizeOnInitialVisibleMount: false,
  });
  const workspaceSessionActionDisabled =
    Boolean(workspaceReadOnlyReason) || reloadSessionDisabled || reloadSessionPending;
  // When the file tree is opened, the task list slides out of the entire screen, and the New Task entry in the sidebar is also invisible.
  // The top floating layer needs to temporarily expose New Task, and continue to use the sidebar closed state rule after closing the file tree.
  const showTopOverlayNewTaskButton = !isSidebarVisible || isSidebarFileTreeOpen;
  const workspaceSidebarResizeLabel = intl.formatMessage({
    id: "workspaceSidebar.resizeSidebar",
  });

  useEffect(() => {
    conversationAutoCollapseStateRef.current = {
      handleToggleSidebar,
      handleToggleSidePane,
      isSidebarVisible,
      isSidePaneOpen,
      workspaceKey,
    };
  }, [handleToggleSidebar, handleToggleSidePane, isSidebarVisible, isSidePaneOpen, workspaceKey]);

  useEffect(() => {
    if (workspaceMainView !== "chat") {
      return;
    }

    if (typeof window === "undefined") {
      return;
    }

    const readConversationWidthPx = () =>
      conversationPanelElementRef.current?.getBoundingClientRect().width ?? null;

    const collapseSidebarIfStillNarrow = () => {
      const widthPx = readConversationWidthPx();
      if (widthPx === null) {
        return;
      }

      const {
        handleToggleSidebar: collapseSidebar,
        isSidebarVisible: latestIsSidebarVisible,
        workspaceKey: latestWorkspaceKey,
      } = conversationAutoCollapseStateRef.current;

      if (latestIsSidebarVisible && widthPx < CONVERSATION_AUTO_COLLAPSE_SIDEBAR_WIDTH_PX) {
        logger.info("[WorkspaceShellLayout] conversation too narrow, auto-collapsing sidebar", {
          widthPx: Math.round(widthPx),
          thresholdPx: CONVERSATION_AUTO_COLLAPSE_SIDEBAR_WIDTH_PX,
          workspaceKey: latestWorkspaceKey,
        });
        collapseSidebar();
      }
    };

    const runAutoCollapseForWindowResize = () => {
      const widthPx = readConversationWidthPx();
      if (widthPx === null) {
        return;
      }

      const {
        handleToggleSidePane: collapseSidePane,
        isSidePaneOpen: latestIsSidePaneOpen,
        workspaceKey: latestWorkspaceKey,
      } = conversationAutoCollapseStateRef.current;

      // Function description: Automatic collapse only responds to the actual width of the conversation after the user changes the window size.
      // Do not monitor the conversation itself ResizeObserver to avoid being shut down by the policy when the user manually opens the panel.
      if (latestIsSidePaneOpen && widthPx < CONVERSATION_AUTO_COLLAPSE_SIDE_PANE_WIDTH_PX) {
        logger.info("[WorkspaceShellLayout] conversation too narrow, auto-collapsing side pane", {
          widthPx: Math.round(widthPx),
          thresholdPx: CONVERSATION_AUTO_COLLAPSE_SIDE_PANE_WIDTH_PX,
          workspaceKey: latestWorkspaceKey,
        });
        collapseSidePane();
        window.requestAnimationFrame(() => {
          window.requestAnimationFrame(collapseSidebarIfStillNarrow);
        });
        return;
      }

      collapseSidebarIfStillNarrow();
    };

    const handleWindowResize = () => {
      if (conversationAutoCollapseResizeTimerRef.current !== null) {
        window.clearTimeout(conversationAutoCollapseResizeTimerRef.current);
      }

      // Large session resize trace shows that automatically collapsing the sidebar will trigger the WorkspaceSidebar
      // And a large number of tooltip/menu subtrees are re-rendered; when dragging the window, wait for resize idle first, and then retain the original collapse semantics.
      conversationAutoCollapseResizeTimerRef.current = window.setTimeout(() => {
        conversationAutoCollapseResizeTimerRef.current = null;
        runAutoCollapseForWindowResize();
      }, CONVERSATION_AUTO_COLLAPSE_RESIZE_IDLE_MS);
    };

    window.addEventListener("resize", handleWindowResize);

    return () => {
      if (conversationAutoCollapseResizeTimerRef.current !== null) {
        window.clearTimeout(conversationAutoCollapseResizeTimerRef.current);
        conversationAutoCollapseResizeTimerRef.current = null;
      }
      window.removeEventListener("resize", handleWindowResize);
    };
  }, [workspaceMainView]);

  useEffect(() => {
    workspaceSidebarPanelWidthPxRef.current = workspaceSidebarPanelWidthPx;
  }, [workspaceSidebarPanelWidthPx]);

  const applyWorkspaceSidebarWidthDuringDrag = useCallback(
    (nextWidthPx: number) => {
      workspaceSidebarPanelWidthPxRef.current = nextWidthPx;
      const shellElement = workspaceShellRef.current;
      if (!shellElement) {
        return;
      }

      // The large session trace shows that when dragging the sidebar, each pointermove has setState.
      // Will cause the WorkspaceShellLayout, WorkspaceSidebar and ChatView trees to render repeatedly.
      // The width during dragging is only a temporary layout value, written directly into CSS variables; the React state is submitted when released.
      shellElement.style.setProperty(
        WORKSPACE_SIDEBAR_PANEL_WIDTH_CSS_VAR,
        `${isSidebarPanelVisible ? nextWidthPx : collapsedSidebarWidthPx}px`,
      );
      shellElement.style.setProperty(WORKSPACE_SIDEBAR_WIDTH_CSS_VAR, `${nextWidthPx}px`);
    },
    [collapsedSidebarWidthPx, isSidebarPanelVisible],
  );

  useEffect(() => {
    if (readStoredWorkspaceSidebarWidthPx() !== null) {
      return;
    }

    const legacyRatio = readLegacyWorkspaceSidebarWidthRatio();
    const shellElement = workspaceShellRef.current;
    if (legacyRatio === null || !shellElement) {
      return;
    }

    const containerWidthPx = shellElement.getBoundingClientRect().width;
    if (!Number.isFinite(containerWidthPx) || containerWidthPx <= 0) {
      return;
    }

    // The outer workspace shell no longer uses react-resizable-panels,
    // But the old version has persisted the sidebar/content percentage. After migrating to pixel width,
    // Normal window resize will no longer trigger the RRP layout store, while still retaining the width of the sidebar dragged out by the user.
    const migratedWidthPx = clampWorkspaceSidebarWidth(
      containerWidthPx * legacyRatio,
      containerWidthPx,
    );
    workspaceSidebarPanelWidthPxRef.current = migratedWidthPx;
    setWorkspaceSidebarPanelWidthPx(migratedWidthPx);
    persistWorkspaceSidebarWidthPx(migratedWidthPx);
  }, []);

  const applyWorkspaceSidebarWidth = useCallback(
    (nextWidthPx: number, options: { persist: boolean }) => {
      const containerWidthPx = workspaceShellRef.current?.getBoundingClientRect().width;
      const resolvedWidthPx = clampWorkspaceSidebarWidth(nextWidthPx, containerWidthPx);
      workspaceSidebarPanelWidthPxRef.current = resolvedWidthPx;
      setWorkspaceSidebarPanelWidthPx((currentWidthPx) =>
        currentWidthPx === resolvedWidthPx ? currentWidthPx : resolvedWidthPx,
      );
      if (options.persist) {
        persistWorkspaceSidebarWidthPx(resolvedWidthPx);
      }
      return resolvedWidthPx;
    },
    [],
  );

  const handleWorkspaceSidebarResizeStart = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (!isSidebarPanelVisible || (event.pointerType === "mouse" && event.button !== 0)) {
        return;
      }

      const shellElement = workspaceShellRef.current;
      if (!shellElement) {
        return;
      }

      const containerWidthPx = shellElement.getBoundingClientRect().width;
      workspaceSidebarResizeSessionRef.current = {
        containerWidthPx,
        pointerId: event.pointerId,
        startWidthPx: workspaceSidebarPanelWidthPxRef.current,
        startX: event.clientX,
      };
      setWorkspaceSidebarResizeActive({
        active: true,
        panelElement: workspaceSidebarPanelElementRef.current,
        shellElement,
      });
      event.currentTarget.setPointerCapture(event.pointerId);
      event.preventDefault();
    },
    [isSidebarPanelVisible],
  );

  const handleWorkspaceSidebarResizeMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const resizeSession = workspaceSidebarResizeSessionRef.current;
      if (!resizeSession || resizeSession.pointerId !== event.pointerId) {
        return;
      }

      event.preventDefault();
      const nextWidthPx = clampWorkspaceSidebarWidth(
        resizeSession.startWidthPx + event.clientX - resizeSession.startX,
        resizeSession.containerWidthPx,
      );
      applyWorkspaceSidebarWidthDuringDrag(nextWidthPx);
      event.currentTarget.setAttribute("aria-valuenow", String(Math.round(nextWidthPx)));
    },
    [applyWorkspaceSidebarWidthDuringDrag],
  );

  const finishWorkspaceSidebarResize = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>, cancelled = false) => {
      const resizeSession = workspaceSidebarResizeSessionRef.current;
      if (!resizeSession || resizeSession.pointerId !== event.pointerId) {
        return;
      }

      workspaceSidebarResizeSessionRef.current = null;
      setWorkspaceSidebarResizeActive({
        active: false,
        panelElement: workspaceSidebarPanelElementRef.current,
        shellElement: workspaceShellRef.current,
      });
      setWorkspaceSidebarPanelWidthPx((currentWidthPx) => {
        const finalWidthPx = workspaceSidebarPanelWidthPxRef.current;
        return currentWidthPx === finalWidthPx ? currentWidthPx : finalWidthPx;
      });
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
      if (!cancelled) {
        persistWorkspaceSidebarWidthPx(workspaceSidebarPanelWidthPxRef.current);
      }
    },
    [],
  );

  const handleWorkspaceSidebarResizeKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      if (!isSidebarPanelVisible) {
        return;
      }

      const containerWidthPx = workspaceShellRef.current?.getBoundingClientRect().width;
      const maxWidthPx =
        containerWidthPx && containerWidthPx > 0
          ? containerWidthPx * WORKSPACE_SIDEBAR_MAX_WIDTH_RATIO
          : workspaceSidebarPanelWidthPxRef.current;
      let nextWidthPx: number | null = null;

      if (event.key === "ArrowLeft") {
        nextWidthPx =
          workspaceSidebarPanelWidthPxRef.current - WORKSPACE_SIDEBAR_RESIZE_KEYBOARD_STEP_PX;
      } else if (event.key === "ArrowRight") {
        nextWidthPx =
          workspaceSidebarPanelWidthPxRef.current + WORKSPACE_SIDEBAR_RESIZE_KEYBOARD_STEP_PX;
      } else if (event.key === "Home") {
        nextWidthPx = WORKSPACE_SIDEBAR_MIN_WIDTH_PX;
      } else if (event.key === "End") {
        nextWidthPx = maxWidthPx;
      }

      if (nextWidthPx === null) {
        return;
      }

      event.preventDefault();
      applyWorkspaceSidebarWidth(nextWidthPx, { persist: true });
    },
    [applyWorkspaceSidebarWidth, isSidebarPanelVisible],
  );

  useEffect(() => {
    return () => {
      setWorkspaceSidebarResizeActive({
        active: false,
        panelElement: workspaceSidebarPanelElementRef.current,
        shellElement: workspaceShellRef.current,
      });
    };
  }, []);

  const activeSearchResultHighlightRequest = useMemo(() => {
    if (!searchResultHighlightRequest || searchResultHighlightRequest.taskId !== activeTaskId) {
      return null;
    }

    const activeWorkspaceKey = buildTaskWorkspaceKey(workspaceAbsPath, workspaceIdentity);
    const requestWorkspaceKey = buildTaskWorkspaceKey(
      searchResultHighlightRequest.workspacePath,
      searchResultHighlightRequest.workspaceIdentity,
    );
    return activeWorkspaceKey === requestWorkspaceKey ? searchResultHighlightRequest : null;
  }, [activeTaskId, searchResultHighlightRequest, workspaceAbsPath, workspaceIdentity]);
  const renderChatFindDialog = () => <TaskFindDialog {...taskFindDialogProps} placement="chat" />;
  const gitDirtyFileCount = useMemo(() => {
    // Key business logic: The same file may appear in staged / unstaged at the same time.
    // Here, press path to remove duplicates and then count, to avoid double counting of the "number of uncommitted changed files" in the entrance.
    return getGitDirtyFileCount(gitState.datasets);
  }, [gitState.datasets.staged, gitState.datasets.unstaged]);
  const workspaceRemoteTarget = useMemo(
    () =>
      workspaceTabs.find(
        (tab) =>
          tab.workspacePath === workspaceAbsPath &&
          (!workspaceIdentity || tab.workspaceIdentity === workspaceIdentity),
      )?.remoteTarget,
    [workspaceAbsPath, workspaceIdentity, workspaceTabs],
  );
  const workspaceLocalPathForRemoteMcpSync = useMemo(
    () =>
      workspaceTabs.find(
        (tab) =>
          tab.workspacePath === workspaceAbsPath &&
          (!workspaceIdentity || tab.workspaceIdentity === workspaceIdentity),
      )?.localWorkspacePath,
    [workspaceAbsPath, workspaceIdentity, workspaceTabs],
  );
  const workspaceShellSplitStyle = useMemo(
    () =>
      ({
        "--workspace-sidebar-panel-width": `${
          isSidebarPanelVisible ? workspaceSidebarPanelWidthPx : collapsedSidebarWidthPx
        }px`,
        "--workspace-sidebar-width": `${workspaceSidebarPanelWidthPx}px`,
        "--workspace-panel-radius": `${workspacePanelRadiusPx}px`,
        "--workspace-resize-handle-inset": `${workspaceResizeHandleInsetPx}px`,
      }) as CSSProperties,
    [
      collapsedSidebarWidthPx,
      isSidebarPanelVisible,
      workspacePanelRadiusPx,
      workspaceResizeHandleInsetPx,
      workspaceSidebarPanelWidthPx,
    ],
  );
  const activePreviewPath = useMemo(() => {
    const activeSidePaneTab =
      sidePaneState?.tabs.find((tab) => tab.id === sidePaneState.activeTabId) ?? null;
    return activeSidePaneTab?.type === "code-viewer"
      ? (activeSidePaneTab.source.path ?? null)
      : null;
  }, [sidePaneState]);
  const findFileLinkOwnerWorkspace = useCallback(
    (
      targetPath: string,
      targetWorkspaceIdentity?: string,
      targetWorkspaceRemoteSessionId?: string,
    ) => {
      const matches = workspaceTabs.filter(
        (tab) =>
          isWorkspaceFilePathInside(tab.workspacePath, targetPath) &&
          (!targetWorkspaceIdentity || tab.workspaceIdentity === targetWorkspaceIdentity) &&
          (!targetWorkspaceRemoteSessionId ||
            tab.remoteSessionId === targetWorkspaceRemoteSessionId),
      );
      if (matches.length === 0) {
        return null;
      }
      return (
        matches.sort((left, right) => {
          const leftActive = left.workspaceIdentity === workspaceIdentity ? 1 : 0;
          const rightActive = right.workspaceIdentity === workspaceIdentity ? 1 : 0;
          if (leftActive !== rightActive) {
            return rightActive - leftActive;
          }
          return right.workspacePath.length - left.workspacePath.length;
        })[0] ?? null
      );
    },
    [workspaceIdentity, workspaceTabs],
  );
  const openFileTreeRequest = useCallback((request: Omit<SidebarFileTreeOpenRequest, "id">) => {
    fileTreeOpenRequestIdRef.current += 1;
    setFileTreeOpenRequest({
      id: fileTreeOpenRequestIdRef.current,
      ...request,
    });
  }, []);
  const showChatMainView = useCallback(() => {
    onWorkspaceMainViewChange("chat");
  }, [onWorkspaceMainViewChange]);
  const primaryNavigationBack =
    workspaceMainView === "plugin-store" ? handleManageInstalledPlugins : handleTaskNavBack;
  const canPrimaryNavigationBack = workspaceMainView === "plugin-store" || canTaskNavBack;
  const handleCreateTaskInChat = useCallback(
    (request?: Parameters<typeof onCreateTask>[0]) => {
      // workspaceReadOnlyReason determines the active workspace; when the request explicitly contains targetWorkspace
      // The target belongs to another project (initiating a saved workflow across projects),
      // The read-only nature of the active workspace does not apply, the real guard is the root action's isWorkspaceReadOnly on the target.
      const hasTargetWorkspace =
        typeof request === "object" && request !== null && Boolean(request.targetWorkspace);
      if (!hasTargetWorkspace && workspaceReadOnlyReason) {
        return;
      }
      showChatMainView();
      onCreateTask(request);
    },
    [onCreateTask, showChatMainView, workspaceReadOnlyReason],
  );
  const shellWorkbenchBinding = useMemo<WorkbenchSessionBinding | null>(
    () =>
      activeTaskId
        ? {
            workspaceScope: {
              workspacePath: workspaceAbsPath,
              ...(workspaceIdentity?.trim() ? { workspaceIdentity } : {}),
              ...(workspaceRemoteSessionId ? { remoteSessionId: workspaceRemoteSessionId } : {}),
            },
            sessionId: activeTaskId,
          }
        : null,
    [activeTaskId, workspaceAbsPath, workspaceIdentity, workspaceRemoteSessionId],
  );
  const handleCreateAutomationInChat = useCallback(
    (prompt: string, targetWorkspace?: { workspacePath: string; workspaceIdentity?: string }) => {
      // Skip the active workspace read-only check with target and hand it over to the handleCreateTaskInChat / root action.
      // Verification on target; shape unchanged without target.
      if (!targetWorkspace && workspaceReadOnlyReason) return;
      handleCreateTaskInChat({
        initialPrompt: prompt,
        ...(targetWorkspace ? { targetWorkspace } : {}),
      });
    },
    [handleCreateTaskInChat, workspaceReadOnlyReason],
  );
  // Workflow "Run" is now launched directly from the hub: GUI Create Empty Session +
  // Issue the startSavedWorkflow command and the dialogue copy will no longer be synthesized. This layer only switches the session to the foreground after accepted.
  const handleSelectTaskInChat = useCallback(
    (
      targetWorkspacePath: string,
      taskId: string,
      targetWorkspaceIdentity?: string,
      targetRemoteSessionId?: string,
      expectedUnreadAt?: number,
    ) => {
      {
        const workspaceResult = ensureTaskNavigationWorkspace({
          workspacePath: targetWorkspacePath,
          workspaceIdentity: targetWorkspaceIdentity,
          activateTabByPath: tabStoreApi.getState().activateTabByPath,
          addLocalWorkspaceTab: (workspacePath) => {
            tabStoreApi.getState().addTab(workspacePath);
          },
        });
        if (!workspaceResult.accepted) {
          logger.warn(
            "[automations] run history target remote workspace not connected, keeping current page",
            {
              sessionId: taskId,
              workspaceIdentity: targetWorkspaceIdentity,
              workspacePath: targetWorkspacePath,
            },
          );
          toast(intl.formatMessage({ id: "automations.runs.openSessionFailed" }));
          return;
        }
        if (workspaceResult.openedLocalTab) {
          logger.info("[automations] opened local workspace tab for run history session", {
            sessionId: taskId,
            workspacePath: targetWorkspacePath,
          });
        }
        const resolvedRemoteSessionId =
          targetRemoteSessionId ??
          workspaceTabs.find(
            (tab) =>
              (tab.workspaceIdentity?.trim() || tab.workspacePath) ===
              (targetWorkspaceIdentity?.trim() || targetWorkspacePath),
          )?.remoteSessionId;
        const target: V4SplitPaneSessionTarget = {
          workspacePath: targetWorkspacePath,
          ...(targetWorkspaceIdentity?.trim()
            ? { workspaceIdentity: targetWorkspaceIdentity }
            : {}),
          ...(resolvedRemoteSessionId ? { remoteSessionId: resolvedRemoteSessionId } : {}),
          sessionId: taskId,
        };
        selectWorkbenchSession(shellWorkbenchBinding, target);
      }
      // Close Automations only after the target workspace has been activated or has been re-opened successfully to avoid the failure from appearing like a successful jump.
      showChatMainView();
      if (typeof expectedUnreadAt === "number") {
        handleSelectTask(targetWorkspacePath, taskId, targetWorkspaceIdentity, expectedUnreadAt);
      } else {
        handleSelectTask(targetWorkspacePath, taskId, targetWorkspaceIdentity);
      }
    },
    [handleSelectTask, intl, shellWorkbenchBinding, showChatMainView, tabStoreApi, workspaceTabs],
  );
  // The hub directly starts accepted and then switches to a new session (the run card is already at the top): reuse the navigation of the running history,
  // The target is the coordinate of the project to which the workflow belongs (invariant 7), and the remoteSessionId determines the connection endpoint.
  const handleNavigateToLaunchedRun = useCallback(
    (target: SavedWorkflowLaunchTarget, sessionId: string) => {
      handleSelectTaskInChat(
        target.workspacePath,
        sessionId,
        target.workspaceIdentity,
        target.remoteSessionId,
      );
    },
    [handleSelectTaskInChat],
  );
  // Workflow running history "View instance": First go back to the session where it was initiated (the sidebar page is only visible in the chat view), and then open the instance details page.
  const handleOpenSavedWorkflowRun = useCallback(
    (params: SavedWorkflowsOpenRunParams) => {
      // The hub is a cross-project view: the instance must be opened in the project that originated it, not the active project.
      // params always takes workspacePath/identity; it only falls back to the active workspace when an exception occurs.
      const targetWorkspacePath = params.workspacePath || workspaceAbsPath;
      const targetWorkspaceIdentity =
        params.workspaceIdentity ?? (workspaceIdentity?.trim() ? workspaceIdentity : undefined);
      // remoteSessionId is not in the contract: check back from the open tab according to the target workspace; hit the active item to get the active value.
      const targetRemoteSessionId = workspaceTabs.find(
        (tab) =>
          tab.workspacePath === targetWorkspacePath &&
          (!targetWorkspaceIdentity || tab.workspaceIdentity === targetWorkspaceIdentity),
      )?.remoteSessionId;
      handleSelectTaskInChat(
        targetWorkspacePath,
        params.sessionId,
        targetWorkspaceIdentity,
        targetRemoteSessionId,
      );
      handleOpenWorkflowRun({
        workspacePath: targetWorkspacePath,
        ...(targetWorkspaceIdentity ? { workspaceIdentity: targetWorkspaceIdentity } : {}),
        ...(targetRemoteSessionId ? { remoteSessionId: targetRemoteSessionId } : {}),
        parentSessionId: params.sessionId,
        toolCallId: params.toolCallId,
        runId: params.runId,
        workflowName: params.workflowName,
      });
    },
    [
      handleOpenWorkflowRun,
      handleSelectTaskInChat,
      workspaceAbsPath,
      workspaceIdentity,
      workspaceTabs,
    ],
  );
  // Sidebar run line: with composer logo
  // Same jump - first select the session, then open the run pane. Run without toolCallId (which shouldn't be there) only selects the session.
  const handleOpenSidebarWorkflowRun = useCallback(
    (target: WorkflowRunOpenTarget) => {
      if (target.run.toolCallId === undefined) {
        const targetRemoteSessionId = workspaceTabs.find(
          (tab) =>
            tab.workspacePath === target.workspacePath &&
            (!target.workspaceIdentity || tab.workspaceIdentity === target.workspaceIdentity),
        )?.remoteSessionId;
        handleSelectTaskInChat(
          target.workspacePath,
          target.sessionId,
          target.workspaceIdentity,
          targetRemoteSessionId,
        );
        return;
      }
      handleOpenSavedWorkflowRun({
        sessionId: target.sessionId,
        runId: target.run.runId,
        toolCallId: target.run.toolCallId,
        workflowName: target.run.name ?? "",
        workspacePath: target.workspacePath,
        ...(target.workspaceIdentity ? { workspaceIdentity: target.workspaceIdentity } : {}),
      });
    },
    [handleOpenSavedWorkflowRun, handleSelectTaskInChat, workspaceTabs],
  );
  // The product of the hub, chip: is literally isomorphic to "view instance" (the same path of "first go back to the session that initiated it"),
  // Just the end point is the `workflow-artifact` tab instead of the run details page.
  const handleOpenSavedWorkflowArtifact = useCallback(
    (params: SavedWorkflowsOpenArtifactParams) => {
      const targetWorkspacePath = params.workspacePath || workspaceAbsPath;
      const targetWorkspaceIdentity =
        params.workspaceIdentity ?? (workspaceIdentity?.trim() ? workspaceIdentity : undefined);
      const targetRemoteSessionId = workspaceTabs.find(
        (tab) =>
          tab.workspacePath === targetWorkspacePath &&
          (!targetWorkspaceIdentity || tab.workspaceIdentity === targetWorkspaceIdentity),
      )?.remoteSessionId;
      handleSelectTaskInChat(
        targetWorkspacePath,
        params.sessionId,
        targetWorkspaceIdentity,
        targetRemoteSessionId,
      );
      handleOpenWorkflowArtifact({
        workspacePath: targetWorkspacePath,
        ...(targetWorkspaceIdentity ? { workspaceIdentity: targetWorkspaceIdentity } : {}),
        ...(targetRemoteSessionId ? { remoteSessionId: targetRemoteSessionId } : {}),
        parentSessionId: params.sessionId,
        runId: params.runId,
        artifactId: params.artifactId,
        ...(params.title === undefined ? {} : { title: params.title }),
        // The core chip payload brings the contentType (the html product directly opens the browser tab according to it); `sourcePath`
        // There is no such payload, so `handleOpenWorkflowArtifact` can check the journal and make up for it.
        ...(params.contentType === undefined ? {} : { contentType: params.contentType }),
      });
    },
    [
      handleOpenWorkflowArtifact,
      handleSelectTaskInChat,
      workspaceAbsPath,
      workspaceIdentity,
      workspaceTabs,
    ],
  );
  const handlePaneActiveSessionChange = useCallback(
    (
      scope: {
        workspacePath: string;
        workspaceIdentity?: string;
        remoteSessionId?: string;
      },
      sessionId: string,
    ) => {
      handleSelectTaskInChat(
        scope.workspacePath,
        sessionId,
        scope.workspaceIdentity,
        scope.remoteSessionId,
      );
    },
    [handleSelectTaskInChat],
  );

  const canOpenSessionInSplitPane = useCallback(
    (target: V4SplitPaneSessionTarget) => {
      return canPlaceWorkbenchSessionInSplit(shellWorkbenchBinding, target, {
        mode: "context-menu",
        side: "right",
      });
    },
    [shellWorkbenchBinding],
  );
  const handleOpenSessionInSplitPane = useCallback(
    (target: V4SplitPaneSessionTarget) => {
      showChatMainView();
      const shouldSelectTarget = placeWorkbenchSessionInSplit(shellWorkbenchBinding, target, {
        mode: "context-menu",
        side: "right",
      });
      if (shouldSelectTarget) {
        handleSelectTask(target.workspacePath, target.sessionId, target.workspaceIdentity);
      }
    },
    [handleSelectTask, shellWorkbenchBinding, showChatMainView],
  );
  const handleStartDraftInWorkspaceInChat = useCallback(
    (
      targetWorkspacePath: string,
      targetWorkspaceIdentity?: string,
      targetWorkspacePurpose?: import("@zcode/shared").WorkspacePurpose,
      createSource?: import("@zcode/shared").SessionCreateSource,
    ) => {
      showChatMainView();
      handleStartDraftInWorkspace(
        targetWorkspacePath,
        targetWorkspaceIdentity,
        targetWorkspacePurpose,
        createSource,
      );
    },
    [handleStartDraftInWorkspace, showChatMainView],
  );
  const handleCreateProjectDraft = useCallback(
    (path: string, identity?: string) =>
      handleStartDraftInWorkspaceInChat(path, identity, undefined, "project"),
    [handleStartDraftInWorkspaceInChat],
  );
  const activeWorkspacePurpose =
    workspaceTabs.find(
      (tab) =>
        tab.workspacePath === workspaceAbsPath &&
        (!workspaceIdentity || tab.workspaceIdentity === workspaceIdentity),
    )?.workspacePurpose ?? "project";
  const handleSelectConversationWorkspace = useCallback(async () => {
    if (!onResolveConversationWorkspace) {
      return;
    }
    let targetWorkspacePath: string;
    try {
      targetWorkspacePath = await onResolveConversationWorkspace();
    } catch (error) {
      logger.error("[WorkspaceShellLayout] failed to switch conversation workspace", {
        error,
      });
      return;
    }
    if ((workspaceIdentity?.trim() || workspaceAbsPath) !== targetWorkspacePath) {
      requestV4ComposerDraftWorkspaceTransfer({
        sourceWorkspacePath: workspaceAbsPath,
        sourceWorkspaceIdentity: workspaceIdentity,
        targetWorkspacePath,
      });
    }
    handleStartDraftInWorkspaceInChat(targetWorkspacePath, undefined, "conversation");
  }, [
    handleStartDraftInWorkspaceInChat,
    onResolveConversationWorkspace,
    workspaceAbsPath,
    workspaceIdentity,
  ]);
  const handleSelectComposerPlugin = useCallback(
    (mention: ComposerMentionPrefill) => {
      useZCodeSessionStore
        .getState()
        .requestComposerTextInsert(
          workspaceAbsPath,
          mention.markdown,
          workspaceIdentity,
          mention,
          "prepend-if-missing",
        );
    },
    [workspaceAbsPath, workspaceIdentity],
  );
  // v4 pane life cycle callback (stable reference for consumption by memo-friendly pane hosts):
  // Access the existing selection path after createSession/fork; return to draft after deleting the session.
  const handleV4SessionCreated = useCallback(
    (sessionId: string) => {
      handleSelectTask(workspaceAbsPath, sessionId, workspaceIdentity);
    },
    [handleSelectTask, workspaceAbsPath, workspaceIdentity],
  );
  // Draft state composer contextHeader: workspace switch menu +
  // Git branch switcher, isomorphic to the old ChatView empty contextHeaderContent. shell level capability
  // (workspaceTabs / remote connection callback) is closed here, and the pane only accepts ReactNode.
  // onSelectWorkspace semantics are consistent with the old version: switch to the new draft of the target workspace.
  const draftComposerHeader = useMemo(
    () => (
      <>
        <ChatEmptyWorkspacePreviewMenu
          workspacePath={workspaceAbsPath}
          workspaceIdentity={workspaceIdentity}
          isWindowsDesktop={isWindowsDesktop}
          workspaceTabs={workspaceTabs}
          onSelectWorkspace={(workspaceTab) =>
            handleStartDraftInWorkspaceInChat(
              workspaceTab.workspacePath,
              workspaceTab.workspaceIdentity,
              workspaceTab.workspacePurpose,
            )
          }
          onSelectConversationWorkspace={handleSelectConversationWorkspace}
          onOpenFolder={onOpenFolderFromWorkspaceMenu}
          allowOpenWorkspace={allowOpenWorkspace}
          allowRemoteWorkspace={allowRemoteWorkspace}
          remoteWorkspaceSessions={remoteWorkspaceSessions}
          onConnectRemote={onConnectRemote}
          onSelectRemoteProject={onSelectRemoteProject}
          onCancelRemoteProject={onCancelRemoteProject}
        />
        {isOfficeMode ? (
          <WorkspacePluginPreview
            onOpen={handleOpenPluginStore}
            onSelectPlugin={handleSelectComposerPlugin}
            workspacePath={workspaceAbsPath}
            workspaceIdentity={workspaceIdentity}
            remoteSessionId={workspaceRemoteSessionId ?? undefined}
          />
        ) : !isOfficeMode && activeWorkspacePurpose === "project" ? (
          <GitBranchSwitcher
            workspacePath={workspaceAbsPath}
            gitSummary={gitState.summary}
            dirtyFileCount={gitDirtyFileCount}
            onRefreshGit={handleRefreshGit}
            className="px-0 pt-0"
            popoverClassName="w-72"
            branchListClassName="max-h-48"
            // The input box area is at the bottom, and Radix collision avoidance will flip the branch menu to the bottom.
            // The upper pop-up is locked here to prevent the menu from blocking the input area and to keep the operating direction stable.
            avoidPopoverCollisions={false}
          />
        ) : null}
      </>
    ),
    [
      isOfficeMode,
      workspaceRemoteSessionId,
      handleOpenPluginStore,
      handleSelectComposerPlugin,
      allowOpenWorkspace,
      allowRemoteWorkspace,
      activeWorkspacePurpose,
      gitDirtyFileCount,
      gitState.summary,
      handleRefreshGit,
      handleSelectConversationWorkspace,
      handleStartDraftInWorkspaceInChat,
      isWindowsDesktop,
      onCancelRemoteProject,
      onConnectRemote,
      onOpenFolderFromWorkspaceMenu,
      onSelectRemoteProject,
      remoteWorkspaceSessions,
      workspaceAbsPath,
      workspaceIdentity,
      workspaceTabs,
    ],
  );
  const handleV4SessionDeleted = useCallback(() => {
    if (activeTaskId) {
      for (const tab of sidePaneState?.tabs ?? []) {
        if (tab.type === "selection-side-chat" && tab.parentSessionId === activeTaskId) {
          handleCloseSidePaneTab(tab.id);
        }
      }
    }
    handleStartDraftInWorkspaceInChat(workspaceAbsPath, workspaceIdentity);
  }, [
    activeTaskId,
    handleCloseSidePaneTab,
    handleStartDraftInWorkspaceInChat,
    sidePaneState?.tabs,
    workspaceAbsPath,
    workspaceIdentity,
  ]);
  const handleOpenMarkdownFileLink = useCallback(
    async (target: WorkspacePathOpenRequest) => {
      if (workspaceReadOnlyReason && target.serviceScope !== "base-local") {
        return;
      }
      try {
        const fileService = selectWorkspacePathFileService(
          target,
          services.fileService,
          baseServices.fileService,
        );
        const fileStat = await fileService.stat({
          path: target.path,
        });
        if (fileStat.type === "file") {
          if (
            shouldOpenAssistantHtmlInBrowser({
              path: target.path,
              workspaceIdentity: target.workspaceIdentity,
              workspaceRemoteSessionId: target.workspaceRemoteSessionId,
            })
          ) {
            handleOpenBrowserUrl(toFileUrl(target.path));
            return;
          }
          handleOpenCodeViewer({
            type: "file",
            title: getPathLeaf(target.path),
            path: target.path,
            workspacePath: target.workspacePath,
            workspaceIdentity: target.workspaceIdentity,
            workspaceRemoteSessionId: target.workspaceRemoteSessionId,
          });
          return;
        }

        if (target.serviceScope === "base-local") {
          openFileTreeRequest({
            target: {
              workspacePath: target.path,
              workspaceName: target.label || getPathLeaf(target.path),
              revealPath: target.path,
              temporaryExternalDirectory: true,
            },
          });
          return;
        }

        const ownerWorkspace = findFileLinkOwnerWorkspace(
          target.path,
          target.workspaceIdentity,
          target.workspaceRemoteSessionId,
        );
        if (ownerWorkspace) {
          openFileTreeRequest({
            target: {
              workspacePath: ownerWorkspace.workspacePath,
              workspaceName: ownerWorkspace.label,
              workspaceIdentity: ownerWorkspace.workspaceIdentity,
              workspaceRemoteSessionId: ownerWorkspace.remoteSessionId,
              revealPath: areWorkspaceFilePathsEqual(ownerWorkspace.workspacePath, target.path)
                ? undefined
                : target.path,
            },
          });
          return;
        }

        openFileTreeRequest({
          target: {
            workspacePath: target.path,
            workspaceName: target.label || getPathLeaf(target.path),
            revealPath: target.path,
            temporaryExternalDirectory: true,
          },
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.warn("[WorkspaceShell] failed to open markdown file link", {
          path: target.path,
          error: message,
        });
        if (shouldFallbackWorkspacePathToCodeViewer(target)) {
          // markdown file link may point to a path that no longer exists.
          // When stat fails, it is still handed over to CodeViewer to display specific file reading errors to avoid no feedback at all when clicking.
          handleOpenCodeViewer({
            type: "file",
            title: getPathLeaf(target.path),
            path: target.path,
            workspacePath: target.workspacePath,
            workspaceIdentity: target.workspaceIdentity,
            workspaceRemoteSessionId: target.workspaceRemoteSessionId,
          });
        }
        toast(intl.formatMessage({ id: "workspaceFileTree.openFailed" }));
      }
    },
    [
      findFileLinkOwnerWorkspace,
      baseServices.fileService,
      handleOpenBrowserUrl,
      handleOpenCodeViewer,
      intl,
      openFileTreeRequest,
      services.fileService,
      workspaceReadOnlyReason,
    ],
  );
  useEffect(
    () =>
      addWorkspacePathOpenRequestListener((target) => {
        void handleOpenMarkdownFileLink(target);
      }),
    [handleOpenMarkdownFileLink],
  );
  const handleRevealGitFileInTree = useCallback(
    (path: string) => {
      if (workspaceReadOnlyReason) {
        return;
      }
      openFileTreeRequest({
        target: {
          workspacePath: workspaceAbsPath,
          workspaceName: projectName,
          workspaceIdentity,
          workspaceRemoteSessionId,
          revealPath: path,
        },
      });
    },
    [
      openFileTreeRequest,
      projectName,
      workspaceAbsPath,
      workspaceIdentity,
      workspaceRemoteSessionId,
      workspaceReadOnlyReason,
    ],
  );
  const activeSelectionSideChatSessionId = activeTaskId
    ? (getActiveSelectionSideChatTab(sidePaneState, {
        workspaceKey,
        parentSessionId: activeTaskId,
      })?.childSessionId ?? null)
    : null;
  const handleOpenSelectionSideConversationLauncher = useCallback(() => {
    if (!activeTaskId) return;
    const requested = requestSelectionSideChatOpen(
      buildSelectionSideChatKey(workspaceKey, activeTaskId),
    );
    if (!requested) {
      // The fixed entry is taken by the current main SessionPane; if the pane has not been mounted, the shell is not allowed to splice the remote identity or protocol by itself.
      logger.warn("[WorkspaceShell] side conversation launcher has no main session controller", {
        parentSessionId: activeTaskId,
        workspaceKey,
      });
    }
  }, [activeTaskId, workspaceKey]);
  const renderSidePanePanel = () => (
    <AnimatedSidePanePanel
      services={services}
      isDesktop={isDesktop}
      isWindowsDesktop={isWindowsDesktop}
      frameClassName={resolveWorkspaceShellWindowChromeClass({
        isMacDesktop,
        isWindowsDesktop,
        isLinuxDesktop,
        macOSMajorVersion: desktopWindowChromeState?.macOSMajorVersion,
        isWindowsMaximized: desktopWindowChromeState?.isMaximized ?? false,
        supportsNativeRoundedCorners:
          desktopWindowChromeState?.supportsNativeRoundedCorners ?? null,
      })}
      showWindowControls={usesInlineWindowControls}
      isVisible={isSidePaneVisible}
      onCloseSidePane={handleToggleSidePane}
      toggleSidePaneShortcutLabel={toggleSidePaneShortcutLabel}
      sidePaneState={sidePaneState}
      recentClosedSidePaneTabs={recentClosedSidePaneTabs}
      isBrowserOpen={isBrowserOpen}
      supportsEmbeddedBrowser={supportsEmbeddedBrowser}
      workspaceAbsPath={workspaceAbsPath}
      workspaceIdentity={workspaceIdentity}
      workspaceRemoteSessionId={workspaceRemoteSessionId}
      activeTaskId={activeTaskId}
      sidePaneOwnerId={sidePaneOwnerId}
      gitState={gitState}
      activeGitSourceId={activeGitSourceId}
      panelRef={sidePanePanelRef}
      panelElementRef={sidePanePanelElementRef}
      browserNavigationRequest={browserNavigationRequest}
      browserRestoreUrls={browserRestoreUrls}
      screenshotSurfaceRequest={screenshotSurfaceRequest}
      screenshotSurfaceTabId={screenshotSurfaceTab?.id ?? null}
      fileChangeFindActiveIndex={fileChangeFindActiveIndex}
      fileChangeFindNavigationRequestId={fileChangeFindNavigationRequestId}
      fileChangeFindQuery={fileChangeFindQuery}
      onFileChangeFindMatchCountChange={onFileChangeFindMatchCountChange}
      onCloseCodeViewer={handleCloseCodeViewer}
      onCloseGit={handleCloseGit}
      onActivateTab={handleActivateSidePaneTab}
      onReorderTab={handleReorderSidePaneTab}
      onCloseTab={handleCloseSidePaneTab}
      onCloseOtherTabs={handleCloseOtherSidePaneTabs}
      onCloseAllTabs={handleCloseAllSidePaneTabs}
      onReopenClosedTab={handleReopenClosedSidePaneTab}
      onOpenBrowserTab={handleOpenBrowserTab}
      onOpenWhiteboard={handleOpenWhiteboard}
      onOpenDeveloperTools={handleOpenDeveloperTools}
      onOpenTerminalTab={handleOpenTerminalTab}
      onOpenReviewTab={handleToggleGit}
      onOpenSelectionSideConversation={handleOpenSelectionSideConversationLauncher}
      onRevealGitFileInTree={handleRevealGitFileInTree}
      onOpenBrowserUrl={handleOpenBrowserUrl}
      onOpenCodeViewer={handleOpenCodeViewer}
      onOpenFileLink={handleOpenMarkdownFileLink}
      onOpenBackgroundBash={handleOpenBackgroundBash}
      onOpenSubagentSession={handleOpenSubagentSession}
      onOpenWorkflowActorSession={handleOpenWorkflowActorSession}
      onOpenWorkflowWorkspace={handleOpenWorkflowWorkspace}
      onOpenWorkflowArtifact={handleOpenWorkflowArtifact}
      onOpenWorkflowRun={handleOpenWorkflowRun}
      onRefreshGit={handleRefreshGit}
      onBrowserNavigationRequestHandled={handleBrowserNavigationRequestHandled}
      onBrowserUrlChange={handleBrowserUrlChange}
      onBrowserPageMetadataChange={handleBrowserPageMetadataChange}
      onSelectGitSource={setGitSelectedSourceId}
    />
  );
  const sidePanePanel = renderSidePanePanel();
  const hasUpdateStatusButton =
    updateReadyVersion !== null ||
    updateState?.kind === "update-available" ||
    updateState?.kind === "download-progress" ||
    updateState?.kind === "update-downloaded";
  // Draft previously maintained a set of independent lightweight headers, resulting in side pane, caption safe area and drag entry
  // Fork with Task Header. WorkspaceHeader is reused uniformly on the desktop, and only task-specific content is trimmed by variant;
  // When the mobile phone remote control has no active task, it still does not render the desktop chrome and continues to respect the replayable overlay boundary.
  const shouldRenderMainViewHeader =
    workspaceMainView !== "automations" && workspaceMainView !== "plugin-store";
  const shouldRenderWorkspaceHeader =
    shouldRenderMainViewHeader && (activeTaskId !== null || isDesktop);
  // If the array of ErrorBoundary resetKeys is recreated every time render,
  // Even if the workspace/task does not change, it will continue to appear as subtree props changes in the React DevTools Components track.
  const workspaceOnlyResetKeys = useMemo(() => [workspaceKey], [workspaceKey]);
  const workspaceDraftResetKeys = useMemo(
    () => [workspaceKey, activeTaskId ?? "draft"],
    [workspaceKey, activeTaskId],
  );
  const workspaceSidebarVisibilityResetKeys = useMemo(
    () => [workspaceKey, isSidebarVisible],
    [workspaceKey, isSidebarVisible],
  );

  return (
    <DesktopWindowFrame
      title={`ZCode / ${getPathLeaf(workspaceAbsPath)}`}
      showHeader
      isDesktop={isDesktop}
      isMacDesktop={isMacDesktop}
      isWindowsDesktop={isWindowsDesktop}
      headerTestId={TID_APP_HEADER}
    >
      <div
        ref={workspaceShellRef}
        data-workspace-shell="true"
        style={workspaceShellSplitStyle}
        className={cn(
          "relative flex h-full min-h-0 w-full overflow-hidden",
          // When the window is resized natively, the outer react-resizable-panels will resize each frame
          // All are written into the layout store, and the sidebar tooltip/menu subtree is committed repeatedly. Change here to
          // A special split driven by CSS variables, ordinary window resize only follows the browser layout and does not trigger the React state.
        )}
      >
        <div
          ref={workspaceSidebarPanelElementRef}
          data-panel=""
          data-workspace-sidebar-panel="true"
          id="sidebar"
          className={cn(
            "w-[var(--workspace-sidebar-panel-width)] max-w-[50%] flex-none overflow-hidden duration-200 ease-out transition-[width,opacity] data-[workspace-sidebar-resizing=true]:transition-opacity",
            // If you continue to transition width while dragging the sidebar width, there will be a lag between the pointer movement and the actual width.
            // Drag active to switch transitions through DOM tags to avoid pointerdown/up re-rendering the entire workspace in order to switch classes.
            isSidebarPanelVisible ? "opacity-100" : "pointer-events-none opacity-0",
          )}
        >
          <aside
            ref={sidebarContainerRef}
            className="h-full overflow-hidden select-none"
            aria-hidden={!isSidebarPanelVisible}
          >
            <ScopedErrorBoundary
              scope="workspace-sidebar"
              resetKeys={workspaceOnlyResetKeys}
              variant="panel"
              className="h-full"
            >
              {/* Session workbench groups: the desktop and the regular web app can split the screen. */}
              <V4SplitPaneEntryProvider
                enabled
                canOpenSession={canOpenSessionInSplitPane}
                onOpenSession={handleOpenSessionInSplitPane}
              >
                <WorkflowRunOpenProvider onOpenRun={handleOpenSidebarWorkflowRun}>
                  <WorkspaceSidebar
                    workspacePath={workspaceAbsPath}
                    workspaceRemoteSessionId={workspaceRemoteSessionId}
                    activePreviewPath={activePreviewPath}
                    onSelectTask={handleSelectTaskInChat}
                    onStartDraftInWorkspace={handleCreateProjectDraft}
                    onOpenCodeViewer={handleOpenCodeViewer}
                    onOpenBrowserUrl={handleOpenBrowserUrl}
                    fileTreeOpenRequest={fileTreeOpenRequest}
                    onCreateTask={handleCreateTaskInChat}
                    onCreateConversationTask={onCreateConversationTask ?? handleCreateTaskInChat}
                    onOpenFolderFromWorkspaceMenu={onOpenFolderFromWorkspaceMenu}
                    onOpenRemoteWorkspace={onOpenRemoteWorkspace}
                    theme={theme}
                    onConnectRemote={onConnectRemote}
                    onSelectRemoteProject={onSelectRemoteProject}
                    onCancelRemoteProject={onCancelRemoteProject}
                    onReconnectRemoteWorkspace={onReconnectRemoteWorkspace}
                    reconnectingRemoteWorkspaceKeys={reconnectingRemoteWorkspaceKeys}
                    remoteWorkspaceErrorByWorkspaceKey={remoteWorkspaceErrorByWorkspaceKey}
                    reconnectingRemoteWorkspaceLogsByWorkspaceKey={
                      reconnectingRemoteWorkspaceLogsByWorkspaceKey
                    }
                    onLogout={onLogout}
                    onLogin={onLogin}
                    user={user}
                    isDesktop={isDesktop}
                    isMacDesktop={isMacDesktop}
                    isWindowsDesktop={isWindowsDesktop}
                    isSidebarVisible={isSidebarVisible}
                    onToggleSidebar={handleToggleSidebar}
                    toggleSidebarShortcutLabel={toggleSidebarShortcutLabel}
                    canGoBack={canPrimaryNavigationBack}
                    canGoForward={canTaskNavForward}
                    onGoBack={primaryNavigationBack}
                    onGoForward={handleTaskNavForward}
                    goBackShortcutLabel={goBackShortcutLabel}
                    goForwardShortcutLabel={goForwardShortcutLabel}
                    onOpenCommandCenter={handleOpenCommandCenter}
                    onOpenAutomations={handleOpenAutomations}
                    automationsActive={workspaceMainView === "automations"}
                    onOpenPluginStore={handleOpenPluginStore}
                    pluginStoreActive={workspaceMainView === "plugin-store"}
                    onFileTreeOpenChange={setIsSidebarFileTreeOpen}
                  />
                </WorkflowRunOpenProvider>
              </V4SplitPaneEntryProvider>
            </ScopedErrorBoundary>
          </aside>
        </div>

        {isSidebarVisible ? (
          <div
            role="separator"
            tabIndex={0}
            aria-controls="sidebar"
            aria-label={workspaceSidebarResizeLabel}
            aria-orientation="vertical"
            aria-valuemin={WORKSPACE_SIDEBAR_MIN_WIDTH_PX}
            aria-valuenow={Math.round(workspaceSidebarPanelWidthPx)}
            data-testid="resizable-handle"
            onKeyDown={handleWorkspaceSidebarResizeKeyDown}
            onPointerCancel={(event) => finishWorkspaceSidebarResize(event, true)}
            onPointerDown={handleWorkspaceSidebarResizeStart}
            onPointerMove={handleWorkspaceSidebarResizeMove}
            onPointerUp={(event) => finishWorkspaceSidebarResize(event)}
            className={cn(
              "group/handle relative z-10 flex h-full w-1 shrink-0 touch-none cursor-ew-resize items-center justify-center bg-transparent outline-none [app-region:no-drag] focus:outline-none focus-visible:ring-0",
              "after:pointer-events-none after:absolute after:rounded-full after:bg-foreground-subtlest/50 after:opacity-0 after:transition-opacity after:content-[''] after:inset-y-[var(--workspace-panel-radius)] after:w-0.5",
              "hover:after:opacity-100 data-[separator=hover]:after:opacity-100 data-[separator=active]:after:opacity-100 focus-visible:after:opacity-100 [[data-workspace-sidebar-resizing=true]_&]:after:opacity-100",
              hasDesktopPanelInset && "after:inset-y-[var(--workspace-resize-handle-inset)]",
            )}
          />
        ) : null}
        {/* The main workspace on the right: header on top, sessions + terminal at the bottom left, shared browser/code-viewer slot on the right */}
        <div
          data-panel=""
          id="content"
          className={cn(
            "flex min-w-[320px] flex-1 flex-col",
            hasDesktopPanelInset ? "p-1 pl-0 pt-0" : "p-0",
          )}
        >
          {
            hasDesktopPanelInset && (
              <div className="h-1 w-full [app-region:drag]" />
            ) /* Fixes the macOS traffic-light window buttons being covered by the header and therefore unclickable */
          }
          <ResizablePanelGroup
            layoutId="workspace-body-layout"
            panelIds={WORKSPACE_BODY_PANEL_IDS}
            className="min-h-0 flex-1"
          >
            <ResizablePanel
              id="conversation-column"
              minSize="35%"
              defaultSize={isSidePaneVisible ? "52%" : undefined}
            >
              <ResizablePanelGroup
                orientation="vertical"
                layoutId="workspace-conversation-column-layout"
                panelIds={WORKSPACE_CONVERSATION_PANEL_IDS}
                className="h-full min-h-0"
              >
                <ResizablePanel
                  id="conversation"
                  elementRef={conversationPanelElementRef}
                  minSize="35%"
                >
                  <section
                    data-workspace-conversation-frame="true"
                    className={cn(
                      "relative flex h-full min-h-0 flex-1 flex-col overflow-hidden bg-background",
                      isSidePaneVisible
                        ? "rounded-[var(--workspace-panel-radius)] border border-border"
                        : resolveWorkspaceShellWindowChromeClass({
                            isMacDesktop,
                            isWindowsDesktop,
                            isLinuxDesktop,
                            macOSMajorVersion: desktopWindowChromeState?.macOSMajorVersion,
                            isWindowsMaximized: desktopWindowChromeState?.isMaximized ?? false,
                            supportsNativeRoundedCorners:
                              desktopWindowChromeState?.supportsNativeRoundedCorners ?? null,
                          }),
                      isTerminalVisible && "rounded-b-[var(--workspace-panel-radius)] border-b",
                    )}
                  >
                    {shouldRenderWorkspaceHeader ? (
                      <ScopedErrorBoundary
                        scope="workspace-header"
                        resetKeys={workspaceOnlyResetKeys}
                        variant="compact"
                        className="border-b"
                      >
                        <WorkspaceHeader
                          reserveWindowControls={!isSidePaneVisible}
                          variant={activeTaskId === null ? "draft" : "task"}
                          draftDropTargetController={
                            activeTaskId === null ? draftHeaderDropTargetController : undefined
                          }
                          readOnlyReason={workspaceReadOnlyReason}
                          workspaceAbsPath={workspaceAbsPath}
                          remoteSessionId={workspaceRemoteSessionId}
                          workspaceIdentity={workspaceIdentity}
                          remoteTarget={workspaceRemoteTarget}
                          localWorkspacePath={workspaceLocalPathForRemoteMcpSync}
                          projectName={projectName}
                          activeTaskTitle={activeTaskTitle}
                          activeTaskChangeSummary={activeTaskChangeSummary}
                          hasUpdateReady={hasUpdateStatusButton}
                          activeTaskId={activeTaskId}
                          user={user}
                          activeTraceId={activeTraceId}
                          activeSessionId={activeSessionId}
                          activeTaskProvider={activeTaskProvider}
                          resolvedActiveTaskMeta={resolvedActiveTaskMeta}
                          sessionLogPath={taskSessionFile.path}
                          nativeSessionLogProvider={taskNativeSessionLogFile.provider}
                          nativeSessionLogPath={taskNativeSessionLogFile.path}
                          nativeSessionLogExists={taskNativeSessionLogFile.exists}
                          nativeSessionLogLoading={taskNativeSessionLogFile.loading}
                          workspaceHeaderState={workspaceShellZCodeState}
                          gitSummary={gitState.summary}
                          gitDirtyFileCount={gitDirtyFileCount}
                          isMacDesktop={isMacDesktop}
                          isMacFullscreen={isMacFullscreen}
                          isWindowsDesktop={isWindowsDesktop}
                          windowsWindowControlsRightPaddingPx={windowsWindowControlsRightPaddingPx}
                          isDesktop={isDesktop}
                          isSidebarVisible={isSidebarVisible}
                          isTerminalOpen={isTerminalOpen}
                          isSidePaneOpen={isSidePaneOpen}
                          onRefreshGit={handleRefreshGit}
                          onToggleTerminal={handleToggleTerminal}
                          onToggleBrowser={handleToggleBrowser}
                          onToggleSidePane={handleToggleSidePane}
                          toggleSidePaneShortcutLabel={toggleSidePaneShortcutLabel}
                          onReloadSession={handleReloadSession}
                          reloadSessionDisabled={workspaceSessionActionDisabled}
                          reloadSessionPending={reloadSessionPending}
                          onCreateTask={handleCreateTaskInChat}
                          onOpenWorkspace={onOpenWorkspace}
                          allowOpenWorkspace={allowOpenWorkspace}
                        />
                      </ScopedErrorBoundary>
                    ) : null}
                    <div className="min-h-0 flex-1 overflow-hidden">
                      {workspaceMainView === "automations" ? (
                        <main
                          id={AUTOMATIONS_TOAST_ANCHOR_ID}
                          className="flex h-full min-h-0 flex-1 flex-col bg-background"
                        >
                          <AutomationsMainBreadcrumbFrame
                            isDesktop={Boolean(isDesktop)}
                            sectionLabel={intl.formatMessage({
                              id: "settings.automations.title",
                            })}
                            ariaLabel={intl.formatMessage({
                              id: "automations.breadcrumbLabel",
                            })}
                          >
                            <div
                              // The content height of different Automations tabs is different, and the appearance/disappearance of scroll bars will change.
                              // mx-auto The available width of the content column, causing the entire page to bounce left and right; a stable slot is reserved to keep the centering reference unchanged.
                              className="min-h-0 flex-1 overflow-y-auto [scrollbar-gutter:stable]"
                            >
                              <ScopedErrorBoundary
                                scope="automations-main"
                                resetKeys={workspaceOnlyResetKeys}
                                variant="panel"
                                className="min-h-full"
                              >
                                <div className="mx-auto flex w-full max-w-5xl flex-col px-4 py-4 md:px-6 md:py-6">
                                  <AutomationsSection
                                    workspacePath={workspaceAbsPath}
                                    workspaceIdentity={workspaceIdentity}
                                    onCreateViaChat={handleCreateAutomationInChat}
                                    onNavigateToLaunchedRun={handleNavigateToLaunchedRun}
                                    onOpenWorkflowRun={handleOpenSavedWorkflowRun}
                                    onOpenWorkflowArtifact={handleOpenSavedWorkflowArtifact}
                                    openAutomationId={openAutomationId}
                                    openAutomationTab={openAutomationTab}
                                    onOpenAutomationConsumed={onOpenAutomationConsumed}
                                    onOpenSession={({
                                      sessionId,
                                      workspacePath,
                                      workspaceIdentity,
                                    }) =>
                                      handleSelectTaskInChat(
                                        workspacePath,
                                        sessionId,
                                        workspaceIdentity,
                                      )
                                    }
                                  />
                                </div>
                              </ScopedErrorBoundary>
                            </div>
                          </AutomationsMainBreadcrumbFrame>
                        </main>
                      ) : workspaceMainView === "plugin-store" ? (
                        <main className="flex h-full min-h-0 flex-1 flex-col bg-background">
                          <AutomationsMainBreadcrumbFrame
                            isDesktop={Boolean(isDesktop)}
                            sectionLabel={intl.formatMessage({
                              id: "workspace.openPluginsSettings",
                            })}
                            ariaLabel={intl.formatMessage({
                              id: "settings.breadcrumbLabel",
                            })}
                          >
                            <div className="min-h-0 flex-1 overflow-y-auto [scrollbar-gutter:stable]">
                              <div className="mx-auto flex w-full max-w-4xl flex-col px-4 py-4 md:px-6 md:py-6">
                                <PluginStorePage
                                  key={`plugin-store:${pluginStoreOpenVersion}`}
                                  workspacePath={workspaceAbsPath}
                                  workspaceIdentity={workspaceIdentity}
                                  onCreateTask={handleCreateTaskInChat}
                                  onManageInstalled={handleManageInstalledPlugins}
                                />
                              </div>
                            </div>
                          </AutomationsMainBreadcrumbFrame>
                        </main>
                      ) : (
                        <main className="relative flex h-full min-h-0 flex-1 flex-col overflow-hidden">
                          {renderChatFindDialog()}
                          <ScopedErrorBoundary
                            scope="workspace-chat"
                            resetKeys={workspaceDraftResetKeys}
                            variant="panel"
                            className="h-full"
                          >
                            {/* Pane binding must use the raw selection state activeTaskId,
                                  not the meta-derived activeSessionId — a session that v4
                                  createSession just created is not in the taskListCache/optimistic
                                  cache yet, and meta resolving to null would leave the pane stuck
                                  on draft forever. Under v4 semantics sessionId ≡ taskId; meta only
                                  serves Header display. The desktop main area is upgraded into a
                                  split-screen host (the Layout/Focus two layers); the primary pane
                                  binding semantics and the testid contract (paneId=workspace-main)
                                  are unchanged.
                                  */}
                            <V4WorkspaceChatArea
                              readOnly={Boolean(workspaceReadOnlyReason)}
                              foregroundEnabled={isWorkspaceVisible}
                              workspacePath={workspaceAbsPath}
                              workspaceIdentity={workspaceIdentity}
                              isDesktop={isDesktop === true}
                              remoteSessionId={workspaceRemoteSessionId}
                              sessionId={activeTaskId}
                              activeSelectionSideChatSessionId={activeSelectionSideChatSessionId}
                              provider={activeTaskProvider ?? undefined}
                              onSessionCreated={handleV4SessionCreated}
                              onSessionDeleted={handleV4SessionDeleted}
                              draftComposerHeader={draftComposerHeader}
                              onPrimaryDraftDropTargetControllerChange={
                                setDraftHeaderDropTargetController
                              }
                              gitSummary={gitState.summary}
                              gitDirtyFileCount={gitDirtyFileCount}
                              activeTaskChangeSummary={activeTaskChangeSummary}
                              gitWorktreeReviewSourceId={gitWorktreeReviewSourceId}
                              gitWorktreeChangeSummary={gitWorktreeChangeSummary}
                              summaryPanelVariantOverride={summaryPanelVariantOverride}
                              onSummaryPanelVariantOverrideChange={
                                onSummaryPanelVariantOverrideChange
                              }
                              onRefreshGit={handleRefreshGit}
                              onOpenGitReview={handleOpenGitReview}
                              onPaneActiveSessionChange={handlePaneActiveSessionChange}
                              onOpenBrowserUrl={handleOpenBrowserUrl}
                              onOpenAutomationsMain={handleOpenAutomations}
                              onOpenCodeViewer={handleOpenCodeViewer}
                              onAutoOpenAssistantPptx={
                                isDesktop ? handleAutoOpenAssistantPptx : undefined
                              }
                              onOpenBackgroundBash={handleOpenBackgroundBash}
                              onOpenSubagentSession={handleOpenSubagentSession}
                              onOpenSubagentDirectory={handleOpenSubagentDirectory}
                              onSyncSubagentSessionTabs={handleSyncSubagentSessionTabs}
                              onOpenSelectionSideChat={handleOpenSelectionSideChat}
                              onOpenPlanDetail={handleOpenPlanDetail}
                              onOpenWorkflowRun={handleOpenWorkflowRun}
                              onOpenWorkflowArtifact={handleOpenWorkflowArtifact}
                              onOpenWorkflowRunDirectory={handleOpenWorkflowRunDirectory}
                              onOpenWorkflowActorSession={handleOpenWorkflowActorSession}
                              onOpenWorkflowWorkspace={handleOpenWorkflowWorkspace}
                              onOpenFileLink={handleOpenMarkdownFileLink}
                              conversationFindQuery={conversationFindQuery}
                              conversationFindActiveIndex={conversationFindActiveIndex}
                              conversationFindNavigationRequestId={
                                conversationFindNavigationRequestId
                              }
                              onConversationFindMatchStateChange={
                                onConversationFindMatchStateChange
                              }
                              searchResultHighlightRequest={activeSearchResultHighlightRequest}
                              onSearchResultHighlightDone={onSearchResultHighlightDone}
                            />
                          </ScopedErrorBoundary>
                        </main>
                      )}
                    </div>
                  </section>
                </ResizablePanel>
                {workspaceMainView !== "automations" && workspaceMainView !== "plugin-store" ? (
                  <AnimatedTerminalPanel
                    frameClassName={cn(
                      isSidePaneVisible
                        ? "rounded-[var(--workspace-panel-radius)] border border-border"
                        : resolveWorkspaceShellWindowChromeClass({
                            isMacDesktop,
                            isWindowsDesktop,
                            isLinuxDesktop,
                            macOSMajorVersion: desktopWindowChromeState?.macOSMajorVersion,
                            isWindowsMaximized: desktopWindowChromeState?.isMaximized ?? false,
                            supportsNativeRoundedCorners:
                              desktopWindowChromeState?.supportsNativeRoundedCorners ?? null,
                          }),
                      "rounded-t-[var(--workspace-panel-radius)] border-t",
                    )}
                    services={services}
                    workspaceAbsPath={workspaceAbsPath}
                    workspaceIdentity={workspaceIdentity}
                    openWorkspaceKeys={openWorkspaceKeys}
                    isVisible={isTerminalVisible}
                    isWindowsDesktop={isWindowsDesktop}
                    panelRef={terminalPanelRef}
                    panelElementRef={terminalPanelElementRef}
                    onClose={() => setIsTerminalOpen(false)}
                    onOpenBrowserUrl={handleOpenBrowserUrl}
                  />
                ) : null}
              </ResizablePanelGroup>
            </ResizablePanel>
            {/*
                    The Browser Guest Host must stay decoupled from the main-view route, so that
                    switching automations/plugin does not unmount the guest; while a screenshot
                    request is in flight, an upper layer temporarily expands the real pane to host
                    the composable WebContents.
                    */}
            {sidePanePanel}
          </ResizablePanelGroup>
        </div>
        <ScopedErrorBoundary
          scope="desktop-top-overlay"
          resetKeys={workspaceSidebarVisibilityResetKeys}
          variant="silent"
        >
          <DesktopTopOverlay
            newTaskDisabledReason={workspaceReadOnlyReason}
            workspaceAbsPath={workspaceAbsPath}
            isMacDesktop={isMacDesktop}
            isMacFullscreen={isMacFullscreen}
            macWindowControlsLeftPaddingPx={macWindowControlsLeftPaddingPx}
            windowsWindowControlsRightPaddingPx={windowsWindowControlsRightPaddingPx}
            isWindowsDesktop={isWindowsDesktop}
            isDesktop={isDesktop}
            isSidebarVisible={isSidebarVisible}
            updateReadyVersion={updateReadyVersion}
            updateState={updateState}
            toggleSidebarShortcutLabel={toggleSidebarShortcutLabel}
            newTaskShortcutLabel={newTaskShortcutLabel}
            goBackShortcutLabel={goBackShortcutLabel}
            goForwardShortcutLabel={goForwardShortcutLabel}
            canTaskNavBack={canPrimaryNavigationBack}
            canTaskNavForward={canTaskNavForward}
            canGoBack={canGoBack}
            canGoForward={canGoForward}
            showNewTaskButton={showTopOverlayNewTaskButton}
            appLogoUrl={appLogoUrl}
            platform={platform}
            onToggleSidebar={handleToggleSidebar}
            onCreateTask={handleCreateTaskInChat}
            onGoBack={primaryNavigationBack}
            onGoForward={handleTaskNavForward}
          />
        </ScopedErrorBoundary>
      </div>
    </DesktopWindowFrame>
  );
});
