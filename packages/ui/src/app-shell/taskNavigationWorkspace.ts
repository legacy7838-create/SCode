type TaskNavigationWorkspaceResult =
  | { accepted: true; openedLocalTab: boolean }
  | { accepted: false; reason: "remote_attachment_missing" };

export function ensureTaskNavigationWorkspace(params: {
  workspacePath: string;
  workspaceIdentity?: string;
  activateTabByPath: (workspacePath: string, options?: { workspaceIdentity?: string }) => boolean;
  addLocalWorkspaceTab: (workspacePath: string) => void;
}): TaskNavigationWorkspaceResult {
  const workspaceIdentity = params.workspaceIdentity?.trim();
  if (
    params.activateTabByPath(
      params.workspacePath,
      workspaceIdentity ? { workspaceIdentity } : undefined,
    )
  ) {
    return { accepted: true, openedLocalTab: false };
  }

  if (workspaceIdentity) {
    // The identity of the remote workspace only expresses the isolation identity and cannot be used to reconstruct SSH/WSL.
    // attachment. The current window must be fail-closed when there is no matching tab to avoid creating pseudo-remote tabs that cannot be connected.
    return { accepted: false, reason: "remote_attachment_missing" };
  }

  // Automations are a cross-project list, and the local workspace to which the run history belongs may have been closed.
  // If you just try activate, Automations will still be closed if it fails, and you will end up in the old session of the current project.
  params.addLocalWorkspaceTab(params.workspacePath);
  return { accepted: true, openedLocalTab: true };
}
