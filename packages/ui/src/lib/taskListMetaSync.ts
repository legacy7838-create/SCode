import type { ZCodeTaskMeta } from "@zcode/shared";
import { mergeTaskMetaCandidates } from "@/lib/zcodeTaskMetaMerge.js";
import { buildTaskEntityKey } from "@/lib/taskQueryCache.js";
import { getTaskMeta, useZCodeSessionStore } from "@/store/zcodeSessionStore.js";
import {
  applyTaskQueryCacheMutation,
  removeTaskFromTaskQueryCaches,
  updateTaskQueryCacheTaskMetaPreservingMembership,
  upsertTaskQueryCacheTaskMeta,
  useTaskQueryCacheStore,
  type TaskListMembershipState,
} from "@/store/taskQueryCacheStore.js";

export function removeTaskFromTaskCaches(params: {
  workspacePath: string;
  workspaceIdentity?: string;
  taskId: string;
}): boolean {
  const store = useZCodeSessionStore.getState();
  const workspaceState = store.getWorkspaceState(params.workspacePath, params.workspaceIdentity);
  if (workspaceState.taskListCache) {
    store.setTaskListCache(
      params.workspacePath,
      workspaceState.taskListCache.filter((task) => task.taskId !== params.taskId),
      params.workspaceIdentity,
    );
  }
  store.removeTaskState(params.workspacePath, params.taskId, params.workspaceIdentity);
  return removeTaskFromTaskQueryCaches(params);
}

const ABSENT_MEMBERSHIP: TaskListMembershipState = {
  pinned: true,
  archived: true,
};

function sortTasksByUpdatedAt(tasks: readonly ZCodeTaskMeta[]): ZCodeTaskMeta[] {
  return [...tasks].sort((left, right) => {
    if (right.updatedAt !== left.updatedAt) {
      return right.updatedAt - left.updatedAt;
    }
    if (right.createdAt !== left.createdAt) {
      return right.createdAt - left.createdAt;
    }
    return right.taskId.localeCompare(left.taskId);
  });
}

export function syncTaskMetaToTaskCaches(params: {
  workspacePath: string;
  workspaceIdentity?: string;
  task: ZCodeTaskMeta;
  membership?: TaskListMembershipState;
  forceInsertMembership?: boolean;
  ensureInWorkspaceTaskCache?: boolean;
  preserveListMembership?: boolean;
  applyQueryCacheMutation?: boolean;
}): void {
  const store = useZCodeSessionStore.getState();
  const workspaceState = store.getWorkspaceState(params.workspacePath, params.workspaceIdentity);
  const previousTask = getTaskMeta(workspaceState, params.task.taskId);
  const queryTask = useTaskQueryCacheStore.getState().taskMetaByEntityKey[
    buildTaskEntityKey({
      taskId: params.task.taskId,
      workspacePath: params.workspacePath,
      workspaceIdentity: params.workspaceIdentity ?? params.task.workspaceIdentity,
    })
  ];
  // Bugfix: updatedAt of session/readSession snapshot may lag behind the front-end optimistic time of first prompt write.
  // When synchronizing snapshots, you must first monotonically merge it with the local existing task meta, otherwise the new task will jump back to the bottom after the sqlite first screen is refreshed.
  // Bugfix: When restarting and restoring, the workspace store may not have the current task, but the query cache already has sqlite indexed meta.
  // The raw session snapshot does not have titleOverridden and must be merged together to avoid manually renaming the title from being restored in the renderer.
  const task =
    mergeTaskMetaCandidates(params.task, previousTask, queryTask) ?? params.task;
  const cachedTasks = workspaceState.taskListCache ?? [];
  const hasCachedTask = cachedTasks.some((cachedTask) => cachedTask.taskId === task.taskId);
  const shouldExistInWorkspaceTaskCache =
    params.membership?.pinned === false && params.membership.archived === false;
  const nextCachedTasks = params.preserveListMembership
    ? cachedTasks.map((cachedTask) => (cachedTask.taskId === task.taskId ? task : cachedTask))
    : shouldExistInWorkspaceTaskCache
      ? sortTasksByUpdatedAt([
          task,
          ...cachedTasks.filter((cachedTask) => cachedTask.taskId !== task.taskId),
        ])
      : cachedTasks.filter((cachedTask) => cachedTask.taskId !== task.taskId);

  // Bugfix: uniformly bump the entire taskListVersion before final state/rollback operations, just to update the latest snapshot.meta
  // Retrieve the list. Here, the taskListCache is written back in increments of tasks to avoid rechecking all task lists in the entire round.
  if (
    workspaceState.taskListCache !== null &&
    ((params.preserveListMembership && hasCachedTask) ||
      params.ensureInWorkspaceTaskCache ||
      hasCachedTask ||
      !shouldExistInWorkspaceTaskCache)
  ) {
    store.setTaskListCache(params.workspacePath, nextCachedTasks, params.workspaceIdentity);
  }

  // Bugfix: Header / The current session information will give priority to optimistic meta to overwrite the old cache.
  // If only the query cache is changed here and the optimistic pool is not replenished, the currently active task may continue to display the old title/old summary.
  store.upsertOptimisticTaskListItem(params.workspacePath, task, params.workspaceIdentity);
  upsertTaskQueryCacheTaskMeta(task);

  if (params.preserveListMembership) {
    updateTaskQueryCacheTaskMetaPreservingMembership(task);
  } else if (params.membership && params.applyQueryCacheMutation !== false) {
    // Bugfix: When creating a task on the mobile shared-host, the desktop renderer only receives the workspace event.
    // insertTaskIntoTaskCaches without local origin path. When previousTask is missing, still press active
    // The membership relationship is inserted into the query cache, otherwise the remote control homepage will continue to synchronize the old list order.
    // Bugfix: The local initializer will write optimistic meta first, and then insert the list members; at this time, although previousTask exists,
    // But it only means "already metadata", not "already included in the list total". To create a new task, you must explicitly press absent -> active
    // processing, otherwise the total of the sixth workspace task will still stop at 5 and Show more will not appear.
    applyTaskQueryCacheMutation({
      previousTask: previousTask ?? task,
      nextTask: task,
      previousState:
        previousTask && !params.forceInsertMembership
          ? params.membership
          : ABSENT_MEMBERSHIP,
      nextState: params.membership,
    });
  }
}

export function insertTaskIntoTaskCaches(params: {
  workspacePath: string;
  workspaceIdentity?: string;
  task: ZCodeTaskMeta;
  membership: TaskListMembershipState;
}): void {
  // Bugfix: When creating a new /fork/remote shared-host task, the same "None -> Yes" member change should be followed.
  // syncTaskMetaToTaskCaches will insert the query cache according to ABSENT_MEMBERSHIP when previousTask is missing.
  // You cannot apply mutation twice here, otherwise total will be incremented by one repeatedly.
  syncTaskMetaToTaskCaches({
    workspacePath: params.workspacePath,
    workspaceIdentity: params.workspaceIdentity,
    task: params.task,
    membership: params.membership,
    forceInsertMembership: true,
    ensureInWorkspaceTaskCache:
      params.membership.pinned === false && params.membership.archived === false,
  });
}
