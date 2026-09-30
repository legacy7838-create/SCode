/* oxlint-disable eslint(max-lines) -- Platform events and share imports share the same lifecycle.
 */
import { useEffect, useRef, useState } from "react";
import { useZCodeSessionStore } from "@/store/zcodeSessionStore.js";
import type { IPlatformService } from "@zcode/shared";
import { isWorkspaceTab, type TabStoreState, type WindowTabState } from "@/store/tabStore.js";
import { useTabStore } from "@/store/TabStoreProvider.js";
import { logger } from "@/logger.js";
import { seedImportedSessionDraft } from "@/v4/composer/newTaskDraft.js";
import { dismissToast, toast, updateToast } from "@/components/ui/toast.js";
import { matchesPrimaryShortcut } from "@/lib/keyboardShortcuts.js";
import { isShortcutRecordingActive } from "@/shortcuts/bindings.js";
import { isRendererReloadNavigation } from "@/lib/rendererNavigation.js";
import { useOptionalBaseWorkspaceServices } from "@/hooks/useWorkspaceServices.js";
import { shouldPublishCompleteWorkspaceSnapshot } from "@/root/rootPlatformWorkspaceSync.js";
import {
  createShareImportIntent,
  isShareImportIntentSame,
  resolveShareImportFailurePresentation,
  type ShareImportIntent,
} from "@/root/shareImportIntent.js";

export function useRootPlatformEffects({
  initialWorkspaceAbsPath,
  initialWorkspaceIdentity,
  initialWorkspacePurpose,
  initialTaskId,
  canBootstrapInitialWorkspace = true,
  addTab,
  setIsBootstrappingInitialWorkspace,
  platform,
  activateTabByPath,
  startDraftInWorkspace,
  startNewTaskFromActiveWorkspace,
  openWorkspace,
  openWorkspacePath,
  setWorkspaceActionError,
  allowOpenWorkspace = true,
  isDesktop,
  locale,
  tabs,
  activeWorkspacePath,
  activeWorkspaceIdentity,
  reconnectingRemoteWorkspaceKeys = [],
  remoteWorkspaceErrorByWorkspaceKey = {},
  totalUnreadTaskCount,
  hasCompletedFullTabRestore = true,
  intl,
  isRestoringOAuthSession,
}: {
  initialWorkspaceAbsPath?: string;
  initialWorkspaceIdentity?: string;
  initialWorkspacePurpose?: import("@zcode/shared").WorkspacePurpose;
  initialTaskId?: string;
  canBootstrapInitialWorkspace?: boolean;
  addTab: (
    workspacePath: string,
    options?: {
      workspaceIdentity?: string;
      workspacePurpose?: import("@zcode/shared").WorkspacePurpose;
    },
  ) => void;
  setIsBootstrappingInitialWorkspace: (value: boolean) => void;
  platform: IPlatformService;
  activateTabByPath: (workspacePath: string, options?: { workspaceIdentity?: string }) => boolean;
  startDraftInWorkspace: (workspacePath: string, workspaceIdentity?: string) => void;
  startNewTaskFromActiveWorkspace: (source: string) => void;
  openWorkspace: () => void;
  openWorkspacePath: (workspacePath: string) => void;
  setWorkspaceActionError: (message: string | null) => void;
  allowOpenWorkspace?: boolean;
  isDesktop?: boolean;
  locale: ReturnType<typeof import("@/i18n/IntlProvider.js").useZCodeIntl>["locale"];
  tabs: WindowTabState[];
  activeWorkspacePath?: string | null;
  activeWorkspaceIdentity?: string | null;
  reconnectingRemoteWorkspaceKeys?: string[];
  remoteWorkspaceErrorByWorkspaceKey?: Record<string, string>;
  totalUnreadTaskCount: number;
  hasCompletedFullTabRestore?: boolean;
  intl: ReturnType<typeof import("@/i18n/IntlProvider.js").useZCodeIntl>["intl"];
  isRestoringOAuthSession: boolean;
}) {
  const didBootstrapInitialWorkspaceRef = useRef(false);
  const baseServices = useOptionalBaseWorkspaceServices();
  const pendingShareImportRef = useRef<ShareImportIntent | null>(null);
  const [shareImportRevision, setShareImportRevision] = useState(0);
  const activeShareImportRef = useRef<ShareImportIntent | null>(null);
  const importOperationRef = useRef<string | null>(null);
  const lastImportProgressToastRef = useRef<{ phase: string; at: number } | null>(null);
  const importToastIdRef = useRef<number | null>(null);

  useEffect(() => {
    // When starting, the OAuth local session must be determined first, and then the history/initial workspace can be restored.
    // If you addTab first here, users who are not logged in will see the main interface first and then be overwritten by the login page.
    if (!canBootstrapInitialWorkspace || didBootstrapInitialWorkspaceRef.current) {
      return;
    }

    didBootstrapInitialWorkspaceRef.current = true;
    if (initialWorkspaceAbsPath) {
      addTab(
        initialWorkspaceAbsPath,
        initialWorkspaceIdentity || initialWorkspacePurpose
          ? {
              ...(initialWorkspaceIdentity ? { workspaceIdentity: initialWorkspaceIdentity } : {}),
              ...(initialWorkspacePurpose ? { workspacePurpose: initialWorkspacePurpose } : {}),
            }
          : undefined,
      );
      if (initialTaskId) {
        useZCodeSessionStore
          .getState()
          .setActiveTaskId(initialWorkspaceAbsPath, initialTaskId, initialWorkspaceIdentity);
      } else if (!isRendererReloadNavigation()) {
        // main injects initial workspace only to express the workspace entry; there is no explicit taskId
        // The app cold start must go into draft and cannot let renderer-local last-session/group/pane
        // Retrieve historical sessions; the same renderer reload retains the current session's continuation qualifications.
        startDraftInWorkspace(initialWorkspaceAbsPath, initialWorkspaceIdentity);
      }
    }
    // Dock's recent projects will be directly accessed to the workspace through initialWorkspaceAbsPath.
    // If we still wait for the first screen to be rendered once by pressing the default empty tab, the window will flash out and open the middle page of the workspace.
    // Then asynchronously add the target workspace, visually it is like "open the wrong page and then jump".
    // Here, the initial workspace injection is also included in the startup protection period, and the official content will be rendered after the first tab is ready.
    setIsBootstrappingInitialWorkspace(false);
  }, [
    addTab,
    canBootstrapInitialWorkspace,
    initialTaskId,
    initialWorkspaceAbsPath,
    initialWorkspaceIdentity,
    initialWorkspacePurpose,
    setIsBootstrappingInitialWorkspace,
    startDraftInWorkspace,
  ]);

  useEffect(() => {
    const disposeFocusTab = platform.onFocusTab((path: string) => {
      logger.info("[Root] onFocusTab:", path);
      if (activateTabByPath(path)) {
        // System workspace focus is workspace-only navigation; task notifications are otherwise
        // The explicit taskId path cannot implicitly restore the last selected session of this workspace here.
        startDraftInWorkspace(path);
      }
    });
    const disposeNewTab = platform.onNewTab(() => {
      logger.info("[Root] onNewTab");
      setWorkspaceActionError(null);
      // In the past, new tabs would open the middle page of the workspace, causing startup/shortcut keys to enter the middle page.
      // Now the semantics of new tags converge to the "open workspace" action, and Root determines the directory selection or default workspace.
      openWorkspace();
    });
    const disposeNewTask = platform.onNewTask(() => {
      startNewTaskFromActiveWorkspace("onNewTask");
    });
    const disposeOpenWorkspace = platform.onOpenWorkspace(() => {
      logger.info("[Root] onOpenWorkspace");
      openWorkspace();
    });
    const disposeOpenWorkspacePath = platform.onOpenWorkspacePath
      ? platform.onOpenWorkspacePath((path: string) => {
          if (!allowOpenWorkspace) {
            logger.info(
              "[Root] deep link folder open is not supported in this mode, ignoring the request",
            );
            return;
          }

          logger.info("[Root] onOpenWorkspacePath:", path);
          // The system service deep link corresponds to the Open folder semantics above the input box.
          // Here, handleSelectProject is reused instead of using the path as a chat attachment, so that tab deduplication and deduplication can be retained.
          // Cross-window activation and recentProjects update the existing behavior of manually opening these folders.
          openWorkspacePath(path);
        })
      : () => {};
    const disposeShareImport = platform.onShareImport
      ? platform.onShareImport((payload) => {
          const current = pendingShareImportRef.current ?? activeShareImportRef.current;
          if (current && isShareImportIntentSame(current, payload)) {
            logger.info("[Root] ignoring a duplicate share import deep link", {
              shareCodeLength: payload.shareCode.length,
            });
            return;
          }
          const activeTab = tabs.find(
            (tab): tab is Extract<WindowTabState, { kind: "workspace" }> =>
              tab.kind === "workspace" &&
              tab.workspacePath === activeWorkspacePath &&
              (activeWorkspaceIdentity
                ? tab.workspaceIdentity === activeWorkspaceIdentity
                : !tab.workspaceIdentity),
          );
          pendingShareImportRef.current = createShareImportIntent(payload.shareCode, undefined, {
            ...(activeWorkspacePath ? { targetWorkspacePath: activeWorkspacePath } : {}),
            ...(activeWorkspaceIdentity
              ? { targetWorkspaceIdentity: activeWorkspaceIdentity }
              : {}),
            targetWorkspaceKind:
              activeTab?.remoteSessionId || activeTab?.remoteTarget ? "remote" : "local",
          });
          setShareImportRevision((revision) => revision + 1);
          logger.info("[Root] received a share import deep link", {
            shareCodeLength: payload.shareCode.length,
          });
        })
      : () => {};
    const disposeNotificationClick = platform.onTaskNotificationClick((taskId: string) => {
      logger.info("[Root] onTaskNotificationClick:", taskId);
      // Traverse all workspaces to find the workspace to which taskId belongs, then activate the corresponding tab and switch tasks
      const workspaces = useZCodeSessionStore.getState().workspaces;
      for (const [workspacePath, workspaceState] of Object.entries(workspaces)) {
        const taskMeta = workspaceState.taskListCache?.find((task) => task.taskId === taskId);
        const hasTask = workspaceState.activeTaskId === taskId || Boolean(taskMeta);
        if (hasTask) {
          const targetWorkspacePath = taskMeta?.workspacePath ?? workspacePath;
          const targetWorkspaceIdentity = taskMeta?.workspaceIdentity;
          // Clicking on the notification will check the task from the global workspace store.
          // Remote tasks must be activated and selected using the workspaceIdentity that comes with task meta, otherwise they will fall into the path-only bucket.
          activateTabByPath(
            targetWorkspacePath,
            targetWorkspaceIdentity ? { workspaceIdentity: targetWorkspaceIdentity } : undefined,
          );
          useZCodeSessionStore
            .getState()
            .setActiveTaskId(targetWorkspacePath, taskId, targetWorkspaceIdentity);
          return;
        }
      }
      logger.warn("[Root] onTaskNotificationClick: task not found in any workspace:", taskId);
    });
    const disposeUpdateCheckResult = platform.onUpdateCheckResult
      ? platform.onUpdateCheckResult((payload) => {
          logger.info("[Root] onUpdateCheckResult:", payload.kind);
          switch (payload.kind) {
            case "up-to-date":
              toast(
                intl.formatMessage(
                  { id: "update.toast.upToDate" },
                  { version: payload.currentVersion },
                ),
              );
              return;
            case "downloading":
              toast(
                intl.formatMessage(
                  { id: "update.toast.downloading" },
                  { version: payload.version },
                ),
              );
              return;
            case "available":
              toast(
                intl.formatMessage({ id: "update.toast.available" }, { version: payload.version }),
              );
              return;
            case "already-downloading":
              toast(
                intl.formatMessage(
                  { id: "update.toast.alreadyDownloading" },
                  { progress: payload.progress },
                ),
              );
              return;
            case "ready":
              toast(intl.formatMessage({ id: "update.toast.ready" }, { version: payload.version }));
              return;
            case "dev-skipped":
              toast(intl.formatMessage({ id: "update.toast.devSkipped" }));
              return;
            case "error":
              toast(intl.formatMessage({ id: "update.toast.error" }, { error: payload.message }));
              return;
          }
        })
      : () => {};
    return () => {
      disposeFocusTab();
      disposeNewTab();
      disposeNewTask();
      disposeOpenWorkspace();
      disposeOpenWorkspacePath();
      disposeShareImport();
      disposeNotificationClick();
      disposeUpdateCheckResult();
    };
  }, [activeWorkspaceIdentity, activeWorkspacePath, platform, tabs]);

  useEffect(() => {
    const pending = pendingShareImportRef.current;
    if (!pending || !baseServices || activeShareImportRef.current || importOperationRef.current) {
      return;
    }
    if (isRestoringOAuthSession) {
      return;
    }

    // The shared page Deep Link should not fork according to the logged-in state at the Root layer; both unlogged and logged-in
    // Follow the same continuation/import process. Whether publicly importable sharing is available is determined by the interface itself.
    pending.status = "importing";
    pendingShareImportRef.current = null;
    activeShareImportRef.current = pending;
    if (importToastIdRef.current !== null) {
      dismissToast(importToastIdRef.current);
      importToastIdRef.current = null;
    }
    const operationId = `share-import-${globalThis.crypto?.randomUUID?.() ?? Date.now()}`;
    importOperationRef.current = operationId;
    lastImportProgressToastRef.current = null;
    const progressEvent =
      baseServices.conversationShareService.onDynamicImportProgress(operationId);
    const disposeProgress = progressEvent((progress) => {
      const now = Date.now();
      const last = lastImportProgressToastRef.current;
      if (
        last &&
        last.phase === progress.phase &&
        now - last.at < 800 &&
        progress.phase !== "complete"
      ) {
        return;
      }
      // complete only means that the import transaction has been closed; the successful result will uniformly replace the progress prompt below to avoid a brief flash.
      // "Import Completed" is followed by two successful Toasts "Imported from Sharing".
      if (progress.phase === "complete") {
        return;
      }
      lastImportProgressToastRef.current = { phase: progress.phase, at: now };
      const label =
        progress.phase === "downloading"
          ? intl.formatMessage(
              { id: "conversationShare.import.downloading" },
              { completed: progress.completedArtifacts, total: progress.totalArtifacts },
            )
          : progress.phase === "installing"
            ? intl.formatMessage({ id: "conversationShare.import.installing" })
            : intl.formatMessage({ id: "conversationShare.import.committing" });
      if (importToastIdRef.current === null) {
        importToastIdRef.current = toast(label, { durationMs: 0, variant: "info" });
      } else {
        updateToast(importToastIdRef.current, {
          message: label,
          durationMs: 0,
          variant: "info",
          actionLabel: undefined,
          onAction: undefined,
          dismissible: false,
        });
      }
    });

    void baseServices.conversationShareService
      .importShare(
        {
          shareCode: pending.shareCode,
          clientRequestId: pending.clientRequestId,
          ...(pending.targetWorkspacePath
            ? { targetWorkspacePath: pending.targetWorkspacePath }
            : {}),
          ...(pending.targetWorkspaceIdentity
            ? { targetWorkspaceIdentity: pending.targetWorkspaceIdentity }
            : {}),
          ...(pending.targetWorkspaceKind
            ? { targetWorkspaceKind: pending.targetWorkspaceKind }
            : {}),
          locale,
        },
        operationId,
      )
      .then((result) => {
        pending.status = "complete";
        // Prepare an independent draft of the actual workspace before activating it; reuse and import will not overwrite session selections.
        seedImportedSessionDraft(result);
        const activated = activateTabByPath(
          result.workspacePath,
          result.workspaceIdentity ? { workspaceIdentity: result.workspaceIdentity } : undefined,
        );
        if (!activated) {
          addTab(result.workspacePath, {
            ...(result.workspaceIdentity ? { workspaceIdentity: result.workspaceIdentity } : {}),
            workspacePurpose: "conversation",
          });
        }
        const sessionStore = useZCodeSessionStore.getState();
        sessionStore.setActiveTaskId(
          result.workspacePath,
          result.sessionId,
          result.workspaceIdentity,
        );
        // Imports may reuse currently open sessions; setActiveTaskId alone will not produce an observable switch.
        // A positioning request is explicitly issued on each success, and the target pane is ready to share the content before consuming it.
        sessionStore.requestTimelineBottom(
          result.workspacePath,
          result.sessionId,
          result.workspaceIdentity,
        );
        // The rolled-back import will fall into a different workspace than the one currently viewed by the user. It must be explained clearly where it falls and why it was rolled back.
        // Otherwise the user will just see the session "went somewhere else".
        const resultMessage = result.fallbackReason
          ? intl.formatMessage(
              {
                id:
                  result.fallbackReason === "remote_workspace"
                    ? "conversationShare.import.fallbackRemoteWorkspace"
                    : "conversationShare.import.fallbackDefaultWorkspace",
              },
              { title: result.title, workspacePath: result.workspacePath },
            )
          : intl.formatMessage({ id: "conversationShare.import.source" }, { title: result.title });
        const resultToastOptions = {
          durationMs: result.fallbackReason ? 7000 : 3000,
          variant: result.fallbackReason ? ("info" as const) : ("default" as const),
          actionLabel: undefined,
          onAction: undefined,
          dismissible: false,
        };
        if (importToastIdRef.current === null) {
          importToastIdRef.current = toast(resultMessage, resultToastOptions);
        } else {
          updateToast(importToastIdRef.current, { message: resultMessage, ...resultToastOptions });
        }
      })
      .catch((error) => {
        pending.status = "failed";
        const record = error && typeof error === "object" ? (error as Record<string, unknown>) : {};
        const kind = typeof record.kind === "string" ? record.kind : "unknown";
        const reasonCode = typeof record.reasonCode === "string" ? record.reasonCode : undefined;
        const firstIssue = Array.isArray(record.issues) ? record.issues[0] : undefined;
        const firstIssueRecord =
          firstIssue && typeof firstIssue === "object" && !Array.isArray(firstIssue)
            ? (firstIssue as Record<string, unknown>)
            : undefined;
        const artifactDisplayName =
          typeof firstIssueRecord?.artifactDisplayName === "string"
            ? firstIssueRecord.artifactDisplayName
            : undefined;
        logger.warn("[Root] share import failed", {
          operationId,
          clientRequestId: pending.clientRequestId,
          kind,
          ...(reasonCode ? { reasonCode } : {}),
          ...(typeof record.issueCount === "number" ? { issueCount: record.issueCount } : {}),
        });
        const failurePresentation = resolveShareImportFailurePresentation(kind);
        const retryImport = () => {
          pending.status = "received";
          pendingShareImportRef.current = pending;
          setShareImportRevision((revision) => revision + 1);
        };
        const detailedMessageId =
          artifactDisplayName && kind === "invalid_contract"
            ? "conversationShare.import.integrityFailedWithArtifact"
            : artifactDisplayName && kind === "network"
              ? "conversationShare.import.failedWithArtifact"
              : failurePresentation.messageId;
        const failureMessage = intl.formatMessage(
          { id: detailedMessageId },
          artifactDisplayName ? { artifactDisplayName } : undefined,
        );
        const failureToastOptions = {
          durationMs: 7000,
          ...(failurePresentation.retryable
            ? {
                actionLabel: intl.formatMessage({ id: "conversationShare.import.retry" }),
                onAction: retryImport,
              }
            : {}),
          dismissible: true,
          variant: "default" as const,
        };
        if (importToastIdRef.current === null) {
          importToastIdRef.current = toast(failureMessage, failureToastOptions);
        } else {
          updateToast(importToastIdRef.current, {
            message: failureMessage,
            ...failureToastOptions,
          });
        }
      })
      .finally(() => {
        disposeProgress.dispose();
        activeShareImportRef.current = null;
        importOperationRef.current = null;
        setShareImportRevision((revision) => revision + 1);
      });
  }, [
    activateTabByPath,
    addTab,
    baseServices,
    intl,
    isRestoringOAuthSession,
    locale,
    shareImportRevision,
  ]);

  useEffect(() => {
    if (!isDesktop || !shouldPublishCompleteWorkspaceSnapshot(hasCompletedFullTabRestore)) {
      return;
    }

    const paths = tabs
      .filter(isWorkspaceTab)
      // During startup, the remote workspace will now be restored with "disconnect placeholder tab" first.
      // These tabs do not have a remoteSessionId, but they are still essentially remote sessions and cannot be synchronized to the main process window list as local paths.
      // Here it is changed to filter by the complete remote identity field to avoid mistakenly synchronizing the remote path to the local window label.
      .filter((tab) => !tab.remoteSessionId && !tab.workspaceIdentity && !tab.remoteTarget)
      .map((tab) => tab.workspacePath);
    platform.syncWindowTabs(paths);
  }, [hasCompletedFullTabRestore, isDesktop, platform, tabs]);

  useEffect(() => {
    if (isDesktop) {
      return;
    }

    function handleWindowKeydown(event: KeyboardEvent) {
      // The recording keyboard is exclusive to the recorder. This monitor is registered before the recording monitor (same as the capture stage).
      // If there is no short circuit, pressing Cmd/Ctrl+N, O during recording to preview will actually trigger a new task/open workspace.
      if (isShortcutRecordingActive()) {
        return;
      }
      const isNewTaskShortcut = matchesPrimaryShortcut(event, "n");
      const isOpenWorkspaceShortcut = matchesPrimaryShortcut(event, "o");

      if (!isNewTaskShortcut && !isOpenWorkspaceShortcut) {
        return;
      }

      // There is no host menu on the web side. Add a layer of best-effort keyboard monitoring and press the main modifier key of the platform to fall to the same set of root-level actions.
      // Coupling description: The default key positions (Ctrl/Cmd+N, +O) are fixed here, and "menu channel commands are not configurable on the Web side"
      // (The settings page will be grayed out) Supporting - If the menu channel change button on the Web side is released in the future,
      // The shortcut key validity table must be read here, otherwise the web behavior will be split after the user changes the key.
      event.preventDefault();
      if (isOpenWorkspaceShortcut) {
        openWorkspace();
        return;
      }

      startNewTaskFromActiveWorkspace("web CmdOrCtrl+N");
    }

    window.addEventListener("keydown", handleWindowKeydown, true);
    return () => {
      window.removeEventListener("keydown", handleWindowKeydown, true);
    };
  }, [isDesktop, openWorkspace, startNewTaskFromActiveWorkspace]);

  useEffect(() => {
    if (!isDesktop) {
      return;
    }

    // The application now only retains English, and the native menu copy is fixed in English in the main process.
    // It is no longer necessary to synchronize the locale of the renderer to rebuild the menu.
  }, [isDesktop]);

  useEffect(() => {
    // The first phase of Dock badge only counts the number of tasks that "have not been opened after the background is completed".
    // The failure red dot and permission tag remain in their respective UI semantics to avoid confusing the platform logo with generalized alarm numbers.
    platform.syncWindowUnreadCount(totalUnreadTaskCount);
  }, [platform, totalUnreadTaskCount]);

  const activeTabId = useTabStore((state: TabStoreState) => state.activeTabId);
  const activeTabCandidate = useTabStore((state: TabStoreState) =>
    state.tabs.find((tab: WindowTabState) => tab.id === state.activeTabId),
  );
  const activeTab =
    activeTabCandidate && isWorkspaceTab(activeTabCandidate) ? activeTabCandidate : undefined;
  const lastSyncedSessionIdRef = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    if (!isDesktop) return;
    const workspacePath = activeTab?.workspacePath;
    const workspaceIdentity = activeTab?.workspaceIdentity;
    const syncActiveSession = (): void => {
      const nextSessionId = workspacePath
        ? (useZCodeSessionStore.getState().getWorkspaceState(workspacePath, workspaceIdentity)
            .activeTaskId ?? null)
        : null;
      if (nextSessionId === lastSyncedSessionIdRef.current) return;
      lastSyncedSessionIdRef.current = nextSessionId;
      platform.syncActiveTaskSession(nextSessionId);
    };
    syncActiveSession();
    return useZCodeSessionStore.subscribe(syncActiveSession);
  }, [activeTab, activeTabId, isDesktop, platform]);
}
