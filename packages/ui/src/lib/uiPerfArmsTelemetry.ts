import {
  sanitizeTelemetryModelValue,
  type ArmsCustomEventPayload,
  type IPlatformService,
  type LaunchMarks,
} from "@zcode/shared";
import { logger } from "@/logger.js";

const UI_PERF_ARMS_GROUP = "ui_perf";

const UI_PERF_EVENT_LAUNCH_TO_INPUT = "perf_ui_launch_to_input";
const UI_PERF_EVENT_LAUNCH_ELECTRON_INIT = "perf_ui_launch_electron_init_ms";
const UI_PERF_EVENT_LAUNCH_APP_READY = "perf_ui_launch_app_ready_ms";
const UI_PERF_EVENT_LAUNCH_WINDOW = "perf_ui_launch_window_ms";
const UI_PERF_EVENT_LAUNCH_RENDERER_LOAD = "perf_ui_launch_renderer_load_ms";
const UI_PERF_EVENT_LAUNCH_REACT_COMMIT = "perf_ui_launch_react_commit_ms";
const UI_PERF_EVENT_LAUNCH_STARTUP_GATE = "perf_ui_launch_startup_gate_ms";

// If the total duration exceeds this value, it will be regarded as clock abnormality/hang, and the entire batch will be discarded to avoid contaminating the distribution.
const LAUNCH_TO_INPUT_SANITY_MAX_MS = 300000;

const UI_PERF_EVENT_FIRST_TOKEN = "perf_ui_first_token";
const UI_PERF_EVENT_MESSAGE_COMPLETE = "perf_ui_message_complete";
const UI_PERF_EVENT_TURN_BREAKDOWN = "perf_ui_turn_breakdown";
const UI_PERF_EVENT_TOOL_CALL_DETAIL = "perf_ui_tool_call_detail";
const UI_PERF_EVENT_STREAM_STALL = "perf_ui_stream_stall";

// If no new chunk is received beyond this interval (ms), it will be regarded as a pause and reported; the value is still the real interval. Can be tightened according to online distribution.
// The period of tool call (tool_call/tool_call_update) is not counted: the tool event will clearStreamStallTracking,
// The first text chunk after the tool is regarded as the first and is not compared with the chunk before the tool to avoid misjudgment of tool execution as a pause.
const STREAM_STALL_REPORT_THRESHOLD_MS = 3000;

type ArmsReporter = Pick<IPlatformService, "reportArmsCustomEvent">;

let armsReporter: ArmsReporter | null = null;

export function setUiPerfArmsReporter(reporter: ArmsReporter | null): void {
  armsReporter = reporter;
}

/**
 * `model` in this set of events comes from `detail.model_name`, and under the custom provider is the user-named encoded value.
 * Unified normalization at the only exit to avoid missing new events after each report function processes them separately; normalization only affects the reported value.
 * The model selection and local log obtained by the caller are not changed.
 */
function sanitizeModelProperty(
  properties: ArmsCustomEventPayload["properties"],
): ArmsCustomEventPayload["properties"] {
  if (!properties || typeof properties.model !== "string") {
    return properties;
  }
  const model = sanitizeTelemetryModelValue(properties.model);
  return { ...properties, model: model || undefined };
}

// Reason: ARMS is an observation link, and the main UI process (starting/sending/rendering) must not be interrupted due to failure to bury points.
function emit(payload: ArmsCustomEventPayload): void {
  if (!armsReporter) {
    return;
  }
  const sanitized: ArmsCustomEventPayload = {
    ...payload,
    properties: sanitizeModelProperty(payload.properties),
  };
  try {
    void Promise.resolve(armsReporter.reportArmsCustomEvent(sanitized)).catch((error) => {
      logger.warn("[ui-perf] ARMS report failed", { name: payload.name, error });
    });
  } catch (error) {
    logger.warn("[ui-perf] ARMS report threw", { name: payload.name, error });
  }
}

interface LaunchToInputTimings {
  marks: LaunchMarks;
  /** renderer/src/main.tsx module top Date.now() (T4) */
  rendererStart: number;
  /** zcode-react-startup-ready is triggered when Date.now() (T5) */
  reactCommit: number;
  /** Date.now() (T6) when access control clearing is started and the input box is available */
  inputReady: number;
  /** Associated keys for the same startup */
  sessionId: string;
}

function clampMs(ms: number): number {
  return Math.max(0, Math.round(ms));
}

function optionalRoundedNumber(value: number | undefined): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  const rounded = Math.round(value);
  return rounded >= 0 ? rounded : undefined;
}

export function reportUiLaunchToInput(timings: LaunchToInputTimings): void {
  const { marks, rendererStart, reactCommit, inputReady, sessionId } = timings;
  const total = inputReady - marks.createdAt;
  // 6 original durations (uncensored). Work it all out before sending so that the entire batch can be verified.
  const stageMs = {
    electronInit: marks.mainStart - marks.createdAt,
    appReady: marks.appReady - marks.mainStart,
    window: marks.loadUrl - marks.appReady,
    rendererLoad: rendererStart - marks.loadUrl,
    reactCommit: reactCommit - rendererStart,
    startupGate: inputReady - reactCommit,
  };
  // Sentinel: The total duration of the exception (clock jump/process hang) is discarded in batches.
  if (total < 0 || total > LAUNCH_TO_INPUT_SANITY_MAX_MS) {
    logger.warn("[ui-perf] launch_to_input total duration out of range, dropping", { total });
    return;
  }
  // If any section is negative (the cross-process clock offset between the main process T0–T3 and the rendering process T4–T6), the entire batch will be discarded.
  // Otherwise sum(6 segments) != total, breaking the identity that Kanban relies on. Keep it all or nothing with Total Duration Sentinel.
  const negativeStage = Object.entries(stageMs).find(([, ms]) => ms < 0);
  if (negativeStage) {
    logger.warn(
      "[ui-perf] launch_to_input has a negative stage (cross-process clock skew/rollback), dropping the whole batch",
      {
        stage: negativeStage[0],
        ms: negativeStage[1],
      },
    );
    return;
  }
  const properties = { session_id: sessionId };
  // At this point, each paragraph is guaranteed to be >= 0, and the max(0,...) of clampMs is redundant insurance and is only used for consistent Math.round rounding.
  const stages: { name: string; ms: number }[] = [
    { name: UI_PERF_EVENT_LAUNCH_TO_INPUT, ms: total },
    { name: UI_PERF_EVENT_LAUNCH_ELECTRON_INIT, ms: stageMs.electronInit },
    { name: UI_PERF_EVENT_LAUNCH_APP_READY, ms: stageMs.appReady },
    { name: UI_PERF_EVENT_LAUNCH_WINDOW, ms: stageMs.window },
    { name: UI_PERF_EVENT_LAUNCH_RENDERER_LOAD, ms: stageMs.rendererLoad },
    { name: UI_PERF_EVENT_LAUNCH_REACT_COMMIT, ms: stageMs.reactCommit },
    { name: UI_PERF_EVENT_LAUNCH_STARTUP_GATE, ms: stageMs.startupGate },
  ];
  for (const stage of stages) {
    emit({
      name: stage.name,
      group: UI_PERF_ARMS_GROUP,
      value: clampMs(stage.ms),
      properties,
    });
  }
}

export function reportUiFirstToken(params: {
  ttftMs: number;
  model?: string;
  talkId?: string;
  messageId?: string;
}): void {
  emit({
    name: UI_PERF_EVENT_FIRST_TOKEN,
    group: UI_PERF_ARMS_GROUP,
    value: Math.max(0, Math.round(params.ttftMs)),
    properties: {
      model: params.model,
      talk_id: params.talkId,
      message_id: params.messageId,
    },
  });
}

export function reportUiMessageComplete(params: {
  durationMs: number;
  result: string;
  model?: string;
  talkId?: string;
  messageId?: string;
}): void {
  emit({
    name: UI_PERF_EVENT_MESSAGE_COMPLETE,
    group: UI_PERF_ARMS_GROUP,
    value: Math.max(0, Math.round(params.durationMs)),
    properties: {
      result: params.result,
      model: params.model,
      talk_id: params.talkId,
      message_id: params.messageId,
    },
  });
}

export function reportUiTurnBreakdown(params: {
  durationMs: number;
  result: string;
  model?: string;
  talkId?: string;
  messageId?: string;
  ttftMs?: number;
  waitingMs?: number;
  toolCallTotal?: number;
  toolCallFailed?: number;
  agentStepCount?: number;
  retryCount?: number;
  fileChangeCount?: number;
  generatedCodeLines?: number;
}): void {
  const durationMs = Math.max(0, Math.round(params.durationMs));
  emit({
    name: UI_PERF_EVENT_TURN_BREAKDOWN,
    group: UI_PERF_ARMS_GROUP,
    value: durationMs,
    properties: {
      result: params.result,
      model: params.model,
      talk_id: params.talkId,
      message_id: params.messageId,
      duration_ms: durationMs,
      ttft_ms: optionalRoundedNumber(params.ttftMs),
      waiting_ms: optionalRoundedNumber(params.waitingMs),
      tool_call_total: optionalRoundedNumber(params.toolCallTotal),
      tool_call_failed: optionalRoundedNumber(params.toolCallFailed),
      agent_step_cnt: optionalRoundedNumber(params.agentStepCount),
      retry_cnt: optionalRoundedNumber(params.retryCount),
      file_change_cnt: optionalRoundedNumber(params.fileChangeCount),
      generated_code_lines: optionalRoundedNumber(params.generatedCodeLines),
    },
  });
}

export function reportUiToolCallDetail(params: {
  toolName?: string;
  status: string;
  talkId?: string;
  messageId?: string;
  toolCallId?: string;
  parentToolCallId?: string;
  childToolCallId?: string;
  childSessionId?: string;
  agentId?: string;
  agentType?: string;
  totalMs?: number;
  permissionWaitMs?: number;
  commandRunMs?: number;
  firstOutputMs?: number;
  noOutputMs?: number;
  exitCode?: number;
  timedOut?: boolean;
  outputBytes?: number;
  commandCategory?: string;
  commandName?: string;
  commandCount?: number;
  commandStatus?: string;
  fsReadMs?: number;
  fsWriteMs?: number;
  patchMatchMs?: number;
  fileCount?: number;
  totalBytes?: number;
  maxFileBytes?: number;
  hunkCount?: number;
  matchAttempts?: number;
  workspaceKind?: string;
}): void {
  const totalMs = optionalRoundedNumber(params.totalMs);
  const value =
    totalMs ??
    optionalRoundedNumber(params.commandRunMs) ??
    optionalRoundedNumber(params.fsWriteMs) ??
    optionalRoundedNumber(params.fsReadMs) ??
    0;
  emit({
    name: UI_PERF_EVENT_TOOL_CALL_DETAIL,
    group: UI_PERF_ARMS_GROUP,
    value,
    properties: {
      tool_name: params.toolName,
      status: params.status,
      talk_id: params.talkId,
      message_id: params.messageId,
      tool_call_id: params.toolCallId,
      parent_tool_call_id: params.parentToolCallId,
      child_tool_call_id: params.childToolCallId,
      child_session_id: params.childSessionId,
      agent_id: params.agentId,
      agent_type: params.agentType,
      total_ms: totalMs,
      permission_wait_ms: optionalRoundedNumber(params.permissionWaitMs),
      command_run_ms: optionalRoundedNumber(params.commandRunMs),
      first_output_ms: optionalRoundedNumber(params.firstOutputMs),
      no_output_ms: optionalRoundedNumber(params.noOutputMs),
      exit_code:
        typeof params.exitCode === "number" && Number.isFinite(params.exitCode)
          ? Math.round(params.exitCode)
          : undefined,
      timed_out: params.timedOut,
      output_bytes: optionalRoundedNumber(params.outputBytes),
      command_category: params.commandCategory,
      command_name: params.commandName,
      command_count: optionalRoundedNumber(params.commandCount),
      command_status: params.commandStatus,
      fs_read_ms: optionalRoundedNumber(params.fsReadMs),
      fs_write_ms: optionalRoundedNumber(params.fsWriteMs),
      patch_match_ms: optionalRoundedNumber(params.patchMatchMs),
      file_count: optionalRoundedNumber(params.fileCount),
      total_bytes: optionalRoundedNumber(params.totalBytes),
      max_file_bytes: optionalRoundedNumber(params.maxFileBytes),
      hunk_count: optionalRoundedNumber(params.hunkCount),
      match_attempts: optionalRoundedNumber(params.matchAttempts),
      workspace_kind: params.workspaceKind,
    },
  });
}

// Streaming pause: per-task records the arrival time of the previous text chunk. If the interval exceeds the threshold, the real interval is reported.
const lastChunkAtByTask = new Map<string, number>();

export function recordStreamChunkArrival(
  taskId: string,
  options?: {
    waitingTool?: boolean;
    /** The tracker can use the workspace-scoped internal key; the reported talk_id still remains true. */
    talkId?: string;
    messageId?: string;
    model?: string;
    chunkType?: "message" | "thought" | "unknown";
    now?: number;
  },
): void {
  const now = options?.now ?? Date.now();
  const last = lastChunkAtByTask.get(taskId);
  lastChunkAtByTask.set(taskId, now);
  if (last === undefined) {
    return;
  }
  const gapMs = now - last;
  if (gapMs <= STREAM_STALL_REPORT_THRESHOLD_MS) {
    return;
  }
  emit({
    name: UI_PERF_EVENT_STREAM_STALL,
    group: UI_PERF_ARMS_GROUP,
    value: Math.round(gapMs),
    properties: {
      stall_ms: Math.round(gapMs),
      waiting_tool: options?.waitingTool ?? false,
      model: options?.model,
      chunk_type: options?.chunkType,
      talk_id: options?.talkId ?? taskId,
      // The messageId of the chunk at the end of the pause; the text/thought chunk is usually not included, and if not available, leave it blank (the same as other fields).
      message_id: options?.messageId,
    },
  });
}

export function clearStreamStallTracking(taskId: string): void {
  lastChunkAtByTask.delete(taskId);
}

// Input box freeze: Testing "single input processing time" (getEditorMarkdown+onChange synchronization segment) within Lexical update listener.
// Differentiate from stream_stall (output side): this is the input side. Only the over-threshold stuck points are reported, and the number of events is minimal.
const UI_PERF_EVENT_INPUT_LAG = "perf_ui_input_lag";

// Conservative starting point: only catch the most serious lags. It can be tightened downward according to the online distribution.
const INPUT_LAG_REPORT_THRESHOLD_MS = 500;
// Exceeding this value is most likely caused by breakpoint debugging/tab hang/device sleep wake-up, which should be discarded to avoid contaminating the distribution.
const INPUT_LAG_SANITY_MAX_MS = 5000;

// Determine the pure function to facilitate single testing: programmatic rewriting (paste/setText/mention/history backfill) and IME combination state
// It’s not considered typing lag, even if it takes too long, it will be skipped.
function shouldReportInputLag(args: {
  lagMs: number;
  isProgrammatic: boolean;
  isComposing: boolean;
}): boolean {
  if (args.isProgrammatic || args.isComposing) {
    return false;
  }
  return args.lagMs > INPUT_LAG_REPORT_THRESHOLD_MS && args.lagMs <= INPUT_LAG_SANITY_MAX_MS;
}

export function recordInputLag(params: {
  lagMs: number;
  textLength: number;
  isProgrammatic: boolean;
  isComposing: boolean;
  taskId?: string;
}): void {
  if (
    !shouldReportInputLag({
      lagMs: params.lagMs,
      isProgrammatic: params.isProgrammatic,
      isComposing: params.isComposing,
    })
  ) {
    return;
  }
  const lagMs = Math.round(params.lagMs);
  emit({
    name: UI_PERF_EVENT_INPUT_LAG,
    group: UI_PERF_ARMS_GROUP,
    value: lagMs,
    properties: {
      lag_ms: lagMs,
      text_length: params.textLength,
      // There is no taskId in the draft state, leaving it blank is consistent with the caliber of other ui_perf events.
      task_id: params.taskId,
    },
  });
}
