import { localTtftContextSchema, localTtftClockSchema } from "../localTtft.js";
// Command layer: envelope/ACK/command set payload.
// conversation rewind no independent command (ruling: = UI entry for editUserQuery);
// The workspace-only file can be revoked using applyFileRewind without truncating the chat history.
import { z } from "zod";
import { conversationRowTargetSchema, timestampSchema } from "./core.js";
import { attachmentRefSchema } from "./attachment-ref.js";
import { v4ConversationFileRewindPreviewResultSchema } from "./transport.js";
import { modelSelectionSchema } from "../model-selection.js";
import { modelExecutionSchema } from "../model-execution.js";
import { submissionModeSchema } from "./submission.js";
import { zcodeAutomationBotDeliveryTargetSchema } from "../bots.js";
import {
  amendWorkflowRunSettingsPayloadSchema,
  amendWorkflowRunSettingsResultSchema,
} from "./workflow-run-settings-command.js";
import {
  workspaceHookReviewCommandTargetSchema,
  workspaceHookReviewDecisionSchema,
  workspaceHookTrustRevokeTargetSchema,
  requestWorkspaceHookReviewTargetSchema,
} from "./workspace-hook-review.js";
import {
  zcodeBrowserAmbientContextSchema,
  zcodeProtocolMcpServerSchema,
} from "../zcode-protocol/index.js";
import { sharedContextRefSchema } from "./shared-context-ref.js";
export type { SharedContextRef } from "./shared-context-ref.js";

const createSessionRequestedConfigSchema = z.object({
  modelSelection: modelSelectionSchema.optional(),
  provider: z.string().optional(),
  model: z.string().optional(),
  thought: z.string().optional(),
  followupMode: z.enum(["queue", "guide"]).optional(),
  // createSession.config expresses "request coverage field" and cannot reuse snapshot.
  // sessionConfigStateSchema.partial(); snapshot sets default("build") for mode to be compatible with old snapshots.
  // It will mistakenly change "no mode passed" to "request to switch back to build", overwriting the workspace default yolo.
  mode: z.string().optional(),
  planEnabled: z.boolean().optional(),
});

// ── Complete command payload ──
export const commandPayloadSchemas = {
  // firstInput default → phase=draft empty session; carry → direct turnHeader+userInput rows.
  createSession: z.object({
    workspaceId: z.string(),
    firstInput: z
      .object({
        text: z.string(),
        attachments: z.array(attachmentRefSchema).optional(),
        modelSelection: modelSelectionSchema.optional(),
        mode: submissionModeSchema.optional(),
        planEnabled: z.boolean().optional(),
      })
      .optional(),
    config: createSessionRequestedConfigSchema.optional(),
    // MCP is a configuration during runtime startup. It must be entered into the record once with create and cannot be rewritten after the initial release.
    mcpServers: z.array(zcodeProtocolMcpServerSchema).optional(),
    // Off-Peak tool surface flag, equivalent to legacy session/create - V4 createSession is desktop
    // The actual creation path of the new session. Without transparent transmission, OffPeakCreate/OffPeakList will never be registered. additive,
    // The old CLI's z.object silently discarded the key (fail-closed).
    offPeakToolEnabled: z.boolean().optional(),
    // Dynamic workflow grayscale flag, the same mode as offPeakToolEnabled.
    dynamicWorkflowEnabled: z.boolean().optional(),
  }),
  // The parent session is specified by envelope.sessionId; the server derives the complete running configuration from the parent record.
  // When firstInput exists, the first normal input will be started immediately after the child is created; by default, the secondary screen will remain empty.
  createSelectionSideSession: z.object({
    firstInput: z
      .object({
        text: z.string().trim().min(1),
        // Commit recommendations only cover the full selection of new children, leaving parent runtime inheritance by default.
        modelSelection: modelSelectionSchema.optional(),
      })
      .optional(),
  }),
  // By inputRouting ruling: startNow/enqueue/guide/choice.
  // heldQueueDisposition: required in held state (inputRouting.mode=choice);
  // clear→clear the queue and startNow, keep→keep the queue and startNow immediately.
  sendText: z
    .object({
      text: z.string(),
      attachments: z.array(attachmentRefSchema).optional(),
      // Desktop Cmd/Ctrl+Enter only covers this busy input and does not change the session followupMode.
      // startNow atomically preempts the current turn by CLI without going through queue admission.
      requestedDelivery: z.enum(["startNow", "queue", "guide"]).optional(),
      browserAmbientContext: zcodeBrowserAmbientContextSchema.optional(),
      // Share handover only allows one imported context for the current session; the full text is provided by the runtime from
      // Persistent provenance analysis cannot be passed in from the renderer with the command.
      context_refs: z.array(sharedContextRefSchema).max(1).optional(),
      heldQueueDisposition: z.enum(["clearQueueAndSend", "keepQueueAndSend"]).optional(),
      // The collection of queueItemIds seen when the pause queue confirmation box is opened. CLI verifies before executing clear/keep,
      // Prevent concurrent additions and deletions on desktop/mobile phones and process new queues that have not been confirmed by the user together.
      expectedHeldQueueItemIds: z.array(z.string().min(1)).optional(),
      // The migration period allows the old sender to default; CLI admission will fix the current Session Selection into
      // canonical intent. After the Renderer switch is complete, first-party user submissions always carry these two items explicitly.
      modelSelection: modelSelectionSchema.optional(),
      mode: submissionModeSchema.optional(),
      planEnabled: z.boolean().optional(),
      // This execution still uses the standard Selection above; here only non-persistent semantics, dynamic authentication and child strategies are carried.
      // Only idle startNow is accepted, preventing Secret/Ticket from entering the normal CommandInbox.
      modelExecution: modelExecutionSchema.optional(),
      automationId: z.string().min(1).optional(),
      offPeakTaskId: z.string().min(1).optional(),
      offPeakRunType: z.enum(["init", "resume"]).optional(),
      // The Bot source is only injected by the Host and is used by CronCreate to read and persist the pushback address within the current turn.
      botDeliveryTarget: zcodeAutomationBotDeliveryTargetSchema.optional(),
      // Subsequent user input from the cron job session must also maintain turn-scoped tool surface isolation; it cannot be borrowed
      // automationId, otherwise ordinary user input will be mistakenly marked as an automation dispatch.
      toolDisallowlist: z.array(z.string().min(1)).optional(),
    })
    .superRefine((payload, context) => {
      if (payload.automationId && payload.offPeakTaskId) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "automationId and offPeakTaskId are mutually exclusive",
        });
      }
      if (payload.offPeakRunType && !payload.offPeakTaskId) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "offPeakRunType requires offPeakTaskId",
          path: ["offPeakRunType"],
        });
      }
      if (payload.modelExecution && !payload.modelSelection) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "modelExecution requires modelSelection",
          path: ["modelExecution"],
        });
      }
    }),
  sendGoalCommand: z.object({
    text: z.string(),
    displayText: z.string().optional(),
    modelSelection: modelSelectionSchema.optional(),
    mode: submissionModeSchema.optional(),
    planEnabled: z.boolean().optional(),
    heldQueueDisposition: z.enum(["clearQueueAndSend", "keepQueueAndSend"]).optional(),
    expectedHeldQueueItemIds: z.array(z.string().min(1)).optional(),
  }),
  stop: z.object({
    // From activeWorks; used by the CLI to reject late Stops that would inadvertently kill subsequent unrelated execution.
    expectedForegroundExecutionId: z.string().min(1).optional(),
  }),
  // compact is an input maintenance command: executed immediately when idle, and entered into FIFO when busy/held.
  // Because admission has nothing to do with the current revision, CAS is not used; sourceCommandId provides idempotent boundaries.
  compact: z.object({}),
  // Available for stable assistant row while running.
  forkAssistant: z.object({ target: conversationRowTargetSchema }),
  applyFileRewind: z.object({ target: conversationRowTargetSchema }),
  editUserQuery: z.object({
    target: conversationRowTargetSchema,
    newText: z.string(),
    attachments: z.array(attachmentRefSchema).optional(),
    // Default preserve: only cut the conversation branch; rewind will safely restore the round of files first.
    workspaceMode: z.enum(["preserve", "rewind"]).optional(),
  }),
  retryTurn: z.object({ target: conversationRowTargetSchema }),
  setAssistantFeedback: z.object({
    target: conversationRowTargetSchema,
    feedback: z.enum(["like", "dislike"]).nullable(),
  }),
  sendQueuedNow: z.object({ queueItemId: z.string() }),
  editQueueItem: z.object({ queueItemId: z.string(), newText: z.string() }),
  // beforeQueueItemId = null → Move to the end of the queue.
  reorderQueueItem: z.object({
    queueItemId: z.string(),
    beforeQueueItemId: z.string().nullable(),
  }),
  deleteQueueItem: z.object({ queueItemId: z.string() }),
  setAutoDrain: z.object({ autoDrain: z.boolean() }),
  // First come first served, late arrival noop (reasonCode=proto.alreadyResolved).
  resolveInteraction: z.object({
    interactionId: z.string(),
    answer: z.object({
      optionId: z.string().optional(),
      freeText: z.string().optional(),
      // (elicitation receipt convergence): AskUserQuestion/plan-approval
      // Answers and annotations to multiple questions are carried losslessly. CLI broker press accept/decline/cancel when action exists
      // Exact mapping (content is passed directly to the old userInput response semantics); the default is used
      // optionId/freeText compatible path, old client behavior remains unchanged.
      action: z.enum(["accept", "decline", "cancel"]).optional(),
      content: z.record(z.string(), z.unknown()).optional(),
    }),
  }),
  respondWorkspaceHookReview: workspaceHookReviewCommandTargetSchema.extend({
    decision: workspaceHookReviewDecisionSchema,
  }),
  toggleWorkspaceHookReviewItem: workspaceHookReviewCommandTargetSchema.extend({
    reviewItemId: z.string().trim().min(1),
    enabled: z.boolean(),
  }),
  revokeWorkspaceHookTrust: z.union([
    workspaceHookReviewCommandTargetSchema.extend({
      reviewItemIds: z.array(z.string().trim().min(1)).min(1),
    }),
    workspaceHookTrustRevokeTargetSchema,
  ]),
  // Soft access control: Open audit flow on demand, clone revoke non-flow target but without hookDeclarationDigests.
  requestWorkspaceHookReview: requestWorkspaceHookReviewTargetSchema,
  // The first valid operation of AskUserQuestion is permanently suspended and ends automatically; repeated/late calls are idempotent noops.
  snoozeInteractionAutoResolution: z.object({
    interactionId: z.string(),
  }),
  switchModelConfig: z.object({
    provider: z.string(),
    model: z.string(),
    thought: z.string(),
  }),
  // Additive (the frozen surface evolves according to the gold test endorsement): agent collaboration mode switch.
  // Value range = switchable subset of core CollaborationMode (auto is not user-switchable and does not enter the UI command surface).
  switchCollaborationMode: z.object({
    mode: z.enum(["build", "edit", "plan", "yolo"]),
  }),
  setFollowupMode: z.object({ mode: z.enum(["queue", "guide"]) }),
  pauseGoal: z.object({}),
  resumeGoal: z.object({}),
  cancelBackgroundWork: z.object({ workId: z.string() }),
  // cancel & resume: Resume a canceled/dead process
  // Interrupted dwf run. workId ≡ runId (same identity equation as cancelBackgroundWork); `name` optional,
  // Feed the topic of completion notification after recovery (original CreateWorkflow tool input is unavailable after restart). Deliberately not carrying
  // baseRevision: Similar to cancelBackgroundWork (workflowRuns does not require revision, false CAS fails
  // It will only cause accidental injury). Gate on CLI side (recoverable set = canceled ∪ failed+Interrupted), reject with
  // fault.command.workflowRunResumeRejected.<reason> returns ACK.
  resumeWorkflowRun: z.object({ workId: z.string(), name: z.string().optional() }),
  // startSavedWorkflow: Hub "Run" is no longer synthesized
  // Conversation copy, directly ask the agent to start the saved workflow in a new session. with cancelBackgroundWork/resumeWorkflowRun
  // Similar: does not carry baseRevision (workflowRuns does not require revision, false CAS failure will only cause accidental damage). name by agent from
  // Fill in the parsing result (invariant 6), and the command does not accept name coverage.
  // Reject ACK with fault.command.savedWorkflowStartRejected.<reason> (see vocabulary below
  // savedWorkflowStartRejectionReasonSchema); capability absent (no dwf port) → V4CapabilityUnsupportedError
  // (Same error as resumeWorkflowRun).
  startSavedWorkflow: z.object({
    name: z.string().min(1),
    scope: z.enum(["project", "global"]).optional(),
    args: z.record(z.string(), z.unknown()).optional(),
  }),
  // amendWorkflowRunSettings: The "Configuration" of the run card/details page directly asks the agent to revise the run with the new settings without going through the model wheel. Payloads, Results and Rejections
  // See workflow-run-settings-command.ts for the glossary; capability absent → V4CapabilityUnsupportedError.
  amendWorkflowRunSettings: amendWorkflowRunSettingsPayloadSchema,
  renameSession: z.object({ title: z.string() }),
  deleteSession: z.object({}),
  discardSharedContext: z.object({ contextId: z.string().trim().min(1) }).strict(),
} as const;

export type CommandType = keyof typeof commandPayloadSchemas;
export type CommandPayloadMap = {
  [T in CommandType]: T extends "sendText"
    ? z.infer<(typeof commandPayloadSchemas)[T]> &
        import("../zcode-task-types-core.js").ZCodeBackgroundTurnAttribution
    : z.infer<(typeof commandPayloadSchemas)[T]>;
};

export const commandTypeSchema = z.enum(
  Object.keys(commandPayloadSchemas) as [CommandType, ...CommandType[]],
);

// startSavedWorkflow rejects vocabulary:
// The bootstrap handler casts the fault code, the ui launcher reversely checks the i18n copy, and both sides share this enumeration to avoid drift.
// invalid_name / not_found: parsing stage; invalid_args: actual parameter verification; compile_failed: analyzeScript diagnosis;
// session_busy: The session has active turn; start_failed: Other starts before port.submit failed.
export const savedWorkflowStartRejectionReasonSchema = z.enum([
  "invalid_name",
  "not_found",
  "invalid_args",
  "compile_failed",
  "session_busy",
  "start_failed",
]);
export type SavedWorkflowStartRejectionReason = z.infer<
  typeof savedWorkflowStartRejectionReasonSchema
>;

// Full fault code = prefix + reason (eg fault.command.savedWorkflowStartRejected.not_found).
// Same family as the workflowRunResumeRejected namespace; export constants for bootstrap splicing and ui prefix matching.
export const SAVED_WORKFLOW_START_REJECTED_FAULT_PREFIX =
  "fault.command.savedWorkflowStartRejected." as const;

// Rejection of resumeWorkflowRun: prefix + port reason (not_found/not_resumable/superseded/
// already_running / script_missing / script_mismatch / compile_failed); `ack.message` carries
// Bounded diagnostics for compile_failed.
export const WORKFLOW_RUN_RESUME_REJECTED_FAULT_PREFIX =
  "fault.command.workflowRunResumeRejected." as const;

// Rejection of cancelBackgroundWork: core clearly returns "nothing was canceled" (the task does not exist/has been terminated/the type is not supported)
// Prefix it with + reason instead of an accepted one that pretends to be successful - the details page will tell the user that this run is not running.
// reason is core's stopBackgroundTask reason, remove the `background_task_` prefix: not_found /
// not_running / cancel_not_supported.
export const BACKGROUND_WORK_CANCEL_REJECTED_FAULT_PREFIX =
  "fault.command.backgroundWorkCancelRejected." as const;

// CAS ✓ command: the envelope must carry baseRevision.
export const COMMANDS_REQUIRING_BASE_REVISION: ReadonlySet<CommandType> = new Set([
  "applyFileRewind",
  "forkAssistant",
  "editUserQuery",
  "retryTurn",
  "setAssistantFeedback",
  "sendQueuedNow",
  "editQueueItem",
  "reorderQueueItem",
  "deleteQueueItem",
  "setAutoDrain",
  "switchModelConfig",
  "switchCollaborationMode",
  "setFollowupMode",
  "pauseGoal",
  "resumeGoal",
]);

export const ROW_TARGETING_COMMANDS: ReadonlySet<CommandType> = new Set([
  "applyFileRewind",
  "forkAssistant",
  "editUserQuery",
  "retryTurn",
  "setAssistantFeedback",
]);

// ── Envelope ──
export const commandEnvelopeSchema = z.object({
  ttft: localTtftContextSchema.optional(),
  // uuid v7, generated by the client, unchanged on retries.
  commandId: z.string(),
  clientId: z.string(),
  // null when creatingSession.
  sessionId: z.string().nullable(),
  baseRevision: z.number().optional(),
  baseLogEpoch: z.string().trim().min(1).optional(),
  type: commandTypeSchema,
  payload: z.unknown(),
  // Client clock, telemetry only; server not used for any adjudication.
  issuedAt: timestampSchema,
});
export type CommandEnvelope = z.infer<typeof commandEnvelopeSchema>;

/** Validates the envelope and the payload according to `type` (the envelope schema cannot statically relate payload, so the narrowing happens here). */
export function parseCommandEnvelope(
  value: unknown,
): { ok: true; envelope: CommandEnvelope } | { ok: false; error: z.ZodError } {
  const envelope = commandEnvelopeSchema.safeParse(value);
  if (!envelope.success) return { ok: false, error: envelope.error };
  const payload = commandPayloadSchemas[envelope.data.type].safeParse(envelope.data.payload);
  if (!payload.success) return { ok: false, error: payload.error };
  if (
    (COMMANDS_REQUIRING_BASE_REVISION.has(envelope.data.type) &&
      envelope.data.baseRevision === undefined) ||
    (ROW_TARGETING_COMMANDS.has(envelope.data.type) && envelope.data.baseLogEpoch === undefined)
  ) {
    return {
      ok: false,
      error: new z.ZodError([
        {
          code: "custom",
          path: [envelope.data.baseRevision === undefined ? "baseRevision" : "baseLogEpoch"],
          message: "CAS commands require baseRevision and baseLogEpoch",
        },
      ]),
    };
  }
  return {
    ok: true,
    envelope: { ...envelope.data, payload: payload.data },
  };
}

// ── ACK ──
export const commandResultSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.enum(["createSession", "createSelectionSideSession", "forkAssistant"]),
    sessionId: z.string(),
    input: z
      .object({
        delivery: z.enum(["startNow", "queue", "guide"]),
        inputId: z.string(),
        // Core admission ACK does not wait for TurnStarted; messageId may be completed by subsequent events.
        messageId: z.string().optional(),
      })
      .optional(),
  }),
  z.object({
    type: z.literal("resolveInteraction"),
    resolvedBy: z.object({
      clientId: z.string(),
      optionId: z.string().optional(),
    }),
  }),
  z.object({
    type: z.literal("applyFileRewind"),
    applied: z.boolean(),
    preview: v4ConversationFileRewindPreviewResultSchema,
    response: z.string(),
  }),
  z.object({
    type: z.literal("editUserQuery"),
    // The fork only retains the old ACK decoding compatibility; the new editUserQuery no longer generates child sessions.
    disposition: z.enum(["rewind", "fork", "blocked"]),
    sessionId: z.string().min(1),
    reasonCode: z.string().min(1).optional(),
    preview: v4ConversationFileRewindPreviewResultSchema.optional(),
  }),
  z.object({
    // startSavedWorkflow accepted ACK:
    // runId connects the launch wheel run card status/notification/side panel; toolCallId = launch-<uuid>, connects to the CreateWorkflow wheel.
    type: z.literal("startSavedWorkflow"),
    runId: z.string().min(1),
    toolCallId: z.string().min(1),
  }),
  amendWorkflowRunSettingsResultSchema,
  z.object({
    // messageId is only completed after TurnStarted as bypass attribution; Core admission ACK does not wait
    // projection commit, messageId cannot be used as a necessary condition for input accepted.
    type: z.literal("inputAccepted"),
    delivery: z.enum(["startNow", "queue", "guide"]),
    inputId: z.string(),
    messageId: z.string().optional(),
  }),
  z.object({
    // restart discarded used to return only one indistinguishable fault, and the renderer could not distinguish it.
    // runtime-local queue and startNow which still require manual confirmation. delivery from session_input
    // Persistent facts that cannot be guessed by the client based on the current UI phase.
    type: z.literal("inputDisposition"),
    delivery: z.enum(["startNow", "queue", "guide"]),
  }),
]);
export type CommandResult = z.infer<typeof commandResultSchema>;

export const commandAckSchema = z.object({
  /** The App Memory switch adopted at session creation time; absent from older senders means unknown. */
  memoryEnabled: z.boolean().optional(),
  ttftExcluded: z.literal("capacity").optional(),
  commandId: z.string(),
  // accepted does not promise to survive across CLI processes; the final closure is subject to authoritative data (sourceCommandId).
  status: z.enum(["accepted", "rejected", "stale", "duplicate", "noop", "failed"]),
  // rejected/stale/noop/failed required; = guard id or fault code (namespace).
  reasonCode: z.string().optional(),
  message: z.string().optional(),
  revisionAtDecision: z.number(),
  // Duplicate plays back the cached results; accepted can also be brought (fork) immediately.
  result: commandResultSchema.optional(),
});
export type CommandAck = z.infer<typeof commandAckSchema>;

// ── commands/query ──
export const commandKeySchema = z
  .object({
    // null only belongs to the global/createSession idempotent bucket; the session command must carry sessionId.
    sessionId: z.string().nullable(),
    commandId: z.string().min(1),
  })
  .strict();
export type CommandKey = z.infer<typeof commandKeySchema>;

export const commandsQueryParamsSchema = z
  .object({
    commands: z.array(commandKeySchema).min(1).max(64),
    clock: z.literal(true).optional(),
  })
  .strict()
  .refine(
    (params) => !params.clock || params.commands.every((key) => key.sessionId === null),
    "clock probes cannot query session commands",
  );
export type CommandsQueryParams = z.infer<typeof commandsQueryParamsSchema>;

export const commandQueryItemSchema = z
  .object({
    key: commandKeySchema,
    result: z.union([commandAckSchema, z.literal("unknown")]),
  })
  .strict();
export type CommandQueryItem = z.infer<typeof commandQueryItemSchema>;

export const commandsQueryResultSchema = z
  .object({
    results: z.array(commandQueryItemSchema).min(1).max(64),
    clock: localTtftClockSchema.optional(),
  })
  .strict();
export type CommandsQueryResult = z.infer<typeof commandsQueryResultSchema>;
