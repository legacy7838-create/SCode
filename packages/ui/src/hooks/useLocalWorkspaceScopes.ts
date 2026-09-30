import { useMemo } from "react";
import { isWorkspaceTab, type WorkspaceTabState } from "@/store/tabStore.js";

function isLocalWorkspaceTab(tab: WorkspaceTabState): boolean {
  return !tab.remoteSessionId && !tab.remoteTarget && !tab.workspaceIdentity;
}

export function useLocalWorkspaceScopes({
  workspaceTabs,
}: {
  workspaceTabs: WorkspaceTabState[];
}): WorkspaceTabState[] {
  return useMemo(
    () =>
      workspaceTabs.filter((tab) => {
        // Pinned queries only use local workspaces already open in this window.
        // Even a remote workspace persisted in lastWorkspaceSession must not fall back into the local query,
        // or a tab without a remoteSessionId would hit the local service and cross-read tasks by path.
        return isWorkspaceTab(tab) && isLocalWorkspaceTab(tab);
      }),
    [workspaceTabs],
  );
}
