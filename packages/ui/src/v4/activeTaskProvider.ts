import type { ZCodeProvider } from "@zcode/shared";
import { selectWorkspaceZCodeState, useZCodeSessionStore } from "@/store/zcodeSessionStore.js";
import type { WorkspaceZCodeUIState } from "@/store/zcodeSessionStoreTypes.js";
import { useTabStore } from "@/store/TabStoreProvider.js";
import { isWorkspaceTab } from "@/store/tabStore.js";

function resolveChatViewActiveTaskProvider(
  taskId: string | null,
  workspaceState: Pick<
    WorkspaceZCodeUIState,
    "selectedProvider" | "taskListCache" | "optimisticTaskListByTaskId"
  >,
): ZCodeProvider {
  if (!taskId) {
    return workspaceState.selectedProvider;
  }

  // The $/ skill list and / panel in the input box only looked at the provider currently selected in the workspace.
  // Once the user switches to a historical task, a fork task, or the task provider is temporarily inconsistent with the workspace default value,
  // The panel will be mixed with other agent skills, and even the available_skills injected before sending will also deviate.
  // Here, priority is given to reading the current task's own provider, so that "the task currently being viewed" becomes the only true value.
  // In addition, after the Agent is successfully switched, the old provider in taskListCache may be refreshed a little later;
  // The optimistic meta is the latest result that has just been confirmed by the current front end, so you must eat optimistic first before the icon will switch immediately.
  return (
    workspaceState.optimisticTaskListByTaskId[taskId]?.provider ??
    workspaceState.taskListCache?.find((task) => task.taskId === taskId)?.provider ??
    workspaceState.selectedProvider
  );
}

export function useChatViewActiveTaskProvider(
  taskId: string | null,
  workspacePath: string,
  workspaceIdentity?: string,
) {
  const activeTabWorkspaceIdentity = useTabStore((state) => {
    if (!state.activeTabId) {
      return undefined;
    }

    const activeTab = state.tabs.find((tab) => tab.id === state.activeTabId);
    if (!activeTab || !isWorkspaceTab(activeTab) || activeTab.workspacePath !== workspacePath) {
      return undefined;
    }

    return activeTab.workspaceIdentity;
  });
  const resolvedWorkspaceIdentity = workspaceIdentity ?? activeTabWorkspaceIdentity;

  return useZCodeSessionStore((state) => {
    const workspaceState = selectWorkspaceZCodeState(
      state,
      workspacePath,
      resolvedWorkspaceIdentity,
    );

    return resolveChatViewActiveTaskProvider(taskId, workspaceState);
  });
}
