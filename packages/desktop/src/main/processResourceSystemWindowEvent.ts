/** The property projection for `perf_system_window` (a pure function whose property keys map one-to-one to the allow-list, 17 in total). */

import { PROCESS_RESOURCE_EVENT_NAMES } from "@zcode/shared";
import type { SystemResourceWindowReport } from "./processResourceSystemWindowAggregator.js";
import {
  normalizeOsCategory,
  type ProcessResourceReportContext,
} from "./processResourceWindowEvent.js";

export const PERF_SYSTEM_WINDOW_EVENT_NAME = PROCESS_RESOURCE_EVENT_NAMES.systemWindow;

/** The hardware dimension describes the desktop machine itself: a device-level event only counts local processes, with no remote override case. */
export function buildSystemWindowEventProperties(
  report: SystemResourceWindowReport,
  context: ProcessResourceReportContext,
): Record<string, string | number | undefined> {
  const hardware = context.desktopHardware;
  return {
    platform: normalizeOsCategory(hardware.platform),
    app_version: context.appVersion,
    arms_env: context.armsEnv,
    device_mid: context.deviceMid,
    arch: hardware.arch,
    logical_cpu_count: hardware.logicalCpuCount,
    total_memory_gb: hardware.totalMemoryGb,
    background_ratio: report.backgroundRatio,
    app_uptime_minutes: report.appUptimeMinutes,
    system_cpu_percent_p95: report.systemCpuPercentP95,
    system_free_memory_kb_min: report.systemFreeMemoryKbMin,
    app_cpu_percent_p95: report.appCpuPercentP95,
    app_rss_kb_total_mean: report.appRssKbTotalMean,
    app_rss_kb_total_peak: report.appRssKbTotalPeak,
    process_count_total_peak: report.processCountTotalPeak,
    sample_count: report.sampleCount,
    telemetry_self_ms: report.telemetrySelfMs,
  };
}
