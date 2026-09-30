import { useShallow } from "zustand/react/shallow";
import {
  getWorkspaceDisplayedTaskState,
  selectWorkspaceZCodeState,
  useZCodeSessionStore,
  type WorkspaceZCodeUIState,
} from "@/store/zcodeSessionStore.js";
import { resolveWorkspaceModelConfigSyncScope } from "@/lib/modelConfigSync.js";
import { hasBusyTaskInWorkspaceProvider } from "@/lib/workspaceBusyTaskLock.js";

type WorkspaceShellZCodeState = Pick<
  WorkspaceZCodeUIState,
  | "activeTaskId"
  | "draftFocusVersion"
  | "modelSwitchPending"
  | "modelSwitchStage"
  | "selectedProvider"
  | "selectedSupplierKey"
  | "configOptions"
  | "optimisticTaskListByTaskId"
  | "workspaceInit"
> &
  ReturnType<typeof getWorkspaceDisplayedTaskState>;

export function useWorkspaceShellZCodeState(workspaceAbsPath: string, workspaceIdentity?: string) {
  // App previously directly subscribed to the entire workspaceZCodeState, and each chunk of streaming would change taskMessagesByTaskId.
  // This will drag the sidebar, header, and Git derivation logic into synchronous re-rendering. This is how the string of long tasks in the performance trace is amplified.
  // Here, the fields that the shell really depends on are converged into shallow comparison selectors to prevent the message flow from disturbing irrelevant UI.
  const workspaceShellZCodeState = useZCodeSessionStore(
    useShallow((state): WorkspaceShellZCodeState => {
      const workspaceState = selectWorkspaceZCodeState(state, workspaceAbsPath, workspaceIdentity);
      const displayedTaskState = getWorkspaceDisplayedTaskState(workspaceState);
      return {
        activeTaskId: workspaceState.activeTaskId,
        draftFocusVersion: workspaceState.draftFocusVersion,
        modelSwitchPending: workspaceState.modelSwitchPending,
        modelSwitchStage: workspaceState.modelSwitchStage,
        selectedProvider: workspaceState.selectedProvider,
        selectedSupplierKey: workspaceState.selectedSupplierKey,
        configOptions: workspaceState.configOptions,
        optimisticTaskListByTaskId: workspaceState.optimisticTaskListByTaskId,
        workspaceInit: workspaceState.workspaceInit,
        taskStatus: displayedTaskState.taskStatus,
        taskError: displayedTaskState.taskError,
      };
    }),
  );

  const reloadSessionDisabled = useZCodeSessionStore((state) => {
    const workspaceState = selectWorkspaceZCodeState(state, workspaceAbsPath, workspaceIdentity);
    const actionScope = resolveWorkspaceModelConfigSyncScope(workspaceState);
    return hasBusyTaskInWorkspaceProvider(
      actionScope.provider,
      workspaceState.taskRuntimeByTaskId,
      workspaceState.optimisticTaskListByTaskId,
      workspaceState.taskListCache,
      workspaceState.activeTaskId,
    );
  });

  return { workspaceShellZCodeState, reloadSessionDisabled };
}
