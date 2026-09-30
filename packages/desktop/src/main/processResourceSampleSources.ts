/**
 * Types and scheduling for the resource sample source registry.
 *
 * Each source lives in its own file and only adds a line to the registry; sources know nothing
 * about each other, and a single source that fails to sample loses only its own sample (dropped on
 * failure, never blocking the product).
 */

import type { ProcessResourceRole } from "@zcode/shared";
import type { AppResourceTotals } from "./processResourceAppTotals.js";
import type { DeviceResourceSample } from "./processResourceSystemWindowAggregator.js";
import type { ProcessRoleSample } from "./processResourceWindowAggregator.js";

export interface ProcessResourceSampleContext {
  /** Wall-clock time for this tick, shared by every source so time cannot drift within a tick. */
  now: number;
  addRoleSample: (sample: ProcessRoleSample) => void;
  /**
   * Sources that only contribute heap readings without forming a complete role sample use this hook
   * (host / scheduler self-sampling, renderer). The heap reading is folded into the complete sample
   * for that role within the same tick; when that role has no complete sample in this tick the
   * reading is dropped — heap is only an extra dimension of a role event, not enough to open a
   * window on its own.
   */
  addRoleHeapSample: (role: ProcessResourceRole, heapUsedKb: number) => void;
  /**
   * The total of the app processes main can enumerate exactly within this tick (currently only the
   * Chromium family). Device-level sources read it in the second phase to compute the app total, so
   * the total here must not double-count the external sample entry points.
   */
  addAppProcessTotals: (totals: AppResourceTotals) => void;
  onError?: (sourceId: string, error: unknown) => void;
}

/**
 * Context for device-level sampling (second phase): it relies on facts the first phase already
 * collected within the same tick. Running the two phases separately means sources no longer have
 * to pass values through call order or module-level variables.
 */
export interface ProcessResourceDeviceSampleContext {
  now: number;
  /** The exact total from the first phase; null when no source contributed in this tick, in which case no device sample is produced. */
  appProcessTotals: AppResourceTotals | null;
  addDeviceSample: (sample: DeviceResourceSample) => void;
  onError?: (sourceId: string, error: unknown) => void;
}

export interface ProcessResourceSampleSource {
  /** Source identifier, used only for logging and registry uniqueness checks; never an event property. */
  readonly id: string;
  /**
   * Called by main on every 10-second tick to write this source's current instantaneous facts into
   * the open window.
   *
   * Push-style sources (host/scheduler heap, renderer heap, CLI, MCP) use the same hook: each one
   * exports an `ingestXxx(sample)` for the message dispatch point to call, keeps the most recent
   * sample inside the source module, and hands it to the aggregator in `sample()`. Window
   * boundaries therefore stay solely on main's flush clock, sources need no knowledge of each
   * other, and the registry only grows by a line.
   */
  sample?: (context: ProcessResourceSampleContext) => void;
  /**
   * Sources that need "facts other sources already collected within the same tick" use this hook
   * (`perf_system_window`). Within a tick every `sample` runs first, then every `sampleDevice`.
   */
  sampleDevice?: (context: ProcessResourceDeviceSampleContext) => void;
  /**
   * Called while a normal exit drains the leftover window: it hands readings that "arrived but
   * missed their own delivery beat" to the window in time (CLI does the same, as does MCP).
   * **It only moves facts that already exist and never samples anew** — the exit path is not
   * allowed to read `getAppMetrics()` again or start any probe.
   */
  flushPending?: (context: ProcessResourceSampleContext) => void;
  /** Clears the source's own cached instantaneous state when sampling stops or restarts, so data never leaks across sessions. */
  reset?: () => void;
}

export function runProcessResourceSampleSources(
  sources: readonly ProcessResourceSampleSource[],
  context: ProcessResourceSampleContext,
): void {
  for (const source of sources) {
    try {
      source.sample?.(context);
    } catch (error) {
      context.onError?.(source.id, error);
    }
  }
}

export function runProcessResourceDeviceSampleSources(
  sources: readonly ProcessResourceSampleSource[],
  context: ProcessResourceDeviceSampleContext,
): void {
  for (const source of sources) {
    try {
      source.sampleDevice?.(context);
    } catch (error) {
      context.onError?.(source.id, error);
    }
  }
}

export function flushPendingProcessResourceSampleSources(
  sources: readonly ProcessResourceSampleSource[],
  context: ProcessResourceSampleContext,
): void {
  for (const source of sources) {
    try {
      source.flushPending?.(context);
    } catch (error) {
      context.onError?.(source.id, error);
    }
  }
}

export function resetProcessResourceSampleSources(
  sources: readonly ProcessResourceSampleSource[],
): void {
  for (const source of sources) {
    try {
      source.reset?.();
    } catch {
      // reset is only responsible for discarding the transient state, and failure will not affect other sources and subsequent sampling.
    }
  }
}
