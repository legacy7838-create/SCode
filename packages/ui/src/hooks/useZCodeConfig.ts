/**
 * ZCode Agent ConfigOptions convenience hooks
 *
 * Only the model catalog read hook that V4ComposerToolbar depends on is kept; the config write path
 * goes through v4 commands (switchModelConfig and the rest), so this file contains no write-path
 * hooks.
 */
import { useShallow } from "zustand/react/shallow";
import { resolveTaskRestorePreloadConfigOptions } from "@/lib/taskModelRecovery.js";
import {
  getTaskMeta,
  useZCodeSessionStore,
  selectWorkspaceZCodeState,
} from "@/store/zcodeSessionStore.js";
import type { ConfigOptionsStatus } from "@/store/zcodeSessionStoreTypes.js";
import { useTabStore } from "@/store/TabStoreProvider.js";
import { isWorkspaceTab } from "@/store/tabStore.js";

function useActiveWorkspaceIdentity(workspacePath: string): string | undefined {
  return useTabStore((state) => {
    if (!state.activeTabId) {
      return undefined;
    }

    const activeTab = state.tabs.find((tab) => tab.id === state.activeTabId);
    if (!activeTab || !isWorkspaceTab(activeTab) || activeTab.workspacePath !== workspacePath) {
      return undefined;
    }

    return activeTab.workspaceIdentity;
  });
}

/**
 * Fetches the configOptions for the toolbar's current scope: the task snapshot for an active task,
 * the workspace default config in draft state.
 */
export function useToolbarConfigOptions(
  workspacePath: string,
  taskId: string | null,
  workspaceIdentity?: string,
) {
  const activeWorkspaceIdentity = useActiveWorkspaceIdentity(workspacePath);
  const resolvedWorkspaceIdentity = workspaceIdentity ?? activeWorkspaceIdentity;
  const { configOptions, configOptionsStatus } = useZCodeSessionStore(
    useShallow((state) => {
      const workspaceState = selectWorkspaceZCodeState(
        state,
        workspacePath,
        resolvedWorkspaceIdentity,
      );
      if (taskId && workspaceState.activeTaskId === taskId) {
        const taskConfigOptions = workspaceState.taskConfigOptionsByTaskId[taskId];
        const taskConfigOptionsStatus = workspaceState.taskConfigOptionsStatusByTaskId[taskId];
        if (taskConfigOptions) {
          return {
            configOptions: taskConfigOptions,
            configOptionsStatus: taskConfigOptionsStatus ?? "ready",
          };
        }

        const taskMeta = getTaskMeta(workspaceState, taskId);
        const preloadedConfigOptions = resolveTaskRestorePreloadConfigOptions({
          taskMeta: {
            provider: taskMeta?.provider ?? workspaceState.selectedProvider,
            model: taskMeta?.model,
          },
        });
        return {
          configOptions: preloadedConfigOptions,
          configOptionsStatus: preloadedConfigOptions.length > 0 ? "loading" : "idle",
        };
      }

      return {
        configOptions: workspaceState.configOptions,
        configOptionsStatus: workspaceState.configOptionsStatus,
      };
    }),
  );

  return {
    configOptions: configOptions ?? [],
    status: configOptionsStatus as ConfigOptionsStatus,
    loading: configOptionsStatus === "loading",
    error: configOptionsStatus === "error",
  };
}
