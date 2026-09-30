import type { ExecutionOutputPreview } from "../interfaces/execution.port.js";
import type { RuntimeInputPresentation } from "../interfaces/runtime-input-presentation.js";
/* eslint-disable max-lines -- the session event contract is exported from a single file, so the app/agent protocol types cannot drift apart once they are spread out. */
// ============================================================
// Session Events - All event types for the agent loop
// ============================================================

import type {
  EventId,
  InteractionRequestOrigin,
  MessageId,
  PartId,
  QueryId,
  SessionId,
  TraceId,
  ToolCallId,
  TurnId,
} from "../interfaces/shared.js";
import type {
  CollaborationMode,
  RiskLevel,
  TurnSteerCommandKind,
  TurnSteerDeliveryMode,
  TurnSteerRejectReason,
  TurnSteerSource,
  TurnInputIntentMetadata,
} from "../interfaces/session.port.js";
import type {
  ModelNetworkStatusEvent,
  ModelSelection,
  ModelUsage,
  ModelUsageSummary,
} from "../model/index.js";
import type { HttpClientEgressInfo } from "../interfaces/http-client.port.js";
import { createModelUsageSummary } from "../model/index.js";
import type { ModelApiErrorPhase, ModelFailureExceptionKind } from "../telemetry/index.js";
import type {
  CompactBoundaryPayload,
  CompactTimelinePayload,
  MicrocompactBoundaryPayload,
} from "../compact/index.js";
import type { HookRunLifecyclePayload } from "../hooks/index.js";
import type { CheckpointCreatedPayload, RewindTriggeredPayload } from "../rewind/index.js";
import type { GoalCompletionVerificationOutput, SessionGoal } from "../tools/target.js";
import type { ToolSideEffectScope } from "../tools/contract.js";
import type { ToolResultDisplayPayload } from "../tools/tool-result-metadata.js";
import type { SkillTelemetryMetadata } from "../skills/index.js";
import type {
  MessageVisibility,
  SessionTitleSource,
  SyntheticUserMessageSource,
} from "../interfaces/session-store.port.js";
import type { SavedWorkflowScope } from "../tools/saved-workflow.js";
import type { PermissionOptionsPolicy, PermissionUpdate } from "../interfaces/permission.port.js";
import type {
  StreamRecoveryAnchorPayload,
  StreamRecoveryAnchorSelectedPayload,
  StreamRecoveryBlockedPayload,
  StreamRecoveryRetryStartedPayload,
  StreamRecoveryStartedPayload,
  StreamRecoveryTailDiscardedPayload,
  StreamingToolLedgerPayload,
} from "./stream-recovery.events.js";

// Re-export for convenience
export type { CollaborationMode, RiskLevel } from "../interfaces/session.port.js";

// Re-export ModelToolCall as ToolCall for core usage
export type { ModelToolCall as ToolCall } from "../model/index.js";

// Base Event
export interface SessionEvent {
  id: EventId;
  sessionId: SessionId;
  turnId?: TurnId;
  type: SessionEventType;
  timestamp: Date;
  traceId: TraceId;
  sequenceNumber: number;
  payload: unknown;
}

export const SessionEventType = {
  SessionCreated: "session_created",
  SessionResumed: "session_resumed",
  SessionForked: "session_forked",
  SessionCompacted: "session_compacted",
  SessionTitleUpdated: "session_title_updated",
  SessionModeChanged: "session_mode_changed",
  SessionEnded: "session_ended",
  TurnStarted: "turn_started",
  TurnInputReceived: "turn_input_received",
  TurnSteerQueued: "turn_steer_queued",
  // When the guide closes without encountering an available tool batch, the original intent is redirected to the normal queue.
  TurnSteerDeliveryChanged: "turn_steer_delivery_changed",
  // sendQueuedNow Atomic promotion: reservation/promoting/rollback all enter the event stream, and projection is not guessed locally.
  TurnSteerDispatchChanged: "turn_steer_dispatch_changed",
  TurnSteerDrained: "turn_steer_drained",
  TurnSteerRejected: "turn_steer_rejected",
  TurnSteerDiscarded: "turn_steer_discarded",
  // session_input and user message/parts have been promoted in the same transaction; CommandInbox can safely unpin.
  SessionInputPromoted: "session_input_promoted",
  // v4 queue rearrangement: queue item order changes (reducer rearranges queue rows according to orderedPendingInputIds).
  TurnSteerReordered: "turn_steer_reordered",
  // v4 input control: queue autoDrain switch (held grant bit derived from heldQueueInputRequiresChoice).
  QueueAutoDrainChanged: "queue_auto_drain_changed",
  // v4 input control: followup routing mode (enqueue vs guide when running).
  FollowupModeChanged: "followup_mode_changed",
  TurnComplete: "turn_complete",
  TurnError: "turn_error",
  UserMessage: "user_message",
  AssistantMessage: "assistant_message",
  AssistantFeedbackUpdated: "assistant_feedback_updated",
  SystemMessage: "system_message",
  ModelRequest: "model_request",
  ModelSelected: "model_selected",
  ModelStreaming: "model_streaming",
  StreamingToolLedgerUpdated: "streaming_tool_ledger_updated",
  StreamRecoveryAnchorCreated: "stream_recovery_anchor_created",
  StreamRecoveryStarted: "stream_recovery_started",
  StreamRecoveryAnchorSelected: "stream_recovery_anchor_selected",
  StreamRecoveryTailDiscarded: "stream_recovery_tail_discarded",
  StreamRecoveryRetryStarted: "stream_recovery_retry_started",
  StreamRecoveryBlocked: "stream_recovery_blocked",
  ModelNetworkStatus: "model_network_status",
  ModelAnomalyWarning: "model_anomaly_warning",
  NetworkRequestStatus: "network_request_status",
  ModelComplete: "model_complete",
  ModelError: "model_error",
  ToolCallScheduled: "tool_call_scheduled",
  ToolCallStarted: "tool_call_started",
  ToolCallProgress: "tool_call_progress",
  ToolCallResult: "tool_call_result",
  ToolCallError: "tool_call_error",
  ToolBatchComplete: "tool_batch_complete",
  BackgroundTaskStarted: "background_task_started",
  BackgroundTaskUpdated: "background_task_updated",
  BackgroundTaskCompleted: "background_task_completed",
  // Real-time progress of workflow run: one engine RunEvent and one event, appended to **parent session** (run itself has no session).
  // The v4 side is reduced to the workflowRuns state key; the v3 side is stripped in shouldExposeSessionEventToProtocol.
  // The script run event of the legacy `Workflow` tool is deliberately named with dynamic_:legacy (workflow_started/
  // workflow_completed, script-workflow-runtime.ts) is another set of logs, and the same name can be really confusing.
  DynamicWorkflowRunProgress: "dynamic_workflow_run_progress",
  PermissionRequested: "permission_requested",
  PermissionResolved: "permission_resolved",
  PermissionDenied: "permission_denied",
  UserInputAutoResolutionUpdated: "user_input_auto_resolution_updated",
  WorkspaceHookReviewRequested: "workspace_hook_review_requested",
  WorkspaceHookReviewSettled: "workspace_hook_review_settled",
  WorkspaceHookReviewSuperseded: "workspace_hook_review_superseded",
  // Soft access control: emitted when the access status changes. When pendingCount=0, the projection layer clears the snapshot field.
  WorkspaceHookAdmissionUpdated: "workspace_hook_admission_updated",
  HookRunStarted: "hook_run_started",
  HookRunProgress: "hook_run_progress",
  HookRunCompleted: "hook_run_completed",
  HookRunFailed: "hook_run_failed",
  HookRunBlocked: "hook_run_blocked",
  CompactStarted: "compact_started",
  CompactCompleted: "compact_completed",
  CompactFailed: "compact_failed",
  CompactBoundary: "compact_boundary",
  MicrocompactBoundary: "microcompact_boundary",
  RewindTriggered: "rewind_triggered",
  CheckpointCreated: "checkpoint_created",
  TargetChanged: "target_changed",
  TargetCompletionVerification: "target_completion_verification",
  SubagentSpawned: "subagent_spawned",
  SubagentMessage: "subagent_message",
  SubagentStopped: "subagent_stopped",
  Interrupt: "interrupt",
  Cancel: "cancel",
  Resume: "resume",
  Error: "error",
} as const;

export type SessionEventType = (typeof SessionEventType)[keyof typeof SessionEventType];

// -----------------------------------------------
// Event Payloads
// -----------------------------------------------

export interface SessionCreatedPayload {
  planEnabled?: boolean;
  mode: CollaborationMode;
  contextWindow: number;
}

export interface SessionResumedPayload {
  directory: string;
  interruptedToolCount: number;
  messageCount: number;
  partCount: number;
  recoveredCompactTimelineCount?: number;
  recoveredSteerInputCount?: number;
  resumedTodoCount?: number;
}

export interface SessionForkedPayload {
  forkedSessionId?: SessionId;
  originalSessionId: SessionId;
  restoredFileCount?: number;
  restoredSnapshotRef?: string;
  strategy?: "fork_required";
  targetCheckpointId?: string;
  targetMessageId?: MessageId;
  /** @deprecated Use targetMessageId for message-level forks. */
  forkPoint: number;
}

export interface SessionCompactedPayload {
  compactBoundary: CompactBoundaryPayload;
  summary?: string;
  preservedEventCount?: number;
  removedEventCount?: number;
}

export type CompactLifecyclePayload = CompactTimelinePayload;

export type MicrocompactBoundaryEventPayload = MicrocompactBoundaryPayload;

/**
 * Attachment rendering (additive): lightweight display metadata for user input attachments, delivered along
 * with TurnStarted, from which the v4 projection fills the attachments of the userInput row.
 * It carries only the fields needed for display, not the content itself (the content travels as
 * FilePart/artifact through resolve/persist).
 */
export interface TurnAttachmentMeta {
  fileName: string;
  mime: string;
  bytes: number;
  /** Content reference (local path / artifact URI); absent for data URLs and other content with no stable reference. */
  ref?: string;
}

/**
 * The structured payload of a workflow notification.
 * Minted on the emitting side and bounded (summary≤500 / result≤4000 / error≤2000 / reports.preview ≤500 each,
 * ≤8 entries /
 * artifacts ≤8 entries, title≤120 / question·context≤4000); kept manually in sync with the shared
 * workflowNotificationMetaSchema.
 * Batch notification turns deliberately do not carry it: the one-manifest-per-turn correspondence does not hold
 * for batches.
 */
export type WorkflowNotificationMeta =
  | {
      kind: "terminal";
      status: "completed" | "errored" | "stopped";
      /** Present only when `status === "stopped"`. */
      stopReason?: "user" | "model" | "provider" | "interrupted" | "superseded";
      summary: string;
      result?: string;
      resultForm?: "prose" | "json";
      resultTruncated?: true;
      error?: string;
      reports?: { count: number; shown: number; preview: string[] };
      /**
       * The chips payload of user-facing artifacts: ≤ 8 entries,
       * with `artifactsTruncated` set when there are more (including those filtered out by kind).
       *
       * ⚠ Terminology: an artifact here is an output that a script publishes for the user through
       * `artifact.*`, which is a different thing from the `result` on the same payload (the script's top-level
       * return value, also called an artifact inside the engine).
       */
      artifacts?: {
        id: string;
        kind: "file" | "markdown" | "chart" | "table" | "metrics" | "board";
        title?: string;
        version: number;
        contentType?: string;
        /** The deliverable of the run; the manifest leads with it. Only it carries a `description` (the deliverable row of the completion card reads it out). */
        primary?: true;
        description?: string;
      }[];
      artifactsTruncated?: true;
      durationMs?: number;
    }
  | {
      kind: "escalation";
      qid: string;
      actor: string;
      question: string;
      context?: string;
      askedAt?: number;
    }
  /** Run-level stall: one per stall segment, not a terminal state. */
  | {
      kind: "stall";
      sinceMs: number;
      reason?: string;
      cap?: number;
    };

/** Display metadata for a standalone background result turn; a batch turn may reuse a representative task identity and synthesize a title instead of parsing it back out of the notification text. */
export interface BackgroundResultOriginMeta {
  /** `workflow` is a dynamic-workflow run (workId ≡ runId), reusing the entire background notification pipeline. */
  backgroundSource: "bash" | "subagent" | "workflow";
  workId: string;
  title: string;
  /** Present only on a single-entry notification turn whose backgroundSource === "workflow"; the only data source for manifest rendering. */
  workflowNotification?: WorkflowNotificationMeta;
}

/**
 * Whether the turn carries real Agent execution. controlOnly only establishes a timeline boundary for a
 * visible control input;
 * it must not advance session running/activeWorks, nor should it produce a "working / has worked" state.
 */
export type TurnExecutionKind = "agent" | "controlOnly";

export type OffPeakRunType = "init" | "resume";

export type TurnBackgroundAttribution =
  | { automationId: string; offPeakTaskId?: never; offPeakRunType?: never }
  | {
      offPeakTaskId: string;
      offPeakRunType?: OffPeakRunType;
      automationId?: never;
    }
  | {
      automationId?: undefined;
      offPeakTaskId?: undefined;
      offPeakRunType?: never;
    };

/**
 * Launch-turn metadata for a saved workflow started directly from the hub. The same copy is written both into
 * the `metadata` of the user message (the cold recovery source) and into the `TurnStarted`
 * payload (the live projection source): identical on both paths, so the projection draws the launch card from
 * it instead of rendering text.
 */
/** On launch metadata, display only allows the create_workflow projection (shaped like the shared row schema). */
export type WorkflowLaunchDisplay = Extract<ToolResultDisplayPayload, { kind: "create_workflow" }>;

/**
 * The "what changed" of a settings turn: only the settings that changed are present,
 * and for each entry a missing from / to means that side is the default (model = the session model, ceiling =
 * the local ceiling). `ceiling` is the local ceiling,
 * which is what makes readings like "13 -> 4" possible. Shaped like the shared
 * `workflowSettingsAmendMetaSchema`.
 */
export interface WorkflowSettingsAmendMeta {
  /**
   * The run that this adjustment replaced (or that carries on running). **Absent means it took effect in
   * place**: when only the concurrency ceiling is changed and the run is still in flight, that "configure"
   * neither stops this run nor starts another one, so there is no predecessor to point at: `runId` refers to
   * the run being adjusted itself.
   * Shaped like the shared `workflowSettingsAmendMetaSchema`.
   */
  predecessorRunId?: string;
  subagentModel?: { from?: string; to?: string };
  maxConcurrency?: { from?: number; to?: number };
  ceiling?: number;
}

export interface WorkflowLaunchMeta {
  /** The identity of the run (≡ backgroundTaskId ≡ the workId of cancelBackgroundWork). */
  runId: string;
  /**
   * The synthetic toolCall id that started this run (the hub uses `launch-<uuid>`, a settings turn uses
   * `settings-<uuid>`; the tool card -> detail page linking key).
   */
  toolCallId: string;
  /**
   * The workflow name (the resolved result, not something a user/model can override); both the launch card
   * title and the session title take it. A hub launch always carries it; a settings turn takes the name of
   * the adjusted run itself, and an unnamed run means it is absent (the UI switches to a fallback word
   * rather than using the run id as the title).
   */
  name?: string;
  /** The actually resolved scope (not the scope that may be absent in the request). Hub launches only: a settings turn has no saved file to point at. */
  scope?: SavedWorkflowScope;
  /** Where the saved file lives, used for details/diagnostics; it does not participate in execution. Hub launches only. */
  path?: string;
  /** The arguments of this run (already validated against the declaration and backfilled with defaults); see {@link boundWorkflowLaunchMeta} for the bound. */
  args?: Record<string, unknown>;
  /** The workflow description (the description in the saved metadata), bounded to ≤ 500 characters. */
  description?: string;
  /**
   * The `create_workflow` result display produced by the pre-launch compile (a bounded causal graph +
   * diagnostics), the same projection and the same constructor as the `display` of the CreateWorkflow tool
   * row. The run detail side panel looks up the "originating row" by toolCallId to get the graph: a direct
   * launch has no tool row, so the graph comes from here.
   */
  display?: WorkflowLaunchDisplay;
  /**
   * The verbatim script this run actually executed (the same copy as `port.submit.scriptText`). The tool path
   * puts it on the tool input
   * `input.script` for the side panel's Script section to read; this is the launch-turn landing spot for the
   * same fact. See {@link WORKFLOW_LAUNCH_SCRIPT_MAX_CHARS} for the bound (over the bound it is absent as a
   * whole, and the side panel's Script section is absent with it).
   */
  script?: string;
  /** Settings turns only: which run this one was amended from via "configure", and what changed. */
  amend?: WorkflowSettingsAmendMeta;
}

/** The upper bound in bytes of the JSON serialization of {@link WorkflowLaunchMeta.args}. Over the bound it is dropped and replaced by a marker key. */
export const WORKFLOW_LAUNCH_ARGS_MAX_BYTES = 4_096;
/** The character upper bound of {@link WorkflowLaunchMeta.description}. */
export const WORKFLOW_LAUNCH_DESCRIPTION_MAX_CHARS = 500;
/**
 * The character upper bound of {@link WorkflowLaunchMeta.script}. The tool path's `input.script` already enters
 * the transcript with no bound at all, so here we pick a limit far above any reasonable dwf script that still
 * stops an entire repository from being stuffed in by mistake; over the bound it is absent as a whole rather
 * than truncated (half a script is meaningless in the Script section, and the graph stays in display anyway).
 */
export const WORKFLOW_LAUNCH_SCRIPT_MAX_CHARS = 256_000;
/**
 * The stand-in key used when args exceed the bound. Real arguments always travel as the model-facing canonical
 * sentence (that copy is not truncated); this metadata only feeds the launch card;
 * an argument bag as large as 4KB cannot be shown on the card in the first place, so it is replaced wholesale
 * with a single readable marker instead of being forced in. The ellipsis is used as the key: it falls outside
 * `SAVED_WORKFLOW_NAME_PATTERN` and therefore cannot collide with a real argument name.
 */
export const WORKFLOW_LAUNCH_ARGS_TRUNCATED_KEY = "…";

/**
 * Folds the launch-turn metadata into the bounds. If the serialized args exceed
 * {@link WORKFLOW_LAUNCH_ARGS_MAX_BYTES} they are replaced wholesale with the
 * `{ "…": "arguments omitted (N bytes)" }` marker (see {@link WORKFLOW_LAUNCH_ARGS_TRUNCATED_KEY});
 * a description over {@link WORKFLOW_LAUNCH_DESCRIPTION_MAX_CHARS} is truncated with an ellipsis. The minting
 * side calls this in place, so the message metadata and the TurnStarted payload receive the same bounded
 * value.
 */
export function boundWorkflowLaunchMeta(input: WorkflowLaunchMeta): WorkflowLaunchMeta {
  const bounded: WorkflowLaunchMeta = {
    runId: input.runId,
    toolCallId: input.toolCallId,
    ...(input.name === undefined ? {} : { name: input.name }),
    ...(input.scope === undefined ? {} : { scope: input.scope }),
    ...(input.path === undefined ? {} : { path: input.path }),
  };
  if (input.args !== undefined) {
    const serialized = JSON.stringify(input.args);
    const bytes = serialized === undefined ? 0 : Buffer.byteLength(serialized, "utf8");
    bounded.args =
      bytes > WORKFLOW_LAUNCH_ARGS_MAX_BYTES
        ? { [WORKFLOW_LAUNCH_ARGS_TRUNCATED_KEY]: `arguments omitted (${bytes} bytes)` }
        : input.args;
  }
  if (input.description !== undefined) {
    bounded.description =
      input.description.length > WORKFLOW_LAUNCH_DESCRIPTION_MAX_CHARS
        ? `${input.description.slice(0, WORKFLOW_LAUNCH_DESCRIPTION_MAX_CHARS - 1)}…`
        : input.description;
  }
  // The display has been limited in length at the construction location (createCreateWorkflowDisplay + boundCausalityGraph) and is transparently transmitted as it is.
  if (input.display !== undefined) bounded.display = input.display;
  if (input.script !== undefined && input.script.length <= WORKFLOW_LAUNCH_SCRIPT_MAX_CHARS) {
    bounded.script = input.script;
  }
  // The amend block itself is bounded (the two model strings are taken from the parsed canonical form by the caller, with the same upper bound as the run state).
  if (input.amend !== undefined) bounded.amend = input.amend;
  return bounded;
}

export interface TurnStartedPayloadBase {
  /** Monotonic epoch milliseconds at the execution entry; hooks/persistence happen before TurnStarted is published, so execution start cannot be back-inferred from the publish time. */
  executionStartedAt?: number;
  turnNumber: number;
  input: string;
  /**
   * The v4 file summary issues its query by turn rowId, but the workspace checkpoint uses the user messageId
   * as its recovery anchor; TurnStarted must carry that same persisted id, so the projection can look the
   * userInput row back up to the corresponding checkpoint.
   */
  messageId?: MessageId;
  inputId?: string;
  /** Passed through by admission only, to a bodyless telemetry fact; it cannot be back-inferred from session ownership. */
  /** A stable cancel identity that, within one runtime command, covers primary turn -> goal verify/continue. */
  foregroundExecutionId?: string;
  queryId?: QueryId;
  inputSource?: SyntheticUserMessageSource;
  inputVisibility?: MessageVisibility;
  /**
   * Launch-turn metadata for a saved workflow started directly from the hub (present when
   * `inputSource === "workflow_launch"`). The live projection draws the launch card from it; it is aligned
   * with the same copy in the message metadata (identical on the cold and hot paths).
   */
  workflowLaunch?: WorkflowLaunchMeta;
  /** Defaults to agent, for compatibility with old events and historical transcripts. */
  executionKind?: TurnExecutionKind;
  /**
   * From this index onward `input` is engine-attached text (a dwf ask tail note / nudge), which the GUI
   * folds into the disclosure; 0 = the whole thing is; absent = none. Aligned with the same copy in the
   * message metadata (identical on the cold and hot paths).
   */
  epilogueStart?: number;
  /** The structured source of an idle background wake; an active-loop convergence does not create its own TurnStarted. */
  originMeta?: BackgroundResultOriginMeta;
  /** Passed through only when every member of a background notification batch shares one source; a mixed source stays empty. */
  backgroundSource?: BackgroundResultOriginMeta["backgroundSource"];
  targetId?: string;
  /** The attachment metadata of this turn's user input (absent when there are no attachments). */
  attachments?: TurnAttachmentMeta[];
  /** CLI admission metadata; inputId continues to serve as the sourceCommandId compatibility anchor. */
  intent?: TurnInputIntentMetadata;
}

export type TurnStartedPayload = TurnStartedPayloadBase & TurnBackgroundAttribution;

export interface TurnInputReceivedPayload {
  input: string;
  attachments?: Attachment[];
}

export interface TurnSteerQueuedPayload {
  pendingInputId: string;
  inputId?: string;
  queryId?: QueryId;
  input: string;
  inputPreview: string;
  inputSize: number;
  commandKind?: TurnSteerCommandKind;
  source?: TurnSteerSource;
  inputPresentation?: RuntimeInputPresentation;
  /** The tool name not exposed to the provider while the currently queued input is consumed. */
  toolDisallowlist?: readonly string[];
  /** Delivery semantics: queue = a new product turn starts when it is consumed; guide = inlined into the current turn. */
  delivery?: TurnSteerDeliveryMode;
  targetTurnId: TurnId;
  queueLength: number;
  intent?: TurnInputIntentMetadata;
}

export interface TurnSteerDeliveryChangedPayload {
  pendingInputId: string;
  targetTurnId: TurnId;
  requestedDelivery: "guide";
  admittedDelivery: "queue";
  fallbackReasonCode: string;
  /** The full intent after re-delivery; the reducer / cold replay never guesses delivery from side state. */
  intent?: TurnInputIntentMetadata;
}

export interface TurnSteerReorderedPayload {
  orderedPendingInputIds: string[];
  targetTurnId: TurnId;
}

export interface TurnSteerDispatchChangedPayload {
  pendingInputId: string;
  reservationId?: string;
  state: "queued" | "reserved" | "promoting";
  targetTurnId: TurnId;
}

export interface QueueAutoDrainChangedPayload {
  autoDrain: boolean;
}

export interface FollowupModeChangedPayload {
  mode: "queue" | "guide";
}

export interface TurnSteerDrainedPayload {
  pendingInputIds: string[];
  queryIds?: QueryId[];
  targetTurnId: TurnId;
  injectedMessageIds: MessageId[];
  /**
   * The drain fact carries its own text and persistent messageId, so the projection no longer depends on
   * in-memory queue state for the text (failing to find a queue item silently dropped the user row).
   * delivery decides the turn-splitting semantics; the default is queue (one turn per entry).
   */
  drainedInputs?: Array<{
    pendingInputId: string;
    messageId: MessageId;
    text: string;
    delivery?: TurnSteerDeliveryMode;
    intent?: TurnInputIntentMetadata;
    toolDisallowlist?: readonly string[];
  }>;
}

export interface TurnSteerRejectedPayload {
  reason: TurnSteerRejectReason;
  activeTurnId?: TurnId;
  expectedTurnId?: TurnId;
  inputPreview?: string;
  inputSize?: number;
}

export interface TurnSteerDiscardedPayload {
  pendingInputIds: string[];
  targetTurnId: TurnId;
  // user_removed (v4 queue single item deletion): The user explicitly removes an item from the queue, which is different from the turn life cycle discard.
  // promoted: sendQueuedNow has obtained execution rights and is only removed from the queue projection; session_input must continue
  // Remain admitted until user message is atomically promoted (or discarded after reboot).
  reason: "turn_cancelled" | "turn_failed" | "session_resumed" | "user_removed" | "promoted";
}

export interface SessionInputPromotedPayload {
  pendingInputId: string;
  sourceCommandId: string;
  messageId: MessageId;
}

export interface TurnCompletePayload {
  response: string;
  tokenCount: number;
  usage?: ModelUsageSummary;
  toolCallCount: number;
  /** The number of model artifacts of the current query that have been successfully committed to the provider-visible persistent history. */
  historyRoundCount?: number;
  duration: number;
  inputId?: string;
  resultType: TurnResultType;
  /** Whether the current turn consumed a background result notification whose source is a subagent. */
  backgroundSubagentResultConsumed?: boolean;
  /** Whether the current turn consumed a background notification whose source is a workflow (a dynamic-workflow run). */
  workflowResultConsumed?: boolean;
  /** An internal preemption (such as sendQueuedNow) only terminates the current turn; it is not equivalent to the user manually stopping the queue. */
  preserveQueueAutoDrainOnCancel?: boolean;
}

export interface TurnErrorPayload {
  error: ErrorPayload;
  turnPhase: string;
  inputId?: string;
  /** Whether the current turn consumed a background result notification whose source is a subagent. */
  backgroundSubagentResultConsumed?: boolean;
  /** Whether the current turn consumed a background notification whose source is a workflow (a dynamic-workflow run). */
  workflowResultConsumed?: boolean;
}

export type TurnResultType =
  | "success"
  // "cancelled": User-initiated interruption (TurnCancelled) is a normal end, and TurnComplete is used to report instead of TurnError.
  | "cancelled"
  | "error_max_turns"
  | "error_max_budget"
  | "error_during_execution"
  | "error_max_tool_calls";

export interface UserMessagePayload {
  content: string;
  attachments?: Attachment[];
}

export interface AssistantMessagePayload {
  content: string;
  toolCalls?: ToolCallPayload[];
}

export interface AssistantFeedbackUpdatedPayload {
  entityId: string;
  feedback: "like" | "dislike" | null;
}

export interface SystemMessagePayload {
  type: "init" | "compact_boundary" | "interrupted";
  content: string;
  compactBoundary?: CompactBoundaryPayload;
}

export interface SessionTitleUpdatedPayload {
  messageID?: MessageId;
  previousTitle: string;
  source: SessionTitleSource;
  title: string;
}

export interface SessionModeChangedPayload {
  permissionGrant?: { interactionId: string; queueItemIds: string[] };
  planEnabled?: boolean;
  previousPlanEnabled?: boolean;
  mode: CollaborationMode;
  previousMode: CollaborationMode;
  source: "tool" | "command" | "system";
  toolCallId?: ToolCallId;
}

export type TargetCompletionVerificationStatus =
  | "started"
  | "completed"
  | "failed_closed"
  | "cancelled";

export interface TargetCompletionVerificationPayload {
  targetId: string;
  status: TargetCompletionVerificationStatus;
  verificationId: string;
  /** Shared with the foreground runtime command that triggered this verification, for Stop to use as a stale guard. */
  foregroundExecutionId?: string;
  /** When sendQueuedNow preempts the verifier it pauses only the goal, not the future queue. */
  preserveQueueAutoDrainOnCancel?: boolean;
  verification?: GoalCompletionVerificationOutput;
  goalIteration?: number;
  anchorAssistantMessageId?: MessageId;
  anchorTurnId?: TurnId;
}

export interface ModelRequestPayload {
  messages: ModelMessage[];
  providerId: string;
  modelId: string;
  querySource?: string;
  temperature?: number;
  maxTokens?: number;
}

export type ModelSelectionOrigin = "registryFallback";

export interface ModelSelectedPayload {
  modelSelection: ModelSelection;
  /** The reasoning resolved by the Active Model, solely for execution facts / display projection; it is not part of the sparse Selection. */
  effectiveReasoningLevel?: string;
  /** Missing means only the current selection is updated; null means an explicit ∅->selection model boundary. */
  previousModelSelection?: ModelSelection | null;
  /** Carried only when the Agent automatically restores a model; missing means a normal selection or an old event. */
  origin?: ModelSelectionOrigin;
  /** The thinking-tier capability of the current selection; published atomically together with the model selection in the same event. */
  supportedThoughtLevels?: string[];
  /** The context window actually applied by the runtime for the current selection; null means explicitly cleared, while an absent field stays compatible with old events. */
  contextWindow?: number | null;
}

export type ModelStreamingKind =
  | "start"
  | "text_start"
  | "text_delta"
  | "text_end"
  | "reasoning_start"
  | "reasoning_delta"
  | "reasoning_end"
  | "tool_input_start"
  | "tool_input_delta"
  | "tool_input_end"
  | "tool_call"
  | "finish"
  | "error";

export interface ModelStreamingPayload {
  delta: string;
  done: boolean;
  kind?: ModelStreamingKind;
  assistantMessageId?: MessageId;
  partId?: PartId;
  toolCallId?: ToolCallId;
  toolName?: string;
  input?: unknown;
  providerExecuted?: boolean;
}

export type ModelNetworkStatusPayload = ModelNetworkStatusEvent;

export type ModelAnomalyWarningCategory =
  | "tool_call_budget"
  | "repeated_tool_call"
  | "provider_finish_mismatch"
  | "malformed_tool_call";

export type ModelAnomalyWarningSeverity = "info" | "warning";

export interface ModelAnomalyWarningPayload {
  category: ModelAnomalyWarningCategory;
  severity: ModelAnomalyWarningSeverity;
  observedCount?: number;
  threshold?: number;
  toolName?: string;
  toolCallId?: ToolCallId;
  warningInjected: boolean;
  modelVisibleMessageId?: MessageId;
}

export type NetworkRequestSource = "http_client" | "model" | "tool" | "mcp" | "plugin" | "unknown";

export type NetworkRequestLifecycleStatus = "pending" | "complete" | "error";

export interface NetworkRequestStatusPayload {
  requestId: string;
  source: NetworkRequestSource;
  status: NetworkRequestLifecycleStatus;
  method: string;
  url: string;
  startedAt: string;
  completedAt?: string;
  durationMs?: number;
  statusCode?: number;
  error?: string;
  toolCallId?: ToolCallId | string;
  toolName?: string;
  attempt?: number;
  egress?: HttpClientEgressInfo;
}

export interface ModelCompletePayload {
  cacheHit?: {
    inputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    latestHitRate: number | null;
    hitRate: number | null;
    hitRateRequestCount: number;
    totalInputTokens: number;
    totalCacheReadTokens: number;
    totalCacheWriteTokens: number;
  };
  content: string;
  contextUsageBreakdown?: ContextUsageBreakdownItem[];
  contextWindow?: number;
  fileChanges?: TurnFileChangeSummary;
  querySource?: string;
  stopReason: string;
  /** The number of complete tool calls assembled in the current model request; old events may be missing it. */
  toolCallCount?: number;
  usage: TokenUsage | ModelUsage;
}

export interface TurnFileChangeSummary {
  additions: number;
  deletions: number;
  files: number;
  items: TurnFileChangeSummaryItem[];
}

export interface TurnFileChangeSummaryItem {
  additions: number;
  deletions: number;
  path: string;
  toolNames?: string[];
  writeCount: number;
}

export type ContextUsageBreakdownSource =
  | "system_prompt"
  | "meta_user_context"
  | "skills"
  | "tool_prompt"
  | "system_tool_schemas"
  | "mcp_tool_schemas"
  | "messages";

export interface ContextUsageBreakdownItem {
  source: ContextUsageBreakdownSource;
  chars: number;
}

export interface ModelErrorPayload {
  error: ErrorPayload;
  retryable: boolean;
}

export interface ToolCallScheduledPayload {
  toolCallId: ToolCallId;
  assistantMessageId?: MessageId;
  toolName: string;
  input: unknown;
  dependencies?: ToolCallId[];
  parallelGroupIndex?: number;
  canRunParallel?: boolean;
  display?: ToolResultDisplayPayload;
  schedule: ToolSchedulePayload;
}

export interface ToolCallStartedPayload {
  toolCallId: ToolCallId;
  toolName?: string;
  startedAt: Date;
  display?: ToolResultDisplayPayload;
  /**
   * The side-effect capability of this call **after resolution** (tool metadata plus runtime capabilities
   * resolved from the arguments, such as Bash's read-only command determination). The event is emitted
   * before the handler acts, so subscribers learn "a write is coming" before the first byte hits disk:
   * dynamic-workflow's driver uses it to close the amend-resume import cache
   * (`isWorkspaceMutatingToolCall`). Optional: events predating this field do not have it.
   */
  readOnly?: boolean;
  sideEffectScope?: ToolSideEffectScope;
}

export interface ToolCallProgressPayload {
  toolCallId: ToolCallId;
  toolName?: string;
  elapsedMs?: number;
  pid?: number;
  stdoutBytes?: number;
  stderrBytes?: number;
  outputBytes?: number;
  outputPreview?: ExecutionOutputPreview;
  stdoutTail?: string;
  stderrTail?: string;
}

export interface ToolCallResultPayload {
  toolCallId: ToolCallId;
  result: ToolResultPayload;
  duration: number;
  /** Skill metadata is used only for telemetry and does not enter the model-visible result.content. */
  skillMetadata?: SkillTelemetryMetadata;
}

export interface ToolCallErrorPayload {
  toolCallId: ToolCallId;
  error: ErrorPayload;
  /** Skill metadata is used only for telemetry and does not enter the model-visible error body. */
  skillMetadata?: SkillTelemetryMetadata;
}

export interface ToolBatchCompletePayload {
  toolCallIds: ToolCallId[];
  successCount: number;
  errorCount: number;
}

export type BackgroundTaskStatus =
  | "running"
  | "completed"
  | "failed"
  | "timed_out"
  | "cancelled"
  | "spawn_error"
  | "lost";

export interface BackgroundTaskPayloadBase {
  taskId: string;
  toolCallId?: ToolCallId | string;
  toolName?: string;
  // "workflow" = workflow run(CreateWorkflow). The behavior of the tracker has been changed per-tool lifecycleProvider
  // Assignment, taskKind only determines panel grouping and icons, so widening is a pure display modification and does not change any life cycle semantics.
  taskKind?: "bash" | "subagent" | "workflow";
  childSessionId?: SessionId | string;
  blocked?: boolean;
  blockedReason?: "interactive_prompt_detected" | "no_output_progress" | string;
  cancellable?: boolean;
  cancelRequestedAt?: Date;
  command?: string;
  description?: string;
  status: BackgroundTaskStatus;
  pid?: number;
  startedAt?: Date;
  completedAt?: Date;
  outputPath?: string;
  stderrPersistedOutputPath?: string;
  stdoutPersistedOutputPath?: string;
  outputBytes?: number;
  outputTruncated?: boolean;
  outputTail?: string;
  stderrBytes?: number;
  stderrTail?: string;
  stdoutBytes?: number;
  stdoutTail?: string;
  terminalId?: string;
}

export type BackgroundTaskStartedPayload = BackgroundTaskPayloadBase & {
  status: "running";
};

export type BackgroundTaskUpdatedPayload = BackgroundTaskPayloadBase;

export type BackgroundTaskCompletedPayload = BackgroundTaskPayloadBase & {
  status: Exclude<BackgroundTaskStatus, "running">;
};

/**
 * A workflow run progress event (in the parent session). Its fields are shaped like
 * {@link DynamicWorkflowRunEvent}:
 * **serialized once, two consumers**: the event page of `listEvents` and the session event here use the same
 * bounded payload, so the read side needs no second set of interpretation rules. `type` is already taken by
 * the session event envelope, hence the engine event kind is called `eventType`.
 */
export interface DynamicWorkflowRunProgressPayload {
  runId: string;
  /** The CreateWorkflow tool call that started this run (the tool card -> detail page linking key). */
  toolCallId?: ToolCallId | string;
  /** The journal sequence (monotonically assigned by `appendEvent`); the event log's cursor uses the same ruler. */
  sequence: number;
  /** The engine event kind: run-started / actor-created / node-* / usage-updated / log / report / phase-entered / run-settled. */
  eventType: string;
  payload: Record<string, unknown>;
  truncated?: boolean;
  /** Derived field (toProgressPayload): on `actor-created`, the id of that subagent session (the `sess_dwf-…` minted by the driver). */
  actorSessionId?: string;
  /**
   * Derived field (same kind as `actorSessionId`, see toProgressPayload): the `run-launched.inputId` of that
   * run. It hangs only on the two `actor-created` / `run-settled` events, so downstream can attribute a
   * subagent to the turn that started the run. Runs from before the upgrade have no `run-launched`, and the
   * field is absent.
   */
  launchInputId?: string;
}

export interface PermissionRequestedPayload {
  requestId?: string;
  toolCallId: ToolCallId;
  toolName: string;
  riskLevel: RiskLevel;
  reason: string;
  input: unknown;
  suggestedPermissionUpdates?: PermissionUpdate[];
  origin?: InteractionRequestOrigin;
  /**
   * The confirmation preview the tool reports for itself, produced by the `prepareApproval` hook. It reuses
   * the result channel's display projection, so the ask and the result card share one bounded shape, without
   * adding an unbounded field.
   */
  display?: ToolResultDisplayPayload;
  fullAccessSupported?: boolean;
  optionsPolicy?: PermissionOptionsPolicy;
}

export interface PermissionResolvedPayload {
  requestId?: string;
  toolCallId: ToolCallId;
  decision: PermissionDecision;
  reason?: string;
  modifiedInput?: unknown;
}

export interface PermissionDeniedPayload {
  toolCallId: ToolCallId;
  toolName: string;
  reason: string;
  inputSummary?: unknown;
}

export type UserInputAutoResolutionState =
  | {
      state: "hiddenGrace" | "visibleCountdown";
      startedAt: number;
      visibleAt: number;
      deadlineAt: number;
    }
  | {
      state: "snoozed";
      startedAt: number;
      snoozedAt: number;
    };

export interface UserInputAutoResolutionUpdatedPayload {
  interactionId: string;
  toolCallId: ToolCallId;
  autoResolution: UserInputAutoResolutionState;
}

export interface WorkspaceHookReviewRequestedPayload {
  request: unknown;
}

export interface WorkspaceHookReviewSettledPayload {
  interactionId: string;
  state: "resolved" | "timed_out" | "configuration_error";
  reasonCode?: string;
}

export interface WorkspaceHookReviewSupersededPayload {
  interactionId: string;
  supersededByInteractionId: string;
}

// Soft access control: After the access layer completes the evaluation, the pending status is reported.
// pendingCount = configuredEnabled && admissionClass === "pending" number of claims;
// pendingCount === 0 → The projection layer sets snapshot.workspaceHookAdmission to null (the prompt bar disappears).
export interface WorkspaceHookAdmissionUpdatedPayload {
  pendingCount: number;
  bundleDigest: string;
  workspaceIdentity?: string;
}

export type PermissionDecision = "allow" | "deny" | "escalate" | "modify";

export type TargetChangedAction =
  | "set"
  | "status_updated"
  | "cleared"
  | "usage_accounted"
  | "run_started"
  | "run_finished"
  | "summary_updated";

export type TargetChangedSource = "command" | "tool" | "runtime";

export interface TargetChangedPayload {
  action: TargetChangedAction;
  source: TargetChangedSource;
  target: SessionGoal | null;
  previousTarget?: SessionGoal | null;
}

// -----------------------------------------------
// Supporting Types
// -----------------------------------------------

export interface Attachment {
  type: "file" | "image" | "pdf" | "url";
  path?: string;
  content?: string;
  mimeType?: string;
}

export interface ModelMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  toolCalls?: ToolCallPayload[];
  toolCallId?: string;
}

export interface ToolCallPayload {
  id: ToolCallId;
  name: string;
  input: unknown;
}

export interface ToolResultPayload {
  success: boolean;
  content: string;
  display?: ToolResultDisplayPayload;
  perf?: import("../tools/performance.js").ToolExecutionTelemetry;
  error?: ErrorPayload;
  truncated?: boolean;
  originalBytes?: number;
  returnedBytes?: number;
  budgetStrategy?: string;
  artifactPath?: string;
}

export interface ToolSchedulePayload {
  parallelGroups: ToolCallId[][];
  executionOrder: ToolCallId[];
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cacheTokens?: number;
}

export interface ErrorPayload {
  code?: string;
  detail?: string;
  /** The raw message of the deepest non-wrapper frame in the error chain, for client telemetry to locate the root cause. */
  underlyingErrorMessage?: string;
  /** The detail/errorDetails/details content of the same underlying frame. */
  underlyingErrorDetail?: string;
  type: string;
  message: string;
  attribution?: ErrorAttribution;
  retryable?: boolean;
  stack?: string;
  data?: unknown;
}

/** Carries only aggregable failure facts, never request bodies, credentials, URLs or monitoring policy. */
export interface ErrorAttribution {
  source?: "provider" | "runtime" | "tool" | "network";
  reason?: string;
  errorPhase?: ModelApiErrorPhase;
  exceptionKind?: ModelFailureExceptionKind;
  providerId?: string;
  modelId?: string;
  providerKind?: string;
  transport?: "http" | "sse" | "websocket";
  statusCode?: number;
  providerErrorCode?: string;
  retryable?: boolean;
}

// CollaborationMode and RiskLevel are re-exported from ports

// -----------------------------------------------
// Event Factory
// -----------------------------------------------

export function createSessionEvent<T>(
  type: SessionEventType,
  sessionId: SessionId,
  payload: T,
  options?: {
    turnId?: TurnId;
    traceId?: TraceId;
    sequenceNumber?: number;
  },
): SessionEvent {
  return {
    id: crypto.randomUUID() as EventId,
    sessionId,
    turnId: options?.turnId,
    type,
    timestamp: new Date(),
    traceId: options?.traceId ?? (crypto.randomUUID() as TraceId),
    sequenceNumber: options?.sequenceNumber ?? 0,
    payload,
  };
}

export function createModelUsageSummaryFromEvents(
  events: readonly SessionEvent[],
): ModelUsageSummary | undefined {
  const usages: ModelUsage[] = [];

  for (const event of events) {
    if (event.type !== SessionEventType.ModelComplete) continue;
    const payload = event.payload as Partial<ModelCompletePayload>;
    if (payload.usage) {
      usages.push(payload.usage as ModelUsage);
    }
  }

  return createModelUsageSummary(usages);
}

export type SessionEventPayload =
  | SessionCreatedPayload
  | SessionResumedPayload
  | SessionForkedPayload
  | SessionCompactedPayload
  | SessionTitleUpdatedPayload
  | SessionModeChangedPayload
  | TurnStartedPayload
  | TurnInputReceivedPayload
  | TurnSteerQueuedPayload
  | TurnSteerDeliveryChangedPayload
  | TurnSteerDispatchChangedPayload
  | TurnSteerDrainedPayload
  | TurnSteerReorderedPayload
  | QueueAutoDrainChangedPayload
  | FollowupModeChangedPayload
  | TurnSteerRejectedPayload
  | TurnSteerDiscardedPayload
  | SessionInputPromotedPayload
  | TurnCompletePayload
  | TurnErrorPayload
  | UserMessagePayload
  | AssistantMessagePayload
  | SystemMessagePayload
  | ModelRequestPayload
  | ModelSelectedPayload
  | ModelStreamingPayload
  | StreamingToolLedgerPayload
  | StreamRecoveryAnchorPayload
  | StreamRecoveryStartedPayload
  | StreamRecoveryAnchorSelectedPayload
  | StreamRecoveryTailDiscardedPayload
  | StreamRecoveryRetryStartedPayload
  | StreamRecoveryBlockedPayload
  | ModelNetworkStatusPayload
  | ModelAnomalyWarningPayload
  | NetworkRequestStatusPayload
  | ModelCompletePayload
  | TargetCompletionVerificationPayload
  | ModelErrorPayload
  | ToolCallScheduledPayload
  | ToolCallStartedPayload
  | ToolCallProgressPayload
  | ToolCallResultPayload
  | ToolCallErrorPayload
  | ToolBatchCompletePayload
  | BackgroundTaskStartedPayload
  | BackgroundTaskUpdatedPayload
  | BackgroundTaskCompletedPayload
  | DynamicWorkflowRunProgressPayload
  | PermissionRequestedPayload
  | PermissionResolvedPayload
  | PermissionDeniedPayload
  | UserInputAutoResolutionUpdatedPayload
  | WorkspaceHookReviewRequestedPayload
  | WorkspaceHookReviewSettledPayload
  | WorkspaceHookReviewSupersededPayload
  | WorkspaceHookAdmissionUpdatedPayload
  | HookRunLifecyclePayload
  | CompactLifecyclePayload
  | MicrocompactBoundaryEventPayload
  | CheckpointCreatedPayload
  | RewindTriggeredPayload
  | CompactBoundaryPayload;
