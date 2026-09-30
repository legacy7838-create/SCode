/**
 * Bounded aggregation window for process roles.
 *
 * Every source (Chromium family, Node's own sampling, CLI, MCP) feeds in "an instant of a role at
 * a single moment", and on flush each window projects into one `perf_process_window`. Purely
 * in-memory, bounded, with no queue and no retry.
 */

import type { ProcessResourceRole, ProcessResourceRuntimeSurface } from "@zcode/shared";
import {
  appendBoundedSamples,
  computeAggregateStats,
  roundMetric,
} from "./resourceMetricsStats.js";

/** Per-role, per-series sample cap (5 minutes @ 10s = 30, with 2 slots of slack for timer drift). */
export const PROCESS_RESOURCE_MAX_SAMPLES_PER_WINDOW = 32;
/**
 * The upper limit of simultaneous windows (memory bounded).
 * Roles, operating environments, hardware and MCP IDs will open windows separately; multiple remote environments share 64 window budgets.
 * After exceeding the limit, the new window is directly discarded without queuing or persistence.
 */
const PROCESS_RESOURCE_MAX_WINDOWS = 64;

type ProcessResourceScene = "foreground" | "background";

/** The machine this role actually runs on; when absent, the egress fills in the desktop machine's value. */
export interface ProcessResourceHardware {
  platform: NodeJS.Platform;
  arch: string;
  logicalCpuCount: number;
  totalMemoryGb: number;
}

/**
 * Running-machine information reported by the sample itself, which may only fill in some of the
 * fields (older CLIs carry no `totalMemoryGb`).
 * The egress overrides the desktop-machine defaults field by field rather than picking one side
 * wholesale.
 */
export type ProcessResourceHardwareOverride = Partial<ProcessResourceHardware>;

/** One instant of a role at a single moment. */
export interface ProcessRoleSample {
  role: ProcessResourceRole;
  /** Environment hash injected by the Host; used only for in-memory grouping and never projected onto event properties. */
  environmentKey?: string;
  /** Summed CPU of every process in the role (whole-machine normalized percentage). */
  cpuPercent: number;
  rssKbTotal: number;
  rssKbMaxProcess: number;
  processCount: number;
  uptimeMinutes: number;
  /** Node roles and renderer_main only; absent means this sample carries no heap reading. */
  heapUsedKb?: number;
  runtimeSurface?: ProcessResourceRuntimeSurface;
  /** mcp roles only. */
  mcpId?: string;
  hardware?: ProcessResourceHardwareOverride;
}

export interface ProcessRoleWindowReport {
  role: ProcessResourceRole;
  runtimeSurface: ProcessResourceRuntimeSurface;
  mcpId?: string;
  hardware?: ProcessResourceHardwareOverride;
  backgroundRatio: number;
  uptimeMinutes: number;
  cpuPercentMean: number;
  cpuPercentP95: number;
  cpuPercentPeak: number;
  rssKbTotalMean: number;
  rssKbTotalPeak: number;
  rssKbMaxProcessPeak: number;
  heapUsedKbMean?: number;
  heapUsedKbPeak?: number;
  processCountPeak: number;
  sampleCount: number;
}

interface ProcessRoleWindow {
  role: ProcessResourceRole;
  runtimeSurface: ProcessResourceRuntimeSurface;
  mcpId?: string;
  hardware?: ProcessResourceHardwareOverride;
  cpuPercent: number[];
  rssKbTotal: number[];
  rssKbMaxProcess: number[];
  heapUsedKb: number[];
  processCountPeak: number;
  uptimeMinutes: number;
}

/**
 * The hardware-dimension fingerprint describes specifications only, never machine identity.
 * Environment identity is injected by the Host as a separate window key, so that CPU/RSS from
 * remote environments of the same spec are not added together; the hardware fingerprint still
 * separates readings of differing specs within the same environment. Local roles carry no
 * hardware, so the fingerprint is an empty string and the window key is exactly the same as when
 * only the role is present.
 */
export function processResourceHardwareKey(hardware?: ProcessResourceHardwareOverride): string {
  if (!hardware) {
    return "";
  }
  return [
    hardware.platform ?? "",
    hardware.arch ?? "",
    hardware.logicalCpuCount ?? "",
    hardware.totalMemoryGb ?? "",
  ].join("/");
}

function windowKey(sample: ProcessRoleSample): string {
  return [
    sample.role,
    sample.runtimeSurface ?? "local",
    sample.environmentKey ?? "",
    sample.mcpId ?? "",
    processResourceHardwareKey(sample.hardware),
  ].join(":");
}

export class ProcessResourceWindowAggregator {
  private readonly windows = new Map<string, ProcessRoleWindow>();
  private sceneTicks = 0;
  private backgroundTicks = 0;

  /** main records foreground/background once per 10-second tick; the ratio within the window is shared by every role event. */
  recordScene(scene: ProcessResourceScene): void {
    this.sceneTicks += 1;
    if (scene === "background") {
      this.backgroundTicks += 1;
    }
  }

  add(sample: ProcessRoleSample): void {
    const key = windowKey(sample);
    let window = this.windows.get(key);
    if (!window) {
      if (this.windows.size >= PROCESS_RESOURCE_MAX_WINDOWS) {
        return;
      }
      window = {
        role: sample.role,
        runtimeSurface: sample.runtimeSurface ?? "local",
        mcpId: sample.mcpId,
        hardware: sample.hardware,
        cpuPercent: [],
        rssKbTotal: [],
        rssKbMaxProcess: [],
        heapUsedKb: [],
        processCountPeak: 0,
        uptimeMinutes: 0,
      };
      this.windows.set(key, window);
    }

    // Both the operating environment and hardware dimensions enter the window key, and there is no need to cover dimensions in the same window.
    window.cpuPercent = appendBounded(window.cpuPercent, sample.cpuPercent);
    window.rssKbTotal = appendBounded(window.rssKbTotal, sample.rssKbTotal);
    window.rssKbMaxProcess = appendBounded(window.rssKbMaxProcess, sample.rssKbMaxProcess);
    if (typeof sample.heapUsedKb === "number" && Number.isFinite(sample.heapUsedKb)) {
      window.heapUsedKb = appendBounded(window.heapUsedKb, sample.heapUsedKb);
    }
    window.processCountPeak = Math.max(window.processCountPeak, sample.processCount);
    window.uptimeMinutes = Math.max(window.uptimeMinutes, sample.uptimeMinutes);
  }

  /**
   * Share of background ticks within the window.
   * Role events and the device-level `perf_system_window` share this one number, so there is only
   * this one set of scene counts; note that `drain()` zeroes them, so the device event must read
   * the value before draining.
   */
  get backgroundRatio(): number {
    return this.sceneTicks > 0 ? roundMetric(this.backgroundTicks / this.sceneTicks) : 0;
  }

  /** Takes and clears every window; `sample_count` faithfully reflects the number of samples in the window (including truncated windows). */
  drain(): ProcessRoleWindowReport[] {
    const backgroundRatio = this.backgroundRatio;
    const reports = [...this.windows.values()]
      .filter((window) => window.cpuPercent.length > 0)
      .map((window) => projectWindow(window, backgroundRatio));
    this.clear();
    return reports;
  }

  clear(): void {
    this.windows.clear();
    this.sceneTicks = 0;
    this.backgroundTicks = 0;
  }
}

/**
 * Drop oldest samples on overflow: the upper limit is only hit when the timer drifts (more than 30 ticks squeezed into a window),
 * The reading at the end of the window at this time is the fact for that period of time to be reported.
 */
function appendBounded(bucket: number[], value: number): number[] {
  return appendBoundedSamples(bucket, value, PROCESS_RESOURCE_MAX_SAMPLES_PER_WINDOW);
}

function projectWindow(
  window: ProcessRoleWindow,
  backgroundRatio: number,
): ProcessRoleWindowReport {
  const cpu = computeAggregateStats(window.cpuPercent);
  const rssTotal = computeAggregateStats(window.rssKbTotal);
  const rssMaxProcess = computeAggregateStats(window.rssKbMaxProcess);
  const heap = window.heapUsedKb.length > 0 ? computeAggregateStats(window.heapUsedKb) : null;

  return {
    role: window.role,
    runtimeSurface: window.runtimeSurface,
    mcpId: window.mcpId,
    hardware: window.hardware,
    backgroundRatio,
    uptimeMinutes: window.uptimeMinutes,
    cpuPercentMean: cpu.mean,
    cpuPercentP95: cpu.p95,
    cpuPercentPeak: cpu.peak,
    rssKbTotalMean: rssTotal.mean,
    rssKbTotalPeak: rssTotal.peak,
    rssKbMaxProcessPeak: rssMaxProcess.peak,
    heapUsedKbMean: heap?.mean,
    heapUsedKbPeak: heap?.peak,
    processCountPeak: window.processCountPeak,
    sampleCount: cpu.sample_count,
  };
}
