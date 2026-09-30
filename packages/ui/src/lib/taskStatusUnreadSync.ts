import type { IZCodeTaskService } from "@zcode/services";
import type { ZCodeTaskMeta, ZCodeWorkspaceTaskListChanged } from "@zcode/shared";
import { buildTaskEntityKey, buildTaskWorkspaceKey } from "@/lib/taskQueryCache.js";
import {
  markTaskQueryCacheScopesStale,
  reconcileTaskQueryCacheUnread,
  rollbackTaskQueryCacheUnread,
  setTaskQueryCacheUnreadOverlay,
  useTaskQueryCacheStore,
} from "@/store/taskQueryCacheStore.js";
import { getTaskUnreadIndicator, useZCodeSessionStore } from "@/store/zcodeSessionStore.js";
import { bumpTaskListMembershipVersion } from "@/v4/taskListMembershipVersion.js";
import { logger } from "@/logger.js";

type TaskUnreadService = Pick<IZCodeTaskService, "setTaskUnread">;

const STATUS_UNREAD_DEDUPE_WINDOW_MS = 1_000;
const STATUS_UNREAD_DEDUPE_MAX_KEYS = 256;
const recentStatusUnreadAtByKey = new Map<string, number>();

function isTerminalTaskStatus(status: ZCodeTaskMeta["status"]): boolean {
  return status === "completed" || status === "error";
}

function buildStatusUnreadKey(event: ZCodeWorkspaceTaskListChanged, taskId: string): string {
  const workspaceKey = buildTaskWorkspaceKey(event.workspacePath, event.workspaceIdentity);
  return [workspaceKey, taskId, event.taskMeta?.status ?? "", event.taskMeta?.updatedAt ?? ""].join(
    "::",
  );
}

function shouldSkipRecentStatusUnread(key: string): boolean {
  const now = Date.now();
  for (const [recentKey, at] of recentStatusUnreadAtByKey) {
    if (now - at > STATUS_UNREAD_DEDUPE_WINDOW_MS) {
      recentStatusUnreadAtByKey.delete(recentKey);
    }
  }
  if (recentStatusUnreadAtByKey.has(key)) {
    return true;
  }
  recentStatusUnreadAtByKey.set(key, now);
  if (recentStatusUnreadAtByKey.size > STATUS_UNREAD_DEDUPE_MAX_KEYS) {
    const oldestKey = recentStatusUnreadAtByKey.keys().next().value;
    if (oldestKey) {
      recentStatusUnreadAtByKey.delete(oldestKey);
    }
  }
  return false;
}

function shouldMarkStatusEventTaskUnread(params: {
  activeTaskId: string | null;
  activeWorkspace: { workspacePath: string; workspaceIdentity?: string };
  event: ZCodeWorkspaceTaskListChanged;
}): boolean {
  const taskId = params.event.taskId ?? params.event.taskMeta?.taskId;
  const isEventWorkspaceActive =
    buildTaskWorkspaceKey(
      params.activeWorkspace.workspacePath,
      params.activeWorkspace.workspaceIdentity,
    ) === buildTaskWorkspaceKey(params.event.workspacePath, params.event.workspaceIdentity);
  return (
    params.event.reason === "task_status_changed" &&
    params.event.unreadSignal === "background_terminal" &&
    Boolean(taskId) &&
    isTerminalTaskStatus(params.event.taskMeta?.status) &&
    (!isEventWorkspaceActive || params.activeTaskId !== taskId)
  );
}

export function syncTaskUnreadFromStatusWorkspaceEvent(params: {
  activeWorkspace: { workspacePath: string; workspaceIdentity?: string };
  event: ZCodeWorkspaceTaskListChanged;
  service: TaskUnreadService;
}): void {
  const { event, service } = params;
  const taskId = event.taskId ?? event.taskMeta?.taskId;
  if (
    !taskId ||
    event.reason !== "task_status_changed" ||
    event.unreadSignal !== "background_terminal"
  ) {
    return;
  }

  const store = useZCodeSessionStore.getState();
  const workspaceState = store.getWorkspaceState(event.workspacePath, event.workspaceIdentity);
  if (
    !shouldMarkStatusEventTaskUnread({
      activeTaskId: workspaceState.activeTaskId,
      activeWorkspace: params.activeWorkspace,
      event,
    })
  ) {
    return;
  }

  const targetTask = {
    taskId,
    workspacePath: event.workspacePath,
    ...(event.workspaceIdentity ? { workspaceIdentity: event.workspaceIdentity } : {}),
  };
  const taskEntityKey = buildTaskEntityKey(targetTask);
  const queryCacheState = useTaskQueryCacheStore.getState();
  const cachedTask = queryCacheState.taskMetaByEntityKey[taskEntityKey];
  const pendingUnreadAt = queryCacheState.taskUnreadOverlayByEntityKey[taskEntityKey];
  const persistedUnreadAt =
    cachedTask?.unreadAt ??
    event.taskMeta?.unreadAt ??
    (typeof pendingUnreadAt === "number" ? pendingUnreadAt : undefined);
  if (typeof persistedUnreadAt === "number") {
    // The same status event will be received by multiple sidebar subscriptions. The first listener has been written
    // After query-row overlay, subsequent listeners are only compatible with the Dock badge and will not be dropped into the database again.
    // If unreadAt has been carried by the event, the field will be reconciled directly; a permanent overlay cannot be created for existing unreads.
    if (typeof cachedTask?.unreadAt !== "number" && typeof pendingUnreadAt !== "number") {
      rollbackTaskQueryCacheUnread(targetTask, persistedUnreadAt);
    }
    store.setTaskUnreadIndicator(event.workspacePath, taskId, true, event.workspaceIdentity);
    return;
  }

  const dedupeKey = buildStatusUnreadKey(event, taskId);
  if (shouldSkipRecentStatusUnread(dedupeKey)) {
    return;
  }

  const previousUnreadAt = cachedTask?.unreadAt;
  const previousLegacyUnread = getTaskUnreadIndicator(workspaceState, taskId);
  const optimisticUnreadAt = Date.now();
  // The V4 sidebar already only consumes unreadAt of task query row, old Zustand
  // taskUnreadByTaskId no longer drives TaskListItem. The background final state must be written according to the precise entity key first.
  // field overlay; even if the row of the new task has not been published, subsequent queries will merge this overlay.
  setTaskQueryCacheUnreadOverlay(targetTask, optimisticUnreadAt);
  // Compatible with the migration projection of the Dock badge; the source of fact for the blue dot in the sidebar is still only query row unreadAt.
  store.setTaskUnreadIndicator(event.workspacePath, taskId, true, event.workspaceIdentity);
  void service
    .setTaskUnread({
      ...targetTask,
      unread: true,
    })
    .then((meta) => {
      // The server first updates tasks-index and then returns the package; only the unreadAt field is reconciled, and the entire meta is prohibited.
      // Override sessions-index activity to prevent background completion or unread writes from changing the Updated sorting.
      const committedUnreadAt = meta.unreadAt ?? optimisticUnreadAt;
      reconcileTaskQueryCacheUnread(targetTask, committedUnreadAt);
      store.setTaskUnreadIndicator(event.workspacePath, taskId, true, event.workspaceIdentity);
    })
    .catch((error: unknown) => {
      // A renderer-only false cannot be left unread when persistence fails. Restore pre-submit fields,
      // Then mark the exact workspace and let the next round of membership join return to the tasks-index fact.
      rollbackTaskQueryCacheUnread(targetTask, previousUnreadAt);
      store.setTaskUnreadIndicator(
        event.workspacePath,
        taskId,
        previousLegacyUnread,
        event.workspaceIdentity,
      );
      markTaskQueryCacheScopesStale([targetTask]);
      bumpTaskListMembershipVersion();
      logger.warn(
        "[taskStatusUnreadSync] failed to persist background terminal unread state",
        {
          taskId,
          workspaceIdentity: event.workspaceIdentity ?? null,
          workspacePath: event.workspacePath,
        },
        error,
      );
    });
}
