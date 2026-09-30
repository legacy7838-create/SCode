// Delayed trusted parsing of recommended prompts requires knowing whether the user edited Composer while waiting.
// revision only exists in renderer memory and does not enter draft persistence, protocol or remote synchronization; workspace identity
// Use the same workspaceKey as the Zustand draft to avoid local path and remote identity string writing.
const revisionByWorkspaceKey = new Map<string, number>();

function getWorkspaceKey(workspacePath: string, workspaceIdentity?: string): string {
  return workspaceIdentity?.trim() || workspacePath;
}

export function getComposerDraftRevision(
  workspacePath: string,
  workspaceIdentity?: string,
): number {
  return revisionByWorkspaceKey.get(getWorkspaceKey(workspacePath, workspaceIdentity)) ?? 0;
}

export function advanceComposerDraftRevision(
  workspacePath: string,
  workspaceIdentity?: string,
): number {
  const workspaceKey = getWorkspaceKey(workspacePath, workspaceIdentity);
  const nextRevision = (revisionByWorkspaceKey.get(workspaceKey) ?? 0) + 1;
  revisionByWorkspaceKey.set(workspaceKey, nextRevision);
  return nextRevision;
}
