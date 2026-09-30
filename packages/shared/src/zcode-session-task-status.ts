// ── Old protocol compatibility (transition period)─────────────────────────────
// 1 export remaining: deriveZCodeTaskStatusFromSessionSnapshot.
// Consumer: zcodeTaskServiceAdapter/zcodeTaskIndexSyncer/zcodeSessionProjection (old projection stack).
import type { ZCodeSessionStateSnapshot } from "./zcode-protocol/index.js";
import { getZCodeUserVisibleMessages } from "./zcode-session-visible-content.js";
import type { ZCodeTaskMeta } from "./zcode-task-types-core.js";
type ZCodeTaskStatus = ZCodeTaskMeta["status"];

function statusFromZCodeSession(
  status: ZCodeSessionStateSnapshot["session"]["status"],
): ZCodeTaskStatus {
  if (status === "running" || status === "waiting" || status === "paused") {
    return "running";
  }
  if (status === "error") return "error";
  if (status === "completed") return "completed";
  return undefined;
}

function hasBlockingActiveSnapshotRuntime(snapshot: ZCodeSessionStateSnapshot): boolean {
  if (snapshot.runtime.activeTurnId || snapshot.runtime.activeTurnKind) {
    return true;
  }
  // projection.currentTurnId is the turn boundary of the last projection, which will be retained after completion;
  // Only the runtime active field, permissions, or tool calls can prove that there is still a real blocking running state.
  if ((snapshot.projection.pendingPermissions ?? []).length > 0) {
    return true;
  }
  return (snapshot.projection.activeToolCalls ?? []).some(
    (toolCall) => toolCall.status === "pending" || toolCall.status === "running",
  );
}

function hasActiveSnapshotRuntime(snapshot: ZCodeSessionStateSnapshot): boolean {
  return hasBlockingActiveSnapshotRuntime(snapshot);
}

function isToolCallContinuationFinish(finish: string | undefined): boolean {
  const normalized = finish?.trim().toLowerCase().replace(/_/g, "-");
  return normalized === "tool-calls";
}

function hasCompletedVisibleAssistantTurn(snapshot: ZCodeSessionStateSnapshot): boolean {
  const visibleMessages = getZCodeUserVisibleMessages(snapshot.messages, {
    target: snapshot.projection.target,
  });
  const latestVisibleMessage = visibleMessages.at(-1);
  if (latestVisibleMessage?.info.role !== "assistant") {
    return false;
  }
  if (isToolCallContinuationFinish(latestVisibleMessage.info.finish)) {
    return false;
  }
  return typeof latestVisibleMessage.info.time.completed === "number";
}

export function deriveZCodeTaskStatusFromSessionSnapshot(
  snapshot: ZCodeSessionStateSnapshot,
): ZCodeTaskStatus {
  if (snapshot.projection.lastError) {
    return "error";
  }

  const status = statusFromZCodeSession(snapshot.session.status);
  if (status === "error" || status === "completed") {
    return status;
  }
  if (hasCompletedVisibleAssistantTurn(snapshot) && !hasBlockingActiveSnapshotRuntime(snapshot)) {
    // desktop continuous's session/read relies on runtime projection.
    // The old projection may only replay to model_streaming finish and miss turn_complete, resulting in currentTurnId
    // Temporary or long-term residue. At this time, the persistent assistant has completed time and is more authoritative than the stale currentTurnId.
    return "completed";
  }
  if (hasActiveSnapshotRuntime(snapshot)) {
    return status ?? "running";
  }
  return status;
}
