import armsRum from "@arms/rum-electron";
import {
  bytesToKb,
  createMemorySampleWriteGate,
  formatMemorySampleLine,
  mapZCodeEnvToArmsRumEnv,
  memoryUsageToSampleFields,
  type MemorySample,
  type MemorySampleWriteGate,
  type ProcessResourceRole,
  type ProcessResourceRuntimeSurface,
  PROCESS_RESOURCE_EVENT_NAMES,
  zcodeToolExecResourceSchema,
} from "@zcode/shared";
import { BrowserWindow } from "electron";
import os from "node:os";
import { getSharedFinalArmsCustomEventE2EController } from "./desktopArmsCustomEvent.js";
import { desktopRuntimeEnv } from "./desktopRuntimeEnv.js";
import { mainMemoryDiagnosticsRegistry } from "./mainMemoryDiagnostics.js";
import { addAppResourceTotals, type AppResourceTotals } from "./processResourceAppTotals.js";
import { PROCESS_RESOURCE_SAMPLE_SOURCES } from "./processResourceSampleSourceRegistry.js";
import {
  flushPendingProcessResourceSampleSources,
  resetProcessResourceSampleSources,
  runProcessResourceDeviceSampleSources,
  runProcessResourceSampleSources,
} from "./processResourceSampleSources.js";
import { ProcessResourceSystemWindowAggregator } from "./processResourceSystemWindowAggregator.js";
import {
  buildSystemWindowEventProperties,
  PERF_SYSTEM_WINDOW_EVENT_NAME,
} from "./processResourceSystemWindowEvent.js";
import {
  ProcessResourceWindowAggregator,
  type ProcessResourceHardware,
  type ProcessRoleSample,
} from "./processResourceWindowAggregator.js";
import {
  buildProcessWindowEventProperties,
  normalizeOsCategory,
  PERF_PROCESS_WINDOW_EVENT_NAME,
} from "./processResourceWindowEvent.js";
import { listRegisteredHostAgentProcessIds } from "./resourceManagerWindow.js";

/**
 * Main side process resource telemetry.
 *
 * Unique ARMS resource export: 10 second tick for each sample source to write to a bounded window,
 * 5 minutes (development build and E2E 1 minute) flush out one `perf_process_window` per character
 * With one `perf_system_window` per device, exit normally to empty the remaining windows.
 * Performance red line: Main process has zero external processes, and PowerShell/WMI/CIM is prohibited on all links.
 */

/** Sampling interval */
const RESOURCE_SAMPLE_INTERVAL_MS = 10_000;

/** Development builds with E2E use a 1 minute window for easy verification; production 5 minutes. */
function resolveDefaultReportIntervalMs(): number {
  if (desktopRuntimeEnv === "development") {
    return 60_000;
  }
  // E2E runs a packaged build. Without this short window, trend events cannot be observed in one use case.
  if (process.env.ZCODE_ENV === "test" && process.env.ZCODE_E2E_RUN_ID?.trim()) {
    return 60_000;
  }
  return 300_000;
}

/** Reporting interval */
const RESOURCE_REPORT_INTERVAL_MS = resolveDefaultReportIntervalMs();

/**
 * Local memory diagnostic log: borrow 10s resource sampling beat,
 * Main's own memory is read every 6 ticks (≈60s). The same reading is written to the main log and serves as a heap sample for the main role.
 */
const MEMORY_LOG_SAMPLE_EVERY_N_TICKS = 6;

type ResourceUsageScene = "foreground" | "background";

interface ResourceLogger {
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  debug?: (...args: unknown[]) => void;
}

interface ResourceGlobalContext {
  deviceMid: string;
  platform: NodeJS.Platform;
  appVersion: string;
  armsEnv: ReturnType<typeof mapZCodeEnvToArmsRumEnv>;
}

let globalContext: ResourceGlobalContext | null = null;
let desktopHardware: ProcessResourceHardware | null = null;
let sampleTimer: ReturnType<typeof setInterval> | null = null;
let reportTimer: ReturnType<typeof setInterval> | null = null;
let agentMetricProbeDisabledAuditLogged = false;
let memoryLogTick = 0;
let memorySampleWriteGate: MemorySampleWriteGate = createMemorySampleWriteGate();
/** Self-certifying overhead clock; only single tests are replaced with predictable fake clocks. */
let readTelemetrySelfClockMs: () => number = () => performance.now();

const processResourceWindows = new ProcessResourceWindowAggregator();
const processResourceSystemWindow = new ProcessResourceSystemWindowAggregator();
/** The completion fact only needs to cover recent repetitions of multi-connection forwarding, and the fixed budget avoids unbounded growth of long sessions. */
const MAX_RECENT_TOOL_EXEC_COMPLETIONS = 1_024;
const recentToolExecCompletions = new Set<string>();

function resolveDesktopHardware(platform: NodeJS.Platform): ProcessResourceHardware {
  return {
    platform,
    arch: process.arch,
    logicalCpuCount: os.cpus().length,
    totalMemoryGb: Math.round(os.totalmem() / 1024 ** 3),
  };
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

function reportResourceCustom(
  name: string,
  /** The value field of ARMS custom: the main indicator value displayed by the console by default */
  metricValue: number,
  properties: Record<string, string | number | boolean | undefined>,
): void {
  if (!globalContext) {
    return;
  }

  const payload = {
    name,
    type: "custom" as const,
    group: "resource",
    value: metricValue,
    properties: stringifyProperties(properties),
  };

  // E2E captures before sendCustom, and what is read is the actual reported content.
  const e2eController = getSharedFinalArmsCustomEventE2EController();
  e2eController?.record(payload);
  if (e2eController?.shouldSuppress(name)) {
    return;
  }

  try {
    armsRum.sendCustom(payload);
  } catch (error) {
    console.warn("[resource] sendCustom failed:", name, error);
  }
}

export function resolveResourceUsageScene(): ResourceUsageScene {
  const windows = BrowserWindow.getAllWindows().filter((win) => !win.isDestroyed());
  if (windows.length === 0) {
    return "background";
  }

  const anyFocused = windows.some((win) => win.isFocused());
  const anyVisible = windows.some((win) => win.isVisible() && !win.isMinimized());
  return anyFocused && anyVisible ? "foreground" : "background";
}

/** Completion facts are reported immediately, reusing the single resource exit point; they never enter the five-minute window or the session-restore path. */
export function ingestToolExecResource(
  raw: unknown,
  runtimeSurface: ProcessResourceRuntimeSurface,
): void {
  if (!globalContext) return;
  const parsed = zcodeToolExecResourceSchema.safeParse(raw);
  if (!parsed.success) return;
  const sample = parsed.data;
  // The same server can be forwarded through multiple workspaces and window hosts; duplication is only removed at the main exit.
  // The old CLI without identification retains the original behavior and cannot be deduplicated according to quantitative indicators, otherwise it will swallow different real commands.
  if (sample.completionToken) {
    if (recentToolExecCompletions.has(sample.completionToken)) return;
    recentToolExecCompletions.add(sample.completionToken);
    if (recentToolExecCompletions.size > MAX_RECENT_TOOL_EXEC_COMPLETIONS) {
      const oldest = recentToolExecCompletions.values().next().value;
      if (oldest !== undefined) recentToolExecCompletions.delete(oldest);
    }
  }
  reportResourceCustom(PROCESS_RESOURCE_EVENT_NAMES.toolExecResource, sample.durationMs, {
    platform: normalizeOsCategory(sample.platform),
    app_version: globalContext.appVersion,
    arms_env: globalContext.armsEnv,
    device_mid: globalContext.deviceMid,
    runtime_surface: runtimeSurface,
    tool_name: sample.toolName,
    exit_kind: sample.exitKind,
    sample_count: sample.sampleCount,
    cli_rss_kb: sample.cliRssKb,
    system_free_memory_kb: sample.systemFreeMemoryKb,
    ...(sample.platform === "win32"
      ? {}
      : {
          tree_rss_kb_peak: sample.treeRssKbPeak ?? 0,
          tree_cpu_time_ms: sample.treeCpuTimeMs ?? 0,
        }),
  });
}

function auditDisabledAgentMetricProbe(logger: ResourceLogger | undefined): void {
  if (
    agentMetricProbeDisabledAuditLogged ||
    process.platform !== "win32" ||
    process.env.ZCODE_ENV !== "test" ||
    !process.env.ZCODE_E2E_RUNTIME_LOG_DIR?.trim()
  ) {
    return;
  }

  const agentCount = listRegisteredHostAgentProcessIds().length;
  if (agentCount === 0) {
    return;
  }

  agentMetricProbeDisabledAuditLogged = true;
  // E2E Audit Contract: This record only proves the real sampling period when the Agent PID is registered
  // Explicitly skip external metric collection. If collection is resumed in the future, action=spawn must be recorded first.
  // Windows E2E will therefore fail, preventing synchronization of PowerShell back to the main process again.
  logger?.info(
    `[resource] agent_metric_probe action=skipped reason=main_process_external_probe_disabled agent_count=${agentCount}`,
  );
}

function readMainMemoryUsage(): NodeJS.MemoryUsage | null {
  try {
    return process.memoryUsage();
  } catch {
    return null;
  }
}

function logMemorySample(
  logger: ResourceLogger | undefined,
  memoryUsage: NodeJS.MemoryUsage,
  samples: readonly ProcessRoleSample[],
): void {
  if (!logger) {
    return;
  }
  try {
    const counters = mainMemoryDiagnosticsRegistry.collect();
    for (const sample of samples) {
      counters[`ws.${sample.role}`] = sample.rssKbTotal;
    }
    const sample: MemorySample = {
      role: "main",
      ...memoryUsageToSampleFields(memoryUsage),
      counters,
    };
    const reason = memorySampleWriteGate.evaluate(sample, Date.now());
    if (reason) {
      logger.info(formatMemorySampleLine(sample, reason));
    }
  } catch {
    // If the diagnostic log fails, only the current sample will be lost, and resource sampling and ARMS reporting will not be affected.
  }
}

function takeSample(logger?: ResourceLogger): void {
  processResourceWindows.recordScene(resolveResourceUsageScene());

  const now = Date.now();
  const samples: ProcessRoleSample[] = [];
  /**
   * Only the process itself can read the heap: main is read in place below, host / scheduler / renderer are read by their respective
   * Posted from the source of this sample. The heap is not large enough to open windows independently, and the complete samples of the character in the same tick are unified and merged.
   */
  const heapUsedKbByRole = new Map<ProcessResourceRole, number>();
  let appProcessTotals: AppResourceTotals | null = null;
  const onError = (sourceId: string, error: unknown): void =>
    logger?.warn(`[resource] sample source ${sourceId} failed:`, error);
  runProcessResourceSampleSources(PROCESS_RESOURCE_SAMPLE_SOURCES, {
    now,
    addRoleSample: (sample) => samples.push(sample),
    addRoleHeapSample: (role, heapUsedKb) => heapUsedKbByRole.set(role, heapUsedKb),
    addAppProcessTotals: (totals) => {
      appProcessTotals = appProcessTotals ? addAppResourceTotals(appProcessTotals, totals) : totals;
    },
    onError,
  });

  // Read main's own memory every 6 ticks (≈60s): the same reading is written to the local `[memory]` log,
  // As a heap sample of the main role event, the two values are naturally consistent and no timer is added.
  memoryLogTick += 1;
  const mainMemoryUsage =
    memoryLogTick % MEMORY_LOG_SAMPLE_EVERY_N_TICKS === 0 ? readMainMemoryUsage() : null;
  if (mainMemoryUsage) {
    heapUsedKbByRole.set("main", bytesToKb(mainMemoryUsage.heapUsed));
  }

  for (const sample of samples) {
    const heapUsedKb = heapUsedKbByRole.get(sample.role);
    processResourceWindows.add(heapUsedKb === undefined ? sample : { ...sample, heapUsedKb });
  }

  if (mainMemoryUsage) {
    logMemorySample(logger, mainMemoryUsage, samples);
  }

  // Phase 2: Device-level sources must use the exact sum of the same tick, so you must wait until all sources in the first phase are completed.
  runProcessResourceDeviceSampleSources(PROCESS_RESOURCE_SAMPLE_SOURCES, {
    now,
    appProcessTotals,
    addDeviceSample: (sample) => processResourceSystemWindow.add(sample),
    onError,
  });

  auditDisabledAgentMetricProbe(logger);
}

/**
 * The wall clock time consumption of the main side telemetry code itself: reported as `telemetry_self_ms`.
 * The cost of flush falls on the next window - it occurs after the window is projected and cannot be counted into the event that has been emitted.
 */
function measureTelemetrySelfMs(run: () => void): void {
  const startedAt = readTelemetrySelfClockMs();
  try {
    run();
  } finally {
    processResourceSystemWindow.addTelemetrySelfMs(readTelemetrySelfClockMs() - startedAt);
  }
}

function reportProcessResourceWindows(): void {
  if (!globalContext || !desktopHardware) {
    processResourceWindows.clear();
    return;
  }
  const context = {
    deviceMid: globalContext.deviceMid,
    appVersion: globalContext.appVersion,
    armsEnv: globalContext.armsEnv,
    desktopHardware,
  };
  for (const report of processResourceWindows.drain()) {
    reportResourceCustom(
      PERF_PROCESS_WINDOW_EVENT_NAME,
      report.cpuPercentMean,
      buildProcessWindowEventProperties(report, context),
    );
  }
}

/** Application running time: The main process lives and dies with the App, and its running time is directly taken. */
function resolveAppUptimeMinutes(): number {
  const uptimeSeconds = process.uptime();
  return Number.isFinite(uptimeSeconds) ? Math.max(0, Math.round(uptimeSeconds / 60)) : 0;
}

function reportSystemResourceWindow(backgroundRatio: number): void {
  if (!globalContext || !desktopHardware) {
    processResourceSystemWindow.clear();
    return;
  }
  const report = processResourceSystemWindow.drain({
    backgroundRatio,
    appUptimeMinutes: resolveAppUptimeMinutes(),
  });
  if (!report) {
    return;
  }
  reportResourceCustom(
    PERF_SYSTEM_WINDOW_EVENT_NAME,
    report.appCpuPercentMean,
    buildSystemWindowEventProperties(report, {
      deviceMid: globalContext.deviceMid,
      appVersion: globalContext.appVersion,
      armsEnv: globalContext.armsEnv,
      desktopHardware,
    }),
  );
}

/**
 * Fill the window with the readings from each source that have been "received but not yet delivered to the window" (only called when exiting draining).
 * Do not do any new sampling: the exit path does not allow any further reading of getAppMetrics or probes.
 */
function flushPendingSourceReadings(logger?: ResourceLogger): void {
  flushPendingProcessResourceSampleSources(PROCESS_RESOURCE_SAMPLE_SOURCES, {
    now: Date.now(),
    addRoleSample: (sample) => processResourceWindows.add(sample),
    // The heap is not enough to open a window independently, and this is no exception when exiting; sources that only contribute to the heap do not have flushPending.
    addRoleHeapSample: () => {},
    addAppProcessTotals: () => {},
    onError: (sourceId, error) =>
      logger?.warn(`[resource] sample source ${sourceId} flush failed:`, error),
  });
}

/** Empty all resource windows; there is only one window clock, exit the emptying and reuse the same sequence. */
function drainAllResourceWindows(logger?: ResourceLogger): void {
  flushPendingSourceReadings(logger);
  // The only data source of background_ratio is the scene count of the character aggregator, which is taken first and then drained (drain will be cleared to zero).
  const backgroundRatio = processResourceWindows.backgroundRatio;
  reportProcessResourceWindows();
  reportSystemResourceWindow(backgroundRatio);
}

function flushResourceReports(logger: ResourceLogger): void {
  drainAllResourceWindows(logger);
  logger.info("[resource] perf_process_window + perf_system_window flushed");
}

export function configureDesktopResourceTelemetry(context: ResourceGlobalContext): void {
  recentToolExecCompletions.clear();
  processResourceWindows.clear();
  processResourceSystemWindow.clear();
  globalContext = context;
  desktopHardware = resolveDesktopHardware(context.platform);

  armsRum.setConfig("properties", {
    device_mid: context.deviceMid,
    platform: normalizeOsCategory(context.platform),
    app_version: context.appVersion,
    arms_env: context.armsEnv,
  });
}

export function registerDesktopResourceTelemetry(
  logger: ResourceLogger,
  /**
   * `reportIntervalMs` is only used for single test injection window clock; for production, use RESOURCE_REPORT_INTERVAL_MS.
   * `readSelfClockMs` is only used for single tests to inject expected self-certified overhead clocks; for production, go to performance.now.
   */
  options?: { reportIntervalMs?: number; readSelfClockMs?: () => number },
): void {
  stopDesktopResourceTelemetry();
  agentMetricProbeDisabledAuditLogged = false;
  memoryLogTick = 0;
  memorySampleWriteGate = createMemorySampleWriteGate();
  resetProcessResourceSampleSources(PROCESS_RESOURCE_SAMPLE_SOURCES);
  processResourceSystemWindow.clear();
  readTelemetrySelfClockMs = options?.readSelfClockMs ?? (() => performance.now());

  const reportIntervalMs = options?.reportIntervalMs ?? RESOURCE_REPORT_INTERVAL_MS;

  sampleTimer = setInterval(() => {
    measureTelemetrySelfMs(() => {
      try {
        takeSample(logger);
      } catch (error) {
        logger.warn("[resource] sample failed:", error);
      }
    });
  }, RESOURCE_SAMPLE_INTERVAL_MS);

  reportTimer = setInterval(() => {
    measureTelemetrySelfMs(() => {
      try {
        flushResourceReports(logger);
      } catch (error) {
        logger.warn("[resource] report failed:", error);
      }
    });
  }, reportIntervalMs);

  // Telemetry timers must not extend process life.
  sampleTimer.unref?.();
  reportTimer.unref?.();

  logger.info(
    `[resource] sampling started interval=${RESOURCE_SAMPLE_INTERVAL_MS}ms report=${reportIntervalMs}ms`,
  );
}

export function stopDesktopResourceTelemetry(options?: {
  /** Normal exit: drains the leftover window so `sample_count` stays truthful; it triggers no new sampling. */
  flushPendingWindows?: boolean;
}): void {
  recentToolExecCompletions.clear();
  if (sampleTimer) {
    clearInterval(sampleTimer);
    sampleTimer = null;
  }
  if (reportTimer) {
    clearInterval(reportTimer);
    reportTimer = null;
  }
  if (options?.flushPendingWindows) {
    // Bug root cause: After changing to 5-minute aggregation, the old stop of direct clear is still used for normal exit.
    // Causes samples that have been received but do not fill the window to be lost silently. This only empties the memory window and does not trigger new samples or disk scans.
    drainAllResourceWindows();
  } else {
    processResourceWindows.clear();
    processResourceSystemWindow.clear();
  }
}
