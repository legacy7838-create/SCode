import { getVisibleTaskMetas } from "@/store/zcodeSessionStoreSelectors.js";
import type { WorkspaceZCodeUIState } from "@/store/zcodeSessionStoreTypes.js";

type WorkspaceUnreadState = Pick<
  WorkspaceZCodeUIState,
  "optimisticTaskListByTaskId" | "taskListCache"
> &
  Partial<Pick<WorkspaceZCodeUIState, "taskUnreadByTaskId">>;

export function countAllUnreadTasks(workspaces: Record<string, WorkspaceUnreadState>): number {
  const countedTaskKeys = new Set<string>();
  const visitedWorkspaceStates = new WeakSet<object>();

  for (const [workspaceKey, workspace] of Object.entries(workspaces)) {
    if (visitedWorkspaceStates.has(workspace)) {
      continue;
    }
    visitedWorkspaceStates.add(workspace);
    // The unread status is now based on task meta.unreadAt.
    // The Dock badge must read the same metadata as the task list blue point, and can no longer rely solely on the old temporary map.
    const visibleTasks = getVisibleTaskMetas(workspace);
    for (const task of visibleTasks) {
      if (!task.unreadAt) {
        continue;
      }
      countedTaskKeys.add(
        `${task.workspaceIdentity?.trim() || task.workspacePath}::${task.taskId}`,
      );
    }

    if (visibleTasks.length > 0) {
      continue;
    }

    // The remote workspace will retain the compatibility status of both the path key and the workspaceIdentity key.
    // Here, press workspaceKey + taskId to remove duplicates and skip the same object reference to prevent the window unread corner from counting the same remote task twice.
    for (const taskId of Object.keys(workspace.taskUnreadByTaskId ?? {})) {
      countedTaskKeys.add(`${workspaceKey}::${taskId}`);
    }
  }

  return countedTaskKeys.size;
}
