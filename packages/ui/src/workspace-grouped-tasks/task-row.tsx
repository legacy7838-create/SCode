/* eslint-disable max-lines -- the grouped row carries both the drag overlay and the regular
 * interactions, and the status badge has to share the same rendering semantics.
 */
import { memo, useState } from "react";
import type { KeyboardEvent, MouseEvent } from "react";
import { useDraggable, useDroppable } from "@dnd-kit/core";
import type { UniqueIdentifier } from "@dnd-kit/core";
import { isCronTask, isOffPeakTask, type ZCodeTaskMeta } from "@zcode/shared";
import { ArrowUpToLine, Clock, Cloud, Folder, ListTree, LoaderIcon, Moon, X } from "lucide-react";
import { cn } from "@/components/lib/utils.js";
import { Badge } from "@/components/ui/badge.js";
import { toast } from "@/components/ui/toast.js";
import { ContextMenu, ContextMenuTrigger } from "@/components/ui/context-menu.js";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  deriveTaskLeadingIndicator,
  formatTaskRelativeTime,
} from "@/lib/taskListItemPresentation.js";
import { getTaskChangeSummary } from "@/lib/taskChangeSummary.js";
import { buildTaskWorkspaceKey } from "@/lib/taskQueryCache.js";
import { buildTaskFeedbackDescription } from "@/lib/taskFeedbackDraft.js";
import { useTaskListItemContextActions } from "@/useTaskListItemContextActions.js";
import { useFeedbackStore } from "@/feedback/feedbackStore.js";
import { getTaskListAttention, getTaskListRowActivity } from "@/v4/taskListRowActivity.js";
import { GroupedTaskContextMenuContent } from "@/workspace-grouped-tasks/task-context-menu-content.js";
import { TaskRowActionButton } from "@/workspace-grouped-tasks/task-row-action-button.js";
import { TaskInteractionBadge } from "@/TaskInteractionBadge.js";
import { formatGroupedTaskHoverChangeParts } from "@/workspace-grouped-tasks/task-row-tooltip.js";
import {
  TASK_GROUP_ROW_CLASS,
  TASK_GROUP_ROW_LINE_CLASS,
  type TaskGroupMenuItem,
} from "@/workspace-grouped-tasks/types.js";
import { TaskWorkflowRunLines } from "@/components/workflow-run-line/TaskWorkflowRunLines.js";
import { useTaskInteractionAutoResolutionSnooze } from "@/hooks/useTaskInteractionAutoResolutionSnooze.js";
import { useOptionalTabStore } from "@/store/TabStoreProvider.js";
import { isWorkspaceReadOnly } from "@/store/tabStore.js";
import { TaskTitleOverflowText } from "@/components/TaskTitleOverflowText.js";

function GroupedTaskRowComponent({
  task,
  currentGroupId,
  groups,
  remoteSessionId,
  activeWorkspacePath,
  activeWorkspaceIdentity,
  activeTaskId,
  workspaceLabel,
  onSelectTask,
  onCloseTask,
  onOpenFileTree,
  onMoveTaskToGroup,
  onMoveTaskToTop,
  onStartRenameTask,
  onArchiveTask,
  onMarkTaskAsUnread,
  dragId,
  dragging,
  dragOverlay,
  tooltipsDisabled,
}: {
  task: ZCodeTaskMeta;
  currentGroupId?: string;
  groups: TaskGroupMenuItem[];
  remoteSessionId?: string;
  activeWorkspacePath: string;
  activeWorkspaceIdentity?: string;
  activeTaskId: string | null;
  workspaceLabel: string;
  onSelectTask: (workspacePath: string, taskId: string, workspaceIdentity?: string) => void;
  onCloseTask: (task: ZCodeTaskMeta) => void;
  onOpenFileTree?: (task: ZCodeTaskMeta) => void;
  onMoveTaskToGroup: (task: ZCodeTaskMeta, groupId: string | null) => void;
  onMoveTaskToTop: (task: ZCodeTaskMeta) => void;
  onStartRenameTask: (task: ZCodeTaskMeta) => void;
  onArchiveTask: (task: ZCodeTaskMeta) => void;
  onMarkTaskAsUnread: (task: ZCodeTaskMeta) => void;
  dragId?: UniqueIdentifier;
  dragging?: boolean;
  dragOverlay?: boolean;
  tooltipsDisabled?: boolean;
}) {
  const { intl } = useZCodeIntl();
  const workspaceActionsDisabled = useOptionalTabStore((state) =>
    isWorkspaceReadOnly(state, task.workspacePath, task.workspaceIdentity),
  );
  const workspaceActionsDisabledReason = workspaceActionsDisabled
    ? intl.formatMessage({ id: "workspaceSidebar.unavailableLocalDirectory" })
    : undefined;
  const snoozeInteractionAutoResolution = useTaskInteractionAutoResolutionSnooze({
    workspacePath: task.workspacePath,
    ...(task.workspaceIdentity ? { workspaceIdentity: task.workspaceIdentity } : {}),
    ...(remoteSessionId ? { remoteSessionId } : {}),
    sessionId: task.taskId,
  });
  const workspaceKey = buildTaskWorkspaceKey(task.workspacePath, task.workspaceIdentity);
  const taskActivity = getTaskListRowActivity(task);
  const taskAttention = getTaskListAttention(task);
  // The interaction capsule is the current highest priority right-hand state; whether from the sessions-index summary or
  // activity attention, should no longer display relative times side by side and squeeze task titles.
  const hasPendingInteraction = Boolean(task.pendingInteraction) || taskAttention !== null;
  // Opening the file tree when the remote session is not ready will inevitably be rejected by the resolver, so do not expose it
  // Invalid action; the local task does not require remoteSessionId, and the entry is still available.
  const canOpenFileTree =
    Boolean(onOpenFileTree) && (!task.workspaceIdentity?.trim() || Boolean(remoteSessionId));
  const taskAttentionLabel = taskAttention
    ? intl.formatMessage({
        id: taskAttention.kind === "userInput" ? "taskList.userInputTag" : "taskList.permissionTag",
      })
    : null;
  const taskAttentionDisplay =
    taskAttention && taskAttentionLabel && taskAttention.count > 1
      ? intl.formatMessage(
          { id: "taskList.attentionCount" },
          { label: taskAttentionLabel, count: String(taskAttention.count) },
        )
      : taskAttentionLabel;
  const leadingIndicator = deriveTaskLeadingIndicator(task, taskActivity);
  const taskTitle =
    task.title ||
    intl.formatMessage({
      id: task.forkedFromTaskId ? "taskList.forkedUntitled" : "taskList.untitled",
    });
  const taskChangeParts = formatGroupedTaskHoverChangeParts(getTaskChangeSummary(task));
  const taskTimeLabel = formatTaskRelativeTime(task.updatedAt, intl);
  const isTaskCron = isCronTask(task);
  // Moon identity is changed to persistent meta tag judgment; off-peak store reverse check will be lost after the task is deleted
  // Session traceability, and let each row carry an additional global store subscription.
  const isTaskOffPeak = isOffPeakTask(task);
  const isActive =
    buildTaskWorkspaceKey(activeWorkspacePath, activeWorkspaceIdentity) === workspaceKey &&
    activeTaskId === task.taskId;
  const isMobileActive = false;
  const statusDotClassName =
    leadingIndicator === "error"
      ? "bg-destructive"
      : leadingIndicator === "unread"
        ? // The unread points of the grouped task need to share the sky color with the ordinary task list to prevent the brand color from drifting under different themes.
          "bg-sky-500 dark:bg-sky-400"
        : null;
  const canShowHoverActions = !dragOverlay;
  // Workflow running line: the grouping line is also long under the title;
  // The drag overlay is purely for display and does not involve confirmation side effects or click entry.
  const workflowRunLinesNode =
    taskActivity?.workflowActivity && !dragOverlay ? (
      <TaskWorkflowRunLines
        activity={taskActivity.workflowActivity}
        isActive={isActive}
        intl={intl}
        session={{
          workspacePath: task.workspacePath,
          ...(task.workspaceIdentity ? { workspaceIdentity: task.workspaceIdentity } : {}),
          sessionId: task.taskId,
        }}
      />
    ) : null;

  const taskRow = (
    <div
      role={dragOverlay ? undefined : "button"}
      tabIndex={dragOverlay ? undefined : 0}
      data-mobile-active-task={!dragOverlay && isMobileActive ? "true" : undefined}
      className={cn(
        "group/task-row",
        TASK_GROUP_ROW_CLASS,
        dragOverlay
          ? "pointer-events-none cursor-grabbing border border-border bg-background shadow-lg opacity-100"
          : "cursor-pointer",
        isActive ? "bg-selected" : canShowHoverActions && "hover:bg-surface-hover",
        dragging && "opacity-0",
      )}
    >
      <span className={TASK_GROUP_ROW_LINE_CLASS}>
        <TaskTitleOverflowText
          as="span"
          className="text-foreground"
          title={dragOverlay ? undefined : taskTitle}
        >
          {/* When a grouped task title overflows, do not show an ellipsis; the fade-out on the right preserves the continuity of the title and avoids crowding it against the status meta on the right.*/}
          {taskTitle}
        </TaskTitleOverflowText>
        <span className="ml-auto flex shrink-0 items-center gap-1.5 text-ui-sm text-foreground-subtle">
          {task.pendingInteraction ? (
            <TaskInteractionBadge
              interaction={task.pendingInteraction}
              formatMessage={(id) => intl.formatMessage({ id })}
              onSnoozeCountdown={dragOverlay ? undefined : snoozeInteractionAutoResolution}
            />
          ) : taskAttentionDisplay ? (
            <Badge
              className={cn(
                "h-5 border-transparent bg-success/14 px-2 text-ui-base font-medium text-success dark:bg-success/18",
                canShowHoverActions && "group-hover/task-row:hidden",
              )}
            >
              {taskAttentionDisplay}
            </Badge>
          ) : null}
          <span
            className={cn(
              "flex shrink-0 items-center gap-1",
              canShowHoverActions && "group-hover/task-row:hidden",
            )}
          >
            {leadingIndicator === "loading" ? (
              <LoaderIcon className="size-3.5 animate-spin text-foreground-subtle" />
            ) : statusDotClassName ? (
              <span aria-hidden="true" className="flex size-4 shrink-0 items-center justify-center">
                <span className={cn("size-1.5 rounded-full", statusDotClassName)} />
              </span>
            ) : null}
            {!hasPendingInteraction && isTaskCron ? (
              // Drag overlay also reuses grouped row meta-information; clock is placed in front of the time and cannot be mutually exclusive with unread points.
              <Clock
                data-cron-task-icon="true"
                aria-label={intl.formatMessage({ id: "taskList.cronTaskLabel" })}
                className="size-3.5 shrink-0"
              />
            ) : !hasPendingInteraction && isTaskOffPeak ? (
              <Moon
                data-off-peak-task-icon="true"
                aria-label={intl.formatMessage({ id: "taskList.offPeakTaskLabel" })}
                className="size-3.5 shrink-0"
              />
            ) : null}
            {!hasPendingInteraction ? <span className="mr-1">{taskTimeLabel}</span> : null}
          </span>
        </span>
      </span>
    </div>
  );

  // DragOverlay only returns pure display nodes during high-frequency rendering to avoid hiding the Radix ref loop and task path RPC of the action tooltip.
  if (dragOverlay) return taskRow;

  const [contextMenuOpen, setContextMenuOpen] = useState(false);
  const [taskRowHovered, setTaskRowHovered] = useState(false);
  const [taskRowFocusWithin, setTaskRowFocusWithin] = useState(false);
  const [isHoverNone] = useState(
    () =>
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(hover: none)").matches,
  );
  const openFeedbackSubmit = useFeedbackStore((state) => state.openSubmit);
  const {
    taskSessionFile,
    taskNativeSessionLogFile,
    fileManagerLabel,
    handleCopyText,
    handleOpenTaskPathInFileManager,
  } = useTaskListItemContextActions({
    workspacePath: task.workspacePath,
    remoteSessionId,
    workspaceIdentity: task.workspaceIdentity,
    taskId: task.taskId,
    provider: task.provider,
    intl,
    loadTaskPaths: contextMenuOpen,
  });
  const handleSelect = () => {
    onSelectTask(task.workspacePath, task.taskId, task.workspaceIdentity);
  };
  const handleCloseTask = (event: MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    if (workspaceActionsDisabled) {
      return;
    }
    onCloseTask(task);
  };
  const handleOpenFileTree = (event: MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    if (workspaceActionsDisabled) {
      return;
    }
    onOpenFileTree?.(task);
  };
  const handleMoveTaskToTop = (event: MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    if (workspaceActionsDisabled) {
      return;
    }
    onMoveTaskToTop(task);
  };
  const handleOpenTaskFeedback = async () => {
    openFeedbackSubmit({
      title: intl
        .formatMessage(
          { id: "feedback.submit.template.section.taskFeedbackTitle" },
          { title: taskTitle },
        )
        .slice(0, 80),
      type: "bug",
      module: "Agent Task Execution Failure",
      severity: "P2-Medium",
      includeLogs: false,
      description: buildTaskFeedbackDescription({
        taskTitle,
        taskId: task.taskId,
        workspacePath: task.workspacePath,
        taskSessionPath: taskSessionFile.path,
        taskLogPath: taskNativeSessionLogFile.path,
        formatMessage: (id: string, values?: Record<string, string>) =>
          intl.formatMessage({ id }, values),
      }),
      screenshots: [],
    });
    toast(intl.formatMessage({ id: "taskList.feedbackOpened" }));
  };
  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget) {
      return;
    }
    if (event.key !== "Enter" && event.key !== " ") {
      return;
    }
    event.preventDefault();
    handleSelect();
  };
  const dragDisabled = workspaceActionsDisabled || !dragId || contextMenuOpen || dragOverlay;
  const draggable = useDraggable({
    id: dragId ?? `disabled:${workspaceKey}:${task.taskId}`,
    disabled: dragDisabled,
    data: { type: "grouped-task", taskKey: dragId },
  });
  const droppable = useDroppable({
    id: dragId ?? `disabled-drop:${workspaceKey}:${task.taskId}`,
    disabled: workspaceActionsDisabled || !dragId || dragOverlay,
    data: { type: "grouped-task", taskKey: dragId },
  });

  const setTaskRowRef = (element: HTMLDivElement | null) => {
    draggable.setNodeRef(element);
    droppable.setNodeRef(element);
  };
  const groupedTaskDomKey = typeof dragId === "string" ? encodeURIComponent(dragId) : undefined;
  // CSS hidden → flex will cause the action trigger to get the layout size when the pointer arrives.
  // Tooltip Portal may be drawn first with unpositioned coordinates. Change to interactive state to determine whether the action is mounted.
  // At the same time, the entrance to the keyboard, touch device and mobile phone remote control active task is retained.
  const shouldMountHoverActions =
    !task.pendingInteraction &&
    (taskRowHovered || taskRowFocusWithin || isHoverNone || isMobileActive);
  // The touch screen side isHoverNone is only responsible for resident actions; time, status points and cron/off-peak meta information
  // It should still be retained and only give way during real hover / focus interactions to avoid permanent loss of task status on the mobile phone.
  const shouldSuppressTaskMetadata = taskRowHovered || taskRowFocusWithin;

  const interactiveTaskRow = (
    <div
      ref={setTaskRowRef}
      {...draggable.attributes}
      {...draggable.listeners}
      role="button"
      tabIndex={0}
      onClick={handleSelect}
      onKeyDown={handleKeyDown}
      onMouseEnter={() => setTaskRowHovered(true)}
      onMouseLeave={() => setTaskRowHovered(false)}
      onFocusCapture={() => setTaskRowFocusWithin(true)}
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
          setTaskRowFocusWithin(false);
        }
      }}
      data-grouped-task-key={groupedTaskDomKey}
      data-mobile-active-task={isMobileActive ? "true" : undefined}
      className={cn(
        "group/task-row",
        TASK_GROUP_ROW_CLASS,
        "cursor-pointer",
        isActive ? "bg-selected" : "hover:bg-surface-hover",
        dragging && "opacity-0",
      )}
    >
      <span className={TASK_GROUP_ROW_LINE_CLASS}>
        <TaskTitleOverflowText as="span" className="text-foreground" title={taskTitle}>
          {/* When a grouped task title overflows, do not show an ellipsis; the fade-out on the right preserves the continuity of the title and avoids crowding it against the status meta on the right.*/}
          {taskTitle}
        </TaskTitleOverflowText>
        <span className="ml-auto flex shrink-0 items-center gap-1.5 text-ui-sm text-foreground-subtle">
          {task.pendingInteraction ? (
            <TaskInteractionBadge
              interaction={task.pendingInteraction}
              formatMessage={(id) => intl.formatMessage({ id })}
              onSnoozeCountdown={snoozeInteractionAutoResolution}
            />
          ) : taskAttentionDisplay && !shouldSuppressTaskMetadata ? (
            <Badge className="h-5 border-transparent bg-success/14 px-2 text-ui-base font-medium text-success dark:bg-success/18">
              {taskAttentionDisplay}
            </Badge>
          ) : null}
          {!shouldSuppressTaskMetadata ? (
            <span className="flex shrink-0 items-center gap-1">
              {leadingIndicator === "loading" ? (
                <LoaderIcon className="size-3.5 animate-spin text-foreground-subtle" />
              ) : statusDotClassName ? (
                <span
                  aria-hidden="true"
                  className="flex size-4 shrink-0 items-center justify-center"
                >
                  <span className={cn("size-1.5 rounded-full", statusDotClassName)} />
                </span>
              ) : null}
              {!hasPendingInteraction && isTaskCron ? (
                // The interactive grouped row missed the rendering clock before, causing the scheduled tasks in the Projects group to have no icon.
                // This is placed in front of the time just like the normal task list, and is no longer pushed out by the unread/running status.
                <Clock
                  data-cron-task-icon="true"
                  aria-label={intl.formatMessage({ id: "taskList.cronTaskLabel" })}
                  className="size-3.5 shrink-0"
                />
              ) : !hasPendingInteraction && isTaskOffPeak ? (
                <Moon
                  data-off-peak-task-icon="true"
                  aria-label={intl.formatMessage({ id: "taskList.offPeakTaskLabel" })}
                  className="size-3.5 shrink-0"
                />
              ) : null}
              {!hasPendingInteraction ? <span className="mr-1">{taskTimeLabel}</span> : null}
            </span>
          ) : null}
          {shouldMountHoverActions ? (
            <span className="flex shrink-0 items-center gap-0.5">
              {canOpenFileTree ? (
                <TaskRowActionButton
                  label={intl.formatMessage({ id: "git.action.showTree" })}
                  onClick={handleOpenFileTree}
                  showTooltip
                  disabledReason={workspaceActionsDisabledReason}
                >
                  <ListTree className="size-3.5" />
                </TaskRowActionButton>
              ) : null}
              <TaskRowActionButton
                label={intl.formatMessage({ id: "taskGroup.moveToTop" })}
                onClick={handleMoveTaskToTop}
                showTooltip
                disabledReason={workspaceActionsDisabledReason}
              >
                <ArrowUpToLine className="size-3.5" />
              </TaskRowActionButton>
              <TaskRowActionButton
                label={intl.formatMessage({ id: "common.close" })}
                onClick={handleCloseTask}
                showTooltip
                disabledReason={workspaceActionsDisabledReason}
              >
                <X className="size-3.5" />
              </TaskRowActionButton>
            </span>
          ) : null}
        </span>
      </span>
      {workflowRunLinesNode}
    </div>
  );

  // Grouped row cannot use native buttons to host the entire row; there are also menu, close, file tree and other buttons in the row. The outer layer continues to use role=button to avoid nested buttons destroying the semantics of the keyboard and right-click menu.
  return (
    <ContextMenu onOpenChange={setContextMenuOpen}>
      {tooltipsDisabled ? (
        // When overlay is dragged, the real row under the pointer may still be recognized as hover by Radix, skipping the TooltipTrigger to avoid the underlying row or action from popping up a hover prompt.
        <ContextMenuTrigger asChild>{interactiveTaskRow}</ContextMenuTrigger>
      ) : (
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <ContextMenuTrigger asChild>{interactiveTaskRow}</ContextMenuTrigger>
            </TooltipTrigger>
            <TooltipContent side="right" align="center" sideOffset={6}>
              {remoteSessionId ? (
                <Cloud aria-hidden="true" className="size-3.5 shrink-0" />
              ) : (
                <Folder aria-hidden="true" className="size-3.5 shrink-0" />
              )}
              <span className="min-w-0 max-w-48 truncate">{workspaceLabel}</span>
              {taskChangeParts.length > 0 ? (
                <>
                  <span className="text-tooltip-foreground/60">·</span>
                  <span className="inline-flex shrink-0 items-center gap-1">
                    {taskChangeParts.map((part) => (
                      <span
                        key={part}
                        className={part.startsWith("+") ? "text-diff-added" : "text-diff-removed"}
                      >
                        {part}
                      </span>
                    ))}
                  </span>
                </>
              ) : null}
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      )}
      {contextMenuOpen ? (
        // The right-click menu content has Radix Presence/Portal, and the resident mount will trigger a nested update loop when dragging and rearranging; the content is only mounted when the menu is open, and lazy loading with the path avoids flushing the task path RPC during the dragging process.
        <GroupedTaskContextMenuContent
          task={task}
          currentGroupId={currentGroupId}
          groups={groups}
          intl={intl}
          fileManagerLabel={fileManagerLabel}
          taskSessionFile={taskSessionFile}
          taskNativeSessionLogFile={taskNativeSessionLogFile}
          onMoveTaskToGroup={onMoveTaskToGroup}
          onMoveTaskToTop={onMoveTaskToTop}
          onStartRenameTask={onStartRenameTask}
          onArchiveTask={onArchiveTask}
          onMarkTaskAsUnread={onMarkTaskAsUnread}
          onOpenTaskPathInFileManager={() => void handleOpenTaskPathInFileManager()}
          onCopyText={(label, text) => void handleCopyText(label, text)}
          onOpenTaskFeedback={() => void handleOpenTaskFeedback()}
          disabledReason={workspaceActionsDisabledReason}
        />
      ) : null}
    </ContextMenu>
  );
}
export const GroupedTaskRow = memo(GroupedTaskRowComponent);
