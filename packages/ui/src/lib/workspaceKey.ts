/**
 * Identity / isolation semantics uniformly use workspaceIdentity, with a fallback path for legacy
 * local calls that have no identity. remoteSessionId is not included: it describes the connection
 * instance and does not change the workspace identity.
 */
export function getWorkspaceKey(workspacePath: string, workspaceIdentity?: string | null): string {
  return workspaceIdentity?.trim() || workspacePath;
}
