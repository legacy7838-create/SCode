import type { ZCodeWorkspaceTaskListChanged } from "@zcode/shared";

type TaskListMembershipWorkspaceEventReason =
  | "task_archived"
  | "task_unarchived"
  | "task_pinned"
  | "task_unpinned";

const TASK_LIST_MEMBERSHIP_REASONS = new Set<ZCodeWorkspaceTaskListChanged["reason"]>([
  "task_archived",
  "task_unarchived",
  "task_pinned",
  "task_unpinned",
]);

function isTaskListMembershipWorkspaceEvent<
  T extends Pick<ZCodeWorkspaceTaskListChanged, "reason">,
>(
  event: T,
): event is T & {
  reason: TaskListMembershipWorkspaceEventReason;
} {
  return TASK_LIST_MEMBERSHIP_REASONS.has(event.reason);
}

/**
 * The sidebar treats tasks-index rows and pin/archive/unread membership as authoritative, while
 * sessions-index only fills in detail, and re-fetches are driven by membershipVersion. unread
 * (setTaskUnread) and rename go through task_meta_changed, and sessions-index carries no unread, so
 * task_meta_changed is also counted as a membership re-fetch signal (low frequency). task_created
 * grows the forward row set of tasks-index and must be read from the new generation only after the
 * task row/grouped order has been committed; it cannot rely on sessions-index detail or incremental
 * insertion into the old query-cache alone. task_model_changed (model switch) is unrelated to
 * membership and is explicitly excluded — it used to be mixed into task_meta_changed, where
 * switching the model once bumped membershipVersion globally and dragged every list instance into a
 * membership re-fetch.
 */
export function shouldRefetchTaskListMembershipForWorkspaceEvent(
  event: Pick<ZCodeWorkspaceTaskListChanged, "reason">,
): boolean {
  // After deletion, sessions-index may still continue to publish sessions retained in the CLI store;
  // task_deleted must be replaced by deleted tombstone join, and query cache removal cannot be performed only once.
  return (
    isTaskListMembershipWorkspaceEvent(event) ||
    // After the sidebar is changed to tasks-index row authority, task_created is no longer just a session meta event.
    // If the membership/task-row Promise is not replaced, the Project will continue to display the old collection even though the new row has been dropped into SQLite.
    event.reason === "task_created" ||
    event.reason === "task_meta_changed" ||
    event.reason === "task_deleted"
  );
}
