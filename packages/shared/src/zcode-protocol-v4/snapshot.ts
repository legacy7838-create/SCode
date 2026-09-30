/* oxlint-disable max-lines -- v4 snapshot schema is a frozen cross-process contract; additions stay grouped here. */
// ConversationSnapshot Area A.
// Area A update semantics = field-level overall replacement (state.updated), never deep merge - deep merge is the mother of confusion.
import { z } from "zod";
import { sharedContextImportStateSchema } from "./shared-context-import.js";
export { sharedContextImportStateSchema } from "./shared-context-import.js";
import { conversationInputDispatchSchema, conversationInputIntentSchema } from "./input-intent.js";
import {
  zcodeContextUsageBreakdownSchema,
  zcodeInteractionRequestOriginSchema,
  zcodePermissionResponseSchema,
  zcodeSessionContextCacheUsageSchema,
} from "../zcode-protocol-legacy-types.js";
import { timestampSchema } from "./core.js";
import { conversationRowSchema } from "./rows.js";
import { toolCallDisplaySchema } from "./toolDisplay.js";

import { workspaceHookReviewRequestPayloadSchema } from "./workspace-hook-review.js";
import { workflowRunsStateSchema } from "./workflow-runs.js";
import { sessionConfigStateSchema, sessionModelTransitionSchema } from "./session-config.js";
export {
  sessionConfigStateSchema,
  sessionModelTransitionSchema,
  type SessionConfigState,
  type SessionModelTransition,
} from "./session-config.js";
// ── SessionControl ──
export const sessionPhaseSchema = z.enum([
  // draft ruling reserved - pure memory state, sessions-index visible, no row,
  // It will disappear when the CLI is restarted without downloading; firstInput arrives → prewarming/running.
  "draft",
  "prewarming",
  "running",
  "completedSuccess",
  "completedInterrupted",
  "error",
]);
export type SessionPhase = z.infer<typeof sessionPhaseSchema>;

export const stopTargetKindSchema = z.enum([
  "assistant",
  "tool",
  "subagent",
  "compact",
  "goalVerifier",
  "goalContinuation",
  "turnSteer",
  "mixed",
  "unknown",
]);
export type StopTargetKind = z.infer<typeof stopTargetKindSchema>;

export const activeWorkSummarySchema = z.object({
  kind: z.enum([
    "primaryTurn",
    "foregroundSubagent",
    "compact",
    "goalVerifier",
    "goalContinuation",
    "turnSteer",
  ]),
  foregroundExecutionId: z.string().min(1).optional(),
  startedAt: timestampSchema,
});
export type ActiveWorkSummary = z.infer<typeof activeWorkSummarySchema>;

// Error codes are divided into fault.*, proto.* and guard.*.
export const errorAttributionSchema = z
  .object({
    source: z.enum(["provider", "runtime", "tool", "network"]).optional(),
    reason: z.string().min(1).max(160).optional(),
    errorPhase: z
      .enum([
        "prepare",
        "configuration",
        "connect",
        "response",
        "stream",
        "parse",
        "validation",
        "unhandled",
      ])
      .optional(),
    exceptionKind: z
      .enum([
        "api_call",
        "generic",
        "protocol",
        "provider_business",
        "transport",
        "type_error",
        "validation",
      ])
      .optional(),
    providerId: z.string().min(1).max(160).optional(),
    modelId: z.string().min(1).max(160).optional(),
    providerKind: z.string().min(1).max(160).optional(),
    transport: z.enum(["http", "sse", "websocket"]).optional(),
    statusCode: z.number().int().min(100).max(599).optional(),
    providerErrorCode: z.string().min(1).max(160).optional(),
    retryable: z.boolean().optional(),
  })
  .strict();
export type ErrorAttribution = z.infer<typeof errorAttributionSchema>;

export const sessionErrorInfoSchema = z.object({
  code: z.string(),
  message: z.string(),
  recoverable: z.boolean(),
  at: timestampSchema,
  source: z.enum(["provider", "runtime", "tool", "network"]),
  traceId: z.string().optional(),
  detail: z.string().optional(),
  underlyingErrorMessage: z.string().optional(),
  underlyingErrorDetail: z.string().optional(),
  attribution: errorAttributionSchema.optional(),
});
export type SessionErrorInfo = z.infer<typeof sessionErrorInfoSchema>;

export const apiRetryStateSchema = z.object({
  attempt: z.number(),
  maxAttempts: z.number(),
  nextRetryAt: timestampSchema,
  reasonCode: z.string(),
});
export type ApiRetryState = z.infer<typeof apiRetryStateSchema>;

export const sessionControlSchema = z.object({
  phase: sessionPhaseSchema,
  // Derived value (= phase ∈ completed*), reserved for UI convenience.
  sessionEnded: z.boolean(),
  canStop: z.boolean(),
  stopState: z.enum(["idle", "stoppable", "stopping"]),
  stopTargetKind: stopTargetKindSchema,
  // Used for lightweight evidence/suspended prompts, the UI must not deduce the flag based on this.
  // hasBackgroundWork is not in the payload: the client derives by the line backgroundWorks.some(w => w.status === "running") .
  activeWorks: z.array(activeWorkSummarySchema),
  lastError: sessionErrorInfoSchema.nullable(),
  apiRetry: apiRetryStateSchema.nullable(),
});
export type SessionControl = z.infer<typeof sessionControlSchema>;

// ── availability and inputRouting ──
export const actionAvailabilitySchema = z.discriminatedUnion("allowed", [
  z.object({ allowed: z.literal(true) }),
  // reasonCode = product-protocol guard id, driver disabled tooltip.
  z.object({ allowed: z.literal(false), reasonCode: z.string() }),
]);
export type ActionAvailability = z.infer<typeof actionAvailabilitySchema>;

export const sessionActionAvailabilitySchema = z.object({
  fork: actionAvailabilitySchema,
  compact: actionAvailabilitySchema,
  switchModelConfig: actionAvailabilitySchema,
  setFollowupMode: actionAvailabilitySchema,
  queueEdit: actionAvailabilitySchema,
  sendQueuedNow: actionAvailabilitySchema,
  pauseGoal: actionAvailabilitySchema,
  resumeGoal: actionAvailabilitySchema,
});
export type SessionActionAvailability = z.infer<typeof sessionActionAvailabilitySchema>;

export const inputRoutingSchema = z.object({
  // choice: held (completed+queue>0+autoDrain=false)
  // The input is not queued silently, and the client displays "clear the queue and send it/retain the queue and send it immediately".
  mode: z.enum(["startNow", "enqueue", "guide", "reject", "choice"]),
  // mode=reject is required; enqueue/guide/choice can be included (such as guide unqualified fallback reason).
  reasonCode: z.string().optional(),
});
export type InputRouting = z.infer<typeof inputRoutingSchema>;

// ── meta (session-level meta information: title). renameSession/automatic title falls here. ──
export const sessionMetaStateSchema = z.object({
  title: z.string(),
  // default = unnamed; generated = model automatically generated; custom = explicit renamed by user (no longer overridden by automatic title).
  titleSource: z.enum(["default", "generated", "custom"]),
});
export type SessionMetaState = z.infer<typeof sessionMetaStateSchema>;

/**
 * Share imported read-only source tags.
 *
 * The shared_context text is only used by the model and cannot be forged into the conversation bubble through userInput row;
 * This additive metadata allows Desktop to still tell the user exactly where the context came from in a new session.
 */
export type { SharedContextImportState } from "./shared-context-import.js";

// ─ Usage. conflation: If the value remains unchanged, it will not be issued──
export const sessionUsageStateSchema = z.object({
  contextWindow: z
    .object({
      usedTokens: z.number(),
      maxTokens: z.number(),
      autoCompactThresholdTokens: z.number().nullable(),
      cache: zcodeSessionContextCacheUsageSchema.optional(),
      breakdown: zcodeContextUsageBreakdownSchema.optional(),
    })
    .nullable(),
  cumulative: z.object({
    inputTokens: z.number(),
    outputTokens: z.number(),
    cacheReadTokens: z.number(),
    cacheWriteTokens: z.number(),
  }),
});
export type SessionUsageState = z.infer<typeof sessionUsageStateSchema>;

// ── queue (not persistent, ruling: the CLI process will be lost when it dies, and the user will decide to resend after the client reconciles the account)──
export const queueItemSchema = conversationInputIntentSchema.extend({
  dispatch: conversationInputDispatchSchema.extend({
    state: z.enum(["queued", "reserved", "promoting"]),
  }),
  toolDisallowlist: z.array(z.string().min(1)).optional(),
});
export type QueueItem = z.infer<typeof queueItemSchema>;

export const queueStateSchema = z.object({
  items: z.array(queueItemSchema),
  // After stop = false (pause queue); setAutoDrain resumes.
  autoDrain: z.boolean(),
  // Additive: The UI of old snapshots uses universal pause text by default; Stop/TurnError can display the reason text.
  pauseReason: z.enum(["stopped", "manual", "error"]).optional(),
});
export type QueueState = z.infer<typeof queueStateSchema>;

// ── pendingInteractions (blocking interaction → status)──
export const MAX_PERMISSION_FEEDBACK_CHARS = 4_096;

export const PERMISSION_FULL_ACCESS_OPTION_ID = "fullAccess";
const permissionOptionSchema = z.object({
  optionId: z.string(),
  label: z.string(),
  kind: z.enum(["allowOnce", "allowAlways", "deny", "custom"]),
  response: zcodePermissionResponseSchema.optional(),
});

export const permissionRequestPayloadSchema = z.object({
  kind: z.literal("permission"),
  toolCallId: z.string(),
  toolName: z.string(),
  summary: z.string(),
  detail: z.unknown(),
  // Additive: The UI of the old snapshot does not display feedback input by default; the new projection of V4 can be explicitly turned on.
  freeText: z.boolean().optional(),
  origin: zcodeInteractionRequestOriginSchema.optional(),
  // The confirmation preview reported by the tool reuses the display projection of row (the same bounded shape). Default = plain text ask.
  // There is also no gate: the preview parsing fails and is reduced to a plain text ask, and the entire snapshot is not rejected (see toolDisplay.ts comments).
  display: toolCallDisplaySchema.optional().catch(undefined),
  // Independent additive capabilities: The old UI ignores this field and still only displays the original options, without the semi-implemented authorization entry.
  fullAccessOption: permissionOptionSchema
    .extend({
      optionId: z.literal(PERMISSION_FULL_ACCESS_OPTION_ID),
      kind: z.literal("custom"),
    })
    .optional(),
  options: z.array(permissionOptionSchema),
});
export type PermissionRequestPayload = z.infer<typeof permissionRequestPayloadSchema>;

export const userInputOptionPayloadSchema = z.object({
  value: z.string(),
  label: z.string(),
  description: z.string().optional(),
  preview: z.string().optional(),
});
export type UserInputOptionPayload = z.infer<typeof userInputOptionPayloadSchema>;

export const userInputQuestionPayloadSchema = z.object({
  question: z.string(),
  header: z.string(),
  options: z.array(userInputOptionPayloadSchema),
  multiSelect: z.boolean().optional(),
});
export type UserInputQuestionPayload = z.infer<typeof userInputQuestionPayloadSchema>;

export const userInputRequestPayloadSchema = z.object({
  kind: z.literal("userInput"),
  prompt: z.string(),
  freeText: z.boolean(),
  options: z.array(z.object({ optionId: z.string(), label: z.string() })).optional(),
  // true → The input box is processed according to the password, and the client does not enter the draft/history.
  sensitive: z.boolean().optional(),
  toolName: z.string().optional(),
  toolCallId: z.string().optional(),
  traceId: z.string().optional(),
  input: z.unknown().optional(),
  schema: z.unknown().optional(),
  questions: z.array(userInputQuestionPayloadSchema).optional(),
  currentQuestionIndex: z.number().optional(),
  answerDrafts: z.record(z.string(), z.array(z.string())).optional(),
  origin: zcodeInteractionRequestOriginSchema.optional(),
});
export type UserInputRequestPayload = z.infer<typeof userInputRequestPayloadSchema>;

export const interactionAutoResolutionSchema = z.discriminatedUnion("state", [
  z.object({
    state: z.enum(["hiddenGrace", "visibleCountdown"]),
    startedAt: timestampSchema,
    visibleAt: timestampSchema,
    deadlineAt: timestampSchema,
  }),
  z.object({
    state: z.literal("snoozed"),
    startedAt: timestampSchema,
    snoozedAt: timestampSchema,
  }),
]);
export type InteractionAutoResolution = z.infer<typeof interactionAutoResolutionSchema>;

export const pendingInteractionSchema = z
  .object({
    interactionId: z.string(),
    kind: z.enum(["permission", "userInput", "workspaceHookReview"]),
    // null = session level (such as provider interactions and workspace Hook review).
    anchorRowId: z.number().nullable(),
    createdAt: timestampSchema,
    autoResolution: interactionAutoResolutionSchema.optional(),
    payload: z.discriminatedUnion("kind", [
      permissionRequestPayloadSchema,
      userInputRequestPayloadSchema,
      workspaceHookReviewRequestPayloadSchema,
    ]),
  })
  .superRefine((interaction, context) => {
    if (interaction.kind !== interaction.payload.kind) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["kind"],
        message: "pending interaction kind must match payload kind",
      });
    }
    if (interaction.kind === "workspaceHookReview" && interaction.autoResolution) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["autoResolution"],
        message: "workspaceHookReview cannot use AskUserQuestion auto-resolution",
      });
    }
    if (
      interaction.payload.kind === "workspaceHookReview" &&
      interaction.interactionId !== interaction.payload.interactionId
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["interactionId"],
        message: "workspaceHookReview interaction id must match its immutable payload",
      });
    }
  });
export type PendingInteraction = z.infer<typeof pendingInteractionSchema>;

// ── pendingCommands / backgroundWorks ──
export const commandStateSummarySchema = z.object({
  commandId: z.string(),
  clientId: z.string(),
  type: z.string(),
  state: z.enum(["accepted", "executing"]),
  at: timestampSchema,
});
export type CommandStateSummary = z.infer<typeof commandStateSummarySchema>;

export const backgroundWorkSummarySchema = z.object({
  workId: z.string(),
  // workflow = workflow run(CreateWorkflow). **Skew cost of closed set addition**:
  // The entire state.updated patch parsing fails when the old desktop receives an unknown value (illegal values for known keys are errors, not stripping),
  // So the entire frame is rejected by the assembler, and the resync snapshot carries the same value and fails too - it cannot be degraded gracefully.
  // The CLI is released in the same batch as the desktop to make it acceptable.
  kind: z.enum(["bash", "subagent", "workflow"]),
  title: z.string(),
  // resultPending = completed, the result is waiting in the continuation inbox for the foreground to be idle;
  // After delivery, the entry disappears (the result body becomes the userInput row of origin=backgroundResult).
  status: z.enum(["running", "resultPending", "failed", "cancelled"]),
  startedAt: timestampSchema,
  endedAt: timestampSchema.optional(),
  cancellable: z.boolean().optional(),
  blocked: z.boolean().optional(),
  anchorRowId: z.number().nullable(),
  childSessionId: z.string().optional(),
});
export type BackgroundWorkSummary = z.infer<typeof backgroundWorkSummarySchema>;

// The subagent running state belongs to the conversation authority projection, not the renderer query cache.
// The ended details remain in the cursor query; the snapshot only carries the total number of directories to prevent the number of concurrent runs from depending on the query timing.
export const runningSubagentSummarySchema = z.object({
  childSessionId: z.string(),
  agentId: z.string().optional(),
  toolCallId: z.string().optional(),
  subagentType: z.string(),
  title: z.string(),
  summary: z.string().optional(),
  status: z.enum(["running", "waiting", "blocked"]),
  startedAt: timestampSchema.optional(),
});
export type RunningSubagentSummary = z.infer<typeof runningSubagentSummarySchema>;

export const subagentProjectionStateSchema = z.object({
  revision: z.number().int().nonnegative(),
  childSessionIds: z.array(z.string()),
  running: z.array(runningSubagentSummarySchema),
  endedTotal: z.number().int().nonnegative(),
});
export type SubagentProjectionState = z.infer<typeof subagentProjectionStateSchema>;

// ── goal / plan ──
export const planItemSchema = z.object({
  id: z.string(),
  content: z.string(),
  status: z.enum(["pending", "inProgress", "completed"]),
});
export type PlanItem = z.infer<typeof planItemSchema>;

export const goalIterationStateSchema = z.object({
  iteration: z.number().int().positive(),
  items: z.array(planItemSchema),
  updatedAt: timestampSchema,
});
export type GoalIterationState = z.infer<typeof goalIterationStateSchema>;

export const goalStateSchema = z.object({
  // default is only for compatibility with old snapshots; new projections always carry the current target identity and timing facts.
  targetId: z.string().default(""),
  objective: z.string(),
  summaryTitle: z.string().nullable().default(null),
  timeUsedSeconds: z.number().int().nonnegative().default(0),
  activeRunStartedAtMs: z.number().int().nonnegative().nullable().default(null),
  // paused: stop acts on any foreground work when the target is forced to enter (stopPausesActiveGoalTarget).
  // notSatisfied is separated from failed: the former is a valid conclusion, the latter is a failure of the verification process.
  status: z.enum(["active", "paused", "verifying", "verified", "notSatisfied", "failed"]),
  iteration: z.number(),
  verifications: z.array(
    z.object({
      iteration: z.number(),
      outcome: z.enum(["pass", "notSatisfied", "failed"]),
      at: timestampSchema,
      anchorRowId: z.number().nullable(),
      reason: z.string().optional(),
      nextAction: z.string().optional(),
    }),
  ),
  iterations: z.array(goalIterationStateSchema).default([]),
});
export type GoalState = z.infer<typeof goalStateSchema>;

export const planStateSchema = z.object({
  items: z.array(planItemSchema),
  updatedAt: timestampSchema,
});
export type PlanState = z.infer<typeof planStateSchema>;

// ── Snapshot Overview ──
export const rowsWindowSchema = z.object({
  // Tail window, rowId ascending order.
  window: z.array(conversationRowSchema),
  // Current total sequence number of rows (reduced after truncation; used for scrollbar estimation only).
  totalCount: z.number(),
  // The rowId of the first row in total order; the first row of the window is equal to it ⇔ has reached the top (cursor paging determination).
  firstRowId: z.number().nullable(),
});
export type RowsWindow = z.infer<typeof rowsWindowSchema>;

// Soft Gate: Session-level pending hook access status.
// snapshot is shared with StatePatch (delta.ts) to ensure that the projected patch and snapshot fields are isomorphic.
export const workspaceHookAdmissionStateSchema = z.object({
  pendingCount: z.number().int().nonnegative(),
  bundleDigest: z.string(),
  workspaceIdentity: z.string().optional(),
});
export type WorkspaceHookAdmissionSnapshotState = z.infer<typeof workspaceHookAdmissionStateSchema>;

export const conversationSnapshotSchema = z.object({
  protocolVersion: z.literal(1),
  sessionId: z.string(),
  logEpoch: z.string(),
  // Snapshot alignment water level (= frame toSeq; value from memory projection atom).
  seq: z.number(),
  revision: z.number(),
  // Area A
  control: sessionControlSchema,
  availability: sessionActionAvailabilitySchema,
  inputRouting: inputRoutingSchema,
  // meta is after freezing the schema
  // Additive is new, and default must be used in order not to destroy the resolution of the old snapshot/old sender - the backup branch once set it to
  // Required, the round-trip test of shared is always red on this branch (the root vitest was not run at that time and was missed).
  meta: sessionMetaStateSchema.default({ title: "", titleSource: "default" }),
  // Additive: If the old CLI/old snapshot does not have this field, it will still be processed as a normal session.
  sharedContextImport: sharedContextImportStateSchema.optional(),
  config: sessionConfigStateSchema,
  // Persistent stable facts are used for live clients to identify one-time prompts; they are not triggered when old snapshots have missing fields.
  modelTransition: sessionModelTransitionSchema.nullable().default(null),
  usage: sessionUsageStateSchema,
  queue: queueStateSchema,
  pendingInteractions: z.array(pendingInteractionSchema),
  pendingCommands: z.array(commandStateSummarySchema),
  backgroundWorks: z.array(backgroundWorkSummarySchema),
  // optional Only serves old snapshot wire compatibility; the initial state of the new CLI and each projection always carry this field.
  subagents: subagentProjectionStateSchema.optional(),
  // Cold snapshots must carry workflowRuns: If you miss this point, the running run will disappear silently after refreshing/reconnecting.
  // (The details page is therefore blank, while the run itself is still flying). optional also only serves old snapshot wire compatibility.
  workflowRuns: workflowRunsStateSchema.optional(),
  goal: goalStateSchema.nullable(),
  plan: planStateSchema.nullable(),
  // Soft Gate: additive field, must have default (null).
  // Old snapshots/old senders do not carry this field → parsed to null, which does not break compatibility (comply with freezing rules).
  // When pendingCount === 0, the projection layer is set to null (the prompt bar disappears).
  workspaceHookAdmission: workspaceHookAdmissionStateSchema.nullable().default(null),
  // Area B
  rows: rowsWindowSchema,
});
export type ConversationSnapshot = z.infer<typeof conversationSnapshotSchema>;
