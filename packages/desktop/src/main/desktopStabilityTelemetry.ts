/* eslint-disable max-lines -- Stability reporting deliberately lives in one module; splitting it would only add cross-file state synchronisation */
import { createHash, randomUUID } from "node:crypto";
import armsRum from "@arms/rum-electron";
import { BrowserWindow, type WebContents } from "electron";
import {
  mapZCodeEnvToArmsRumEnv,
  type HostAgentProcessErrorResponse,
  type HostAgentProcessExceptionResponse,
  type HostAgentProcessExitedResponse,
  type HostAgentProcessReadyResponse,
  type HostAgentProcessSpawnedResponse,
} from "@zcode/shared";
import type { CrashCapturePaths } from "./desktopCrashCapture.js";
import { registerCrashEventMonitor as registerBaseCrashEventMonitor } from "./desktopCrashCapture.js";
import { getResourceManagerWindowId } from "./resourceManagerWindow.js";

/** ANR: Main thread unresponsive threshold (aligned with Electron unresponsive) */
const STABILITY_ANR_THRESHOLD_MS = 5_000;
/** Hanged: Longer unresponsiveness threshold without recovery and without crash */
const STABILITY_FREEZE_THRESHOLD_MS = 30_000;
const AGENT_CRASH_ERROR_DETAIL_MAX_LENGTH = 4_000;
const STABILITY_TELEMETRY_SCHEMA_VERSION = 2;
const WINDOWS_CONTROLLED_TERMINATION_EXIT_CODE = 0x40010004;
const AGENT_EXCEPTION_DEDUP_CAPACITY = 1024;
const reportedAgentExceptions = new Set<string>();

const AGENT_CRASH_SENSITIVE_ASSIGNMENT_PATTERN =
  /(["']?(?:api[-_]?key|authorization|cookie|credential|password|secret|token)["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;}]+)/gi;
const AGENT_CRASH_AUTH_SCHEME_PATTERN = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi;
const AGENT_CRASH_API_KEY_PATTERN = /\b(sk-)[A-Za-z0-9_-]{16,}\b/gi;
const AGENT_CRASH_UUID_PATTERN =
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi;
const AGENT_CRASH_STACK_LOCATION_PATTERN = /:\d+:\d+/g;
const AGENT_CRASH_POSIX_HOME_PATTERN = /\/(?:Users|home)\/[^/\s"'`()[\]{}<>]+/g;
const AGENT_CRASH_WINDOWS_HOME_PATTERN = /\b[A-Za-z]:[\\/]+Users[\\/]+[^\\/\s"'`()[\]{}<>]+/gi;
const AGENT_CRASH_WINDOWS_ABSOLUTE_PATH_PATTERN =
  /\b[A-Za-z]:[\\/](?:[^\\/\s"'`()[\]{}<>:]+[\\/])*[^\\/\s"'`()[\]{}<>:]+/g;
const AGENT_CRASH_POSIX_ABSOLUTE_PATH_PATTERN =
  /\/(?:[^/\s"'`()[\]{}<>:]+\/)*[^/\s"'`()[\]{}<>:]+/g;
const AGENT_CRASH_KNOWN_PATH_PLACEHOLDER_PATTERN = /<(?:workspace|home)>[^\s"'`()[\]{}<>]*/g;

type StabilityLifecycleScene = "cold_start" | "runtime" | "app_quit" | "update_install";

type StabilityWindowScene = "main" | "process_monitor" | "other";

type StabilityCrashKind = "native" | "js" | "oom";

type StabilityCrashScope =
  | "app_native_process"
  | "main_window_renderer"
  | "auxiliary_window_renderer"
  | "embedded_webview"
  | "host"
  | "child";

type StabilityCrashCause =
  | "oom"
  | "process_crashed"
  | "abnormal_exit"
  | "launch_failed"
  | "integrity_failure"
  | "native_crash"
  | "unknown";

interface StabilityCrashClassification {
  crashKind: StabilityCrashKind;
  crashScope: StabilityCrashScope;
  crashCause: StabilityCrashCause;
}

type StabilityProcessRole =
  | "main"
  | "renderer"
  | "gpu"
  | "utility"
  | "agent"
  | "host"
  | "child"
  | "unknown";

type AgentCrashPhase = "startup" | "runtime" | "unknown";
type AgentTerminationClass = "exit_zero" | "exit_nonzero" | "signal" | "unknown";
type AgentDiagnosticClass = "oom" | "sqlite" | "errno" | "generic" | "none";

interface StabilityLogger {
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
  debug?: (...args: unknown[]) => void;
}

interface StabilityGlobalContext {
  deviceMid: string;
  platform: NodeJS.Platform;
  appVersion: string;
  armsEnv: ReturnType<typeof mapZCodeEnvToArmsRumEnv>;
}

interface UnresponsiveWatchState {
  windowId: number;
  webContentsId: number;
  windowScene: StabilityWindowScene;
  startedAt: number;
  anrReported: boolean;
  freezeReported: boolean;
  crashReported: boolean;
  pollTimer: ReturnType<typeof setTimeout> | null;
}

interface RenderProcessGoneInput {
  reason: string;
  exitCode: number;
  webContentsType: string;
  windowScene?: StabilityWindowScene;
}

interface ChildProcessGoneInput {
  type: string;
  reason: string;
  exitCode: number;
  serviceName?: string;
  name: string;
}

let globalContext: StabilityGlobalContext | null = null;
let lifecycleScene: StabilityLifecycleScene = "runtime";
// Reason for repair: WebContents.getType() returns window for all BrowserWindow, and cannot distinguish between main business window and
// Resource Manager / Updates / About. Only register the business window created by createWindowInstance to avoid auxiliary windows from polluting the crash rate.
const mainWindowIds = new Set<number>();
let perfAppStartReported = false;
const unresponsiveByWebContentsId = new Map<number, UnresponsiveWatchState>();

function normalizeOsCategory(platform: NodeJS.Platform): string {
  switch (platform) {
    case "darwin":
      return "macos";
    case "win32":
      return "windows";
    default:
      return "linux";
  }
}

function stringifyProperties(
  properties: Record<string, string | number | boolean | undefined>,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(properties)) {
    if (value === undefined) {
      continue;
    }
    result[key] = String(value);
  }
  return result;
}

function resolveStabilityMetricValue(
  name: string,
  properties: Record<string, string | number | boolean | undefined>,
): number {
  switch (name) {
    case "perf_anr":
    case "perf_freeze": {
      const duration = Number(properties.duration_ms);
      return Number.isFinite(duration) ? duration : 0;
    }
    case "perf_app_exit":
    case "perf_process_exit": {
      const exitCode = Number(properties.exit_code);
      return Number.isFinite(exitCode) ? exitCode : 0;
    }
    case "perf_crash":
      return 1;
    case "perf_app_start":
    default:
      return 1;
  }
}

function truncateAgentCrashDetail(value: string): string {
  return value.length > AGENT_CRASH_ERROR_DETAIL_MAX_LENGTH
    ? value.slice(0, AGENT_CRASH_ERROR_DETAIL_MAX_LENGTH)
    : value;
}

function redactRemainingAbsolutePaths(value: string): string {
  const protectedPaths: string[] = [];
  const protectedValue = value.replace(AGENT_CRASH_KNOWN_PATH_PLACEHOLDER_PATTERN, (match) => {
    const index = protectedPaths.push(match) - 1;
    return `ZCODE_REDACTED_PATH_${index}_TOKEN`;
  });
  const redacted = protectedValue
    .replace(AGENT_CRASH_WINDOWS_ABSOLUTE_PATH_PATTERN, "<path>")
    .replace(AGENT_CRASH_POSIX_ABSOLUTE_PATH_PATTERN, "<path>");
  return protectedPaths.reduce(
    (result, protectedPath, index) =>
      result.replace(`ZCODE_REDACTED_PATH_${index}_TOKEN`, protectedPath),
    redacted,
  );
}

function sanitizeAgentCrashDetail(value: string, workspacePath: string): string {
  const withoutWorkspace = workspacePath ? value.split(workspacePath).join("<workspace>") : value;
  return truncateAgentCrashDetail(
    redactRemainingAbsolutePaths(
      withoutWorkspace
        .replace(AGENT_CRASH_WINDOWS_HOME_PATTERN, "<home>")
        .replace(AGENT_CRASH_POSIX_HOME_PATTERN, "<home>"),
    )
      .replace(AGENT_CRASH_SENSITIVE_ASSIGNMENT_PATTERN, "$1<redacted>")
      .replace(AGENT_CRASH_AUTH_SCHEME_PATTERN, "$1 <redacted>")
      // Reason for fix: Host reporter is not the only input boundary and main must mask the bare key again before sending RUM.
      .replace(AGENT_CRASH_API_KEY_PATTERN, "$1<redacted>"),
  );
}

function normalizeAgentCrashFingerprintSource(value: string): string {
  return value
    .replace(/\\/g, "/")
    .replace(AGENT_CRASH_UUID_PATTERN, "<uuid>")
    .replace(AGENT_CRASH_STACK_LOCATION_PATTERN, ":<line>:<column>")
    .replace(/\bpid\s*[:=]\s*\d+\b/gi, "pid=<pid>")
    .replace(AGENT_CRASH_WINDOWS_ABSOLUTE_PATH_PATTERN, "<path>")
    .replace(AGENT_CRASH_POSIX_ABSOLUTE_PATH_PATTERN, "<path>")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 1_000);
}

function normalizeAgentDiagnosticSummary(value: string): string {
  return truncateAgentCrashDetail(value.replace(/\\/g, "/").trim());
}

function isAgentDiagnosticNoise(line: string): boolean {
  return (
    /^(?:\[Object\]\s*,?\s*)+$/i.test(line) ||
    /\[Object\]/i.test(line) ||
    /^node:(?:events|internal)\b/i.test(line) ||
    /^at\s+/i.test(line) ||
    /^\d+:\s*0x[0-9a-f]+\b/i.test(line) ||
    /^\[\d+:0x[0-9a-f]+\]/i.test(line) ||
    /^<---.*--->$/.test(line) ||
    /^-+\s*(?:Native stack trace|JS stacktrace)\s*-+$/i.test(line) ||
    /^\(node:\d+\)\s*ExperimentalWarning:/i.test(line) ||
    /^\(Use `.*--trace-warnings.*\)$/i.test(line) ||
    /^(?:throw er;|Emitted ['"]error['"] event on .* instance at:)$/i.test(line) ||
    /^[}\]]\s*,?$/.test(line) ||
    /^(?:\{|\[)$/.test(line) ||
    /^["']?[\w-]+["']?\s*:\s*(?:\{|\[)$/.test(line) ||
    /^["']?code["']?\s*:\s*["'][A-Z0-9_]+["'],?$/i.test(line)
  );
}

function extractAgentErrorCode(value: string): string {
  const explicit = value.match(/\bcode:\s*["']?([A-Z][A-Z0-9_]+)\b/i)?.[1]?.toUpperCase();
  if (explicit && explicit !== "ERROR") {
    return explicit;
  }
  return (
    value
      .match(/\b(?:[A-Z]+_ERR_[A-Z0-9_]+|ERR_[A-Z0-9_]+|SQLITE_[A-Z0-9_]+|E[A-Z0-9_]{2,})\b/g)
      ?.find((candidate) => candidate !== "ERROR") ?? ""
  );
}

function isErrnoCode(errorCode: string): boolean {
  return /^E[A-Z0-9_]{2,}$/.test(errorCode) && !errorCode.startsWith("ERR_");
}

function isSqliteDiagnostic(value: string, errorCode: string): boolean {
  return (
    /^SQLITE_/i.test(errorCode) ||
    /\bSQLiteError\b|\bSQLite\s+(?:migration|database|initialization|lock)\b|\bdatabase (?:is locked|disk image is malformed)\b/i.test(
      value,
    )
  );
}

function classifyAgentDiagnostic(
  value: string,
  errorCode: string,
  hasUsefulSummary: boolean,
): AgentDiagnosticClass {
  if (/\b(?:JavaScript heap out of memory|Reached heap limit)\b/i.test(value)) {
    return "oom";
  }
  if (isSqliteDiagnostic(value, errorCode)) {
    return "sqlite";
  }
  if (isErrnoCode(errorCode)) {
    return "errno";
  }
  return hasUsefulSummary ? "generic" : "none";
}

function createAgentCrashFingerprint(parts: string[]): string {
  return createHash("sha256")
    .update(parts.map(normalizeAgentCrashFingerprintSource).join("|"))
    .digest("hex")
    .slice(0, 16);
}

function parseAgentStderrDiagnostic(event: HostAgentProcessExitedResponse): {
  errorName: string;
  errorCode: string;
  errorMessage: string;
  errorStack: string;
  errorFingerprint: string;
  diagnosticClass: AgentDiagnosticClass;
} {
  const errorStack = sanitizeAgentCrashDetail(
    event.stderrTail?.join("\n") ?? "",
    event.workspacePath,
  );
  const lines = errorStack
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  // Bug root cause: The old logic treats the first non-empty line of stderr as a summary, [Object], GC header and
  // The native address thus overrides the real OOM/SQLite/errno. Sort structural noise first, then select rows based on diagnostic certainty.
  const usefulLines = lines.filter((line) => !isAgentDiagnosticNoise(line));
  const oomLine = usefulLines.find((line) =>
    /\b(?:JavaScript heap out of memory|Reached heap limit)\b/i.test(line),
  );
  const stackErrorCode = extractAgentErrorCode(errorStack);
  const sqliteLine = usefulLines.find(
    (line) => !/ExperimentalWarning:/i.test(line) && isSqliteDiagnostic(line, stackErrorCode),
  );
  const errnoLine = usefulLines.find((line) => isErrnoCode(extractAgentErrorCode(line)));
  const errorLine =
    oomLine ??
    sqliteLine ??
    errnoLine ??
    usefulLines.find((line) => /^(?:[A-Za-z_$][\w$]*Error|Error):\s*/.test(line)) ??
    usefulLines.find((line) => /\b(?:Exception|fatal|panic|process exited)\b/i.test(line)) ??
    usefulLines[0];
  const errorMatch = errorLine?.match(/^([A-Za-z_$][\w$]*Error|Error):\s*(.*)$/);
  const errorName = oomLine ? "AgentOutOfMemory" : (errorMatch?.[1] ?? "AgentProcessExit");
  const fallbackMessage = `Agent process exited unexpectedly (code=${event.exitCode ?? "null"}, signal=${event.signal ?? "null"})`;
  const errorMessage = normalizeAgentDiagnosticSummary(
    (oomLine ? oomLine.replace(/^FATAL ERROR:\s*/i, "") : errorMatch?.[2]?.trim()) ||
      errorLine ||
      fallbackMessage,
  );
  const errorCode = oomLine
    ? "ERR_OUT_OF_MEMORY"
    : extractAgentErrorCode(`${errorMessage}\n${errorStack}`);
  const diagnosticClass = classifyAgentDiagnostic(
    `${errorMessage}\n${errorStack}`,
    errorCode,
    errorLine != null,
  );
  return {
    errorName,
    errorCode,
    errorMessage,
    errorStack,
    diagnosticClass,
    errorFingerprint: createAgentCrashFingerprint([
      errorName,
      errorCode,
      errorMessage,
      lines.find((line) => line.startsWith("at ")) ?? "",
    ]),
  };
}

function parseAgentSpawnDiagnostic(event: HostAgentProcessErrorResponse): {
  errorName: string;
  errorCode: string;
  errorMessage: string;
  errorStack: string;
  errorFingerprint: string;
  diagnosticClass: AgentDiagnosticClass;
} {
  const errorName = event.errorName || "Error";
  const errorCode = event.errorCode ?? "";
  const errorMessage = sanitizeAgentCrashDetail(event.errorMessage, event.workspacePath);
  const errorStack = sanitizeAgentCrashDetail(event.errorStack ?? "", event.workspacePath);
  const diagnosticClass = classifyAgentDiagnostic(
    `${errorMessage}\n${errorStack}`,
    errorCode,
    Boolean(errorMessage),
  );
  return {
    errorName,
    errorCode,
    errorMessage,
    errorStack,
    diagnosticClass,
    errorFingerprint: createAgentCrashFingerprint([
      errorName,
      errorCode,
      errorMessage,
      errorStack.split(/\r?\n/).find((line) => line.trim().startsWith("at ")) ?? "",
    ]),
  };
}

function classifyAgentCrashPhase(runtimeReady: boolean | undefined): AgentCrashPhase {
  if (runtimeReady === true) {
    return "runtime";
  }
  if (runtimeReady === false) {
    return "startup";
  }
  return "unknown";
}

function classifyAgentTermination(event: HostAgentProcessExitedResponse): AgentTerminationClass {
  if (event.signal) {
    return "signal";
  }
  if (event.exitCode === 0) {
    return "exit_zero";
  }
  if (typeof event.exitCode === "number") {
    return "exit_nonzero";
  }
  return "unknown";
}

function reportStabilityCustom(
  name: string,
  properties: Record<string, string | number | boolean | undefined>,
  windowScene?: StabilityWindowScene,
  lifecycleSceneOverride?: StabilityLifecycleScene,
): void {
  if (!globalContext) {
    return;
  }

  const metricValue = resolveStabilityMetricValue(name, properties);

  const payload = stringifyProperties({
    event_name: name,
    platform: normalizeOsCategory(globalContext.platform),
    app_version: globalContext.appVersion,
    arms_env: globalContext.armsEnv,
    device_mid: globalContext.deviceMid,
    telemetry_schema_version: STABILITY_TELEMETRY_SCHEMA_VERSION,
    scene_lifecycle: lifecycleSceneOverride ?? lifecycleScene,
    scene_window: windowScene ?? "main",
    metric_value: metricValue,
    ...properties,
  });

  try {
    // ARMS original logs/console are displayed by custom type; business grouping is grouped
    // Value fills in the specific value: ANR/hang is duration_ms, exit is exit_code, and the counting class is uniformly 1
    armsRum.sendCustom({
      name,
      type: "custom",
      group: "stability",
      value: metricValue,
      properties: payload,
    });
  } catch (error) {
    // Failure to report stability should not affect the main process
    console.warn("[stability] sendCustom failed:", name, error);
  }
}

export function reportAgentProcessExceptionToArms(
  event: HostAgentProcessExceptionResponse,
  logger: StabilityLogger,
): void {
  if (!globalContext) return;
  const key = `${event.runtimeInstanceId}:${event.diagnostic.errorId}`;
  if (reportedAgentExceptions.has(key)) return;
  const diagnostic = event.diagnostic;
  const name = sanitizeAgentCrashDetail(diagnostic.name, event.workspacePath);
  const message = sanitizeAgentCrashDetail(diagnostic.message, event.workspacePath);
  const stack =
    diagnostic.stack === undefined
      ? undefined
      : sanitizeAgentCrashDetail(diagnostic.stack, event.workspacePath);
  try {
    // Root cause: Electron collector only monitors its own process, and CLI exceptions must be sent explicitly with the original stack.
    // It cannot be converted into a console.error wrapper string first, nor can it be reported after the process exits.
    armsRum.sendEvent({
      event_type: "exception",
      type: "error",
      source: diagnostic.kind,
      name,
      message,
      ...(stack === undefined ? {} : { stack }),
      timestamp: diagnostic.occurredAt,
      properties: stringifyProperties({
        process_role: "agent",
        process_error_kind: diagnostic.kind,
        process_error_origin: diagnostic.origin,
        error_id: diagnostic.errorId,
        runtime_instance_id: event.runtimeInstanceId,
        runtime_generation: event.runtimeGeneration,
        provider: event.provider,
        lane: event.lane,
        error_fingerprint: createAgentCrashFingerprint([
          name,
          message,
          stack?.split(/\r?\n/).find((line) => line.trim().startsWith("at ")) ?? "",
        ]),
        app_version: globalContext.appVersion,
        arms_env: globalContext.armsEnv,
        device_mid: globalContext.deviceMid,
        platform: normalizeOsCategory(globalContext.platform),
      }),
    });
    reportedAgentExceptions.add(key);
    if (reportedAgentExceptions.size > AGENT_EXCEPTION_DEDUP_CAPACITY) {
      reportedAgentExceptions.delete(reportedAgentExceptions.values().next().value!);
    }
  } catch (error) {
    // SDK failure cannot affect Host message processing; events that are not submitted successfully do not enter the deduplication collection.
    logger.warn("[stability] Agent exception report failed", error);
  }
}

export function reportAgentProcessStartToArms(
  event: HostAgentProcessSpawnedResponse,
  logger: StabilityLogger,
): void {
  reportStabilityCustom("perf_agent_start", {
    process_role: "agent",
    // The mcp-status and plugin lane processes share cwd/command, and only the lane can distinguish the source of the event.
    ...(event.lane ? { lane: event.lane } : {}),
    provider: event.provider,
    runtime_generation: event.runtimeGeneration,
    runtime_instance_id: event.runtimeInstanceId,
  });
  logger.info("[stability] perf_agent_start reported", {
    pid: event.pid,
    runtimeGeneration: event.runtimeGeneration,
    runtimeInstanceId: event.runtimeInstanceId,
  });
}

export function reportAgentProcessReadyToArms(
  event: HostAgentProcessReadyResponse,
  logger: StabilityLogger,
): void {
  reportStabilityCustom("perf_agent_ready", {
    process_role: "agent",
    // The mcp-status and plugin lane processes share cwd/command, and only the lane can distinguish the source of the event.
    ...(event.lane ? { lane: event.lane } : {}),
    provider: event.provider,
    runtime_generation: event.runtimeGeneration,
    runtime_instance_id: event.runtimeInstanceId,
    startup_duration_ms: event.startupDurationMs,
  });
  logger.info("[stability] perf_agent_ready reported", {
    pid: event.pid,
    runtimeGeneration: event.runtimeGeneration,
    runtimeInstanceId: event.runtimeInstanceId,
    startupDurationMs: event.startupDurationMs,
  });
}

export function reportAgentProcessExitToArms(
  event: HostAgentProcessExitedResponse,
  logger: StabilityLogger,
): void {
  if (event.terminationKind !== "unexpected") {
    return;
  }
  const isProtocolFailure = event.terminationReason === "protocol-close";
  if (
    !isProtocolFailure &&
    (event.exitCode === WINDOWS_CONTROLLED_TERMINATION_EXIT_CODE || event.signal === "SIGTERM")
  ) {
    // Bug root cause: Protocol failure will first trigger protocol-close, and then the Host will recycle the surviving processes.
    // So it may also end up manifesting as SIGTERM / Windows control-c exit code. Only lack of structure
    // When the protocol is the root cause, naked exit signatures are not enough to prove that the Agent itself crashed, and false positives should continue to be suppressed.
    logger.debug?.("[stability] controlled Agent termination suppressed", {
      pid: event.pid,
      runtimeInstanceId: event.runtimeInstanceId,
      exitCode: event.exitCode,
      signal: event.signal,
    });
    return;
  }
  if (lifecycleScene === "app_quit" || lifecycleScene === "update_install") {
    // Bug root cause: Host cleanup and IPC return are asynchronous, and a missing item may still arrive late after perf_app_exit
    // Agent exit for termination intent. Application exit is a higher-level fact held by main and cannot be counted as a runtime crash.
    logger.debug?.("[stability] late Agent exit suppressed during app shutdown", {
      pid: event.pid,
      runtimeInstanceId: event.runtimeInstanceId,
      lifecycleScene,
    });
    return;
  }
  const diagnostic = parseAgentStderrDiagnostic(event);
  reportStabilityCustom("perf_agent_crash", {
    process_role: "agent",
    // The mcp-status and plugin lane processes share cwd/command, and only the lane can distinguish the source of the event.
    ...(event.lane ? { lane: event.lane } : {}),
    incident_kind: "unexpected_exit",
    provider: event.provider,
    exit_code: event.exitCode ?? "",
    signal: event.signal ?? "",
    runtime_generation: event.runtimeGeneration,
    runtime_instance_id: event.runtimeInstanceId,
    uptime_ms: event.uptimeMs,
    stderr_line_count: event.stderrLineCount,
    crash_phase: classifyAgentCrashPhase(event.runtimeReady),
    termination_class: classifyAgentTermination(event),
    termination_reason: event.terminationReason,
    diagnostic_class: diagnostic.diagnosticClass,
    error_name: diagnostic.errorName,
    error_code: diagnostic.errorCode,
    error_message: diagnostic.errorMessage,
    error_stack: diagnostic.errorStack,
    error_fingerprint: diagnostic.errorFingerprint,
  });
  // Successful reporting belongs to the observation log, and error will be generated by the console collector as a pseudo JS exception.
  logger.info("[stability] perf_agent_crash reported", {
    pid: event.pid,
    exitCode: event.exitCode,
    signal: event.signal,
    runtimeGeneration: event.runtimeGeneration,
    errorName: diagnostic.errorName,
    errorCode: diagnostic.errorCode,
    errorFingerprint: diagnostic.errorFingerprint,
  });
}

export function reportAgentProcessSpawnErrorToArms(
  event: HostAgentProcessErrorResponse,
  logger: StabilityLogger,
): void {
  const diagnostic = parseAgentSpawnDiagnostic(event);
  reportStabilityCustom("perf_agent_spawn_error", {
    process_role: "agent",
    // The mcp-status and plugin lane processes share cwd/command, and only the lane can distinguish the source of the event.
    ...(event.lane ? { lane: event.lane } : {}),
    incident_kind: "spawn_error",
    provider: event.provider,
    runtime_generation: event.runtimeGeneration,
    runtime_instance_id: event.runtimeInstanceId,
    diagnostic_class: diagnostic.diagnosticClass,
    error_name: diagnostic.errorName,
    error_code: diagnostic.errorCode,
    error_message: diagnostic.errorMessage,
    error_stack: diagnostic.errorStack,
    error_fingerprint: diagnostic.errorFingerprint,
  });
  logger.info("[stability] perf_agent_spawn_error reported", {
    pid: event.pid,
    runtimeGeneration: event.runtimeGeneration,
    errorName: diagnostic.errorName,
    errorCode: diagnostic.errorCode,
    errorFingerprint: diagnostic.errorFingerprint,
  });
}

function mapExitReasonToCrashKind(reason: string): StabilityCrashKind {
  // Electron's renderer/child gone callbacks share this set of exit reasons, and OOM cannot be classified as native due to different process sources.
  return reason === "oom" || reason === "memory-eviction" ? "oom" : "native";
}

function mapExitReasonToCrashCause(reason: string): StabilityCrashCause {
  switch (reason) {
    case "oom":
    // Electron 41 has a separate name for Chromium's memory pressure eviction; it, like oom, indicates that a process is
    // Pressure exit cannot fall into native/unknown, otherwise the OOM indicator will be underestimated.
    case "memory-eviction":
      return "oom";
    case "crashed":
      return "process_crashed";
    case "abnormal":
    case "abnormal-exit":
      return "abnormal_exit";
    case "launch-failed":
      return "launch_failed";
    case "integrity-failure":
      return "integrity_failure";
    default:
      return "unknown";
  }
}

function classifyRenderProcessCrash(
  input: RenderProcessGoneInput,
): StabilityCrashClassification | null {
  if (input.reason === "killed" || input.reason === "clean-exit") {
    return null;
  }
  return {
    crashKind: mapExitReasonToCrashKind(input.reason),
    crashScope:
      input.webContentsType === "webview"
        ? "embedded_webview"
        : input.windowScene === undefined || input.windowScene === "main"
          ? "main_window_renderer"
          : "auxiliary_window_renderer",
    crashCause: mapExitReasonToCrashCause(input.reason),
  };
}

function mapChildProcessGoneToProcessRoleWithName(
  type: string,
  processName?: string,
): StabilityProcessRole {
  if (processName?.startsWith("zcode-host")) {
    return "host";
  }
  if (processName?.startsWith("zcode-agent")) {
    return "agent";
  }
  switch (type) {
    case "GPU":
      return "gpu";
    case "Utility":
      return "utility";
    default:
      return "child";
  }
}

function shouldReportChildProcessGoneAsCrash(input: ChildProcessGoneInput): boolean {
  if (input.reason === "killed" || input.reason === "clean-exit") {
    return false;
  }

  const role = mapChildProcessGoneToProcessRoleWithName(input.type, input.name);
  if (role === "gpu") {
    return false;
  }

  // Bugfix: Chromium Utility such as Video Capture / Network Service / Audio Service in RUM
  // Child processes will be automatically re-created by the system and will not render the ZCode main window or session unavailable; they will only be recorded as recoverable exits,
  // You cannot enter perf_crash, otherwise the crash-free indicator will be lowered according to "non-real crash".
  if (role === "utility") {
    return false;
  }

  return true;
}

function shouldReportAnr(elapsedMs: number, anrReported: boolean): boolean {
  return !anrReported && elapsedMs >= STABILITY_ANR_THRESHOLD_MS;
}

function shouldReportFreeze(
  elapsedMs: number,
  freezeReported: boolean,
  crashReported: boolean,
): boolean {
  return !freezeReported && !crashReported && elapsedMs >= STABILITY_FREEZE_THRESHOLD_MS;
}

function resolveRegisteredWindowScene(win: BrowserWindow | null | undefined): StabilityWindowScene {
  if (!win || win.isDestroyed()) {
    return "other";
  }
  const resourceManagerId = getResourceManagerWindowId();
  if (resourceManagerId != null && win.id === resourceManagerId) {
    return "process_monitor";
  }
  return mainWindowIds.has(win.id) ? "main" : "other";
}

function resolveWindowScene(win: BrowserWindow | null | undefined): StabilityWindowScene {
  if (win && !win.isDestroyed()) {
    return resolveRegisteredWindowScene(win);
  }
  const focused = BrowserWindow.getFocusedWindow();
  return focused && !focused.isDestroyed() ? resolveRegisteredWindowScene(focused) : "main";
}

function markWebContentsCrash(webContentsId: number): void {
  const state = unresponsiveByWebContentsId.get(webContentsId);
  if (state) {
    state.crashReported = true;
    if (state.pollTimer) {
      clearTimeout(state.pollTimer);
      state.pollTimer = null;
    }
  }
}

function clearUnresponsiveWatch(webContentsId: number): void {
  const state = unresponsiveByWebContentsId.get(webContentsId);
  if (!state) {
    return;
  }
  if (state.pollTimer) {
    clearTimeout(state.pollTimer);
  }
  unresponsiveByWebContentsId.delete(webContentsId);
}

function pollUnresponsiveState(state: UnresponsiveWatchState, logger: StabilityLogger): void {
  if (state.crashReported) {
    clearUnresponsiveWatch(state.webContentsId);
    return;
  }

  const elapsedMs = Date.now() - state.startedAt;
  const windowScene = state.windowScene;

  if (shouldReportAnr(elapsedMs, state.anrReported)) {
    state.anrReported = true;
    reportStabilityCustom(
      "perf_anr",
      {
        duration_ms: elapsedMs,
        window_id: state.windowId,
        web_contents_id: state.webContentsId,
      },
      windowScene,
    );
    logger.warn("[stability] perf_anr reported", {
      windowId: state.windowId,
      webContentsId: state.webContentsId,
      durationMs: elapsedMs,
    });
  }

  if (shouldReportFreeze(elapsedMs, state.freezeReported, state.crashReported)) {
    state.freezeReported = true;
    reportStabilityCustom(
      "perf_freeze",
      {
        duration_ms: elapsedMs,
        window_id: state.windowId,
        web_contents_id: state.webContentsId,
      },
      windowScene,
    );
    logger.warn("[stability] perf_freeze reported", {
      windowId: state.windowId,
      webContentsId: state.webContentsId,
      durationMs: elapsedMs,
    });
  }

  if (!state.freezeReported && !state.crashReported) {
    state.pollTimer = setTimeout(() => pollUnresponsiveState(state, logger), 1_000);
    state.pollTimer.unref?.();
  }
}

function attachWebContentsStabilityWatch(
  win: BrowserWindow,
  webContents: WebContents,
  logger: StabilityLogger,
): void {
  const webContentsId = webContents.id;

  webContents.on("unresponsive", () => {
    clearUnresponsiveWatch(webContentsId);
    const state: UnresponsiveWatchState = {
      windowId: win.id,
      webContentsId,
      windowScene: resolveRegisteredWindowScene(win),
      startedAt: Date.now(),
      anrReported: false,
      freezeReported: false,
      crashReported: false,
      pollTimer: null,
    };
    unresponsiveByWebContentsId.set(webContentsId, state);
    logger.warn("[stability] webContents unresponsive", {
      windowId: win.id,
      webContentsId,
      url: webContents.getURL(),
    });
    pollUnresponsiveState(state, logger);
  });

  webContents.on("responsive", () => {
    logger.info("[stability] webContents responsive", {
      windowId: win.id,
      webContentsId,
    });
    clearUnresponsiveWatch(webContentsId);
  });

  webContents.on("destroyed", () => {
    clearUnresponsiveWatch(webContentsId);
  });
}

export function configureDesktopStabilityTelemetry(context: StabilityGlobalContext): void {
  globalContext = context;
  armsRum.setConfig("properties", {
    device_mid: context.deviceMid,
    platform: normalizeOsCategory(context.platform),
    app_version: context.appVersion,
    arms_env: context.armsEnv,
  });
}

/** Align with the initial_load window of @arms/rum-electron pv-collector to avoid flushing the PV earlier than the first screen */
const PERF_APP_START_AFTER_VIEW_MS = 3_200;

function reportPerfAppStart(logger: StabilityLogger): void {
  if (perfAppStartReported) {
    return;
  }
  perfAppStartReported = true;
  lifecycleScene = "cold_start";
  reportStabilityCustom("perf_app_start", {}, "main", "cold_start");
  lifecycleScene = "runtime";
  logger.info("[stability] perf_app_start reported");
}

/**
 * Reports perf_app_start only after the main window's first screen has finished loading.
 * Reason: sendCustom too early still sees view as __default__, and it may land in a different
 * reporting batch than the renderer PV; in raw ARMS logs the PV is frequently there while the custom
 * event of the same session is missing.
 */
export function scheduleReportPerfAppStartAfterMainViewReady(
  webContents: WebContents,
  logger: StabilityLogger,
): void {
  if (perfAppStartReported || webContents.isDestroyed()) {
    return;
  }

  const reportAfterView = (): void => {
    if (perfAppStartReported || webContents.isDestroyed()) {
      return;
    }
    setTimeout(() => {
      if (!webContents.isDestroyed()) {
        reportPerfAppStart(logger);
      }
    }, PERF_APP_START_AFTER_VIEW_MS);
  };

  if (webContents.isLoading()) {
    webContents.once("did-finish-load", reportAfterView);
    return;
  }

  reportAfterView();
}

export function registerStabilityMainWindow(win: BrowserWindow): void {
  if (win.isDestroyed() || mainWindowIds.has(win.id)) {
    return;
  }
  mainWindowIds.add(win.id);
  win.once("closed", () => {
    mainWindowIds.delete(win.id);
  });
}

export function notifyStabilityLifecycle(scene: StabilityLifecycleScene): void {
  lifecycleScene = scene;
}

export function getStabilityLifecycleScene(): StabilityLifecycleScene {
  return lifecycleScene;
}

export function notifyStabilityAppExit(
  scene: StabilityLifecycleScene,
  logger: StabilityLogger,
  options?: { exitCode?: number; exitKind?: string },
): void {
  // Bug root cause: The old implementation reports perf_app_exit and immediately resumes the runtime; Agent/Host’s asynchronous exit event
  // Thus the app_quit/update_install boundary is lost and mistakenly counted as a crash. Once the exit process is started, it is irreversible.
  // The lifecycle must persist until the main process terminates.
  lifecycleScene = scene;
  reportStabilityCustom("perf_app_exit", {
    exit_code: options?.exitCode ?? 0,
    exit_kind: options?.exitKind ?? "normal",
  });
  logger.info("[stability] perf_app_exit reported", { scene, exitCode: options?.exitCode ?? 0 });
}

function reportPerfCrash(
  classification: StabilityCrashClassification,
  logger: StabilityLogger,
  properties: Record<string, string | number | boolean | undefined>,
  win?: BrowserWindow | null,
): void {
  const crashProperties = {
    crash_id: randomUUID(),
    crash_kind: classification.crashKind,
    crash_scope: classification.crashScope,
    crash_cause: classification.crashCause,
    crash_source: "electron_callback",
    ...properties,
  };
  // Bugfix: The old implementation performs five-minute deduplication according to crash_kind, which will swallow real accidents of the same type but different processes.
  // Electron's gone callback itself is a single accident boundary, and each callback here is only reported once.
  reportStabilityCustom("perf_crash", crashProperties, resolveWindowScene(win));
  logger.error("[stability] perf_crash reported", crashProperties);
}

function reportPerfProcessExit(
  logger: StabilityLogger,
  properties: Record<string, string | number | boolean | undefined>,
  win?: BrowserWindow | null,
): void {
  reportStabilityCustom("perf_process_exit", properties, resolveWindowScene(win));
  // Bug reason: perf_process_exit hosts both controlled exits and recoverable helper exception exits.
  // The old implementation uses errors uniformly, causing the normal life cycle to be mistakenly counted as exceptions by the ARMS console collector.
  const logLevel = properties.exit_kind === "normal" ? "info" : "warn";
  logger[logLevel]("[stability] perf_process_exit reported", properties);
}

export function registerDesktopStabilityMonitors(
  logger: StabilityLogger,
  crashPaths: CrashCapturePaths,
): void {
  registerBaseCrashEventMonitor(logger, crashPaths, {
    onRenderProcessGone: (webContents, details) => {
      markWebContentsCrash(webContents.id);
      const win = BrowserWindow.fromWebContents(webContents);
      const input: RenderProcessGoneInput = {
        reason: details.reason,
        exitCode: details.exitCode,
        webContentsType: webContents.getType(),
        // You must use the window that crashes WebContents itself; falling back to the current focus window will misjudge the auxiliary window as the main business window.
        windowScene: resolveRegisteredWindowScene(win),
      };
      const classification = classifyRenderProcessCrash(input);
      if (classification) {
        reportPerfCrash(
          classification,
          logger,
          {
            exit_code: details.exitCode,
            exit_reason: details.reason,
            process_role: "renderer",
            web_contents_type: webContents.getType(),
            web_contents_id: webContents.id,
            window_id: win?.id,
          },
          win,
        );
      } else {
        reportPerfProcessExit(
          logger,
          {
            exit_code: details.exitCode,
            exit_reason: details.reason,
            process_role: "renderer",
            exit_kind: "normal",
            web_contents_id: webContents.id,
          },
          win,
        );
      }
    },
    onChildProcessGone: (details) => {
      // Reason for fix: Electron puts the custom identifier of utilityProcess.fork() in serviceName,
      // name only represents the Chromium Utility service name (such as Network Service). read-only name will
      // Host is classified as utility, which causes Host to exit abnormally and use recoverable_child_crash instead of perf_crash.
      const processName = details.serviceName?.trim() || details.name?.trim() || "";
      const role = mapChildProcessGoneToProcessRoleWithName(details.type, processName);
      if (details.reason === "killed" || details.reason === "clean-exit") {
        reportPerfProcessExit(logger, {
          exit_code: details.exitCode,
          exit_reason: details.reason,
          process_role: role,
          exit_kind: "normal",
          process_type: details.type,
          process_name: processName,
        });
      } else if (!shouldReportChildProcessGoneAsCrash({ ...details, name: processName })) {
        reportPerfProcessExit(logger, {
          exit_code: details.exitCode,
          exit_reason: details.reason,
          process_role: role,
          exit_kind: "recoverable_child_crash",
          process_type: details.type,
          process_name: processName,
        });
      } else {
        reportPerfCrash(
          {
            crashKind: mapExitReasonToCrashKind(details.reason),
            crashScope: role === "host" ? "host" : "child",
            crashCause: mapExitReasonToCrashCause(details.reason),
          },
          logger,
          {
            exit_code: details.exitCode,
            exit_reason: details.reason,
            process_role: role,
            process_type: details.type,
            process_name: processName,
          },
        );
      }
    },
    onBrowserWindowCreated: (win) => {
      attachWebContentsStabilityWatch(win, win.webContents, logger);
    },
  });
}
