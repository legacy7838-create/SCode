export function runWorkspaceVisibleCommand({
  isWorkspaceVisible,
  onReturnToWorkspace,
  run,
}: {
  isWorkspaceVisible: boolean;
  onReturnToWorkspace?: () => void;
  run: () => void;
}) {
  if (!isWorkspaceVisible) {
    // The settings page just covers the workspace, and the underlying App will still respond to quickpick/shortcut keys.
    // If you directly execute workspace commands such as sidebar, terminal, file search, etc., the status will change on the underlying layer that is covered, and it will appear to the user that the command has not taken effect.
    // Here, switch back to the workspace and then execute the command, so that the user can see the command results immediately.
    onReturnToWorkspace?.();
  }

  run();
}
