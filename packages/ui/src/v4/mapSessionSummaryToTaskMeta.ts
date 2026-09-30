// SessionSummary → Sidebar real-time detail ZCodeTaskMeta mapping for sessions-index.
// These objects do not independently determine the existence of list rows; subsequent joins to the left table are performed using tasks-index.sqlite persistent rows.
// Note: summary.sessionEnded is a "successful round closing" semantic (completedSuccess is true), not deletion;
// session.removed will only remove real-time detail, persistent row deletion is still determined by tasks-index row/tombstone.
import type { TraceId, ZCodeProvider, ZCodeTaskMeta } from "@zcode/shared";
import type { SessionSummary } from "@zcode/shared/zcode-protocol-v4";
import {
  attachTaskListRowActivity,
  type TaskListMetaWithActivity,
} from "@/v4/taskListRowActivity.js";

/** phase → the sidebar's persisted status (running/completed/error); draft has no result status. */
function phaseToStatus(phase: SessionSummary["phase"]): ZCodeTaskMeta["status"] {
  switch (phase) {
    case "running":
    case "prewarming":
      return "running";
    case "completedSuccess":
    case "completedInterrupted":
      return "completed";
    case "error":
      return "error";
    default:
      return undefined; // draft
  }
}

interface MapSessionSummaryOptions {
  workspacePath: string;
  workspaceIdentity?: string;
  /**
   * The meta already present locally (keeps older values such as a manual title/provider so a list
   * refresh does not wipe them).
   */
  previous?: ZCodeTaskMeta;
}

/**
 * SessionSummary → the live detail ZCodeTaskMeta. Fields that sessions-index does not carry
 * (traceId/mode/provider) take sensible defaults or reuse previous; the truly persisted fields are
 * defined by the task row at join time.
 */
export function mapSessionSummaryToTaskMeta(
  summary: SessionSummary,
  options: MapSessionSummaryOptions,
): TaskListMetaWithActivity {
  const previous = options.previous;
  const status = phaseToStatus(summary.phase);
  const summaryTitleIsCustom = summary.titleSource === "custom";
  // When a manual title with titleOverridden=true already exists in the old task-index,
  // sessions-index cold start summary may still be the first_input/generated header. Only v4 session
  // The store only treats summary.title as the new manual title authority when it is explicitly marked custom.
  const title =
    previous?.titleOverridden === true && !summaryTitleIsCustom
      ? previous.title
      : summary.title || previous?.title || "";
  const titleOverridden =
    summaryTitleIsCustom || previous?.titleOverridden === true ? true : undefined;
  return attachTaskListRowActivity(
    {
      taskId: summary.sessionId,
      traceId: (previous?.traceId ?? `session-${summary.sessionId}`) as TraceId,
      title,
      ...(titleOverridden ? { titleOverridden } : {}),
      workspacePath: options.workspacePath,
      ...(options.workspaceIdentity ? { workspaceIdentity: options.workspaceIdentity } : {}),
      createdAt: summary.createdAt || previous?.createdAt || 0,
      updatedAt: summary.lastActivityAt || previous?.updatedAt || 0,
      mode: previous?.mode ?? "build",
      ...(previous?.model ? { model: previous.model } : {}),
      ...(summary.parentSessionId ? { forkedFromTaskId: summary.parentSessionId } : {}),
      ...(previous?.provider ? { provider: previous.provider as ZCodeProvider } : {}),
      ...(status ? { status } : {}),
      ...(summary.pendingInteraction
        ? {
            pendingInteraction: {
              interactionId: summary.pendingInteraction.interactionId,
              kind: summary.pendingInteraction.kind,
              ...(summary.pendingInteraction.toolName
                ? { toolName: summary.pendingInteraction.toolName }
                : {}),
              ...(summary.pendingInteraction.autoResolution
                ? { autoResolution: summary.pendingInteraction.autoResolution }
                : {}),
            },
          }
        : {}),
      ...(previous?.unreadAt ? { unreadAt: previous.unreadAt } : {}),
    },
    {
      phase: summary.phase,
      lastActivityAt: summary.lastActivityAt,
      hasBackgroundWork: summary.hasBackgroundWork,
      ...(summary.pendingInteractionSummary
        ? { pendingInteractions: summary.pendingInteractionSummary }
        : {}),
      ...(summary.workflowActivity ? { workflowActivity: summary.workflowActivity } : {}),
    },
  );
}
