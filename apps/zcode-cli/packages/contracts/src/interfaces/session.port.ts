import type { RuntimeInputPresentation } from "./runtime-input-presentation.js";
// ============================================================
// Session Ports - Core interfaces for session management
// ============================================================

import type { ErrorAttribution, SessionEvent } from "../events/session.events.js";
import type {
  InteractionRequestOrigin,
  MessageId,
  QueryId,
  SessionId,
  TurnId,
  TraceId,
} from "./shared.js";
import type { TraceContext } from "../tracing/tracer.js";
import type { CompactProjectionInfo } from "../compact/index.js";
import type { CheckpointProjectionInfo, RewindProjectionInfo } from "../rewind/index.js";
import type {
  StreamRecoveryAnchorProjectionInfo,
  StreamingToolLedgerProjectionInfo,
} from "../events/stream-recovery.events.js";
import type { SessionGoal } from "../tools/target.js";
import type { GoalCompletionVerificationOutput } from "../tools/target.js";
import type { PermissionOptionsPolicy, PermissionUpdate } from "./permission.port.js";
import type { ToolResultDisplayPayload } from "../tools/tool-result-metadata.js";
import type { ModelSelection } from "../model/model.js";

// -----------------------------------------------
// Collaboration Mode and Risk Level
// -----------------------------------------------

export type CollaborationMode = "plan" | "build" | "edit" | "yolo" | "auto";
export type SessionStatus = "idle" | "running" | "waiting" | "paused" | "completed" | "error";
export type RiskLevel = "low" | "medium" | "high" | "critical";
export type InputDelivery = "auto" | "start_turn" | "steer_active_turn";
export type TurnSteerRejectReason =
  | "no_active_turn"
  | "expected_turn_mismatch"
  | "turn_not_steerable"
  | "empty_input"
  | "input_too_large";

// -----------------------------------------------
// Session Event Store Port
// -----------------------------------------------

/** The resident size of the in-memory event store; used only for local in-memory diagnostic logs. */
export interface SessionEventStoreStats {
  sessions: number;
  events: number;
  /** The cumulative number of transient events already evicted by the turn window policy; always 0 in unbounded mode. */
  evictedEvents?: number;
  /** The number of transient events still resident right now (the in-progress turn plus one lagging turn). */
  retainedTransient?: number;
}

export interface SessionEventStorePort {
  append(event: SessionEvent): Promise<SessionEvent>;
  getEvents(sessionId: SessionId): Promise<SessionEvent[]>;
  getEventsAfter(sessionId: SessionId, sequenceNumber: number): Promise<SessionEvent[]>;
  getLatestSequenceNumber(sessionId: SessionId): Promise<number>;
  deleteSession(sessionId: SessionId): Promise<void>;
  /** Synchronous, O(sessions) read-only statistics; persistent implementations may omit it. */
  getStats?(): SessionEventStoreStats;
  /**
   * Time-based fallback eviction of transient events, triggered by a low-frequency tick;
   * returns the number of evicted entries. Persistent implementations may omit it.
   */
  pruneTransientEvents?(nowMs?: number): number;
}

// -----------------------------------------------
// Live Session Event Sink Port
// -----------------------------------------------

export interface SessionEventSink {
  onSessionEvent(event: SessionEvent): void | Promise<void>;
}

// -----------------------------------------------
// Session Projection Port
// -----------------------------------------------

export interface SessionProjection {
  id: SessionId;
  createdAt: Date;
  updatedAt: Date;
  mode: CollaborationMode;
  planEnabled?: boolean;
  status: SessionStatus;
  turnCount: number;
  totalTokenCount: number;
  contextUsed: number;
  contextWindow: number;
  pendingPermissions: PendingPermission[];
  pendingSteerInputs: PendingSteerInputInfo[];
  activeToolCalls: ActiveToolCall[];
  streamingToolLedger: StreamingToolLedgerProjectionInfo[];
  backgroundTasks: BackgroundTaskInfo[];
  currentTurnId?: TurnId;
  lastError?: ErrorInfo;
  lastCompact?: CompactProjectionInfo;
  lastCheckpoint?: CheckpointProjectionInfo;
  lastStreamRecoveryAnchor?: StreamRecoveryAnchorProjectionInfo;
  lastRewind?: RewindProjectionInfo;
  target?: SessionGoal | null;
  targetCompletionVerifications: GoalCompletionVerificationOutput[];
  targetCompletionVerificationTimeline: TargetCompletionVerificationProjectionInfo[];
}

export interface TargetCompletionVerificationProjectionInfo {
  targetId: string;
  status: "started" | "completed" | "failed_closed" | "cancelled";
  verificationId: string;
  verification?: GoalCompletionVerificationOutput;
  goalIteration?: number;
  anchorAssistantMessageId?: MessageId;
  anchorTurnId?: TurnId;
  startedAt?: Date;
  updatedAt: Date;
}

export interface PendingPermission {
  requestId?: string;
  toolCallId: string;
  toolName: string;
  reason?: string;
  riskLevel: RiskLevel;
  input?: unknown;
  suggestedPermissionUpdates?: PermissionUpdate[];
  origin?: InteractionRequestOrigin;
  /** The ask preview carried by the request event; the dialog of a session rebuilt by cold recovery still needs its image, so it must go into projection state. */
  display?: ToolResultDisplayPayload;
  optionsPolicy?: PermissionOptionsPolicy;
  requestedAt: Date;
}

export interface PendingSteerInputInfo {
  pendingInputId: string;
  input: string;
  inputPreview: string;
  inputSize: number;
  commandKind?: TurnSteerCommandKind;
  source?: TurnSteerSource;
  inputPresentation?: RuntimeInputPresentation;
  /** The tool hiding list carried by the currently queued input; an automation-busy enqueue must keep taking effect at consumption time. */
  toolDisallowlist?: readonly string[];
  queuedAt: Date;
  targetTurnId: TurnId;
  traceId: TraceId;
  intent?: TurnInputIntentMetadata;
}

export interface ActiveToolCall {
  toolCallId: string;
  toolName: string;
  status: ToolCallStatus;
  startedAt?: Date;
}

export type ToolCallStatus = "pending" | "running" | "completed" | "failed" | "denied";

export type BackgroundTaskInfoStatus =
  | "running"
  | "completed"
  | "failed"
  | "timed_out"
  | "cancelled"
  | "spawn_error"
  | "lost";

export interface BackgroundTaskInfo {
  taskId: string;
  toolCallId?: string;
  toolName?: string;
  taskKind?: "bash" | "subagent" | "workflow";
  childSessionId?: string;
  blocked?: boolean;
  blockedReason?: string;
  cancellable?: boolean;
  cancelRequestedAt?: Date;
  command?: string;
  description?: string;
  status: BackgroundTaskInfoStatus;
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

export interface BackgroundTaskCancelResult {
  cancelled: boolean;
  reason?: string;
  snapshot?: BackgroundTaskInfo;
  status: BackgroundTaskInfoStatus;
  taskId: string;
}

export interface ErrorInfo {
  attribution?: ErrorAttribution;
  code?: string;
  detail?: string;
  type: string;
  message: string;
}

// -----------------------------------------------
// Event Reducer Port
// -----------------------------------------------

export interface EventReducerPort {
  reduce(events: SessionEvent[]): SessionProjection;
  apply(projection: SessionProjection, event: SessionEvent): SessionProjection;
}

// -----------------------------------------------
// Session Manager Port
// -----------------------------------------------

export interface SessionManagerPort {
  createSession(config: SessionConfig): Promise<Session>;
  resumeSession(sessionId: SessionId): Promise<Session>;
  forkSession(sessionId: SessionId, forkPoint?: number): Promise<Session>;
  getSession(sessionId: SessionId): Promise<Session | null>;
  listSessions(): Promise<SessionSummary[]>;
}

export interface SessionConfig {
  mode?: CollaborationMode;
  contextWindow?: number;
  traceId?: TraceId;
}

export interface Session {
  id: SessionId;
  config: SessionConfig;
  eventStore: SessionEventStorePort;
  projection: SessionProjection;
  eventReducer: EventReducerPort;
}

export interface TurnSteerInput {
  input: string;
  inputId?: string;
  queryId?: QueryId;
  expectedTurnId?: TurnId;
  commandKind?: TurnSteerCommandKind;
  source?: TurnSteerSource;
  inputPresentation?: RuntimeInputPresentation;
  delivery?: TurnSteerDeliveryMode;
  intent?: TurnInputIntentMetadata;
  attachments?: PendingTurnAttachment[];
  pendingInputId?: string;
  traceContext?: TraceContext;
  /** The tool names not exposed to the provider while the current input is consumed. */
  toolDisallowlist?: readonly string[];
}

export type TurnSteerCommandKind = "sendText" | "sendGoalCommand" | "compact";
export type TurnSteerSource = "plan_approval_feedback" | "workflow_refine_feedback";

/**
 * Input delivery semantics:
 * - "queue": a queued future intent; at consumption time it starts a new product turn (one turn each, with its own reply / work time / edit scope);
 * - "guide": a supplementary steer for work in progress, inlined into the current turn, without starting a new turn.
 * The runtime injection mechanism is the same for both (boundary injection); the difference lies only in product presentation and ledger semantics.
 */
export type TurnSteerDeliveryMode = "guide" | "queue";

/** Protocol-independent input intent metadata; bootstrap v4 assembles it into a ConversationInputIntent at the event boundary. */
export interface TurnInputIntentMetadata {
  planEnabled?: boolean;
  sourceCommandId: string;
  queueItemId: string;
  clientId: string;
  kind: TurnSteerCommandKind;
  /** Transcript hydration carries the canonical command text of the complete ConversationInputIntent. */
  text?: string;
  /** Fixed at Admission time; Queue/Guide must not re-read the Composer's or the Session's latest selection afterwards. */
  modelSelection?: ModelSelection;
  /** The collaboration mode fixed together with this user Submission. */
  mode?: "build" | "edit" | "plan" | "yolo";
  admissionSeq: number;
  admittedAt: number;
  requestedDelivery: "auto" | "startNow" | "queue" | "guide";
  admittedDelivery: "startNow" | "queue" | "guide";
  queuePosition?: number;
  fallbackReasonCode?: string;
  attachmentRefs?: Array<{
    ref: string;
    fileName: string;
    mime: string;
    bytes: number;
    previewRef?: string;
  }>;
  sharedContextRefs?: Array<{
    kind: "shared_context_import";
    context_id: string;
  }>;
  /** A stable trace from the new command rebuilt by edit/retry back to the original canonical input cause. */
  provenance?: {
    sourceCommandId: string;
    queueItemId?: string;
    clientId?: string;
  };
}

/** Unresolved attachment descriptions kept inside the queue; consumed with the same resolver as an ordinary turn. */
export interface PendingTurnAttachment {
  type: "file" | "image" | "video" | "pdf" | "url";
  path?: string;
  content?: string;
  sourceKind?: "clipboard-text";
  filename?: string;
  mimeType?: string;
  sizeBytes?: number;
}

export interface PendingTurnInput {
  id: string;
  input: string;
  queuedAt: Date;
  traceId: TraceId;
  queryId?: QueryId;
  commandKind?: TurnSteerCommandKind;
  source?: TurnSteerSource;
  inputPresentation?: RuntimeInputPresentation;
  delivery?: TurnSteerDeliveryMode;
  intent?: TurnInputIntentMetadata;
  attachments?: PendingTurnAttachment[];
  /** The tool names not exposed to the provider after the current pending input is drained. */
  toolDisallowlist?: readonly string[];
  turnId: TurnId;
}

export type TurnSteerResult =
  | {
      kind: "queued";
      pendingInputId: string;
      queueLength: number;
      turnId: TurnId;
    }
  | {
      activeTurnId?: TurnId;
      kind: "rejected";
      reason: TurnSteerRejectReason;
    };

export interface SessionSummary {
  id: SessionId;
  createdAt: Date;
  updatedAt: Date;
  mode: CollaborationMode;
  status: SessionStatus;
  turnCount: number;
}
