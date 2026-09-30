import { useEffect } from "react";
import { useModelTrajectoryStore } from "@/store/modelTrajectoryStore.js";

/**
 * Subscribes to "open model call trajectory" requests and hands them to the sidebar controller of
 * the current workspace.
 *
 * The trigger lives deep in the task context menu / Header menu and raises the request through a
 * singleton store; here it is matched by workspaceKey, onOpen is called to open the sidebar tab,
 * and the request is then consumed, so that multiple workspace instances never open each other's
 * panes.
 */
export function useModelTrajectoryOpenBridge(
  ownWorkspaceKey: string,
  onOpen: (params: { taskId: string; title?: string | null }) => void,
): void {
  useEffect(() => {
    const handlePending = (
      pendingRequest: ReturnType<typeof useModelTrajectoryStore.getState>["pendingRequest"],
    ) => {
      if (!pendingRequest || pendingRequest.workspaceKey !== ownWorkspaceKey) {
        return;
      }
      onOpen({ taskId: pendingRequest.taskId, title: pendingRequest.title });
      useModelTrajectoryStore.getState().consumeRequest(pendingRequest.requestId);
    };

    // A pending request may already exist while subscribing (click and mount race), so handle the current value once first.
    handlePending(useModelTrajectoryStore.getState().pendingRequest);
    return useModelTrajectoryStore.subscribe((state) => {
      handlePending(state.pendingRequest);
    });
  }, [onOpen, ownWorkspaceKey]);
}
