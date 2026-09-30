// Left list projection: tasks-index determines the persistent row set and membership, and sessions-index only supplements real-time activity/detail.
// Keep the pure function here for Project/Timeline/Pinned/Archived/Grouped to share the same field authority.
import type { ZCodeTaskMeta } from "@zcode/shared";
import { matchesTaskListMembershipKind } from "@zcode/shared/zcode-protocol-v4";
import { buildTaskEntityKey } from "@/lib/taskQueryCache.js";
import { compareZCodeTaskListItems } from "@/lib/taskListOrdering.js";
import { attachTaskListRowActivity, getTaskListRowActivity } from "@/v4/taskListRowActivity.js";

type TaskListKind = "pinned" | "archived" | "timeline" | "active";
type TaskListSortBy = "created" | "updated";

interface BuildTaskListParams {
  /**
   * The union of task rows across the three persistent partitions of tasks-index:
   * active/pinned/archived.
   */
  taskIndexItems: ZCodeTaskMeta[];
  /**
   * Session activity/detail derived from sessions-index; only the persistent rows it matches are
   * overwritten.
   */
  sessions: ZCodeTaskMeta[];
  kind: TaskListKind;
  /** The server-authoritative pin/archive id set (persisted in tasks-index.sqlite). */
  pinnedIds: ReadonlySet<string>;
  archivedIds: ReadonlySet<string>;
  /** tasks-index persistent-delete tombstone; once matched it belongs to no list kind. */
  deletedIds?: ReadonlySet<string>;
  search?: string;
  sortBy: TaskListSortBy;
  /** The collapse limit; undefined = the full set (expanded). */
  limit?: number;
  /**
   * taskId → unreadAt (organizational state from tasks-index, fetched in parallel from the same
   * source as pin/archive). The sessions-index schema is frozen and does not carry unread, so it is
   * joined into meta here while the list is built.
   */
  unreadAtByTaskId?: ReadonlyMap<string, number>;
  /**
   * taskId → terminal status (historical terminal state from tasks-index; only fills in cold-start
   * stored summaries).
   */
  terminalStatusByTaskId?: ReadonlyMap<
    string,
    Extract<ZCodeTaskMeta["status"], "completed" | "error">
  >;
  /**
   * taskId → manual title from the legacy task-index; only overwrites session meta where
   * titleOverridden!==true.
   */
  titleOverrideByTaskId?: ReadonlyMap<string, string>;
  /** taskId -> cronAutomationId (tasks-index metadata; not carried by SessionSummary). */
  cronAutomationIdByTaskId?: ReadonlyMap<string, string>;
}

interface BuildTaskListResult {
  items: ZCodeTaskMeta[];
  total: number;
}

function mergeTaskIndexRowWithSession(
  taskIndexTask: ZCodeTaskMeta,
  sessionTask: ZCodeTaskMeta,
): ZCodeTaskMeta {
  const activity = getTaskListRowActivity(sessionTask);
  const sessionTitle = sessionTask.title.trim();
  const sessionTitleWins =
    sessionTitle.length > 0 &&
    (sessionTask.titleOverridden === true || taskIndexTask.titleOverridden !== true);
  const titleOverridden =
    sessionTask.titleOverridden === true || taskIndexTask.titleOverridden === true
      ? true
      : undefined;
  const merged: ZCodeTaskMeta = {
    ...taskIndexTask,
    title: sessionTitleWins ? sessionTask.title : taskIndexTask.title,
    titleOverridden,
    // Session activity is the real-time authoritative of creation/activity time and final state; task row only provides information when summary is missing.
    createdAt: sessionTask.createdAt || taskIndexTask.createdAt,
    updatedAt: (activity?.lastActivityAt ?? sessionTask.updatedAt) || taskIndexTask.updatedAt,
    status: sessionTask.status ?? taskIndexTask.status,
    forkedFromTaskId: sessionTask.forkedFromTaskId ?? taskIndexTask.forkedFromTaskId,
    // The pending interaction belongs to the current session projection; when the summary has arrived but the field is empty, the old persistent value must be cleared.
    pendingInteraction: sessionTask.pendingInteraction,
  };
  return activity ? attachTaskListRowActivity(merged, activity) : merged;
}

/**
 * A field-level join with tasks-index rows as the left table. When the summary is missing, the
 * original task reference is kept; session-only cold summaries do not enter the persistent list —
 * the existing optimistic/live overlay takes care of newly created short windows.
 */
export function mergeTaskIndexRowsWithSessions(params: {
  taskIndexItems: ZCodeTaskMeta[];
  sessions: ZCodeTaskMeta[];
}): ZCodeTaskMeta[] {
  const sessionByEntityKey = new Map(
    params.sessions.map((session) => [buildTaskEntityKey(session), session]),
  );
  return params.taskIndexItems.map((task) => {
    const session = sessionByEntityKey.get(buildTaskEntityKey(task));
    return session ? mergeTaskIndexRowWithSession(task, session) : task;
  });
}

/**
 * The unreadAt join: once the map is loaded tasks-index wins; while it is unloaded the original
 * meta is left untouched, so the first frame does not flicker.
 */
export function joinTaskListUnreadAt(
  tasks: ZCodeTaskMeta[],
  unreadAtByTaskId: ReadonlyMap<string, number> | undefined,
): ZCodeTaskMeta[] {
  return joinTaskListMembershipMeta(tasks, { unreadAtByTaskId });
}

function joinTaskListMembershipMeta(
  tasks: ZCodeTaskMeta[],
  params: {
    unreadAtByTaskId?: ReadonlyMap<string, number>;
    terminalStatusByTaskId?: ReadonlyMap<
      string,
      Extract<ZCodeTaskMeta["status"], "completed" | "error">
    >;
    titleOverrideByTaskId?: ReadonlyMap<string, string>;
    cronAutomationIdByTaskId?: ReadonlyMap<string, string>;
  },
): ZCodeTaskMeta[] {
  const {
    unreadAtByTaskId,
    terminalStatusByTaskId,
    titleOverrideByTaskId,
    cronAutomationIdByTaskId,
  } = params;
  if (
    unreadAtByTaskId === undefined &&
    (!terminalStatusByTaskId || terminalStatusByTaskId.size === 0) &&
    (!titleOverrideByTaskId || titleOverrideByTaskId.size === 0) &&
    (!cronAutomationIdByTaskId || cronAutomationIdByTaskId.size === 0)
  ) {
    return tasks;
  }
  return tasks.map((task) => {
    const activity = getTaskListRowActivity(task);
    const unreadAt = unreadAtByTaskId?.get(task.taskId);
    const terminalStatus = terminalStatusByTaskId?.get(task.taskId);
    const titleOverride =
      task.titleOverridden === true ? undefined : titleOverrideByTaskId?.get(task.taskId);
    const cronAutomationId = cronAutomationIdByTaskId?.get(task.taskId);
    const shouldUpdateUnread =
      unreadAtByTaskId !== undefined &&
      (unreadAt !== task.unreadAt || (unreadAt === undefined && task.unreadAt !== undefined));
    // v4 cold start stored summaries may not have activity sidecar, and can only be started from
    // tasks-index complements the historical terminal status; once sessions-index has projected activity, all real-time terminal status
    // are owned by it and can no longer be overwritten by the error/completed reverse of the old tasks-index.
    const shouldUpdateStatus =
      activity === null &&
      terminalStatus !== undefined &&
      (task.status === undefined || (terminalStatus === "error" && task.status === "completed"));
    const shouldUpdateTitle =
      titleOverride !== undefined &&
      (task.title !== titleOverride || task.titleOverridden !== true);
    const shouldUpdateCronAutomationId =
      cronAutomationId !== undefined && cronAutomationId !== task.cronAutomationId;
    if (
      !shouldUpdateUnread &&
      !shouldUpdateStatus &&
      !shouldUpdateTitle &&
      !shouldUpdateCronAutomationId
    ) {
      return task;
    }
    return {
      ...task,
      ...(shouldUpdateUnread ? { unreadAt } : {}),
      ...(shouldUpdateStatus ? { status: terminalStatus } : {}),
      ...(shouldUpdateTitle ? { title: titleOverride, titleOverridden: true } : {}),
      // The frozen summary of sessions-index does not contain cron identity; it must be returned from tasks-index join.
      // Otherwise, the database has been marked as a scheduled task, and the meta passed to React from the sidebar still cannot pass isCronTask.
      ...(shouldUpdateCronAutomationId ? { cronAutomationId } : {}),
    };
  });
}

/**
 * Client-side filtering/sorting/paging, producing a { items, total } shaped like the old
 * listTaskList.
 */
export function buildTaskListResult(params: BuildTaskListParams): BuildTaskListResult {
  const query = params.search?.trim().toLocaleLowerCase() ?? "";
  const rows = mergeTaskIndexRowsWithSessions({
    taskIndexItems: params.taskIndexItems,
    sessions: params.sessions,
  });
  const tasks = joinTaskListMembershipMeta(rows, {
    unreadAtByTaskId: params.unreadAtByTaskId,
    terminalStatusByTaskId: params.terminalStatusByTaskId,
    titleOverrideByTaskId: params.titleOverrideByTaskId,
    cronAutomationIdByTaskId: params.cronAutomationIdByTaskId,
  });
  const filtered = tasks.filter((task) => {
    // The CLI session store will not be physically cleaned with the archive list "permanently deleted"; if not applied first
    // deleted negative membership, cold start sessions-index will revive it as a non-archived ordinary task.
    if (params.deletedIds?.has(task.taskId)) return false;
    const pinned = params.pinnedIds.has(task.taskId);
    const archived = params.archivedIds.has(task.taskId);
    if (!matchesTaskListMembershipKind({ pinned, archived }, params.kind)) return false;
    if (query && !task.title.toLocaleLowerCase().includes(query)) return false;
    return true;
  });
  filtered.sort((a, b) => compareZCodeTaskListItems(a, b, params.sortBy));
  const total = filtered.length;
  const items = params.limit === undefined ? filtered : filtered.slice(0, params.limit);
  return { items, total };
}
