import { PERMISSION_FULL_ACCESS_OPTION_ID } from "@zcode/shared/zcode-protocol-v4";
// Permissions/Background Command Group: resolveInteraction/cancelBackgroundWork.
// - resolveInteraction: The forward command closes the reverse request (permission/AskUserQuestion).
//   host.interactions (V4InteractionRegistry) is delivered to the waiting deferred on the broker side.
// - cancelBackgroundWork: optional capability of direct drive core cancelBackgroundTask (workId ≡ taskId).
import type {
  CommandEnvelope,
  CommandPayloadMap,
  CommandResult,
  SavedWorkflowStartRejectionReason,
  WorkflowRunSettingsRejectionReason,
} from "@zcode/shared/zcode-protocol-v4";
import {
  BACKGROUND_WORK_CANCEL_REJECTED_FAULT_PREFIX,
  SAVED_WORKFLOW_START_REJECTED_FAULT_PREFIX,
  WORKFLOW_RUN_RESUME_REJECTED_FAULT_PREFIX,
  WORKFLOW_RUN_SETTINGS_REJECTED_FAULT_PREFIX,
} from "@zcode/shared/zcode-protocol-v4";
import { requireRecord } from "../record-access.js";
import type { V4CommandCoreHost } from "../types.js";

/**
 * Capability-unsupported error: thrown when the session runtime has not implemented an optional capability
 * (compare with the ProtocolRequestError -32031 semantics of the old server-operations.ts
 * cancelBackgroundTask). The v4 side no longer uses JSON-RPC error codes; it uses a structured Error carrying
 * a reasonCode (fault namespace) instead, and the gateway uses that to settle the ACK.
 */
export class V4CapabilityUnsupportedError extends Error {
  readonly reasonCode = "fault.command.capabilityUnsupported";

  constructor(capability: string, sessionId: string) {
    super(`capability not supported by this session runtime: ${capability} (session ${sessionId})`);
    this.name = "V4CapabilityUnsupportedError";
  }
}

/**
 * resolveInteraction: deliver the response to a pending reverse request (the interaction-broker's race deferral).
 *
 * Semantic fidelity (conclusion of the investigation):
 * - A miss (delivered === false; the interaction was already answered / already deregistered / an unknown id)
 *   settles as an idempotent success and throws nothing, because first response from any endpoint wins and a
 *   late response is a harmless idempotent operation; throwing failed would mislead the client.
 * - No requireRecord: a late response may arrive after the session has already settled / been deleted, and it
 *   must be harmless there too; the registry is addressed globally by interactionId and does not depend on a
 *   record existing.
 */
async function resolveInteraction(
  host: V4CommandCoreHost,
  envelope: CommandEnvelope,
): Promise<CommandResult | undefined> {
  const payload = envelope.payload as CommandPayloadMap["resolveInteraction"];
  const delivered =
    payload.answer.optionId === PERMISSION_FULL_ACCESS_OPTION_ID
      ? ((await host.interactions?.resolveFullAccess(payload.interactionId, envelope.sessionId!)) ??
        false)
      : (host.interactions?.resolve(payload.interactionId, payload.answer) ?? false);
  if (!delivered) {
    host.logger?.info?.("v4 resolveInteraction no pending interaction (idempotent)", {
      event: "zcode_protocol.v4.interaction_already_resolved",
      interactionId: payload.interactionId,
      sessionId: envelope.sessionId,
    });
  }
  return undefined;
}

async function snoozeInteractionAutoResolution(
  host: V4CommandCoreHost,
  envelope: CommandEnvelope,
): Promise<CommandResult | undefined> {
  const payload = envelope.payload as CommandPayloadMap["snoozeInteractionAutoResolution"];
  const snoozed = (await host.interactions?.snoozeAutoResolution(payload.interactionId)) ?? false;
  if (!snoozed) {
    host.logger?.info?.("v4 snoozeInteractionAutoResolution no active countdown (idempotent)", {
      event: "zcode_protocol.v4.interaction_auto_resolution_already_snoozed",
      interactionId: payload.interactionId,
      sessionId: envelope.sessionId,
    });
  }
  return undefined;
}

class V4WorkspaceHookReviewRejectedError extends Error {
  constructor(readonly reasonCode: string) {
    super(`Workspace Hook review command rejected: ${reasonCode}`);
    this.name = "V4WorkspaceHookReviewRejectedError";
  }
}

async function respondWorkspaceHookReview(
  host: V4CommandCoreHost,
  envelope: CommandEnvelope,
): Promise<CommandResult | undefined> {
  const payload = envelope.payload as CommandPayloadMap["respondWorkspaceHookReview"];
  const record = requireWorkspaceHookReviewRecord(host, envelope, payload.sessionId);
  const result = await record.app.respondWorkspaceHookReview(payload);
  if (!result.accepted) throw new V4WorkspaceHookReviewRejectedError(result.reasonCode);
  return undefined;
}

async function toggleWorkspaceHookReviewItem(
  host: V4CommandCoreHost,
  envelope: CommandEnvelope,
): Promise<CommandResult | undefined> {
  const payload = envelope.payload as CommandPayloadMap["toggleWorkspaceHookReviewItem"];
  const record = requireWorkspaceHookReviewRecord(host, envelope, payload.sessionId);
  const result = await record.app.toggleWorkspaceHookReviewItem(payload);
  if (!result.accepted) throw new V4WorkspaceHookReviewRejectedError(result.reasonCode);
  return undefined;
}

async function revokeWorkspaceHookTrust(
  host: V4CommandCoreHost,
  envelope: CommandEnvelope,
): Promise<CommandResult | undefined> {
  const payload = envelope.payload as CommandPayloadMap["revokeWorkspaceHookTrust"];
  const record = requireWorkspaceHookReviewRecord(host, envelope, payload.sessionId);
  const result = await record.app.revokeWorkspaceHookTrust(payload);
  if (!result.accepted) throw new V4WorkspaceHookReviewRejectedError(result.reasonCode);
  return undefined;
}

/**
 * Soft gate: open the review flow on demand.
 *
 * Called when the user clicks "go review". Goes through controller.requestReview -> openOrReuseFlow +
 * superviseFlow. Reuses an existing active flow idempotently. With no pending items it is a safe no-op.
 */
async function requestWorkspaceHookReview(
  host: V4CommandCoreHost,
  envelope: CommandEnvelope,
): Promise<CommandResult | undefined> {
  const payload = envelope.payload as CommandPayloadMap["requestWorkspaceHookReview"];
  const record = requireWorkspaceHookReviewRecord(host, envelope, payload.sessionId);
  const result = await record.app.requestWorkspaceHookReview({
    workspaceIdentity: payload.workspaceIdentity,
    bundleDigest: payload.bundleDigest,
  });
  if (!result.accepted) throw new V4WorkspaceHookReviewRejectedError(result.reasonCode);
  return undefined;
}

function requireWorkspaceHookReviewRecord(
  host: V4CommandCoreHost,
  envelope: CommandEnvelope,
  payloadSessionId: string,
) {
  if (envelope.sessionId !== payloadSessionId) {
    throw new V4WorkspaceHookReviewRejectedError("workspace_hooks_snapshot_mismatch");
  }
  return requireRecord(host, envelope.sessionId);
}

/**
 * The business rejection of cancelBackgroundWork: core explicitly answers "nothing was cancelled" (reason
 * present).
 *
 * When an old run is mistakenly left in running by cold replay, Cancel on the detail page is clickable,
 * yet the command reaches core and finds no such task (`background_task_not_found`); the old handler threw the
 * whole structured result away and returned accepted, so the user sees "clicked and nothing happened". core's
 * reason is the single authority, and here we only carry the prefix over.
 */
class V4BackgroundWorkCancelRejectedError extends Error {
  readonly reasonCode: string;
  constructor(reason: string, workId: string) {
    super(`background work ${workId} was not cancelled: ${reason}`);
    this.name = "V4BackgroundWorkCancelRejectedError";
    this.reasonCode = `${BACKGROUND_WORK_CANCEL_REJECTED_FAULT_PREFIX}${reason.replace(/^background_task_/, "")}`;
  }
}

/**
 * cancelBackgroundWork: workId ≡ the old taskId, passed straight to core.
 * - cancelBackgroundTask is an optional ZCodeApp capability: absent => throw capability-unsupported (see
 *   above).
 * - core returns a `reason` (not found / already terminal / unsupported type) => ACK with reasonCode
 *   `fault.command.backgroundWorkCancelRejected.<reason>`; only an actual cancellation, or an absent return
 *   value (stub host), counts as accepted.
 * - No legacy broadcast is needed: BackgroundTask* (Started/Updated/Completed) lifecycle events are emitted
 *   directly by core, and the v4 projection (product-projection backgroundWorks) settles them by itself;
 *   compare with the old op's afterStateMutation("background_task_cancelled"), which the v4 surface has no
 *   obligation to perform.
 */
async function cancelBackgroundWork(
  host: V4CommandCoreHost,
  envelope: CommandEnvelope,
): Promise<CommandResult | undefined> {
  const payload = envelope.payload as CommandPayloadMap["cancelBackgroundWork"];
  const record = requireRecord(host, envelope.sessionId);
  if (!record.app.cancelBackgroundTask) {
    throw new V4CapabilityUnsupportedError("cancelBackgroundTask", record.app.sessionId);
  }
  // Note: Methods must be called by app (cannot be deconstructed, implementation may rely on this binding).
  const result = await record.app.cancelBackgroundTask(payload.workId);
  if (result?.reason !== undefined) {
    throw new V4BackgroundWorkCancelRejectedError(result.reason, payload.workId);
  }
  return undefined;
}

/**
 * resumeWorkflowRun: workId ≡ runId, passed straight to the app capability.
 * - Capability absent (journal unavailable / the port has no resume) => capability-unsupported error (the same
 *   semantics as cancel).
 * - Business rejections (not_found / not_resumable / already_running / script_missing /
 *   script_mismatch / compile_failed) ACK with reasonCode
 *   `fault.command.workflowRunResumeRejected.<reason>`: the gateway passes domain errors carrying a reasonCode
 *   through unchanged and the UI routes on the vocabulary; the error text is never used to decide. The bounded
 *   diagnostics of compile_failed are folded into `ack.message` via `error.message` (the same convention as
 *   startSavedWorkflow).
 */
class V4WorkflowRunResumeRejectedError extends Error {
  readonly reasonCode: string;
  constructor(reason: string, message?: string) {
    super(message ?? `workflow run resume rejected: ${reason}`);
    this.name = "V4WorkflowRunResumeRejectedError";
    this.reasonCode = `${WORKFLOW_RUN_RESUME_REJECTED_FAULT_PREFIX}${reason}`;
  }
}

async function resumeWorkflowRun(
  host: V4CommandCoreHost,
  envelope: CommandEnvelope,
): Promise<CommandResult | undefined> {
  const payload = envelope.payload as CommandPayloadMap["resumeWorkflowRun"];
  const record = requireRecord(host, envelope.sessionId);
  if (!record.app.resumeWorkflowRun) {
    throw new V4CapabilityUnsupportedError("resumeWorkflowRun", record.app.sessionId);
  }
  // Note: Methods must be called by app (cannot be deconstructed, implementation may rely on this binding).
  const result = await record.app.resumeWorkflowRun({
    workId: payload.workId,
    ...(payload.name === undefined ? {} : { name: payload.name }),
  });
  if (!result.ok) throw new V4WorkflowRunResumeRejectedError(result.reason, result.message);
  return undefined;
}

/**
 * startSavedWorkflow: the hub starts a saved workflow directly.
 * - Capability absent (no dwf port / stub host) => capability-unsupported error (the same semantics as the
 *   resume family), and the GUI shows "the current agent does not support direct start" verbatim and reclaims
 *   the empty session.
 * - Business rejections (invalid_name / not_found / invalid_args / compile_failed / session_busy /
 *   start_failed) ACK with reasonCode `fault.command.savedWorkflowStartRejected.<reason>`, with `message`
 *   carrying human-readable diagnostics (merged compile diagnostics, truncated to a bound) for inline display
 *   in the argument pane. The gateway passes domain errors carrying a reasonCode through unchanged and folds
 *   `error.message` into `ack.message`; the UI routes on the vocabulary, never on the error text for flow
 *   decisions.
 * - On success, ACK.result carries `{ type: "startSavedWorkflow", runId, toolCallId }` (linking the tool card
 *   -> the detail page).
 * Note: it is a non-input command (not queued, no baseRevision), of the same kind as resume / cancel, and is
 * registered in the interaction-background group.
 */
class V4SavedWorkflowStartRejectedError extends Error {
  readonly reasonCode: string;
  constructor(reason: SavedWorkflowStartRejectionReason, message?: string) {
    // The message directly enters ack.message (gateway convention: error.message receives ACK), and is readable in case of absence.
    super(message ?? `saved workflow start rejected: ${reason}`);
    this.name = "V4SavedWorkflowStartRejectedError";
    this.reasonCode = `${SAVED_WORKFLOW_START_REJECTED_FAULT_PREFIX}${reason}`;
  }
}

async function startSavedWorkflow(
  host: V4CommandCoreHost,
  envelope: CommandEnvelope,
): Promise<CommandResult | undefined> {
  const payload = envelope.payload as CommandPayloadMap["startSavedWorkflow"];
  const record = requireRecord(host, envelope.sessionId);
  if (!record.app.startSavedWorkflow) {
    throw new V4CapabilityUnsupportedError("startSavedWorkflow", record.app.sessionId);
  }
  // Note: Methods must be called by app (cannot be deconstructed, implementation may rely on this binding).
  const result = await record.app.startSavedWorkflow({
    name: payload.name,
    ...(payload.scope === undefined ? {} : { scope: payload.scope }),
    ...(payload.args === undefined ? {} : { args: payload.args }),
  });
  if (!result.ok) throw new V4SavedWorkflowStartRejectedError(result.reason, result.message);
  return { type: "startSavedWorkflow", runId: result.runId, toolCallId: result.toolCallId };
}

/**
 * amendWorkflowRunSettings: the "configure" action on a run card / detail page. workId ≡ runId; the tri-state
 * of the two settings is passed down to the runtime as is.
 * - Capability absent (no dwf port, or the port has no amend / getScript) => capability-unsupported error, and
 *   the dialog shows "not supported".
 * - Business rejections ACK with `fault.command.workflowRunSettingsRejected.<reason>`, with `message` carrying
 *   the diagnostics (compile diagnostics / model resolution diagnostics / start failure reason); the old run
 *   keeps running as usual on a rejection.
 * - On success, ACK.result carries `{ type, runId, toolCallId, supersededRunId? }`: the two linking keys of
 *   the new run, which the detail page uses to switch the tab to the new run.
 */
class V4WorkflowRunSettingsRejectedError extends Error {
  readonly reasonCode: string;
  constructor(reason: WorkflowRunSettingsRejectionReason, message?: string) {
    super(message ?? `workflow run settings rejected: ${reason}`);
    this.name = "V4WorkflowRunSettingsRejectedError";
    this.reasonCode = `${WORKFLOW_RUN_SETTINGS_REJECTED_FAULT_PREFIX}${reason}`;
  }
}

async function amendWorkflowRunSettings(
  host: V4CommandCoreHost,
  envelope: CommandEnvelope,
): Promise<CommandResult | undefined> {
  const payload = envelope.payload as CommandPayloadMap["amendWorkflowRunSettings"];
  const record = requireRecord(host, envelope.sessionId);
  if (!record.app.amendWorkflowRunSettings) {
    throw new V4CapabilityUnsupportedError("amendWorkflowRunSettings", record.app.sessionId);
  }
  // Note: Methods must be called by app (cannot be deconstructed, implementation may rely on this binding).
  const result = await record.app.amendWorkflowRunSettings({
    runId: payload.workId,
    ...(payload.subagentModel === undefined ? {} : { subagentModel: payload.subagentModel }),
    ...(payload.maxConcurrency === undefined ? {} : { maxConcurrency: payload.maxConcurrency }),
  });
  if (!result.ok) throw new V4WorkflowRunSettingsRejectedError(result.reason, result.message);
  return {
    type: "amendWorkflowRunSettings",
    runId: result.runId,
    toolCallId: result.toolCallId,
    ...(result.supersededRunId === undefined ? {} : { supersededRunId: result.supersededRunId }),
  };
}

export const interactionBackgroundHandlers = {
  resolveInteraction,
  respondWorkspaceHookReview,
  toggleWorkspaceHookReviewItem,
  revokeWorkspaceHookTrust,
  requestWorkspaceHookReview,
  snoozeInteractionAutoResolution,
  cancelBackgroundWork,
  resumeWorkflowRun,
  startSavedWorkflow,
  amendWorkflowRunSettings,
};
