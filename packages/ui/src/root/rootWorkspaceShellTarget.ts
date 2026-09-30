import { buildTaskWorkspaceKey } from "@/lib/taskQueryCache.js";

interface WorkspaceShellTargetTab {
  workspacePath: string;
  remoteSessionId?: string;
  workspaceIdentity?: string;
}

interface RootWorkspaceShellTarget {
  workspaceShellPath: string | null;
  workspaceIdentity?: string;
  workspaceRemoteSessionId?: string;
}

function normalizeOptionalString(value?: string | null): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

export function resolveRootWorkspaceShellTarget({
  activeWorkspaceTab,
  activeWorkspacePath,
  activeWorkspaceIdentity,
  workspaceTabs,
}: {
  activeWorkspaceTab: WorkspaceShellTargetTab | null;
  activeWorkspacePath: string | null;
  activeWorkspaceIdentity: string | null;
  /** All workspace tabs in the current window; Settings and other non-workspace tabs are used to retrieve the overwritten tab when activated. */
  workspaceTabs: readonly WorkspaceShellTargetTab[];
}): RootWorkspaceShellTarget {
  if (activeWorkspaceTab) {
    return {
      workspaceShellPath: activeWorkspaceTab.workspacePath,
      workspaceIdentity: normalizeOptionalString(activeWorkspaceTab.workspaceIdentity),
      workspaceRemoteSessionId: normalizeOptionalString(activeWorkspaceTab.remoteSessionId),
    };
  }

  // When the Settings tab overrides the workspace, the active tab is not the workspace tab.
  // Previously, only workspacePath was fallbacked, but workspaceIdentity was not fallbacked, resulting in the disconnected SSH path being misjudged as the local base service.
  const workspaceIdentity = normalizeOptionalString(activeWorkspaceIdentity);
  // The above fix still sets workspaceRemoteSessionId to undefined. Use it to do the completion notification hook in the App
  // The endpointKey of the sessions-index registry. If it is missing, a new store will be built for the same remote workspace using the `__base__` key.
  // And send another subscribe to the same topic; CLI only retains the latest subscription for the same connection/topic, and the subscription currently used in the sidebar
  // Replaced by silence, frames will never be received after that - the task on the left keeps spinning in circles and time stops at the moment when the settings page is opened.
  // The overwritten workspace tab is still in the tab list. Here, press workspaceKey to retrieve it, ensuring that the shell target is completely consistent with the tab activation state.
  const coveredWorkspaceTab =
    activeWorkspacePath === null
      ? undefined
      : workspaceTabs.find(
          (tab) =>
            buildTaskWorkspaceKey(tab.workspacePath, tab.workspaceIdentity) ===
            buildTaskWorkspaceKey(activeWorkspacePath, workspaceIdentity),
        );

  return {
    workspaceShellPath: activeWorkspacePath,
    workspaceIdentity,
    workspaceRemoteSessionId: normalizeOptionalString(coveredWorkspaceTab?.remoteSessionId),
  };
}
