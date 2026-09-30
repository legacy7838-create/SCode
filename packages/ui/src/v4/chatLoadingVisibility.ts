import type {
  ActiveWorkSummary,
  ConversationRow,
  PendingInteraction,
} from "@zcode/shared/zcode-protocol-v4";

/**
 * While waiting for the user, the dialog / question card is already the only progress feedback, so
 * no loading indicator may be shown. Only permission confirmations and AskUserQuestion are
 * recognized here; other userInput semantics such as ExitPlanMode stay separate. After the soft
 * gate, workspaceHookReview no longer blocks the conversation.
 */
export function hasChatLoadingBlockingInteraction(
  interactions: readonly PendingInteraction[],
): boolean {
  return interactions.some(
    (interaction) =>
      interaction.payload.kind === "permission" ||
      (interaction.payload.kind === "userInput" &&
        interaction.payload.toolName === "AskUserQuestion"),
  );
}

export function hasChatLoadingBlockingActiveWork(
  activeWorks: readonly ActiveWorkSummary[],
): boolean {
  return activeWorks.some((work) => work.kind === "compact" || work.kind === "goalVerifier");
}

function hasChatLoadingBlockingMaintenanceRow(rows: readonly ConversationRow[]): boolean {
  return rows.some(
    (row) =>
      row.kind === "timelineMarker" &&
      ((row.marker.type === "compact" && row.marker.status === "running") ||
        (row.marker.type === "goalVerify" && row.marker.outcome === "running")),
  );
}

export function shouldShowTurnChatLoading({
  blockedByActiveWork,
  blockedByInteraction,
  isLastTurn,
  isRunning,
  rows,
}: {
  blockedByActiveWork: boolean;
  blockedByInteraction: boolean;
  isLastTurn: boolean;
  isRunning: boolean;
  rows: readonly ConversationRow[];
}): boolean {
  if (!isLastTurn || !isRunning || blockedByActiveWork || blockedByInteraction) {
    return false;
  }

  // pendingInteractions/activeWorks is the authoritative source of truth, but restore or reorder windows
  // There may only be row status at first; row-level fallback avoids permissions, compact, and goal verifiers when they have appeared.
  // Bottom loading brief flashback.
  return (
    !rows.some((row) => row.kind === "toolCall" && row.status === "pendingApproval") &&
    !hasChatLoadingBlockingMaintenanceRow(rows)
  );
}
