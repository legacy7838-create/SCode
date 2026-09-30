/* oxlint-disable eslint(max-lines) -- the legacy message/ARMS builders share the same prompt
 * lifecycle and clock; splitting them would add cross-module synchronization drift to the fact
 * state machine.
 */
import {
  legacyTelemetryModelValue,
  legacyTelemetryProviderId,
} from "@/lib/providerTelemetryIdentity.js";
import type {
  IPlatformService,
  RemoteWorkspaceIdentityKind,
  ZCodeContextCompactionTimelineMeta,
  ZCodeStreamEvent,
  ZCodeUsage,
} from "@zcode/shared";
import type { ConversationTelemetryFact } from "@zcode/shared/zcode-protocol-v4";
import { reportAppTelemetryEvent } from "@/lib/appTelemetry.js";
import {
  reportChatErrorBannerTelemetry,
  resolveVisibleChatErrorTelemetryRecoveryAction,
  type ChatErrorBannerSurface,
} from "@/lib/chatErrorBannerTelemetry.js";
import {
  activatePromptTelemetry,
  activateDetachedAgentStepTelemetry,
  composeAgentComposition,
  type AgentStepRole,
  type PromptMessageSource,
  buildCompactionTelemetryExtraDetail,
  discardPromptTelemetry,
  discardQueuedPromptTelemetry,
  finalizePromptTelemetry,
  getActivePromptModelName,
  getActivePromptMessageId,
  queuePromptTelemetry,
  recordAgentStepTelemetryEvent,
  recordComposerFocus,
  recordComposerTextChange,
  recordSubagentToolAttribution,
  recordPromptModelRequestStarted,
  recordPromptPermissionRequest,
  recordPromptPermissionResponse,
  recordPromptTokenUsageDelta,
} from "@/lib/messageTelemetry.js";
import {
  reportPlanUsageModelRequestStartedToArms,
  reportPlanUsageTtftToArms,
} from "@/lib/planUsageArmsTelemetry.js";
import {
  reportSendFunnelInputFocus,
  reportSendFunnelSendClick,
  reportSendFunnelSendResult,
  type SendFunnelReasonCode,
} from "@/lib/sendFunnelArmsTelemetry.js";
import {
  clearStreamStallTracking,
  recordStreamChunkArrival,
  reportUiFirstToken,
  reportUiMessageComplete,
  reportUiToolCallDetail,
  reportUiTurnBreakdown,
} from "@/lib/uiPerfArmsTelemetry.js";
import type { ZCodeUiError } from "@/lib/zcodeUiError.js";
import { resolveLegacyRuntimeModelValue } from "@/v4/telemetry/conversationPromptTelemetry.js";

const MAX_DEDUPE_KEYS = 2_000;
const MAX_BUFFERED_FACTS_PER_COMMAND = 128;
const MAX_BUFFERED_COMMANDS = 200;

type TelemetryPlatform = Pick<IPlatformService, "reportArmsCustomEvent" | "reportTelemetryEvent">;

export interface ConversationPromptTelemetrySeed {
  localTtft?: import("@zcode/shared").LocalTtftContext;
  /** Renderer clock at the moment the user triggered the original send action. */
  sendTime: number;
  /** Legacy model / mode / plan fields frozen at the moment of sending. */
  extraDetail: Record<string, string>;
  /**
   * Send funnel correlation ID, pairing send_click ↔ send_result. Produced only by a real click in
   * the composer; background job seeds (off_peak / automation) have no such field, so settling
   * skips them instead of reporting.
   */
  sendClickId?: string;
  /**
   * Whether a queue second-confirmation dialog was involved along the way (for that subset,
   * send_cost_ms includes the user's dwell time).
   */
  queueConfirmed?: boolean;
}

/** Failure reason for the settled send. */
type ConversationSendFailureReason = SendFunnelReasonCode;

interface AcceptedConversationPromptTelemetrySeed extends ConversationPromptTelemetrySeed {
  /**
   * Toggle of the CLI session record; when missing it stays unknown and must not be filled in from
   * the live settings.
   */
  memoryEnabled?: boolean;
  sessionId: string;
  sourceCommandId: string;
  /** The completion source of a standalone background wake is frozen at TurnStarted admission. */
  completionMessageSource?: PromptMessageSource;
}

/**
 * ACK reasonCode of the queue's second confirmation; its meaning is "wait for the user's decision,
 * then reuse the same seed to resend", not a terminal state.
 */
const HELD_QUEUE_CONFIRMATION_STALE_REASON = "guard.heldQueueConfirmationStale";

/**
 * Counted from the send click, exceeding this duration without the user message being rendered
 * counts as a timeout.
 */
const SEND_RENDER_WAIT_TIMEOUT_MS = 30_000;

/**
 * Disposition of the ACK: either switch to waiting for the render (the command was accepted but the
 * user message has not been drawn yet), or settle immediately as a failure. Returning null means
 * that this time neither is done.
 */
type ConversationSendAckOutcome =
  | { kind: "awaitRender"; ackStatus: string }
  | {
      kind: "settle";
      status: "fail";
      ackStatus: string;
      reasonCode: ConversationSendFailureReason;
    };

/**
 * The rule for folding a CommandAck into the disposition of a send_result; returning null means
 * this time does not settle. It is extracted into a pure function so that dispatchCommand is only
 * responsible for calling it and the branch logic can be unit tested.
 */
export function resolveSendAckSettlement(ack: {
  status: string;
  reasonCode?: string;
}): ConversationSendAckOutcome | null {
  // It must be judged before status: the status of this ACK is not accepted.
  // Once settled, first-wins will eat up the real success or failure results after user confirmation.
  if (ack.reasonCode === HELD_QUEUE_CONFIRMATION_STALE_REASON) return null;
  // accepted/duplicate only means that the Host accepted the command, and there is nothing on the screen at this time;
  // Z-code does not have optimistic rendering, and it must wait for the projection to flow back out of the userInput row before it is sent successfully.
  if (ack.status === "accepted" || ack.status === "duplicate") {
    return { kind: "awaitRender", ackStatus: ack.status };
  }
  const reasonCode: ConversationSendFailureReason =
    ack.status === "rejected" || ack.status === "stale" ? ack.status : "failed";
  // Noop does not list reason_code separately, and the user perspective is not sent out; the original value is retained in ackStatus for drill-down.
  return { kind: "settle", status: "fail", ackStatus: ack.status, reasonCode };
}

/**
 * A pending-settlement record: the ACK has been accepted and it is waiting for the user message to
 * be rendered.
 */
interface PendingSendRenderWait {
  seed: ConversationPromptTelemetrySeed;
  sessionId: string | null;
  ackStatus: string;
  ackCostMs: number;
  timer: ReturnType<typeof setTimeout>;
}

function backgroundSeedFromTurnStarted(
  fact: Extract<ConversationTelemetryFact, { kind: "turn.started" }>,
): AcceptedConversationPromptTelemetrySeed | null {
  if (!fact.sourceCommandId) return null;
  if (fact.offPeakTaskId) {
    return {
      sessionId: fact.sessionId,
      sourceCommandId: fact.sourceCommandId,
      sendTime: fact.occurredAt,
      extraDetail: {
        message_source: "off_peak_task",
        off_peak_task_id: fact.offPeakTaskId,
        ...(fact.offPeakRunType ? { off_peak_run_type: fact.offPeakRunType } : {}),
      },
    };
  }
  if (!fact.automationId || !fact.taskTrigger) {
    if (fact.inputSource !== "background_task") return null;
    return {
      sessionId: fact.sessionId,
      sourceCommandId: fact.sourceCommandId,
      sendTime: fact.occurredAt,
      extraDetail: { message_source: "background_task" },
      ...(fact.backgroundSource === "subagent"
        ? { completionMessageSource: "background_subagent" as const }
        : fact.backgroundSource === "workflow"
          ? { completionMessageSource: "background_workflow" as const }
          : {}),
    };
  }
  const scheduledAt = fact.taskTrigger === "schedule" ? fact.scheduledAt : undefined;
  return {
    sessionId: fact.sessionId,
    sourceCommandId: fact.sourceCommandId,
    sendTime: fact.occurredAt,
    extraDetail: {
      message_source: "scheduled_task",
      task_trigger: fact.taskTrigger,
      automation_id: fact.automationId,
      ...(scheduledAt !== undefined
        ? {
            scheduled_at: String(scheduledAt),
            schedule_lag_ms: String(Math.max(0, fact.occurredAt - scheduledAt)),
          }
        : {}),
    },
  };
}

/**
 * Source fields frozen onto each agent_step (same values as the completion). Only the source
 * attribution fields are picked: the model / plan dimensions in the seed are not part of the step
 * contract, and scheduled_at / schedule_lag_ms describe the run as a whole and are only reported
 * with the completion.
 */
const STEP_SOURCE_DETAIL_KEYS = [
  "memory_enabled",
  "message_source",
  "task_trigger",
  "automation_id",
  "off_peak_task_id",
  "off_peak_run_type",
] as const;

function stepSourceDetailOf(extraDetail: Record<string, string>): Record<string, string> {
  const detail: Record<string, string> = {};
  for (const key of STEP_SOURCE_DETAIL_KEYS) {
    const value = extraDetail[key];
    if (value !== undefined) detail[key] = value;
  }
  return detail;
}

interface PromptLifecycle {
  sessionId: string;
  sourceCommandId: string;
  taskKey: string;
  sendTime: number;
  foregroundFirstTokenAt: number | null;
  legacyFirstTokenObserved: boolean;
  turnId?: string;
  active: boolean;
  lastErrorMessage?: string;
  completionMessageSource?: PromptMessageSource;
  hasForegroundSubagentResult: boolean;
  hasBackgroundSubagentResult: boolean;
  /**
   * Notifications of dynamic-workflow runs that this turn consumed (the wf dimension of
   * agent_composition).
   */
  hasWorkflowResult: boolean;
  startedToolCallIds: Set<string>;
  stepSourceDetail: Record<string, string>;
}

interface BufferedFact {
  fact: ConversationTelemetryFact;
  receivedAt: number;
  foregroundAtReceipt: boolean;
}

interface ForegroundSubagentUsage {
  agentId: string;
  parentCommandId: string;
  parentToolCallId: string;
  requestIds: string[];
  requestCount: number;
  modelName: string;
  modelProvider: string;
  providerName: string;
  usage: ZCodeUsage | null;
  stopped: boolean;
  pendingFinalizedSteps: PendingFinalizedStep[];
}

/**
 * The telemetry ledger of one detached sub-session. Shared by both sources:
 * - `background`: the background subagent of the Agent tool, registered from `subagent.lifecycle`,
 *   the terminal state is the sub-session's own `turn.terminal` or `subagent.lifecycle(stopped)`;
 * - `workflow`: a dynamic workflow subagent, registered from `workflow.lifecycle(actor-spawned)`,
 *   the terminal state is **only** `workflow.lifecycle(run-settled)` — each turn.terminal of the
 *   sub-session merely ends one ask.
 */
interface BackgroundSubagentTelemetry {
  kind: "background" | "workflow";
  /**
   * workflow only: the run it belongs to (the tool_call_id of the terminal summary step uses it to
   * close out).
   */
  runId?: string;
  parentSessionId: string;
  sourceCommandId: string;
  parentToolCallId: string;
  childSessionId: string;
  agentId: string;
  taskKey: string;
  stepSourceDetail: Record<string, string>;
  startedToolCallIds: Set<string>;
  usageReported: boolean;
  openToolCallIds: Set<string>;
  startedAt: number;
  requestIds: string[];
  requestCount: number;
  usage: ZCodeUsage | null;
  modelName: string;
  modelProvider: string;
  providerName: string;
}

type FinalizedAgentStep = ReturnType<typeof recordAgentStepTelemetryEvent>[number];

interface PendingFinalizedStep {
  step: FinalizedAgentStep;
  extraDetail?: Record<string, string>;
}

interface DeferredTerminal {
  lifecycle: PromptLifecycle;
  fact: Extract<ConversationTelemetryFact, { kind: "turn.terminal" }>;
  receivedAt: number;
  foregroundAtReceipt: boolean;
}

interface ConversationTelemetryWorkspaceDetail {
  workspace_kind: "local" | "remote";
  remote_kind: RemoteWorkspaceIdentityKind | "";
}

class BoundedKeySet {
  private readonly keys = new Set<string>();

  remember(key: string): boolean {
    if (this.keys.has(key)) {
      return false;
    }
    this.keys.add(key);
    if (this.keys.size > MAX_DEDUPE_KEYS) {
      const oldest = this.keys.values().next().value;
      if (typeof oldest === "string") {
        this.keys.delete(oldest);
      }
    }
    return true;
  }

  clear(): void {
    this.keys.clear();
  }
}

function toLegacyNetworkEvent(
  fact: Extract<ConversationTelemetryFact, { kind: "model.request.status" }>,
): Extract<ZCodeStreamEvent, { type: "task_network_debug_status" }> {
  return {
    type: "task_network_debug_status",
    taskId: fact.sessionId,
    traceId: fact.eventId,
    ...(fact.sourceCommandId ? { inputId: fact.sourceCommandId } : {}),
    ...(fact.queryId ? { queryId: fact.queryId } : {}),
    eventKey: fact.eventId,
    eventId: fact.eventId,
    statusType: fact.status,
    requestId: fact.requestId,
    providerId: fact.providerId,
    modelId: fact.modelId,
    providerKind: fact.providerKind,
    transport: fact.transport,
    // The old entry of messageTelemetry only accepts baseURL; fact has been cut into hostname in advance and repackaged without expanding the privacy aspect.
    baseURL: fact.providerHostname ? `https://${fact.providerHostname}` : undefined,
    querySource: fact.querySource,
    attempt: fact.attempt,
    maxAttempts: fact.maxAttempts,
    nextAttempt: fact.nextAttempt,
    retryable: fact.retryable,
    statusCode: fact.statusCode,
    durationMs: fact.durationMs,
    delayMs: fact.delayMs,
    idleMs: fact.idleMs,
    timeoutMs: fact.timeoutMs,
    reason: fact.reason,
    requestHeaders: {},
    responseHeaders: {},
    requestHeaderCount: 0,
    responseHeaderCount: 0,
  } as Extract<ZCodeStreamEvent, { type: "task_network_debug_status" }>;
}

function scopedSubagentToolCallId(agentId: string, childToolCallId: string): string {
  return `tool_subagent_${agentId}_${childToolCallId}`;
}

/**
 * Steps of a detached sub-session are distinguished by a source prefix: Agent tool subagents use
 * `tool_subagent_`, workflow subagents use `tool_workflow_`.
 */
function scopedChildToolCallId(
  child: BackgroundSubagentTelemetry,
  childToolCallId: string,
): string {
  return child.kind === "workflow"
    ? `tool_workflow_${child.agentId}_${childToolCallId}`
    : scopedSubagentToolCallId(child.agentId, childToolCallId);
}

/**
 * Closing id of the terminal summary step: for a background subagent it is the parent Agent tool
 * call, for a workflow subagent it is the run.
 */
function terminalToolCallIdOf(child: BackgroundSubagentTelemetry): string {
  return child.kind === "workflow"
    ? (child.runId ?? child.parentToolCallId)
    : child.parentToolCallId;
}

function childAgentRole(child: BackgroundSubagentTelemetry): AgentStepRole {
  return child.kind === "workflow" ? "workflow subagent" : "background subagent";
}

/** Attribution fields on the step. */
function childStepExtraDetail(child: BackgroundSubagentTelemetry): Record<string, string> {
  if (child.kind === "workflow") {
    return {
      child_session_id: child.childSessionId,
      ...(child.runId === undefined ? {} : { workflow_run_id: child.runId }),
      ...(child.parentToolCallId === "" ? {} : { workflow_tool_call_id: child.parentToolCallId }),
    };
  }
  return {
    child_session_id: child.childSessionId,
    parent_tool_call_id: child.parentToolCallId,
  };
}

/**
 * Inputs of the terminal summary of a detached sub-session: who triggered it (eventId), success or
 * failure, and the raw error text.
 */
interface DetachedChildTerminalOutcome {
  eventId: string;
  success: boolean;
  errorMessage?: string;
}

function terminalOutcomeOf(
  fact: Extract<ConversationTelemetryFact, { kind: "turn.terminal" | "subagent.lifecycle" }>,
): DetachedChildTerminalOutcome {
  const errorMessage =
    fact.errorMessage ?? (fact.kind === "turn.terminal" ? fact.errorCode : undefined);
  return {
    eventId: fact.eventId,
    success: fact.status === "success" || fact.status === "completed",
    ...(errorMessage === undefined ? {} : { errorMessage }),
  };
}

function toToolLifecycleEvent(input: {
  fact: Extract<ConversationTelemetryFact, { kind: "tool.lifecycle" }>;
  toolId: string;
  inputId?: string;
  hasStarted: boolean;
}): ZCodeStreamEvent {
  const { fact } = input;
  const skillMetadata =
    fact.skillQualifiedName || fact.skillPluginId || fact.skillSource
      ? {
          ...(fact.skillQualifiedName ? { qualifiedName: fact.skillQualifiedName } : {}),
          ...(fact.skillPluginId ? { pluginId: fact.skillPluginId } : {}),
          ...(fact.skillSource ? { source: fact.skillSource } : {}),
        }
      : undefined;
  if (!input.hasStarted && fact.phase !== "completed" && fact.phase !== "failed") {
    return {
      type: "tool_call",
      taskId: fact.sessionId,
      traceId: fact.eventId,
      ...(input.inputId ? { inputId: input.inputId } : {}),
      toolId: input.toolId,
      parentToolUseId: fact.parentToolCallId,
      input: {},
      toolName: fact.toolName,
      kind: fact.toolName ?? "",
      title: "",
      raw: {},
      ...(skillMetadata ? { skillMetadata } : {}),
    } as Extract<ZCodeStreamEvent, { type: "tool_call" }>;
  }
  return {
    type: "tool_call_update",
    taskId: fact.sessionId,
    traceId: fact.eventId,
    ...(input.inputId ? { inputId: input.inputId } : {}),
    toolId: input.toolId,
    parentToolUseId: fact.parentToolCallId,
    status:
      fact.phase === "completed" ? "completed" : fact.phase === "failed" ? "failed" : "in_progress",
    toolName: fact.toolName,
    kind: fact.toolName,
    error: fact.errorMessage,
    raw: {},
    ...(skillMetadata ? { skillMetadata } : {}),
  } as Extract<ZCodeStreamEvent, { type: "tool_call_update" }>;
}

function toUsage(fact: Extract<ConversationTelemetryFact, { kind: "usage.delta" }>): ZCodeUsage {
  return {
    inputTokens: fact.inputTokens,
    outputTokens: fact.outputTokens,
    totalTokens: fact.totalTokens,
    reasoningTokens: fact.reasoningTokens,
    cachedInputTokens: fact.cacheReadTokens,
    cachedWriteInputTokens: fact.cacheWriteTokens,
  };
}

function runtimeTelemetryModelName(providerId: string | undefined, modelId: string | undefined) {
  const provider = providerId?.trim() ?? "";
  const model = modelId?.trim() ?? "";
  if (!provider) return model;
  if (!model) return "";
  return model.includes("/") ? model : `${provider}/${model}`;
}

function mergeUsage(left: ZCodeUsage | null, right: ZCodeUsage): ZCodeUsage {
  if (!left) return { ...right };
  return {
    inputTokens: left.inputTokens + right.inputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    totalTokens: left.totalTokens + right.totalTokens,
    reasoningTokens: (left.reasoningTokens ?? 0) + (right.reasoningTokens ?? 0),
    cachedInputTokens: (left.cachedInputTokens ?? 0) + (right.cachedInputTokens ?? 0),
    cachedWriteInputTokens:
      (left.cachedWriteInputTokens ?? 0) + (right.cachedWriteInputTokens ?? 0),
  };
}

function isToolTimeout(
  fact: Extract<ConversationTelemetryFact, { kind: "tool.lifecycle" }>,
): boolean {
  return fact.errorCode === "tool_timeout" || fact.performance?.timedOut === true;
}

function terminalStatus(
  status: Extract<ConversationTelemetryFact, { kind: "turn.terminal" }>["status"],
): "success" | "fail" | "user_interrupt" {
  if (status === "success") return "success";
  return status === "interrupted" ? "user_interrupt" : "fail";
}

function finiteNumber(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function createSendClickId(): string {
  return (
    globalThis.crypto?.randomUUID?.() ?? `send_${Date.now()}_${Math.random().toString(36).slice(2)}`
  );
}

/**
 * The renderer workspace-level live telemetry state machine.
 *
 * It reads neither rows nor snapshots, and it is not torn down with the pane lease; React is only
 * responsible for attachment and foreground references, and all high-frequency facts enter this
 * imperative object so that streaming does not trigger rendering.
 */
export class ConversationTelemetrySupervisor {
  private readonly platform: TelemetryPlatform;
  private readonly workspaceTelemetryDetail: ConversationTelemetryWorkspaceDetail | null;
  private readonly workspaceScopeKey: string;
  private readonly now: () => number;
  private readonly eventIds = new BoundedKeySet();
  private readonly acceptedCommandIds = new BoundedKeySet();
  private readonly settledSendClickIds = new BoundedKeySet();
  private readonly terminalKeys = new BoundedKeySet();
  private readonly compactionKeys = new BoundedKeySet();
  private readonly foregroundOwnerSessions = new Map<object, string>();
  private readonly foregroundSessionCounts = new Map<string, number>();
  private readonly lifecyclesByCommandId = new Map<string, PromptLifecycle>();
  private readonly activeCommandBySessionId = new Map<string, string>();
  private readonly commandIdByTurnKey = new Map<string, string>();
  private readonly pendingFactsByCommandId = new Map<string, BufferedFact[]>();
  private readonly foregroundSubagentUsageByChildSession = new Map<
    string,
    ForegroundSubagentUsage
  >();
  /** Subagent sessions registered for each in-flight run (settled one by one at run-settled). */
  private readonly workflowActorsByRun = new Map<string, Set<string>>();
  private readonly backgroundSubagentTelemetryByChildSession = new Map<
    string,
    BackgroundSubagentTelemetry
  >();
  private readonly deferredTerminalsByCommandId = new Map<string, DeferredTerminal>();
  private readonly pendingSendRenderWaits = new Map<string, PendingSendRenderWait>();
  private reportTail: Promise<void> | null = null;
  private disposed = false;

  constructor(options: {
    platform: TelemetryPlatform;
    workspaceScopeKey: string;
    workspaceTelemetryDetail?: ConversationTelemetryWorkspaceDetail;
    now?: () => number;
  }) {
    this.platform = options.platform;
    this.workspaceTelemetryDetail = options.workspaceTelemetryDetail ?? null;
    this.workspaceScopeKey = options.workspaceScopeKey;
    this.now = options.now ?? Date.now;
  }

  recordComposerFocus(): void {
    if (this.disposed) return;
    recordComposerFocus(this.workspaceScopeKey, this.now());
  }

  recordComposerTextChange(nextText: string): void {
    if (this.disposed) return;
    recordComposerTextChange(this.workspaceScopeKey, nextText, this.now());
  }

  /**
   * The user genuinely clicks or focuses the input box. Programmatic auto-focus (creating a task,
   * switching sessions, refocusing after mount, refocusing after a context block is removed) is
   * intercepted on the composer side and must not enter this method, otherwise "clicked the input
   * box" would be polluted by session-switching actions. This and recordComposerFocus are two
   * independent chains: the latter only writes a timestamp to feed send_btn, while this method is
   * only responsible for reporting.
   */
  recordComposerFocusClick(input: { sessionId: string | null }): void {
    if (this.disposed) return;
    reportSendFunnelInputFocus({ sessionId: input.sessionId, focusTime: this.now() });
  }

  /**
   * The moment the user clicks the send key / presses Enter to submit and passes the send gate.
   * Returns the seed with sendClickId filled in; the caller must carry it all the way to the settle
   * point so that send_click and send_result stay strictly 1:1. When a queue second confirmation
   * reuses an existing seed this method must not be called again (otherwise one click would report
   * twice).
   */
  recordSendClick(input: {
    sessionId: string | null;
    seed: ConversationPromptTelemetrySeed;
    trigger: "button" | "shortcut";
  }): ConversationPromptTelemetrySeed {
    const seed: ConversationPromptTelemetrySeed = {
      ...input.seed,
      sendClickId: input.seed.sendClickId ?? createSendClickId(),
    };
    if (this.disposed) return seed;
    reportSendFunnelSendClick({
      sessionId: input.sessionId,
      sendClickId: seed.sendClickId ?? "",
      sendTime: input.seed.sendTime,
      trigger: input.trigger,
      extraDetail: input.seed.extraDetail,
    });
    return seed;
  }

  /**
   * Settling of the send (user message rendered, ACK failed, product guard rejected, transport
   * error, wait-for-render timeout). Deduplicated by sendClickId, first-wins: the ACK and the catch
   * may each be invoked once for the same click, and only the first result to arrive counts.
   */
  settleSendResult(input: {
    seed: ConversationPromptTelemetrySeed;
    sessionId: string | null;
    commandId?: string;
    status: "success" | "fail";
    ackStatus?: string;
    reasonCode?: ConversationSendFailureReason;
    /** The "clicked send → received ACK" span; failure paths that never got an ACK do not pass it. */
    ackCostMs?: number;
    /**
     * Overrides the end-to-end duration; only the timeout fallback uses it (at that point now has
     * already passed the 30s limit, so it must be pinned to the threshold).
     */
    costMs?: number;
  }): void {
    if (this.disposed) return;
    const sendClickId = input.seed.sendClickId;
    // The seed of the background automatic task has no click source and cannot be forged to be sent by the user.
    if (!sendClickId || !this.settledSendClickIds.remember(sendClickId)) return;
    reportSendFunnelSendResult({
      sessionId: input.sessionId,
      commandId: input.commandId,
      sendClickId,
      status: input.status,
      ackStatus: input.ackStatus,
      reasonCode: input.reasonCode,
      costMs: input.costMs ?? this.now() - input.seed.sendTime,
      ackCostMs: input.ackCostMs,
      queueConfirmed: input.seed.queueConfirmed === true,
      extraDetail: input.seed.extraDetail,
    });
  }

  /**
   * The ACK is accepted/duplicate: the Host took the command, but the user message has not been
   * drawn on screen yet. Register it as pending render and attach a timeout timer, settling only
   * after whichever of notifyUserInputRendered or the timeout arrives first.
   */
  awaitSendRender(input: {
    seed: ConversationPromptTelemetrySeed;
    sessionId: string | null;
    commandId: string;
    ackStatus: string;
  }): void {
    if (this.disposed) return;
    // Background automatic tasks have no click source; the first time (including its timer) is retained when the same commandId is registered repeatedly.
    if (!input.seed.sendClickId) return;
    if (this.pendingSendRenderWaits.has(input.commandId)) return;
    const ackCostMs = Math.max(0, this.now() - input.seed.sendTime);
    // The timeout is calculated from the time you click to send, so the remaining time will be deducted from the period spent on ACK.
    const remainingMs = Math.max(0, SEND_RENDER_WAIT_TIMEOUT_MS - ackCostMs);
    const timer = setTimeout(() => {
      const wait = this.pendingSendRenderWaits.get(input.commandId);
      if (!wait) return;
      this.pendingSendRenderWaits.delete(input.commandId);
      this.settleSendResult({
        seed: wait.seed,
        sessionId: wait.sessionId,
        commandId: input.commandId,
        status: "fail",
        ackStatus: wait.ackStatus,
        reasonCode: "render_timeout",
        ackCostMs: wait.ackCostMs,
        costMs: SEND_RENDER_WAIT_TIMEOUT_MS,
      });
    }, remainingMs);
    this.pendingSendRenderWaits.set(input.commandId, {
      seed: input.seed,
      sessionId: input.sessionId,
      ackStatus: input.ackStatus,
      ackCostMs,
      timer,
    });
  }

  /**
   * The user message has been rendered into the conversation history (a userInput row flows back
   * from the projection and React has completed the commit). A commandId that was never registered
   * is ignored outright — backfilling historical messages and reloading on session switch both push
   * a whole pile of rows over.
   */
  notifyUserInputRendered(commandId: string): void {
    if (this.disposed) return;
    const wait = this.pendingSendRenderWaits.get(commandId);
    if (!wait) return;
    this.pendingSendRenderWaits.delete(commandId);
    clearTimeout(wait.timer);
    this.settleSendResult({
      seed: wait.seed,
      sessionId: wait.sessionId,
      commandId,
      status: "success",
      ackStatus: wait.ackStatus,
      ackCostMs: wait.ackCostMs,
    });
  }

  /**
   * The seed is only created after ACK=accepted; duplicate/retry/promotion do not report send_btn
   * again.
   */
  acceptPromptSeed(
    seed: AcceptedConversationPromptTelemetrySeed,
    options: { reportSendButton?: boolean } = {},
  ): void {
    if (this.disposed || !this.acceptedCommandIds.remember(seed.sourceCommandId)) {
      return;
    }
    const taskKey = this.taskKey(seed.sessionId);
    const extraDetail = {
      ...seed.extraDetail,
      memory_enabled: seed.memoryEnabled === undefined ? "" : seed.memoryEnabled ? "1" : "0",
    };
    const eventExtraDetail = queuePromptTelemetry({
      workspacePath: this.workspaceScopeKey,
      taskId: taskKey,
      messageId: seed.sourceCommandId,
      sendTime: seed.sendTime,
      extraDetail,
    });
    this.lifecyclesByCommandId.set(seed.sourceCommandId, {
      sessionId: seed.sessionId,
      sourceCommandId: seed.sourceCommandId,
      taskKey,
      sendTime: seed.sendTime,
      foregroundFirstTokenAt: null,
      legacyFirstTokenObserved: false,
      active: false,
      completionMessageSource: seed.completionMessageSource,
      hasForegroundSubagentResult: false,
      hasBackgroundSubagentResult: false,
      hasWorkflowResult: false,
      startedToolCallIds: new Set(),
      stepSourceDetail: stepSourceDetailOf(extraDetail),
    });
    if (this.lifecyclesByCommandId.size > MAX_DEDUPE_KEYS) {
      const oldestInactive = [...this.lifecyclesByCommandId].find(
        ([commandId, lifecycle]) => commandId !== seed.sourceCommandId && !lifecycle.active,
      );
      if (oldestInactive) {
        this.lifecyclesByCommandId.delete(oldestInactive[0]);
        discardQueuedPromptTelemetry(oldestInactive[1].taskKey, oldestInactive[1].sourceCommandId);
      }
    }
    if (options.reportSendButton !== false) {
      this.enqueueReport({
        elementName: "send_btn",
        eventRegion: "app",
        eventType: "ck",
        eventExtraDetail,
        talkId: seed.sessionId,
        messageId: seed.sourceCommandId,
      });
    }
    this.drainPendingFacts(seed.sourceCommandId);
  }

  /**
   * Several panes of the same session being visible still record only one foreground; different
   * sessions can be visible at the same time.
   */
  attachForeground(owner: object, sessionId: string): () => void {
    if (this.disposed) return () => undefined;
    const previous = this.foregroundOwnerSessions.get(owner);
    if (previous === sessionId) return () => this.detachForeground(owner);
    if (previous) this.decrementForeground(previous);
    this.foregroundOwnerSessions.set(owner, sessionId);
    this.foregroundSessionCounts.set(
      sessionId,
      (this.foregroundSessionCounts.get(sessionId) ?? 0) + 1,
    );
    return () => this.detachForeground(owner);
  }

  handleFact(fact: ConversationTelemetryFact): void {
    // The eventId of the main session and detached child are only guaranteed to be unique within their respective sessions;
    // If you only remove duplicates by eventId, the child fact with the same number will be mistakenly killed by the main session fact again in the renderer.
    const eventKey = `${fact.sessionId}\0${fact.eventId}`;
    if (this.disposed || !this.eventIds.remember(eventKey)) {
      return;
    }
    const receivedAt = this.now();
    const foregroundAtReceipt = this.isForeground(fact.sessionId);

    // plan_request only relies on the real model network facts, can be reported to the front and backends, and does not require local prompt seed.
    if (fact.kind === "model.request.status") {
      reportPlanUsageModelRequestStartedToArms(this.platform, toLegacyNetworkEvent(fact));
    }
    if (fact.kind === "subagent.lifecycle") {
      this.handleSubagentLifecycle(fact, receivedAt);
      return;
    }
    if (fact.kind === "workflow.lifecycle") {
      this.handleWorkflowLifecycle(fact, receivedAt);
      return;
    }
    const backgroundSubagent = this.backgroundSubagentTelemetryByChildSession.get(fact.sessionId);
    if (backgroundSubagent) {
      this.handleBackgroundSubagentFact(backgroundSubagent, fact, receivedAt);
      return;
    }
    if (this.shouldIgnoreBackgroundMirror(fact)) {
      return;
    }
    const foregroundSubagent = this.foregroundSubagentUsageByChildSession.get(fact.sessionId);
    if (foregroundSubagent) {
      this.handleForegroundSubagentFact(foregroundSubagent, fact);
      return;
    }
    if (fact.kind === "compaction.terminal") {
      this.handleCompaction(fact, foregroundAtReceipt);
      return;
    }
    if (fact.kind === "turn.started") {
      const backgroundSeed = backgroundSeedFromTurnStarted(fact);
      if (backgroundSeed) {
        // Reason: The background task does not go through renderer ACK; the seed is created using the non-text fact transparently transmitted by Host admission.
        // But you cannot fake send_btn which only represents user clicks.
        this.acceptPromptSeed(
          { ...backgroundSeed, memoryEnabled: fact.memoryEnabled },
          { reportSendButton: false },
        );
      }
    }

    const commandId = this.resolveCommandId(fact);
    if (!commandId) {
      return;
    }
    const lifecycle = this.lifecyclesByCommandId.get(commandId);
    const blockedByDeferredTerminal =
      lifecycle !== undefined &&
      fact.kind === "turn.started" &&
      this.hasDeferredTerminalForTask(lifecycle.taskKey, lifecycle.sourceCommandId);
    if (
      !lifecycle ||
      blockedByDeferredTerminal ||
      (!lifecycle.active && fact.kind !== "turn.started")
    ) {
      this.bufferFact(commandId, { fact, receivedAt, foregroundAtReceipt });
      return;
    }
    this.processPromptFact(lifecycle, fact, receivedAt, foregroundAtReceipt);
    if (fact.kind === "turn.started") {
      this.drainPendingFacts(commandId);
    }
  }

  private handleSubagentLifecycle(
    fact: Extract<ConversationTelemetryFact, { kind: "subagent.lifecycle" }>,
    receivedAt: number,
  ): void {
    if (fact.phase === "spawned") {
      if (fact.background) {
        if (!fact.sourceCommandId || !fact.parentToolCallId) return;
        const parentLifecycle = this.lifecyclesByCommandId.get(fact.sourceCommandId);
        const child: BackgroundSubagentTelemetry = {
          kind: "background",
          parentSessionId: fact.sessionId,
          sourceCommandId: fact.sourceCommandId,
          parentToolCallId: fact.parentToolCallId,
          childSessionId: fact.childSessionId,
          agentId: fact.agentId,
          taskKey: this.taskKey(fact.childSessionId),
          // Child start fact may precede parent message ACK; use same-origin parent session fact directly to avoid missing switches.
          stepSourceDetail: parentLifecycle?.stepSourceDetail ?? {
            memory_enabled: fact.memoryEnabled === undefined ? "" : fact.memoryEnabled ? "1" : "0",
          },
          startedToolCallIds: new Set(),
          usageReported: false,
          openToolCallIds: new Set(),
          startedAt: this.now(),
          requestIds: [],
          requestCount: 0,
          usage: null,
          modelName: "",
          modelProvider: "",
          providerName: "",
        };
        this.backgroundSubagentTelemetryByChildSession.set(fact.childSessionId, child);
        activateDetachedAgentStepTelemetry({
          taskId: child.taskKey,
          messageId: child.sourceCommandId,
          sendTime: fact.occurredAt,
          extraDetail: child.stepSourceDetail,
        });
        return;
      }
      if (!fact.parentToolCallId) return;
      const parentCommandId = this.resolveCommandId(fact);
      if (!parentCommandId) return;
      const lifecycle = this.lifecyclesByCommandId.get(parentCommandId);
      if (!lifecycle?.active) return;
      const child: ForegroundSubagentUsage = {
        agentId: fact.agentId,
        parentCommandId,
        parentToolCallId: fact.parentToolCallId,
        requestIds: [],
        requestCount: 0,
        modelName: "",
        modelProvider: "",
        providerName: "",
        usage: null,
        stopped: false,
        pendingFinalizedSteps: [],
      };
      this.foregroundSubagentUsageByChildSession.set(fact.childSessionId, child);
      this.syncForegroundSubagentToolAttribution(child);
      return;
    }

    const backgroundChild = this.backgroundSubagentTelemetryByChildSession.get(fact.childSessionId);
    if (backgroundChild && fact.background) {
      this.reportBackgroundAgentUsage(backgroundChild, terminalOutcomeOf(fact), receivedAt);
      this.maybeCleanupBackgroundSubagentTelemetry(backgroundChild);
      return;
    }

    const child = this.foregroundSubagentUsageByChildSession.get(fact.childSessionId);
    if (!child) return;
    if (fact.background) {
      child.stopped = true;
      this.reportPendingForegroundSubagentSteps(child, false);
      this.flushDeferredTerminal(child.parentCommandId);
      return;
    }
    // Mirror and lifecycle belong to different event streams. After stopped, you may still receive the child tool that has been sent.
    // final state. Keep the mapping to the parent message end to ensure that late tools can still obtain the child model and agent_id.
    this.syncForegroundSubagentToolAttribution(child);
    child.stopped = true;
    const lifecycle = this.lifecyclesByCommandId.get(child.parentCommandId);
    if (lifecycle) lifecycle.hasForegroundSubagentResult = true;
    this.reportPendingForegroundSubagentSteps(child);
    this.flushDeferredTerminal(child.parentCommandId);
  }

  private handleForegroundSubagentFact(
    child: ForegroundSubagentUsage,
    fact: ConversationTelemetryFact,
  ): void {
    if (fact.kind === "model.request.status") {
      if (fact.status !== "model_request_started") return;
      child.modelName = runtimeTelemetryModelName(fact.providerId, fact.modelId);
      child.modelProvider = fact.providerId;
      child.providerName = fact.providerHostname ?? "";
      this.syncForegroundSubagentToolAttribution(child);
      return;
    }
    if (fact.kind !== "usage.delta") return;

    child.usage = mergeUsage(child.usage, toUsage(fact));
    child.requestCount += 1;
    if (fact.requestId && !child.requestIds.includes(fact.requestId)) {
      child.requestIds.push(fact.requestId);
    }
    // Subagent's runtime model is fixed within a synchronous Agent call; usage fact's request identity
    // Closer to the real provider request than the spawned configuration, so on arrival overwriting the same-origin value from the previous request.
    if (fact.providerId || fact.modelId) {
      child.modelName = runtimeTelemetryModelName(fact.providerId, fact.modelId);
      child.modelProvider = fact.providerId ?? child.modelProvider;
      child.providerName = fact.providerHostname ?? child.providerName;
    }
    this.syncForegroundSubagentToolAttribution(child);
  }

  private syncForegroundSubagentToolAttribution(child: ForegroundSubagentUsage): void {
    const lifecycle = this.lifecyclesByCommandId.get(child.parentCommandId);
    if (!lifecycle?.active) return;
    recordSubagentToolAttribution({
      taskId: lifecycle.taskKey,
      toolCallId: child.parentToolCallId,
      requestIds: child.requestIds,
      requestCount: child.requestCount,
      modelName: child.modelName,
      modelProvider: child.modelProvider,
      providerName: child.providerName,
      agentId: child.agentId,
      ...(child.usage ? { usage: child.usage } : {}),
    });
  }

  private handleBackgroundSubagentFact(
    child: BackgroundSubagentTelemetry,
    fact: ConversationTelemetryFact,
    receivedAt: number,
  ): void {
    switch (fact.kind) {
      case "model.request.status":
        if (child.usageReported) return;
        recordPromptModelRequestStarted(child.taskKey, toLegacyNetworkEvent(fact));
        if (fact.status === "model_request_started") {
          child.modelName = runtimeTelemetryModelName(fact.providerId, fact.modelId);
          child.modelProvider = fact.providerId;
          child.providerName = fact.providerHostname ?? "";
        }
        return;
      case "usage.delta": {
        if (child.usageReported) return;
        if (fact.requestId && child.requestIds.includes(fact.requestId)) return;
        if (fact.requestId) child.requestIds.push(fact.requestId);
        child.requestCount += 1;
        child.usage = mergeUsage(child.usage, toUsage(fact));
        if (fact.providerId || fact.modelId) {
          child.modelName = runtimeTelemetryModelName(fact.providerId, fact.modelId);
          child.modelProvider = fact.providerId ?? child.modelProvider;
          child.providerName = fact.providerHostname ?? child.providerName;
        }
        return;
      }
      case "stream.chunk":
        return;
      case "tool.lifecycle":
        this.handleBackgroundToolLifecycle(child, fact, receivedAt);
        return;
      case "permission.lifecycle": {
        if (child.usageReported && !child.openToolCallIds.has(fact.toolCallId)) return;
        const toolCallId = scopedChildToolCallId(child, fact.toolCallId);
        const requestId = fact.requestId ?? fact.toolCallId;
        if (fact.phase === "requested") {
          recordPromptPermissionRequest({
            taskId: child.taskKey,
            requestId,
            toolCallId,
            now: receivedAt,
          });
        } else {
          recordPromptPermissionResponse({
            taskId: child.taskKey,
            requestId,
            now: receivedAt,
          });
        }
        return;
      }
      case "turn.terminal":
        // The workflow subagent session accepts multiple asks, and each ask is a turn: the final state here is just the end of one ask.
        // Summary step etc. run-settled.
        if (child.kind === "workflow") return;
        this.reportBackgroundAgentUsage(child, terminalOutcomeOf(fact), receivedAt);
        this.cleanupBackgroundSubagentTelemetry(child);
        return;
      case "turn.started":
      case "subagent.lifecycle":
      case "workflow.lifecycle":
      case "compaction.terminal":
        return;
    }
  }

  /**
   * Registration and settlement of dynamic workflow subagents. They share the same detached ledger
   * as background subagents; the differences lie only in the registration facts, the terminal
   * timing, and the attribution fields on the step.
   */
  private handleWorkflowLifecycle(
    fact: Extract<ConversationTelemetryFact, { kind: "workflow.lifecycle" }>,
    receivedAt: number,
  ): void {
    if (fact.phase === "actor-spawned") {
      // Missing anchor point (run before upgrade) or missing sub-session identity: no guessing of ownership, no reporting.
      if (!fact.sourceCommandId || !fact.childSessionId || !fact.agentId) return;
      // resume will send actor-created again; the ledger of the same sub-session is only created once.
      if (this.backgroundSubagentTelemetryByChildSession.has(fact.childSessionId)) return;
      const parentLifecycle = this.lifecyclesByCommandId.get(fact.sourceCommandId);
      const child: BackgroundSubagentTelemetry = {
        kind: "workflow",
        runId: fact.runId,
        parentSessionId: fact.sessionId,
        sourceCommandId: fact.sourceCommandId,
        parentToolCallId: fact.toolCallId ?? "",
        childSessionId: fact.childSessionId,
        agentId: fact.agentId,
        taskKey: this.taskKey(fact.childSessionId),
        // Child start fact may precede parent message ACK; use same-origin parent session fact directly to avoid missing switches.
        stepSourceDetail: parentLifecycle?.stepSourceDetail ?? {
          memory_enabled: fact.memoryEnabled === undefined ? "" : fact.memoryEnabled ? "1" : "0",
        },
        startedToolCallIds: new Set(),
        usageReported: false,
        openToolCallIds: new Set(),
        startedAt: this.now(),
        requestIds: [],
        requestCount: 0,
        usage: null,
        modelName: "",
        modelProvider: "",
        providerName: "",
      };
      this.backgroundSubagentTelemetryByChildSession.set(fact.childSessionId, child);
      const siblings = this.workflowActorsByRun.get(fact.runId) ?? new Set<string>();
      siblings.add(fact.childSessionId);
      this.workflowActorsByRun.set(fact.runId, siblings);
      activateDetachedAgentStepTelemetry({
        taskId: child.taskKey,
        messageId: child.sourceCommandId,
        sendTime: fact.occurredAt,
        extraDetail: child.stepSourceDetail,
      });
      return;
    }

    // run-settled: The final state of all subagents of this run. Each sub-agent has a summary step, and then cleans up the late tools after the final state.
    const actors = this.workflowActorsByRun.get(fact.runId);
    if (!actors) return;
    this.workflowActorsByRun.delete(fact.runId);
    for (const childSessionId of actors) {
      const child = this.backgroundSubagentTelemetryByChildSession.get(childSessionId);
      if (!child) continue;
      this.reportBackgroundAgentUsage(
        child,
        {
          eventId: fact.eventId,
          success: fact.status === "completed",
          ...(fact.errorMessage === undefined ? {} : { errorMessage: fact.errorMessage }),
        },
        receivedAt,
      );
      this.maybeCleanupBackgroundSubagentTelemetry(child);
    }
  }

  private reportBackgroundAgentUsage(
    child: BackgroundSubagentTelemetry,
    outcome: DetachedChildTerminalOutcome,
    receivedAt: number,
  ): void {
    // Bug root cause: Just waiting for the child terminal will miss the failure/cancellation of the preparation phase; stopped must also be resolved.
    // Align the known usage snapshot of the foreground: the first final state is only reported once, and subsequent late usage will not be compensated.
    if (child.usageReported) return;
    child.usageReported = true;
    // No usage does not mean that the call did not occur; the real final state is still reported, and the missing token uses the zero value of the foreground builder.
    const toolId = scopedChildToolCallId(child, terminalToolCallIdOf(child));
    // Root cause of the bug: The background only reports internal tools and discards usage, and lacks the token owner of the foreground outer Agent.
    // Use the shared builder to settle once in the final state of the child; internal tools continue to report items one by one to avoid repeated calculation of the same token.
    recordAgentStepTelemetryEvent({
      taskId: child.taskKey,
      event: {
        type: "tool_call",
        taskId: child.childSessionId,
        traceId: outcome.eventId,
        toolId,
        toolName: "Agent",
        kind: "Agent",
        input: {},
        title: "Agent",
        raw: {},
      },
      now: child.startedAt,
    });
    recordSubagentToolAttribution({
      taskId: child.taskKey,
      toolCallId: toolId,
      agentId: child.agentId,
      agentRole: childAgentRole(child),
      requestIds: child.requestIds,
      requestCount: child.requestCount,
      modelName: child.modelName,
      modelProvider: child.modelProvider,
      providerName: child.providerName,
      ...(child.usage ? { usage: child.usage } : {}),
    });
    const finalized = recordAgentStepTelemetryEvent({
      taskId: child.taskKey,
      event: {
        type: "tool_call_update",
        taskId: child.childSessionId,
        traceId: outcome.eventId,
        toolId,
        toolName: "Agent",
        kind: "Agent",
        raw: {},
        status: outcome.success ? "completed" : "failed",
        error: outcome.errorMessage,
      },
      now: receivedAt,
    });
    this.reportBackgroundFinalizedSteps(child, finalized, childStepExtraDetail(child));
  }

  private handleBackgroundToolLifecycle(
    child: BackgroundSubagentTelemetry,
    fact: Extract<ConversationTelemetryFact, { kind: "tool.lifecycle" }>,
    receivedAt: number,
  ): void {
    // After stopped, only started tools are drained to avoid replay/late events from recreating closed steps.
    if (child.usageReported && !child.openToolCallIds.has(fact.toolCallId)) return;
    const hasStarted = child.startedToolCallIds.has(fact.toolCallId);
    child.startedToolCallIds.add(fact.toolCallId);
    const isTerminal = fact.phase === "completed" || fact.phase === "failed";
    if (isTerminal) {
      child.openToolCallIds.delete(fact.toolCallId);
    } else {
      child.openToolCallIds.add(fact.toolCallId);
    }
    const finalized = recordAgentStepTelemetryEvent({
      taskId: child.taskKey,
      event: toToolLifecycleEvent({
        fact,
        toolId: scopedChildToolCallId(child, fact.toolCallId),
        hasStarted,
      }),
      clientMode: "desktop-continuous",
      toolAttribution: {
        agentId: child.agentId,
        agentRole: childAgentRole(child),
      },
      now: receivedAt,
    });
    const extraDetail = {
      ...childStepExtraDetail(child),
      ...(fact.automationId ? { automation_id: fact.automationId } : {}),
    };
    this.reportBackgroundFinalizedSteps(child, finalized, extraDetail);
    if (isTerminal) this.maybeCleanupBackgroundSubagentTelemetry(child);
  }

  private reportBackgroundFinalizedSteps(
    child: BackgroundSubagentTelemetry,
    finalized: ReturnType<typeof recordAgentStepTelemetryEvent>,
    extraDetail: Record<string, string>,
  ): void {
    for (const step of finalized) {
      this.enqueueReport({
        elementName: "agent_step",
        eventRegion: "app",
        eventType: "agent_trace",
        eventExtraDetail: this.withWorkspaceTelemetryDetail({
          ...child.stepSourceDetail,
          ...step.eventExtraDetail,
          ...extraDetail,
        }),
        talkId: child.parentSessionId,
        messageId: child.sourceCommandId,
      });
    }
  }

  private cleanupBackgroundSubagentTelemetry(child: BackgroundSubagentTelemetry): void {
    discardPromptTelemetry(child.taskKey);
    this.backgroundSubagentTelemetryByChildSession.delete(child.childSessionId);
  }

  private maybeCleanupBackgroundSubagentTelemetry(child: BackgroundSubagentTelemetry): void {
    // Summary reporting is separated from tool emptying: stopped will no longer lose summaries, nor will it lose late final states of started tools.
    if (child.usageReported && child.openToolCallIds.size === 0) {
      this.cleanupBackgroundSubagentTelemetry(child);
    }
  }

  private reportPendingForegroundSubagentSteps(
    child: ForegroundSubagentUsage,
    applyAttribution = true,
  ): void {
    const lifecycle = this.lifecyclesByCommandId.get(child.parentCommandId);
    if (!lifecycle?.active) return;
    for (const pending of child.pendingFinalizedSteps.splice(0)) {
      if (applyAttribution) this.applyForegroundSubagentAttribution(pending.step, child);
      this.reportFinalizedSteps(lifecycle, [pending.step], pending.extraDetail);
    }
  }

  private applyForegroundSubagentAttribution(
    step: FinalizedAgentStep,
    child: ForegroundSubagentUsage,
  ): void {
    const detail = step.eventExtraDetail;
    detail.agent_id = child.agentId;
    if (child.modelName || child.modelProvider || child.providerName) {
      detail.model_name = legacyTelemetryModelValue(child.modelName);
      detail.model_provider = legacyTelemetryProviderId(child.modelProvider);
      detail.provider_name = child.providerName;
    }
    if (!child.usage) return;
    detail.model_request_id = child.requestIds.length === 1 ? (child.requestIds[0] ?? "") : "";
    detail.model_request_count = String(child.requestCount);
    detail.token_usage_scope = "subagent_requests";
    detail.input_tokens = String(child.usage.inputTokens);
    detail.output_tokens = String(child.usage.outputTokens);
    detail.reasoning_tokens = String(child.usage.reasoningTokens ?? 0);
    detail.cached_tokens = String(child.usage.cachedInputTokens ?? 0);
    detail.cache_write_input_tokens = String(child.usage.cachedWriteInputTokens ?? 0);
    detail.total_tokens = String(child.usage.totalTokens);
  }

  private flushDeferredTerminal(commandId: string): void {
    const deferred = this.deferredTerminalsByCommandId.get(commandId);
    if (
      !deferred ||
      [...this.foregroundSubagentUsageByChildSession.values()].some(
        (child) => child.parentCommandId === commandId && !child.stopped,
      )
    ) {
      return;
    }
    this.deferredTerminalsByCommandId.delete(commandId);
    this.handleTerminal(
      deferred.lifecycle,
      deferred.fact,
      deferred.receivedAt,
      deferred.foregroundAtReceipt,
    );
  }

  reportVisibleChatError(params: {
    surface?: ChatErrorBannerSurface;
    errorKey?: string | null;
    displayMessage: string;
    error: ZCodeUiError;
  }): void {
    if (this.disposed) return;
    void reportChatErrorBannerTelemetry(this.platform, {
      ...params,
      providerBusinessRecoveryAction: resolveVisibleChatErrorTelemetryRecoveryAction(params.error),
    });
  }

  /** Observed only by the bounded-cache unit tests; no business logic depends on this value. */
  getPendingCommandCountForTest(): number {
    return this.pendingFactsByCommandId.size;
  }

  /** Used only by focused tests to wait for the serial reporter to drain. */
  async flushReportsForTest(): Promise<void> {
    await this.reportTail;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const lifecycle of this.lifecyclesByCommandId.values()) {
      clearStreamStallTracking(lifecycle.taskKey);
      discardPromptTelemetry(lifecycle.taskKey);
    }
    for (const child of this.backgroundSubagentTelemetryByChildSession.values()) {
      discardPromptTelemetry(child.taskKey);
    }
    // If the timer to be rendered is unclear, it will continue to run after uninstallation, resulting in a batch of meaningless render_timeouts.
    for (const wait of this.pendingSendRenderWaits.values()) {
      clearTimeout(wait.timer);
    }
    this.pendingSendRenderWaits.clear();
    this.eventIds.clear();
    this.acceptedCommandIds.clear();
    this.settledSendClickIds.clear();
    this.terminalKeys.clear();
    this.compactionKeys.clear();
    this.foregroundSubagentUsageByChildSession.clear();
    this.backgroundSubagentTelemetryByChildSession.clear();
    this.workflowActorsByRun.clear();
    this.deferredTerminalsByCommandId.clear();
    this.foregroundOwnerSessions.clear();
    this.foregroundSessionCounts.clear();
    this.lifecyclesByCommandId.clear();
    this.activeCommandBySessionId.clear();
    this.commandIdByTurnKey.clear();
    this.pendingFactsByCommandId.clear();
  }

  private enqueueReport(payload: Parameters<typeof reportAppTelemetryEvent>[1]): void {
    const report = () =>
      reportAppTelemetryEvent(this.platform, payload, "v4-conversation-telemetry");
    // Reason for repair: Although the renderer initiation sequence is step → completion, the two asynchronous IPCs will be executed in main
    // Executed concurrently, net.fetch eventually reverses the order occasionally. Serialize the final reporter within the workspace supervisor,
    // At the same time, keep the first one initiated immediately to avoid additional delay of send_btn.
    const queued = this.reportTail ? this.reportTail.then(report) : report();
    this.reportTail = queued;
    void queued.then(() => {
      if (this.reportTail === queued) this.reportTail = null;
    });
  }

  private withWorkspaceTelemetryDetail(detail: Record<string, string>): Record<string, string> {
    return this.workspaceTelemetryDetail ? { ...detail, ...this.workspaceTelemetryDetail } : detail;
  }

  private taskKey(sessionId: string): string {
    return `${this.workspaceScopeKey}\u0000${sessionId}`;
  }

  private isForeground(sessionId: string): boolean {
    return (this.foregroundSessionCounts.get(sessionId) ?? 0) > 0;
  }

  private shouldIgnoreBackgroundMirror(fact: ConversationTelemetryFact): boolean {
    if (fact.kind !== "tool.lifecycle" && fact.kind !== "permission.lifecycle") return false;
    return (
      fact.background === true &&
      (!fact.childSessionId || !this.foregroundSubagentUsageByChildSession.has(fact.childSessionId))
    );
  }

  private detachForeground(owner: object): void {
    const sessionId = this.foregroundOwnerSessions.get(owner);
    if (!sessionId) return;
    this.foregroundOwnerSessions.delete(owner);
    this.decrementForeground(sessionId);
  }

  private decrementForeground(sessionId: string): void {
    const next = (this.foregroundSessionCounts.get(sessionId) ?? 1) - 1;
    if (next > 0) {
      this.foregroundSessionCounts.set(sessionId, next);
      return;
    }
    this.foregroundSessionCounts.delete(sessionId);
    // The wall clock time during the switch cannot be misjudged as stream stall the next time you return to the front desk.
    clearStreamStallTracking(this.taskKey(sessionId));
  }

  private resolveCommandId(fact: ConversationTelemetryFact): string | undefined {
    if (fact.sourceCommandId) return fact.sourceCommandId;
    return fact.turnId
      ? this.commandIdByTurnKey.get(`${fact.sessionId}\u0000${fact.turnId}`)
      : this.activeCommandBySessionId.get(fact.sessionId);
  }

  private bufferFact(commandId: string, buffered: BufferedFact): void {
    const current = this.pendingFactsByCommandId.get(commandId) ?? [];
    current.push(buffered);
    if (current.length > MAX_BUFFERED_FACTS_PER_COMMAND) {
      // When ACK is extremely slow, only ordinary subsequent chunks are prioritized; turn.started, firstChunk, real model status, tools and
      // Terminals are life cycle anchors for old indicators and cannot be squeezed out by high-frequency text.
      const ordinaryChunkIndex = current.findIndex(
        (item) => item.fact.kind === "stream.chunk" && !item.fact.firstChunk,
      );
      const removableIndex =
        ordinaryChunkIndex >= 0
          ? ordinaryChunkIndex
          : current.findIndex((item) => item.fact.kind !== "turn.started");
      current.splice(removableIndex >= 0 ? removableIndex : 0, 1);
    }
    // The insertion order of the Map is LRU: when the command is hit, delete it first and then write it back, ensuring that the entire group that has not received the fact for the longest time is eliminated first.
    this.pendingFactsByCommandId.delete(commandId);
    this.pendingFactsByCommandId.set(commandId, current);
    if (this.pendingFactsByCommandId.size > MAX_BUFFERED_COMMANDS) {
      const oldestCommandId = this.pendingFactsByCommandId.keys().next().value;
      if (typeof oldestCommandId === "string") {
        this.pendingFactsByCommandId.delete(oldestCommandId);
      }
    }
  }

  private drainPendingFacts(commandId: string): void {
    const lifecycle = this.lifecyclesByCommandId.get(commandId);
    const pending = this.pendingFactsByCommandId.get(commandId);
    if (!lifecycle || !pending || pending.length === 0) return;
    this.pendingFactsByCommandId.delete(commandId);
    for (const item of pending) {
      if (!this.lifecyclesByCommandId.has(commandId)) return;
      if (
        item.fact.kind === "turn.started" &&
        this.hasDeferredTerminalForTask(lifecycle.taskKey, lifecycle.sourceCommandId)
      ) {
        this.bufferFact(commandId, item);
        continue;
      }
      if (!lifecycle.active && item.fact.kind !== "turn.started") {
        this.bufferFact(commandId, item);
        continue;
      }
      this.processPromptFact(lifecycle, item.fact, item.receivedAt, item.foregroundAtReceipt);
    }
  }

  private hasDeferredTerminalForTask(taskKey: string, exceptCommandId?: string): boolean {
    return [...this.deferredTerminalsByCommandId].some(
      ([commandId, deferred]) =>
        commandId !== exceptCommandId && deferred.lifecycle.taskKey === taskKey,
    );
  }

  private drainPromptBlockedByDeferredTerminal(taskKey: string): void {
    if (this.hasDeferredTerminalForTask(taskKey)) return;
    const nextLifecycle = [...this.lifecyclesByCommandId.values()]
      .filter(
        (candidate) =>
          candidate.taskKey === taskKey &&
          !candidate.active &&
          this.pendingFactsByCommandId
            .get(candidate.sourceCommandId)
            ?.some((item) => item.fact.kind === "turn.started"),
      )
      .sort((left, right) => left.sendTime - right.sendTime)[0];
    if (nextLifecycle) this.drainPendingFacts(nextLifecycle.sourceCommandId);
  }

  private processPromptFact(
    lifecycle: PromptLifecycle,
    fact: ConversationTelemetryFact,
    receivedAt: number,
    foregroundAtReceipt: boolean,
  ): void {
    switch (fact.kind) {
      case "turn.started":
        lifecycle.active = true;
        lifecycle.turnId = fact.turnId;
        this.activeCommandBySessionId.set(fact.sessionId, lifecycle.sourceCommandId);
        if (fact.turnId) {
          this.commandIdByTurnKey.set(
            `${fact.sessionId}\u0000${fact.turnId}`,
            lifecycle.sourceCommandId,
          );
        }
        activatePromptTelemetry(lifecycle.taskKey, lifecycle.sourceCommandId);
        return;

      case "model.request.status": {
        const legacyEvent = toLegacyNetworkEvent(fact);
        recordPromptModelRequestStarted(lifecycle.taskKey, legacyEvent, lifecycle.sourceCommandId);
        if (fact.status === "model_request_failed") {
          lifecycle.lastErrorMessage = fact.reason;
        }
        return;
      }

      case "stream.chunk": {
        lifecycle.legacyFirstTokenObserved = true;
        if (foregroundAtReceipt && lifecycle.foregroundFirstTokenAt === null) {
          lifecycle.foregroundFirstTokenAt = receivedAt;
        }
        const legacyEvent = {
          type: fact.channel === "thought" ? "agent_thought_chunk" : "agent_message_chunk",
          taskId: fact.sessionId,
          traceId: fact.eventId,
          inputId: lifecycle.sourceCommandId,
          content: "",
          ...(fact.channel === "text" && fact.assistantMessageId
            ? { messageId: fact.assistantMessageId }
            : {}),
          ...(fact.parentToolCallId ? { parentToolUseId: fact.parentToolCallId } : {}),
        } as Extract<ZCodeStreamEvent, { type: "agent_thought_chunk" | "agent_message_chunk" }>;
        this.reportFinalizedSteps(
          lifecycle,
          recordAgentStepTelemetryEvent({
            taskId: lifecycle.taskKey,
            event: legacyEvent,
            activeInputId: lifecycle.sourceCommandId,
            clientMode: "desktop-continuous",
            now: receivedAt,
          }),
        );
        if (foregroundAtReceipt) {
          recordStreamChunkArrival(lifecycle.taskKey, {
            now: receivedAt,
            talkId: fact.sessionId,
            waitingTool: false,
            model: getActivePromptModelName(lifecycle.taskKey),
            messageId: fact.assistantMessageId,
            chunkType: fact.channel === "thought" ? "thought" : "message",
          });
        }
        return;
      }

      case "tool.lifecycle":
        this.handleToolLifecycle(lifecycle, fact, receivedAt, foregroundAtReceipt);
        return;

      case "permission.lifecycle": {
        const requestId = fact.requestId ?? fact.toolCallId;
        if (fact.phase === "requested") {
          recordPromptPermissionRequest({
            taskId: lifecycle.taskKey,
            requestId,
            toolCallId: fact.toolCallId,
            now: receivedAt,
          });
        } else {
          recordPromptPermissionResponse({
            taskId: lifecycle.taskKey,
            requestId,
            now: receivedAt,
          });
        }
        return;
      }

      case "usage.delta":
        recordPromptTokenUsageDelta({
          taskId: lifecycle.taskKey,
          eventKey: fact.eventId,
          usage: toUsage(fact),
          requestId: fact.requestId,
          modelName: runtimeTelemetryModelName(fact.providerId, fact.modelId),
          modelProvider: fact.providerId,
          providerName: fact.providerHostname,
        });
        return;

      case "turn.terminal":
        // The active-loop does not have an independent TurnStarted; the current composition is updated after the consumption fact arrives with the final state.
        if (fact.backgroundSubagentResultConsumed) {
          lifecycle.hasBackgroundSubagentResult = true;
        }
        if (fact.workflowResultConsumed) {
          lifecycle.hasWorkflowResult = true;
        }
        this.handleTerminal(lifecycle, fact, receivedAt, foregroundAtReceipt);
        return;

      case "compaction.terminal":
      case "workflow.lifecycle":
        return;
    }
  }

  private handleToolLifecycle(
    lifecycle: PromptLifecycle,
    fact: Extract<ConversationTelemetryFact, { kind: "tool.lifecycle" }>,
    receivedAt: number,
    foregroundAtReceipt: boolean,
  ): void {
    lifecycle.legacyFirstTokenObserved = true;
    if (foregroundAtReceipt && lifecycle.foregroundFirstTokenAt === null) {
      lifecycle.foregroundFirstTokenAt = receivedAt;
    }
    clearStreamStallTracking(lifecycle.taskKey);
    const child =
      fact.childSessionId !== undefined
        ? this.foregroundSubagentUsageByChildSession.get(fact.childSessionId)
        : undefined;
    const agentId = fact.agentId ?? child?.agentId;
    const toolAttribution =
      agentId || child
        ? {
            ...(agentId ? { agentId } : {}),
            ...(child?.modelName ? { modelName: child.modelName } : {}),
            ...(child?.modelProvider ? { modelProvider: child.modelProvider } : {}),
            ...(child?.providerName ? { providerName: child.providerName } : {}),
          }
        : undefined;
    const hasStarted = lifecycle.startedToolCallIds.has(fact.toolCallId);
    lifecycle.startedToolCallIds.add(fact.toolCallId);
    const event = toToolLifecycleEvent({
      fact,
      toolId: fact.toolCallId,
      inputId: lifecycle.sourceCommandId,
      hasStarted,
    });
    const finalized = recordAgentStepTelemetryEvent({
      taskId: lifecycle.taskKey,
      event,
      activeInputId: lifecycle.sourceCommandId,
      clientMode: "desktop-continuous",
      ...(toolAttribution ? { toolAttribution } : {}),
      now: receivedAt,
    });
    const extraDetail = fact.automationId ? { automation_id: fact.automationId } : undefined;
    const isTerminal = fact.phase === "completed" || fact.phase === "failed";
    const foregroundChild = isTerminal
      ? [...this.foregroundSubagentUsageByChildSession.values()].find(
          (candidate) =>
            candidate.parentCommandId === lifecycle.sourceCommandId &&
            candidate.parentToolCallId === fact.toolCallId,
        )
      : undefined;
    if (foregroundChild && !foregroundChild.stopped) {
      const timeoutWon = isToolTimeout(fact);
      const immediate: FinalizedAgentStep[] = [];
      for (const step of finalized) {
        if (step.eventExtraDetail.tool_call_id === fact.toolCallId) {
          if (timeoutWon) {
            this.applyForegroundSubagentAttribution(step, foregroundChild);
            immediate.push(step);
          } else {
            // Bug root cause: The final state of the parent Agent tool may be earlier than the child usage. Non-timeout final states continue to freeze,
            // Wait for Runtime's SubagentStopped to backfill with the child's final cumulative value to avoid losing tokens.
            foregroundChild.pendingFinalizedSteps.push({ step, extraDetail });
          }
        } else {
          immediate.push(step);
        }
      }
      this.reportFinalizedSteps(lifecycle, immediate, extraDetail);
      if (timeoutWon) {
        // The outer Agent timeout is the real final state of Runtime; with SubagentStopped, whoever arrives first will stop.
        // No more waiting for telemetry grace, late stopped will only hit the completed life cycle.
        foregroundChild.stopped = true;
        this.flushDeferredTerminal(foregroundChild.parentCommandId);
      }
    } else {
      this.reportFinalizedSteps(lifecycle, finalized, extraDetail);
    }
    if (fact.errorMessage) lifecycle.lastErrorMessage = fact.errorMessage;

    const performance = fact.performance;
    if (
      !foregroundAtReceipt ||
      !isTerminal ||
      !performance ||
      Object.keys(performance).length === 0
    ) {
      return;
    }
    reportUiToolCallDetail({
      toolName: fact.toolName,
      status: fact.phase === "completed" ? "completed" : "failed",
      talkId: fact.sessionId,
      messageId: getActivePromptMessageId(lifecycle.taskKey),
      toolCallId: fact.toolCallId,
      parentToolCallId: fact.parentToolCallId,
      childSessionId: fact.childSessionId,
      childToolCallId: fact.childToolCallId,
      agentId: fact.agentId,
      agentType: fact.agentType,
      totalMs: performance.totalMs ?? fact.durationMs,
      permissionWaitMs: performance.permissionWaitMs,
      commandRunMs: performance.commandRunMs,
      firstOutputMs: performance.firstOutputMs,
      noOutputMs: performance.noOutputMs,
      exitCode: performance.exitCode,
      timedOut: performance.timedOut,
      outputBytes: performance.outputBytes,
      commandCategory: performance.commandCategory,
      commandName: performance.commandName,
      commandCount: performance.commandCount,
      commandStatus: performance.commandStatus,
      fsReadMs: performance.fsReadMs,
      fsWriteMs: performance.fsWriteMs,
      patchMatchMs: performance.patchMatchMs,
      fileCount: performance.fileCount,
      totalBytes: performance.totalBytes,
      maxFileBytes: performance.maxFileBytes,
      hunkCount: performance.hunkCount,
      matchAttempts: performance.matchAttempts,
      workspaceKind: performance.workspaceKind,
    });
  }

  private handleTerminal(
    lifecycle: PromptLifecycle,
    fact: Extract<ConversationTelemetryFact, { kind: "turn.terminal" }>,
    receivedAt: number,
    foregroundAtReceipt: boolean,
  ): void {
    const hasRunningForegroundChild = [...this.foregroundSubagentUsageByChildSession.values()].some(
      (child) => child.parentCommandId === lifecycle.sourceCommandId && !child.stopped,
    );
    if (hasRunningForegroundChild) {
      if (this.deferredTerminalsByCommandId.has(lifecycle.sourceCommandId)) return;
      // The normal sequence for the same parent stream is Agent tool terminal -> turn terminal. Only dealt with here
      // Transport reverse order: wait for real SubagentStopped or Agent tool terminal, both of which can be flushed immediately.
      this.deferredTerminalsByCommandId.set(lifecycle.sourceCommandId, {
        lifecycle,
        fact,
        receivedAt,
        foregroundAtReceipt,
      });
      return;
    }
    const terminalKey = `${fact.sessionId}\u0000${lifecycle.sourceCommandId}\u0000message_completion`;
    if (!this.terminalKeys.remember(terminalKey)) return;
    const status = terminalStatus(fact.status);
    const terminalEvent = // Reason for repair: The old adapter projects all TurnComplete (including canceled) into
      // task_complete; the UI then separately marks completion as user_interrupt.
      (
        fact.status === "success" || fact.resultType !== undefined
          ? {
              type: "task_complete",
              taskId: fact.sessionId,
              traceId: fact.eventId,
              inputId: lifecycle.sourceCommandId,
              stopReason: fact.resultType ?? "complete",
            }
          : {
              type: "task_error",
              taskId: fact.sessionId,
              traceId: fact.eventId,
              inputId: lifecycle.sourceCommandId,
              error: fact.errorMessage ?? lifecycle.lastErrorMessage ?? fact.errorCode ?? "",
              code: fact.errorCode,
            }
      ) as Extract<ZCodeStreamEvent, { type: "task_complete" | "task_error" }>;
    this.reportFinalizedSteps(
      lifecycle,
      recordAgentStepTelemetryEvent({
        taskId: lifecycle.taskKey,
        event: terminalEvent,
        activeInputId: lifecycle.sourceCommandId,
        clientMode: "desktop-continuous",
        now: receivedAt,
      }),
    );
    const completion = finalizePromptTelemetry({
      taskId: lifecycle.taskKey,
      status,
      finishedAt: receivedAt,
      errorType: fact.errorCode,
      errorMsg: fact.errorMessage ?? lifecycle.lastErrorMessage,
      ...(lifecycle.completionMessageSource
        ? { messageSource: lifecycle.completionMessageSource }
        : {}),
      agentComposition: composeAgentComposition(lifecycle),
    });
    if (completion) {
      this.enqueueReport({
        elementName: "message_completion",
        eventRegion: "app",
        eventType: "agent_trace",
        // Reason for fix: workspace scene dimension must appear together with completion/step in the final report.
        // You cannot just stay at the isolation key of the attachment, otherwise the data warehouse cannot distinguish between local and remote conversations.
        eventExtraDetail: this.withWorkspaceTelemetryDetail(completion.eventExtraDetail),
        talkId: fact.sessionId,
        messageId: lifecycle.sourceCommandId,
      });
      if (foregroundAtReceipt) {
        this.reportCompletionArms(
          fact.sessionId,
          lifecycle.sourceCommandId,
          completion.eventExtraDetail,
          lifecycle.foregroundFirstTokenAt === null
            ? lifecycle.legacyFirstTokenObserved
              ? undefined
              : -1
            : lifecycle.foregroundFirstTokenAt - lifecycle.sendTime,
        );
      }
    }
    clearStreamStallTracking(lifecycle.taskKey);
    this.deferredTerminalsByCommandId.delete(lifecycle.sourceCommandId);
    // finalize has cleared the current active; subsequent queued seeds in the same session still need to wait for promotion, and the entire task cannot be discarded.
    this.activeCommandBySessionId.delete(fact.sessionId);
    this.lifecyclesByCommandId.delete(lifecycle.sourceCommandId);
    if (lifecycle.turnId) {
      this.commandIdByTurnKey.delete(`${fact.sessionId}\u0000${lifecycle.turnId}`);
    }
    for (const [childSessionId, child] of this.foregroundSubagentUsageByChildSession) {
      if (child.parentCommandId === lifecycle.sourceCommandId) {
        this.foregroundSubagentUsageByChildSession.delete(childSessionId);
      }
    }
    this.drainPromptBlockedByDeferredTerminal(lifecycle.taskKey);
  }

  private reportCompletionArms(
    sessionId: string,
    sourceCommandId: string,
    detail: Record<string, string>,
    foregroundTtftMs: number | undefined,
  ): void {
    if (foregroundTtftMs !== undefined) {
      reportUiFirstToken({
        ttftMs: foregroundTtftMs,
        model: detail.model_name || undefined,
        talkId: sessionId,
        messageId: sourceCommandId,
      });
      reportPlanUsageTtftToArms(this.platform, {
        providerId: detail.model_provider,
        modelName: detail.model_name,
        askMode: detail.ask_mode,
        ttftMs: foregroundTtftMs,
      });
    }
    const durationMs = finiteNumber(detail.duration_ms);
    if (durationMs === undefined) return;
    reportUiMessageComplete({
      durationMs,
      result: detail.status ?? "",
      model: detail.model_name || undefined,
      talkId: sessionId,
      messageId: sourceCommandId,
    });
    reportUiTurnBreakdown({
      durationMs,
      result: detail.status ?? "",
      model: detail.model_name || undefined,
      talkId: sessionId,
      messageId: sourceCommandId,
      ttftMs: foregroundTtftMs,
      waitingMs: finiteNumber(detail.waiting_ms),
      toolCallTotal: finiteNumber(detail.tool_call_total),
      toolCallFailed: finiteNumber(detail.tool_call_failed),
      agentStepCount: finiteNumber(detail.agent_step_cnt),
      retryCount: finiteNumber(detail.retry_cnt),
      fileChangeCount: finiteNumber(detail.file_change_cnt),
      generatedCodeLines: finiteNumber(detail.generated_code_lines),
    });
  }

  private reportFinalizedSteps(
    lifecycle: PromptLifecycle,
    finalized: ReturnType<typeof recordAgentStepTelemetryEvent>,
    extraDetail?: Record<string, string>,
  ): void {
    for (const step of finalized) {
      this.enqueueReport({
        elementName: "agent_step",
        eventRegion: "app",
        eventType: "agent_trace",
        eventExtraDetail: this.withWorkspaceTelemetryDetail({
          ...lifecycle.stepSourceDetail,
          ...step.eventExtraDetail,
          ...extraDetail,
        }),
        talkId: lifecycle.sessionId,
        messageId: lifecycle.sourceCommandId,
      });
    }
  }

  private handleCompaction(
    fact: Extract<ConversationTelemetryFact, { kind: "compaction.terminal" }>,
    foregroundAtReceipt: boolean,
  ): void {
    const dedupeKey = `${fact.sessionId}\u0000${fact.operationId}\u0000context_compaction`;
    if (!this.compactionKeys.remember(dedupeKey)) return;
    // Compaction only determines whether the terminal is in the foreground at the moment it arrives; switching back to the background after arriving in the background cannot make up for the report.
    if (!foregroundAtReceipt) return;
    const timeline: ZCodeContextCompactionTimelineMeta = {
      version: 1,
      kind: "synthetic",
      type: "context_compaction",
      operationId: fact.operationId,
      status: fact.status,
      trigger: fact.trigger,
      display: "separator",
      reason: fact.reason,
      summaryMessageId: fact.summaryMessageId,
      preCompactTokenCount: fact.preCompactTokenCount,
      postCompactTokenCount: fact.postCompactTokenCount,
      truePostCompactTokenCount: fact.truePostCompactTokenCount,
      attempt: fact.attempt,
      maxAttempts: fact.maxAttempts,
      startedAt: fact.startedAt,
      endedAt: fact.endedAt,
    };
    const eventExtraDetail = buildCompactionTelemetryExtraDetail({
      timeline,
      modelName: resolveLegacyRuntimeModelValue({
        configProvider: fact.modelProvider,
        modelName: fact.modelName,
      }),
      modelProvider: fact.modelProvider,
    });
    if (!eventExtraDetail) return;
    this.enqueueReport({
      elementName: "context_compaction",
      eventRegion: "app",
      eventType: "agent_trace",
      eventExtraDetail,
      talkId: fact.sessionId,
      messageId: fact.summaryMessageId ?? fact.operationId,
    });
  }
}
