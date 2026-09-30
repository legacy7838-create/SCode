/* oxlint-disable eslint(max-lines) -- re-home artifact: the load-bearing task projection types were migrated into one file, keeping a single-file contract surface. */
// re-home migration artifact (paving the way for deleting the old protocol tree).
// This file carries the star load-bearing types still consumed by surviving stacks in the old task projection: ZCodeTaskMeta / ZCodeProvider /
// ZCodeStreamEvent / TraceId/InputId/QueryId / ZCodePersistedMessage(Part) / ZCodeTaskSnapshot /
// ZCodePlanStep / ZCodePermissionRequest and their dependency closure (including realtime transport base types).
// zcode-task-types.ts / task-realtime.ts still retain the old protocol compatibility surface, sharing the core types in this file.

import type { ZCodeBackgroundTaskControlItem } from "./background-task-controls.js";
import type { ToolCallDisplay } from "./zcode-protocol-v4/toolDisplay.js";
import type {
  ZCodeContextUsageBreakdownItem,
  ZCodeInteractionRequestOrigin,
  ZCodePermissionResponse,
  ZCodeSessionActiveTurnKind,
} from "./zcode-protocol-legacy-types.js";
import type { ErrorAttribution } from "./zcode-protocol-v4/snapshot.js";

/**
 * Shared type definitions for the ZCode task/session projection
 *
 * Types used across the renderer, the host process, and the ZCode agent service.
 */

// ---- Observability ----

/** End-to-end trace ID, used for logging and observability traces. */
export type TraceId = string;
/** Attribution ID for each user input, used to converge stop / queue / terminal state. */
export type InputId = string;
/** Semantic attribution ID for each real user query, used for the model request header and per-question observability. */
export type QueryId = string;
// ---- ZCode Provider ----

/** Supported ZCode agent providers; only glm is currently kept. */
export type ZCodeProvider = "glm";
export type ZCodeGlmAgentModelStateUpdateReason =
  | "session_initialized"
  | "model_changed"
  | "thought_level_changed";
export interface ZCodeGlmAgentModelStateOption {
  value: string;
  name: string;
}
export interface ZCodeGlmAgentModelStateUpdatePayload {
  version: 1;
  sessionId: string;
  reason: ZCodeGlmAgentModelStateUpdateReason;
  model: {
    currentValue: string;
  };
  thoughtLevel: {
    enabled: boolean;
    currentValue?: string;
    options: ZCodeGlmAgentModelStateOption[];
  };
  contextWindow: {
    tokens: number;
  };
}
/** External history migration source. Only Claude Code is landed for now; further sources extend here later. */
export type ZCodeTaskMigrationSource = "claudeCode";
export type ZCodeTaskGoalStatus = "active" | "paused" | "budget_limited" | "complete";
export type ZCodeTaskTargetChangedAction =
  | "set"
  | "status_updated"
  | "cleared"
  | "usage_accounted"
  | "run_started"
  | "run_finished"
  | "summary_updated";
export type ZCodeTaskTargetChangedSource = "command" | "tool" | "runtime";
export interface ZCodeTaskGoal {
  sessionID: string;
  targetID: string;
  objective: string;
  summaryTitle: string | null;
  status: ZCodeTaskGoalStatus;
  tokenBudget: number | null;
  tokensUsed: number;
  timeUsedSeconds: number;
  activeInputId?: string | null;
  activeRunStartedAtMs?: number | null;
  activeRunLastSeenAtMs?: number | null;
  time: {
    created: number;
    updated: number;
  };
}
export interface ZCodeTaskGoalStats {
  /** Cumulative goal run seconds; comes from the agent's session_target or from a historical turn projection. */
  timeUsedSeconds: number;
  /** Cumulative goal tokens; goal accounting is preferred, and the agent falls back to historical turns when necessary. */
  tokensUsed: number;
  /** Goal token budget explicitly set by the user; when empty the UI can show the context window instead. */
  tokenBudget: number | null;
  /** Tokens already used in the current session's context window. */
  contextUsed: number;
  /** Capacity of the current session's context window. */
  contextWindow: number;
  /** Number of goal-related historical tool calls. */
  toolCallCount: number;
  /** Number of goal verifier lifecycle rounds that have been triggered; this is not the same as an ordinary runtime turn or a user continuation count. */
  iterationCount: number;
}
export interface ZCodeGoalVerification {
  nextAction?: string | null;
  passed: boolean;
  reason: string;
}
export type ZCodeGoalVerificationTimelineStatus =
  | "started"
  | "completed"
  | "failed_closed"
  | "cancelled";
export interface ZCodeGoalVerificationTimelineMeta {
  version: 1;
  kind: "synthetic";
  type: "goal_verification";
  display: "separator";
  targetId: string;
  verificationId: string;
  status: ZCodeGoalVerificationTimelineStatus;
  verification?: ZCodeGoalVerification;
  goalIteration?: number;
  /** The verifier divider should anchor to the assistant message that finished this round's output, rather than drifting by time. */
  anchorAssistantMessageId?: string;
  /** Auxiliary field that restores the boundary semantics of the same turn; it may be missing from old history. */
  anchorTurnId?: string;
  startedAt?: number;
  updatedAt: number;
}
export interface ZCodeTodoGroup {
  id: string;
  source: "goal_iteration" | "session";
  goalIteration?: number;
  targetId?: string;
  startedAt?: number;
  updatedAt?: number;
  todos: ZCodePlanStep[];
}
export interface ZCodeTaskGoalChangedPatch {
  action: ZCodeTaskTargetChangedAction;
  source: ZCodeTaskTargetChangedSource;
  target: ZCodeTaskGoal | null;
  previousTarget?: ZCodeTaskGoal | null;
}
// ---- ZCode task mode ----

export type ZCodeTaskMode = "yolo" | "plan" | "edit" | "auto" | "autoEdit" | "build";

export type ZCodeOffPeakRunType = "init" | "resume";

/** Source attribution for a single automatic input turn; the two background business identities must never coexist. */
export type ZCodeBackgroundTurnAttribution =
  | { automationId: string; offPeakTaskId?: never; offPeakRunType?: never }
  | {
      offPeakTaskId: string;
      offPeakRunType?: ZCodeOffPeakRunType;
      automationId?: never;
    }
  | { automationId?: undefined; offPeakTaskId?: undefined; offPeakRunType?: never };
/** Runtime status of the task in the current workspace */
export type ZCodeTaskRuntimeStatus =
  | "idle"
  | "creating"
  | "notReady"
  | "restoring"
  | "ready"
  | "streaming"
  | "completed"
  | "failed";
/** Persisted task status, recording the result of the last prompt */
export type ZCodeTaskPersistStatus = "running" | "completed" | "error";
export interface ZCodeTaskLastError {
  attribution?: ErrorAttribution;
  code?: string;
  message: string;
  traceId?: TraceId;
  taskId?: string;
}
/**
 * Attachment types supported by the current prompt.
 * Small image files go through the agent image block; local files / large images prefer localPath, letting the agent read them at its own threshold.
 */
export interface ZCodePromptImageAttachment {
  kind: "image";
  filename: string;
  mimeType: string;
  sizeBytes?: number;
  /** agent ImageContent already carries mimeType separately, so only the raw base64 body is kept here. */
  dataBase64?: string;
  /** Real local path on the desktop; large images are no longer stuffed into the protocol body and are handled by path on the agent side. */
  localPath?: string;
}
export interface ZCodePromptFileAttachment {
  kind: "file";
  filename: string;
  mimeType: string;
  sizeBytes: number;
  /** Attachment origin; clipboard-text means it was produced by spilling a long text paste to disk, and the agent should only treat it as a temporary file reference. */
  sourceKind?: "clipboard-text";
  /** Compatibility fallback for legacy / path-less environments; the new desktop GUI no longer sends base64 for ordinary files. */
  dataBase64?: string;
  /** Small-text fallback when there is no local path; when localPath exists the agent reads it itself. */
  textContent?: string;
  localPath?: string;
}
export interface ZCodePromptAudioAttachment {
  kind: "audio";
  filename: string;
  mimeType: string;
  /** agent AudioContent already carries mimeType separately, so only the raw base64 body is kept here. */
  dataBase64?: string;
  localPath?: string;
}
/** Video attachment: small web videos use dataBase64, while desktop prefers localPath for a zero-copy transfer. */
export interface ZCodePromptVideoAttachment {
  kind: "video";
  filename: string;
  mimeType: string;
  sizeBytes?: number;
  /** Raw base64 body; mimeType is carried separately by its own field. */
  dataBase64?: string;
  /** Real local path on the desktop; the agent side reads by path and performs a size check. */
  localPath?: string;
}
export interface ZCodePromptPdfAttachment {
  kind: "pdf";
  filename: string;
  mimeType: string;
  sizeBytes?: number;
  dataBase64?: string;
  localPath?: string;
}
export type ZCodePromptAttachment =
  | ZCodePromptImageAttachment
  | ZCodePromptAudioAttachment
  | ZCodePromptVideoAttachment
  | ZCodePromptPdfAttachment
  | ZCodePromptFileAttachment;
// ---- Task metadata ----

export type ZCodeTaskInteractionAutoResolution =
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

export interface ZCodeTaskPendingInteraction {
  interactionId: string;
  kind: "permission" | "userInput";
  /** Lightweight tool identity delivered by sessions-index; stays compatible when old summaries lack it. */
  toolName?: string;
  autoResolution?: ZCodeTaskInteractionAutoResolution;
}

export interface ZCodeTaskMeta {
  /** The UI taskId is kept identical to the ZCode agent sessionId, used for list selection, log correlation, and session restore. */
  taskId: string;
  /** session/task-level observability traceId; not used to distinguish individual user inputs */
  traceId: TraceId;
  /** Task title (the user input, or truncated from the first message) */
  title: string;
  /**
   * Whether the user has manually overridden the task title.
   *
   * A running agent keeps pushing auto-generated titles; the UI needs to know the current title is a manual name
   * so that updating status/target/updatedAt does not briefly wipe out the manual title.
   */
  titleOverridden?: boolean;
  /** Absolute path of the associated workspace */
  workspacePath: string;
  /**
   * Stable identity of a remote workspace (authority + canonicalPath).
   *
   * Persisting by workspacePath alone would write "same path on different remote hosts" into the same directory,
   * making task lists, snapshots, and logs read each other's data. workspaceIdentity is added here to take part in isolation.
   */
  workspaceIdentity?: string;
  /** app-owned workspace classification; defaults to project and does not take part in workspaceKey. */
  workspacePurpose?: import("./workspacePurpose.js").WorkspacePurpose;
  createdAt: number;
  updatedAt: number;
  mode: ZCodeTaskMode;
  model?: string;
  /**
   * Task-level reasoning effort.
   *
   * When switching effort inside an active task, writing only to the workspace settings.json
   * would cross-modify other tasks of the same workspace; changing only the session could let the next prompt be
   * overwritten by the workspace default pushed back. task-local thoughtLevel is therefore persisted separately and replayed to the session before sending.
   */
  thoughtLevel?: string;
  /**
   * The epoch at which this task last confirmed alignment with the workspace runtime baseline.
   *
   * In the past, judging "should the current task model be overridden" relied on workspacePreferredModel alone,
   * which mistook "an in-task model switch within the same supplier" for global convergence and cross-modified other tasks.
   * runtimeEpoch is recorded here to distinguish "the task keeps its own model" from "the runtime baseline really changed and convergence is needed".
   */
  runtimeEpoch?: number;
  /** Agent provider used when this task was created; treated as "glm" when absent (old data compatibility) */
  provider?: ZCodeProvider;
  /** Migration source; empty for ordinary new tasks, used to identify native Claude Code history imports. */
  migrationSource?: ZCodeTaskMigrationSource;
  /**
   * cron identity marker: which automation this session belongs to.
   *
   * The cron identity must be defined on the shared ZCodeTaskMeta so the persistence layer, the V4 UI, and the
   * service contract all use it together, avoiding a field that is persisted yet unreachable through the type contract.
   */
  cronAutomationId?: string;
  /**
   * Off-peak task identity marker: which off-peak task this session / phantom row belongs to.
   * It is a sibling marker of cronAutomationId (off-peak never reuses the cron marker); the row id = the sessionId
   * pre-allocated at creation, and the marker stays constant from creation through running, for the moon icon and system grouping.
   */
  offPeakTaskId?: string;
  /** fork products keep the source taskId, for the UI's localized-title fallback and later traceability. */
  forkedFromTaskId?: string;
  /** Unread tasks record the most recent time they were marked / became unread, so the blue dot survives a restart. */
  unreadAt?: number;
  /** Persisted task status, recording the result of the last prompt */
  status?: ZCodeTaskPersistStatus;
  /** Head-of-queue blocking interaction summary provided by sessions-index, for rendering sidebar state of background tasks that were never opened. */
  pendingInteraction?: ZCodeTaskPendingInteraction;
  /**
   * The last displayable failure reason.
   *
   * When the phone remote-control connection drops, a live task_error may fail to arrive; after recovery only meta.status=error is visible,
   * but the error body is gone, so the user thinks the send never fired. The failure reason is therefore persisted together with the task meta.
   */
  lastError?: ZCodeTaskLastError;
  /** Task-level file change summary, used only for list / title display; real rollback still relies on fileChanges */
  changeSummary?: ZCodeTaskChangeSummary;
  /** zcode-cli /goal session target; null means it was explicitly cleared. */
  target?: ZCodeTaskGoal | null;
}
export interface ZCodeTaskChangeSummary {
  /** Number of unique files touched across the whole task */
  fileCount: number;
  /** Added lines aggregated by final per-file result */
  added: number;
  /** Removed lines aggregated by final per-file result */
  removed: number;
  /** Summary of the files involved in the task */
  files: ZCodeTaskChangedFileSummary[];
}
export interface ZCodeTaskChangedFileSummary {
  path: string;
  added: number;
  removed: number;
  /** Total number of times this file was written within the same task */
  writeCount: number;
  /** Which round the last write happened in; the rollback button can reuse it directly later */
  lastTurnIndex: number;
}
// ---- ZCode configuration and command types ----

/** UI projection of ZCode configOptions (extracted from the session/new response) */
export interface ZCodeConfigOption {
  id: string;
  name: string;
  description?: string;
  /** mode | model | thought_level | custom */
  category?: string;
  type: "select" | "boolean";
  currentValue: string | boolean;
  /** Option list when type === "select" */
  options?: ZCodeConfigSelectValue[];
}
export interface ZCodeConfigSelectValue {
  value: string;
  name: string;
  description?: string;
  /** Value origin: the native model list or a session-side injected entry (used for UI dedup and display control) */
  origin?: "native" | "injected";
  /** Provider/group id the model option belongs to, used for provider -> model grouping selection */
  modelProviderId?: string;
  /** Display name of the provider/group the model option belongs to */
  modelProviderName?: string;
  /** Missing means the capability is unknown; an empty array means it is known that no reasoning level is selectable */
  modelThoughtLevels?: string[];
  /** Default reasoning level declared by the model catalog; it does not mean the user explicitly chose it */
  modelDefaultThoughtLevel?: string;
}
export interface ZCodeSlashCommand {
  name: string;
  description: string;
  inputHint?: string;
  /** Command origin; the old protocol may leave it empty, so clients should treat it as builtin for compatibility. */
  source?: "builtin" | "custom";
}
export interface ZCodeTaskModeInfo {
  id: string;
  name: string;
  description?: string;
}
// ---- ZCode streaming event (Host → Renderer) ----

export type TaskStreamMirrorableEvent = (
  | ZCodeAgentMessageChunk
  | ZCodeAgentThoughtChunk
  | ZCodeToolCall
  | ZCodeToolCallUpdate
  | ZCodePlan
  | ZCodePermissionRequest
  | ZCodeTaskPermissionResponse
  | ZCodeElicitationRequest
  | ZCodeElicitationResponse
  | ZCodeTaskComplete
  | ZCodeTaskRunStarted
  | ZCodeTaskWarning
  | ZCodeTaskError
  | ZCodeConfigOptionUpdate
  | ZCodeAvailableCommandsUpdate
  | ZCodeModeUpdate
  | ZCodeSessionInfoUpdate
  | ZCodeGoalVerificationUpdate
  | ZCodeTaskTokenUsageDelta
  | ZCodeTaskNetworkDebugStatus
  | ZCodeUsageUpdate
  | ZCodeBackgroundTaskControlItemsUpdate
) & { inputId?: InputId };
export type ZCodeStreamEvent = (
  | TaskStreamMirrorableEvent
  | ZCodeGlmAgentModelStateUpdate
  | ZCodeGoalIterationStarted
  | ZCodeTurnSteerQueued
  | ZCodeTurnSteerStatus
  | TaskStreamMirrorBatch
  | ZCodeTaskSnapshotUpdated
) & { inputId?: InputId };
export type ZCodeTurnSteerSource = "plan_approval_feedback" | "workflow_refine_feedback";
export type ZCodeTurnSteerCommandKind = "sendText" | "sendGoalCommand" | "compact";
export interface ZCodeTurnSteerQueued {
  type: "turn_steer_queued";
  taskId: string;
  traceId: TraceId;
  inputId?: InputId;
  queryId?: QueryId;
  pendingInputId: string;
  messageId?: string;
  commandKind?: ZCodeTurnSteerCommandKind;
  source?: ZCodeTurnSteerSource;
  targetTurnId?: string;
  content: string;
  raw?: unknown;
}
export interface ZCodeTurnSteerStatus {
  type: "turn_steer_status";
  taskId: string;
  traceId: TraceId;
  inputId?: InputId;
  queryIds?: QueryId[];
  status: "drained" | "discarded" | "rejected";
  pendingInputIds?: string[];
  injectedMessageIds?: string[];
  targetTurnId?: string;
  reason?: string;
  raw?: unknown;
}
export interface ZCodeAgentMessageChunk {
  type: "agent_message_chunk";
  taskId: string;
  traceId: TraceId;
  inputId?: InputId;
  /** Parent toolCallId; null means the main agent body. */
  parentToolUseId?: string | null;
  /** agent messageId; ZCode synthetic timeline messages use it for upsert. */
  messageId?: string;
  content: string;
  zcodeTimeline?: ZCodeTimelineMeta;
}
export interface ZCodeAgentThoughtChunk {
  type: "agent_thought_chunk";
  taskId: string;
  traceId: TraceId;
  inputId?: InputId;
  /** Parent toolCallId; null means the main agent thought. */
  parentToolUseId?: string | null;
  content: string;
}
export type ZCodeTimelineStatus =
  | "started"
  | "retrying"
  | "skipped"
  | "completed"
  | "failed"
  | "interrupted";
export type ZCodeTimelineTrigger = "manual" | "auto" | "reactive" | "partial" | "session_memory";
export type ZCodeContextCompactionTimelinePhase =
  | "standalone_turn"
  | "pre_request"
  | "mid_turn"
  | "reactive";
export type ZCodeTimelineMeta =
  | ZCodeContextCompactionTimelineMeta
  | ZCodeGoalVerificationTimelineMeta
  | ZCodeSessionForkTimelineMeta;
export interface ZCodeContextCompactionTimelineMeta {
  version: 1;
  kind: "synthetic";
  type: "context_compaction";
  operationId: string;
  status: ZCodeTimelineStatus;
  trigger: ZCodeTimelineTrigger;
  display: "separator";
  /**
   * `/compact` first renders an optimistic bar locally, while the agent lifecycle event only arrives later.
   * inputId merges the two, so a single compaction does not first show "compacting" and then additionally append a "compacted" entry.
   */
  inputId?: InputId;
  /** Retrying after a failure must preserve the `/compact ...` command the user originally typed. */
  command?: string;
  replace?: boolean;
  reason?: string;
  boundaryId?: string;
  summaryMessageId?: string;
  preCompactTokenCount?: number;
  postCompactTokenCount?: number;
  truePostCompactTokenCount?: number;
  attempt?: number;
  maxAttempts?: number;
  /** During the compact phase, distinguishes real compaction boundaries such as mid_turn / pre_request, so the UI and e2e do not have to guess from wording. */
  phase?: ZCodeContextCompactionTimelinePhase;
  startedAt?: number;
  endedAt?: number;
}
export interface ZCodeSessionForkTimelineMeta {
  version: 1;
  kind: "synthetic";
  type: "session_fork";
  display: "separator";
  parentSessionId: string;
  targetMessageId: string;
  /** A pure conversation fork has no workspace checkpoint; the UI relies only on targetMessageId to jump back to the parent message. */
  targetCheckpointId?: string;
  restoredFileCount?: number;
}
export interface ZCodeToolCall {
  type: "tool_call";
  taskId: string;
  traceId: TraceId;
  inputId?: InputId;
  toolId: string;
  /** Parent toolCallId; null means a tool call issued directly by the main agent. */
  parentToolUseId?: string | null;
  input: unknown;
  /** Fixed ZCode tool name; the new field splits tool identity apart from the historical kind classification. */
  toolName?: string;
  /** Backward-compatible historical classification; in the current ZCode stream it is usually equal to toolName. */
  kind: string;
  /** agent ToolCall.title, the human-readable title describing the current tool action */
  title: string;
  /** Raw agent ToolCall payload; the authority when debugging protocol fields */
  raw: unknown;
  /** Skill resolved metadata; used only for telemetry attribution. */
  skillMetadata?: {
    qualifiedName?: string;
    pluginId?: string;
    source?: "agents" | "zcode" | "bundled" | "plugin" | "remote";
  };
}
export interface ZCodeToolCallUpdate {
  type: "tool_call_update";
  taskId: string;
  traceId: TraceId;
  inputId?: InputId;
  toolId: string;
  /** Parent toolCallId; null means a tool call issued directly by the main agent. */
  parentToolUseId?: string | null;
  status: "pending" | "in_progress" | "completed" | "failed" | "denied" | "stopped";
  /**
   * agent ToolCallUpdate.title, optional; it may be empty here if the Agent never updated the title.
   */
  title?: string;
  /** Fixed ZCode tool name; ToolCallResult may carry only toolId, and the service layer fills it in from the cache of preceding calls. */
  toolName?: string;
  /** Backward-compatible historical classification; in the current ZCode stream it is usually equal to toolName. */
  kind?: string;
  input?: unknown;
  content?: unknown;
  error?: string;
  /** Raw agent ToolCallUpdate payload; the authority when debugging protocol fields */
  raw: unknown;
  /** Skill resolved metadata; used only for telemetry attribution. */
  skillMetadata?: {
    qualifiedName?: string;
    pluginId?: string;
    source?: "agents" | "zcode" | "bundled" | "plugin" | "remote";
  };
}
export interface ZCodePlan {
  type: "plan";
  taskId: string;
  traceId: TraceId;
  inputId?: InputId;
  steps: ZCodePlanStep[];
}
export interface ZCodePlanStep {
  id: string;
  title: string;
  status: "pending" | "in_progress" | "completed";
}
export interface ZCodePermissionRequest {
  type: "permission_request";
  taskId: string;
  traceId: TraceId;
  inputId?: InputId;
  requestId: string;
  description: string;
  kind: string;
  title?: string;
  options: ZCodePermissionOption[];
  /** Whether the V4 permission allows attaching user feedback when denying. */
  freeText?: boolean;
  origin?: ZCodeInteractionRequestOrigin;
  /**
   * Confirmation preview reported by the tool itself, reusing the tool call row's display projection (the same bounded shape).
   * Absent = plain-text ask (the legacy v3 path explicitly strips this field).
   */
  display?: ToolCallDisplay;
  /** Raw agent RequestPermissionRequest.toolCall payload */
  raw: unknown;
}
export interface ZCodeTaskPermissionResponse {
  type: "permission_response";
  taskId: string;
  traceId: TraceId;
  inputId?: InputId;
  requestId: string;
  optionId: string;
  response: ZCodePermissionResponse;
}
export interface ZCodePermissionOption {
  optionId: string;
  kind: string;
  name: string;
  description?: string;
  response: ZCodePermissionResponse;
}
/** ZCode Elicitation request event, for tools that need user interaction such as AskUserQuestion */
export interface ZCodeElicitationRequest {
  type: "elicitation_request";
  taskId: string;
  traceId: TraceId;
  inputId?: InputId;
  requestId: string;
  message: string;
  header?: string;
  options: ZCodeElicitationOption[];
  multiSelect?: boolean;
  /** Multi-question structure of AskUserQuestion; when present the UI collects all answers at once as tabs. */
  questions?: ZCodeElicitationQuestion[];
  /** Current question index synced over the remote control link, used to keep AskUserQuestion progress across clients. */
  currentQuestionIndex?: number;
  /** Draft answers synced over the remote control link, keyed by answer_0 / answer_1. */
  answerDrafts?: Record<string, string[]>;
  origin?: ZCodeInteractionRequestOrigin;
  /** Raw ElicitationSchema payload */
  schema?: unknown;
}
/** A single ZCode Elicitation question */
export interface ZCodeElicitationQuestion {
  question: string;
  header: string;
  options: ZCodeElicitationOption[];
  multiSelect?: boolean;
}
/** A ZCode Elicitation option */
export interface ZCodeElicitationOption {
  value: string;
  label: string;
  description?: string;
}
/** ZCode Elicitation response event */
export interface ZCodeElicitationResponse {
  type: "elicitation_response";
  taskId: string;
  traceId: TraceId;
  inputId?: InputId;
  requestId: string;
  action: "accept" | "decline" | "cancel";
  content?: Record<string, unknown>;
}
export interface ZCodeTaskComplete {
  type: "task_complete";
  taskId: string;
  traceId: TraceId;
  inputId?: InputId;
  stopReason: string;
  usage?: ZCodeUsage;
}
export interface ZCodeTaskRunStarted {
  type: "task_run_started";
  taskId: string;
  traceId: TraceId;
  inputId?: InputId;
  turnId?: string;
  startedAt: number;
}
export interface ZCodeGoalIterationStarted {
  type: "goal_iteration_started";
  taskId: string;
  traceId: TraceId;
  inputId?: InputId;
  turnId?: string;
  targetId?: string;
  startedAt: number;
}
export interface ZCodeTaskError {
  type: "task_error";
  taskId: string;
  traceId: TraceId;
  inputId?: InputId;
  error: string;
  code?: string;
  detail?: string;
  attribution?: ErrorAttribution;
}
export interface ZCodeTaskWarning {
  type: "task_warning";
  taskId: string;
  traceId: TraceId;
  inputId?: InputId;
  warning: string;
  code?: string;
  detail?: string;
}
export interface ZCodeUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  /** Tokens spent on reasoning/thinking; aligned with the agent's `thoughtTokens`. */
  reasoningTokens?: number;
  /** Input tokens served from cache */
  cachedInputTokens?: number;
  /** Input tokens written into cache */
  cachedWriteInputTokens?: number;
}
export interface ZCodeContextCacheUsage {
  /** Input token count of the most recent main turn reported by the Provider. */
  inputTokens: number;
  /** Cache hit token count of the most recent main turn reported by the Provider. */
  cacheReadTokens: number;
  /** Cache write token count of the most recent main turn reported by the Provider. */
  cacheWriteTokens: number;
  /** Cache hit rate of the most recent main turn's provider usage; null when unknown. */
  latestHitRate?: number | null;
  /** Number of main-turn requests that participate in the running average. */
  hitRateRequestCount?: number;
  /** Total main-turn input tokens that participate in the running average. */
  totalInputTokens?: number;
  /** Total main-turn cache read tokens that participate in the running average. */
  totalCacheReadTokens?: number;
  /** Total main-turn cache write tokens that participate in the running average. */
  totalCacheWriteTokens?: number;
  /** Running-average main-turn cache hit rate returned to the app after the Agent normalizes it; null when unknown. */
  hitRate: number | null;
}
/** Cumulative task token delta pushed by the Agent after each model request completes. */
export interface ZCodeTaskTokenUsageDelta {
  type: "task_token_usage_delta";
  taskId: string;
  traceId: TraceId;
  inputId?: InputId;
  queryId?: QueryId;
  /** Stable dedup key, usually taken from the ZCode Protocol eventId. */
  eventKey: string;
  eventId?: string;
  querySource?: string;
  usage: ZCodeUsage;
}
export type ZCodeTaskNetworkDebugStatusType =
  | "model_request_started"
  | "model_request_completed"
  | "model_request_failed"
  | "model_retry_scheduled"
  | "model_stream_stalled";
/** Agent model network status debug event; carries only metadata and redacted headers, never the response body/data. */
export interface ZCodeTaskNetworkDebugStatus {
  type: "task_network_debug_status";
  taskId: string;
  traceId: TraceId;
  inputId?: InputId;
  queryId?: QueryId;
  eventKey: string;
  eventId?: string;
  statusType: ZCodeTaskNetworkDebugStatusType;
  requestId?: string;
  providerId?: string;
  modelId?: string;
  providerKind?: string;
  transport?: string;
  baseURL?: string;
  querySource?: string;
  attempt?: number;
  maxAttempts?: number;
  nextAttempt?: number;
  retryable?: boolean;
  statusCode?: number;
  durationMs?: number;
  delayMs?: number;
  idleMs?: number;
  timeoutMs?: number;
  reason?: string;
  message?: string;
  timestamp?: string;
  requestHeaders: Record<string, string>;
  responseHeaders: Record<string, string>;
  requestHeaderCount: number;
  responseHeaderCount: number;
}
// ---- Added new streaming event type ----

/** Agent-initiated configuration change push (e.g. rate-limit model downgrade, mode linkage changes) */
export interface ZCodeConfigOptionUpdate {
  type: "config_option_update";
  taskId: string;
  traceId: TraceId;
  inputId?: InputId;
  configOptions: ZCodeConfigOption[];
}
/** zcode-cli/GLM agent only: syncs thought level options and the context window after the model changes. */
export interface ZCodeGlmAgentModelStateUpdate extends ZCodeGlmAgentModelStateUpdatePayload {
  type: "glm_agent_model_state_update";
  taskId: string;
  traceId: TraceId;
  inputId?: InputId;
}
/** List of available slash commands pushed by the Agent */
export interface ZCodeAvailableCommandsUpdate {
  type: "available_commands_update";
  taskId: string;
  traceId: TraceId;
  inputId?: InputId;
  commands: ZCodeSlashCommand[];
}
/** Mode change pushed by the Agent (e.g. automatically switching from architect to code) */
export interface ZCodeModeUpdate {
  type: "mode_update";
  taskId: string;
  traceId: TraceId;
  inputId?: InputId;
  currentModeId: string;
  availableModes: ZCodeTaskModeInfo[];
}
/** Transient state used when the Agent API hits a retryable error; in-memory UI only, never written to task persistence.
 * attempt means which retry is currently in progress, starting at 1, not the total number of attempts.
 */
export interface ZCodeApiRetryStatus {
  kind: "api_retry";
  attempt: number;
  maxRetries: number;
  retryDelayMs: number;
  errorStatus: number | null;
  error: string;
}
/** Metadata update push such as the session title, sent by the Agent */
export interface ZCodeSessionInfoUpdate {
  type: "session_info_update";
  taskId: string;
  traceId: TraceId;
  inputId?: InputId;
  title?: string | null;
  /**
   * Optional API retry status patch.
   *
   * `undefined` means this session_info_update did not touch the field;
   * `null` means the retry status was explicitly cleared;
   * an object means entering/updating the retrying state.
   */
  apiRetry?: ZCodeApiRetryStatus | null;
  /**
   * /goal status patch that zcode-cli projects through the compatible session_info_update._meta.zcode.target.
   * `undefined` means no target change this time; `target: null` means cleared.
   */
  target?: ZCodeTaskGoalChangedPatch;
}
export interface ZCodeGoalVerificationUpdate {
  type: "goal_verification_update";
  taskId: string;
  traceId: TraceId;
  inputId?: InputId;
  verification: ZCodeGoalVerification;
}
/** Real-time context window usage pushed by the Agent */
export interface ZCodeUsageUpdate {
  type: "usage_update";
  taskId: string;
  traceId: TraceId;
  inputId?: InputId;
  /** Total size of the context window (in tokens) */
  size: number;
  /** Number of tokens currently used */
  used: number;
  /** Cumulative cost */
  cost?: { amount: number; currency: string } | null;
  /** Cache hit information exposed by the current main turn's provider usage. */
  cache?: ZCodeContextCacheUsage;
  /** Context character count estimated by the Agent per source, used for the UI ratio display and not a token ledger. */
  breakdown?: ZCodeContextUsageBreakdownItem[];
}
/** Background task control items reported by the Agent runtime; they only describe the current in-memory host state and are never written to the session file. */
export interface ZCodeBackgroundTaskControlItemsUpdate {
  type: "background_bash_jobs_update";
  taskId: string;
  traceId: TraceId;
  inputId?: InputId;
  jobs: ZCodeBackgroundTaskControlItem[];
}
/** Notifies the UI to re-fetch the snapshot after the remaining data is flushed, ensuring late streaming data can be rendered */
export interface ZCodeTaskSnapshotUpdated {
  type: "task_snapshot_updated";
  workspacePath: string;
  workspaceIdentity?: string;
  workspaceKey: string;
  taskId: string;
  traceId: TraceId;
  reason?: TaskRealtimeReason;
  eventId?: string;
  runId?: string;
  streamWatermark?: TaskStreamWatermark;
}
export type ZCodeTaskClientMode = "desktop-continuous" | "web-remote-replayable";
export type ZCodeTaskRuntimeCommandStatus = "accepted" | "running" | "failed";
export interface ZCodeTaskRuntimeCommandBase {
  commandId: string;
  taskId: string;
  traceId: TraceId;
  queryId?: QueryId;
  workspacePath: string;
  workspaceIdentity?: string;
  workspaceKey: string;
  status: ZCodeTaskRuntimeCommandStatus;
  createdAt: number;
  updatedAt: number;
  clientId?: string;
  clientLabel?: string;
  error?: string;
}
export interface ZCodeTaskSendPromptCommand extends ZCodeTaskRuntimeCommandBase {
  type: "send_prompt";
  content: string;
  attachments?: ZCodePromptAttachment[];
  /** Host commands dispatched by scheduled tasks must keep the automation context, so CronCreate is not re-exposed after the queue drains. */
  automationId?: string;
}
export type ZCodeTaskRuntimeCommand = ZCodeTaskSendPromptCommand;
export interface TaskStreamMirrorBatch {
  type: "task_stream_mirror_batch";
  workspacePath: string;
  workspaceIdentity?: string;
  workspaceKey: string;
  taskId: string;
  traceId: TraceId;
  runId: string;
  ownerClientId?: string;
  ownerDeviceLabel?: string;
  batchSeq: number;
  fromSeq: number;
  toSeq: number;
  ops: TaskStreamMirrorOp[];
  terminal: boolean;
}
// ---- Persistence format ----

export interface ZCodeSessionFile {
  meta: ZCodeTaskMeta;
  messages: ZCodePersistedMessage[];
  /** File change records, stored per turn */
  fileChanges?: ZCodePersistedFileChange[];
  /** Git checkpoint metadata, stored per turn and used only to orchestrate undo */
  turnCheckpoints?: ZCodePersistedTurnCheckpoint[];
}
export interface ZCodeSessionRuntimeSnapshot {
  pendingPermissions?: ZCodePermissionRequest[];
  pendingElicitations?: ZCodeElicitationRequest[];
  /** Active turn kind of the current session; lets the UI tell ordinary streaming apart from the compact maintenance state. */
  activeTurnKind?: ZCodeSessionActiveTurnKind;
  /** Agent API network retry is a runtime hint: it is only restored with the snapshot and is never written to session JSON. */
  apiRetry?: ZCodeApiRetryStatus | null;
  /** Context window usage from the ZCode Protocol projection, used to restore the bottom-right context meter of the old task UI. */
  contextUsage?: {
    used: number;
    size: number;
    cost?: { amount: number; currency: string } | null;
    cache?: ZCodeContextCacheUsage;
    breakdown?: ZCodeContextUsageBreakdownItem[];
  };
  streamWatermark?: TaskStreamWatermark;
  pendingCommands?: ZCodeTaskRuntimeCommand[];
  /**
   * Recovery state mapped from the persistent todo in the agent session store.
   * The UI only consumes it to restore the todo panel and never writes this field back into old session JSON.
   */
  plan?: ZCodePlanStep[] | null;
  /**
   * Runtime projection of the target summary; computed on the fly from the agent DB / message tool parts and never written to the task index.
   */
  goalStats?: ZCodeTaskGoalStats | null;
  goalVerifications?: ZCodeGoalVerification[] | null;
  goalVerificationTimeline?: ZCodeGoalVerificationTimelineMeta[] | null;
  /**
   * Grouped todos projected from the session's historical TodoWrite calls; used for restoring the display, not as the authoritative todo store.
   */
  todoGroups?: ZCodeTodoGroup[] | null;
  /** Compatibility field: carries the host/runtime background task controls; it can be restored with the snapshot but is not persisted to session JSON. */
  backgroundBashJobs?: ZCodeBackgroundTaskControlItem[];
}
export interface ZCodeTaskSnapshotHistory {
  /** Whether the response-time history window trimmed older messages; only returned by getTaskSnapshot and never written to session JSON. */
  truncatedBefore: boolean;
  /** Total number of visible messages before trimming, used by the UI to decide whether older history can still be pulled. */
  totalMessages: number;
}
export type ZCodeTaskSnapshot = ZCodeSessionFile & {
  /** Non-persistent runtime state, assembled and returned only by getTaskSnapshot; writing it to session JSON is forbidden. */
  runtime?: ZCodeSessionRuntimeSnapshot;
  /** Non-persistent history window metadata describing only whether this snapshot response is a tail window. */
  history?: ZCodeTaskSnapshotHistory;
  /** Visible command list returned by the Agent/app communication; used to restore the `/` panel and never written to session JSON. */
  slashCommands?: ZCodeSlashCommand[];
  /** UI configuration projected from session settings; returned only with the snapshot and never written to session JSON. */
  configOptions?: ZCodeConfigOption[];
};
export type ZCodeTurnFileState = "applied" | "reverted";
/** Persisted per-turn file changes */
export interface ZCodePersistedFileChange {
  turnIndex: number;
  snapshots: ZCodePersistedFileSnapshot[];
  /** Whether this turn's file changes are still applied in the workspace */
  fileState?: ZCodeTurnFileState;
}
/** Persisted per-turn file checkpoint metadata */
export interface ZCodePersistedTurnCheckpoint {
  turnIndex: number;
  /** File state checkpoint from before the turn started */
  baseFileCheckpointId: string;
  /** File state checkpoint from after the turn finished; may be empty while the turn is unfinished */
  resultFileCheckpointId?: string;
}
/** Persisted file snapshot */
export interface ZCodePersistedFileSnapshot {
  path: string;
  beforeContent: string | null;
  afterContent: string;
  writeCount: number;
  /** Response-state snapshots only: the file snapshot body was trimmed by the first-screen budget and the full content can be pulled by ref. */
  contentRefs?: ZCodeTaskSnapshotFileContentRef[];
}
/** A parts element of a persisted message, recording the interleaved order of content / thought / tool-call.
 *  History restore uses it to rebuild the UI-side parts array, so that all the text does not pile up on top with the tool calls queued below. */
export type ZCodePersistedMessagePart =
  | { type: "content"; content: string }
  | { type: "thought"; content: string }
  | { type: "tool-call"; toolIndex: number };
export type ZCodeAssistantMessageFeedback = "like" | "dislike";
export type ZCodeAssistantCheckpointState = "partial";
export type ZCodeAssistantCheckpointReason = "tool_completed" | "part_boundary" | "periodic";
export interface ZCodePersistedMessage {
  /** Original protocol-side messageId; it keeps live messages and the timeline divider restored from a snapshot under the same identity. */
  id?: string;
  /** Set of original messageIds kept after the projection merged assistants, so timeline anchors can still hit the merged child messages. */
  mergedMessageIds?: string[];
  role: "user" | "assistant";
  content: string;
  timestamp: number;
  /** Legacy goal display iteration this assistant belongs to; used only for the status line in the UI history area and not for verifier round decisions. */
  goalIteration?: number;
  /** Model this message was sent under; when old history lacks it, the read side falls back to task.meta.model. */
  model?: string;
  /** Snapshot of the plain-text character count; token estimation converts it with a constant divisor, and it can be recomputed if the standard later changes. */
  characterCount?: number;
  /** Final duration of the assistant history entry; only persisted after the turn ends, avoiding a distorted duration from reverse-deriving the timestamp during history restore */
  durationMs?: number;
  /** Whether the assistant turn ended by an explicit user stop or an abnormal interruption; used to suppress promotion in the latest reply area. */
  interrupted?: boolean;
  /** Local user feedback on the assistant reply; used only for ZCode display/statistics and never injected into the Agent context. */
  feedback?: ZCodeAssistantMessageFeedback;
  attachments?: ZCodePromptAttachment[];
  tools?: ZCodePersistedToolCall[];
  thought?: string;
  /** Interleaved order of the message's parts, used to preserve the original arrangement of content and tool-calls during history restore */
  parts?: ZCodePersistedMessagePart[];
  /** Mid-run assistant snapshot; used to recover to the latest parts boundary after a crash/restart, and it does not mean this turn completed naturally. */
  checkpointState?: ZCodeAssistantCheckpointState;
  checkpointReason?: ZCodeAssistantCheckpointReason;
  checkpointUpdatedAt?: number;
  /** The conversation turn this message belongs to, used to correlate the per-turn file change summary and rollback */
  turnIndex?: number;
  /** Response-state snapshots only: large fields were trimmed by the first-screen budget and the full body can be pulled by ref. */
  bodyRefs?: ZCodeTaskSnapshotBodyRef[];
  /** Response-state snapshots only: slice information used when tools were trimmed by count, which can be used to pull more tool calls. */
  toolSlice?: ZCodeTaskSnapshotToolSlice;
  /** synthetic divider metadata (context_compaction / session_fork), restored with the snapshot for the UI to render separator bars. */
  syntheticTimeline?: ZCodeTimelineMeta;
}
export type ZCodeTaskSnapshotBodyField = "content" | "thought";
export interface ZCodeTaskSnapshotBodyRef {
  field: ZCodeTaskSnapshotBodyField;
  refId: string;
  hash: string;
  fullBytes: number;
  previewBytes: number;
}
export type ZCodeTaskSnapshotToolField = "input" | "output" | "raw";
export type ZCodeTaskSnapshotFileContentField = "beforeContent" | "afterContent";
export interface ZCodeTaskSnapshotToolFieldRef {
  field: ZCodeTaskSnapshotToolField;
  refId: string;
  hash: string;
  fullBytes: number;
  previewBytes: number;
}
export interface ZCodeTaskSnapshotFileContentRef {
  field: ZCodeTaskSnapshotFileContentField;
  refId: string;
  hash: string;
  fullBytes: number;
  previewBytes: number;
}
export interface ZCodeTaskSnapshotToolSlice {
  persistedMessageIndex: number;
  totalTools: number;
  startToolIndex: number;
  endToolIndexExclusive: number;
}
export interface ZCodePersistedToolCall {
  /** Fixed ZCode tool name; old snapshots may have stored the title here, so the read side must stay compatible. */
  toolName?: string;
  title?: string;
  kind?: string;
  status?: "completed" | "failed" | "denied" | "stopped";
  input: unknown;
  output?: unknown;
  error?: string;
  raw?: unknown;
  /** Response-state snapshots only: the tool's large fields were trimmed by the first-screen budget and the full content can be pulled by ref. */
  snapshotRefs?: ZCodeTaskSnapshotToolFieldRef[];
}
export type TaskRealtimeReason =
  | "task_created"
  | "user_message_saved"
  | "assistant_message_saved"
  | "task_status_changed"
  | "task_meta_changed"
  // Pure configuration changes like model switching were previously broadcast mixed in task_meta_changed, and the UI could not distinguish
  // "attribution-related meta changes (rename/unread)" from "configuration changes unrelated to list attribution",
  // causing every model switch to trigger a global membership re-fetch + full table refresh. A separate reason allows the policy layer to degrade precisely.
  | "task_model_changed"
  // Title updates (first message writes title / auto title generation after closing) are also unrelated to attribution and high-frequency,
  // mixed in task_meta_changed would cause every send/close to trigger a global membership re-fetch.
  | "task_title_changed"
  | "task_pinned"
  | "task_unpinned"
  | "task_archived"
  | "task_unarchived"
  | "task_deleted"
  | "stream_mirror_gap"
  | "stream_mirror_owner_lost";
export interface TaskStreamMirrorUserMessageOp {
  kind: "user_message";
  messageId: string;
  content: string;
  attachments?: ZCodePromptAttachment[];
  timestamp: number;
}
export interface TaskStreamMirrorStreamEventOp {
  kind: "stream_event";
  event: TaskStreamMirrorableEvent;
}
export type TaskStreamMirrorOp =
  | (TaskStreamMirrorUserMessageOp & { seq: number })
  | (TaskStreamMirrorStreamEventOp & { seq: number });
export interface TaskStreamWatermark {
  runId: string;
  opSeq: number;
}
