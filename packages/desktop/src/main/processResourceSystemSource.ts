/**
 * Device-level sample source.
 *
 * Shares the main process's 10-second tick with the Chromium family and runs in the second stage of
 * sampling: the difference between two adjacent `os.cpus()` snapshots gives whole-machine CPU, and
 * `os.freemem()` gives remaining whole-machine memory; the exact totals from the first stage are
 * then added to the most recent samples from the external sources (CLI, MCP) to get the app total.
 * Everything here is an in-process API — the main process has zero external processes.
 */

import os from "node:os";
import { addAppResourceTotals } from "./processResourceAppTotals.js";
import {
  collectExternalAppResourceTotals,
  resetExternalAppResourceSamples,
} from "./processResourceExternalAppSamples.js";
import type { ProcessResourceSampleSource } from "./processResourceSampleSources.js";
import { roundMetric } from "./resourceMetricsStats.js";

/** The accumulated time snapshot of the whole machine CPU; only the difference between two snapshots is the whole machine CPU within a period of time. */
interface SystemCpuTimesSnapshot {
  busyMs: number;
  totalMs: number;
}

function summarizeSystemCpuTimes(cpus: readonly os.CpuInfo[]): SystemCpuTimesSnapshot {
  let busyMs = 0;
  let idleMs = 0;
  for (const cpu of cpus) {
    const times = cpu.times;
    busyMs += (times?.user ?? 0) + (times?.nice ?? 0) + (times?.sys ?? 0) + (times?.irq ?? 0);
    idleMs += times?.idle ?? 0;
  }
  return { busyMs, totalMs: busyMs + idleMs };
}

/**
 * The difference percentage between the two snapshots; if the available difference cannot be obtained, null is returned, and the caller does not generate samples in this tick.
 * Returning null occurs when the accumulated time does not advance (`os.cpus()` in the container is empty), the number of cores changes or the clock is set back causing the difference to be negative.
 */
function diffSystemCpuPercent(
  previous: SystemCpuTimesSnapshot,
  next: SystemCpuTimesSnapshot,
): number | null {
  const totalDeltaMs = next.totalMs - previous.totalMs;
  const busyDeltaMs = next.busyMs - previous.busyMs;
  if (!(totalDeltaMs > 0) || busyDeltaMs < 0) {
    return null;
  }
  return roundMetric(Math.min(100, (busyDeltaMs / totalDeltaMs) * 100));
}

let previousCpuTimes: SystemCpuTimesSnapshot | null = null;

export const systemProcessResourceSampleSource: ProcessResourceSampleSource = {
  id: "system",
  sampleDevice(context) {
    const snapshot = summarizeSystemCpuTimes(os.cpus());
    const baseline = previousCpuTimes;
    previousCpuTimes = snapshot;

    // The first tick only has one snapshot, and the difference cannot be discussed, so no samples are generated;
    // The same goes for the first phase when there aren't any precise totals - it's better to have one less sample of equipment events than to report a half-true total.
    if (!baseline || !context.appProcessTotals) {
      return;
    }
    const systemCpuPercent = diffSystemCpuPercent(baseline, snapshot);
    if (systemCpuPercent === null) {
      return;
    }

    const appTotals = addAppResourceTotals(
      context.appProcessTotals,
      collectExternalAppResourceTotals(context.now),
    );
    context.addDeviceSample({
      systemCpuPercent,
      systemFreeMemoryKb: Math.round(os.freemem() / 1024),
      appCpuPercent: appTotals.cpuPercent,
      appRssKbTotal: appTotals.rssKbTotal,
      appProcessCount: appTotals.processCount,
    });
  },
  reset() {
    // Discard the CPU baseline and recent samples from external sources to avoid differencing and summing with facts from the last sampling session.
    previousCpuTimes = null;
    resetExternalAppResourceSamples();
  },
};
