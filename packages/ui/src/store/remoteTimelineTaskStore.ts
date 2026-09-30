import { create } from "zustand";
import type { ZCodeTaskMeta } from "@zcode/shared";
import type { ZCodeTaskListSortBy, IZCodeTaskService } from "@zcode/services";
import { logger } from "@/logger.js";
import { buildTaskWorkspaceKey } from "@/lib/taskQueryCache.js";
import { getRemoteWorkspaceSession } from "@/store/remoteWorkspaceSessionStore.js";

interface RemoteTimelineTaskState {
  itemsByWorkspaceKey: Record<string, ZCodeTaskMeta[]>;
  totalByWorkspaceKey: Record<string, number>;
  hasMoreByWorkspaceKey: Record<string, boolean>;
  loadingByWorkspaceKey: Record<string, boolean>;
  errorByWorkspaceKey: Record<string, string>;
  refreshWorkspace: (params: {
    workspacePath: string;
    workspaceIdentity?: string;
    zcodeTaskService: Pick<IZCodeTaskService, "listTaskList">;
    sortBy: ZCodeTaskListSortBy;
    limit?: number;
  }) => Promise<void>;
  upsertTask: (task: ZCodeTaskMeta, sortBy?: ZCodeTaskListSortBy) => void;
  removeTask: (workspacePath: string, taskId: string, workspaceIdentity?: string) => void;
  clearWorkspace: (workspacePath: string, workspaceIdentity?: string) => void;
}

function getWorkspaceKey(workspacePath: string, workspaceIdentity?: string): string {
  return buildTaskWorkspaceKey(workspacePath, workspaceIdentity);
}

function sortTimelineTasks(
  tasks: ZCodeTaskMeta[],
  sortBy: ZCodeTaskListSortBy = "updated",
): ZCodeTaskMeta[] {
  return [...tasks].sort((left, right) => {
    if (sortBy === "created") {
      if (right.createdAt !== left.createdAt) {
        return right.createdAt - left.createdAt;
      }
      if (right.updatedAt !== left.updatedAt) {
        return right.updatedAt - left.updatedAt;
      }
      return right.taskId.localeCompare(left.taskId);
    }
    if (right.updatedAt !== left.updatedAt) {
      return right.updatedAt - left.updatedAt;
    }
    if (right.createdAt !== left.createdAt) {
      return right.createdAt - left.createdAt;
    }
    return right.taskId.localeCompare(left.taskId);
  });
}

export const useRemoteTimelineTaskStore = create<RemoteTimelineTaskState>()((set) => ({
  itemsByWorkspaceKey: {},
  totalByWorkspaceKey: {},
  hasMoreByWorkspaceKey: {},
  loadingByWorkspaceKey: {},
  errorByWorkspaceKey: {},
  async refreshWorkspace({ workspacePath, workspaceIdentity, zcodeTaskService, sortBy, limit }) {
    const workspaceKey = getWorkspaceKey(workspacePath, workspaceIdentity);
    set((state) => ({
      loadingByWorkspaceKey: {
        ...state.loadingByWorkspaceKey,
        [workspaceKey]: true,
      },
      errorByWorkspaceKey: {
        ...state.errorByWorkspaceKey,
        [workspaceKey]: "",
      },
    }));

    try {
      const result = await zcodeTaskService.listTaskList({
        kind: "timeline",
        workspaceScopes: [
          {
            workspacePath,
            ...(workspaceIdentity ? { workspaceIdentity } : {}),
          },
        ],
        sortBy,
        limit,
      });
      set((state) => ({
        itemsByWorkspaceKey: {
          ...state.itemsByWorkspaceKey,
          [workspaceKey]: sortTimelineTasks(result.items, sortBy),
        },
        totalByWorkspaceKey: {
          ...state.totalByWorkspaceKey,
          [workspaceKey]: result.total,
        },
        hasMoreByWorkspaceKey: {
          ...state.hasMoreByWorkspaceKey,
          [workspaceKey]: result.hasMore,
        },
        loadingByWorkspaceKey: {
          ...state.loadingByWorkspaceKey,
          [workspaceKey]: false,
        },
      }));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // The remote timeline is a supplementary link after the remote end is ready. Reading failure cannot prevent the workspace from being restored.
      // Only the status and logs are recorded here, and they will be completed when switching timelines or reconnecting later.
      logger.warn("[remoteTimelineTaskStore] failed to read remote timeline tasks", {
        workspacePath,
        workspaceIdentity,
        error: message,
      });
      set((state) => ({
        loadingByWorkspaceKey: {
          ...state.loadingByWorkspaceKey,
          [workspaceKey]: false,
        },
        errorByWorkspaceKey: {
          ...state.errorByWorkspaceKey,
          [workspaceKey]: message,
        },
      }));
    }
  },
  upsertTask(task, sortBy = "updated") {
    const workspaceKey = getWorkspaceKey(task.workspacePath, task.workspaceIdentity);
    set((state) => {
      const currentItems = state.itemsByWorkspaceKey[workspaceKey] ?? [];
      const nextItems = currentItems.some((item) => item.taskId === task.taskId)
        ? currentItems.map((item) => (item.taskId === task.taskId ? task : item))
        : [...currentItems, task];
      return {
        itemsByWorkspaceKey: {
          ...state.itemsByWorkspaceKey,
          [workspaceKey]: sortTimelineTasks(nextItems, sortBy),
        },
        totalByWorkspaceKey: {
          ...state.totalByWorkspaceKey,
          [workspaceKey]: Math.max(state.totalByWorkspaceKey[workspaceKey] ?? 0, nextItems.length),
        },
      };
    });
  },
  removeTask(workspacePath, taskId, workspaceIdentity) {
    const workspaceKey = getWorkspaceKey(workspacePath, workspaceIdentity);
    set((state) => ({
      itemsByWorkspaceKey: {
        ...state.itemsByWorkspaceKey,
        [workspaceKey]: (state.itemsByWorkspaceKey[workspaceKey] ?? []).filter(
          (task) => task.taskId !== taskId,
        ),
      },
      totalByWorkspaceKey: {
        ...state.totalByWorkspaceKey,
        [workspaceKey]: Math.max(
          0,
          (state.totalByWorkspaceKey[workspaceKey] ??
            state.itemsByWorkspaceKey[workspaceKey]?.length ??
            0) - 1,
        ),
      },
    }));
  },
  clearWorkspace(workspacePath, workspaceIdentity) {
    const workspaceKey = getWorkspaceKey(workspacePath, workspaceIdentity);
    set((state) => {
      const { [workspaceKey]: _removedItems, ...itemsByWorkspaceKey } = state.itemsByWorkspaceKey;
      const { [workspaceKey]: _removedTotal, ...totalByWorkspaceKey } = state.totalByWorkspaceKey;
      const { [workspaceKey]: _removedHasMore, ...hasMoreByWorkspaceKey } =
        state.hasMoreByWorkspaceKey;
      const { [workspaceKey]: _removedLoading, ...loadingByWorkspaceKey } =
        state.loadingByWorkspaceKey;
      const { [workspaceKey]: _removedError, ...errorByWorkspaceKey } = state.errorByWorkspaceKey;
      return {
        itemsByWorkspaceKey,
        totalByWorkspaceKey,
        hasMoreByWorkspaceKey,
        loadingByWorkspaceKey,
        errorByWorkspaceKey,
      };
    });
  },
}));

export async function refreshRemoteTimelineTasksForSession({
  sessionId,
  workspacePath,
  workspaceIdentity,
  sortBy = "updated",
  limit = 10,
}: {
  sessionId: string;
  workspacePath: string;
  workspaceIdentity?: string;
  sortBy?: ZCodeTaskListSortBy;
  limit?: number;
}): Promise<void> {
  const session = getRemoteWorkspaceSession(sessionId);
  if (!session) {
    logger.warn(
      "[remoteTimelineTaskStore] remote session not registered yet, skipping timeline read",
      {
        sessionId,
        workspacePath,
        workspaceIdentity,
      },
    );
    return;
  }

  await useRemoteTimelineTaskStore.getState().refreshWorkspace({
    workspacePath,
    workspaceIdentity,
    zcodeTaskService: session.services.zcodeTaskService,
    sortBy,
    limit,
  });
}
