// fork/edit/retry command group: forkAssistant/editUserQuery/retryTurn.
// What they have in common: {rowId, entityId} is used to locate historical entities, and is replaced by transcript messageId through the v4 projection translation surface of the host.
// (Translation is v4’s native decision-making. If it cannot be translated, it will be rejected directly, and it will never silently reveal the latestCheckpoint - it will be wrong).
// - editUserQuery = retryTurn for changing text: rewind truncates the turn → native prompt turn resends new text.
// - retryTurn = rewind truncation + resend the original user prompt (the original text must be parsed before rewind, and cannot be obtained after truncation).
// - forkAssistant = stable resolver + conversation-only copy; running parent and workspace do not move.
import type {
  CommandEnvelope,
  CommandPayloadMap,
  CommandResult,
} from "@zcode/shared/zcode-protocol-v4";
import {
  RewindStrategy,
  traceContextToLogContext,
  type MessageId,
  type TurnId,
} from "@zcode/contracts";
import { mapAttachmentRefsToTurnAttachments } from "../attachment-refs.js";
import { inputIntentMetadataFromCanonical } from "../input-intent.js";
import { startPromptTurn } from "../prompt-turn.js";
import { commandAdmissionOf } from "../executor.js";
import { requireRecord } from "../record-access.js";
import type { V4CommandCoreHost, V4SessionRecordView } from "../types.js";
import {
  hasPromptInput,
  preemptActiveTurnAndWait,
  V4InputAdmissionRejectedError,
} from "./session-flow.js";
import { applyGoalCommand } from "./goal-compact.js";
import type { ConversationEditTarget } from "../../product-projection.js";

const CONVERSATION_COMMAND_LOG_MODULE = "bootstrap.zcode_protocol_v4.commands";
const EDIT_USER_QUERY_COMPLETED_EVENT = "conversation.command.edit_user_query.completed";
const FORK_ASSISTANT_COMPLETED_EVENT = "conversation.command.fork_assistant.completed";

/** row target → messageId translation failed (not an assistant row / a late entity / the session has no projection). */
export class V4RowTranslationError extends Error {
  readonly reasonCode = "fault.command.executionFailed";

  constructor(command: string, targetRowId: number) {
    super(`${command} targetRowId ${targetRowId} does not resolve to a transcript messageId`);
    this.name = "V4RowTranslationError";
  }
}

/** The fork target is not the last assistantText of its own turn → explicit rejection. */
export class V4ForkTargetNotLatestSegmentError extends Error {
  readonly reasonCode = "fault.command.executionFailed";

  constructor(targetRowId: number) {
    super(
      `forkAssistant targetRowId ${targetRowId} is not the last assistant segment of its turn (fork only attaches to the turn's final segment)`,
    );
    this.name = "V4ForkTargetNotLatestSegmentError";
  }
}

class V4ForkTargetGuardError extends Error {
  constructor(
    readonly reasonCode: string,
    targetRowId: number,
  ) {
    super(`forkAssistant targetRowId ${targetRowId} was rejected by the stable target resolver: ${reasonCode}`);
    this.name = "V4ForkTargetGuardError";
  }
}

/** latestQueryEditOnly: an old row / a non-realUser row / no projection are all rejected outright, without stopping the current turn. */
class V4EditTargetNotLatestError extends Error {
  readonly reasonCode = "guard.latestQueryEditOnly";

  constructor(targetRowId: number) {
    super(`editUserQuery targetRowId ${targetRowId} is not the last turn's real user query`);
    this.name = "V4EditTargetNotLatestError";
  }
}

/** latestAssistantRetryOnly: retrying a historical assistant reply would rewind the active branch, so it must be rejected. */
class V4RetryTargetNotLatestError extends Error {
  readonly reasonCode = "guard.latestAssistantRetryOnly";

  constructor(targetRowId: number) {
    super(`retryTurn targetRowId ${targetRowId} is not the last assistant reply`);
    this.name = "V4RetryTargetNotLatestError";
  }
}

/**
 * rewind truncation (driving core directly): edit/retry no longer fake a `/rewind` slash turn, they
 * submit a same-session active branch cut directly. With workspaceMode=rewind this primitive is called
 * at the same commit gate, once every file write has succeeded.
 *
 * A combined rewind used to call app.submitPrompt inside the file transaction callback, which
 * enqueues `/rewind` into the runtime command queue again; the current edit command waits for the
 * callback, and the nested rewind in turn waits for the current command to release the queue, so the
 * UI ends up stuck in the editing state forever.
 * On completion the legacy session_rewound is broadcast (a transitional hook for legacy sidebar
 * consumers; the v4 projection closes its own loop via the RewindTriggered event and does not depend
 * on this broadcast).
 */
async function submitConversationRewind(
  host: V4CommandCoreHost,
  record: V4SessionRecordView,
  anchorMessageId: string,
): Promise<void> {
  const result = await record.app.runtime.rewindConversationToMessage({
    events: [],
    targetMessageId: anchorMessageId as MessageId,
    traceContext: record.traceContext,
  });
  if (result.strategy !== RewindStrategy.ActiveChain) {
    throw new Error(`conversation rewind unavailable for ${anchorMessageId}: ${result.strategy}`);
  }
  await host.afterLegacyStateMutation?.(record, "session_rewound");
}

/**
 * editUserQuery: the target is a user entity, and its canonical transcript messageId is used as the
 * rewind anchor → truncate the whole segment → resend newText as a native prompt turn.
 * Attachment command surface: attachments (AttachmentRef → TurnAttachment) are submitted along with
 * the resend.
 */
async function editUserQuery(
  host: V4CommandCoreHost,
  envelope: CommandEnvelope,
): Promise<CommandResult | undefined> {
  const payload = envelope.payload as CommandPayloadMap["editUserQuery"];
  const record = requireRecord(host, envelope.sessionId);
  const resolution = host.resolveRowActionTarget?.(
    record.app.sessionId,
    payload.target,
    "editUserQuery",
  );
  if (!resolution?.ok || !resolution.editTarget) {
    throw new V4EditTargetNotLatestError(payload.target.rowId);
  }
  const editTarget = resolution.editTarget;
  const attachmentRefs = payload.attachments ?? stableAttachmentRefs(editTarget);
  // The default semantics of attachments are different from []; they must be verified based on effective refs.
  // Only attachment-only edit can be allowed at the same time, and rejected before rewind when both the text and attachments are cleared.
  if (!hasPromptInput(payload.newText, attachmentRefs)) {
    throw new V4InputAdmissionRejectedError("proto.invalidPayload", "input must not be empty");
  }
  // Attachment mapping is completed before rewind: reference failures should be exposed before truncation of history to avoid half-way failures.
  const attachments = await mapAttachmentRefsToTurnAttachments(record.app, attachmentRefs);
  if (record.activeAbortController) {
    await preemptActiveTurnAndWait(host, record, {
      abortMessage: "v4 editUserQuery preempts active turn",
      goalPausedMutationReason: "edit_user_query_goal_paused",
    });
  }
  let conversationRewindCommitted = false;
  if ((payload.workspaceMode ?? "preserve") === "rewind") {
    const turnMessageIds = resolution.messageIds ??
      host.getMessageIdsForTurnRow?.(record.app.sessionId, resolution.row.rowId) ?? [
        editTarget.transcriptMessageId,
      ];
    const fileOptions = {
      targetMessageIds: turnMessageIds as MessageId[],
      targetTurnId: resolution.row.turnId as TurnId,
      traceContext: record.traceContext,
    };
    const preview = await record.app.runtime.previewWorkspaceFileRewind(fileOptions);
    // Shell/ignored changes cannot prove a full rollback. The combined mode fails closed and returns the latest preview to the UI unchanged.
    if (!preview.canApply || preview.ignoredFiles.length > 0 || preview.safeFiles.length === 0) {
      const reasonCode =
        preview.unsafeFiles.length > 0
          ? "guard.workspaceRewindUnsafeFiles"
          : preview.ignoredFiles.length > 0
            ? "guard.workspaceRewindIgnoredFiles"
            : preview.safeFiles.length === 0
              ? "guard.workspaceRewindUnavailable"
              : "guard.workspaceRewindApplyConflict";
      await host.cancelInputCommand?.(
        record.app.sessionId,
        commandAdmissionOf(envelope).queueItemId,
        reasonCode,
      );
      return {
        type: "editUserQuery",
        disposition: "blocked",
        sessionId: record.app.sessionId,
        reasonCode,
        preview,
      };
    }
    const applied = await record.app.runtime.applyWorkspaceFileRewind({
      ...fileOptions,
      commitAfterApply: async () => {
        await submitConversationRewind(host, record, editTarget.transcriptMessageId);
        conversationRewindCommitted = true;
      },
    });
    if (!applied.applied) {
      await host.cancelInputCommand?.(
        record.app.sessionId,
        commandAdmissionOf(envelope).queueItemId,
        "guard.workspaceRewindApplyConflict",
      );
      return {
        type: "editUserQuery",
        disposition: "blocked",
        sessionId: record.app.sessionId,
        reasonCode: "guard.workspaceRewindApplyConflict",
        preview: applied.preview,
      };
    }
  }
  if (!conversationRewindCommitted) {
    await submitConversationRewind(host, record, editTarget.transcriptMessageId);
  }
  await startCanonicalIntent(
    host,
    record,
    envelope,
    editTarget,
    payload.newText,
    attachmentRefs,
    attachments,
  );
  // The production renderer does not leave logs. In the past, we could only guess that editing occurred from the general rewind + send.
  // Indistinguishable from retry stability. After the command side effects are completed, the Agent server writes the low-frequency info audit index.
  host.logger?.info?.("v4 editUserQuery completed", {
    ...traceContextToLogContext(record.traceContext),
    attachmentCount: attachmentRefs?.length ?? 0,
    clientId: envelope.clientId,
    commandId: envelope.commandId,
    event: EDIT_USER_QUERY_COMPLETED_EVENT,
    intentKind: editTarget.intent.kind,
    module: CONVERSATION_COMMAND_LOG_MODULE,
    sessionId: record.app.sessionId,
    status: "completed",
    targetEntityId: payload.target.entityId,
    targetRowId: payload.target.rowId,
    workspaceMode: payload.workspaceMode ?? "preserve",
  });
  return {
    type: "editUserQuery",
    disposition: "rewind",
    sessionId: record.app.sessionId,
  };
}

/**
 * retryTurn: assistant target → messageId → rewind truncation + resend of the
 * canonical user intent. The intent is resolved during the projection resolver stage, **before** the
 * rewind; after truncation the visible text or the transcript parent is never re-read to guess the
 * original input.
 */
async function retryTurn(
  host: V4CommandCoreHost,
  envelope: CommandEnvelope,
): Promise<CommandResult | undefined> {
  const payload = envelope.payload as CommandPayloadMap["retryTurn"];
  const record = requireRecord(host, envelope.sessionId);
  const resolution = host.resolveRowActionTarget?.(
    record.app.sessionId,
    payload.target,
    "retryTurn",
  );
  if (!resolution?.ok || !resolution.messageId || !resolution.editTarget) {
    throw new V4RetryTargetNotLatestError(payload.target.rowId);
  }
  const attachmentRefs = stableAttachmentRefs(resolution.editTarget);
  const attachments = await mapAttachmentRefsToTurnAttachments(record.app, attachmentRefs);
  await submitConversationRewind(host, record, resolution.messageId);
  await startCanonicalIntent(
    host,
    record,
    envelope,
    resolution.editTarget,
    resolution.editTarget.intent.text,
    attachmentRefs,
    attachments,
  );
  return undefined;
}

/**
 * forkAssistant: the only stable resolver pins the logical-turn/message boundary, and then proceeds
 * with a conversation-only fork. This path does not read activeAbortController, does not stop the parent,
 * and does not enter legacy forkSession (which contains ensureNoActiveTurn + workspace rewind).
 */
async function forkAssistant(
  host: V4CommandCoreHost,
  envelope: CommandEnvelope,
): Promise<CommandResult | undefined> {
  const payload = envelope.payload as CommandPayloadMap["forkAssistant"];
  const record = requireRecord(host, envelope.sessionId);
  const targetResolution = host.resolveRowActionTarget?.(
    record.app.sessionId,
    payload.target,
    "forkAssistant",
  );
  if (!targetResolution?.ok) {
    throw new V4ForkTargetGuardError("guard.forkTargetNotStable", payload.target.rowId);
  }
  if (!host.resolveStableForkTarget) {
    throw new Error("v4 forkAssistant requires host.resolveStableForkTarget capability");
  }
  const resolution = await host.resolveStableForkTarget(record.app.sessionId, payload.target.rowId);
  if (!resolution.ok) {
    throw new V4ForkTargetGuardError(resolution.reasonCode, payload.target.rowId);
  }
  if (!host.forkStableConversation) {
    throw new Error("v4 forkAssistant requires host.forkStableConversation capability");
  }
  const { forkedSessionId } = await host.forkStableConversation(record.app.sessionId, {
    target: resolution.target,
    goalBoundary: resolution.goalBoundary,
    sourceCommandId: envelope.commandId,
    revisionAtDecision: envelope.baseRevision ?? 0,
  });
  // The fork completion fact used to be only in session events/debug and could not be retrieved directly from the production default JSONL.
  // Write info after the child has been created and completed host registration to avoid mistakenly recording rejected or failed requests as successful.
  host.logger?.info?.("v4 forkAssistant completed", {
    ...traceContextToLogContext(record.traceContext),
    childSessionId: forkedSessionId,
    clientId: envelope.clientId,
    commandId: envelope.commandId,
    event: FORK_ASSISTANT_COMPLETED_EVENT,
    module: CONVERSATION_COMMAND_LOG_MODULE,
    parentSessionId: record.app.sessionId,
    revisionAtDecision: envelope.baseRevision ?? 0,
    sessionId: record.app.sessionId,
    status: "completed",
    targetBoundaryMessageId: resolution.target.boundaryMessageId,
    targetEntityId: payload.target.entityId,
    targetRowId: payload.target.rowId,
  });
  const result = { type: "forkAssistant" as const, sessionId: forkedSessionId };
  return result;
}

function stableAttachmentRefs(editTarget: ConversationEditTarget) {
  return editTarget.intent.attachments?.flatMap((attachment) =>
    attachment.ref ? [{ ...attachment, ref: attachment.ref }] : [],
  );
}

async function startCanonicalIntent(
  host: V4CommandCoreHost,
  record: V4SessionRecordView,
  envelope: CommandEnvelope,
  editTarget: ConversationEditTarget,
  text: string,
  attachmentRefs: ReturnType<typeof stableAttachmentRefs>,
  attachments: Awaited<ReturnType<typeof mapAttachmentRefsToTurnAttachments>>,
): Promise<void> {
  const intent = inputIntentMetadataFromCanonical(
    envelope,
    {
      kind: editTarget.intent.kind,
      text: editTarget.intent.text,
      sourceCommandId: editTarget.intent.sourceCommandId,
      clientId: editTarget.intent.clientId,
      queueItemId: editTarget.intent.queueItemId,
      requestedDelivery: editTarget.intent.requestedDelivery,
      admittedDelivery: editTarget.intent.admittedDelivery,
      fallbackReasonCode: editTarget.intent.fallbackReasonCode,
      modelSelection: editTarget.intent.modelSelection,
      mode: editTarget.intent.mode,
      planEnabled: editTarget.intent.planEnabled,
      attachmentRefs,
      provenance: editTarget.intent.provenance,
    },
    text,
  );
  if (editTarget.intent.kind === "sendGoalCommand") {
    await applyGoalCommand(host, record, {
      inputId: envelope.commandId,
      objective: text,
      intent,
    });
    return;
  }
  await startPromptTurn(host, record, {
    content: text,
    inputId: envelope.commandId,
    intent,
    ...(attachments ? { attachments } : {}),
  });
}

export const forkEditRetryHandlers = {
  forkAssistant,
  editUserQuery,
  retryTurn,
};
