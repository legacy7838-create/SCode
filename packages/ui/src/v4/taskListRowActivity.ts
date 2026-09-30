import type { ZCodeTaskMeta } from "@zcode/shared";
import type {
  PendingInteractionSummary,
  SessionSummary,
  SessionWorkflowActivity,
} from "@zcode/shared/zcode-protocol-v4";

// UI-only sidecar: Do not enter shared task meta/schema, nor write back tasks-index.
// Use an explicit internal prefix for field names to prevent callers from mistaking them for persistent task properties.
const TASK_LIST_ROW_ACTIVITY_FIELD = "__zcodeSessionActivity" as const;

export interface TaskListRowActivity {
  phase: SessionSummary["phase"];
  lastActivityAt: number;
  hasBackgroundWork: boolean;
  pendingInteractions?: PendingInteractionSummary;
  /** The data of a workflow-run row in the sidebar; absent when there is no run. */
  workflowActivity?: SessionWorkflowActivity;
}

export type TaskListMetaWithActivity = ZCodeTaskMeta & {
  [TASK_LIST_ROW_ACTIVITY_FIELD]: TaskListRowActivity;
};

export function attachTaskListRowActivity<T extends ZCodeTaskMeta>(
  task: T,
  activity: TaskListRowActivity,
): T & TaskListMetaWithActivity {
  return {
    ...task,
    [TASK_LIST_ROW_ACTIVITY_FIELD]: activity,
  };
}

export function getTaskListRowActivity(task: ZCodeTaskMeta): TaskListRowActivity | null {
  const activity = (task as Partial<TaskListMetaWithActivity>)[TASK_LIST_ROW_ACTIVITY_FIELD];
  return activity ?? null;
}

/**
 * Only the live phase from sessions-index is trusted; a leftover status=running in tasks-index must
 * not float a historical task to the top.
 */
function isTaskListRowRunning(task: ZCodeTaskMeta): boolean {
  const phase = getTaskListRowActivity(task)?.phase;
  return phase === "prewarming" || phase === "running";
}

/**
 * Membership test for the running layer of the list: the turn is running (prewarming/running)
 * **or** it has background work hanging off it (hasBackgroundWork).
 *
 * A dynamic workflow run is background work — after the starting turn wraps up, the parent
 * session's phase is already back at completedSuccess, but every run progress event still pushes
 * lastActivityAt forward. If the running layer looked only at phase, two sessions each running one
 * run would both land in the non-running layer sorted by updatedAt and swap places as progress
 * events arrive. Background bash / detached subagents are the same. The spinner icon still keys off
 * phase alone (isTaskListRowRunning); this only decides the ordering layer.
 */
export function isTaskListRowActive(task: ZCodeTaskMeta): boolean {
  return isTaskListRowRunning(task) || getTaskListRowActivity(task)?.hasBackgroundWork === true;
}

export function getTaskListAttention(
  task: ZCodeTaskMeta,
): { kind: "permission" | "userInput"; count: number } | null {
  const summary = getTaskListRowActivity(task)?.pendingInteractions;
  if (!summary) {
    return null;
  }
  const count = summary.permissionCount + summary.userInputCount;
  if (count === 0) {
    return null;
  }
  return {
    kind: summary.userInputCount > 0 ? "userInput" : "permission",
    count,
  };
}

export function mergeTaskListMembershipFields(
  activityTask: ZCodeTaskMeta,
  membershipTask: ZCodeTaskMeta,
): ZCodeTaskMeta {
  const activity = getTaskListRowActivity(activityTask);
  if (!activity) {
    return membershipTask;
  }
  const membershipOwnsUnreadAt = Object.prototype.hasOwnProperty.call(membershipTask, "unreadAt");
  // The tasks-index response of rename/pin/archive/unread will carry its own updatedAt/status,
  // But the sidebar activity and Updated sorting only belong to sessions-index. mutation can only override membership/meta
  // fields, you cannot replace the entire row so that the task has no real activity but skips the sequence or loses the real-time phase.
  return attachTaskListRowActivity(
    {
      ...activityTask,
      ...membershipTask,
      createdAt: activityTask.createdAt,
      updatedAt: activity.lastActivityAt,
      status: activityTask.status,
      unreadAt: membershipOwnsUnreadAt ? membershipTask.unreadAt : activityTask.unreadAt,
    },
    activity,
  );
}
