/* eslint-disable max-lines -- TaskList also carries workspace list rendering, inline actions, and
 * external data source compatibility; collecting it in one place first prevents the UI structure
 * from drifting.
 */
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Settings2 } from "lucide-react";
import type { ZCodeTaskMeta } from "@zcode/shared";
import { TID_TASK_LIST, TID_TASK_EMPTY, TID_TASK_SETTINGS_BUTTON } from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { ContextMenu, ContextMenuTrigger } from "@/components/ui/context-menu.js";
import { toast } from "@/components/ui/toast.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useZCodeSessionStore } from "@/store/zcodeSessionStore.js";
import { NewTaskButtonGroup } from "@/NewTaskButtonGroup.js";
import { useTabStore } from "@/store/TabStoreProvider.js";
import { MemoTaskItem, TaskListItemContextMenuContent } from "@/TaskListItem.js";
import { TaskListLoadingHint } from "@/TaskListLoadingHint.js";
import { TaskRenameDialog } from "@/TaskRenameDialog.js";
import { buildTaskWorkspaceKey } from "@/lib/taskQueryCache.js";
import { compareZCodeTaskListItems } from "@/lib/taskListOrdering.js";
import { logger } from "@/logger.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";

export { deriveTaskLeadingIndicator } from "@/lib/taskListItemPresentation.js";

// [] in the default parameters will create a new array every time TaskList render;
// This amplifies the equivalent data judgment cost of the memo subcomponent during task flow refresh.
const EMPTY_PINNED_TASKS: ZCodeTaskMeta[] = [];

// The parent App/Shell may be re-rendered due to stream state updates, but the list props themselves remain unchanged.
// TaskList first uses the entire memo to avoid irrelevant parent renders from re-traversing the tasks and triggering the calculation of MemoTaskItem props.
export const TaskList = memo(function TaskList({
  workspacePath,
  remoteSessionId,
  workspaceIdentity,
  tasks,
  pinnedTasks = EMPTY_PINNED_TASKS,
  activeTaskId,
  sortBy = "manual",
  isWorkspaceActive = true,
  onSelectTask,
  showCreateButton = true,
  showFooter = true,
  showEmptyState = true,
  loading: inputLoading,
  hasMore = false,
  onShowMore,
  onRenameTask,
  onSetTaskPinned,
  onArchiveTask,
  onSetTaskUnread,
  readOnlyReason,
}: {
  workspacePath: string;
  remoteSessionId?: string;
  workspaceIdentity?: string;
  tasks: ZCodeTaskMeta[];
  pinnedTasks?: ZCodeTaskMeta[];
  activeTaskId: string | null;
  sortBy?: "manual" | "created" | "updated";
  isWorkspaceActive?: boolean;
  onSelectTask: (taskId: string) => void;
  showCreateButton?: boolean;
  showFooter?: boolean;
  showEmptyState?: boolean;
  loading?: boolean;
  hasMore?: boolean;
  onShowMore?: () => void;
  onRenameTask: (taskId: string, title: string) => Promise<ZCodeTaskMeta | null>;
  onSetTaskPinned: (taskId: string, pinned: boolean) => Promise<ZCodeTaskMeta | null>;
  onArchiveTask: (taskId: string) => Promise<ZCodeTaskMeta | null>;
  onSetTaskUnread: (taskId: string, unread: boolean) => Promise<ZCodeTaskMeta | null>;
  readOnlyReason?: string;
}) {
  const { intl } = useZCodeIntl();
  const pinnedTaskIdSet = useMemo(
    () => new Set(pinnedTasks.map((task) => task.taskId)),
    [pinnedTasks],
  );
  const taskLookup = useMemo(() => [...tasks, ...pinnedTasks], [pinnedTasks, tasks]);
  const startDraft = useZCodeSessionStore((state) => state.startDraft);
  const openSettingsTab = useTabStore((state) => state.openSettingsTab);
  const [pendingArchiveTaskId, setPendingArchiveTaskId] = useState<string | null>(null);
  const [renamingTaskId, setRenamingTaskId] = useState<string | null>(null);
  const [contextMenuTaskId, setContextMenuTaskId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const renameInputRef = useRef<HTMLInputElement | null>(null);
  const pendingArchiveTaskIdRef = useRef<string | null>(pendingArchiveTaskId);
  const renamingTaskIdRef = useRef<string | null>(renamingTaskId);
  const onSelectTaskRef = useRef(onSelectTask);
  const onSetTaskPinnedRef = useRef(onSetTaskPinned);
  const onArchiveTaskRef = useRef(onArchiveTask);
  const onSetTaskUnreadRef = useRef(onSetTaskUnread);
  pendingArchiveTaskIdRef.current = pendingArchiveTaskId;
  renamingTaskIdRef.current = renamingTaskId;
  onSelectTaskRef.current = onSelectTask;
  onSetTaskPinnedRef.current = onSetTaskPinned;
  onArchiveTaskRef.current = onArchiveTask;
  onSetTaskUnreadRef.current = onSetTaskUnread;
  const handleCancelArchiveConfirm = useCallback(() => {
    setPendingArchiveTaskId(null);
  }, []);

  const handleCancelRenameTask = useCallback(() => {
    setRenamingTaskId(null);
    setRenameDraft("");
  }, []);

  const handleSelectTaskItem = useCallback((taskId: string) => {
    onSelectTaskRef.current(taskId);
  }, []);
  const handleOpenTaskContextMenu = useCallback((taskId: string) => {
    // Previously, each task row had a Radix ContextMenu root/trigger resident.
    // Now row only reports the target task, and the real menu tree is mounted by a list-level singleton to avoid the cost of amplifying Popper/MenuProvider by row in a large session.
    if (pendingArchiveTaskIdRef.current === taskId) {
      setPendingArchiveTaskId(null);
    }
    setContextMenuTaskId(taskId);
  }, []);

  const handleCreateTask = useCallback(() => {
    if (readOnlyReason) {
      return;
    }
    // If you create a new session and createTask immediately when the button is clicked, the "empty task" will also be persisted to the list.
    // The user just wants to open the input box first, but there will be an extra record without any message in the sidebar.
    // Here it is changed to enter the workspace level draft state, and the task will be automatically created when the user actually sends the first message.
    startDraft(workspacePath, undefined, workspaceIdentity, { createSource: "project" });
  }, [readOnlyReason, startDraft, workspaceIdentity, workspacePath]);

  const handleArchiveTaskFromInline = useCallback(
    async (e: React.MouseEvent, taskId: string) => {
      e.stopPropagation();
      if (readOnlyReason) {
        return;
      }
      if (renamingTaskIdRef.current) {
        handleCancelRenameTask();
      }

      if (pendingArchiveTaskIdRef.current !== taskId) {
        // The sidebar hover action is now changed to "Archive Task", but it will still make the task disappear from the current list immediately.
        // If the first click is executed directly, it is easy for users to mistakenly click "temporarily close" as "why the entire task is gone".
        // Here it is changed to "the first click enters the pending confirmation state, the second click confirms in place", which retains the protection and does not leave the current context.
        setPendingArchiveTaskId(taskId);
        return;
      }

      setPendingArchiveTaskId(null);
      await onArchiveTaskRef.current(taskId);
    },
    [handleCancelRenameTask, readOnlyReason],
  );

  const handleStartRenameTask = useCallback(
    (taskId: string, currentTitle: string) => {
      if (readOnlyReason) {
        return;
      }
      logger.info("[TaskList] rename start", {
        taskId,
        workspacePath,
        workspaceIdentity,
        titleLength: currentTitle.length,
      });
      setPendingArchiveTaskId(null);
      setRenamingTaskId(taskId);
      setRenameDraft(currentTitle ?? "");
    },
    [readOnlyReason, workspaceIdentity, workspacePath],
  );

  const handleTogglePinTask = useCallback(
    async (taskId: string, pinned: boolean) => {
      if (readOnlyReason) {
        return;
      }
      const updatedTask = await onSetTaskPinnedRef.current(taskId, pinned);
      if (!updatedTask) {
        return;
      }
    },
    [readOnlyReason],
  );

  const handleArchiveTask = useCallback(
    async (taskId: string) => {
      if (readOnlyReason) {
        return;
      }
      setPendingArchiveTaskId(null);
      handleCancelRenameTask();
      await onArchiveTaskRef.current(taskId);
    },
    [handleCancelRenameTask, readOnlyReason],
  );

  const handleSubmitRenameTask = useCallback(
    async (taskId: string) => {
      if (readOnlyReason) {
        return;
      }
      logger.info("[TaskList] rename submit entered", {
        taskId,
        workspacePath,
        workspaceIdentity,
        draftLength: renameDraft.length,
        trimmedLength: renameDraft.trim().length,
        taskCount: taskLookup.length,
      });
      const task = taskLookup.find((candidate) => candidate.taskId === taskId);
      if (!task) {
        logger.warn("[TaskList] rename submit task missing", {
          taskId,
          workspacePath,
          workspaceIdentity,
        });
        handleCancelRenameTask();
        return;
      }

      const normalizedTitle = renameDraft.trim();
      if (normalizedTitle === task.title.trim()) {
        logger.info("[TaskList] rename submit unchanged", {
          taskId,
          workspacePath,
          workspaceIdentity,
          titleLength: normalizedTitle.length,
        });
        handleCancelRenameTask();
        return;
      }

      // If the task title directly retains the leading and trailing spaces entered by the user, the list will look like "misaligned" or "the title is missing".
      // However, the actual persistent content has changed, making it difficult to reproduce in subsequent investigations. Here, trim is unified before submission to ensure consistent display and storage.
      logger.info("[TaskList] rename submit calling onRenameTask", {
        taskId,
        workspacePath,
        workspaceIdentity,
        previousTitleLength: task.title.length,
        nextTitleLength: normalizedTitle.length,
      });
      let renamedTask: ZCodeTaskMeta | null;
      try {
        renamedTask = await onRenameTask(taskId, normalizedTitle);
      } catch (error) {
        logger.error("[TaskList] rename submit onRenameTask rejected", {
          taskId,
          workspacePath,
          workspaceIdentity,
          message: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
      logger.info("[TaskList] rename submit onRenameTask resolved", {
        taskId,
        workspacePath,
        workspaceIdentity,
        resolved: Boolean(renamedTask),
        resolvedTitleLength: renamedTask?.title.length,
      });
      if (!renamedTask) {
        logger.warn("[TaskList] rename submit returned empty meta", {
          taskId,
          workspacePath,
          workspaceIdentity,
        });
        toast(intl.formatMessage({ id: "taskList.renameFailed" }));
        return;
      }

      handleCancelRenameTask();
      logger.info("[TaskList] rename submit dialog closed", {
        taskId,
        workspacePath,
        workspaceIdentity,
      });
    },
    [
      handleCancelRenameTask,
      intl,
      onRenameTask,
      readOnlyReason,
      renameDraft,
      taskLookup,
      workspaceIdentity,
      workspacePath,
    ],
  );

  const handleMarkTaskAsUnread = useCallback(
    (taskId: string) => {
      if (readOnlyReason) {
        return;
      }
      void onSetTaskUnreadRef.current(taskId, true);
    },
    [readOnlyReason],
  );

  useEffect(() => {
    if (!renamingTaskId) {
      return;
    }

    renameInputRef.current?.focus();
    renameInputRef.current?.select();
  }, [renamingTaskId]);

  const visibleSourceTasks = useMemo(() => {
    const orderedTasks =
      sortBy === "manual"
        ? tasks
        : [...tasks].sort((left, right) => compareZCodeTaskListItems(left, right, sortBy));
    return orderedTasks;
  }, [sortBy, tasks]);
  useEffect(() => {
    if (!pendingArchiveTaskId) {
      return;
    }

    const stillExists = visibleSourceTasks.some((task) => task.taskId === pendingArchiveTaskId);
    if (!stillExists) {
      setPendingArchiveTaskId(null);
    }
  }, [pendingArchiveTaskId, visibleSourceTasks]);

  useEffect(() => {
    if (!renamingTaskId) {
      return;
    }

    const stillExists = visibleSourceTasks.some((task) => task.taskId === renamingTaskId);
    if (!stillExists) {
      handleCancelRenameTask();
    }
  }, [handleCancelRenameTask, renamingTaskId, visibleSourceTasks]);

  useEffect(() => {
    if (!contextMenuTaskId) {
      return;
    }

    const stillExists = visibleSourceTasks.some((task) => task.taskId === contextMenuTaskId);
    if (!stillExists) {
      setContextMenuTaskId(null);
    }
  }, [contextMenuTaskId, visibleSourceTasks]);

  const contextMenuTask = useMemo(
    () =>
      contextMenuTaskId
        ? (taskLookup.find((task) => task.taskId === contextMenuTaskId) ?? null)
        : null,
    [contextMenuTaskId, taskLookup],
  );

  function renderTaskItem(task: (typeof visibleSourceTasks)[number]) {
    const isPinned = pinnedTaskIdSet.has(task.taskId);
    return (
      <MemoTaskItem
        key={task.taskId}
        workspacePath={workspacePath}
        remoteSessionId={remoteSessionId}
        task={task}
        isPinned={isPinned}
        isActive={isWorkspaceActive && task.taskId === activeTaskId}
        isMobileActive={false}
        onSelectTask={handleSelectTaskItem}
        onArchiveTaskInline={handleArchiveTaskFromInline}
        onCancelArchiveConfirm={handleCancelArchiveConfirm}
        isArchiveConfirming={pendingArchiveTaskId === task.taskId}
        onTogglePinTask={handleTogglePinTask}
        onStartRenameTask={handleStartRenameTask}
        onArchiveTask={handleArchiveTask}
        onMarkTaskAsUnread={handleMarkTaskAsUnread}
        onOpenTaskContextMenu={handleOpenTaskContextMenu}
        actionsDisabled={Boolean(readOnlyReason)}
        actionsDisabledReason={readOnlyReason}
        intl={intl}
      />
    );
  }

  return (
    <div data-testid={TID_TASK_LIST} className={"flex flex-col gap-2"}>
      {renamingTaskId !== null ? (
        <TaskRenameDialog
          open
          value={renameDraft}
          inputRef={renameInputRef}
          intl={intl}
          onOpenChange={(open) => {
            if (!open) {
              handleCancelRenameTask();
            }
          }}
          onChange={setRenameDraft}
          onCancel={handleCancelRenameTask}
          onConfirm={() => {
            logger.info("[TaskList] rename confirm dispatched", {
              renamingTaskId,
              workspacePath,
              workspaceIdentity,
              draftLength: renameDraft.length,
            });
            if (!renamingTaskId) {
              return;
            }
            void handleSubmitRenameTask(renamingTaskId);
          }}
        />
      ) : null}

      {showCreateButton ? (
        <div className="border-b p-3">
          <ControlHintTooltip
            title={readOnlyReason ?? intl.formatMessage({ id: "taskList.newThread" })}
          >
            <div>
              <NewTaskButtonGroup
                onCreateTask={handleCreateTask}
                disabled={Boolean(readOnlyReason)}
              />
            </div>
          </ControlHintTooltip>
        </div>
      ) : null}

      {/* Task list */}
      <div>
        <div className="space-y-1">
          {Boolean(inputLoading) && visibleSourceTasks.length === 0 ? (
            <TaskListLoadingHint />
          ) : visibleSourceTasks.length === 0 ? (
            showEmptyState ? (
              <div
                data-testid={TID_TASK_EMPTY}
                className="px-8.5 py-2 text-ui-base text-foreground-subtlest"
              >
                {intl.formatMessage({ id: "taskList.noTasks" })}
              </div>
            ) : null
          ) : (
            <ContextMenu
              onOpenChange={(open) => {
                if (!open) {
                  setContextMenuTaskId(null);
                }
              }}
            >
              <ContextMenuTrigger asChild>
                <ul className="space-y-0.5">{visibleSourceTasks.map(renderTaskItem)}</ul>
              </ContextMenuTrigger>
              {contextMenuTask ? (
                <TaskListItemContextMenuContent
                  workspacePath={workspacePath}
                  remoteSessionId={remoteSessionId}
                  task={contextMenuTask}
                  isPinned={pinnedTaskIdSet.has(contextMenuTask.taskId)}
                  intl={intl}
                  onTogglePinTask={handleTogglePinTask}
                  onStartRenameTask={handleStartRenameTask}
                  onArchiveTask={handleArchiveTask}
                  onMarkTaskAsUnread={handleMarkTaskAsUnread}
                  disableTaskActions={Boolean(readOnlyReason)}
                  disabledReason={readOnlyReason}
                />
              ) : null}
            </ContextMenu>
          )}
        </div>
        {hasMore && onShowMore ? (
          <div className="cursor-pointer pl-8.5">
            <span
              className="text-ui-base text-foreground-subtlest hover:text-foreground-subtle"
              onClick={onShowMore}
            >
              {intl.formatMessage({ id: "taskList.showMore" })}
            </span>
          </div>
        ) : null}
      </div>

      {showFooter ? (
        <div className="border-t border-outline/40 p-3">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={openSettingsTab}
            data-testid={TID_TASK_SETTINGS_BUTTON}
            className="w-full justify-center"
          >
            <Settings2 className="h-3.5 w-3.5" />
            {intl.formatMessage({ id: "taskList.openSettings" })}
          </Button>
        </div>
      ) : null}
    </div>
  );
});

TaskList.displayName = "TaskList";
