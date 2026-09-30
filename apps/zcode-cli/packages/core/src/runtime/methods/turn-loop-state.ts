import type {
  CompactPhase,
  CompactReason,
  MessageId,
  ModelStreamRecoveryStatus,
  Model,
  OutputStylePromptConfig,
  SessionEvent,
  TraceContext,
  TraceId,
  TurnId,
} from "../deps.js";
import type { ActiveTurnSteeringState } from "../types.js";
import type { SubagentRunOptions } from "@zcode/contracts";
import type { DrainedPendingInputDiagnostics } from "../types.js";
import type { TurnMachineImpl } from "../deps.js";
import type { RuntimeMessageEntry } from "../../agent/message-history.js";

export type PendingStreamRecoveryRequest = ModelStreamRecoveryStatus;

export const RAPID_REFILL_TOOL_TURN_THRESHOLD = 3;
export const MAX_CONSECUTIVE_RAPID_REFILLS = 3;
export const AUTOMATION_MUTATION_TOOL_NAMES = ["CronCreate", "CronUpdate", "CronDelete"] as const;
const AUTOMATION_QUERY_ID_PREFIX = "automation-";
/**
 * The tools hidden on an off-peak dispatch turn; OffPeakList is kept read-only.
 * - OffPeakCreate: it keeps an off-peak task from recursively spawning itself and scheduling forever.
 * - SendMessage / Workflow: they start a child Agent anew outside the off-peak turn's modelExecution (SendMessage resumes an
 *   already completed child Agent, Workflow spawns a script child session), building the model from the parent session's resident selection.
 *
 * A constant of its own, never merged into AUTOMATION_MUTATION_TOOL_NAMES — a cron automation turn explicitly allows
 * OffPeakCreate (scheduled spawning of off-peak tasks), and merging it in would make automation turns deny it by mistake.
 */
export const OFF_PEAK_MUTATION_TOOL_NAMES = ["OffPeakCreate", "SendMessage", "Workflow"] as const;
// The traceId of the init segment distributed during idle time has no fixed prefix, only the resume segment is `${offPeakTaskId}:resume:*`
// (starting with offpeak-); the prefix is just the resume cover signal, and the main signal must be explicit offPeakTaskId.
const OFF_PEAK_QUERY_ID_PREFIX = "offpeak-";

export interface CompactLoopTracking {
  consecutiveRapidRefills: number;
  toolTurnsSinceCompact: number;
}

export interface RapidRefillDecision {
  consecutiveRapidRefills: number;
  shouldBlock: boolean;
  toolTurnsSinceCompact: number;
}

export type CompactAttemptOutcome = "skipped" | "compacted" | "failed";

export type AutoCompactOutcome = CompactAttemptOutcome | "rapid_refill_blocked";

export interface AutoCompactLoopContext {
  compactReason: CompactReason;
  modelStepIndex: number;
  phase: CompactPhase;
  rapidRefill: RapidRefillDecision;
  model: Model;
  turnRequestState: TurnRequestState;
}

export interface ReactiveCompactLoopContext {
  activeEntries?: readonly RuntimeMessageEntry[];
  modelStepIndex: number;
  model: Model;
  rapidRefillCount: number;
  turnRequestState: TurnRequestState;
}

export interface TurnRequestState {
  entries: readonly RuntimeMessageEntry[];
  outputTokenContinuationCount: number;
}

export interface RegularTurnLoopState {
  activeTurn?: ActiveTurnSteeringState;
  /** The automation identity of this turn, passed in explicitly by Host admission; it must not be inferred from persistent task metadata. */
  automationId?: string;
  /** The off-peak task identity of this turn, passed in explicitly by Host admission; it is mutually exclusive with automationId and never inferred from persistent meta. */
  offPeakTaskId?: string;
  /** Once CronCreate hits the global cap, this user's turns are permanently switched to plain text-only replies; the model is forbidden from recovering on its own. */
  automationCreateLimitReached?: boolean;
  anomalyWarningsInjected: number;
  /** Whether this turn has already consumed a background result notification that came from a subagent. */
  backgroundSubagentResultConsumed: boolean;
  /** Whether this turn has already consumed a background notification that came from a workflow (a dynamic-workflow run). */
  workflowResultConsumed: boolean;
  compactTracking?: CompactLoopTracking;
  currentUserMessageId: MessageId;
  drainedSteerForNextRequest?: DrainedPendingInputDiagnostics;
  events: SessionEvent[];
  input: string;
  modelResponse: string;
  /** The callable model fixed for this turn; a configuration change only affects Loops created later. */
  model: Model;
  /** execution means the current Active Model cannot be rewritten by a guide of the same loop. */
  modelSelectionScope?: "execution";
  /** The Core Server's foreground child Selection override; it takes priority over the profile and over parent model inheritance. */
  subagentModelOverride?: SubagentRunOptions["modelOverride"];
  modelStepCount: number;
  /** How many assistant/compact artifacts of the current query have already been written successfully into the provider-visible persistent history. */
  historyRoundCount: number;
  reactiveCompactAttemptedInCurrentModelStep: boolean;
  repeatedToolCallSignature?: string;
  repeatedToolCallStreakCount: number;
  pendingStreamRecoveryRequest?: PendingStreamRecoveryRequest;
  stopHookContinuationCount: number;
  /** The raw transcript start of the finally successful product turn; it is only assigned once it is certain there will be no continue. */
  stableProductStartMessageId?: MessageId;
  /** The finally successful assistant boundary; it always appears in a pair with stableProductStartMessageId. */
  stableBoundaryAssistantMessageId?: MessageId;
  streamRecoveryRetryCount: number;
  tokenCount: number;
  toolCallCount: number;
  /** The current Turn's provider-local history; it is released directly once the Turn ends. */
  turnRequestState: TurnRequestState;
  /** Tool names the current turn does not expose to the provider; the registry still keeps them so the execution boundary can do defense-in-depth checks. */
  toolDisallowlist?: readonly string[];
  traceId: TraceId;
  turnAbortSignal: AbortSignal;
  turnId: TurnId;
  turnMachine: TurnMachineImpl;
  /** The provider-visible output style captured by the current Turn; it does not mean an explicit subagent model override. */
  turnOutputStyle?: OutputStylePromptConfig;
  turnTraceContext: TraceContext;
  userMessageId: MessageId;
}

export function isAutomationMutationRestrictedTurn(state: RegularTurnLoopState): boolean {
  if (state.automationId?.trim()) return true;
  if (state.turnTraceContext.queryId?.trim().startsWith(AUTOMATION_QUERY_ID_PREFIX)) return true;

  const disallowedTools = new Set(state.toolDisallowlist ?? []);
  // active/busy automation input will merge the turn-scoped denylist into the current loop; even if the original
  // automationId is no longer the first input of the loop, and the same fact must be passed to the handler execution boundary.
  return AUTOMATION_MUTATION_TOOL_NAMES.every((toolName) => disallowedTools.has(toolName));
}

/**
 * Whether this turn is an off-peak auto-dispatch turn (OffPeakCreate must be denied). Its three signals are isomorphic to
 * isAutomationMutationRestrictedTurn: the explicit offPeakTaskId is the primary signal;
 * the traceId prefix of the resume segment and the turn denylist are the defense-in-depth backstops.
 */
export function isOffPeakCreateRestrictedTurn(state: RegularTurnLoopState): boolean {
  if (state.offPeakTaskId?.trim()) return true;
  if (state.turnTraceContext.queryId?.trim().startsWith(OFF_PEAK_QUERY_ID_PREFIX)) return true;

  // Only recognize the sentinel OffPeakCreate: the denylist distributed by the old host may not have the new tools.
  const disallowedTools = new Set(state.toolDisallowlist ?? []);
  return disallowedTools.has(OFF_PEAK_MUTATION_TOOL_NAMES[0]);
}

export function evaluateRapidRefill(
  tracking: CompactLoopTracking | undefined,
): RapidRefillDecision {
  const toolTurnsSinceCompact = tracking?.toolTurnsSinceCompact ?? 0;
  const consecutiveRapidRefills =
    tracking && toolTurnsSinceCompact < RAPID_REFILL_TOOL_TURN_THRESHOLD
      ? tracking.consecutiveRapidRefills + 1
      : 0;

  return {
    consecutiveRapidRefills,
    shouldBlock: consecutiveRapidRefills >= MAX_CONSECUTIVE_RAPID_REFILLS,
    toolTurnsSinceCompact,
  };
}

export function recordCompactSuccess(
  state: RegularTurnLoopState,
  decision: RapidRefillDecision,
): void {
  state.compactTracking = {
    consecutiveRapidRefills: decision.consecutiveRapidRefills,
    toolTurnsSinceCompact: 0,
  };
}

export function recordCompletedToolBatch(state: RegularTurnLoopState): void {
  // The old guard lives in the entire user turn and remains used after the complete tool batch ends, resulting in the subsequent real overflow being unable to be reactive compacted again.
  state.reactiveCompactAttemptedInCurrentModelStep = false;
  if (state.compactTracking) {
    state.compactTracking.toolTurnsSinceCompact += 1;
  }
}

export function recordModelHistoryRound(state: RegularTurnLoopState): void {
  // toolCallCount will expand the parallel tools by number and cannot express the rounds in which the model is actually written into history.
  // The call point follows the submission boundary of the existing modelStepCount and accumulates additional historical rounds without changing the loop control semantics.
  state.historyRoundCount += 1;
}

export function recordCompactHistoryRound(state: RegularTurnLoopState): void {
  // Compact summary is an independent provider that can see the persistent history, but it is not an ordinary model step and is accumulated separately.
  state.historyRoundCount += 1;
}
