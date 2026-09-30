/* eslint-disable max-lines -- the workspace row also carries collapsing, remote status, and quick
 * actions, so it stays consolidated in one file for now.
 */
import {
  memo,
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent,
} from "react";
import {
  CheckIcon,
  CircleAlert,
  Cloud,
  CopyIcon,
  Ellipsis,
  Folder,
  FolderOpen,
  House,
  InfoIcon,
  ListTree,
  LoaderCircle,
  RefreshCwIcon,
  MessageCirclePlus,
  XIcon,
} from "lucide-react";
import type { useSortable } from "@dnd-kit/sortable";
import { BorderBeam } from "border-beam";
import { STATUS_DOT } from "@/components/workflow-graph/run-status-presentation.js";
import { Button, buttonVariants } from "@/components/ui/button.js";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu.js";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  buildWorkspaceSessionKey,
  formatRemoteWorkspaceDisplayLabel,
} from "@/lib/remoteWorkspaceHistory.js";
import { TaskList } from "@/TaskList.js";
import { selectWorkspaceZCodeState, useZCodeSessionStore } from "@/store/zcodeSessionStore.js";
import type { WorkspaceTabState } from "@/store/tabStore.js";
import type { RemoteConnectionLogEntry } from "@/hooks/useRemoteConnectionLogs.js";
import { ReconnectingRemoteWorkspaceLogTooltip } from "@/WorkspaceSidebar/ReconnectingRemoteWorkspaceLogTooltip.js";
import { cn } from "@/components/lib/utils.js";
import {
  TID_WORKSPACE_CLOSE,
  TID_WORKSPACE_FILE_TREE_BUTTON,
  TID_WORKSPACE_ITEM,
  testId,
} from "@zcode/shared";
import type { ZCodeTaskMeta } from "@zcode/shared";
import { useBaseWorkspaceServices, useWorkspaceServices } from "@/hooks/useWorkspaceServices.js";
import {
  applyTaskQueryCacheMutation,
  invalidateTaskQueryCacheByScopes,
} from "@/store/taskQueryCacheStore.js";
import { useRemotePinnedTaskStore } from "@/store/remotePinnedTaskStore.js";
import { useRemoteTimelineTaskStore } from "@/store/remoteTimelineTaskStore.js";
import { logger } from "@/logger.js";
import {
  RemoteSyncDialogs,
  RemoteSyncMenuItems,
  shouldShowRemoteSyncActions,
} from "@/settings/RemoteSyncActions.js";
import { invalidateDeferredDraftSessionForSkillChange } from "@/lib/zcodeDraftSkillInvalidation.js";
import { refreshSharedSkillStoreForWorkspace } from "@/lib/skillStoreRefresh.js";
import { refreshWorkspacePluginCapabilitiesAfterRemoteSync } from "@/lib/remotePluginSyncRefresh.js";
import { useMcpStore } from "@/store/mcpStore.js";
import { TaskRowActionButton } from "@/workspace-grouped-tasks/task-row-action-button.js";
import { releaseWorkspaceRuntimeAfterProjectRemoval } from "@/lib/workspaceRuntimeRelease.js";
import {
  hasRunningWorkspaceChat,
  scanWindowsReservedDeviceNameFiles,
} from "@/lib/workspaceRemovalSafety.js";
import { useConfirmDialog } from "@/hooks/useConfirmDialog.js";
import { toast } from "@/components/ui/toast.js";

export type SortableBindings = Pick<ReturnType<typeof useSortable>, "attributes" | "listeners">;

// Workspace rows are re-rendered during streaming tool events due to parent refresh;
// If TaskList receives a new empty array every time, it will misjudge the equivalent data as a change and refresh the task row together.
const EMPTY_PINNED_TASKS: ZCodeTaskMeta[] = [];

function isHomeWorkspacePath(path: string): boolean {
  const normalizedPath = path.replace(/\\/g, "/").replace(/\/+$/, "");
  return /^(\/Users\/[^/]+|\/home\/[^/]+|[A-Za-z]:\/Users\/[^/]+)$/.test(normalizedPath);
}

type SshRemoteTarget = Extract<NonNullable<WorkspaceTabState["remoteTarget"]>, { kind: "ssh" }>;

interface SshWorkspaceTooltipDetails {
  alias: string | null;
  hostLabel: string;
  workspacePath: string;
}

function formatSshRemoteHostLabel(target: SshRemoteTarget): string {
  const username = target.username.trim();
  const host = target.host.trim();
  const port = target.port ?? 22;
  return `${username}@${host}:${port}`;
}

function getSshWorkspaceTooltipDetails(tab: WorkspaceTabState): SshWorkspaceTooltipDetails | null {
  if (tab.remoteTarget?.kind !== "ssh") {
    return null;
  }

  return {
    alias: tab.remoteTarget.sshConfigAlias?.trim() || null,
    hostLabel: formatSshRemoteHostLabel(tab.remoteTarget),
    workspacePath: tab.workspacePath,
  };
}

export const WorkspaceSidebarItem = memo(function WorkspaceSidebarItem({
  tab,
  isActiveWorkspace,
  isExpanded,
  closeTab,
  toggleWorkspaceExpanded,
  onSelectTask,
  onStartDraftInWorkspace,
  taskItems,
  taskListLoading,
  taskListHasMore,
  taskListHasUnread = false,
  taskListLiveWorkflowCount = 0,
  onShowMoreTasks,
  reconnectingRemoteWorkspaceKeys,
  remoteWorkspaceErrorByWorkspaceKey,
  reconnectingRemoteWorkspaceLogsByWorkspaceKey,
  onReconnectRemoteWorkspace,
  onOpenFileTree,
  itemRef,
  itemStyle,
  sortableBindings,
  isDragging = false,
}: {
  tab: WorkspaceTabState;
  isActiveWorkspace: boolean;
  isExpanded: boolean;
  activateTab: (tabId: string) => void;
  closeTab: (tabId: string) => void;
  toggleWorkspaceExpanded: (workspacePath: string) => void;
  onSelectTask: (
    targetWorkspacePath: string,
    taskId: string,
    targetWorkspaceIdentity?: string,
  ) => void;
  onStartDraftInWorkspace: (targetWorkspacePath: string, targetWorkspaceIdentity?: string) => void;
  taskItems: ZCodeTaskMeta[];
  taskListLoading: boolean;
  taskListHasMore: boolean;
  taskListHasUnread?: boolean;
  /**
   * Number of workflow runs in flight in the group; when the project is collapsed, a pulse lamp is
   * drawn next to the unread dot (with a count when >1).
   */
  taskListLiveWorkflowCount?: number;
  onShowMoreTasks: () => void;
  reconnectingRemoteWorkspaceKeys: string[];
  remoteWorkspaceErrorByWorkspaceKey: Record<string, string>;
  reconnectingRemoteWorkspaceLogsByWorkspaceKey: Record<string, RemoteConnectionLogEntry[]>;
  onReconnectRemoteWorkspace: (workspaceKey: string) => Promise<void>;
  onOpenFileTree?: (target: {
    workspacePath: string;
    workspaceName: string;
    workspaceIdentity?: string;
    workspaceRemoteSessionId?: string;
  }) => void;
  itemRef?: (node: HTMLLIElement | null) => void;
  itemStyle?: CSSProperties;
  sortableBindings?: SortableBindings;
  isDragging?: boolean;
}) {
  const { intl } = useZCodeIntl();
  const workspaceZCodeState = useZCodeSessionStore((state) =>
    selectWorkspaceZCodeState(state, tab.workspacePath, tab.workspaceIdentity),
  );
  const activeTaskId = workspaceZCodeState.activeTaskId;
  const removeTaskState = useZCodeSessionStore((state) => state.removeTaskState);
  const upsertOptimisticTaskListItem = useZCodeSessionStore(
    (state) => state.upsertOptimisticTaskListItem,
  );
  const removeOptimisticTaskListItem = useZCodeSessionStore(
    (state) => state.removeOptimisticTaskListItem,
  );
  const setTaskUnreadIndicator = useZCodeSessionStore((state) => state.setTaskUnreadIndicator);
  const services = useWorkspaceServices(
    tab.workspacePath,
    tab.remoteSessionId,
    tab.workspaceIdentity,
    tab.remoteTarget,
  );
  const confirmDialog = useConfirmDialog();
  const baseServices = useBaseWorkspaceServices();
  const zcodeTaskService = services.zcodeTaskService;
  const taskItemsRef = useRef(taskItems);
  taskItemsRef.current = taskItems;
  const workspaceZCodeStateRef = useRef(workspaceZCodeState);
  workspaceZCodeStateRef.current = workspaceZCodeState;
  const findCurrentTaskItem = useCallback((taskId: string) => {
    // Streaming refresh will rebuild the taskItems array. If the task operation callback directly relies on the array,
    // Even if the task semantics have not changed, the reference will be changed, continuing to break down the memo of TaskListItem.
    // Use ref to read the latest list when calling, which not only keeps the callback stable, but also prevents optimistic updates from getting expired meta.
    return taskItemsRef.current.find((task) => task.taskId === taskId) ?? null;
  }, []);
  const isHomeWorkspace = isHomeWorkspacePath(tab.workspacePath);
  const readOnlyReason =
    tab.availability === "unavailable-local-directory"
      ? intl.formatMessage({ id: "workspaceSidebar.unavailableLocalDirectory" })
      : undefined;
  const remoteWorkspaceKey = buildWorkspaceSessionKey(tab);
  const isRemoteWorkspace = Boolean(
    tab.remoteSessionId || tab.remoteTarget || tab.workspaceIdentity,
  );
  const isDisconnectedRemoteWorkspace = Boolean(isRemoteWorkspace && !tab.remoteSessionId);
  const isReconnectPending = Boolean(
    isDisconnectedRemoteWorkspace && reconnectingRemoteWorkspaceKeys.includes(remoteWorkspaceKey),
  );
  const remoteWorkspaceError = remoteWorkspaceErrorByWorkspaceKey[remoteWorkspaceKey];
  const workspaceSidebarLabel = formatRemoteWorkspaceDisplayLabel(tab.label, tab.remoteTarget);
  const sshWorkspaceTooltipDetails = getSshWorkspaceTooltipDetails(tab);
  const reconnectRuntimeLogs =
    reconnectingRemoteWorkspaceLogsByWorkspaceKey[remoteWorkspaceKey] ?? [];
  const showRemoteConnectionErrorNotice = Boolean(
    // As long as the remote project is "disconnected", an exclamation mark will be displayed, which will mix "not yet connected/disconnected but no errors" and "real connection failed".
    // When users see the warning icon in the list, they cannot determine whether there is a real fault.
    // Here it converges to the point where the exclamation mark is displayed only when there is a connection error text, and only the reconnection entry is retained in the normal unconnected state.
    isDisconnectedRemoteWorkspace && !isReconnectPending && remoteWorkspaceError?.trim(),
  );
  const showReconnectAction = Boolean(isDisconnectedRemoteWorkspace);
  const showFileTreeAction = Boolean(onOpenFileTree && !isDisconnectedRemoteWorkspace);
  const showRemoteSkillSyncAction = shouldShowRemoteSyncActions({
    remoteSessionId: tab.remoteSessionId,
    remoteTarget: tab.remoteTarget,
    clientMode: "desktop-continuous" as const,
    hasLocalSourceService: Boolean(baseServices.skillSyncService),
  });
  // When the remote workspace is "reconnecting", there was only a slight background breathing effect before.
  // It is not eye-catching enough in the high-density list in the sidebar, making it difficult for users to quickly determine which container is still connected.
  // BorderBeam is reused here and is only activated during reconnection to make the connection status feedback clearer.
  // At the same time, avoid being mistakenly displayed as "still running" in normal idle state or disconnected state.
  const shouldShowRemoteConnectingBorderBeam = isReconnectPending;
  const [isRemoteErrorCopied, setIsRemoteErrorCopied] = useState(false);
  const [remoteSkillSyncOpen, setRemoteSkillSyncOpen] = useState(false);
  const [remoteMcpSyncOpen, setRemoteMcpSyncOpen] = useState(false);
  const [remotePluginSyncOpen, setRemotePluginSyncOpen] = useState(false);
  const [workspaceRowHovered, setWorkspaceRowHovered] = useState(false);
  const [workspaceRowFocusWithin, setWorkspaceRowFocusWithin] = useState(false);
  const [workspaceActionMenuOpen, setWorkspaceActionMenuOpen] = useState(false);
  const [isHoverNone] = useState(
    () =>
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(hover: none)").matches,
  );
  const shouldMountWorkspaceRowActions =
    // The workspace action used to reside in the DOM and was hidden only by opacity; the adjacent tooltip would be in the
    // Before the floating layer positioning is completed, the hidden trigger is mistakenly recognized and temporarily displayed in the wrong position. Changed to mount during interaction and keep alive when menu is opened.
    workspaceRowHovered || workspaceRowFocusWithin || workspaceActionMenuOpen || isHoverNone;
  const remoteErrorCopyResetRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (remoteErrorCopyResetRef.current !== null) {
        window.clearTimeout(remoteErrorCopyResetRef.current);
      }
    };
  }, []);

  const handleWorkspaceOpenChange = useCallback(
    (nextOpen: boolean) => {
      if (isDisconnectedRemoteWorkspace) {
        return;
      }

      // Workspace draft navigation itself marks the workspace as expanded.
      // Previously, in Collapsible's onOpenChange, the workspace was activated first regardless of whether it was expanded or collapsed.
      // The next click after collapsing will first be expanded by the activated path, and then reversely switched back and recovered by toggleWorkspaceExpanded.
      // The expression is "cannot be opened again after being put away".
      // Here we split the responsibilities: only do draft navigation when expanding; only do toggle when collapsing, to prevent the two status updates from canceling each other out.
      if (nextOpen) {
        if (!isExpanded) {
          // The workspace line means "open this workspace", not restore its last selected session.
          // Unify the upper-level draft navigation affairs and let workspace identity, group/pane cleanup and draft focus be closed together.
          onStartDraftInWorkspace(tab.workspacePath, tab.workspaceIdentity);
        }
      } else if (isExpanded) {
        toggleWorkspaceExpanded(tab.workspacePath);
      }
    },
    [
      isDisconnectedRemoteWorkspace,
      isExpanded,
      onStartDraftInWorkspace,
      tab.workspaceIdentity,
      tab.workspacePath,
      toggleWorkspaceExpanded,
    ],
  );

  const handleSelectTask = useCallback(
    (taskId: string) => {
      // Performance optimization: The upper handleSelectTask already activates tabs according to workspacePath.
      // Repeating activate here will trigger an additional round of tab store updates, re-rendering the entire column of workspace rows.
      onSelectTask(tab.workspacePath, taskId, tab.workspaceIdentity);
    },
    [onSelectTask, tab.workspaceIdentity, tab.workspacePath],
  );

  const handleActionMouseDown = useCallback((event: MouseEvent<HTMLElement>) => {
    event.preventDefault();
    event.stopPropagation();
  }, []);

  const handleActionMenuClick = useCallback((event: MouseEvent<HTMLElement>) => {
    // DropdownMenuContent Although rendered out-of-line via Portal, React synthesized clicks still follow the component tree
    // Bubbles to the outer CollapsibleTrigger. When the collapsed workspace clicks "Remove", it will closeTab first, and then be called back when expanded.
    // Re-addTab as "open workspace", but it appears that it cannot be deleted. The menu layer uniformly truncates clicks, retaining menu selection and keyboard semantics.
    event.stopPropagation();
  }, []);

  const handleCreateThreadClick = useCallback(
    (event: MouseEvent<HTMLButtonElement>) => {
      event.preventDefault();
      event.stopPropagation();
      if (readOnlyReason) {
        return;
      }
      onStartDraftInWorkspace(tab.workspacePath, tab.workspaceIdentity);
    },
    [onStartDraftInWorkspace, readOnlyReason, tab.workspaceIdentity, tab.workspacePath],
  );

  const handleRemoveWorkspace = useCallback(async () => {
    const workspaceKey = tab.workspaceIdentity?.trim() || tab.workspacePath;
    logger.debug("[WorkspaceSidebarItem] removing workspace", {
      isExpanded,
      workspaceKey,
    });

    if (
      hasRunningWorkspaceChat({
        workspaceState: workspaceZCodeStateRef.current,
        taskItems: taskItemsRef.current,
      })
    ) {
      const confirmed = await confirmDialog({
        title: intl.formatMessage({ id: "workspaceSidebar.removeRunningWorkspace.title" }),
        description: intl.formatMessage({
          id: "workspaceSidebar.removeRunningWorkspace.description",
        }),
        confirmLabel: intl.formatMessage({ id: "workspaceSidebar.removeRunningWorkspace.confirm" }),
        cancelLabel: intl.formatMessage({ id: "common.cancel" }),
        confirmVariant: "destructive",
      });
      if (!confirmed) {
        logger.debug("[WorkspaceSidebarItem] user cancelled removing running workspace", {
          workspaceKey,
        });
        return;
      }
    }

    closeTab(tab.id);
    releaseWorkspaceRuntimeAfterProjectRemoval({
      tab: {
        workspacePath: tab.workspacePath,
        workspaceIdentity: tab.workspaceIdentity,
      },
      zcodeTaskService,
    });
    // Removing the workspace only removes the entry and connection history, it does not mean that the user needs to hide historical tasks:
    // Here we only invalidate the cache and retain the original state of the sqlite task index to avoid the task being "lost" after reconnecting to the same SSH workspace.
    invalidateTaskQueryCacheByScopes([
      {
        workspacePath: tab.workspacePath,
        ...(tab.workspaceIdentity ? { workspaceIdentity: tab.workspaceIdentity } : {}),
      },
    ]);

    if (!isRemoteWorkspace) {
      void scanWindowsReservedDeviceNameFiles(baseServices.fileService, tab.workspacePath)
        .then((result) => {
          if (result.findings.length === 0) {
            return;
          }
          const firstFinding = result.findings[0] ?? tab.workspacePath;
          toast(
            intl.formatMessage(
              { id: "workspaceSidebar.windowsReservedNameRisk" },
              { count: result.findings.length, path: firstFinding },
            ),
            { durationMs: 8_000, variant: "warning" },
          );
        })
        .catch((error: unknown) => {
          // Windows reserved device name scanning is only a compatibility risk reminder after removal, and failure cannot affect the release of the workspace life cycle.
          logger.debug("[WorkspaceSidebarItem] windows reserved name risk scan failed", {
            workspaceKey,
            error,
          });
        });
    }
  }, [
    baseServices.fileService,
    closeTab,
    confirmDialog,
    intl,
    isExpanded,
    isRemoteWorkspace,
    tab.id,
    tab.workspaceIdentity,
    tab.workspacePath,
    zcodeTaskService,
  ]);

  const handleReconnectRemoteWorkspace = useCallback(
    (event: MouseEvent<HTMLButtonElement>) => {
      event.preventDefault();
      event.stopPropagation();
      if (!isDisconnectedRemoteWorkspace || isReconnectPending) {
        return;
      }

      void onReconnectRemoteWorkspace(remoteWorkspaceKey);
    },
    [
      isDisconnectedRemoteWorkspace,
      isReconnectPending,
      onReconnectRemoteWorkspace,
      remoteWorkspaceKey,
    ],
  );

  const handleOpenWorkspaceFileTree = useCallback(
    (event: MouseEvent<HTMLButtonElement>) => {
      event.preventDefault();
      event.stopPropagation();
      if (isDisconnectedRemoteWorkspace || readOnlyReason || !onOpenFileTree) {
        return;
      }

      onOpenFileTree({
        workspacePath: tab.workspacePath,
        workspaceName: tab.label,
        workspaceIdentity: tab.workspaceIdentity,
        workspaceRemoteSessionId: tab.remoteSessionId,
      });
    },
    [
      isDisconnectedRemoteWorkspace,
      onOpenFileTree,
      readOnlyReason,
      tab.label,
      tab.remoteSessionId,
      tab.workspaceIdentity,
      tab.workspacePath,
    ],
  );

  // These TaskList operations previously created new closures every render in JSX.
  // When the streaming event refreshes the workspace row, even if the task data does not change, it will penetrate the memo of TaskList/TaskListItem.
  const handleRenameTask = useCallback(
    async (taskId: string, title: string) => {
      if (readOnlyReason) {
        return null;
      }
      const previousTask = findCurrentTaskItem(taskId);
      logger.info("[WorkspaceSidebarItem] rename service call start", {
        taskId,
        workspacePath: tab.workspacePath,
        workspaceIdentity: tab.workspaceIdentity,
        previousTitleLength: previousTask?.title.length,
        nextTitleLength: title.length,
      });
      let meta: ZCodeTaskMeta;
      try {
        meta = await zcodeTaskService.renameTask({
          taskId,
          workspacePath: tab.workspacePath,
          title,
          ...(tab.workspaceIdentity ? { workspaceIdentity: tab.workspaceIdentity } : {}),
        });
      } catch (error) {
        logger.error("[WorkspaceSidebarItem] rename service call failed", {
          taskId,
          workspacePath: tab.workspacePath,
          workspaceIdentity: tab.workspaceIdentity,
          message: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
      logger.info("[WorkspaceSidebarItem] rename service call resolved", {
        taskId,
        workspacePath: tab.workspacePath,
        workspaceIdentity: tab.workspaceIdentity,
        resolvedTitleLength: meta.title.length,
      });
      upsertOptimisticTaskListItem(tab.workspacePath, meta, tab.workspaceIdentity);
      if (tab.workspaceIdentity) {
        useRemoteTimelineTaskStore.getState().upsertTask(meta);
      }
      applyTaskQueryCacheMutation({
        previousTask: previousTask ?? meta,
        nextTask: meta,
        previousState: { pinned: false, archived: false },
        nextState: { pinned: false, archived: false },
      });
      logger.info("[WorkspaceSidebarItem] rename cache mutation applied", {
        taskId,
        workspacePath: tab.workspacePath,
        workspaceIdentity: tab.workspaceIdentity,
      });
      return meta;
    },
    [
      tab.workspaceIdentity,
      tab.workspacePath,
      findCurrentTaskItem,
      readOnlyReason,
      upsertOptimisticTaskListItem,
      zcodeTaskService,
    ],
  );

  const handleSetTaskPinned = useCallback(
    async (taskId: string, pinned: boolean) => {
      if (readOnlyReason) {
        return null;
      }
      const previousTask = findCurrentTaskItem(taskId);
      if (previousTask) {
        // Pins in the workspace used to wait for the remote/local RPC to return before updating the global pinned cache.
        // The pin area will disappear and then be restored. Here we first synchronize the list membership optimistically and roll back when it fails.
        if (tab.workspaceIdentity && pinned) {
          useRemotePinnedTaskStore.getState().upsertTask(previousTask);
          useRemoteTimelineTaskStore
            .getState()
            .removeTask(tab.workspacePath, taskId, tab.workspaceIdentity);
        }
        if (tab.workspaceIdentity && !pinned) {
          useRemotePinnedTaskStore
            .getState()
            .removeTask(tab.workspacePath, taskId, tab.workspaceIdentity);
          useRemoteTimelineTaskStore.getState().upsertTask(previousTask);
        }
        applyTaskQueryCacheMutation({
          previousTask,
          nextTask: previousTask,
          previousState: { pinned: false, archived: false },
          nextState: { pinned, archived: false },
        });
      }
      try {
        const meta = await zcodeTaskService.setTaskPinned({
          taskId,
          workspacePath: tab.workspacePath,
          pinned,
          ...(tab.workspaceIdentity ? { workspaceIdentity: tab.workspaceIdentity } : {}),
        });
        removeOptimisticTaskListItem(tab.workspacePath, taskId, tab.workspaceIdentity);
        if (tab.workspaceIdentity && pinned) {
          useRemotePinnedTaskStore.getState().upsertTask(meta);
          useRemoteTimelineTaskStore
            .getState()
            .removeTask(tab.workspacePath, taskId, tab.workspaceIdentity);
        }
        if (tab.workspaceIdentity && !pinned) {
          useRemotePinnedTaskStore
            .getState()
            .removeTask(tab.workspacePath, taskId, tab.workspaceIdentity);
          useRemoteTimelineTaskStore.getState().upsertTask(meta);
        }
        applyTaskQueryCacheMutation({
          previousTask: previousTask ?? meta,
          nextTask: meta,
          previousState: { pinned, archived: false },
          nextState: { pinned, archived: false },
        });
        return meta;
      } catch (error) {
        if (previousTask) {
          if (tab.workspaceIdentity && pinned) {
            useRemotePinnedTaskStore
              .getState()
              .removeTask(tab.workspacePath, taskId, tab.workspaceIdentity);
            useRemoteTimelineTaskStore.getState().upsertTask(previousTask);
          }
          if (tab.workspaceIdentity && !pinned) {
            useRemotePinnedTaskStore.getState().upsertTask(previousTask);
            useRemoteTimelineTaskStore
              .getState()
              .removeTask(tab.workspacePath, taskId, tab.workspaceIdentity);
          }
          applyTaskQueryCacheMutation({
            previousTask,
            nextTask: previousTask,
            previousState: { pinned, archived: false },
            nextState: { pinned: false, archived: false },
          });
        }
        throw error;
      }
    },
    [
      removeOptimisticTaskListItem,
      readOnlyReason,
      tab.workspaceIdentity,
      tab.workspacePath,
      findCurrentTaskItem,
      zcodeTaskService,
    ],
  );

  const handleArchiveTask = useCallback(
    async (taskId: string) => {
      if (readOnlyReason) {
        return null;
      }
      const previousTask = findCurrentTaskItem(taskId);
      const meta = await zcodeTaskService.archiveTask({
        taskId,
        workspacePath: tab.workspacePath,
        ...(tab.workspaceIdentity ? { workspaceIdentity: tab.workspaceIdentity } : {}),
      });
      removeTaskState(tab.workspacePath, taskId, tab.workspaceIdentity);
      if (tab.workspaceIdentity) {
        useRemoteTimelineTaskStore
          .getState()
          .removeTask(tab.workspacePath, taskId, tab.workspaceIdentity);
        useRemotePinnedTaskStore
          .getState()
          .removeTask(tab.workspacePath, taskId, tab.workspaceIdentity);
      }
      applyTaskQueryCacheMutation({
        previousTask: previousTask ?? meta,
        nextTask: meta,
        previousState: { pinned: false, archived: false },
        nextState: { pinned: false, archived: true },
      });
      return meta;
    },
    [
      removeTaskState,
      readOnlyReason,
      tab.workspaceIdentity,
      tab.workspacePath,
      findCurrentTaskItem,
      zcodeTaskService,
    ],
  );

  const handleSetTaskUnread = useCallback(
    async (taskId: string, unread: boolean) => {
      if (readOnlyReason) {
        return null;
      }
      const previousTask = findCurrentTaskItem(taskId);
      const meta = await zcodeTaskService.setTaskUnread({
        taskId,
        workspacePath: tab.workspacePath,
        unread,
        ...(tab.workspaceIdentity ? { workspaceIdentity: tab.workspaceIdentity } : {}),
      });
      setTaskUnreadIndicator(tab.workspacePath, taskId, unread, tab.workspaceIdentity);
      upsertOptimisticTaskListItem(tab.workspacePath, meta, tab.workspaceIdentity);
      if (tab.workspaceIdentity) {
        useRemoteTimelineTaskStore.getState().upsertTask(meta);
      }
      applyTaskQueryCacheMutation({
        previousTask: previousTask ?? meta,
        nextTask: meta,
        previousState: { pinned: false, archived: false },
        nextState: { pinned: false, archived: false },
      });
      return meta;
    },
    [
      setTaskUnreadIndicator,
      readOnlyReason,
      tab.workspaceIdentity,
      tab.workspacePath,
      findCurrentTaskItem,
      upsertOptimisticTaskListItem,
      zcodeTaskService,
    ],
  );

  const handleCopyRemoteWorkspaceError = useCallback(() => {
    if (!remoteWorkspaceError || remoteWorkspaceError.trim().length === 0) {
      return;
    }

    navigator.clipboard.writeText(remoteWorkspaceError).then(() => {
      setIsRemoteErrorCopied(true);
      if (remoteErrorCopyResetRef.current !== null) {
        window.clearTimeout(remoteErrorCopyResetRef.current);
      }
      remoteErrorCopyResetRef.current = window.setTimeout(() => {
        setIsRemoteErrorCopied(false);
        remoteErrorCopyResetRef.current = null;
      }, 1500);
    });
  }, [remoteWorkspaceError]);
  const renderWorkspaceIcon = () => {
    // The workspace line previously cut the directory icon into an arrow when hovering/expanding it.
    // There will be an extra layer of visual hints of "tree expansion control"; the current interaction only needs to retain the item icon itself,
    // This reduces noise and prevents users from interpreting it as a separate arrow switch.
    if (isExpanded && !isDisconnectedRemoteWorkspace) {
      return isRemoteWorkspace ? (
        <Cloud className="h-4 w-4 text-foreground-subtle" />
      ) : isHomeWorkspace ? (
        <House className="h-4 w-4 text-foreground-subtle" />
      ) : (
        <FolderOpen className="h-4 w-4 text-foreground-subtle" />
      );
    }

    return isRemoteWorkspace ? (
      <Cloud className="h-4 w-4 text-foreground-subtle" />
    ) : isHomeWorkspace ? (
      <House className="h-4 w-4 text-foreground-subtle" />
    ) : (
      <Folder className="h-4 w-4 text-foreground-subtle" />
    );
  };

  const workspaceLabelContent = (
    <div className="flex min-w-0 flex-1 items-center gap-2">
      <span className="relative flex size-4 shrink-0 items-center justify-center">
        {renderWorkspaceIcon()}
      </span>
      <div className="min-w-0 truncate text-ui-base text-foreground-subtle">
        {workspaceSidebarLabel}
      </div>
      {!isExpanded && taskListHasUnread ? (
        <span
          aria-hidden="true"
          data-workspace-unread-indicator="true"
          className="h-1.5 w-1.5 shrink-0 rounded-full bg-sky-500 dark:bg-sky-400"
        />
      ) : null}
      {!isExpanded && taskListLiveWorkflowCount > 0 ? (
        // Summary of group headers for workflow run lines:
        // Only running runs are summarized; completed and unconfirmed lines are not rolled up.
        <span
          data-workspace-workflow-indicator="true"
          data-count={String(taskListLiveWorkflowCount)}
          aria-label={intl.formatMessage(
            { id: "taskList.workflowRun.liveCount" },
            { count: String(taskListLiveWorkflowCount) },
          )}
          className="flex shrink-0 items-center gap-1 text-ui-xs leading-none text-foreground-subtle"
        >
          <span aria-hidden="true" className={cn("size-1.5 rounded-full", STATUS_DOT.running)} />
          {taskListLiveWorkflowCount > 1 ? taskListLiveWorkflowCount : null}
        </span>
      ) : null}
      {readOnlyReason ? (
        <ControlHintTooltip title={readOnlyReason} side="right" align="center">
          <span
            role="img"
            aria-label={readOnlyReason}
            tabIndex={0}
            className="flex size-4 shrink-0 items-center justify-center"
          >
            <CircleAlert className="size-3.5 text-destructive" />
          </span>
        </ControlHintTooltip>
      ) : null}
    </div>
  );

  return (
    <li ref={itemRef} style={itemStyle} className="space-y-2">
      <Collapsible
        className="flex flex-col gap-1"
        open={isExpanded && !isDisconnectedRemoteWorkspace}
        onOpenChange={handleWorkspaceOpenChange}
      >
        <BorderBeam
          size="line"
          colorVariant="colorful"
          duration={1.96}
          active={shouldShowRemoteConnectingBorderBeam}
          borderRadius={8}
        >
          <div
            className={cn(
              "group flex items-center gap-2 rounded-lg transition-[background-color,box-shadow]",
              isReconnectPending
                ? "bg-brand/10 workspace-remote-connecting-breathe"
                : isDisconnectedRemoteWorkspace
                  ? "bg-warning/8"
                  : null,
              // "sticky top-0 z-10", // TODO: Make workspace items float when dragging and don't erase them
              isDragging && "bg-selected shadow-xl",
            )}
          >
            <CollapsibleTrigger asChild>
              <div
                role="button"
                tabIndex={0}
                data-testid={testId(TID_WORKSPACE_ITEM, tab.workspacePath)}
                className={cn(
                  buttonVariants({ variant: "ghost", size: "default" }),
                  /*
                   * CollapsibleTrigger automatically injects aria-expanded. After reusing the ghost
                   * button variant here, it matches the global aria-expanded:bg-surface-hover, so
                   * the workspace item grows a background as soon as it expands, as if it were
                   * “selected”. The aria-expanded styling is overridden locally and only hover is
                   * kept, so the active state is not misleading. A disconnected remote workspace
                   * cannot expand the task list, so the hover expand-state hint is disabled here
                   * too — otherwise users see an “expandable” affordance they cannot act on; only
                   * the warning background is kept, indicating that a reconnect is required first.
                   */
                  "flex h-8 min-w-0 flex-1 justify-start gap-2 rounded-lg pl-2.5 pr-1 text-left text-foreground aria-expanded:bg-transparent aria-expanded:text-foreground",
                  "hover:bg-surface-hover hover:text-foreground",
                  isDisconnectedRemoteWorkspace &&
                    "hover:bg-transparent aria-expanded:bg-transparent",
                  sortableBindings && "cursor-grab active:cursor-grabbing",
                )}
                onMouseEnter={() => setWorkspaceRowHovered(true)}
                onMouseLeave={() => setWorkspaceRowHovered(false)}
                onFocusCapture={() => setWorkspaceRowFocusWithin(true)}
                onBlurCapture={(event) => {
                  if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
                    setWorkspaceRowFocusWithin(false);
                  }
                }}
                {...(sortableBindings?.attributes ?? {})}
                {...(sortableBindings?.listeners ?? {})}
              >
                {sshWorkspaceTooltipDetails ? (
                  <TooltipProvider>
                    <Tooltip>
                      <TooltipTrigger asChild>{workspaceLabelContent}</TooltipTrigger>
                      <TooltipContent
                        side="right"
                        align="start"
                        sideOffset={6}
                        className="max-w-80 flex-col items-start gap-2 p-2.5 text-left"
                      >
                        <span className="text-ui-sm font-medium text-tooltip-foreground">
                          {intl.formatMessage({
                            id: "workspaceSidebar.sshConnectionTitle",
                          })}
                        </span>
                        <dl className="grid w-full grid-cols-[auto_minmax(0,1fr)] gap-x-2 gap-y-1 text-ui-sm/relaxed text-tooltip-foreground">
                          {sshWorkspaceTooltipDetails.alias ? (
                            <>
                              <dt className="font-medium">
                                {intl.formatMessage({
                                  id: "workspaceSidebar.sshConnectionAlias",
                                })}
                              </dt>
                              <dd className="min-w-0 break-all font-mono">
                                {sshWorkspaceTooltipDetails.alias}
                              </dd>
                            </>
                          ) : null}
                          <dt className="font-medium">
                            {intl.formatMessage({
                              id: "workspaceSidebar.sshConnectionHost",
                            })}
                          </dt>
                          <dd className="min-w-0 break-all font-mono">
                            {sshWorkspaceTooltipDetails.hostLabel}
                          </dd>
                          <dt className="font-medium">
                            {intl.formatMessage({
                              id: "workspaceSidebar.sshConnectionPath",
                            })}
                          </dt>
                          <dd className="min-w-0 break-all font-mono">
                            {sshWorkspaceTooltipDetails.workspacePath}
                          </dd>
                        </dl>
                      </TooltipContent>
                    </Tooltip>
                  </TooltipProvider>
                ) : (
                  workspaceLabelContent
                )}

                <div className="flex shrink-0 items-center gap-2">
                  {/* {isRemoteWorkspace && isReconnectPending ? (
                    <ReconnectingRemoteWorkspaceLogTooltip
                      logs={reconnectRuntimeLogs}
                    />
                  ) : null} */}
                  <div className="flex shrink-0 items-center gap-1">
                    {shouldMountWorkspaceRowActions ? (
                      <DropdownMenu
                        open={workspaceActionMenuOpen}
                        onOpenChange={setWorkspaceActionMenuOpen}
                      >
                        <ControlHintTooltip title={intl.formatMessage({ id: "common.more" })}>
                          <DropdownMenuTrigger asChild>
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon-sm"
                              className="shrink-0 text-foreground-subtle hover:bg-surface-hover hover:text-foreground"
                              onMouseDown={handleActionMouseDown}
                              aria-label={intl.formatMessage({ id: "common.more" })}
                            >
                              <Ellipsis className="h-3.5 w-3.5" />
                            </Button>
                          </DropdownMenuTrigger>
                        </ControlHintTooltip>
                        <DropdownMenuContent align="end" onClick={handleActionMenuClick}>
                          <RemoteSyncMenuItems
                            canSyncSkills={showRemoteSkillSyncAction}
                            canSyncMcp={showRemoteSkillSyncAction}
                            canSyncPlugins={showRemoteSkillSyncAction}
                            stopMouseDownPropagation
                            onOpenSkillSync={() => setRemoteSkillSyncOpen(true)}
                            onOpenMcpSync={() => setRemoteMcpSyncOpen(true)}
                            onOpenPluginSync={() => setRemotePluginSyncOpen(true)}
                          />
                          <DropdownMenuItem
                            data-testid={testId(TID_WORKSPACE_CLOSE, tab.workspacePath)}
                            onMouseDown={(event) => {
                              event.preventDefault();
                              event.stopPropagation();
                            }}
                            onSelect={(event) => {
                              event.preventDefault();
                              void handleRemoveWorkspace();
                            }}
                          >
                            <XIcon className="h-3.5 w-3.5" />
                            {intl.formatMessage({
                              id: "workspaceSidebar.remove",
                            })}
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    ) : null}
                    {shouldMountWorkspaceRowActions && showFileTreeAction ? (
                      <span className="shrink-0">
                        {/* The Project file tree entry used to override hover:bg-surface-hover on its own,
                            which was inconsistent with the bg-hover of Pinned / Grouped; all three
                            entries now reuse the same action.
                            */}
                        <TaskRowActionButton
                          // This button inherits the main foreground color of ghost by default, causing the three icons in the same group to be inconsistent in light and shade.
                          className="text-foreground-subtle hover:text-foreground"
                          label={intl.formatMessage({
                            id: "workspaceSidebar.showFileTree",
                          })}
                          onClick={handleOpenWorkspaceFileTree}
                          showTooltip
                          disabledReason={readOnlyReason}
                          testId={testId(TID_WORKSPACE_FILE_TREE_BUTTON, tab.workspacePath)}
                        >
                          <ListTree className="h-3.5 w-3.5" />
                        </TaskRowActionButton>
                      </span>
                    ) : null}
                    {showRemoteConnectionErrorNotice ? (
                      remoteWorkspaceError ? (
                        <TooltipProvider>
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <div
                                className="flex size-6 shrink-0 items-center justify-center !text-warning cursor-help"
                                aria-label={intl.formatMessage({
                                  id: "workspaceSidebar.notConnected",
                                })}
                              >
                                <InfoIcon className="h-3.5 w-3.5" />
                              </div>
                            </TooltipTrigger>
                            <TooltipContent
                              side="top"
                              align="center"
                              sideOffset={4}
                              className="w-72 max-w-72 items-center gap-2 p-2.5"
                            >
                              {/*
                               * The remote connection failure tooltip used to be split into a
                               * “title + inner card” two-part structure, which reads as too many
                               * levels in a dense area like the sidebar — like a mini dialog, not
                               * light enough. It is consolidated back into plain tooltip semantics
                               * here: one floating layer holding the error text and the copy button
                               * directly, keeping it readable and copyable while avoiding visual
                               * over-engineering.
                               */}
                              <pre className="max-h-32 min-w-0 flex-1 overflow-auto text-ui-sm/relaxed whitespace-pre-wrap break-words font-mono text-tooltip-foreground">
                                {remoteWorkspaceError}
                              </pre>
                              <Button
                                type="button"
                                variant="ghost"
                                size="icon-md"
                                className="mt-0.5 size-6 shrink-0 text-tooltip-foreground/80 hover:bg-tooltip-tag hover:text-tooltip-foreground"
                                onClick={(event) => {
                                  event.preventDefault();
                                  event.stopPropagation();
                                  handleCopyRemoteWorkspaceError();
                                }}
                                title={intl.formatMessage({
                                  id: isRemoteErrorCopied
                                    ? "chat.toolCall.copyError.copied"
                                    : "chat.toolCall.copyError",
                                })}
                                aria-label={intl.formatMessage({
                                  id: isRemoteErrorCopied
                                    ? "chat.toolCall.copyError.copied"
                                    : "chat.toolCall.copyError",
                                })}
                              >
                                {isRemoteErrorCopied ? (
                                  <CheckIcon className="size-3" />
                                ) : (
                                  <CopyIcon className="size-3" />
                                )}
                              </Button>
                            </TooltipContent>
                          </Tooltip>
                        </TooltipProvider>
                      ) : (
                        <ControlHintTooltip
                          title={intl.formatMessage({
                            id: "workspaceSidebar.notConnected",
                          })}
                        >
                          <div
                            className="flex size-6 shrink-0 items-center justify-center !text-warning"
                            aria-label={intl.formatMessage({
                              id: "workspaceSidebar.notConnected",
                            })}
                          >
                            <InfoIcon className="h-3.5 w-3.5" />
                          </div>
                        </ControlHintTooltip>
                      )
                    ) : null}
                    {showReconnectAction ? (
                      isReconnectPending ? (
                        <ReconnectingRemoteWorkspaceLogTooltip logs={reconnectRuntimeLogs}>
                          {/* While an SSH workspace is reconnecting, the right side used to only show a spinning icon,
                              so users could not tell which step the connection was stuck at in the
                              chat page's task list. The SSH dialog's connection log tooltip is
                              reused here, which keeps the inline layout stable while moving the
                              diagnostic information into a hover popover.
                              */}
                          <div
                            role="status"
                            className={cn(
                              buttonVariants({ variant: "ghost", size: "icon-sm" }),
                              "shrink-0 text-foreground opacity-100 hover:bg-surface-hover hover:text-foreground",
                            )}
                            onMouseDown={handleActionMouseDown}
                            aria-label={intl.formatMessage({
                              id: "workspaceSidebar.connecting",
                            })}
                          >
                            <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
                          </div>
                        </ReconnectingRemoteWorkspaceLogTooltip>
                      ) : (
                        <ControlHintTooltip
                          title={intl.formatMessage({
                            id: "workspaceSidebar.reconnect",
                          })}
                          side="right"
                          align="center"
                        >
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon-sm"
                            className="shrink-0 text-foreground opacity-100 hover:bg-surface-hover hover:text-foreground disabled:opacity-100"
                            onMouseDown={handleActionMouseDown}
                            onClick={handleReconnectRemoteWorkspace}
                            aria-label={intl.formatMessage({
                              id: "workspaceSidebar.reconnect",
                            })}
                          >
                            <RefreshCwIcon className="h-3.5 w-3.5" />
                          </Button>
                        </ControlHintTooltip>
                      )
                    ) : shouldMountWorkspaceRowActions ? (
                      <ControlHintTooltip
                        title={readOnlyReason ?? intl.formatMessage({ id: "taskList.newThread" })}
                      >
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-sm"
                          className="shrink-0 text-foreground-subtle hover:bg-surface-hover hover:text-foreground"
                          onMouseDown={handleActionMouseDown}
                          onClick={handleCreateThreadClick}
                          disabled={Boolean(readOnlyReason)}
                          aria-label={intl.formatMessage({
                            id: "taskList.newThread",
                          })}
                        >
                          <MessageCirclePlus className="h-3.5 w-3.5" />
                        </Button>
                      </ControlHintTooltip>
                    ) : null}
                  </div>
                </div>
              </div>
            </CollapsibleTrigger>
          </div>
        </BorderBeam>

        <CollapsibleContent>
          <TaskList
            workspacePath={tab.workspacePath}
            remoteSessionId={tab.remoteSessionId}
            workspaceIdentity={tab.workspaceIdentity}
            tasks={taskItems}
            pinnedTasks={EMPTY_PINNED_TASKS}
            activeTaskId={isActiveWorkspace ? activeTaskId : null}
            onSelectTask={handleSelectTask}
            showCreateButton={false}
            showFooter={false}
            loading={taskListLoading}
            hasMore={taskListHasMore}
            onShowMore={onShowMoreTasks}
            onRenameTask={handleRenameTask}
            onSetTaskPinned={handleSetTaskPinned}
            onArchiveTask={handleArchiveTask}
            onSetTaskUnread={handleSetTaskUnread}
            readOnlyReason={readOnlyReason}
          />
        </CollapsibleContent>
      </Collapsible>
      <RemoteSyncDialogs
        canSyncSkills={showRemoteSkillSyncAction}
        canSyncMcp={showRemoteSkillSyncAction}
        canSyncPlugins={showRemoteSkillSyncAction}
        skillOpen={remoteSkillSyncOpen}
        mcpOpen={remoteMcpSyncOpen}
        pluginOpen={remotePluginSyncOpen}
        onSkillOpenChange={setRemoteSkillSyncOpen}
        onMcpOpenChange={setRemoteMcpSyncOpen}
        onPluginOpenChange={setRemotePluginSyncOpen}
        localSkillSyncService={baseServices.skillSyncService}
        remoteSkillSyncService={services.skillSyncService}
        localMcpSyncService={baseServices.mcpSyncService}
        remoteMcpSyncService={services.mcpSyncService}
        localPluginSyncService={baseServices.pluginSyncService}
        remotePluginSyncService={services.pluginSyncService}
        localZCodeAgentService={baseServices.zcodeAgentService}
        remoteZCodeAgentService={services.zcodeAgentService}
        remoteTarget={tab.remoteTarget}
        skillWorkspacePath={tab.workspacePath}
        mcpWorkspacePath={tab.workspacePath}
        pluginWorkspacePath={tab.workspacePath}
        pluginLocalWorkspacePath={tab.localWorkspacePath}
        mcpLocalWorkspacePath={tab.localWorkspacePath}
        workspaceIdentity={tab.workspaceIdentity}
        onSkillsSynced={async () => {
          await invalidateDeferredDraftSessionForSkillChange({
            zcodeSessionService: services.zcodeSessionService,
            workspacePath: tab.workspacePath,
            workspaceIdentity: tab.workspaceIdentity,
            reason: "sidebar-remote-skill-sync",
          });
          await refreshSharedSkillStoreForWorkspace({
            workspacePath: tab.workspacePath,
            workspaceIdentity: tab.workspaceIdentity,
            skillsService: services.skillsService,
          });
        }}
        onMcpSynced={async () => {
          await useMcpStore
            .getState()
            .ensureLoadedForWorkspace(
              tab.workspacePath,
              services.mcpSyncService,
              tab.workspaceIdentity,
            );
        }}
        onPluginsSynced={async () => {
          await refreshWorkspacePluginCapabilitiesAfterRemoteSync({
            commandsService: services.commandsService,
            mcpSyncService: services.mcpSyncService,
            reason: "sidebar-remote-plugin-sync",
            skillsService: services.skillsService,
            workspaceIdentity: tab.workspaceIdentity,
            workspacePath: tab.workspacePath,
            zcodeAgentService: services.zcodeAgentService,
            zcodeSessionService: services.zcodeSessionService,
          });
        }}
      />
    </li>
  );
});
WorkspaceSidebarItem.displayName = "WorkspaceSidebarItem";
