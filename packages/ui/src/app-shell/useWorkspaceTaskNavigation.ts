/* eslint-disable max-lines -- workspace tasks, automations and the plugin marketplace share
 * browser-style history, and handling them in one place is what guarantees consistent forward/back
 * targets.
 */
import { useCallback } from "react";
import { useBaseWorkspaceServices } from "@/hooks/useWorkspaceServices.js";
import {
  canGoBack as navCanGoBack,
  canGoForward as navCanGoForward,
  isAutomationsNavEntry,
  isPluginStoreNavEntry,
  type AutomationsNavigationTab,
} from "@/lib/taskNavigationHistory.js";
import { shouldBlockTaskSelectionDuringModelRestart } from "@/lib/taskSwitchGuard.js";
import { logger } from "@/logger.js";
import { toast } from "@/components/ui/toast.js";
import { getVisibleTaskMetas, useZCodeSessionStore } from "@/store/zcodeSessionStore.js";
import { buildTaskEntityKey, buildTaskWorkspaceKey } from "@/lib/taskQueryCache.js";
import {
  markTaskQueryCacheScopesStale,
  reconcileTaskQueryCacheUnread,
  rollbackTaskQueryCacheUnread,
  setTaskQueryCacheUnreadOverlay,
  useTaskQueryCacheStore,
} from "@/store/taskQueryCacheStore.js";
import { taskNavigationTargetExists } from "@/lib/taskNavigationTarget.js";
import { getRemoteWorkspaceSession } from "@/store/remoteWorkspaceSessionStore.js";
import { useTabStoreApi } from "@/store/TabStoreProvider.js";
import { isWorkspaceTab } from "@/store/tabStore.js";
import { bumpTaskListMembershipVersion } from "@/v4/taskListMembershipVersion.js";

export interface AutomationsNavigationTarget {
  workspacePath: string;
  workspaceIdentity?: string;
  automationId?: string;
  automationTab?: AutomationsNavigationTab;
}

export function useWorkspaceTaskNavigation({
  intl,
  workspaceAbsPath,
  workspaceIdentity,
  activateTabByPath,
  onNavigateToTask,
  onNavigateToAutomations,
  onNavigateToPluginStore,
}: {
  intl: { formatMessage: (descriptor: { id: string }) => string };
  workspaceAbsPath: string;
  workspaceIdentity?: string;
  activateTabByPath: (workspacePath: string, options?: { workspaceIdentity?: string }) => boolean;
  onNavigateToTask?: () => void;
  onNavigateToAutomations?: (target: AutomationsNavigationTarget) => void;
  onNavigateToPluginStore?: (target: Omit<AutomationsNavigationTarget, "automationId">) => void;
}) {
  // Cross-workspace selection will switch tabs synchronously first, but the ambient captured by React render this time
  // Services may still belong to the old remote attachment. local target must be pinned from window base attachment
  // Initiated and then routed by the Host Controller, the local path cannot be sent into the old remote scope.
  const baseServices = useBaseWorkspaceServices();
  const tabStoreApi = useTabStoreApi();
  const setActiveTaskId = useZCodeSessionStore((s) => s.setActiveTaskId);
  const taskNavHistory = useZCodeSessionStore((s) => s.taskNavHistory);
  const taskNavPushAutomations = useZCodeSessionStore((s) => s.taskNavPushAutomations);
  const taskNavPushPluginStore = useZCodeSessionStore((s) => s.taskNavPushPluginStore);
  const taskNavGoBack = useZCodeSessionStore((s) => s.taskNavGoBack);
  const taskNavGoForward = useZCodeSessionStore((s) => s.taskNavGoForward);
  const removeTaskFromNavHistory = useZCodeSessionStore((s) => s.removeTaskFromNavHistory);

  const handleSelectTask = useCallback(
    (
      targetWorkspacePath: string,
      taskId: string,
      targetWorkspaceIdentityHint?: string,
      selectedRowUnreadAt?: number,
    ) => {
      const targetWorkspaceState = useZCodeSessionStore
        .getState()
        .getWorkspaceState(targetWorkspacePath, targetWorkspaceIdentityHint);
      if (
        shouldBlockTaskSelectionDuringModelRestart(
          targetWorkspaceState.modelSwitchPending,
          targetWorkspaceState.modelSwitchStage,
        )
      ) {
        // When model provider switching triggers runtime reconstruction, the task handle of the current provider-workspace will be temporarily recycled.
        // If you switch to another task at this time, resumeTask and the reconstruction process will be triggered concurrently, and it is easy to misjudge the switching failure as a task recovery failure.
        // Here, the task switching entrance is intercepted uniformly, and switching is allowed after the reconstruction is completed to prevent the UI from entering the false failure state of notReady/error.
        logger.info(
          `[App] model runtime rebuilding, ignoring task switch workspace=${targetWorkspacePath} taskId=${taskId} stage=${targetWorkspaceState.modelSwitchStage}`,
        );
        toast(intl.formatMessage({ id: "taskList.switchBlockedByModelRestart" }));
        return;
      }

      // Unread cleanup of remote workspace can no longer rely solely on workspacePath to check the session.
      // When there are multiple remote tabs with the same path in the same window, the path mapping will hit the old session.
      // As a result, "click to open this task" writes the read status to another remote connection.
      // Here, the target tab is first activated, and then the more accurate remoteSessionId is read from the currently activated tab.
      activateTabByPath(
        targetWorkspacePath,
        targetWorkspaceIdentityHint
          ? { workspaceIdentity: targetWorkspaceIdentityHint }
          : undefined,
      );
      const activeTab = tabStoreApi
        .getState()
        .tabs.find((tab) => tab.id === tabStoreApi.getState().activeTabId);
      const targetWorkspaceKey = buildTaskWorkspaceKey(
        targetWorkspacePath,
        targetWorkspaceIdentityHint,
      );
      const activeWorkspaceTabMatchesTarget = Boolean(
        activeTab &&
        isWorkspaceTab(activeTab) &&
        buildTaskWorkspaceKey(activeTab.workspacePath, activeTab.workspaceIdentity) ===
          targetWorkspaceKey,
      );
      const resolvedRemoteSessionId =
        activeTab && isWorkspaceTab(activeTab) && activeWorkspaceTabMatchesTarget
          ? activeTab.remoteSessionId
          : undefined;
      const targetWorkspaceIdentity =
        activeTab && isWorkspaceTab(activeTab) && activeWorkspaceTabMatchesTarget
          ? (activeTab.workspaceIdentity ?? targetWorkspaceIdentityHint)
          : targetWorkspaceIdentityHint;
      const targetTask = {
        taskId,
        workspacePath: targetWorkspacePath,
        ...(targetWorkspaceIdentity ? { workspaceIdentity: targetWorkspaceIdentity } : {}),
      };
      const taskEntityKey = buildTaskEntityKey(targetTask);
      const cachedTaskMeta = useTaskQueryCacheStore.getState().taskMetaByEntityKey[taskEntityKey];
      const previousUnreadAt = cachedTaskMeta?.unreadAt;
      // The "Task" timeline provides row data directly from the Window Controller, unlike the project list.
      // Write the tasks created in the background into the query cache. If you click on the transaction and only check the cache, the rows with blue dots will be mistakenly judged as read.
      // The clicked row is the snapshot actually seen by the user this time, and its unreadAt is used first to compare-and-clear;
      // Old entries without row snapshots will continue to be rolled back to the query cache to maintain compatibility.
      const expectedUnreadAt =
        typeof selectedRowUnreadAt === "number" ? selectedRowUnreadAt : previousUnreadAt;
      const shouldClearUnread = typeof expectedUnreadAt === "number";
      const isRemoteWorkspace = Boolean(
        targetWorkspaceIdentity ||
        (activeTab &&
          isWorkspaceTab(activeTab) &&
          activeWorkspaceTabMatchesTarget &&
          (activeTab.remoteSessionId || activeTab.remoteTarget)),
      );

      if (shouldClearUnread) {
        // Unread was previously only persisted and cleared after resumeTask of useTaskRestore.
        // When the user clicks the current task again, restore will not be performed again, and the unreadAt in the disk will remain.
        // It displays as "I have clicked and read it, but after restarting the app, it returned to unread."
        // Here, the explicitly selected task is also regarded as a read entry, ensuring that the persistent unread status can be cleared when the same task is entered repeatedly.
        // v4 task lines have been rendered by query cache, only old Zustand unread map is updated
        // Will not let blue points re-render. First add field-level overlay to the precise entity key, and the server will return the packet.
        // Reconcile later; the refresh of the old membership during the period cannot write back the blue points.
        setTaskQueryCacheUnreadOverlay(targetTask, undefined);
        const targetServices = resolvedRemoteSessionId
          ? (getRemoteWorkspaceSession(resolvedRemoteSessionId)?.services ?? null)
          : isRemoteWorkspace
            ? null
            : baseServices;
        if (!targetServices) {
          // When the remote workspace is disconnected, it cannot fall back to the same workspacePath.
          // Other remote sessions or local base services, otherwise the unread status of another workspace will be cleared.
          rollbackTaskQueryCacheUnread(targetTask, previousUnreadAt);
          logger.warn(
            `[App] skipping unread persistence on task selection, remote workspace not connected workspace=${targetWorkspacePath} taskId=${taskId}`,
          );
        } else {
          void targetServices.zcodeTaskService
            .setTaskUnread({
              ...targetTask,
              unread: false,
              expectedUnreadAt,
            })
            .then((meta) => {
              reconcileTaskQueryCacheUnread(targetTask, meta.unreadAt);
              bumpTaskListMembershipVersion();
            })
            .catch((error: unknown) => {
              rollbackTaskQueryCacheUnread(targetTask, previousUnreadAt);
              markTaskQueryCacheScopesStale([targetTask]);
              bumpTaskListMembershipVersion();
              logger.warn(
                `[App] failed to clear unread on task selection workspace=${targetWorkspacePath} taskId=${taskId}:`,
                error instanceof Error ? error.message : String(error),
              );
            });
        }
      }

      // slashCommands is a workspace identity level directory, not a task projection.
      // If you clear it first when selecting an existing task, then only the conversation projection will be restored.
      // The workspace directory read by composer never gets backfilled. The same identity bucket is retained here;
      // Cold recovery is filled independently by workspace catalog hydration when it is indeed empty.
      setActiveTaskId(targetWorkspacePath, taskId, targetWorkspaceIdentity);
      onNavigateToTask?.();
    },
    [activateTabByPath, intl, onNavigateToTask, baseServices, tabStoreApi, setActiveTaskId],
  );

  const handleOpenAutomations = useCallback(
    (automationId?: string, automationTab?: AutomationsNavigationTab) => {
      const normalizedAutomationId = automationId?.trim() || undefined;
      // Automations used to only switch the local view of WorkspaceShellLayout, completely bypassing
      // Browser-style navigation history, resulting in top forward/backward failure to return or restore the page. Here it is as
      // The formal navigation target of workspace identity isolation is pushed into the stack; historical playback only consumes entries and will not be pushed into the stack again.
      taskNavPushAutomations(
        workspaceAbsPath,
        workspaceIdentity,
        normalizedAutomationId,
        automationTab,
      );
      onNavigateToAutomations?.({
        workspacePath: workspaceAbsPath,
        ...(workspaceIdentity ? { workspaceIdentity } : {}),
        ...(normalizedAutomationId ? { automationId: normalizedAutomationId } : {}),
        ...(automationTab ? { automationTab } : {}),
      });
    },
    [onNavigateToAutomations, taskNavPushAutomations, workspaceAbsPath, workspaceIdentity],
  );

  const handleOpenPluginStore = useCallback(() => {
    taskNavPushPluginStore(workspaceAbsPath, workspaceIdentity);
    onNavigateToPluginStore?.({ workspacePath: workspaceAbsPath, workspaceIdentity });
  }, [onNavigateToPluginStore, taskNavPushPluginStore, workspaceAbsPath, workspaceIdentity]);

  const handleTaskNavBack = useCallback(() => {
    const currentWorkspaceState = useZCodeSessionStore
      .getState()
      .getWorkspaceState(workspaceAbsPath);
    if (
      shouldBlockTaskSelectionDuringModelRestart(
        currentWorkspaceState.modelSwitchPending,
        currentWorkspaceState.modelSwitchStage,
      )
    ) {
      logger.info(
        "[App] model runtime rebuilding, ignoring task back navigation workspace=" +
          workspaceAbsPath +
          " stage=" +
          currentWorkspaceState.modelSwitchStage,
      );
      toast(intl.formatMessage({ id: "taskList.switchBlockedByModelRestart" }));
      return;
    }

    let entry = taskNavGoBack();
    // Performance fix: task meta recovery/streaming synchronization will refresh the query cache frequently.
    // Historical navigation only requires an existence snapshot when the command is executed to avoid hook subscription to the entire meta table causing shell re-rendering.
    const taskMetaByEntityKey = useTaskQueryCacheStore.getState().taskMetaByEntityKey;
    while (entry) {
      const currentEntry = entry;
      if (isAutomationsNavEntry(currentEntry)) {
        activateTabByPath(
          currentEntry.workspacePath,
          currentEntry.workspaceIdentity
            ? { workspaceIdentity: currentEntry.workspaceIdentity }
            : undefined,
        );
        onNavigateToAutomations?.({
          workspacePath: currentEntry.workspacePath,
          ...(currentEntry.workspaceIdentity
            ? { workspaceIdentity: currentEntry.workspaceIdentity }
            : {}),
          ...(currentEntry.automationId ? { automationId: currentEntry.automationId } : {}),
          ...(currentEntry.automationTab ? { automationTab: currentEntry.automationTab } : {}),
        });
        return;
      }
      if (isPluginStoreNavEntry(currentEntry)) {
        activateTabByPath(
          currentEntry.workspacePath,
          currentEntry.workspaceIdentity
            ? { workspaceIdentity: currentEntry.workspaceIdentity }
            : undefined,
        );
        onNavigateToPluginStore?.(currentEntry);
        return;
      }
      const navWorkspaceState = useZCodeSessionStore
        .getState()
        .getWorkspaceState(currentEntry.workspacePath, currentEntry.workspaceIdentity);
      const exists = taskNavigationTargetExists({
        entry: currentEntry,
        visibleTasks: getVisibleTaskMetas(navWorkspaceState),
        taskMetaByEntityKey,
      });
      if (exists) {
        handleSelectTask(
          currentEntry.workspacePath,
          currentEntry.taskId,
          currentEntry.workspaceIdentity,
        );
        return;
      }

      // Target task has been deleted, clean it from history and try again
      removeTaskFromNavHistory(currentEntry.taskId);
      entry = taskNavGoBack();
    }

    toast(intl.formatMessage({ id: "taskNav.noMoreBack" }));
  }, [
    activateTabByPath,
    handleSelectTask,
    intl,
    onNavigateToAutomations,
    onNavigateToPluginStore,
    removeTaskFromNavHistory,
    taskNavGoBack,
    workspaceAbsPath,
  ]);

  const handleTaskNavForward = useCallback(() => {
    const currentWorkspaceState = useZCodeSessionStore
      .getState()
      .getWorkspaceState(workspaceAbsPath);
    if (
      shouldBlockTaskSelectionDuringModelRestart(
        currentWorkspaceState.modelSwitchPending,
        currentWorkspaceState.modelSwitchStage,
      )
    ) {
      logger.info(
        "[App] model runtime rebuilding, ignoring task forward navigation workspace=" +
          workspaceAbsPath +
          " stage=" +
          currentWorkspaceState.modelSwitchStage,
      );
      toast(intl.formatMessage({ id: "taskList.switchBlockedByModelRestart" }));
      return;
    }

    let entry = taskNavGoForward();
    // Performance fix: Only read the latest query cache when the forward command is triggered to avoid subscribing to the entire navigation hook for small task meta updates.
    const taskMetaByEntityKey = useTaskQueryCacheStore.getState().taskMetaByEntityKey;
    while (entry) {
      const currentEntry = entry;
      if (isAutomationsNavEntry(currentEntry)) {
        activateTabByPath(
          currentEntry.workspacePath,
          currentEntry.workspaceIdentity
            ? { workspaceIdentity: currentEntry.workspaceIdentity }
            : undefined,
        );
        onNavigateToAutomations?.({
          workspacePath: currentEntry.workspacePath,
          ...(currentEntry.workspaceIdentity
            ? { workspaceIdentity: currentEntry.workspaceIdentity }
            : {}),
          ...(currentEntry.automationId ? { automationId: currentEntry.automationId } : {}),
          ...(currentEntry.automationTab ? { automationTab: currentEntry.automationTab } : {}),
        });
        return;
      }
      if (isPluginStoreNavEntry(currentEntry)) {
        activateTabByPath(
          currentEntry.workspacePath,
          currentEntry.workspaceIdentity
            ? { workspaceIdentity: currentEntry.workspaceIdentity }
            : undefined,
        );
        onNavigateToPluginStore?.(currentEntry);
        return;
      }
      const navWorkspaceState = useZCodeSessionStore
        .getState()
        .getWorkspaceState(currentEntry.workspacePath, currentEntry.workspaceIdentity);
      const exists = taskNavigationTargetExists({
        entry: currentEntry,
        visibleTasks: getVisibleTaskMetas(navWorkspaceState),
        taskMetaByEntityKey,
      });
      if (exists) {
        handleSelectTask(
          currentEntry.workspacePath,
          currentEntry.taskId,
          currentEntry.workspaceIdentity,
        );
        return;
      }

      removeTaskFromNavHistory(currentEntry.taskId);
      entry = taskNavGoForward();
    }

    toast(intl.formatMessage({ id: "taskNav.noMoreForward" }));
  }, [
    activateTabByPath,
    handleSelectTask,
    intl,
    onNavigateToAutomations,
    onNavigateToPluginStore,
    removeTaskFromNavHistory,
    taskNavGoForward,
    workspaceAbsPath,
  ]);

  const canGoBack = navCanGoBack(taskNavHistory);
  const canGoForward = navCanGoForward(taskNavHistory);
  const currentWorkspaceState = useZCodeSessionStore.getState().getWorkspaceState(workspaceAbsPath);
  const isTaskSwitchLockedByModelRestart = shouldBlockTaskSelectionDuringModelRestart(
    currentWorkspaceState.modelSwitchPending,
    currentWorkspaceState.modelSwitchStage,
  );
  const canTaskNavBack = canGoBack && !isTaskSwitchLockedByModelRestart;
  const canTaskNavForward = canGoForward && !isTaskSwitchLockedByModelRestart;

  return {
    handleSelectTask,
    handleOpenAutomations,
    handleOpenPluginStore,
    handleTaskNavBack,
    handleTaskNavForward,
    canGoBack,
    canGoForward,
    canTaskNavBack,
    canTaskNavForward,
  };
}
