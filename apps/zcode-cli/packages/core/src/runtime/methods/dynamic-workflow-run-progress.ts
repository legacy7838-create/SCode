import {
  SessionEventType,
  type DynamicWorkflowRunProgressPayload,
  type TraceContext,
} from "../deps.js";
import {
  formatWorkflowEscalationNotification,
  formatWorkflowStallNotification,
} from "../../runtime-task/notification.js";
import type { AgentRuntimeInternal } from "../internal.js";

/**
 * Append a workflow run progress event to the **parent session** (a run has no session of its own).
 *
 * This is an **out-of-turn append**: the run executes in the background, and when the event arrives the parent session may be
 * mid-turn or completely idle. Both must land, and this channel already supports both — BackgroundTask* is what rides it
 * (inside core, via the tool executor's emitEvent). dwf's event source is the run service in bootstrap, and that layer cannot
 * reach AgentRuntimeInternal, hence this public method; the precedent of the same shape is {@link recordTargetChanged}.
 *
 * Deliberately uses `rootTraceContext` instead of the current turn's trace: turnId is therefore empty and the event claims
 * no turn. The merge during cold recovery inserts in-memory events carrying a turnId back at the tail of the unfinished turn
 * they belong to, while a run event belongs to the run and to no turn — claiming one would make it show up at the end of an
 * already finished conversation after a cold recovery.
 */
export async function recordDynamicWorkflowRunProgress(
  this: AgentRuntimeInternal,
  input: DynamicWorkflowRunProgressPayload & { traceContext?: TraceContext },
): Promise<void> {
  const { traceContext: provided, ...payload } = input;
  const traceContext = provided ?? this.rootTraceContext;
  await this.appendEvent(
    this.createEvent(
      SessionEventType.DynamicWorkflowRunProgress,
      payload satisfies DynamicWorkflowRunProgressPayload,
      traceContext,
    ),
    traceContext,
  );
  notifyEscalationRaised.call(this, payload, traceContext);
  notifyRunStalled.call(this, payload, traceContext);
}

/** The event kind of a run-level stall (the engine's `RunEvent.type`). */
const RUN_STALLED_EVENT_TYPE = "run-stalled";

/**
 * `run-stalled` → one model-visible in-run notification. Same layer and same three disciplines as
 * {@link notifyEscalationRaised}: exactly one notification per event (on the driver side, once per stall segment; the next one
 * only arrives once a success re-arms it); no nagging; and never throw — if the payload shape is wrong, skip it and log one line.
 */
function notifyRunStalled(
  this: AgentRuntimeInternal,
  payload: DynamicWorkflowRunProgressPayload,
  traceContext: TraceContext,
): void {
  if (payload.eventType !== RUN_STALLED_EVENT_TYPE) return;
  const sinceMs = payload.payload.sinceMs;
  if (typeof sinceMs !== "number" || !Number.isFinite(sinceMs) || sinceMs < 0) {
    this.logger?.warn?.("Dynamic workflow stall notification skipped: malformed payload", {
      event: "dynamic_workflow.stall.notification_skipped",
      module: "core.runtime",
      runId: payload.runId,
      sequence: payload.sequence,
    });
    return;
  }
  const runLabel = this.runtimeTaskRegistry.get(payload.runId)?.description ?? payload.runId;
  const reason = stringField(payload.payload, "reason");
  const capValue = payload.payload.cap;
  const cap =
    typeof capValue === "number" && Number.isFinite(capValue) && capValue >= 0
      ? Math.floor(capValue)
      : undefined;
  this.enqueueBackgroundTaskNotification({
    originMeta: {
      backgroundSource: "workflow",
      title: runLabel,
      workId: payload.runId,
      workflowNotification: {
        kind: "stall",
        sinceMs: Math.floor(sinceMs),
        ...(reason === undefined ? {} : { reason: reason.slice(0, 64) }),
        ...(cap === undefined ? {} : { cap }),
      },
    },
    taskId: payload.runId,
    text: formatWorkflowStallNotification({
      runLabel,
      runId: payload.runId,
      sinceMs,
      ...(reason === undefined ? {} : { reason }),
      ...(cap === undefined ? {} : { cap }),
    }),
    traceContext,
  });
}

/** The event kind of an escalation Q&A (the engine's `RunEvent.type`, arriving via the progress payload's `eventType`). */
const ESCALATION_RAISED_EVENT_TYPE = "escalation-raised";

/**
 * `escalation-raised` → one model-visible in-run notification.
 *
 * Why at this layer rather than opening a new port: the progress sink already delivers every RunEvent here, and this is the
 * **only** place that can see both run events and the AgentRuntime. One more port would only make the same fact travel two roads.
 *
 * Three disciplines:
 *   - **Exactly one notification per raised**, no resending, no nagging. When a notification is dropped (stale branch / shutdown),
 *     the fallback is a query — the pendingQuestions of GetWorkflowRun, not a retry.
 *   - **`escalation-resolved` sends no notification**: the answerer is the main agent itself, and the receipt is already the
 *     result of that tool call.
 *   - **Never throw**: this is an observation surface, while the truth of a run lives in the journal. If the payload shape is
 *     wrong, skip it and log one line — it has crossed a port boundary and been trimmed by bounding, so a defensive read is what it has earned.
 */
function notifyEscalationRaised(
  this: AgentRuntimeInternal,
  payload: DynamicWorkflowRunProgressPayload,
  traceContext: TraceContext,
): void {
  if (payload.eventType !== ESCALATION_RAISED_EVENT_TYPE) return;

  const qid = stringField(payload.payload, "qid");
  const question = stringField(payload.payload, "question");
  if (qid === undefined || question === undefined) {
    this.logger?.warn?.("Dynamic workflow escalation notification skipped: malformed payload", {
      event: "dynamic_workflow.escalation.notification_skipped",
      module: "core.runtime",
      runId: payload.runId,
      sequence: payload.sequence,
    });
    return;
  }

  // The backend link of the display name has the same origin as the final notification: the description of the registry entry (the name/name of CreateWorkflow
  // Derived from the first line of the script) → runId. Deliberately not checking the port - notifications are generated synchronously, and this path does not do I/O.
  const runLabel = this.runtimeTaskRegistry.get(payload.runId)?.description ?? payload.runId;
  const context = stringField(payload.payload, "context");
  // Anonymous actors do not have actorName (the engine deliberately does not synthesize hidden labels, see the comments of RunEvent): Here comes the
  // The structured ref `site@ordinal`, which is uniquely positioned within the run, reads passably as a sentence. Notification text and manifest
  // The payloads share the same pocket chain - if the two places are pocketed separately, the same actor will display different names in the two places.
  const actor = stringField(payload.payload, "actorName") ?? actorRefLabel(payload.payload);
  // askedAt is epoch ms and may be absent (stringField cannot read numbers and can only read them defensively).
  const askedAt = payload.payload.askedAt;

  this.enqueueBackgroundTaskNotification({
    originMeta: {
      backgroundSource: "workflow",
      title: runLabel,
      // workId ≡ runId: The same display anchor point as the final notification of the run, so the two notifications fall on the same background work.
      workId: payload.runId,
      // Manifest payload (escalation decision branch): GUI collapsed into "Subagent X has a question",
      // Expand to display the full text of the question. Launch-side casting, bounded (question/context ≤4000, synchronous shared schema).
      workflowNotification: {
        kind: "escalation",
        qid,
        actor,
        question: question.slice(0, WORKFLOW_ESCALATION_TEXT_MAX_CHARS),
        ...(context === undefined
          ? {}
          : { context: context.slice(0, WORKFLOW_ESCALATION_TEXT_MAX_CHARS) }),
        ...(typeof askedAt === "number" && Number.isFinite(askedAt) ? { askedAt } : {}),
      },
    },
    // taskId allows the notification to inherit the branchGeneration of the run (fencing of late notifications); the bottom line is snapshot query.
    taskId: payload.runId,
    text: formatWorkflowEscalationNotification({
      runLabel,
      runId: payload.runId,
      qid,
      actor,
      question,
      ...(context === undefined ? {} : { context }),
    }),
    traceContext,
  });
}

/** The bounds on question / context in the manifest payload (shared schema: ≤4000 characters). */
const WORKFLOW_ESCALATION_TEXT_MAX_CHARS = 4_000;

/** `{siteId, ordinal}` → `site@ordinal` (the shape of the engine's `refToString`); when it cannot be read, say "unknown actor". */
function actorRefLabel(payload: Record<string, unknown>): string {
  const actor = payload.actor;
  if (typeof actor === "string") return actor;
  if (typeof actor !== "object" || actor === null) return "unknown actor";
  const siteId = stringField(actor as Record<string, unknown>, "siteId");
  const ordinal = (actor as Record<string, unknown>).ordinal;
  if (siteId === undefined || typeof ordinal !== "number") return "unknown actor";
  return `${siteId}@${ordinal}`;
}

function stringField(payload: Record<string, unknown>, key: string): string | undefined {
  const value = payload[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
