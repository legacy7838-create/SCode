import { create } from "zustand";
import type { ZCodeTaskMeta } from "@zcode/shared";
import type { IZCodeTaskService } from "@zcode/services";
import { logger } from "@/logger.js";
import { buildTaskWorkspaceKey } from "@/lib/taskQueryCache.js";
import { getRemoteWorkspaceSession } from "@/store/remoteWorkspaceSessionStore.js";

interface RemotePinnedTaskState {
  itemsByWorkspaceKey: Record<string, ZCodeTaskMeta[]>;
  loadingByWorkspaceKey: Record<string, boolean>;
  errorByWorkspaceKey: Record<string, string>;
  refreshWorkspace: (params: {
    workspacePath: string;
    workspaceIdentity?: string;
    zcodeTaskService: Pick<IZCodeTaskService, "listPinnedTasks">;
  }) => Promise<void>;
  upsertTask: (task: ZCodeTaskMeta) => void;
  removeTask: (workspacePath: string, taskId: string, workspaceIdentity?: string) => void;
  clearWorkspace: (workspacePath: string, workspaceIdentity?: string) => void;
}

function getWorkspaceKey(workspacePath: string, workspaceIdentity?: string): string {
  return buildTaskWorkspaceKey(workspacePath, workspaceIdentity);
}

function sortPinnedTasks(tasks: ZCodeTaskMeta[]): ZCodeTaskMeta[] {
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

export const useRemotePinnedTaskStore = create<RemotePinnedTaskState>()((set) => ({
  itemsByWorkspaceKey: {},
  loadingByWorkspaceKey: {},
  errorByWorkspaceKey: {},
  async refreshWorkspace({ workspacePath, workspaceIdentity, zcodeTaskService }) {
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
      const items = await zcodeTaskService.listPinnedTasks({
        workspacePath,
        ...(workspaceIdentity ? { workspaceIdentity } : {}),
      });
      set((state) => ({
        itemsByWorkspaceKey: {
          ...state.itemsByWorkspaceKey,
          [workspaceKey]: sortPinnedTasks(items),
        },
        loadingByWorkspaceKey: {
          ...state.loadingByWorkspaceKey,
          [workspaceKey]: false,
        },
      }));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // The remote pinned is a supplementary link after successful reconnection. Reading failure cannot interrupt the workspace recovery.
      // Only status and logs are recorded here, so that users can still enter the workspace, and then reconnect/refresh to complete the pinned list.
      logger.warn("[remotePinnedTaskStore] failed to read remote pinned tasks", {
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
  upsertTask(task) {
    const workspaceKey = getWorkspaceKey(task.workspacePath, task.workspaceIdentity);
    set((state) => {
      const currentItems = state.itemsByWorkspaceKey[workspaceKey] ?? [];
      const nextItems = currentItems.some((item) => item.taskId === task.taskId)
        ? currentItems.map((item) => (item.taskId === task.taskId ? task : item))
        : [...currentItems, task];
      return {
        itemsByWorkspaceKey: {
          ...state.itemsByWorkspaceKey,
          [workspaceKey]: sortPinnedTasks(nextItems),
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
    }));
  },
  clearWorkspace(workspacePath, workspaceIdentity) {
    const workspaceKey = getWorkspaceKey(workspacePath, workspaceIdentity);
    set((state) => {
      const { [workspaceKey]: _removedItems, ...itemsByWorkspaceKey } = state.itemsByWorkspaceKey;
      const { [workspaceKey]: _removedLoading, ...loadingByWorkspaceKey } =
        state.loadingByWorkspaceKey;
      const { [workspaceKey]: _removedError, ...errorByWorkspaceKey } = state.errorByWorkspaceKey;
      return {
        itemsByWorkspaceKey,
        loadingByWorkspaceKey,
        errorByWorkspaceKey,
      };
    });
  },
}));

export async function refreshRemotePinnedTasksForSession({
  sessionId,
  workspacePath,
  workspaceIdentity,
}: {
  sessionId: string;
  workspacePath: string;
  workspaceIdentity?: string;
}): Promise<void> {
  const session = getRemoteWorkspaceSession(sessionId);
  if (!session) {
    logger.warn("[remotePinnedTaskStore] remote session not registered yet, skipping pinned read", {
      sessionId,
      workspacePath,
      workspaceIdentity,
    });
    return;
  }

  await useRemotePinnedTaskStore.getState().refreshWorkspace({
    workspacePath,
    workspaceIdentity,
    zcodeTaskService: session.services.zcodeTaskService,
  });
}
