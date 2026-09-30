/**
 * Bounded aggregation window for device-level resources.
 *
 * One `perf_system_window` per device per window: whole-machine CPU and free memory, app totals,
 * and the telemetry's own overhead. Like the per-role windows, it is purely in-memory, bounded,
 * with no queue and no retry; on flush it projects into a single report.
 */

import {
  appendBoundedSamples,
  computeAggregateStats,
  roundMetric,
} from "./resourceMetricsStats.js";
import { PROCESS_RESOURCE_MAX_SAMPLES_PER_WINDOW } from "./processResourceWindowAggregator.js";

/** One device-level instant of a 10-second tick; no sample is produced while the whole-machine CPU baseline is missing. */
export interface DeviceResourceSample {
  /** Whole-machine CPU (whole-machine normalized percentage derived from the delta of two `os.cpus()` readings). */
  systemCpuPercent: number;
  systemFreeMemoryKb: number;
  /** Summed CPU of every local ZCode process. */
  appCpuPercent: number;
  appRssKbTotal: number;
  appProcessCount: number;
}

export interface SystemResourceWindowReport {
  backgroundRatio: number;
  appUptimeMinutes: number;
  systemCpuPercentP95: number;
  systemFreeMemoryKbMin: number;
  /** Event value. */
  appCpuPercentMean: number;
  appCpuPercentP95: number;
  appRssKbTotalMean: number;
  appRssKbTotalPeak: number;
  processCountTotalPeak: number;
  sampleCount: number;
  telemetrySelfMs: number;
}

export class ProcessResourceSystemWindowAggregator {
  private systemCpuPercent: number[] = [];
  private systemFreeMemoryKb: number[] = [];
  private appCpuPercent: number[] = [];
  private appRssKbTotal: number[] = [];
  private processCountTotalPeak = 0;
  private telemetrySelfMs = 0;

  add(sample: DeviceResourceSample): void {
    this.systemCpuPercent = appendSample(this.systemCpuPercent, sample.systemCpuPercent);
    this.systemFreeMemoryKb = appendSample(this.systemFreeMemoryKb, sample.systemFreeMemoryKb);
    this.appCpuPercent = appendSample(this.appCpuPercent, sample.appCpuPercent);
    this.appRssKbTotal = appendSample(this.appRssKbTotal, sample.appRssKbTotal);
    this.processCountTotalPeak = Math.max(this.processCountTotalPeak, sample.appProcessCount);
  }

  /**
   * Accumulates the wall-clock time the main-side telemetry code itself takes (self-reported overhead).
   * The time flush itself spends can only count toward the next window — it happens after the
   * window has been projected.
   */
  addTelemetrySelfMs(elapsedMs: number): void {
    if (!Number.isFinite(elapsedMs) || elapsedMs <= 0) {
      return;
    }
    this.telemetrySelfMs += elapsedMs;
  }

  /**
   * Takes and clears the window. Returns null when the window holds no device samples, so no empty
   * event is emitted, but the self-reported overhead already accumulated carries over into the next
   * window — a window whose sampling failed repeatedly is precisely the one that most needs to see
   * what the telemetry itself costs.
   * `backgroundRatio` is supplied by the per-role aggregator's scene count, so both events carry
   * the same number.
   */
  drain(input: {
    backgroundRatio: number;
    appUptimeMinutes: number;
  }): SystemResourceWindowReport | null {
    if (this.appCpuPercent.length === 0) {
      this.clearSamples();
      return null;
    }

    const systemCpu = computeAggregateStats(this.systemCpuPercent);
    const appCpu = computeAggregateStats(this.appCpuPercent);
    const appRss = computeAggregateStats(this.appRssKbTotal);
    const report: SystemResourceWindowReport = {
      backgroundRatio: input.backgroundRatio,
      appUptimeMinutes: input.appUptimeMinutes,
      systemCpuPercentP95: systemCpu.p95,
      systemFreeMemoryKbMin: Math.min(...this.systemFreeMemoryKb),
      appCpuPercentMean: appCpu.mean,
      appCpuPercentP95: appCpu.p95,
      appRssKbTotalMean: appRss.mean,
      appRssKbTotalPeak: appRss.peak,
      processCountTotalPeak: this.processCountTotalPeak,
      sampleCount: appCpu.sample_count,
      telemetrySelfMs: roundMetric(this.telemetrySelfMs),
    };
    this.clear();
    return report;
  }

  clear(): void {
    this.clearSamples();
    this.telemetrySelfMs = 0;
  }

  private clearSamples(): void {
    this.systemCpuPercent = [];
    this.systemFreeMemoryKb = [];
    this.appCpuPercent = [];
    this.appRssKbTotal = [];
    this.processCountTotalPeak = 0;
  }
}

/** The same upper limit and overflow strategy as the role window: retain the reading at the end of the window when the timer drifts. */
function appendSample(bucket: number[], value: number): number[] {
  return appendBoundedSamples(bucket, value, PROCESS_RESOURCE_MAX_SAMPLES_PER_WINDOW);
}
