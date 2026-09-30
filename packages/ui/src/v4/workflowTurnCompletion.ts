import type { TurnHeaderRow, WorkflowNotificationMeta } from "@zcode/shared/zcode-protocol-v4";
import type { WorkflowRunCardSummary } from "@/ToolCallBlocks/fileSummaryTypes.js";

/**
 * Resolution of the completion card: whether this turn is the one in which "the main agent consumed
 * a **completed** workflow notification". A pure function, along the same seam as
 * `resolveWorkflowTurnDigests`.
 *
 * Only a case where all three hold is recognized: a background result turn, a workflow source, and
 * a terminal payload with `status === "completed"`. failed / cancelled do not draw a card (the
 * notification row already states the error and already hangs the chips of the partial artifacts);
 * upgrade notifications, batch turns (where the payload is entirely absent), and bash / subagent
 * notifications are none of them.
 *
 * The artifact list is **based on the notification payload**: it is persisted together with the
 * notification and is there after a cold restore; the projection / journal only add byte sizes,
 * provenance and the board spec on top of it.
 */
export type WorkflowTerminalNotification = Extract<WorkflowNotificationMeta, { kind: "terminal" }>;

export interface WorkflowTurnCompletion {
  runId: string;
  /**
   * Notification title (the CLI's workflowTaskSubject, not localized), from the same source as the
   * notification row's primaryText.
   */
  name: string;
  /** Wall-clock time inside the notification; when absent the "Time" cell shows `—`. */
  durationMs?: number;
  artifacts: NonNullable<WorkflowTerminalNotification["artifacts"]>;
  /**
   * Trimmed on the emit side (over 8 or filtered out) — the overflow count can therefore be
   * under-reported.
   */
  artifactsTruncated: boolean;
  /**
   * The run joined by the projection; when absent (evicted by the 8-entry limit) the three cells
   * show `—` and there is no ⤢. A restart no longer lets it be absent: CLI cold materialization
   * replays the projection from the journal.
   */
  summary: WorkflowRunCardSummary | undefined;
}

export function resolveWorkflowTurnCompletion(
  header: TurnHeaderRow | undefined,
  join: { byRunId?: ReadonlyMap<string, WorkflowRunCardSummary> },
): WorkflowTurnCompletion | undefined {
  if (header?.origin !== "backgroundResult") return undefined;
  const originMeta = header.originMeta;
  if (originMeta?.backgroundSource !== "workflow") return undefined;
  const notification = originMeta.workflowNotification;
  if (notification?.kind !== "terminal" || notification.status !== "completed") return undefined;
  const name = originMeta.title.trim();
  if (name.length === 0) return undefined;
  return {
    runId: originMeta.workId,
    name,
    ...(notification.durationMs === undefined ? {} : { durationMs: notification.durationMs }),
    artifacts: notification.artifacts ?? [],
    artifactsTruncated: notification.artifactsTruncated === true,
    summary: join.byRunId?.get(originMeta.workId),
  };
}
