/** Attribute projection for `perf_process_window` (a pure function whose attribute keys map one-to-one onto the allowlist). */

import type { ArmsRumEnv } from "@zcode/shared";
import { PROCESS_RESOURCE_EVENT_NAMES } from "@zcode/shared";
import type {
  ProcessResourceHardware,
  ProcessRoleWindowReport,
} from "./processResourceWindowAggregator.js";

export const PERF_PROCESS_WINDOW_EVENT_NAME = PROCESS_RESOURCE_EVENT_NAMES.processWindow;

export interface ProcessResourceReportContext {
  deviceMid: string;
  appVersion: string;
  armsEnv: ArmsRumEnv;
  /** Desktop machine hardware; samples that carry their own hardware (remote CLI / MCP) override this default. */
  desktopHardware: ProcessResourceHardware;
}

/** The `platform` dimension of ARMS only has these three values, and the Kanban boards are grouped according to it. */
type ProcessResourceOsCategory = "macos" | "windows" | "linux";

export function normalizeOsCategory(platform: NodeJS.Platform): ProcessResourceOsCategory {
  switch (platform) {
    case "darwin":
      return "macos";
    case "win32":
      return "windows";
    default:
      return "linux";
  }
}

/**
 * Attribute order matches the event contract; attributes whose value is undefined never reach the
 * final payload, so gpu / renderer_guest / chromium_other naturally carry 18 attributes.
 */
export function buildProcessWindowEventProperties(
  report: ProcessRoleWindowReport,
  context: ProcessResourceReportContext,
): Record<string, string | number | undefined> {
  // Field-by-field coverage: When the remote CLI only supports platform / arch / core number, total_memory_gb still takes the value of the desktop.
  const hardware = { ...context.desktopHardware, ...report.hardware };
  return {
    platform: normalizeOsCategory(hardware.platform),
    app_version: context.appVersion,
    arms_env: context.armsEnv,
    device_mid: context.deviceMid,
    process_role: report.role,
    runtime_surface: report.runtimeSurface,
    arch: hardware.arch,
    logical_cpu_count: hardware.logicalCpuCount,
    total_memory_gb: hardware.totalMemoryGb,
    mcp_id: report.mcpId,
    background_ratio: report.backgroundRatio,
    uptime_minutes: report.uptimeMinutes,
    cpu_percent_p95: report.cpuPercentP95,
    cpu_percent_peak: report.cpuPercentPeak,
    rss_kb_total_mean: report.rssKbTotalMean,
    rss_kb_total_peak: report.rssKbTotalPeak,
    rss_kb_max_process_peak: report.rssKbMaxProcessPeak,
    heap_used_kb_mean: report.heapUsedKbMean,
    heap_used_kb_peak: report.heapUsedKbPeak,
    process_count_peak: report.processCountPeak,
    sample_count: report.sampleCount,
  };
}
