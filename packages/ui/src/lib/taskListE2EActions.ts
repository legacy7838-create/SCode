import {
  armTaskListMembershipRefreshHoldForE2E,
  getTaskListMembershipRefreshHoldStateForE2E,
  releaseTaskListMembershipRefreshHoldForE2E,
  type TaskListMembershipRefreshHoldState,
} from "@/lib/taskListMembershipSets.js";
import {
  buildTaskEntityKey,
  buildTaskWorkspaceKey,
  type TaskListQueryKind,
} from "@/lib/taskQueryCache.js";
import { useTaskQueryCacheStore } from "@/store/taskQueryCacheStore.js";
import { bumpTaskListMembershipVersion } from "@/v4/taskListMembershipVersion.js";
import { getTaskListRowActivity } from "@/v4/taskListRowActivity.js";

export interface TaskListRefreshE2EProbe {
  matchingQueryCount: number;
  latestQueryStale: boolean | null;
  latestInvalidationVersion: number | null;
  taskPresent: boolean;
  taskStatus: string | null;
  activityPhase: string | null;
}

export interface TaskListMembershipE2EProbe {
  membershipKinds: TaskListQueryKind[];
  taskPresent: boolean;
}

export interface TaskListE2EActions {
  armTaskMembershipRefreshHold: () => void;
  releaseTaskMembershipRefreshHold: () => void;
  getTaskMembershipRefreshHoldState: () => TaskListMembershipRefreshHoldState;
  getTaskListRefreshProbe: (params: {
    workspacePath: string;
    workspaceIdentity?: string;
    taskId: string;
  }) => TaskListRefreshE2EProbe;
  getTaskListMembershipProbe: (params: {
    workspacePath: string;
    workspaceIdentity?: string;
    taskId: string;
  }) => TaskListMembershipE2EProbe;
}

export const taskListE2EActions: TaskListE2EActions = {
  armTaskMembershipRefreshHold: () => {
    armTaskListMembershipRefreshHoldForE2E();
    // After the gate is installed, bump it again to ensure that all membership fetch started due to version changes enter the pause window.
    bumpTaskListMembershipVersion();
  },
  releaseTaskMembershipRefreshHold: releaseTaskListMembershipRefreshHoldForE2E,
  getTaskMembershipRefreshHoldState: getTaskListMembershipRefreshHoldStateForE2E,
  getTaskListMembershipProbe: ({ workspacePath, workspaceIdentity, taskId }) => {
    const workspaceKey = buildTaskWorkspaceKey(workspacePath, workspaceIdentity);
    const entityKey = buildTaskEntityKey({
      workspacePath,
      workspaceIdentity,
      taskId,
    });
    const state = useTaskQueryCacheStore.getState();
    const membershipKinds = new Set<TaskListQueryKind>();
    for (const result of Object.values(state.resultsByQueryKey)) {
      if (
        result.descriptor.workspaceKeys.includes(workspaceKey) &&
        result.taskKeys.includes(entityKey)
      ) {
        membershipKinds.add(result.descriptor.kind);
      }
    }
    return {
      // E2E non-UI evidence: The top entry must allow the same entity to switch membership in the query cache.
      // You can't just rely on temporarily retaining a row in the DOM to mask grouped/pinned partitions and still get errors.
      membershipKinds: [...membershipKinds].sort(),
      taskPresent: Boolean(state.taskMetaByEntityKey[entityKey]),
    };
  },
  getTaskListRefreshProbe: ({ workspacePath, workspaceIdentity, taskId }) => {
    const workspaceKey = buildTaskWorkspaceKey(workspacePath, workspaceIdentity);
    const entityKey = buildTaskEntityKey({
      workspacePath,
      workspaceIdentity,
      taskId,
    });
    const state = useTaskQueryCacheStore.getState();
    const matchingQueries = Object.values(state.resultsByQueryKey)
      .filter(
        (result) =>
          result.descriptor.kind === "workspace" &&
          result.descriptor.workspaceKeys.includes(workspaceKey) &&
          result.taskKeys.includes(entityKey),
      )
      .sort((left, right) => right.fetchedAt - left.fetchedAt);
    const latestQuery = matchingQueries[0] ?? null;
    const task = state.taskMetaByEntityKey[entityKey];
    const activity = task ? getTaskListRowActivity(task) : null;
    return {
      matchingQueryCount: matchingQueries.length,
      latestQueryStale: latestQuery?.stale ?? null,
      latestInvalidationVersion: latestQuery?.invalidationVersion ?? null,
      taskPresent: Boolean(task),
      taskStatus: task?.status ?? null,
      activityPhase: activity?.phase ?? null,
    };
  },
};
