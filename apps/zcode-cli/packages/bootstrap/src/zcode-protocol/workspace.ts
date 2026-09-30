import { parseRemoteWorkspaceIdentity, type ZCodeWorkspaceRef } from "@zcode/shared";

export function buildWorkspaceRef(input: {
  workspaceIdentity?: string;
  workspacePath: string;
}): ZCodeWorkspaceRef {
  const workspaceIdentity = input.workspaceIdentity?.trim() || undefined;
  return {
    workspaceIdentity,
    workspaceKey: workspaceIdentity ?? input.workspacePath,
    workspacePath: input.workspacePath,
  };
}

/**
 * Unifies the two shapes of a V4 workspaceId — the local path and the remote identity — back into a workspace ref.
 */
export function resolveWorkspaceRefFromId(workspaceId: string): ZCodeWorkspaceRef {
  const parsedRemote = parseRemoteWorkspaceIdentity(workspaceId);
  if (!parsedRemote) {
    // If the illegal remote identity continues to be processed according to the local path, the identity will be written again.
    // directory/path. The remote namespace must be fail-closed, and the local path still retains the original fallback.
    if (workspaceId.startsWith("remote:")) {
      throw new Error(`Invalid remote workspace identity: ${workspaceId}`);
    }
    return buildWorkspaceRef({ workspacePath: workspaceId });
  }

  // WSL identity with explicit user would fall into the local path branch after failed parsing before.
  // Causes the full identity to be treated as workingDirectory. Here, the shared parser is used to split the identity and path.
  return buildWorkspaceRef({
    workspaceIdentity: workspaceId,
    workspacePath: parsedRemote.workspacePath,
  });
}
