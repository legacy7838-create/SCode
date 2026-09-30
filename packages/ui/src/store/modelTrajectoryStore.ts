import { create } from "zustand";

/**
 * Open the request bridge store in the "Model Call Track" sidebar.
 *
 * Background: The trigger entry is in the task right-click menu/Header menu, and the mounting position is very deep; and the sidebar tab status is
 * UseAppPanels held per workspace. To avoid running a new callback through the entire task list tree,
 * A lightweight singleton store is used here as a bridge: the menu writes pending requests to the target workspace
 * useAppPanels subscribes and consumes (matched by workspaceKey to avoid multiple workspace instances from being linked together).
 */
interface ModelTrajectoryOpenRequest {
  /** The unique request id ensures that continuous clicks on the same task can trigger consumption. */
  requestId: string;
  taskId: string;
  /** workspaceIdentity?.trim() || workspacePath, used to locate the target workspace sidebar. */
  workspaceKey: string;
  title?: string | null;
}

interface ModelTrajectoryStoreState {
  pendingRequest: ModelTrajectoryOpenRequest | null;
  requestOpen: (request: Omit<ModelTrajectoryOpenRequest, "requestId">) => void;
  consumeRequest: (requestId: string) => void;
}

declare global {
  interface Window {
    __zcodeModelTrajectoryStoreE2E?: typeof useModelTrajectoryStore;
  }
}

let requestSeq = 0;

export const useModelTrajectoryStore = create<ModelTrajectoryStoreState>((set) => ({
  pendingRequest: null,
  requestOpen: (request) => {
    requestSeq += 1;
    set({
      pendingRequest: { ...request, requestId: `model-trajectory-open:${requestSeq}` },
    });
  },
  consumeRequest: (requestId) => {
    set((state) =>
      state.pendingRequest?.requestId === requestId ? { pendingRequest: null } : state,
    );
  },
}));

// E2E needs to directly verify the complete link of the request bridge → target workspace side pane in the dual workspace shell.
// The Header menu is only bound to the activeTaskId of the current header and cannot be used as a stable test entry for split pane;
// Maintain the same pattern as __zcodeSessionStoreE2E, exposing the store itself instead of creating a separate test-specific business implementation.
if (typeof window !== "undefined") {
  window.__zcodeModelTrajectoryStoreE2E = useModelTrajectoryStore;
}
