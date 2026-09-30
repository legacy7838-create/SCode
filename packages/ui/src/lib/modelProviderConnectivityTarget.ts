interface ConnectivityWorkspaceTab {
  workspacePath: string;
  workspaceIdentity?: string | null;
  remoteSessionId?: string | null;
  remoteTarget?: unknown;
  localWorkspacePath?: string | null;
}

function isRemoteWorkspaceTab(tab: ConnectivityWorkspaceTab | null | undefined): boolean {
  return Boolean(
    tab?.workspaceIdentity?.trim() || tab?.remoteSessionId?.trim() || tab?.remoteTarget,
  );
}

/**
 * Provider Settings belongs to a local Environment; when a connectivity probe needs a cwd, only a
 * local workspace can be chosen. A remote tab's workspacePath is a remote filesystem path and
 * cannot be handed to the Local Host directly.
 */
export function resolveModelProviderConnectivityWorkspacePath(params: {
  activeWorkspacePath?: string | null;
  activeWorkspaceIdentity?: string | null;
  activeWorkspaceTab?: ConnectivityWorkspaceTab | null;
  workspaceTabs: readonly ConnectivityWorkspaceTab[];
}): string {
  const rememberedLocalPath = params.activeWorkspaceTab?.localWorkspacePath?.trim();
  if (rememberedLocalPath) {
    return rememberedLocalPath;
  }

  // Old tabs may only have remoteSessionId or remoteTarget, but no workspaceIdentity.
  // The workspacePath of these tabs is still a remote path and cannot be handed over to the Local Host due to missing identity.
  const activeWorkspaceIsRemote = Boolean(
    params.activeWorkspaceIdentity?.trim() || isRemoteWorkspaceTab(params.activeWorkspaceTab),
  );
  if (!activeWorkspaceIsRemote) {
    const activeLocalPath = params.activeWorkspaceTab?.workspacePath.trim();
    if (activeLocalPath) {
      return activeLocalPath;
    }
    const activeWorkspacePath = params.activeWorkspacePath?.trim();
    if (activeWorkspacePath) {
      return activeWorkspacePath;
    }
  }

  const localTab = params.workspaceTabs.find((tab) => !isRemoteWorkspaceTab(tab));
  return localTab?.workspacePath.trim() ?? "";
}
