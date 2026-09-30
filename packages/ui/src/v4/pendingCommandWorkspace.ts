import type { SessionCreateSource } from "@zcode/shared";
import type { GroupedDraftTaskState } from "@/store/zcodeSessionStoreTypes.js";

export interface PendingCommandClientContext {
  workspace?: {
    workspacePath: string;
    workspaceIdentity?: string;
  };
  groupedDraftTask?: GroupedDraftTaskState;
  sessionCreateSource?: SessionCreateSource;
}

interface WorkspaceScopedPendingCommand {
  clientContext?: PendingCommandClientContext;
  replay: {
    kind: "input" | "sensitiveDigest";
    type: string;
    payload?: Record<string, unknown>;
  };
}

function resolvePendingCommandWorkspaceKey(entry: WorkspaceScopedPendingCommand): string | null {
  const workspace = entry.clientContext?.workspace;
  if (workspace) {
    return workspace.workspaceIdentity?.trim() || workspace.workspacePath;
  }
  if (entry.replay.kind !== "input" || entry.replay.type !== "createSession") {
    return null;
  }
  // Compatible with the createSession recovery clue that has been placed before the upgrade: the workspaceId of the protocol payload
  // It is the initiating workspaceKey and cannot be displayed across workspaces due to the lack of a new clientContext.
  const workspaceId = entry.replay.payload?.workspaceId;
  return typeof workspaceId === "string" && workspaceId.trim() ? workspaceId.trim() : null;
}

export function isPendingCommandForWorkspace(
  entry: WorkspaceScopedPendingCommand,
  workspacePath: string,
  workspaceIdentity?: string,
): boolean {
  return resolvePendingCommandWorkspaceKey(entry) === (workspaceIdentity?.trim() || workspacePath);
}
