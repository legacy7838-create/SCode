/* eslint-disable max-lines */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createUuid } from "@zcode/shared";
import type { EmbeddedBrowserOpenUrlRequest, IPlatformService } from "@zcode/shared";
import type { CodeViewerSource } from "@/lib/codeViewer.js";
// Keep alive: side pane terminal moved up to module level registry across workspace sessions.
// When closing the terminal tab, you must explicitly release and kill the PTY to avoid orphan processes caused by the resident registry.
import { sidePaneTerminalSessionRegistry } from "@/terminal/sidePaneTerminalSessionRegistry.js";
import {
  buildTaskSidePaneMemoryKey,
  getSidePaneCollapsedPreference,
  readTaskSidePaneMemoryState,
  saveTaskSidePaneCollapsedPreference,
  saveTaskSidePaneMemoryState,
} from "@/lib/taskSidePaneMemory.js";
import {
  closeSidePaneTab,
  closeSidePaneTabForParent,
  closeVisibleOtherSidePaneTabs,
  closeVisibleSidePaneTabs,
  closeGitSidePane,
  closeCodeViewerSidePane,
  openWhiteboardSidePane,
  openModelTrajectorySidePane,
  openTerminalSidePane,
  openSubagentSessionSidePane,
  openSubagentDirectorySidePane,
  openSelectionSideChatPane,
  openPlanDetailSidePane,
  openWorkflowRunSidePane,
  replaceWorkflowRunSidePane,
  openWorkflowRunDirectorySidePane,
  openWorkflowActorSessionSidePane,
  openWorkflowWorkspaceSidePane,
  openWorkflowArtifactSidePane,
  activateDeveloperToolsSidePane,
  activateGitHubReposSidePane,
  openBrowserSidePane,
  openOrActivateBrowserSidePaneByUrl,
  findBrowserSidePaneTabByUrl,
  applyBrowserUseSidePaneEvent,
  applyBrowserUseSidePaneVisibilityEvent,
  applyBrowserTabResidencyEvent,
  BROWSER_USE_OPERATION_INDICATOR_DURATION_MS,
  openCodeViewerSidePane,
  openCodeViewerSidePanes,
  activateGitSidePane,
  getActiveSidePaneTab,
  getVisibleSidePaneTabs,
  sidePaneOwnerKey,
  markBrowserUseSidePaneTabOperation,
  reorderSidePaneTab,
  resolveSidePaneScopeState,
  restoreSidePaneTab,
  setActiveSidePaneTab,
  syncSubagentSessionSidePaneTabs,
  toggleBrowserSidePane,
  toggleGitSidePane,
  updateBrowserSidePaneTab,
  stampSidePaneTabsOwnership,
  type BrowserSidePaneMetadata,
  type TreemappingSidePaneTab,
  type OpenScopedSubagentSideTabRequest,
  type OpenBackgroundBashSideTabRequest,
  openBackgroundBashSidePane,
  type OpenScopedSubagentDirectorySideTabRequest,
  type OpenSelectionSideChatRequest,
  type OpenScopedPlanDetailSideTabRequest,
  type OpenScopedWorkflowRunSideTabRequest,
  type OpenScopedWorkflowRunDirectorySideTabRequest,
  type OpenScopedWorkflowActorSessionSideTabRequest,
  type OpenScopedWorkflowArtifactSideTabRequest,
  type OpenScopedWorkflowWorkspaceSideTabRequest,
  type WorkspaceSidePaneState,
  type WorkspaceSidePaneTab,
} from "@/lib/workspaceSidePane.js";
import { isSidePaneTabVisibleForParent } from "@/lib/workspaceSidePane.js";
import { logger } from "@/logger.js";
import { getPathLeaf, joinFilePath, toFileUrl } from "@/lib/path.js";
import { shouldOpenWorkflowArtifactInBrowser } from "@/lib/workflowArtifactOpen.js";
import { useWhiteboardStore } from "@/store/whiteboardStore.js";
import { useModelTrajectoryOpenBridge } from "@/hooks/useModelTrajectoryOpenBridge.js";
import { useGitHubReposOpenBridge } from "@/hooks/useGitHubReposOpenBridge.js";
import { useServices } from "@/hooks/useServices.js";
import { useIsOfficeMode } from "@/hooks/useInterfaceMode.js";
import { clearSelectionSideChat } from "@/lib/selectionSideChatRuntime.js";
import { clearConversationSelectionReferenceScope } from "@/lib/conversationSelectionReference.js";
import { subscribeTaskLifecycle } from "@/lib/taskLifecycleEvents.js";

export interface BrowserNavigationRequest {
  id: string;
  targetTabId: string;
  url: string;
}

function isAgentOpenedBrowserPopup(payload: EmbeddedBrowserOpenUrlRequest): boolean {
  // The owner of human webview uses unclaimed-iab; legacy-iab and iab:<uuid> are both Agents
  // Control context. sourceTabId can also avoid misjudgment of ordinary external links/terminal links as model popups.
  return Boolean(payload.sourceTabId && payload.browserId && payload.browserId !== "unclaimed-iab");
}

export interface RecentClosedSidePaneTab {
  tab: WorkspaceSidePaneTab;
  closedAt: number;
}

const RECENT_CLOSED_SIDE_PANE_TAB_LIMIT = 8;

function createTerminalSidePaneTitle(
  current: WorkspaceSidePaneState | null,
  workspaceAbsPath: string,
): string {
  const baseTitle = getPathLeaf(workspaceAbsPath) || "Terminal";
  const usedTitles = new Set(
    current?.tabs
      .filter((tab) => tab.type === "terminal")
      .map((tab) => tab.title.trim())
      .filter(Boolean) ?? [],
  );

  if (!usedTitles.has(baseTitle)) {
    return baseTitle;
  }

  for (let index = 2; ; index += 1) {
    const candidate = `${baseTitle} ${index}`;
    if (!usedTitles.has(candidate)) {
      return candidate;
    }
  }
}

export function useAppPanels(options: {
  workspaceAbsPath: string;
  workspaceIdentity?: string;
  workspaceRemoteSessionId?: string | null;
  activeTaskId: string | null;
  /** The draft state and the official task share a stable ID, which serves as the isolation boundary for the sidebar conversation. */
  sidePaneOwnerId: string | null;
  isDesktop?: boolean;
  /**
   * Presentation semantics: Whether the view is currently presented to the user (false when setting page overlay).
   * This hook deliberately does not consume it - the Browser View event is forwarded authoritatively on the main side, and the subscription cannot be affected by visibility.
   * For details, see the timing constraint notes for subscribing to the effect below.
   * The only reason to retain the input parameters is to return to the guardrail: the four use cases of useAppPanelsBrowserViewLifecycle are expressed by passing false
   * "Settings page override", these use cases will fail immediately as soon as someone writes the visibility back into the subscription condition. Delete the input parameters,
   * That layer of protection disappeared.
   */
  isWorkspaceVisible?: boolean;
  supportsEmbeddedBrowser?: boolean;
  defaultWhiteboardNamePrefix: string;
  platform?: Pick<
    IPlatformService,
    | "onOpenBrowserUrl"
    | "onBrowserViewReady"
    | "onBrowserViewOperation"
    | "onBrowserViewVisibility"
    | "onBrowserViewCloseTab"
    | "onBrowserViewSuspend"
    | "onBrowserViewRestore"
    | "browserViewCloseTab"
    | "browserViewEnsureResident"
  >;
}) {
  const {
    workspaceAbsPath,
    workspaceIdentity,
    workspaceRemoteSessionId,
    activeTaskId,
    sidePaneOwnerId,
    isDesktop,
    supportsEmbeddedBrowser: explicitSupportsEmbeddedBrowser,
    defaultWhiteboardNamePrefix,
    platform,
  } = options;
  const supportsEmbeddedBrowser = explicitSupportsEmbeddedBrowser ?? Boolean(isDesktop);
  const activeWorkspaceKey = workspaceIdentity?.trim() || workspaceAbsPath;
  const { zcodeAgentService, zcodeSessionService } = useServices();
  const isOfficeMode = useIsOfficeMode();
  const sidePaneMemoryKey = useMemo(
    () =>
      buildTaskSidePaneMemoryKey({
        workspacePath: workspaceAbsPath,
        workspaceIdentity,
        taskId: activeTaskId,
      }),
    [activeTaskId, workspaceAbsPath, workspaceIdentity],
  );
  const initialSidePaneMemoryState = readTaskSidePaneMemoryState(sidePaneMemoryKey);

  // Repair instructions: Previously, the terminal area was fixed at the bottom of <main>, and Terminal would be mounted directly as soon as the page was entered.
  // Not only does it occupy the height by default, it also creates a terminal session immediately. Change it here to an explicit switch, which is turned off by default.
  // The Terminal will only be rendered after the user actively clicks it, so that the problem of "terminal does not need to be opened by default" will not occur.
  const [isTerminalOpen, setIsTerminalOpen] = useState(false);
  // Fix instructions: The right sharing panel (browser/code-viewer) needs to be closed by default.
  // Otherwise, as soon as you enter the workspace, the main session space will be occupied first, which is contrary to the expectation of "expanding it only when the user actively views it".
  const [sidePaneState, setSidePaneState] = useState<WorkspaceSidePaneState | null>(
    initialSidePaneMemoryState.sidePaneState,
  );
  const [isSidePaneCollapsed, setIsSidePaneCollapsed] = useState(
    getSidePaneCollapsedPreference(initialSidePaneMemoryState, sidePaneOwnerId) ??
      initialSidePaneMemoryState.isSidePaneCollapsed,
  );
  // Interaction description: The sidebar show and hide button is placed outside the app, not inside the Sidebar.
  // In this way, even if the sidebar is hidden, the entrance will still remain in the upper left corner, and there will be no problem of "there is no room to expand after it is collapsed";
  // At the same time, the macOS traffic light safe area is unified here to avoid overlapping of buttons and system window controls.
  const [isSidebarVisible, setIsSidebarVisible] = useState(true);
  const [browserNavigationRequest, setBrowserNavigationRequest] =
    useState<BrowserNavigationRequest | null>(null);
  const [allRecentClosedSidePaneTabs, setAllRecentClosedSidePaneTabs] = useState<
    RecentClosedSidePaneTab[]
  >([]);
  const lastActiveSubagentTabByRootRef = useRef<Map<string, string>>(new Map());
  const sidePaneOwnerIdRef = useRef(sidePaneOwnerId);
  sidePaneOwnerIdRef.current = sidePaneOwnerId;
  const activeWorkspaceKeyRef = useRef(activeWorkspaceKey);
  activeWorkspaceKeyRef.current = activeWorkspaceKey;
  const activeTabByOwnerRef = useRef<Map<string, string>>(new Map());
  const activeSidePaneMemoryKeyRef = useRef<string | null>(sidePaneMemoryKey);
  const latestSidePaneMemoryRef = useRef({
    sidePaneState,
    isSidePaneCollapsed,
  });
  latestSidePaneMemoryRef.current = {
    sidePaneState,
    isSidePaneCollapsed,
  };

  const revealSidePaneForCurrentOwner = useCallback(() => {
    setIsSidePaneCollapsed(false);
    latestSidePaneMemoryRef.current = {
      ...latestSidePaneMemoryRef.current,
      isSidePaneCollapsed: false,
    };
    saveTaskSidePaneCollapsedPreference(
      activeSidePaneMemoryKeyRef.current,
      sidePaneOwnerIdRef.current,
      false,
    );
  }, []);

  const commitSidePaneState = useCallback(
    (updater: (current: WorkspaceSidePaneState | null) => WorkspaceSidePaneState | null) => {
      const next = updater(latestSidePaneMemoryRef.current.sidePaneState);
      // Normal sidebar interactions and BrowserView IPC can be reached next to each other within the same React batch.
      // If only the BrowserView updates the synchronized ref, the later arrival of the specific value will overwrite the uncommitted open, activate, or sort updates.
      // All sidebar writing entries submit canonical ref first to ensure that interactions and lifecycle are merged strictly in the order of reception.
      latestSidePaneMemoryRef.current = {
        ...latestSidePaneMemoryRef.current,
        sidePaneState: next,
      };
      setSidePaneState(next);
      return next;
    },
    [],
  );

  const commitOpenedSidePaneState = useCallback(
    (updater: (current: WorkspaceSidePaneState | null) => WorkspaceSidePaneState | null) => {
      commitSidePaneState((current) =>
        stampSidePaneTabsOwnership(updater(current), {
          ownerTaskId: sidePaneOwnerIdRef.current,
          workspaceKey: activeWorkspaceKeyRef.current,
          remoteSessionId: workspaceRemoteSessionId ?? null,
        }),
      );
    },
    [commitSidePaneState, workspaceRemoteSessionId],
  );

  useEffect(() => {
    const previousKey = activeSidePaneMemoryKeyRef.current;
    if (previousKey === sidePaneMemoryKey) {
      return;
    }

    // The side pane is originally the transient state within the workspace component, and switching across workspaces will be overwritten by new rendering.
    // Here, before the key is changed, the tabs/folded state of the old workspace is written into the memory, and then the new workspace is restored to avoid different workspace string states.
    // Switching tasks within the same workspace should not affect the side pane, so the key is no longer split according to the task dimension.
    saveTaskSidePaneMemoryState(previousKey, latestSidePaneMemoryRef.current);
    const restored = readTaskSidePaneMemoryState(sidePaneMemoryKey);
    activeSidePaneMemoryKeyRef.current = sidePaneMemoryKey;
    commitSidePaneState(() => restored.sidePaneState);
    setIsSidePaneCollapsed(
      getSidePaneCollapsedPreference(restored, sidePaneOwnerIdRef.current) ??
        restored.isSidePaneCollapsed,
    );
  }, [commitSidePaneState, sidePaneMemoryKey]);

  useEffect(() => {
    return () => {
      saveTaskSidePaneMemoryState(
        activeSidePaneMemoryKeyRef.current,
        latestSidePaneMemoryRef.current,
      );
    };
  }, []);

  const hasVisibleSidePaneTabs = useCallback(
    (next: WorkspaceSidePaneState | null) =>
      Boolean(
        next &&
        getVisibleSidePaneTabs(next.tabs, {
          workspaceKey: activeWorkspaceKey,
          ownerTaskId: sidePaneOwnerId,
        }).length,
      ),
    [activeWorkspaceKey, sidePaneOwnerId],
  );

  const syncSidePaneCollapsedWithTabs = useCallback(
    (next: WorkspaceSidePaneState | null) => {
      if (!hasVisibleSidePaneTabs(next)) {
        // The life cycle end cannot expand the panel because there are still other visible tabs, otherwise it will overwrite the user's current view.
        // The owner's active collapsing preference; empty panels are forced to be collapsed only when there is no visible content.
        setIsSidePaneCollapsed(true);
      }
    },
    [hasVisibleSidePaneTabs],
  );

  useEffect(() => {
    commitSidePaneState((current) => {
      const scopeKey = `${activeWorkspaceKey}::${sidePaneOwnerId ?? "__draft__"}`;
      const preferredTabId =
        activeTabByOwnerRef.current.get(scopeKey) ??
        (activeTaskId ? lastActiveSubagentTabByRootRef.current.get(activeTaskId) : undefined);
      const collapsedPreference = getSidePaneCollapsedPreference(
        readTaskSidePaneMemoryState(activeSidePaneMemoryKeyRef.current),
        sidePaneOwnerId,
      );
      const resolved = resolveSidePaneScopeState(
        current,
        { workspaceKey: activeWorkspaceKey, ownerTaskId: sidePaneOwnerId },
        preferredTabId,
        collapsedPreference,
      );
      setIsSidePaneCollapsed(resolved.isSidePaneCollapsed);
      logger.debug("[App] sync conversation side pane scope", {
        activeTabId: resolved.sidePaneState?.activeTabId ?? null,
        activeTaskId,
        isSidePaneCollapsed: resolved.isSidePaneCollapsed,
        ownerTaskId: sidePaneOwnerId,
        preferredTabId: preferredTabId ?? null,
        workspaceKey: activeWorkspaceKey,
      });
      return resolved.sidePaneState;
    });
  }, [activeTaskId, activeWorkspaceKey, commitSidePaneState, sidePaneOwnerId]);

  const handleOpenCodeViewer = useCallback(
    (source: CodeViewerSource) => {
      revealSidePaneForCurrentOwner();
      commitOpenedSidePaneState((current) => {
        const next = openCodeViewerSidePane(current, source, sidePaneOwnerIdRef.current);
        const activeTab = getActiveSidePaneTab(next);
        const activePath =
          activeTab?.type === "code-viewer" ? (activeTab.source.path ?? "none") : "none";
        logger.info(
          `[App] switch side pane mode=code-viewer workspace=${workspaceAbsPath} title=${source.title} path=${activePath} tabs=${next.tabs.length}`,
        );
        return next;
      });
    },
    [commitOpenedSidePaneState, revealSidePaneForCurrentOwner, workspaceAbsPath],
  );

  const handleOpenCodeViewers = useCallback(
    (sources: readonly CodeViewerSource[]) => {
      if (sources.length === 0) return;
      revealSidePaneForCurrentOwner();
      commitOpenedSidePaneState((current) => {
        const next = openCodeViewerSidePanes(current, sources, sidePaneOwnerIdRef.current, 0);
        logger.info(
          `[App] batch open side previews workspace=${workspaceAbsPath} sources=${sources.length} tabs=${next.tabs.length}`,
        );
        return next;
      });
    },
    [commitOpenedSidePaneState, revealSidePaneForCurrentOwner, workspaceAbsPath],
  );

  const handleOpenBrowserUrl = useCallback(
    (request: string | EmbeddedBrowserOpenUrlRequest) => {
      const payload: EmbeddedBrowserOpenUrlRequest =
        typeof request === "string" ? { url: request, disposition: "foreground-tab" } : request;
      const sourceWorkspaceKey = payload.workspaceKey ?? activeWorkspaceKeyRef.current;
      const sourceSessionId = payload.sessionId ?? sidePaneOwnerIdRef.current;
      const sourceRemoteSessionId =
        payload.remoteSessionId ?? workspaceRemoteSessionId ?? undefined;
      const isCurrentOwner =
        sourceWorkspaceKey === activeWorkspaceKeyRef.current &&
        (sourceRemoteSessionId ?? "") === (workspaceRemoteSessionId ?? "") &&
        sourceSessionId === sidePaneOwnerIdRef.current;
      if (!supportsEmbeddedBrowser) {
        // There is no built-in browser panel on the web side. Return to the new browser tab here to at least ensure that external links are accessible.
        window.open(payload.url, "_blank", "noopener,noreferrer");
        return;
      }

      // Interaction description: The message area is only responsible for throwing out the intention of "open this URL".
      // The real webview navigation, address verification and panel display are still handled uniformly on the side of the browser panel.
      const isShareUrl = /^https?:\/\/[^/]+\/(?:cn\/)?share\/[^/]+$/u.test(payload.url);
      const targetTabId = `browser:${createUuid()}`;
      // When the guest controlled by the Agent triggers a popup, the new page still belongs to the model operation link; it cannot be
      // Treat as a newly opened Browser tab by a human, inheriting the free size/zoom preference saved in setting.json.
      const agentOpened = isAgentOpenedBrowserPopup(payload);
      // The webview popup event originally only carried the URL, and the late conversation 1 event would be replaced by the current conversation 2
      // The owner takes over. Keep the source scope and only grab focus when the source is still the current owner.
      if (!isShareUrl && isCurrentOwner) {
        setBrowserNavigationRequest({
          id: createUuid(),
          targetTabId,
          url: payload.url,
        });
      }
      if (isCurrentOwner) revealSidePaneForCurrentOwner();
      logger.info(
        `[App] ${isCurrentOwner ? "switch" : "background mount"} side pane mode=browser workspace=${sourceWorkspaceKey} sessionId=${sourceSessionId} url=${payload.url}`,
      );
      commitOpenedSidePaneState((current) =>
        isShareUrl
          ? openOrActivateBrowserSidePaneByUrl(current, {
              initialUrl: payload.url,
              ownerTaskId: sourceSessionId,
              workspaceKey: sourceWorkspaceKey,
              ...(sourceRemoteSessionId ? { remoteSessionId: sourceRemoteSessionId } : {}),
            })
          : openBrowserSidePane(current, {
              tabId: targetTabId,
              initialUrl: payload.url,
              ownerTaskId: sourceSessionId,
              workspaceKey: sourceWorkspaceKey,
              // Both paths carry ownerTaskId, and stampSidePaneTabsOwnership will not add scope.
              // remoteSessionId must be frozen when created, otherwise the tab cannot be closed remotely.
              ...(sourceRemoteSessionId ? { remoteSessionId: sourceRemoteSessionId } : {}),
              activate: isCurrentOwner,
              agentOpened,
            }),
      );
    },
    [
      commitOpenedSidePaneState,
      revealSidePaneForCurrentOwner,
      supportsEmbeddedBrowser,
      workspaceAbsPath,
      workspaceRemoteSessionId,
    ],
  );

  const handleToggleBrowser = useCallback(() => {
    if (!supportsEmbeddedBrowser) {
      // Capability boundary: Web/mobile currently does not support Electron webview and does not create Browser side pane.
      logger.info(
        `[App] current shell has no embedded browser, ignoring toggle request workspace=${workspaceAbsPath}`,
      );
      return;
    }

    commitOpenedSidePaneState((current) => {
      const activeTab = getActiveSidePaneTab(current);
      const closingActiveBrowser =
        activeTab?.type === "browser" &&
        sidePaneOwnerKey(activeTab.ownerTaskId) === sidePaneOwnerKey(sidePaneOwnerIdRef.current);
      const next = toggleBrowserSidePane(
        current,
        sidePaneOwnerIdRef.current,
        workspaceRemoteSessionId,
      );
      if (closingActiveBrowser) {
        syncSidePaneCollapsedWithTabs(next);
      } else {
        revealSidePaneForCurrentOwner();
      }
      const nextActiveTab = getActiveSidePaneTab(next);
      logger.info(
        `[App] switch side pane mode=${nextActiveTab?.type ?? "none"} workspace=${workspaceAbsPath} tabs=${next?.tabs.length ?? 0}`,
      );
      return next;
    });
  }, [
    commitOpenedSidePaneState,
    revealSidePaneForCurrentOwner,
    supportsEmbeddedBrowser,
    syncSidePaneCollapsedWithTabs,
    workspaceAbsPath,
    workspaceRemoteSessionId,
  ]);

  const handleOpenBrowserTab = useCallback(() => {
    if (!supportsEmbeddedBrowser) {
      // Capability boundary: Web/mobile currently does not support Electron webview and does not create Browser side pane.
      logger.info(
        `[App] current shell has no embedded browser, ignoring create request workspace=${workspaceAbsPath}`,
      );
      return;
    }

    revealSidePaneForCurrentOwner();
    commitOpenedSidePaneState((current) => {
      const next = openBrowserSidePane(current);
      const activeTab = getActiveSidePaneTab(next);
      logger.info(
        `[App] open new side browser tab=${activeTab?.id ?? "none"} workspace=${workspaceAbsPath} tabs=${next.tabs.length}`,
      );
      return next;
    });
  }, [
    commitOpenedSidePaneState,
    revealSidePaneForCurrentOwner,
    supportsEmbeddedBrowser,
    workspaceAbsPath,
  ]);

  // The following set of Browser View events are authoritative forwarding on the main side.
  // Cannot use isWorkspaceVisible (= !isSettingsTabActive) as the subscription threshold. The settings page is an overlay, the app does not
  // Uninstall, but the flag will become false. After effect cleanup cancels the subscription, the event sent by main will directly go into the black hole: ready will be lost.
  // waitForGuest times out in 10 seconds and deletes tab closeTabDurably. When the user exits the settings page, he or she will see the sidebar is empty.
  // Visibility only expresses "whether to show it to users now" and cannot determine "whether to receive authoritative events"; whether to grab the focus is still determined by shouldReveal
  // The scope is determined by matching, so it no longer relies on isWorkspaceVisible.
  useEffect(() => {
    if (!supportsEmbeddedBrowser || !isDesktop || !platform?.onOpenBrowserUrl) {
      return;
    }

    return platform.onOpenBrowserUrl((request) => {
      // Target=_blank/window.open in webview turns out to be swallowed by the popup strategy.
      // Either let Electron create a BrowserWindow by default. The main process has intercepted and verified the URL,
      // The renderer only places controlled requests on the Browser tab on the right side of the currently visible workspace.
      logger.info(
        `[App] webview requested side browser tab open workspace=${workspaceAbsPath} url=${request.url} disposition=${request.disposition}`,
      );
      handleOpenBrowserUrl(request);
    });
  }, [handleOpenBrowserUrl, isDesktop, platform, supportsEmbeddedBrowser, workspaceAbsPath]);

  // The Browser Use event carries the workspace/session that was frozen when it was created. The late event is only mounted in the background and cannot grab the current conversation focus.
  const handleBrowserViewReady = useCallback(
    (
      payload: Parameters<NonNullable<IPlatformService["onBrowserViewReady"]>>[0] extends (
        value: infer Payload,
      ) => void
        ? Payload
        : never,
    ) => {
      if (!isDesktop) return;
      const activeScope = {
        workspaceKey: activeWorkspaceKeyRef.current,
        remoteSessionId: workspaceRemoteSessionId ?? undefined,
        ownerTaskId: sidePaneOwnerIdRef.current,
      };
      const result = applyBrowserUseSidePaneEvent(
        latestSidePaneMemoryRef.current.sidePaneState,
        payload,
        activeScope,
      );
      commitSidePaneState(() => result.state);
      if (result.shouldReveal) revealSidePaneForCurrentOwner();
      logger.info(
        `[App] ${result.shouldReveal ? "expand and activate" : "background mount"} browser-use tab workspace=${payload.workspaceKey} sessionId=${payload.sessionId} tabId=${payload.tabId}`,
      );
    },
    [commitSidePaneState, isDesktop, revealSidePaneForCurrentOwner, workspaceRemoteSessionId],
  );

  useEffect(() => {
    if (!isDesktop || !platform?.onBrowserViewReady) return;
    return platform.onBrowserViewReady(handleBrowserViewReady);
  }, [handleBrowserViewReady, isDesktop, platform]);

  useEffect(() => {
    if (!isDesktop || !platform?.onBrowserViewOperation) return;
    return platform.onBrowserViewOperation((payload) => {
      const operationUntil = Date.now() + BROWSER_USE_OPERATION_INDICATOR_DURATION_MS;
      commitSidePaneState((current) =>
        markBrowserUseSidePaneTabOperation(current, {
          ...payload,
          operationUntil,
        }),
      );
      // The browser command is of the same order of magnitude as the message flow, and the production environment must not contain info logs.
      logger.debug("[App] browser-use operation", {
        operationUntil,
        sessionId: payload.sessionId,
        tabId: payload.tabId,
        workspaceKey: payload.workspaceKey,
      });
    });
  }, [commitSidePaneState, isDesktop, platform]);

  useEffect(() => {
    if (!isDesktop || !platform?.onBrowserViewVisibility) return;
    return platform.onBrowserViewVisibility((payload) => {
      if (payload.visible && payload.tabId) {
        const result = applyBrowserUseSidePaneVisibilityEvent(
          latestSidePaneMemoryRef.current.sidePaneState,
          { ...payload, tabId: payload.tabId },
          {
            workspaceKey: activeWorkspaceKeyRef.current,
            remoteSessionId: workspaceRemoteSessionId ?? undefined,
            ownerTaskId: sidePaneOwnerIdRef.current,
          },
        );
        if (result.didMatch) {
          activeTabByOwnerRef.current.set(
            `${payload.workspaceKey}::${payload.sessionId}`,
            `browser-use:${payload.tabId}`,
          );
        } else {
          // Visibility is of the same order of magnitude as browser command. Ignore late events and only record development logs to avoid production brushing.
          logger.debug("[App] ignore browser-use visibility with no live shell", {
            sessionId: payload.sessionId,
            tabId: payload.tabId,
            workspaceKey: payload.workspaceKey,
          });
        }
        commitSidePaneState(() => result.state);
        if (result.shouldReveal) revealSidePaneForCurrentOwner();
        return;
      }

      const active = getActiveSidePaneTab(latestSidePaneMemoryRef.current.sidePaneState);
      if (
        active?.type === "browser-use" &&
        active.workspaceKey === payload.workspaceKey &&
        (active.remoteSessionId ?? "") === (payload.remoteSessionId ?? "") &&
        active.sessionId === payload.sessionId &&
        active.browserId === payload.browserId &&
        active.browserGeneration === payload.browserGeneration &&
        (payload.tabId === undefined || active.tabId === payload.tabId)
      ) {
        setIsSidePaneCollapsed(true);
      }
    });
  }, [
    commitSidePaneState,
    isDesktop,
    platform,
    revealSidePaneForCurrentOwner,
    workspaceRemoteSessionId,
  ]);

  useEffect(() => {
    if (!isDesktop || !platform?.onBrowserViewCloseTab) return;
    return platform.onBrowserViewCloseTab((payload) => {
      const findTargetId = (state: WorkspaceSidePaneState | null) =>
        state?.tabs.find(
          (tab) =>
            (tab.type === "browser-use" && tab.tabId === payload.tabId) ||
            (tab.type === "browser" && tab.id === payload.tabId),
        )?.id ?? null;

      // The side pane status is stored separately by workspace. If you only search for the target tab in the "currently active workspace", it will be missed.
      // When the Agent closes the tab, the user may have switched to another workspace, and the notification is silently discarded. The persistent state of the original workspace
      // This tab is still left - after switching back, its corresponding logical tab on the main side no longer exists, and it cannot be closed by clicking ×, becoming a ghost tab.
      // After the notification has the owner scope, it is routed to the memory of the corresponding workspace according to the workspaceKey and deleted directly.
      // Only use workspaceKey for routing and no longer filter by session: main has determined that the tab is closed, and the shell on the renderer side
      // No matter which task it belongs to, it should be converged; the tabId itself is globally unique and there is no chance of accidental deletion across workspaces.
      const targetWorkspaceKey = payload.workspaceKey;
      if (targetWorkspaceKey && targetWorkspaceKey !== activeSidePaneMemoryKeyRef.current) {
        const stored = readTaskSidePaneMemoryState(targetWorkspaceKey);
        const targetId = findTargetId(stored.sidePaneState);
        if (!targetId) return;
        const nextState = closeSidePaneTab(stored.sidePaneState, targetId);
        saveTaskSidePaneMemoryState(targetWorkspaceKey, {
          sidePaneState: nextState,
          isSidePaneCollapsed: nextState ? stored.isSidePaneCollapsed : true,
        });
        return;
      }

      let didClose = false;
      const next = commitSidePaneState((current) => {
        const targetId = findTargetId(current);
        if (!targetId) return current;
        didClose = true;
        return closeSidePaneTabForParent(current, targetId, sidePaneOwnerIdRef.current);
      });
      if (didClose) syncSidePaneCollapsedWithTabs(next);
    });
  }, [commitSidePaneState, isDesktop, platform, syncSidePaneCollapsedWithTabs]);

  useEffect(() => {
    if (!isDesktop || !platform?.onBrowserViewSuspend) return;
    return platform.onBrowserViewSuspend((payload) => {
      commitSidePaneState((current) => {
        const target = current?.tabs.find(
          (tab) =>
            ((tab.type === "browser-use" && tab.tabId === payload.tabId) ||
              (tab.type === "browser" && tab.id === payload.tabId)) &&
            tab.workspaceKey === payload.workspaceKey &&
            (tab.remoteSessionId ?? "") === (payload.remoteSessionId ?? "") &&
            (tab.type === "browser-use"
              ? tab.sessionId === payload.sessionId
              : (tab.ownerTaskId ?? "unscoped") === payload.sessionId),
        );
        if (!target) return current;
        return applyBrowserTabResidencyEvent(current, payload);
      });
    });
  }, [commitSidePaneState, isDesktop, platform]);

  useEffect(() => {
    if (!isDesktop || !platform?.onBrowserViewRestore) return;
    return platform.onBrowserViewRestore((payload) => {
      commitSidePaneState((current) => applyBrowserTabResidencyEvent(current, payload));
    });
  }, [commitSidePaneState, isDesktop, platform]);

  const handleToggleGit = useCallback(() => {
    commitOpenedSidePaneState((current) => {
      if (isOfficeMode && !current?.tabs.some((tab) => tab.type === "git")) return current;
      const closingActiveGit = getActiveSidePaneTab(current)?.type === "git";
      const next = toggleGitSidePane(current);
      if (closingActiveGit) {
        syncSidePaneCollapsedWithTabs(next);
      } else {
        revealSidePaneForCurrentOwner();
      }
      const activeTab = getActiveSidePaneTab(next);
      logger.info(
        `[App] switch side pane mode=${activeTab?.type ?? "none"} workspace=${workspaceAbsPath} tabs=${next?.tabs.length ?? 0}`,
      );
      return next;
    });
  }, [
    isOfficeMode,
    commitOpenedSidePaneState,
    revealSidePaneForCurrentOwner,
    syncSidePaneCollapsedWithTabs,
    workspaceAbsPath,
  ]);

  const handleOpenGit = useCallback(() => {
    commitOpenedSidePaneState((current) => {
      if (isOfficeMode && !current?.tabs.some((tab) => tab.type === "git")) return current;
      const next = activateGitSidePane(current);
      // File change search only requires "make sure the Git panel is open" and cannot reuse the toggle.
      // If you are already on the Git tab, toggle will turn it off, causing you to switch to the file change range and not see the content.
      revealSidePaneForCurrentOwner();
      logger.info(
        `[App] open side pane mode=git workspace=${workspaceAbsPath} tabs=${next.tabs.length}`,
      );
      return next;
    });
  }, [isOfficeMode, commitOpenedSidePaneState, revealSidePaneForCurrentOwner, workspaceAbsPath]);

  const handleOpenTreemapping = useCallback(
    (source?: TreemappingSidePaneTab["source"]) => {
      // Treemapping functionality currently needs to be hidden from the sidebar. Preserve callback shape for message link compatibility,
      // But side pane tabs are no longer created to avoid header or old entries bypassing menu hiding.
      logger.debug(
        `[App] treemapping sidebar entry hidden workspace=${workspaceAbsPath} source=${source?.kind ?? "current"}`,
      );
    },
    [workspaceAbsPath],
  );

  const handleOpenWhiteboard = useCallback(() => {
    const board = useWhiteboardStore.getState().createBoard({
      defaultNamePrefix: defaultWhiteboardNamePrefix,
      workspaceIdentity,
      workspacePath: workspaceAbsPath,
    });
    revealSidePaneForCurrentOwner();
    commitOpenedSidePaneState((current) => {
      const next = openWhiteboardSidePane(current, {
        boardId: board.id,
        title: board.name,
      });
      logger.info(
        `[App] open side pane mode=whiteboard workspace=${workspaceAbsPath} board=${board.id} tabs=${next.tabs.length}`,
      );
      return next;
    });
  }, [
    commitOpenedSidePaneState,
    defaultWhiteboardNamePrefix,
    revealSidePaneForCurrentOwner,
    workspaceAbsPath,
    workspaceIdentity,
  ]);

  const handleOpenDeveloperTools = useCallback(() => {
    revealSidePaneForCurrentOwner();
    commitOpenedSidePaneState((current) => {
      const next = activateDeveloperToolsSidePane(current);
      logger.info(
        `[App] open side pane mode=developer-tools workspace=${workspaceAbsPath} tabs=${next.tabs.length}`,
      );
      return next;
    });
  }, [commitOpenedSidePaneState, revealSidePaneForCurrentOwner, workspaceAbsPath]);

  const handleOpenGitHubRepos = useCallback(() => {
    revealSidePaneForCurrentOwner();
    commitOpenedSidePaneState((current) => {
      const next = activateGitHubReposSidePane(current);
      logger.info(
        `[App] open side pane mode=github-repos workspace=${workspaceAbsPath} tabs=${next.tabs.length}`,
      );
      return next;
    });
  }, [commitOpenedSidePaneState, revealSidePaneForCurrentOwner, workspaceAbsPath]);

  const handleOpenTerminalTab = useCallback(() => {
    if (isOfficeMode) return;
    revealSidePaneForCurrentOwner();
    commitOpenedSidePaneState((current) => {
      const title = createTerminalSidePaneTitle(current, workspaceAbsPath);
      const next = openTerminalSidePane(current, {
        title,
        cwd: workspaceAbsPath,
        remoteSessionId: workspaceRemoteSessionId,
      });
      logger.info(
        `[App] open new side terminal tab=${title} workspace=${workspaceAbsPath} tabs=${next.tabs.length}`,
      );
      return next;
    });
  }, [
    isOfficeMode,
    commitOpenedSidePaneState,
    revealSidePaneForCurrentOwner,
    workspaceAbsPath,
    workspaceRemoteSessionId,
  ]);

  const handleOpenModelTrajectory = useCallback(
    (params: { taskId: string; title?: string | null }) => {
      if (!params.taskId) {
        return;
      }
      revealSidePaneForCurrentOwner();
      commitOpenedSidePaneState((current) => {
        const next = openModelTrajectorySidePane(current, params);
        logger.info(
          `[App] open side pane mode=model-trajectory workspace=${workspaceAbsPath} taskId=${params.taskId} tabs=${next.tabs.length}`,
        );
        return next;
      });
    },
    [commitOpenedSidePaneState, revealSidePaneForCurrentOwner, workspaceAbsPath],
  );

  const handleOpenBackgroundBash = useCallback(
    (request: OpenBackgroundBashSideTabRequest) => {
      revealSidePaneForCurrentOwner();
      commitOpenedSidePaneState((current) => openBackgroundBashSidePane(current, request));
    },
    [commitOpenedSidePaneState, revealSidePaneForCurrentOwner],
  );

  const handleOpenSubagentSession = useCallback(
    (request: OpenScopedSubagentSideTabRequest) => {
      const workspaceKey = request.workspaceIdentity?.trim() || request.workspacePath;
      const rootSessionId = request.rootSessionId ?? request.parentSessionId;
      revealSidePaneForCurrentOwner();
      commitOpenedSidePaneState((current) => {
        const next = openSubagentSessionSidePane(current, {
          workspaceKey,
          workspacePath: request.workspacePath,
          ...(request.workspaceIdentity ? { workspaceIdentity: request.workspaceIdentity } : {}),
          ...(request.remoteSessionId ? { remoteSessionId: request.remoteSessionId } : {}),
          rootSessionId,
          parentSessionId: request.parentSessionId,
          childSessionId: request.childSessionId,
          subagentType: request.subagentType,
          title: request.title,
        });
        lastActiveSubagentTabByRootRef.current.set(rootSessionId, next.activeTabId);
        logger.debug(
          `[App] open subagent side tab parent=${request.parentSessionId} child=${request.childSessionId} workspace=${workspaceKey}`,
        );
        return next;
      });
    },
    [commitOpenedSidePaneState, revealSidePaneForCurrentOwner],
  );

  const handleOpenSubagentDirectory = useCallback(
    (request: OpenScopedSubagentDirectorySideTabRequest) => {
      const workspaceKey = request.workspaceIdentity?.trim() || request.workspacePath;
      const rootSessionId = request.rootSessionId ?? request.parentSessionId;
      revealSidePaneForCurrentOwner();
      commitOpenedSidePaneState((current) => {
        const next = openSubagentDirectorySidePane(current, {
          workspaceKey,
          workspacePath: request.workspacePath,
          ...(request.workspaceIdentity ? { workspaceIdentity: request.workspaceIdentity } : {}),
          ...(request.remoteSessionId ? { remoteSessionId: request.remoteSessionId } : {}),
          rootSessionId,
          parentSessionId: request.parentSessionId,
        });
        lastActiveSubagentTabByRootRef.current.set(rootSessionId, next.activeTabId);
        return next;
      });
    },
    [commitOpenedSidePaneState, revealSidePaneForCurrentOwner],
  );

  const handleSyncSubagentSessionTabs = useCallback(
    (request: import("@/lib/workspaceSidePane.js").SyncSubagentSessionTabsRequest) => {
      // The invalid tab of the branch edit/retry belongs to the projection cleanup and does not enter the "recently closed".
      commitSidePaneState((current) => syncSubagentSessionSidePaneTabs(current, request));
    },
    [commitSidePaneState],
  );

  const handleOpenSelectionSideChat = useCallback(
    (request: OpenSelectionSideChatRequest) => {
      const workspaceKey = request.workspaceIdentity?.trim() || request.workspacePath;
      revealSidePaneForCurrentOwner();
      commitOpenedSidePaneState((current) => {
        const staleTab = request.replacesChildSessionId
          ? current?.tabs.find(
              (tab) =>
                tab.type === "selection-side-chat" &&
                tab.workspaceKey === workspaceKey &&
                tab.parentSessionId === request.parentSessionId &&
                tab.childSessionId === request.replacesChildSessionId,
            )
          : undefined;
        const withoutStale = staleTab ? closeSidePaneTab(current, staleTab.id) : current;
        return openSelectionSideChatPane(withoutStale, {
          ...request,
          workspaceKey,
        });
      });
      logger.debug("[App] open selection side chat session", {
        childSessionId: request.childSessionId,
        parentSessionId: request.parentSessionId,
        workspaceKey,
      });
    },
    [commitOpenedSidePaneState, revealSidePaneForCurrentOwner],
  );

  const handleOpenPlanDetail = useCallback(
    (request: OpenScopedPlanDetailSideTabRequest) => {
      const workspaceKey = request.workspaceIdentity?.trim() || request.workspacePath;
      revealSidePaneForCurrentOwner();
      commitOpenedSidePaneState((current) =>
        openPlanDetailSidePane(current, {
          ...request,
          workspaceKey,
        }),
      );
      logger.debug("[App] open plan detail side tab", {
        parentSessionId: request.parentSessionId,
        toolCallId: request.toolCallId,
        workspaceKey,
      });
    },
    [commitOpenedSidePaneState, revealSidePaneForCurrentOwner],
  );

  const handleOpenWorkflowRun = useCallback(
    (request: OpenScopedWorkflowRunSideTabRequest) => {
      const workspaceKey = request.workspaceIdentity?.trim() || request.workspacePath;
      // The in-place replacement after "Configuration" is not a one-time opening: the collapsed sidebar remains collapsed.
      const replaceRunId = request.replaceRunId;
      if (replaceRunId === undefined) setIsSidePaneCollapsed(false);
      commitOpenedSidePaneState((current) =>
        replaceRunId === undefined
          ? openWorkflowRunSidePane(current, { ...request, workspaceKey })
          : replaceWorkflowRunSidePane(current, { ...request, workspaceKey, replaceRunId }),
      );
      logger.debug("[App] open workflow run detail side tab", {
        parentSessionId: request.parentSessionId,
        runId: request.runId,
        toolCallId: request.toolCallId,
        workspaceKey,
      });
    },
    [commitOpenedSidePaneState],
  );

  const handleOpenWorkflowRunDirectory = useCallback(
    (request: OpenScopedWorkflowRunDirectorySideTabRequest) => {
      const workspaceKey = request.workspaceIdentity?.trim() || request.workspacePath;
      setIsSidePaneCollapsed(false);
      commitOpenedSidePaneState((current) =>
        openWorkflowRunDirectorySidePane(current, {
          ...request,
          workspaceKey,
        }),
      );
      logger.debug("[App] open workflow run directory side tab", {
        parentSessionId: request.parentSessionId,
        workspaceKey,
      });
    },
    [commitOpenedSidePaneState],
  );

  const handleOpenWorkflowActorSession = useCallback(
    (request: OpenScopedWorkflowActorSessionSideTabRequest) => {
      const workspaceKey = request.workspaceIdentity?.trim() || request.workspacePath;
      setIsSidePaneCollapsed(false);
      commitOpenedSidePaneState((current) =>
        openWorkflowActorSessionSidePane(current, {
          ...request,
          workspaceKey,
        }),
      );
      logger.debug("[App] open workflow actor session side tab", {
        actorSessionId: request.actorSessionId,
        parentSessionId: request.parentSessionId,
        runId: request.runId,
        workspaceKey,
      });
    },
    [commitOpenedSidePaneState],
  );

  const handleOpenWorkflowWorkspace = useCallback(
    (request: OpenScopedWorkflowWorkspaceSideTabRequest) => {
      const workspaceKey = request.workspaceIdentity?.trim() || request.workspacePath;
      setIsSidePaneCollapsed(false);
      commitOpenedSidePaneState((current) =>
        openWorkflowWorkspaceSidePane(current, {
          ...request,
          workspaceKey,
        }),
      );
      logger.debug("[App] open workflow workspace side tab", {
        parentSessionId: request.parentSessionId,
        phaseId: request.phaseId,
        runId: request.runId,
        workspaceKey,
      });
    },
    [commitOpenedSidePaneState],
  );

  /**
   * Browser tab reused by URL (the starting point of HTML product development).
   *
   * There are three differences from `handleOpenBrowserUrl`:
   * ① Click the URL to claim instead of opening a new one every time; ② When hitting an existing tab, a navigation request is still sent - webview
   * Stop at the old byte, `initialUrl` has not changed, and the navigation will not run again when mounting.
   * (UnifiedBrowserView's `lastAppliedInitialUrlRef` is deduplicated by URL), v2 will never be displayed;
   * ③ Attribution is given by the caller, and **constantly activated** - this path is only triggered by the user clicking on the product, no
   * `isCurrentOwner` kind of background mounting situation (see the note at ownerTaskId below for details).
   */
  const openFileUrlInBrowserSidePane = useCallback(
    (params: { url: string; ownerTaskId: string; workspaceKey: string }) => {
      const state = latestSidePaneMemoryRef.current.sidePaneState;
      const existing = findBrowserSidePaneTabByUrl(state, {
        initialUrl: params.url,
        ownerTaskId: params.ownerTaskId,
        workspaceKey: params.workspaceKey,
      });
      const targetTabId = existing?.id ?? `browser:${createUuid()}`;
      setBrowserNavigationRequest({ id: createUuid(), targetTabId, url: params.url });
      // Like the product tab, it only sets the current folded state and does not drop the disk preference: the attribute is written as params.ownerTaskId.
      // And revealSidePaneForCurrentOwner will record false under the name of the **current** owner - the central one
      // The two are not the same person on the path.
      setIsSidePaneCollapsed(false);
      commitOpenedSidePaneState((current) =>
        openOrActivateBrowserSidePaneByUrl(current, {
          initialUrl: params.url,
          tabId: targetTabId,
          // Ownership is explicitly frozen and does not rely on stampSidePaneTabsOwnership to cover the current owner: the central product chip
          // First handleSelectTaskInChat and then handleOpenWorkflowArtifact, in the same synchronization block
          // sidePaneOwnerIdRef still stops at the previous session. browser tab visibility narrowed by ownerTaskId
          // (The default branch of getVisibleSidePaneTabsByScope). If you cover the wrong tab, it will no longer be visible after the switch is settled.
          // The product tab is not afraid of this move because it is narrowed by parentSessionId.
          ownerTaskId: params.ownerTaskId,
          workspaceKey: params.workspaceKey,
        }),
      );
      return targetTabId;
    },
    [commitOpenedSidePaneState],
  );

  /**
   * The **only** landing point for product clicks is: html. If you can open an embedded browser, open the page directly. Otherwise, open the product tab.
   *
   * The missing section is `sourcePath`: the run side panel has it (it has been closed through the journal), and the pill summary is deliberately not included.
   * (Status frame volume, see `workflowRunArtifactSummarySchema`). Check the journal here if you are absent.
   * If the query fails, the old CLI does not have this query, and the product has no source at all, all will be returned to the product tab - the click will never fail.
   */
  const handleOpenWorkflowArtifact = useCallback(
    (request: OpenScopedWorkflowArtifactSideTabRequest) => {
      const workspaceKey = request.workspaceIdentity?.trim() || request.workspacePath;
      const openArtifactTab = () => {
        setIsSidePaneCollapsed(false);
        commitOpenedSidePaneState((current) =>
          openWorkflowArtifactSidePane(current, {
            ...request,
            workspaceKey,
          }),
        );
        logger.debug("[App] open workflow artifact side tab", {
          artifactId: request.artifactId,
          parentSessionId: request.parentSessionId,
          runId: request.runId,
          workspaceKey,
        });
      };

      if (
        !shouldOpenWorkflowArtifactInBrowser({
          contentType: request.contentType,
          supportsEmbeddedBrowser,
          workspaceIdentity: request.workspaceIdentity,
          remoteSessionId: request.remoteSessionId,
        })
      ) {
        openArtifactTab();
        return;
      }

      const openInBrowser = (sourcePath: string) => {
        // The sourcePath relative to the workspace is spelled with workspacePath to get the real location of the machine; it is the same as the one on the product card.
        // "Open in browser" takes the same path (localSourcePath of WorkflowArtifactSidePane).
        const url = toFileUrl(joinFilePath(request.workspacePath, sourcePath));
        const tabId = openFileUrlInBrowserSidePane({
          url,
          ownerTaskId: request.parentSessionId,
          workspaceKey,
        });
        logger.debug("[App] html artifact opened directly in browser tab", {
          artifactId: request.artifactId,
          parentSessionId: request.parentSessionId,
          runId: request.runId,
          tabId,
          workspaceKey,
        });
      };

      const knownSourcePath = request.sourcePath?.trim();
      if (knownSourcePath) {
        openInBrowser(knownSourcePath);
        return;
      }

      void (async () => {
        try {
          // The criterion has been guaranteed to be a local workspace (without workspaceIdentity / remoteSessionId),
          // Only workspacePath is taken here.
          const result = await zcodeAgentService.conversationWorkflowRunArtifactsV4({
            workspacePath: request.workspacePath,
            sessionId: request.parentSessionId,
            runId: request.runId,
          });
          const sourcePath = result.artifacts
            .find((artifact) => artifact.id === request.artifactId)
            ?.sourcePath?.trim();
          if (!sourcePath) {
            logger.debug(
              "[App] html artifact has no workspace source path, falling back to artifact tab",
              {
                artifactId: request.artifactId,
                runId: request.runId,
              },
            );
            openArtifactTab();
            return;
          }
          openInBrowser(sourcePath);
        } catch (error) {
          logger.warn(
            "[App] failed to resolve artifact source path, falling back to artifact tab",
            {
              artifactId: request.artifactId,
              error: error instanceof Error ? error.message : String(error),
              runId: request.runId,
            },
          );
          openArtifactTab();
        }
      })();
    },
    [
      commitOpenedSidePaneState,
      openFileUrlInBrowserSidePane,
      supportsEmbeddedBrowser,
      zcodeAgentService,
    ],
  );

  const closeSelectionSideChatRuntime = useCallback(
    (tab: Extract<WorkspaceSidePaneTab, { type: "selection-side-chat" }>) => {
      clearSelectionSideChat(tab.childSessionId);
      clearConversationSelectionReferenceScope(tab.childSessionId, tab.workspaceKey);
      void zcodeSessionService
        .closeSession({
          workspacePath: tab.workspacePath,
          ...(tab.workspaceIdentity ? { workspaceIdentity: tab.workspaceIdentity } : {}),
          sessionId: tab.childSessionId,
        })
        .catch((error) => {
          if (String(error).includes("sessionNotFound")) return;
          logger.warn("[App] failed to close selection side chat runtime", {
            childSessionId: tab.childSessionId,
            error: error instanceof Error ? error.message : String(error),
          });
        });
    },
    [zcodeSessionService],
  );

  useEffect(() => {
    const workspaceKey = workspaceIdentity?.trim() || workspaceAbsPath;
    return subscribeTaskLifecycle((event) => {
      if (event.workspaceKey !== workspaceKey) return;
      clearConversationSelectionReferenceScope(event.taskId, event.workspaceKey);
      const closingTabs =
        latestSidePaneMemoryRef.current.sidePaneState?.tabs.filter(
          (tab): tab is Extract<WorkspaceSidePaneTab, { type: "selection-side-chat" }> =>
            tab.type === "selection-side-chat" && tab.parentSessionId === event.taskId,
        ) ?? [];
      if (closingTabs.length === 0) return;

      for (const tab of closingTabs) closeSelectionSideChatRuntime(tab);
      const closingIds = new Set(closingTabs.map((tab) => tab.id));
      commitSidePaneState((current) => {
        if (!current) return current;
        let next: WorkspaceSidePaneState | null = current;
        for (const tabId of closingIds) {
          next = closeSidePaneTabForParent(next, tabId, activeTaskId);
        }
        syncSidePaneCollapsedWithTabs(next);
        return next;
      });
      logger.info("[App] parent task ended, cleaning up selection side chat session", {
        event: event.type,
        parentSessionId: event.taskId,
        workspaceKey,
      });
    });
  }, [
    activeTaskId,
    closeSelectionSideChatRuntime,
    commitSidePaneState,
    syncSidePaneCollapsedWithTabs,
    workspaceAbsPath,
    workspaceIdentity,
  ]);

  // Subscribe to the "Open model call track" request: initiated through the singleton store deep in the menu, here press the workspaceKey to match and then consume.
  useModelTrajectoryOpenBridge(
    workspaceIdentity?.trim() || workspaceAbsPath,
    handleOpenModelTrajectory,
  );

  // 订阅打开 GitHub 仓库侧边栏请求：在 GitHub 活动卡片点击箭头按钮时触发，展开第 3 个 Toggle Panel 并聚焦至 Repositories Tab
  useGitHubReposOpenBridge(
    workspaceIdentity?.trim() || workspaceAbsPath,
    handleOpenGitHubRepos,
  );

  const handleToggleTerminal = useCallback(() => {
    setIsTerminalOpen((open) => {
      if (isOfficeMode && !open) return open;
      const nextOpen = !open;
      logger.info("[App] toggle bottom terminal panel", {
        open: nextOpen,
        workspace: workspaceAbsPath,
      });
      return nextOpen;
    });
  }, [isOfficeMode, workspaceAbsPath]);

  const handleToggleSidebar = useCallback(() => {
    setIsSidebarVisible((visible) => !visible);
  }, []);

  const handleToggleSidePaneCollapse = useCallback(() => {
    setIsSidePaneCollapsed((collapsed) => {
      const nextCollapsed = !collapsed;
      // Tabs are reused by workspace, but retracting the top is an explicit choice by the user for the current conversation;
      // Record owner preferences to avoid scope resolution being overwritten by automatic expansion of visible tabs after switching conversations.
      saveTaskSidePaneCollapsedPreference(
        activeSidePaneMemoryKeyRef.current,
        sidePaneOwnerIdRef.current,
        nextCollapsed,
      );
      latestSidePaneMemoryRef.current = {
        ...latestSidePaneMemoryRef.current,
        isSidePaneCollapsed: nextCollapsed,
      };
      logger.info(
        `[App] ${nextCollapsed ? "collapse" : "expand"} side pane workspace=${workspaceAbsPath} tabs=${sidePaneState?.tabs.length ?? 0}`,
      );
      return nextCollapsed;
    });
  }, [sidePaneState, workspaceAbsPath]);

  const handleCloseCodeViewer = useCallback(() => {
    logger.info(`[App] close side pane mode=code-viewer workspace=${workspaceAbsPath}`);
    commitSidePaneState((current) => {
      const next = closeCodeViewerSidePane(current);
      syncSidePaneCollapsedWithTabs(next);
      return next;
    });
  }, [commitSidePaneState, syncSidePaneCollapsedWithTabs, workspaceAbsPath]);

  const handleCloseGit = useCallback(() => {
    logger.info(`[App] close side pane mode=git workspace=${workspaceAbsPath}`);
    commitSidePaneState((current) => {
      const next = closeGitSidePane(current);
      syncSidePaneCollapsedWithTabs(next);
      return next;
    });
  }, [commitSidePaneState, syncSidePaneCollapsedWithTabs, workspaceAbsPath]);

  const handleActivateSidePaneTab = useCallback(
    (tabId: string) => {
      const tab = latestSidePaneMemoryRef.current.sidePaneState?.tabs.find(
        (candidate) => candidate.id === tabId,
      );
      if (
        (tab?.type === "browser" || tab?.type === "browser-use") &&
        tab.residency === "suspended"
      ) {
        const logicalTabId = tab.type === "browser-use" ? tab.tabId : tab.id;
        // The attach side of human tab uses `tab.remoteSessionId ?? workspaceRemoteSessionId` to completely freeze the owner.
        // The same source must be used here, otherwise the existing tabs that did not freeze the field when they were created will have scope mismatches and will never be restored when clicked.
        // The attach side of browser-use does not have this layer of protection, and adding it will cause reverse mismatch, so it is distinguished by type.
        const scopedRemoteSessionId =
          tab.type === "browser-use"
            ? tab.remoteSessionId
            : (tab.remoteSessionId ?? workspaceRemoteSessionId);
        void platform
          ?.browserViewEnsureResident?.({
            tabId: logicalTabId,
            workspaceKey: tab.workspaceKey ?? activeWorkspaceKeyRef.current,
            ...(scopedRemoteSessionId ? { remoteSessionId: scopedRemoteSessionId } : {}),
            sessionId: tab.type === "browser-use" ? tab.sessionId : (tab.ownerTaskId ?? "unscoped"),
          })
          .catch((error) => {
            logger.warn("[App] failed to activate suspended Browser tab", {
              error: error instanceof Error ? error.message : String(error),
              tabId: logicalTabId,
            });
          });
      }
      commitSidePaneState((current) => {
        const target = current?.tabs.find((candidate) => candidate.id === tabId);
        if (target?.type === "subagent-session" || target?.type === "subagent-directory") {
          lastActiveSubagentTabByRootRef.current.set(target.rootSessionId, target.id);
        }
        return setActiveSidePaneTab(current, tabId);
      });
    },
    [commitSidePaneState, platform, workspaceRemoteSessionId],
  );

  const handleReorderSidePaneTab = useCallback(
    (activeTabId: string, overTabId: string) => {
      commitSidePaneState((current) => reorderSidePaneTab(current, activeTabId, overTabId));
    },
    [commitSidePaneState],
  );

  const rememberClosedSidePaneTabs = useCallback((tabs: WorkspaceSidePaneTab[]) => {
    const restorableTabs = tabs.filter(
      (tab) => tab.type !== "selection-side-chat" && tab.type !== "browser-use",
    );
    if (restorableTabs.length === 0) {
      return;
    }

    const closedAt = Date.now();
    setAllRecentClosedSidePaneTabs((current) => {
      const closingIds = new Set(restorableTabs.map((tab) => tab.id));
      return [
        ...restorableTabs.map((tab) => ({ tab, closedAt })),
        ...current.filter((item) => !closingIds.has(item.tab.id)),
      ].slice(0, RECENT_CLOSED_SIDE_PANE_TAB_LIMIT);
    });
  }, []);

  const closeBrowserTabsWithAuthority = useCallback(
    async (tabs: readonly WorkspaceSidePaneTab[]): Promise<boolean> => {
      const browserTabs = tabs.filter(
        (tab) => tab.type === "browser" || tab.type === "browser-use",
      );
      if (browserTabs.length === 0) return true;
      if (!platform?.browserViewCloseTab) {
        // Desktop must be deleted by main first; logical tab/recovery snapshot cannot be deleted only when bridge is missing.
        // Otherwise, the closed tab will be resurrected after restarting. The web side does not have guest authority and maintains the original local shutdown semantics.
        if (isDesktop) {
          logger.warn("[App] missing main authority to close Browser tab");
          return false;
        }
        return true;
      }
      try {
        await Promise.all(
          browserTabs.map((tab) => {
            // Same source as attach side: human tab goes to workspaceRemoteSessionId, browser-use does not go all the way.
            // If the source is different, the scope will be mismatched → main will deny authorization → the UI shell will never be removed → the tab will not be closed.
            const scopedRemoteSessionId =
              tab.type === "browser-use"
                ? tab.remoteSessionId
                : (tab.remoteSessionId ?? workspaceRemoteSessionId);
            return platform.browserViewCloseTab!({
              tabId: tab.type === "browser-use" ? tab.tabId : tab.id,
              workspaceKey: tab.workspaceKey ?? activeWorkspaceKeyRef.current,
              ...(scopedRemoteSessionId ? { remoteSessionId: scopedRemoteSessionId } : {}),
              sessionId:
                tab.type === "browser-use" ? tab.sessionId : (tab.ownerTaskId ?? "unscoped"),
            });
          }),
        );
        return true;
      } catch (error) {
        logger.warn("[App] main authority failed to close Browser tab", {
          error: error instanceof Error ? error.message : String(error),
          tabIds: browserTabs.map((tab) => (tab.type === "browser-use" ? tab.tabId : tab.id)),
        });
        return false;
      }
    },
    [isDesktop, platform, workspaceRemoteSessionId],
  );

  const handleCloseSidePaneTab = useCallback(
    (tabId: string) => {
      const closingTab = sidePaneState?.tabs.find((tab) => tab.id === tabId);
      if (closingTab?.type === "selection-side-chat") {
        closeSelectionSideChatRuntime(closingTab);
      }
      void closeBrowserTabsWithAuthority(closingTab ? [closingTab] : []).then((authorized) => {
        if (!authorized) return;
        if (closingTab) rememberClosedSidePaneTabs([closingTab]);
        // Keep alive: Explicitly closing the terminal tab must actually recycle PTY/xterm (registry is resident and will not be automatically recycled with uninstallation).
        if (closingTab?.type === "terminal") {
          sidePaneTerminalSessionRegistry.release(tabId);
        }
        const next = commitSidePaneState((current) =>
          closeSidePaneTabForParent(
            current,
            tabId,
            activeTaskId,
            activeTaskId ? lastActiveSubagentTabByRootRef.current.get(activeTaskId) : null,
          ),
        );
        syncSidePaneCollapsedWithTabs(next);
        const activeTab = getActiveSidePaneTab(next);
        logger.info(
          `[App] close side pane tab=${tabId} mode=${activeTab?.type ?? "none"} workspace=${workspaceAbsPath} tabs=${next?.tabs.length ?? 0}`,
        );
      });
    },
    [
      activeTaskId,
      closeSelectionSideChatRuntime,
      closeBrowserTabsWithAuthority,
      commitSidePaneState,
      rememberClosedSidePaneTabs,
      sidePaneState?.tabs,
      syncSidePaneCollapsedWithTabs,
      workspaceAbsPath,
    ],
  );

  const handleCloseOtherSidePaneTabs = useCallback(
    (tabId: string) => {
      const visibleTabs =
        sidePaneState?.tabs.filter((tab) => isSidePaneTabVisibleForParent(tab, activeTaskId)) ?? [];
      const targetExists = visibleTabs.some((tab) => tab.id === tabId);
      const closingTabs = targetExists ? visibleTabs.filter((tab) => tab.id !== tabId) : [];
      void closeBrowserTabsWithAuthority(closingTabs).then((authorized) => {
        if (!authorized) return;
        for (const tab of closingTabs) {
          if (tab.type === "selection-side-chat") closeSelectionSideChatRuntime(tab);
        }
        // Keep alive: When closing other tabs in batches, recycle the resident PTY/xterm of the terminal tab.
        for (const tab of closingTabs) {
          if (tab.type === "terminal") {
            sidePaneTerminalSessionRegistry.release(tab.id);
          }
        }
        rememberClosedSidePaneTabs(closingTabs);
        commitSidePaneState((current) => {
          const next = closeVisibleOtherSidePaneTabs(current, tabId, activeTaskId);
          logger.info(
            `[App] close other side pane tabs except tab=${tabId} workspace=${workspaceAbsPath} tabs=${next?.tabs.length ?? 0}`,
          );
          return next;
        });
      });
    },
    [
      activeTaskId,
      closeSelectionSideChatRuntime,
      closeBrowserTabsWithAuthority,
      commitSidePaneState,
      rememberClosedSidePaneTabs,
      sidePaneState?.tabs,
      workspaceAbsPath,
    ],
  );

  const handleCloseAllSidePaneTabs = useCallback(() => {
    const visibleTabs =
      sidePaneState?.tabs.filter((tab) => isSidePaneTabVisibleForParent(tab, activeTaskId)) ?? [];
    void closeBrowserTabsWithAuthority(visibleTabs).then((authorized) => {
      if (!authorized) return;
      for (const tab of visibleTabs) {
        if (tab.type === "selection-side-chat") closeSelectionSideChatRuntime(tab);
      }
      // Keep alive: When all tabs are closed, the resident PTY/xterm of the terminal tab is recycled.
      for (const tab of visibleTabs) {
        if (tab.type === "terminal") {
          sidePaneTerminalSessionRegistry.release(tab.id);
        }
      }
      rememberClosedSidePaneTabs(visibleTabs);
      commitSidePaneState((current) => {
        logger.info(`[App] close all side pane tabs workspace=${workspaceAbsPath}`);
        const next = closeVisibleSidePaneTabs(current, activeTaskId);
        syncSidePaneCollapsedWithTabs(next);
        return next;
      });
    });
  }, [
    activeTaskId,
    closeSelectionSideChatRuntime,
    closeBrowserTabsWithAuthority,
    commitSidePaneState,
    rememberClosedSidePaneTabs,
    sidePaneState?.tabs,
    syncSidePaneCollapsedWithTabs,
    workspaceAbsPath,
  ]);

  const handleReopenClosedSidePaneTab = useCallback(
    (tabId: string) => {
      const item = allRecentClosedSidePaneTabs.find((entry) => entry.tab.id === tabId);
      if (!item || (isOfficeMode && (item.tab.type === "terminal" || item.tab.type === "git")))
        return;

      // Interaction description: When a tab in the recently closed list is clicked back to open, the right panel needs to be expanded simultaneously.
      // Otherwise, the tab state has been restored, but the user still sees the collapsed state, and will mistakenly think that the click does not take effect.
      revealSidePaneForCurrentOwner();
      commitSidePaneState((sidePaneCurrent) => {
        let restoredTab = item.tab;
        if (item.tab.type === "browser") {
          const {
            residency: _residency,
            residencyGeneration: _residencyGeneration,
            ...browserTab
          } = item.tab;
          restoredTab = { ...browserTab, id: `browser:${createUuid()}` };
        }
        const next = restoreSidePaneTab(sidePaneCurrent, restoredTab);
        if (restoredTab.type === "subagent-session" || restoredTab.type === "subagent-directory") {
          lastActiveSubagentTabByRootRef.current.set(restoredTab.rootSessionId, restoredTab.id);
        }
        return next;
      });
      setAllRecentClosedSidePaneTabs((current) =>
        current.filter((entry) => entry.tab.id !== tabId),
      );
      logger.info(
        `[App] reopen recently closed side pane tab=${tabId} workspace=${workspaceAbsPath}`,
      );
    },
    [
      isOfficeMode,
      allRecentClosedSidePaneTabs,
      commitSidePaneState,
      revealSidePaneForCurrentOwner,
      workspaceAbsPath,
    ],
  );

  const handleBrowserNavigationRequestHandled = useCallback((requestId: string) => {
    setBrowserNavigationRequest((current) => (current?.id === requestId ? null : current));
  }, []);

  const handleBrowserPageMetadataChange = useCallback(
    (tabId: string, metadata: BrowserSidePaneMetadata) => {
      // Interaction description: Browser's title/favicon comes from webview events and must be written back by tab id.
      // When multiple Browser tabs coexist, if only one copy of global metadata is stored, the page loaded later will overwrite other tab titles.
      commitSidePaneState((current) => updateBrowserSidePaneTab(current, tabId, metadata));
    },
    [commitSidePaneState],
  );

  const recentClosedSidePaneTabs = useMemo(
    () =>
      allRecentClosedSidePaneTabs.filter(
        (item) =>
          isSidePaneTabVisibleForParent(item.tab, activeTaskId) &&
          (!isOfficeMode || (item.tab.type !== "terminal" && item.tab.type !== "git")),
      ),
    [activeTaskId, allRecentClosedSidePaneTabs, isOfficeMode],
  );

  return {
    // Office mode only hides new entries; the filter panel state will make open terminals and reviews disappear when switching.
    isTerminalOpen,
    setIsTerminalOpen,
    sidePaneState,
    recentClosedSidePaneTabs,
    isSidePaneCollapsed,
    setIsSidePaneCollapsed,
    isSidebarVisible,
    browserNavigationRequest,
    setBrowserNavigationRequest,
    // callback
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
    handleOpenModelTrajectory,
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
  };
}
