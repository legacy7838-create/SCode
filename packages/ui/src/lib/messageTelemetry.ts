/* oxlint-disable eslint(max-lines) -- message_completion and agent_step share prompt lifecycle
 * state, and splitting them would add cross-file synchronization complexity.
 */
import {
  legacyTelemetryModelFields,
  legacyTelemetryModelValue,
  legacyTelemetryProviderId,
} from "@/lib/providerTelemetryIdentity.js";
import type {
  InputId,
  PlanIdentitySnapshot,
  ZCodeContextCompactionTimelineMeta,
  ZCodePersistedFileChange,
  ZCodeProvider,
  ZCodeStreamEvent,
  ZCodeTimelineStatus,
  ZCodeUsage,
} from "@zcode/shared";
import {
  CUSTOM_SUPPLIER_KEY_PREFIX,
  GHOST_SUPPLIER_KEY_PREFIX,
  NATIVE_SUPPLIER_KEY_PREFIX,
  createUuid,
  computeLineChangeStat,
  decodeCustomModelValue,
} from "@zcode/shared";
interface ComposerInputTimingState {
  inputStartTime: number;
  inputFirstCharTime: number;
}

interface PromptTelemetryState {
  taskId: string;
  messageId: string;
  inputId?: InputId;
  baseEventExtraDetail: Record<string, string>;
  sendTime: number;
  inputStartTime: number;
  inputFirstCharTime: number;
  waitingMs: number;
  permissionWaitsByRequestId: Map<string, PermissionWaitState>;
  firstTokenAt: number | null;
  usage: ZCodeUsage | null;
  usageEventKeys: Set<string>;
  finalizedAgentStepCount: number;
  toolCallTotal: number;
  toolCallFailed: number;
  firstToolCallError: string;
}

interface PermissionWaitState {
  requestedAt: number;
  toolCallId?: string;
}

interface FinalizePromptTelemetryInput {
  taskId: string;
  status: string;
  finishedAt: number;
  fileChanges?: readonly ZCodePersistedFileChange[];
  usage?: ZCodeUsage;
  errorType?: string;
  errorMsg?: string;
  messageSource?: PromptMessageSource;
  agentComposition?: AgentComposition;
}

/**
 * The source of an independent background wake round: a background sub-agent of the Agent tool, or
 * a notification from a dynamic-workflow run.
 */
export type PromptMessageSource = "background_subagent" | "background_workflow";

/**
 * `message_completion.agent_composition`: which Subagent results this round consumed (fg =
 * foreground, bg = background, wf = dynamic workflow run). Eight values = combinations of three
 * booleans.
 */
type AgentComposition =
  | "main_only"
  | "main_plus_fg"
  | "main_plus_bg"
  | "main_plus_wf"
  | "main_plus_fg_bg"
  | "main_plus_fg_wf"
  | "main_plus_bg_wf"
  | "main_plus_fg_bg_wf";

export function composeAgentComposition(input: {
  hasForegroundSubagentResult: boolean;
  hasBackgroundSubagentResult: boolean;
  hasWorkflowResult: boolean;
}): AgentComposition {
  const parts = [
    ...(input.hasForegroundSubagentResult ? ["fg"] : []),
    ...(input.hasBackgroundSubagentResult ? ["bg"] : []),
    ...(input.hasWorkflowResult ? ["wf"] : []),
  ];
  return parts.length === 0 ? "main_only" : (`main_plus_${parts.join("_")}` as AgentComposition);
}

interface FinalizedPromptTelemetry {
  taskId: string;
  messageId: string;
  eventExtraDetail: Record<string, string>;
}

type AgentStepType = "reasoning" | "tool_call" | "generation";
type GenerationCloseReason = "reasoning" | "tool_call" | "task_complete" | "task_error";
type AgentStepTelemetryClientMode = "desktop-continuous" | "web-remote-replayable";
export type AgentStepRole = "foreground subagent" | "background subagent" | "workflow subagent";

interface ActiveAgentStep {
  stepId: string;
  stepType: AgentStepType;
  loopIndex: number;
  startedAt: number;
  waitingMs: number;
  model?: AgentStepModelIdentity;
  usage?: AgentStepUsageAttribution;
  lastMessageChunkAt?: number;
  toolId?: string;
  toolName?: string;
  agentId?: string;
  agentRole?: AgentStepRole;
  skillMetadata?: AgentStepSkillMetadata;
}

interface AgentStepSkillMetadata {
  qualifiedName?: string;
  pluginId?: string;
  source?: "agents" | "zcode" | "bundled" | "plugin" | "remote";
}

interface AgentStepModelIdentity {
  requestId?: string;
  modelName: string;
  modelProvider: string;
  providerName: string;
}

interface AgentStepUsageAttribution {
  requestIds: string[];
  requestCount: number;
  scope: "model_request" | "subagent_requests";
  usage: ZCodeUsage;
}

interface AgentStepToolAttribution {
  agentId?: string;
  agentRole?: AgentStepRole;
  modelName?: string;
  modelProvider?: string;
  providerName?: string;
}

interface AgentStepTelemetryState {
  nextLoopIndex: number;
  currentModelRequest: AgentStepModelIdentity | null;
  pendingUsageByRequestId: Map<string, AgentStepUsageAttribution>;
  reasoningStep: ActiveAgentStep | null;
  generationStep: ActiveAgentStep | null;
  toolStepsById: Map<string, ActiveAgentStep>;
  settledPermissionWaitsByToolId: Map<string, SettledPermissionWaitAttribution>;
}

interface SettledPermissionWaitAttribution {
  waitingMs: number;
  earliestRequestedAt: number;
}

interface FinalizedAgentStepTelemetry {
  taskId: string;
  messageId: string;
  eventExtraDetail: Record<string, string>;
}

const composerInputTimingByWorkspace = new Map<string, ComposerInputTimingState>();
const queuedPromptTelemetryByTask = new Map<string, PromptTelemetryState[]>();
const activePromptTelemetryByTask = new Map<string, PromptTelemetryState>();
const agentStepTelemetryByTask = new Map<string, AgentStepTelemetryState>();

function resolvePromptTelemetryModelProvider(params: {
  modelName?: string | null;
  provider?: ZCodeProvider;
  selectedSupplierKey?: string | null;
}): string {
  const { modelName, provider, selectedSupplierKey } = params;
  // Bugfix: model_name of send_btn has been fixed by UI model value, but selectedSupplierKey
  // Occasionally, it still stays on the previous supplier, resulting in `uuid/model` paired with `glm` provider.
  // When the model value itself has the provider dimension, the provider must be aligned with the same UI selection.
  const providerFromModelName = readProviderIdFromModelValue(modelName);
  if (providerFromModelName) {
    return providerFromModelName;
  }

  if (!selectedSupplierKey) {
    return provider ?? "";
  }

  if (selectedSupplierKey.startsWith(CUSTOM_SUPPLIER_KEY_PREFIX)) {
    const customProviderId = selectedSupplierKey.slice(CUSTOM_SUPPLIER_KEY_PREFIX.length).trim();
    return customProviderId || provider || "";
  }

  // Ghost supplier represents a temporary isolation state that has not been resolved to a stable custom provider, and the provider dimension uniformly falls back to the current ZCode Agent provider.
  if (selectedSupplierKey.startsWith(GHOST_SUPPLIER_KEY_PREFIX)) {
    return provider ?? "";
  }

  if (selectedSupplierKey.startsWith(NATIVE_SUPPLIER_KEY_PREFIX)) {
    const nativeProvider = selectedSupplierKey.slice(NATIVE_SUPPLIER_KEY_PREFIX.length).trim();
    return nativeProvider || provider || "";
  }

  return provider ?? "";
}

function readProviderIdFromModelValue(modelValue: string | null | undefined): string | null {
  const normalizedModelValue = modelValue?.trim() ?? "";
  if (!normalizedModelValue) {
    return null;
  }

  const customModel = decodeCustomModelValue(normalizedModelValue);
  if (customModel?.providerId?.trim()) {
    return customModel.providerId.trim();
  }

  const separatorIndex = normalizedModelValue.indexOf("/");
  if (separatorIndex <= 0) {
    return null;
  }

  const providerId = normalizedModelValue.slice(0, separatorIndex).trim();
  return providerId || null;
}

function resolveProviderHostname(baseURL: string | null | undefined): string {
  const normalizedBaseURL = baseURL?.trim() ?? "";
  if (!normalizedBaseURL) {
    return "";
  }

  try {
    return new URL(normalizedBaseURL).hostname;
  } catch {
    return "";
  }
}

function createAgentStepTelemetryState(): AgentStepTelemetryState {
  return {
    nextLoopIndex: 1,
    currentModelRequest: null,
    pendingUsageByRequestId: new Map(),
    reasoningStep: null,
    generationStep: null,
    toolStepsById: new Map(),
    settledPermissionWaitsByToolId: new Map(),
  };
}

function getAgentStepTelemetryState(taskId: string): AgentStepTelemetryState {
  const existing = agentStepTelemetryByTask.get(taskId);
  if (existing) {
    return existing;
  }

  const created = createAgentStepTelemetryState();
  agentStepTelemetryByTask.set(taskId, created);
  return created;
}

function createAgentStep(
  state: AgentStepTelemetryState,
  stepType: AgentStepType,
  startedAt: number,
  options: {
    toolId?: string;
    toolName?: string;
    skillMetadata?: AgentStepSkillMetadata;
  } = {},
): ActiveAgentStep {
  const step: ActiveAgentStep = {
    stepId: createUuid(),
    stepType,
    loopIndex: state.nextLoopIndex,
    startedAt,
    waitingMs: 0,
    ...(state.currentModelRequest ? { model: { ...state.currentModelRequest } } : {}),
    ...options,
  };
  const requestId = step.model?.requestId;
  if (requestId) {
    const pendingUsage = state.pendingUsageByRequestId.get(requestId);
    if (pendingUsage) {
      step.usage = pendingUsage;
      state.pendingUsageByRequestId.delete(requestId);
    }
  }
  state.nextLoopIndex += 1;
  return step;
}

function normalizeAgentStepStatus(status: string): string {
  if (status === "failed" || status === "fail" || status === "denied") {
    return "fail";
  }
  if (status === "timeout") {
    return "timeout";
  }
  return "success";
}

function cronCreateAutomationId(content: unknown): string | undefined {
  let value = content;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value) as unknown;
    } catch {
      return undefined;
    }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const automation = (value as { automation?: unknown }).automation;
  if (!automation || typeof automation !== "object" || Array.isArray(automation)) return undefined;
  const automationId = (automation as { automationId?: unknown }).automationId;
  return typeof automationId === "string" && automationId.trim() ? automationId.trim() : undefined;
}

function markPromptFirstToken(prompt: PromptTelemetryState, now: number): void {
  if (prompt.firstTokenAt !== null) {
    return;
  }

  prompt.firstTokenAt = now;
}

function finalizeAgentStep(input: {
  prompt: PromptTelemetryState;
  step: ActiveAgentStep;
  finishedAt: number;
  status: string;
  errorType?: string;
  errorMsg?: string;
  generationTailFinalizeMs?: number;
  automationId?: string;
}): FinalizedAgentStepTelemetry {
  const normalizedStatus = normalizeAgentStepStatus(input.status);
  const isToolCall = input.step.stepType === "tool_call";
  const usage = input.step.usage?.usage;
  const model = input.step.model;
  // Bugfix: Scan the entire taskMessages before completion, causing the history step/tool in the later round
  // Double counting. The step-by-step closing is the source of fact for the current message, so the aggregation must be accumulated synchronously here.
  input.prompt.finalizedAgentStepCount += 1;
  if (isToolCall) {
    input.prompt.toolCallTotal += 1;
    const isFailed = normalizedStatus !== "success" || Boolean(input.errorMsg);
    if (isFailed) {
      input.prompt.toolCallFailed += 1;
      if (!input.prompt.firstToolCallError && input.errorMsg) {
        input.prompt.firstToolCallError = input.errorMsg;
      }
    }
  }

  return {
    taskId: input.prompt.taskId,
    messageId: input.prompt.messageId,
    eventExtraDetail: {
      step_id: input.step.stepId,
      is_tftt_cached: "0",
      loop_index: String(input.step.loopIndex),
      step_type: input.step.stepType,
      // Root cause of the bug: The old implementation takes the model from the prompt shared field, and subsequent main requests or child requests will overwrite the created step.
      // The step must freeze its true request model; it only falls back to the prompt seed if the old fact lacks the request identity.
      model_name: legacyTelemetryModelValue(
        model?.modelName ?? input.prompt.baseEventExtraDetail.model_name ?? "",
      ),
      model_provider: legacyTelemetryProviderId(
        model?.modelProvider ?? input.prompt.baseEventExtraDetail.model_provider ?? "",
      ),
      provider_name: model?.providerName ?? input.prompt.baseEventExtraDetail.provider_name ?? "",
      model_request_id:
        input.step.usage?.requestIds.length === 1 ? (input.step.usage.requestIds[0] ?? "") : "",
      model_request_count: String(input.step.usage?.requestCount ?? 0),
      token_usage_scope: input.step.usage?.scope ?? "",
      is_tool_call: isToolCall ? "1" : "0",
      tool_name: input.step.toolName ?? "",
      tool_call_id: isToolCall ? (input.step.toolId ?? "") : "",
      ...(input.step.agentId ? { agent_id: input.step.agentId } : {}),
      ...(input.step.agentRole ? { agent_role: input.step.agentRole } : {}),
      duration_ms: String(Math.max(input.finishedAt - input.step.startedAt, 0)),
      waiting_ms: String(input.step.waitingMs),
      generation_tail_finalize_ms:
        input.generationTailFinalizeMs !== undefined ? String(input.generationTailFinalizeMs) : "",
      status: normalizedStatus,
      input_tokens: String(usage?.inputTokens ?? 0),
      output_tokens: String(usage?.outputTokens ?? 0),
      reasoning_tokens: String(usage?.reasoningTokens ?? 0),
      cached_tokens: String(usage?.cachedInputTokens ?? 0),
      cache_write_input_tokens: String(usage?.cachedWriteInputTokens ?? 0),
      total_tokens: String(usage?.totalTokens ?? 0),
      error_type: normalizedStatus === "success" ? "" : (input.errorType ?? "UNKNOWN"),
      error_msg: normalizedStatus === "success" ? "" : (input.errorMsg ?? ""),
      ...(input.automationId ? { automation_id: input.automationId } : {}),
      ...(isToolCall && input.step.toolName === "Skill" && input.step.skillMetadata?.qualifiedName
        ? { skill_qualified_name: input.step.skillMetadata.qualifiedName }
        : {}),
      ...(isToolCall && input.step.toolName === "Skill" && input.step.skillMetadata?.pluginId
        ? { skill_plugin_id: input.step.skillMetadata.pluginId }
        : {}),
      ...(isToolCall && input.step.toolName === "Skill" && input.step.skillMetadata?.source
        ? { skill_source: input.step.skillMetadata.source }
        : {}),
    },
  };
}

function closeReasoningStep(
  prompt: PromptTelemetryState,
  state: AgentStepTelemetryState,
  now: number,
  output: FinalizedAgentStepTelemetry[],
): void {
  if (!state.reasoningStep) {
    return;
  }

  output.push(
    finalizeAgentStep({
      prompt,
      step: state.reasoningStep,
      finishedAt: now,
      status: "success",
    }),
  );
  state.reasoningStep = null;
}

function closeGenerationStep(
  prompt: PromptTelemetryState,
  state: AgentStepTelemetryState,
  now: number,
  status: string,
  output: FinalizedAgentStepTelemetry[],
  error?: { type?: string; msg?: string },
  closeReason?: GenerationCloseReason,
  clientMode: AgentStepTelemetryClientMode = "desktop-continuous",
): void {
  if (!state.generationStep) {
    return;
  }

  // Reason for repair: replayable recovery will replay historical chunk/terminal on the client.
  // Date.now() can only represent the local processing time, but cannot represent the real tail delay from the source body tail packet to the final state.
  const canReportGenerationTailFinalize = clientMode === "desktop-continuous";
  const generationTailFinalizeMs =
    canReportGenerationTailFinalize &&
    (closeReason === "task_complete" || closeReason === "task_error") &&
    state.generationStep.lastMessageChunkAt !== undefined
      ? Math.max(now - state.generationStep.lastMessageChunkAt, 0)
      : undefined;

  output.push(
    finalizeAgentStep({
      prompt,
      step: state.generationStep,
      finishedAt: now,
      status,
      errorType: error?.type,
      errorMsg: error?.msg,
      generationTailFinalizeMs,
    }),
  );
  state.generationStep = null;
}

function settlePermissionWait(
  prompt: PromptTelemetryState,
  state: AgentStepTelemetryState | undefined,
  requestId: string,
  now: number,
): void {
  const permissionWait = prompt.permissionWaitsByRequestId.get(requestId);
  if (!permissionWait) {
    return;
  }

  const waitingMs = Math.max(now - permissionWait.requestedAt, 0);
  prompt.waitingMs += waitingMs;
  if (permissionWait.toolCallId) {
    const toolStep = state?.toolStepsById.get(permissionWait.toolCallId);
    if (toolStep) {
      toolStep.waitingMs += waitingMs;
    } else if (state) {
      const settled = state.settledPermissionWaitsByToolId.get(permissionWait.toolCallId);
      state.settledPermissionWaitsByToolId.set(permissionWait.toolCallId, {
        waitingMs: (settled?.waitingMs ?? 0) + waitingMs,
        earliestRequestedAt: Math.min(
          settled?.earliestRequestedAt ?? permissionWait.requestedAt,
          permissionWait.requestedAt,
        ),
      });
    }
  }
  prompt.permissionWaitsByRequestId.delete(requestId);
}

function applySettledPermissionWaitAttribution(
  state: AgentStepTelemetryState,
  step: ActiveAgentStep,
): void {
  if (!step.toolId) {
    return;
  }

  const settled = state.settledPermissionWaitsByToolId.get(step.toolId);
  if (!settled) {
    return;
  }

  step.waitingMs += settled.waitingMs;
  step.startedAt = Math.min(step.startedAt, settled.earliestRequestedAt);
  state.settledPermissionWaitsByToolId.delete(step.toolId);
}

function findEarliestPermissionRequestedAt(
  prompt: PromptTelemetryState,
  state: AgentStepTelemetryState,
  toolCallId: string,
): number | undefined {
  let earliest = state.settledPermissionWaitsByToolId.get(toolCallId)?.earliestRequestedAt;
  for (const permissionWait of prompt.permissionWaitsByRequestId.values()) {
    if (permissionWait.toolCallId !== toolCallId) {
      continue;
    }
    earliest = Math.min(earliest ?? permissionWait.requestedAt, permissionWait.requestedAt);
  }
  return earliest;
}

function settlePermissionWaitsForTool(
  prompt: PromptTelemetryState,
  state: AgentStepTelemetryState,
  toolCallId: string,
  now: number,
): void {
  for (const [requestId, permissionWait] of prompt.permissionWaitsByRequestId) {
    if (permissionWait.toolCallId === toolCallId) {
      settlePermissionWait(prompt, state, requestId, now);
    }
  }
}

function settleAllPermissionWaits(
  prompt: PromptTelemetryState,
  state: AgentStepTelemetryState | undefined,
  now: number,
): void {
  for (const requestId of prompt.permissionWaitsByRequestId.keys()) {
    settlePermissionWait(prompt, state, requestId, now);
  }
}

function closeToolSteps(
  prompt: PromptTelemetryState,
  state: AgentStepTelemetryState,
  now: number,
  status: string,
  output: FinalizedAgentStepTelemetry[],
  error?: { type?: string; msg?: string },
): void {
  for (const [toolId, toolStep] of state.toolStepsById) {
    settlePermissionWaitsForTool(prompt, state, toolId, now);
    output.push(
      finalizeAgentStep({
        prompt,
        step: toolStep,
        finishedAt: now,
        status,
        errorType: error?.type,
        errorMsg: error?.msg,
      }),
    );
  }
  state.toolStepsById.clear();
}

export function buildPromptTelemetryExtraDetail(params: {
  askMode?: string | null;
  modelName?: string | null;
  provider?: ZCodeProvider;
  selectedSupplierKey?: string | null;
  providerBaseURL?: string | null;
  planIdentitySnapshot?: PlanIdentitySnapshot | null;
}): Record<string, string> {
  const modelProvider = resolvePromptTelemetryModelProvider({
    modelName: params.modelName,
    provider: params.provider,
    selectedSupplierKey: params.selectedSupplierKey,
  });
  const providerHostname = resolveProviderHostname(params.providerBaseURL);

  return {
    ask_mode: params.askMode ?? "",
    model_name: legacyTelemetryModelValue(params.modelName ?? ""),
    model_provider: legacyTelemetryProviderId(modelProvider),
    // Reason for fix: The model_provider of custom provider is often an internal uuid, which is meaningless when data warehouse analyzes the real backend.
    // provider_name currently hosts provider hostname; do not change model_provider to avoid affecting the existing uuid/provider id data warehouse caliber.
    // Here, only the hostname is parsed from the URL, and the complete endpoint is not reported to avoid leaking paths or queries.
    ...(providerHostname ? { provider_name: providerHostname } : {}),
    // The agent field takes ZCode Agent provider; this warehouse does not have an independent session.agentId.
    agent: params.provider ?? "",
    plan_status: params.planIdentitySnapshot?.planStatus ?? "unknown",
    plan_product_id: params.planIdentitySnapshot?.planProductId ?? "",
  };
}

const COMPACTION_TERMINAL_STATUSES: readonly ZCodeTimelineStatus[] = [
  "completed",
  "failed",
  "interrupted",
];

function isCompactionTerminalStatus(status: ZCodeTimelineStatus): boolean {
  return COMPACTION_TERMINAL_STATUSES.includes(status);
}

/**
 * Builds the telemetry fields for a context compaction result. A field object is returned only in
 * terminal states (completed/failed/interrupted) and null in in-flight states
 * (started/retrying/skipped), so the caller decides whether to report. The success rate is
 * aggregated in the warehouse by status: completed / (completed + failed + interrupted). The
 * provider/model dimensions reuse buildPromptTelemetryExtraDetail, and version is injected by the
 * backend reportEvent.
 */
export function buildCompactionTelemetryExtraDetail(params: {
  timeline: ZCodeContextCompactionTimelineMeta;
  provider?: ZCodeProvider;
  /**
   * The provider that the V4 fact has already been normalized to from the real model request; it
   * takes precedence over the legacy UI supplier derivation.
   */
  modelProvider?: string | null;
  modelName?: string | null;
  selectedSupplierKey?: string | null;
}): Record<string, string> | null {
  const { timeline } = params;
  if (!isCompactionTerminalStatus(timeline.status)) {
    return null;
  }

  const modelFields = params.provider
    ? buildPromptTelemetryExtraDetail({
        modelName: params.modelName,
        provider: params.provider,
        selectedSupplierKey: params.selectedSupplierKey,
      })
    : { model_name: params.modelName ?? "", model_provider: "" };

  const preCompactTokens = timeline.preCompactTokenCount ?? 0;
  const postCompactTokens = timeline.postCompactTokenCount ?? 0;
  // The compression rate uses the vendor's caliber post/pre; leave it blank when pre is 0 (missing data) to avoid dividing by zero from contaminating the distribution.
  const compactRatio =
    preCompactTokens > 0 ? (postCompactTokens / preCompactTokens).toFixed(4) : "";
  const durationMs =
    timeline.startedAt !== undefined && timeline.endedAt !== undefined
      ? String(Math.max(timeline.endedAt - timeline.startedAt, 0))
      : "";

  return {
    status: timeline.status,
    trigger: timeline.trigger,
    reason: timeline.reason ?? "",
    attempt: String(timeline.attempt ?? 0),
    duration_ms: durationMs,
    pre_compact_tokens: String(preCompactTokens),
    post_compact_tokens: String(postCompactTokens),
    true_post_compact_tokens: String(timeline.truePostCompactTokenCount ?? 0),
    compact_ratio: compactRatio,
    model_name: legacyTelemetryModelValue(modelFields.model_name ?? ""),
    model_provider: legacyTelemetryProviderId(
      params.modelProvider?.trim() || modelFields.model_provider || "",
    ),
  };
}

function buildPromptUsageTelemetryExtraDetail(
  usage: ZCodeUsage | undefined,
  tokenSource?: string,
): Record<string, string> {
  if (!usage) {
    return {};
  }

  return {
    input_tokens: String(usage.inputTokens),
    output_tokens: String(usage.outputTokens),
    reasoning_tokens: String(usage.reasoningTokens ?? 0),
    cached_input_tokens: String(usage.cachedInputTokens ?? 0),
    cache_write_input_tokens: String(usage.cachedWriteInputTokens ?? 0),
    // The ZCode Agent link is not exposed to the tool use prompt token, and 0 is explicitly added in the successful state to keep the extraDetail field set intact.
    tool_use_prompt_tokens: "0",
    total_tokens: String(usage.totalTokens),
    ...(tokenSource ? { token_source: tokenSource } : {}),
  };
}

function mergePromptUsage(left: ZCodeUsage | null, right: ZCodeUsage): ZCodeUsage {
  if (!left) {
    return {
      inputTokens: right.inputTokens,
      outputTokens: right.outputTokens,
      totalTokens: right.totalTokens,
      reasoningTokens: right.reasoningTokens ?? 0,
      cachedInputTokens: right.cachedInputTokens ?? 0,
      cachedWriteInputTokens: right.cachedWriteInputTokens ?? 0,
    };
  }

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

function ensureComposerInputTiming(workspacePath: string): ComposerInputTimingState {
  const existing = composerInputTimingByWorkspace.get(workspacePath);
  if (existing) {
    return existing;
  }

  const created: ComposerInputTimingState = {
    inputStartTime: 0,
    inputFirstCharTime: 0,
  };
  composerInputTimingByWorkspace.set(workspacePath, created);
  return created;
}

function consumeComposerInputTiming(workspacePath: string, sendTime: number) {
  const current = ensureComposerInputTiming(workspacePath);
  const inputStartTime = current.inputStartTime || current.inputFirstCharTime || sendTime;
  const inputFirstCharTime = current.inputFirstCharTime || inputStartTime || sendTime;

  composerInputTimingByWorkspace.set(workspacePath, {
    inputStartTime: 0,
    inputFirstCharTime: 0,
  });

  return {
    inputStartTime,
    inputFirstCharTime,
  };
}

function collectFileChangeMetrics(fileChanges: readonly ZCodePersistedFileChange[] | undefined) {
  if (!fileChanges || fileChanges.length === 0) {
    return {
      changedFileCount: 0,
      generatedCodeLines: 0,
    };
  }

  const changedFileMap = new Map<string, { beforeContent: string | null; afterContent: string }>();

  for (const turn of fileChanges) {
    for (const snapshot of turn.snapshots) {
      const existing = changedFileMap.get(snapshot.path);
      if (existing) {
        existing.afterContent = snapshot.afterContent;
      } else {
        changedFileMap.set(snapshot.path, {
          beforeContent: snapshot.beforeContent,
          afterContent: snapshot.afterContent,
        });
      }
    }
  }

  let generatedCodeLines = 0;
  for (const file of changedFileMap.values()) {
    generatedCodeLines += computeLineChangeStat(file.beforeContent, file.afterContent).added;
  }

  return {
    changedFileCount: changedFileMap.size,
    generatedCodeLines,
  };
}

export function recordComposerFocus(workspacePath: string, now = Date.now()): void {
  const inputTiming = ensureComposerInputTiming(workspacePath);
  inputTiming.inputStartTime = now;
  inputTiming.inputFirstCharTime = 0;
}

export function recordComposerTextChange(
  workspacePath: string,
  nextText: string,
  now = Date.now(),
): void {
  if (nextText.length === 0) {
    return;
  }

  const inputTiming = ensureComposerInputTiming(workspacePath);
  if (inputTiming.inputFirstCharTime !== 0) {
    return;
  }

  inputTiming.inputFirstCharTime = now;
  if (inputTiming.inputStartTime === 0) {
    inputTiming.inputStartTime = now;
  }
}

function createPromptTelemetryState(input: {
  taskId: string;
  messageId: string;
  inputId?: InputId;
  sendTime: number;
  inputStartTime: number;
  inputFirstCharTime: number;
  extraDetail?: Record<string, string>;
}): PromptTelemetryState {
  return {
    taskId: input.taskId,
    messageId: input.messageId,
    ...(input.inputId ? { inputId: input.inputId } : {}),
    baseEventExtraDetail: input.extraDetail ? { ...input.extraDetail } : {},
    sendTime: input.sendTime,
    inputStartTime: input.inputStartTime,
    inputFirstCharTime: input.inputFirstCharTime,
    waitingMs: 0,
    permissionWaitsByRequestId: new Map(),
    firstTokenAt: null,
    usage: null,
    usageEventKeys: new Set(),
    finalizedAgentStepCount: 0,
    toolCallTotal: 0,
    toolCallFailed: 0,
    firstToolCallError: "",
  };
}

export function queuePromptTelemetry(input: {
  workspacePath: string;
  taskId: string;
  messageId: string;
  inputId?: InputId;
  sendTime: number;
  extraDetail?: Record<string, string>;
}) {
  const { inputStartTime, inputFirstCharTime } = consumeComposerInputTiming(
    input.workspacePath,
    input.sendTime,
  );
  const promptTelemetry = createPromptTelemetryState({
    taskId: input.taskId,
    messageId: input.messageId,
    ...(input.inputId ? { inputId: input.inputId } : {}),
    sendTime: input.sendTime,
    inputStartTime,
    inputFirstCharTime,
    ...(input.extraDetail ? { extraDetail: input.extraDetail } : {}),
  });

  const existingQueue = queuedPromptTelemetryByTask.get(input.taskId) ?? [];
  queuedPromptTelemetryByTask.set(input.taskId, [...existingQueue, promptTelemetry]);

  return {
    ...promptTelemetry.baseEventExtraDetail,
    input_start_time: String(inputStartTime),
    input_first_char_time: String(inputFirstCharTime),
    input_send_time: String(input.sendTime),
  };
}

export function activatePromptTelemetry(taskId: string, messageId: string): void {
  const queue = queuedPromptTelemetryByTask.get(taskId);
  if (!queue || queue.length === 0) {
    return;
  }

  const targetIndex = queue.findIndex((item) => item.messageId === messageId);
  if (targetIndex === -1) {
    return;
  }

  const [target] = queue.splice(targetIndex, 1);
  if (!target) {
    return;
  }

  if (queue.length === 0) {
    queuedPromptTelemetryByTask.delete(taskId);
  } else {
    queuedPromptTelemetryByTask.set(taskId, queue);
  }

  activePromptTelemetryByTask.set(taskId, target);
  agentStepTelemetryByTask.set(taskId, createAgentStepTelemetryState());
}

/**
 * A background child only reuses agent_step state, and does not create or report an independent
 * message lifecycle.
 */
export function activateDetachedAgentStepTelemetry(input: {
  taskId: string;
  messageId: string;
  sendTime: number;
  extraDetail?: Record<string, string>;
}): void {
  activePromptTelemetryByTask.set(
    input.taskId,
    createPromptTelemetryState({
      taskId: input.taskId,
      messageId: input.messageId,
      sendTime: input.sendTime,
      inputStartTime: input.sendTime,
      inputFirstCharTime: input.sendTime,
      ...(input.extraDetail ? { extraDetail: input.extraDetail } : {}),
    }),
  );
  agentStepTelemetryByTask.set(input.taskId, createAgentStepTelemetryState());
}

export function recordPromptModelRequestStarted(
  taskId: string,
  event: Extract<ZCodeStreamEvent, { type: "task_network_debug_status" }>,
  activeInputId?: string,
): void {
  if (event.statusType !== "model_request_started") {
    return;
  }

  const active = activePromptTelemetryByTask.get(taskId);
  if (!active) {
    return;
  }

  const expectedInputId = activeInputId ?? active.inputId;
  if (expectedInputId && event.inputId && expectedInputId !== event.inputId) {
    return;
  }

  const modelProvider = event.providerId?.trim();
  const rawModelName = event.modelId?.trim();
  const providerHostname = resolveProviderHostname(event.baseURL);
  const modelName =
    rawModelName && modelProvider && !readProviderIdFromModelValue(rawModelName)
      ? `${modelProvider}/${rawModelName}`
      : rawModelName;
  if (!modelProvider && !modelName) {
    return;
  }

  const state = getAgentStepTelemetryState(taskId);
  state.currentModelRequest = {
    ...(event.requestId?.trim() ? { requestId: event.requestId.trim() } : {}),
    modelName: modelName ?? active.baseEventExtraDetail.model_name ?? "",
    modelProvider: modelProvider ?? active.baseEventExtraDetail.model_provider ?? "",
    providerName: providerHostname || active.baseEventExtraDetail.provider_name || "",
  };
  active.baseEventExtraDetail = {
    ...active.baseEventExtraDetail,
    // Reason for fix: send_btn is a UI selection snapshot, but message_completion/agent_step should try to represent the real model request.
    // The workspace configOptions may still be a builtin model when customizing the vendor switch; here the runtime request_started return packet is used to override the completion model dimension.
    ...(modelName ? { model_name: modelName } : {}),
    ...(modelProvider ? { model_provider: modelProvider } : {}),
    ...(providerHostname ? { provider_name: providerHostname } : {}),
  };
}

function findModelOutputStepForRequest(
  state: AgentStepTelemetryState,
  requestId: string,
): ActiveAgentStep | undefined {
  const candidates = [state.generationStep, state.reasoningStep];
  return candidates.find((step) => step?.model?.requestId === requestId) ?? undefined;
}

function assignUsageToStep(step: ActiveAgentStep, attribution: AgentStepUsageAttribution): void {
  step.usage = step.usage
    ? {
        requestIds: [...new Set([...step.usage.requestIds, ...attribution.requestIds])],
        requestCount: step.usage.requestCount + attribution.requestCount,
        scope:
          step.usage.scope === "subagent_requests" || attribution.scope === "subagent_requests"
            ? "subagent_requests"
            : "model_request",
        usage: mergePromptUsage(step.usage.usage, attribution.usage),
      }
    : attribution;
}

/**
 * Writes a Subagent's real model and accumulated usage into its Agent step. Foreground uses the
 * parent task state, background uses the detached child state.
 */
export function recordSubagentToolAttribution(input: {
  taskId: string;
  toolCallId: string;
  requestIds: string[];
  requestCount: number;
  modelName: string;
  modelProvider: string;
  providerName: string;
  agentId: string;
  agentRole?: AgentStepRole;
  usage?: ZCodeUsage;
}): void {
  const state = agentStepTelemetryByTask.get(input.taskId);
  const step = state?.toolStepsById.get(input.toolCallId);
  if (!step) return;

  step.agentId = input.agentId;
  step.agentRole = input.agentRole ?? "foreground subagent";
  if (input.modelName || input.modelProvider || input.providerName) {
    step.model = {
      modelName: input.modelName,
      modelProvider: input.modelProvider,
      providerName: input.providerName,
    };
  }
  if (input.usage) {
    // Bug root cause: The final state of the parent Agent tool may be earlier than SubagentStopped when canceled/failed. If only stopped
    // At the time of first attribution, the tool step has been deleted from the active index, and the main model can only be mistakenly rolled back with token 0.
    // Child fact carries the cumulative value of the current life cycle each time, which is overwritten instead of superimposed to avoid repeated counting of incremental synchronization.
    step.usage = {
      requestIds: [...input.requestIds],
      requestCount: input.requestCount,
      scope: "subagent_requests",
      usage: { ...input.usage },
    };
  }
}

function applyAgentStepToolAttribution(
  step: ActiveAgentStep,
  attribution: AgentStepToolAttribution | undefined,
): void {
  if (!attribution) return;
  if (attribution.agentId) {
    step.agentId = attribution.agentId;
    step.agentRole = attribution.agentRole ?? "foreground subagent";
  }
  if (attribution.modelName || attribution.modelProvider || attribution.providerName) {
    step.model = {
      modelName: attribution.modelName ?? "",
      modelProvider: attribution.modelProvider ?? "",
      providerName: attribution.providerName ?? "",
    };
  }
}

function applyAgentStepSkillMetadata(
  step: ActiveAgentStep,
  metadata: AgentStepSkillMetadata | undefined,
): void {
  // Reason for repair: metadata is only allowed to be written to Skill step to prevent dirty fields other than Skill tool_call from entering telemetry.
  if (!metadata || step.toolName !== "Skill") return;
  step.skillMetadata = {
    ...step.skillMetadata,
    ...(metadata.qualifiedName ? { qualifiedName: metadata.qualifiedName } : {}),
    ...(metadata.pluginId ? { pluginId: metadata.pluginId } : {}),
    ...(metadata.source ? { source: metadata.source } : {}),
  };
}

function materializePendingModelUsageBeforeTool(input: {
  prompt: PromptTelemetryState;
  state: AgentStepTelemetryState;
  now: number;
  finalized: FinalizedAgentStepTelemetry[];
  clientMode?: AgentStepTelemetryClientMode;
}): void {
  const requestId = input.state.currentModelRequest?.requestId;
  if (
    !requestId ||
    input.state.reasoningStep ||
    input.state.generationStep ||
    !input.state.pendingUsageByRequestId.has(requestId)
  ) {
    return;
  }

  // Bug root cause: There is no body step when the model directly returns tool_use, and the old logic will cause pending usage
  // Consumed by subsequently created tool steps. After the Agent tool is overlaid with child usage, the main model A will be
  // The tokens of child model B are mixed in the same model dimension. Here add a zero-duration generation,
  // Only accept this real model request; the tool step remains independent, waiting for the fact that the tool or front-end child.
  input.state.generationStep = createAgentStep(input.state, "generation", input.now);
  closeGenerationStep(
    input.prompt,
    input.state,
    input.now,
    "success",
    input.finalized,
    undefined,
    "tool_call",
    input.clientMode,
  );
}

export function recordAgentStepTelemetryEvent(input: {
  taskId: string;
  event: ZCodeStreamEvent;
  activeInputId?: string;
  clientMode?: AgentStepTelemetryClientMode;
  toolAttribution?: AgentStepToolAttribution;
  skillMetadata?: AgentStepSkillMetadata;
  now?: number;
}): FinalizedAgentStepTelemetry[] {
  const prompt = activePromptTelemetryByTask.get(input.taskId);
  if (!prompt) {
    return [];
  }
  const eventInputId =
    "inputId" in input.event && typeof input.event.inputId === "string"
      ? input.event.inputId
      : undefined;
  if (input.activeInputId && eventInputId && input.activeInputId !== eventInputId) {
    // Bugfix: After completion switches to step-by-step aggregation, the late chunk/tool ​​of the old input will also pollute the current message.
    // The ownership is based on the runtime activeInputId and is compatible with the actual inputId rebinding when the queued prompt is sent.
    return [];
  }

  const now = input.now ?? Date.now();
  const state = getAgentStepTelemetryState(input.taskId);
  const finalized: FinalizedAgentStepTelemetry[] = [];

  switch (input.event.type) {
    case "agent_thought_chunk":
      markPromptFirstToken(prompt, now);
      if (!state.reasoningStep) {
        closeGenerationStep(
          prompt,
          state,
          now,
          "success",
          finalized,
          undefined,
          "reasoning",
          input.clientMode,
        );
        state.reasoningStep = createAgentStep(state, "reasoning", now);
      }
      return finalized;

    case "agent_message_chunk":
      if (input.event.zcodeTimeline) {
        return finalized;
      }
      if (input.event.parentToolUseId) {
        // Reason for repair: The chunk with parentToolUseId is tool/sub-agent output, and the UI will be linked to the tool card;
        // It cannot be used as the main assistant text creation generation step or refresh text tail packet time.
        return finalized;
      }
      markPromptFirstToken(prompt, now);
      closeReasoningStep(prompt, state, now, finalized);
      if (!state.generationStep) {
        state.generationStep = createAgentStep(state, "generation", now);
      }
      state.generationStep.lastMessageChunkAt = now;
      return finalized;

    case "tool_call": {
      markPromptFirstToken(prompt, now);
      closeReasoningStep(prompt, state, now, finalized);
      closeGenerationStep(
        prompt,
        state,
        now,
        "success",
        finalized,
        undefined,
        "tool_call",
        input.clientMode,
      );
      materializePendingModelUsageBeforeTool({
        prompt,
        state,
        now,
        finalized,
        clientMode: input.clientMode,
      });
      const toolStep = createAgentStep(state, "tool_call", now, {
        toolId: input.event.toolId,
        toolName: input.event.toolName ?? input.event.kind,
      });
      applyAgentStepToolAttribution(toolStep, input.toolAttribution);
      applyAgentStepSkillMetadata(toolStep, input.skillMetadata ?? input.event.skillMetadata);
      applySettledPermissionWaitAttribution(state, toolStep);
      state.toolStepsById.set(input.event.toolId, toolStep);
      return finalized;
    }

    case "tool_call_update": {
      markPromptFirstToken(prompt, now);
      if (input.event.status === "pending" || input.event.status === "in_progress") {
        if (!state.toolStepsById.has(input.event.toolId)) {
          closeReasoningStep(prompt, state, now, finalized);
          closeGenerationStep(
            prompt,
            state,
            now,
            "success",
            finalized,
            undefined,
            "tool_call",
            input.clientMode,
          );
          materializePendingModelUsageBeforeTool({
            prompt,
            state,
            now,
            finalized,
            clientMode: input.clientMode,
          });
          const toolStep = createAgentStep(state, "tool_call", now, {
            toolId: input.event.toolId,
            toolName: input.event.toolName ?? input.event.kind,
          });
          applyAgentStepToolAttribution(toolStep, input.toolAttribution);
          applyAgentStepSkillMetadata(toolStep, input.skillMetadata ?? input.event.skillMetadata);
          applySettledPermissionWaitAttribution(state, toolStep);
          state.toolStepsById.set(input.event.toolId, toolStep);
        }
        return finalized;
      }

      let existing = state.toolStepsById.get(input.event.toolId);
      if (!existing) {
        materializePendingModelUsageBeforeTool({
          prompt,
          state,
          now,
          finalized,
          clientMode: input.clientMode,
        });
        existing = createAgentStep(
          state,
          "tool_call",
          findEarliestPermissionRequestedAt(prompt, state, input.event.toolId) ?? now,
          {
            toolId: input.event.toolId,
            toolName: input.event.toolName ?? input.event.kind,
          },
        );
      }
      applyAgentStepSkillMetadata(existing, input.skillMetadata ?? input.event.skillMetadata);
      applyAgentStepToolAttribution(existing, input.toolAttribution);
      // Reason for repair: The recovery/out-of-order link may see permission_request first, and then directly receive the tool final status.
      // There is no prepended tool_call. First backfill the closed wait, and then put the bottom step back into the wait where the index consumption is still open.
      // Finally, correct startedAt to ensure that the tool wall clock time always covers waiting_ms.
      applySettledPermissionWaitAttribution(state, existing);
      state.toolStepsById.set(input.event.toolId, existing);
      settlePermissionWaitsForTool(prompt, state, input.event.toolId, now);
      existing.startedAt = Math.min(existing.startedAt, now - existing.waitingMs);
      state.toolStepsById.delete(input.event.toolId);
      finalized.push(
        finalizeAgentStep({
          prompt,
          step: {
            ...existing,
            toolName: input.event.toolName ?? input.event.kind ?? existing.toolName,
          },
          finishedAt: now,
          status: input.event.status,
          errorType: input.event.status === "failed" ? "TOOL_EXEC_ERROR" : undefined,
          errorMsg: input.event.error,
          // Bug reason: In the past, the compatibility flow only handed over the tool name and status to agent_step and CronCreate.
          // The returned new task ID remains in content, causing operations to be unable to associate creation steps with tasks.
          automationId:
            input.event.status === "completed" &&
            (input.event.toolName ?? input.event.kind ?? existing.toolName) === "CronCreate"
              ? cronCreateAutomationId(input.event.content)
              : undefined,
        }),
      );
      return finalized;
    }

    case "task_complete":
      settleAllPermissionWaits(prompt, state, now);
      closeReasoningStep(prompt, state, now, finalized);
      closeGenerationStep(
        prompt,
        state,
        now,
        "success",
        finalized,
        undefined,
        "task_complete",
        input.clientMode,
      );
      closeToolSteps(prompt, state, now, "success", finalized);
      agentStepTelemetryByTask.delete(input.taskId);
      return finalized;

    case "task_error":
      settleAllPermissionWaits(prompt, state, now);
      closeReasoningStep(prompt, state, now, finalized);
      closeGenerationStep(
        prompt,
        state,
        now,
        "fail",
        finalized,
        {
          type: input.event.code ?? "UNKNOWN",
          msg: input.event.error,
        },
        "task_error",
        input.clientMode,
      );
      closeToolSteps(prompt, state, now, "fail", finalized, {
        type: input.event.code ?? "UNKNOWN",
        msg: input.event.error,
      });
      agentStepTelemetryByTask.delete(input.taskId);
      return finalized;

    default:
      return finalized;
  }
}

// The model name of the currently activated prompt, used for ARMS mirroring events (stream_stall, etc.) to complete the model dimension;
// When there is no active prompt or model_name is not included, undefined is returned and left blank by the caller.
export function getActivePromptModelName(taskId: string): string | undefined {
  const active = activePromptTelemetryByTask.get(taskId);
  return active?.baseEventExtraDetail.model_name || undefined;
}

export function getActivePromptMessageId(taskId: string): string | undefined {
  return activePromptTelemetryByTask.get(taskId)?.messageId;
}

export function recordPromptTokenUsageDelta(input: {
  taskId: string;
  eventKey: string;
  usage: ZCodeUsage;
  requestId?: string;
  modelName?: string;
  modelProvider?: string;
  providerName?: string;
}): void {
  const active = activePromptTelemetryByTask.get(input.taskId);
  const eventKey = input.eventKey.trim();
  if (!active || eventKey.length === 0 || active.usageEventKeys.has(eventKey)) {
    return;
  }

  active.usageEventKeys.add(eventKey);
  active.usage = mergePromptUsage(active.usage, input.usage);

  const requestId = input.requestId?.trim();
  if (!requestId) return;
  const state = getAgentStepTelemetryState(input.taskId);
  const modelName = input.modelName?.trim();
  const modelProvider = input.modelProvider?.trim();
  const providerName = input.providerName?.trim();
  const step = findModelOutputStepForRequest(state, requestId);
  if (step) {
    step.model = {
      requestId,
      modelName: modelName ?? step.model?.modelName ?? "",
      modelProvider: modelProvider ?? step.model?.modelProvider ?? "",
      providerName: providerName ?? step.model?.providerName ?? "",
    };
    assignUsageToStep(step, {
      requestIds: [requestId],
      requestCount: 1,
      scope: "model_request",
      usage: input.usage,
    });
    return;
  }

  state.pendingUsageByRequestId.set(requestId, {
    requestIds: [requestId],
    requestCount: 1,
    scope: "model_request",
    usage: input.usage,
  });
}

export function recordPromptPermissionRequest(input: {
  taskId: string;
  requestId: string;
  toolCallId?: string;
  raw?: unknown;
  now?: number;
}): void {
  const active = activePromptTelemetryByTask.get(input.taskId);
  const requestId = input.requestId.trim();
  if (!active || requestId.length === 0 || active.permissionWaitsByRequestId.has(requestId)) {
    return;
  }

  const raw =
    input.raw !== null && typeof input.raw === "object"
      ? (input.raw as Record<string, unknown>)
      : {};
  const rawToolCallId =
    typeof raw.toolCallId === "string" && raw.toolCallId.trim().length > 0
      ? raw.toolCallId.trim()
      : undefined;
  const toolCallId = input.toolCallId?.trim() || rawToolCallId || requestId;
  active.permissionWaitsByRequestId.set(requestId, {
    requestedAt: input.now ?? Date.now(),
    ...(toolCallId ? { toolCallId } : {}),
  });
}

export function recordPromptPermissionResponse(input: {
  taskId: string;
  requestId: string;
  now?: number;
}): void {
  const active = activePromptTelemetryByTask.get(input.taskId);
  if (!active) {
    return;
  }

  settlePermissionWait(
    active,
    agentStepTelemetryByTask.get(input.taskId),
    input.requestId,
    input.now ?? Date.now(),
  );
}

export function finalizePromptTelemetry(
  input: FinalizePromptTelemetryInput,
): FinalizedPromptTelemetry | null {
  const active = activePromptTelemetryByTask.get(input.taskId);
  if (!active) {
    return null;
  }

  settleAllPermissionWaits(active, agentStepTelemetryByTask.get(input.taskId), input.finishedAt);
  activePromptTelemetryByTask.delete(input.taskId);
  agentStepTelemetryByTask.delete(input.taskId);

  const { changedFileCount, generatedCodeLines } = collectFileChangeMetrics(input.fileChanges);
  const isSuccess = input.status === "success";
  // The usage of V4 live fact arrives in low-frequency delta, and the terminal does not repeatedly carry the entire package of accumulated values;
  // The old link can still be used directly in the terminal. In the successful state, explicit terminal usage is preferred, and the default falls back to aggregated delta.
  const usageForTelemetry = isSuccess
    ? (input.usage ?? active.usage ?? undefined)
    : (active.usage ?? undefined);
  const tokenSource = !isSuccess && active.usage ? "usage_delta" : undefined;
  const errorType = isSuccess
    ? ""
    : input.errorType?.trim() || (active.toolCallFailed > 0 ? "TOOL_CALL_FAILED" : "UNKNOWN");
  const errorMsg = isSuccess ? "" : input.errorMsg?.trim() || active.firstToolCallError;

  return {
    taskId: input.taskId,
    messageId: active.messageId,
    eventExtraDetail: {
      ...legacyTelemetryModelFields(active.baseEventExtraDetail),
      ...(usageForTelemetry
        ? buildPromptUsageTelemetryExtraDetail(usageForTelemetry, tokenSource)
        : {}),
      duration_ms: String(Math.max(input.finishedAt - active.sendTime, 0)),
      waiting_ms: String(active.waitingMs),
      generated_code_lines: String(generatedCodeLines),
      file_change_cnt: String(changedFileCount),
      time_to_first_token:
        active.firstTokenAt === null
          ? "-1"
          : String(Math.max(active.firstTokenAt - active.sendTime, 0)),
      request_time: String(active.sendTime),
      status: input.status,
      ...(input.messageSource ? { message_source: input.messageSource } : {}),
      agent_composition: input.agentComposition ?? "main_only",
      agent_step_cnt: String(active.finalizedAgentStepCount),
      retry_cnt: "0",
      tool_call_total: String(active.toolCallTotal),
      tool_call_failed: String(active.toolCallFailed),
      error_type: errorType,
      error_msg: errorMsg,
    },
  };
}

/**
 * When a workspace telemetry attachment is released, it only clears its own internal task key and
 * does not affect other workspaces.
 */
export function discardPromptTelemetry(taskId: string): void {
  queuedPromptTelemetryByTask.delete(taskId);
  activePromptTelemetryByTask.delete(taskId);
  agentStepTelemetryByTask.delete(taskId);
}

/**
 * Only the single not-yet-activated prompt is discarded, so that other queued messages in the same
 * session are not cleared along with it.
 */
export function discardQueuedPromptTelemetry(taskId: string, messageId: string): void {
  const queue = queuedPromptTelemetryByTask.get(taskId);
  if (!queue) return;
  const next = queue.filter((item) => item.messageId !== messageId);
  if (next.length === 0) {
    queuedPromptTelemetryByTask.delete(taskId);
    return;
  }
  queuedPromptTelemetryByTask.set(taskId, next);
}
