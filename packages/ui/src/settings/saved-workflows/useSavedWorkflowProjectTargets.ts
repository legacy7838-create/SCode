import { useMemo } from "react";
import type { ZCodeAgentWorkspaceTarget } from "@zcode/services";
import type { AutomationWorkspaceOption } from "@/settings/automationWorkspaceOptions.js";
import type { SavedWorkflowProjectTarget } from "@/settings/saved-workflows/savedWorkflowContract.js";
import type { SavedWorkflowLaunchTarget } from "@/settings/saved-workflows/useSavedWorkflowLauncher.js";

interface SavedWorkflowProjectTargets {
  /** RPC target (including remoteSessionId), for store / service method calls. */
  target: ZCodeAgentWorkspaceTarget;
  /**
   * Project coordinates sent to the conversation / for opening an instance: only workspacePath +
   * identity (without remoteSessionId).
   */
  projectTarget: SavedWorkflowProjectTarget;
  /**
   * Connection coordinates for a direct launch: additionally carry remoteSessionId, which decides
   * the conversation connection endpoint and the navigation target.
   */
  launchTarget: SavedWorkflowLaunchTarget;
}

/**
 * The three sets of coordinates a project group needs (every action carries **this project's**
 * target). The three differ only in whether they carry remoteSessionId; the references stay stable
 * while the dependencies do not, so they can serve as memo / effect dependencies.
 */
export function useSavedWorkflowProjectTargets(
  project: Pick<AutomationWorkspaceOption, "workspacePath" | "workspaceIdentity">,
  remoteSessionId: string | null,
): SavedWorkflowProjectTargets {
  const target = useMemo<ZCodeAgentWorkspaceTarget>(
    () => ({
      workspacePath: project.workspacePath,
      ...(project.workspaceIdentity?.trim()
        ? { workspaceIdentity: project.workspaceIdentity }
        : {}),
      ...(remoteSessionId ? { remoteSessionId } : {}),
    }),
    [project.workspacePath, project.workspaceIdentity, remoteSessionId],
  );
  const projectTarget = useMemo<SavedWorkflowProjectTarget>(
    () => ({
      workspacePath: project.workspacePath,
      ...(project.workspaceIdentity ? { workspaceIdentity: project.workspaceIdentity } : {}),
    }),
    [project.workspacePath, project.workspaceIdentity],
  );
  const launchTarget = useMemo<SavedWorkflowLaunchTarget>(
    () => ({
      workspacePath: project.workspacePath,
      ...(project.workspaceIdentity ? { workspaceIdentity: project.workspaceIdentity } : {}),
      ...(remoteSessionId ? { remoteSessionId } : {}),
    }),
    [project.workspacePath, project.workspaceIdentity, remoteSessionId],
  );
  return { target, projectTarget, launchTarget };
}
