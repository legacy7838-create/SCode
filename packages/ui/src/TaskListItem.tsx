/* eslint-disable max-lines -- the task item carries the shared interaction for both the default
 * list layout and the timeline row layout, so keep the action chain in one place for now to avoid
 * archive/pin regressions.
 */
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Archive,
  Clock,
  CloudUpload,
  ListTree,
  LoaderIcon,
  Moon,
  Pin,
  Smartphone,
} from "lucide-react";
import { isCronTask, isOffPeakTask, type ZCodeTaskMeta } from "@zcode/shared";
import { TID_TASK_ARCHIVE, TID_TASK_ITEM, testId } from "@zcode/shared";
import { Badge } from "@/components/ui/badge.js";
import { Button } from "@/components/ui/button.js";
import { cn } from "@/components/lib/utils.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { getPathLeaf } from "@/lib/path.js";
import { formatTaskTitleWithChanges, getTaskChangeSummary } from "@/lib/taskChangeSummary.js";
import {
  deriveTaskLeadingIndicator,
  formatTaskRelativeTime,
} from "@/lib/taskListItemPresentation.js";
import { getTaskListAttention, getTaskListRowActivity } from "@/v4/taskListRowActivity.js";
import { TaskListItemContextMenu } from "@/TaskListItemContextMenu.js";
import { TaskInteractionBadge } from "@/TaskInteractionBadge.js";
import { useTaskListItemContextActions } from "@/useTaskListItemContextActions.js";
import { useFeedbackStore } from "@/feedback/feedbackStore.js";
import { useModelTrajectoryStore } from "@/store/modelTrajectoryStore.js";
import { buildTaskFeedbackDescription } from "@/lib/taskFeedbackDraft.js";
import { toast } from "@/components/ui/toast.js";
import { buildTaskWorkspaceKey } from "@/lib/taskQueryCache.js";
import { useV4SplitPaneEntry } from "@/v4/splitPaneEntryContext.js";
import { buildWorkbenchSessionKey, useWorkbenchGroupStore } from "@/v4/workbenchGroupStore.js";
import { useTaskInteractionAutoResolutionSnooze } from "@/hooks/useTaskInteractionAutoResolutionSnooze.js";
import {
  WORKBENCH_SESSION_DRAG_MIME,
  clearActiveWorkbenchSessionDragPayload,
  serializeWorkbenchSessionDragPayload,
  setActiveWorkbenchSessionDragPayload,
} from "@/v4/workbenchDragDrop.js";
import { useOptionalTabStore } from "@/store/TabStoreProvider.js";
import { isWorkspaceReadOnly } from "@/store/tabStore.js";
import { TaskTitleOverflowText } from "@/components/TaskTitleOverflowText.js";
import { createTaskWorkbenchDragPreview } from "@/lib/taskWorkbenchDragPreview.js";
import { runUserAction } from "@/lib/userActionTelemetry.js";
import { TaskRowActionButton } from "@/workspace-grouped-tasks/task-row-action-button.js";
import { TaskWorkflowRunLines } from "@/components/workflow-run-line/TaskWorkflowRunLines.js";

type TaskListItemIntl = {
  formatMessage: (desc: { id: string }, values?: Record<string, string>) => string;
};

interface TaskListItemProps {
  workspacePath: string;
  remoteSessionId?: string;
  task: ZCodeTaskMeta;
  isPinned: boolean;
  isActive: boolean;
  isMobileActive?: boolean;
  onSelectTask: (taskId: string) => void;
  onArchiveTaskInline: (e: React.MouseEvent, taskId: string) => void;
  onCancelArchiveConfirm: () => void;
  isArchiveConfirming: boolean;
  onTogglePinTask: (taskId: string, pinned: boolean) => void;
  onStartRenameTask: (taskId: string, currentTitle: string) => void;
  onArchiveTask: (taskId: string) => void;
  onMarkTaskAsUnread: (taskId: string) => void;
  onOpenTaskContextMenu?: (taskId: string) => void;
  onOpenFileTree?: (task: ZCodeTaskMeta) => void;
  variant?: "default" | "timeline";
  showPinAction?: boolean;
  intl: TaskListItemIntl;
  actionsDisabled?: boolean;
  actionsDisabledReason?: string;
}

function areJsonFieldsEqual(left: unknown, right: unknown) {
  return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
}

function getTaskAutomationIdentity(task: ZCodeTaskMeta): string | undefined {
  return task.cronAutomationId ?? (task as ZCodeTaskMeta & { automationId?: string }).automationId;
}

function areTaskListItemTaskFieldsEqual(left: ZCodeTaskMeta, right: ZCodeTaskMeta) {
  if (left === right) {
    return true;
  }

  return (
    left.taskId === right.taskId &&
    left.workspacePath === right.workspacePath &&
    left.workspaceIdentity === right.workspaceIdentity &&
    left.provider === right.provider &&
    left.title === right.title &&
    left.forkedFromTaskId === right.forkedFromTaskId &&
    left.updatedAt === right.updatedAt &&
    left.unreadAt === right.unreadAt &&
    getTaskAutomationIdentity(left) === getTaskAutomationIdentity(right) &&
    left.status === right.status &&
    areJsonFieldsEqual(left.pendingInteraction, right.pendingInteraction) &&
    areJsonFieldsEqual(getTaskListRowActivity(left), getTaskListRowActivity(right)) &&
    areJsonFieldsEqual(left.changeSummary, right.changeSummary)
  );
}

function areTaskListItemPropsEqual(left: TaskListItemProps, right: TaskListItemProps) {
  return (
    left.workspacePath === right.workspacePath &&
    left.remoteSessionId === right.remoteSessionId &&
    areTaskListItemTaskFieldsEqual(left.task, right.task) &&
    left.isPinned === right.isPinned &&
    left.isActive === right.isActive &&
    left.isMobileActive === right.isMobileActive &&
    left.isArchiveConfirming === right.isArchiveConfirming &&
    left.variant === right.variant &&
    left.showPinAction === right.showPinAction &&
    left.intl === right.intl &&
    left.actionsDisabled === right.actionsDisabled &&
    left.actionsDisabledReason === right.actionsDisabledReason &&
    left.onSelectTask === right.onSelectTask &&
    left.onArchiveTaskInline === right.onArchiveTaskInline &&
    left.onCancelArchiveConfirm === right.onCancelArchiveConfirm &&
    left.onTogglePinTask === right.onTogglePinTask &&
    left.onStartRenameTask === right.onStartRenameTask &&
    left.onArchiveTask === right.onArchiveTask &&
    left.onMarkTaskAsUnread === right.onMarkTaskAsUnread &&
    left.onOpenTaskContextMenu === right.onOpenTaskContextMenu &&
    left.onOpenFileTree === right.onOpenFileTree
  );
}

export const MemoTaskItem = memo(function TaskListItem({
  workspacePath,
  remoteSessionId,
  task,
  isPinned,
  isActive,
  isMobileActive = false,
  onSelectTask,
  onArchiveTaskInline,
  onCancelArchiveConfirm,
  isArchiveConfirming,
  onTogglePinTask,
  onOpenTaskContextMenu,
  onOpenFileTree,
  variant = "default",
  showPinAction = true,
  intl,
  actionsDisabled = false,
  actionsDisabledReason,
}: TaskListItemProps) {
  const [hoverActionsVisible, setHoverActionsVisible] = useState(false);
  const [focusActionsVisible, setFocusActionsVisible] = useState(false);
  const [isHoverNone] = useState(
    () =>
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(hover: none)").matches,
  );
  const itemRef = useRef<HTMLLIElement | null>(null);
  const workspaceActionsDisabled = useOptionalTabStore(
    (state) =>
      actionsDisabled || isWorkspaceReadOnly(state, task.workspacePath, task.workspaceIdentity),
  );
  const workspaceActionsDisabledReason = workspaceActionsDisabled
    ? (actionsDisabledReason ??
      intl.formatMessage({ id: "workspaceSidebar.unavailableLocalDirectory" }))
    : undefined;
  const snoozeInteractionAutoResolution = useTaskInteractionAutoResolutionSnooze({
    workspacePath,
    ...(task.workspaceIdentity ? { workspaceIdentity: task.workspaceIdentity } : {}),
    ...(remoteSessionId ? { remoteSessionId } : {}),
    sessionId: task.taskId,
  });

  useEffect(() => {
    if (!isArchiveConfirming) {
      return;
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        onCancelArchiveConfirm();
      }
    }

    function handlePointerDown(event: PointerEvent) {
      const target = event.target;
      if (target instanceof Node && itemRef.current?.contains(target)) {
        return;
      }
      onCancelArchiveConfirm();
    }

    // Confirmation key for global timeline and pinned list contains workspacePath, Windows
    // Backslashes spelled into CSS selectors will be treated as escaped, so the confirmation button will be misjudged as a click outside the item.
    // The confirmation item directly uses its own ref to determine the event boundary to avoid coupling between business keys and CSS syntax.
    window.addEventListener("keydown", handleKeyDown, true);
    window.addEventListener("pointerdown", handlePointerDown, true);
    return () => {
      window.removeEventListener("keydown", handleKeyDown, true);
      window.removeEventListener("pointerdown", handlePointerDown, true);
    };
  }, [isArchiveConfirming, onCancelArchiveConfirm]);

  const splitPaneEntryEnabled = useV4SplitPaneEntry().enabled;
  const taskWorkspaceScope = useMemo(
    () => ({
      workspacePath,
      ...(task.workspaceIdentity?.trim() ? { workspaceIdentity: task.workspaceIdentity } : {}),
      ...(remoteSessionId ? { remoteSessionId } : {}),
    }),
    [remoteSessionId, task.workspaceIdentity, workspacePath],
  );
  const taskWorkbenchSessionKey = useMemo(
    () => buildWorkbenchSessionKey(taskWorkspaceScope, task.taskId),
    [task.taskId, taskWorkspaceScope],
  );
  const isSessionInWorkbenchGroup = useWorkbenchGroupStore((state) =>
    Boolean(state.sessionIndex[taskWorkbenchSessionKey]),
  );
  const canDragToWorkbench =
    !workspaceActionsDisabled && splitPaneEntryEnabled && !isSessionInWorkbenchGroup;

  // V4 runtime/interaction has been projected by sessions-index, the old Zustand map is no longer received
  // Background session delta. row directly consumes the activity sidecar that arrives with the list entry to avoid spinner/attention false inactivity.
  const taskActivity = getTaskListRowActivity(task);
  const taskAttention = getTaskListAttention(task);
  const hasPendingInteraction = Boolean(task.pendingInteraction) || taskAttention !== null;
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
  const taskTitle =
    task.title ||
    intl.formatMessage({
      id: task.forkedFromTaskId ? "taskList.forkedUntitled" : "taskList.untitled",
    });
  const handleSelect = useCallback(() => {
    runUserAction({
      input: { featureId: "task.lifecycle", action: "open", trigger: "button" },
      operation: () => onSelectTask(task.taskId),
      completed: { resultSource: "optimistic_projection" },
      failureStage: "task_open",
    });
  }, [onSelectTask, task.taskId]);
  const handleDragStart = useCallback(
    (event: React.DragEvent<HTMLLIElement>) => {
      if (!canDragToWorkbench) {
        event.preventDefault();
        return;
      }
      event.dataTransfer.effectAllowed = "copy";
      const payload = {
        kind: "zcode/session" as const,
        workspacePath,
        ...(task.workspaceIdentity?.trim() ? { workspaceIdentity: task.workspaceIdentity } : {}),
        ...(remoteSessionId ? { remoteSessionId } : {}),
        sessionId: task.taskId,
      };
      setActiveWorkbenchSessionDragPayload(payload);
      event.dataTransfer.setData(
        WORKBENCH_SESSION_DRAG_MIME,
        serializeWorkbenchSessionDragPayload(payload),
      );
      event.dataTransfer.setData("text/plain", taskTitle);
      // By default, the browser's drag preview has a transparent background and unclear borders; the original line content is retained.
      // Complete only the background, borders and shadow used by the Grouped drag overlay.
      const cleanupDragPreview = createTaskWorkbenchDragPreview({
        clientX: event.clientX,
        clientY: event.clientY,
        dataTransfer: event.dataTransfer,
        source: event.currentTarget,
      });
      const ownerWindow = event.currentTarget.ownerDocument.defaultView;
      if (ownerWindow) {
        ownerWindow.requestAnimationFrame(cleanupDragPreview);
      } else {
        cleanupDragPreview();
      }
    },
    [
      canDragToWorkbench,
      remoteSessionId,
      task.taskId,
      task.workspaceIdentity,
      taskTitle,
      workspacePath,
    ],
  );
  const handleDragEnd = useCallback(() => {
    clearActiveWorkbenchSessionDragPayload();
  }, []);
  const handleContextMenu = useCallback(() => {
    onOpenTaskContextMenu?.(task.taskId);
  }, [onOpenTaskContextMenu, task.taskId]);
  const handleOpenFileTree = useCallback(
    (event: React.MouseEvent) => {
      event.preventDefault();
      event.stopPropagation();
      if (workspaceActionsDisabled) {
        return;
      }
      runUserAction({
        input: { featureId: "workbench.file", action: "open_tree", trigger: "button" },
        operation: () => onOpenFileTree?.(task),
        completed: { resultSource: "local_commit" },
        failureStage: "file_tree_open",
      });
    },
    [onOpenFileTree, task, workspaceActionsDisabled],
  );

  const handleArchive = useCallback(
    (event: React.MouseEvent) => {
      if (workspaceActionsDisabled) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      runUserAction({
        input: { featureId: "task.lifecycle", action: "archive", trigger: "button" },
        operation: () => onArchiveTaskInline(event, task.taskId),
        completed: { resultSource: "optimistic_projection" },
        failureStage: "task_archive",
      });
    },
    [onArchiveTaskInline, task.taskId, workspaceActionsDisabled],
  );
  const handleTogglePin = useCallback(
    (event: React.MouseEvent) => {
      event.preventDefault();
      event.stopPropagation();
      if (workspaceActionsDisabled) {
        return;
      }
      onTogglePinTask(task.taskId, !isPinned);
    },
    [isPinned, onTogglePinTask, task.taskId, workspaceActionsDisabled],
  );
  const handleMouseEnter = useCallback(() => {
    setHoverActionsVisible(true);
  }, []);
  const handleMouseLeave = useCallback(() => {
    setHoverActionsVisible(false);
    // The secondary confirmation of archiving relies on the user's second click to confirm; just clear the hover display when the mouse leaves the row.
    // If the confirmation is canceled synchronously, the confirmation button will disappear after the user moves the mouse slightly away from the task line, causing the secondary confirmation to be unable to be completed stably.
  }, []);

  const leadingIndicator = useMemo(
    () => deriveTaskLeadingIndicator(task, taskActivity),
    [task, taskActivity],
  );
  const isTaskCron = isCronTask(task);
  // Moon identity is changed to persistent meta tag judgment; off-peak store reverse check will be lost after the task is deleted
  // Session traceability, and let each row carry an additional global store subscription.
  const isTaskOffPeak = isOffPeakTask(task);
  const showTimelineIdleIndicator =
    variant === "timeline" && leadingIndicator === "none" && !isPinned;
  // The mobile phone remote control mark and the top status share the leading slot on the left.
  // If the pin continues to be displayed on a pinned task, it will overlap with the absolutely positioned mobile phone icon; when the mobile phone is activated, the mobile phone icon will be given priority by default, and the Pin operation will be displayed when hovering.
  const showPinnedState = isPinned && leadingIndicator === "none" && !isMobileActive;
  const shouldMountWorkspaceTaskActions = hoverActionsVisible || focusActionsVisible || isHoverNone;
  // hover:none only means that the touch screen side needs permanent actions, but it does not mean that the time, status and change summary should be permanently hidden.
  // Metainformation only gives way during real hover / focus interactions, maintaining the "metainformation + action" semantics of the old touch screen layout.
  const shouldSuppressWorkspaceTaskMetadata = hoverActionsVisible || focusActionsVisible;
  const taskTimeLabel = formatTaskRelativeTime(task.updatedAt, intl);
  const taskChangeSummary = getTaskChangeSummary(task);
  const isRemoteTask = Boolean(task.workspaceIdentity?.trim());
  const archiveLabel = intl.formatMessage({
    id: isArchiveConfirming ? "common.confirm" : "taskList.archive",
  });
  const taskTitleWithChanges = formatTaskTitleWithChanges(taskTitle, taskChangeSummary, intl);
  const workspaceLabel = getPathLeaf(task.workspacePath);
  const taskItemKey = `${buildTaskWorkspaceKey(task.workspacePath, task.workspaceIdentity)}:${task.taskId}`;
  // Workflow Run Line: The second lane under the title,
  // It does not occupy space with the front 16px slot (error > unread > spinner). Only mount the component when the session has a run digest.
  const hasWorkflowRunLines = taskActivity?.workflowActivity !== undefined;
  const workflowRunLinesNode = hasWorkflowRunLines ? (
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
  const changeSummaryNode =
    !hasPendingInteraction && taskChangeSummary ? (
      <span className="shrink-0 text-ui-base">
        {taskChangeSummary.added > 0 ? (
          <span className="text-diff-added">+{taskChangeSummary.added}</span>
        ) : null}
        {taskChangeSummary.removed > 0 ? (
          <span className="ml-1 text-diff-removed">-{taskChangeSummary.removed}</span>
        ) : null}
      </span>
    ) : null;
  const shouldRenderArchiveAction =
    !workspaceActionsDisabled &&
    !hasPendingInteraction &&
    (shouldMountWorkspaceTaskActions || isArchiveConfirming);
  const archiveActionVisibilityClassName = isArchiveConfirming ? "flex" : "flex";
  const archiveActionNode = shouldRenderArchiveAction ? (
    /* Interaction change: once a task enters "awaiting archive confirmation", the right-hand hover
       area no longer shows the archive button. Otherwise a single item would show both the
       "awaiting confirmation" state and the "archivable" action, and the two would fight over the
       visual centre of gravity.
       */
    <div className={cn("items-center gap-0.5", archiveActionVisibilityClassName)}>
      {isArchiveConfirming ? (
        <ControlHintTooltip title={archiveLabel} side="top" align="center">
          <Button
            type="button"
            variant="destructive"
            size="sm"
            onMouseDown={(event) => {
              event.preventDefault();
              event.stopPropagation();
            }}
            onClick={handleArchive}
            data-testid={testId(TID_TASK_ARCHIVE, task.taskId)}
            // The archive confirmation state is a state that explicitly awaits user decision-making, and the destructive button must be continuously displayed.
            className={cn("shrink-0 border-destructive/20 px-2", archiveActionVisibilityClassName)}
            aria-label={archiveLabel}
          >
            <span>{intl.formatMessage({ id: "common.confirm" })}</span>
          </Button>
        </ControlHintTooltip>
      ) : (
        // Project / Pinned's normal archive button once overridden hover:bg-background/90,
        // It is inconsistent with the file tree action in the same line; the common state uniformly reuses the shared bg-hover action.
        <TaskRowActionButton
          label={archiveLabel}
          onClick={handleArchive}
          showTooltip
          testId={testId(TID_TASK_ARCHIVE, task.taskId)}
        >
          {isRemoteTask ? (
            // When local and remote tasks are mixed, the unified archive icon cannot indicate which SQLite the operation will fall on.
            // Remote tasks use cloud semantic icons to prevent users from mistaking remote archives for local archives.
            <CloudUpload className="h-3.5 w-3.5" />
          ) : (
            <Archive className="h-3.5 w-3.5" />
          )}
        </TaskRowActionButton>
      )}
    </div>
  ) : null;
  // When the session of the remote task is not ready, the resolver will refuse to open; the rendering layer hides the entrance synchronously.
  // Avoid showing a button that provides no feedback when clicked. Local tasks do not rely on open tabs and can still be opened directly according to the path.
  const canOpenFileTree =
    Boolean(onOpenFileTree) && (!task.workspaceIdentity?.trim() || Boolean(remoteSessionId));
  const fileTreeActionNode =
    canOpenFileTree &&
    !workspaceActionsDisabled &&
    !hasPendingInteraction &&
    (shouldMountWorkspaceTaskActions || isMobileActive) ? (
      <span className="inline-flex shrink-0">
        {/* The Pinned file tree button used to hand-roll its hover background and tooltip, which left it
            visually inconsistent with the same action in Grouped task. Reuse the shared action
            instead, so bg-hover, sizing and pointer behaviour all match.
            */}
        <TaskRowActionButton
          label={intl.formatMessage({ id: "git.action.showTree" })}
          onClick={handleOpenFileTree}
          showTooltip
        >
          <ListTree className="size-3.5" />
        </TaskRowActionButton>
      </span>
    ) : null;
  const taskActionGroupNode =
    fileTreeActionNode || archiveActionNode ? (
      <span data-task-row-actions="true" className="flex shrink-0 items-center gap-0.5">
        {fileTreeActionNode}
        {archiveActionNode}
      </span>
    ) : null;
  const pinActionButton = (
    <Button
      type="button"
      variant="ghost"
      size="icon-xs"
      disabled={workspaceActionsDisabled}
      onMouseDown={(event) => {
        event.preventDefault();
        event.stopPropagation();
      }}
      onClick={handleTogglePin}
      className="inline-flex size-4 min-w-0 rounded-sm p-0 text-foreground-subtle !bg-transparent hover:text-foreground"
      aria-label={intl.formatMessage({
        id: isPinned ? "taskList.unpin" : "taskList.pin",
      })}
    >
      <Pin className="size-4" />
    </Button>
  );
  // hover:none only makes the task actions on the right permanent; if it is also used to take over the leading slot,
  // The error, unread, and loading statuses on the touch screen will be permanently replaced by Pins.
  const shouldRenderPinAction =
    showPinAction && (showPinnedState || shouldSuppressWorkspaceTaskMetadata);
  return (
    <li
      ref={itemRef}
      data-testid={testId(TID_TASK_ITEM, task.taskId)}
      data-task-item-key={taskItemKey}
      data-mobile-active-task={isMobileActive ? "true" : undefined}
      data-archive-confirming-task-id={isArchiveConfirming ? task.taskId : undefined}
      onClick={handleSelect}
      onContextMenu={handleContextMenu}
      draggable={canDragToWorkbench}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      onFocusCapture={() => setFocusActionsVisible(true)}
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
          setFocusActionsVisible(false);
        }
      }}
      tabIndex={0}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) {
          return;
        }
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          handleSelect();
        }
      }}
      className={cn(
        "group/task-item flex cursor-pointer gap-2 rounded-lg pl-2.5 pr-1 py-1 transition-[background-color,border-color,box-shadow]",
        // When the default line is 32px, the entire row of the front slot is centered; after the workflow running line is grown, the row body is a vertical column of two rows, and the slot is changed to align with the first row.
        variant === "timeline"
          ? "items-start py-1.5"
          : hasWorkflowRunLines
            ? "items-start"
            : "items-center",
        isActive ? "bg-selected" : "hover:bg-surface-hover",
      )}
    >
      {/* The task list used to draw dividers with divide-y, which put a visible black line above and
              below every item in the dark sidebar — each row looked pinched between two borders. It
              is now "list padding + items carrying their own rounded state", so hover/active
              layering is carried by the card background instead of dividers.
              */}

      <div
        className={cn(
          "relative flex size-4 shrink-0 items-center justify-center",
          // When the row body is a vertical column (title row + running row), the front slot is aligned with the first row instead of the entire row: the default is 24px, the first row is centered = 4px is left above.
          variant === "timeline" ? "mt-0.5" : hasWorkflowRunLines ? "mt-1" : undefined,
        )}
      >
        <span
          aria-hidden="true"
          className={cn(
            "flex size-4 items-center justify-center transition-opacity",
            shouldRenderPinAction && "hidden",
            isMobileActive && "invisible",
          )}
        >
          {leadingIndicator === "error" ? (
            <span data-error-indicator="true" className="h-1.5 w-1.5 rounded-full bg-destructive" />
          ) : leadingIndicator === "unread" ? (
            <span
              data-unread-indicator="true"
              className="h-1.5 w-1.5 rounded-full bg-sky-500 dark:bg-sky-400"
            />
          ) : leadingIndicator === "loading" ? (
            <LoaderIcon className="size-4 animate-spin text-foreground-subtle" />
          ) : showTimelineIdleIndicator ? (
            <span data-idle-indicator="true" className="h-1.5 w-1.5 rounded-full bg-border" />
          ) : null}
        </span>
        {shouldRenderPinAction ? (
          <ControlHintTooltip
            title={
              workspaceActionsDisabledReason ??
              intl.formatMessage({
                id: isPinned ? "taskList.unpin" : "taskList.pin",
              })
            }
            side="top"
            align="center"
          >
            {pinActionButton}
          </ControlHintTooltip>
        ) : null}
      </div>

      {variant === "timeline" ? (
        <div className="relative flex min-w-0 flex-1 flex-col gap-0.5">
          <div className="flex min-w-0 items-center gap-1.5">
            {isMobileActive && !shouldSuppressWorkspaceTaskMetadata ? (
              <ControlHintTooltip
                title={intl.formatMessage({ id: "taskList.mobileActive" })}
                side="right"
                align="center"
                triggerClassName="absolute -left-6 top-2 z-10 -translate-y-1/2"
              >
                <span
                  data-mobile-active-task="true"
                  className="inline-flex size-4 items-center justify-center rounded-sm text-success"
                  aria-label={intl.formatMessage({
                    id: "taskList.mobileActive",
                  })}
                >
                  <Smartphone className="size-3.5" />
                </span>
              </ControlHintTooltip>
            ) : null}
            <TaskTitleOverflowText
              className="text-ui-base text-foreground"
              title={taskTitleWithChanges}
            >
              {/* workspace/timeline task titles used to use truncate, which showed an ellipsis at the end of a
                      long title; grouped task has already moved to a right-side fade. Unify the
                      overflow strategy for task list titles so that one sidebar never ends up with
                      two truncation semantics.
                      */}
              {taskTitle}
            </TaskTitleOverflowText>
            {task.pendingInteraction ? (
              <TaskInteractionBadge
                interaction={task.pendingInteraction}
                formatMessage={(id) => intl.formatMessage({ id })}
                onSnoozeCountdown={snoozeInteractionAutoResolution}
              />
            ) : taskAttentionDisplay ? (
              <Badge className="h-5 shrink-0 border-transparent bg-success/14 px-2 text-ui-base font-medium text-success dark:bg-success/18">
                {taskAttentionDisplay}
              </Badge>
            ) : null}
          </div>
          <div className="flex min-w-0 items-center justify-between gap-2 text-ui-base text-foreground-subtle h-6">
            <div className="flex min-w-0 items-center gap-1.5">
              <span className="truncate">{workspaceLabel}</span>
            </div>
            <div className="ml-auto flex shrink-0 items-center justify-end gap-1.5">
              {!hasPendingInteraction ? (
                <span
                  data-task-row-metadata="true"
                  className={cn(
                    "flex items-center gap-1.5",
                    isArchiveConfirming || shouldSuppressWorkspaceTaskMetadata
                      ? "hidden"
                      : undefined,
                  )}
                >
                  {changeSummaryNode}
                  {changeSummaryNode ? (
                    <span aria-hidden="true" className="shrink-0 text-foreground-subtlest">
                      ·
                    </span>
                  ) : null}
                  {isTaskCron ? (
                    // The scheduled task icon cannot occupy the status slot on the left; unread, running, and top hover will all take over there.
                    // Placed in front of the time, it is consistent with the meta-information of the grouped task row and will not be lost when the status changes.
                    <Clock
                      data-cron-task-icon="true"
                      aria-label={intl.formatMessage({
                        id: "taskList.cronTaskLabel",
                      })}
                      className="size-3.5 shrink-0"
                    />
                  ) : isTaskOffPeak ? (
                    <Moon
                      data-off-peak-task-icon="true"
                      aria-label={intl.formatMessage({ id: "taskList.offPeakTaskLabel" })}
                      className="size-3.5 shrink-0"
                    />
                  ) : null}
                  <span className="mr-1">{taskTimeLabel}</span>
                </span>
              ) : null}
              {taskActionGroupNode}
            </div>
          </div>
          {workflowRunLinesNode}
        </div>
      ) : (
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex min-w-0 items-center gap-2">
            <div className="relative min-w-0 flex h-6 flex-1 flex-wrap items-center gap-1.5">
              {isMobileActive && !shouldSuppressWorkspaceTaskMetadata ? (
                <ControlHintTooltip
                  title={intl.formatMessage({ id: "taskList.mobileActive" })}
                  side="right"
                  align="center"
                  triggerClassName="absolute -left-6 top-1/2 z-10 -translate-y-1/2"
                >
                  <span
                    data-mobile-active-task="true"
                    className="inline-flex size-4 items-center justify-center rounded-sm text-success"
                    aria-label={intl.formatMessage({
                      id: "taskList.mobileActive",
                    })}
                  >
                    {/* mobileViewState can already tell the desktop which task the phone is looking at,
                        but the list never consumed that state, so users would assume only the
                        desktop is acting on it. The previous version placed the icon as a flex
                        child before the title, which pushed the current row's title to the right
                        and misaligned task titles between rows; it is now absolutely positioned
                        into the existing leading slot, so the title text still starts where it used
                        to; the phone marker is also hidden on hover, handing the pin button back to
                        the user.
                        */}
                    <Smartphone className="size-3.5" />
                  </span>
                </ControlHintTooltip>
              ) : null}
              <TaskTitleOverflowText
                className="text-ui-base text-foreground"
                title={taskTitleWithChanges}
              >
                {/* The default workspace task item and the timeline item share one title overflow rule;
                        a mask fade rather than an ellipsis, consistent with the grouped task row.
                        */}
                {taskTitle}
              </TaskTitleOverflowText>
              {changeSummaryNode ? (
                <span
                  className={cn(
                    isArchiveConfirming || shouldSuppressWorkspaceTaskMetadata
                      ? "hidden"
                      : undefined,
                  )}
                >
                  {changeSummaryNode}
                </span>
              ) : null}
              {task.pendingInteraction ? (
                <TaskInteractionBadge
                  interaction={task.pendingInteraction}
                  formatMessage={(id) => intl.formatMessage({ id })}
                  onSnoozeCountdown={snoozeInteractionAutoResolution}
                />
              ) : taskAttentionDisplay ? (
                <Badge className="h-5 shrink-0 border-transparent bg-success/14 px-2 text-ui-sm font-medium text-success dark:bg-success/18">
                  {taskAttentionDisplay}
                </Badge>
              ) : null}
            </div>

            {!hasPendingInteraction ? (
              // The interactive capsule already occupies the right status bit; continuing to display the relative time will squeeze the title side by side with "Waiting for confirmation".
              <span
                data-task-row-metadata="true"
                className={cn(
                  "mr-0.5 flex shrink-0 items-center gap-1 text-ui-sm text-foreground-subtle",
                  isArchiveConfirming || shouldSuppressWorkspaceTaskMetadata ? "hidden" : undefined,
                )}
              >
                {isTaskCron ? (
                  // The scheduled task icon belongs to the time meta-information, not the left status bit; otherwise unread/loading will push the icon away.
                  <Clock
                    data-cron-task-icon="true"
                    aria-label={intl.formatMessage({
                      id: "taskList.cronTaskLabel",
                    })}
                    className="size-3.5 shrink-0"
                  />
                ) : isTaskOffPeak ? (
                  <Moon
                    data-off-peak-task-icon="true"
                    aria-label={intl.formatMessage({ id: "taskList.offPeakTaskLabel" })}
                    className="size-3.5 shrink-0"
                  />
                ) : null}
                {taskTimeLabel}
              </span>
            ) : null}

            {taskActionGroupNode}
          </div>
          {workflowRunLinesNode}
        </div>
      )}
    </li>
  );
}, areTaskListItemPropsEqual);

MemoTaskItem.displayName = "MemoTaskItem";

export function TaskListItemContextMenuContent({
  workspacePath,
  remoteSessionId,
  task,
  isPinned,
  intl,
  onTogglePinTask,
  onStartRenameTask,
  onArchiveTask,
  onMarkTaskAsUnread,
  disableTaskActions = false,
  disabledReason,
}: {
  workspacePath: string;
  remoteSessionId?: string;
  task: ZCodeTaskMeta;
  isPinned: boolean;
  intl: TaskListItemIntl;
  onTogglePinTask: (taskId: string, pinned: boolean) => void;
  onStartRenameTask: (taskId: string, currentTitle: string) => void;
  onArchiveTask: (taskId: string) => void;
  onMarkTaskAsUnread: (taskId: string) => void;
  disableTaskActions?: boolean;
  disabledReason?: string;
}) {
  const workspaceActionsDisabled = useOptionalTabStore(
    (state) =>
      disableTaskActions || isWorkspaceReadOnly(state, task.workspacePath, task.workspaceIdentity),
  );
  const workspaceActionsDisabledReason = workspaceActionsDisabled
    ? (disabledReason ?? intl.formatMessage({ id: "workspaceSidebar.unavailableLocalDirectory" }))
    : undefined;
  // Finishing: "Open in split screen" only desktop shell (context provided by WorkspaceShellLayout;
  // Mobile phone remote control/no Provider environment defaults to false → the menu items are not rendered as a whole).
  const splitPaneEntry = useV4SplitPaneEntry();
  const splitPaneEntryEnabled = splitPaneEntry.enabled;
  const splitPaneTarget = useMemo(
    () => ({
      workspacePath,
      ...(task.workspaceIdentity?.trim() ? { workspaceIdentity: task.workspaceIdentity } : {}),
      ...(remoteSessionId ? { remoteSessionId } : {}),
      sessionId: task.taskId,
    }),
    [remoteSessionId, task.taskId, task.workspaceIdentity, workspacePath],
  );
  // The current focused session, existing group and pane upper limits are determined by the shell owner; row is no longer directly written to the layout store.
  const canOpenInSplitPane = splitPaneEntry.canOpenSession(splitPaneTarget);
  const openFeedbackSubmit = useFeedbackStore((state) => state.openSubmit);
  const {
    taskSessionFile,
    taskNativeSessionLogFile,
    fileManagerLabel,
    handleCopyText,
    handleOpenTaskPathInFileManager,
  } = useTaskListItemContextActions({
    workspacePath,
    remoteSessionId,
    workspaceIdentity: task.workspaceIdentity,
    taskId: task.taskId,
    provider: task.provider,
    intl,
    // The row-level menu has been converged into a list-level singleton, and this component is only mounted when the menu is actually opened.
    // Therefore path detection and provider configuration detection can be run directly with the open state, avoiding subscription and calculation for each idle row.
    loadTaskPaths: true,
  });
  const taskTitle =
    task.title ||
    intl.formatMessage({
      id: task.forkedFromTaskId ? "taskList.forkedUntitled" : "taskList.untitled",
    });

  const handleOpenTaskFeedback = useCallback(async () => {
    // The task right-click menu could only copy logs/paths before, and the task context was missing when giving feedback.
    // The feedback center draft is reused here, and only the desensitized task clues are pre-filled, and the attachments are actively selected by the user.
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
        workspacePath,
        taskSessionPath: taskSessionFile.path,
        taskLogPath: taskNativeSessionLogFile.path,
        formatMessage: (id: string, values?: Record<string, string>) =>
          intl.formatMessage({ id }, values),
      }),
      screenshots: [],
    });
    toast(intl.formatMessage({ id: "taskList.feedbackOpened" }));
  }, [
    intl,
    openFeedbackSubmit,
    task.taskId,
    taskNativeSessionLogFile.path,
    taskSessionFile.path,
    taskTitle,
    workspacePath,
  ]);

  return (
    <TaskListItemContextMenu
      intl={intl}
      isPinned={isPinned}
      fileManagerLabel={fileManagerLabel}
      taskSessionFile={taskSessionFile}
      activeSessionId={task.taskId}
      taskNativeSessionLogFile={taskNativeSessionLogFile}
      disableTaskActions={workspaceActionsDisabled}
      disabledReason={workspaceActionsDisabledReason}
      onTogglePinTask={() => {
        onTogglePinTask(task.taskId, !isPinned);
      }}
      onStartRenameTask={() => {
        onStartRenameTask(task.taskId, task.title);
      }}
      onArchiveTask={() => {
        onArchiveTask(task.taskId);
      }}
      onMarkTaskAsUnread={() => {
        onMarkTaskAsUnread(task.taskId);
      }}
      onOpenInSplitPane={
        splitPaneEntryEnabled
          ? () => {
              // The old entrance directly writes paneLayout, bypassing active group and shell navigation.
              // After the draft split, the next normal click will pour the session into the primary. All are handed over to the shell controller.
              splitPaneEntry.openSession(splitPaneTarget);
            }
          : undefined
      }
      openInSplitPaneDisabled={workspaceActionsDisabled || !canOpenInSplitPane}
      onOpenTaskFeedback={() => {
        void handleOpenTaskFeedback();
      }}
      onOpenTaskPathInFileManager={() => {
        void handleOpenTaskPathInFileManager();
      }}
      onCopyWorkspacePath={() => {
        void handleCopyText(intl.formatMessage({ id: "appHeader.copyPath" }), workspacePath);
      }}
      onCopyTaskPath={() => {
        void handleCopyText(
          intl.formatMessage({ id: "appHeader.copyTaskPath" }),
          taskSessionFile.path,
        );
      }}
      onCopyTaskLogPath={() => {
        void handleCopyText(
          intl.formatMessage({ id: "appHeader.copyLogPath" }),
          taskNativeSessionLogFile.path,
        );
      }}
      onCopySessionId={() => {
        void handleCopyText(intl.formatMessage({ id: "appHeader.copySessionId" }), task.taskId);
      }}
      onViewModelTrajectory={() => {
        // Pass the "open track" request to the sidebar controller (useAppPanels) of the corresponding workspace through the singleton store.
        useModelTrajectoryStore.getState().requestOpen({
          taskId: task.taskId,
          workspaceKey: task.workspaceIdentity?.trim() || workspacePath,
          title: taskTitle,
        });
      }}
    />
  );
}
