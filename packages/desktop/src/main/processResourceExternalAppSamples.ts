/**
 * The entry point for external samples feeding the device-level app totals.
 *
 * The app total for `perf_system_window` is defined as "the exact sum across the Chromium
 * processes every 10 seconds, plus the most recent known external samples". External processes
 * (CLI self-sampling every 60 seconds, MCP sampling every 5 minutes) are not in
 * `app.getAppMetrics()` and can never produce a reading on main's 10-second beat, so only the
 * latest sample per source is kept here, and staleness is judged against that source's own
 * sampling interval: going more than two sampling intervals without a new sample means the
 * process exited or the sampling link broke, and undercounting is better than passing a stale
 * value off as a current fact.
 *
 * The CLI role and the MCP role each call `recordExternalAppResourceSample` at their own ingest
 * point. Purely in-memory, bounded, and drop-on-failure: no queueing, no persistence, no retry.
 */

import type { ProcessResourceRuntimeSurface } from "@zcode/shared";
import {
  addAppResourceTotals,
  createEmptyAppResourceTotals,
  type AppResourceTotals,
} from "./processResourceAppTotals.js";

/** The default period when the sampling period is not self-reported (CLI self-sampling beat). */
const EXTERNAL_APP_RESOURCE_SAMPLE_DEFAULT_INTERVAL_MS = 60_000;

/**
 * Source entry upper limit (memory bounded).
 * After the CLI is changed to save up to 64 instances, the budget increases by these 64 items, retaining the original MCP source space.
 * Only the memory limit is increased, no queues or timers are added; new sources are discarded directly after exceeding the limit.
 */
const PROCESS_RESOURCE_MAX_EXTERNAL_SAMPLE_SOURCES = 128;

interface ExternalAppResourceSample extends AppResourceTotals {
  /**
   * Stable key of the source (such as CLI instance, MCP source group): only used to overwrite old samples and determine expiration.
   * No ARMS properties are entered, so no pid, path or workspace id must be put.
   */
  sourceKey: string;
  /** Device-level totals only count local processes; remote CLI/MCP samples are directly discarded here. */
  runtimeSurface: ProcessResourceRuntimeSurface;
  /** The sampling period of this source; the expiration criterion is 2 times the period and has not been updated. The default is 60 seconds. */
  intervalMs?: number;
  /** The moment when main side receives this sample. */
  receivedAt: number;
}

interface StoredExternalSample extends AppResourceTotals {
  receivedAt: number;
  expiresAfterMs: number;
}

const latestSamplesBySource = new Map<string, StoredExternalSample>();

function isNonNegativeFinite(value: number): boolean {
  return Number.isFinite(value) && value >= 0;
}

/** Records the latest sample for one external source; an invalid sample is dropped outright and does not affect the existing totals. */
export function recordExternalAppResourceSample(sample: ExternalAppResourceSample): void {
  if (sample.runtimeSurface !== "local" || !sample.sourceKey) {
    return;
  }
  if (
    !isNonNegativeFinite(sample.cpuPercent) ||
    !isNonNegativeFinite(sample.rssKbTotal) ||
    !isNonNegativeFinite(sample.processCount) ||
    !Number.isFinite(sample.receivedAt)
  ) {
    return;
  }
  if (
    !latestSamplesBySource.has(sample.sourceKey) &&
    latestSamplesBySource.size >= PROCESS_RESOURCE_MAX_EXTERNAL_SAMPLE_SOURCES
  ) {
    return;
  }

  const intervalMs =
    typeof sample.intervalMs === "number" &&
    Number.isFinite(sample.intervalMs) &&
    sample.intervalMs > 0
      ? sample.intervalMs
      : EXTERNAL_APP_RESOURCE_SAMPLE_DEFAULT_INTERVAL_MS;

  latestSamplesBySource.set(sample.sourceKey, {
    cpuPercent: sample.cpuPercent,
    rssKbTotal: sample.rssKbTotal,
    processCount: sample.processCount,
    receivedAt: sample.receivedAt,
    expiresAfterMs: intervalMs * 2,
  });
}

/** Totals up the external sources that have not expired; expired entries are swept away along the way so zombie sources do not linger in long sessions. */
export function collectExternalAppResourceTotals(now: number): AppResourceTotals {
  let totals = createEmptyAppResourceTotals();
  for (const [sourceKey, sample] of latestSamplesBySource) {
    if (now - sample.receivedAt > sample.expiresAfterMs) {
      latestSamplesBySource.delete(sourceKey);
      continue;
    }
    totals = addAppResourceTotals(totals, sample);
  }
  return totals;
}

/** Clears every source when sampling starts or stops, so data never leaks across sampling sessions. */
export function resetExternalAppResourceSamples(): void {
  latestSamplesBySource.clear();
}
