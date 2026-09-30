/**
 * The value "the combined resources of a batch of processes at a single instant".
 *
 * The app totals in the device-level `perf_system_window` are the sum of two parts: the Chromium
 * family total that main can enumerate exactly, plus the total of the most recent known sample
 * from external sources like CLI / MCP. Both sides carry the same value semantics, so there is
 * only this one type and one addition routine.
 */

import { roundMetric } from "./resourceMetricsStats.js";

export interface AppResourceTotals {
  /** Summed CPU of this batch of processes (whole-machine normalized percentage). */
  cpuPercent: number;
  rssKbTotal: number;
  processCount: number;
}

export function createEmptyAppResourceTotals(): AppResourceTotals {
  return { cpuPercent: 0, rssKbTotal: 0, processCount: 0 };
}

/** Adds two batches of totals; CPU is rounded only after the addition, because rounding per step lets the error accumulate with the process count. */
export function addAppResourceTotals(
  base: AppResourceTotals,
  extra: AppResourceTotals,
): AppResourceTotals {
  return {
    cpuPercent: roundMetric(base.cpuPercent + extra.cpuPercent),
    rssKbTotal: base.rssKbTotal + extra.rssKbTotal,
    processCount: base.processCount + extra.processCount,
  };
}
