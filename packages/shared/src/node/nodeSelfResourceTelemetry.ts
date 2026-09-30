/**
 * Shared conversion logic for the self-sampled CPU / memory of the two utilityProcesses,
 * host and scheduler.
 *
 * It only does the differential conversion: it owns no timer and is not responsible for
 * sending. host reuses the existing 60-second timer of the memory diagnostics log, while
 * scheduler starts its own single unref timer; both hand the very same
 * `process.memoryUsage()` reading to here to convert it into one sample. Zero external
 * processes, only in-process APIs.
 */

import { availableParallelism } from "node:os";
import { bytesToKb } from "../memoryDiagnostics.js";
import type { NodeSelfResourceSample } from "../validation.js";

interface NodeCpuUsageSnapshot {
  user: number;
  system: number;
}

/** Self-sampling period of a Node process: 60 seconds, on the same beat as the local memory diagnostics log. */
export const NODE_SELF_RESOURCE_SAMPLE_INTERVAL_MS = 60_000;

export interface NodeSelfResourceSamplerOptions {
  readCpuUsage?: () => NodeCpuUsageSnapshot;
  readMonotonicTimeNs?: () => bigint;
  logicalCpuCount?: number;
}

export interface NodeSelfResourceSampler {
  /**
   * Converts a sample from the `memoryUsage` the caller just read.
   * Returns null when no baseline is available (first reading failed, clock did not
   * advance, CPU counters went backwards) — only the current sample is dropped.
   */
  sample(memoryUsage: NodeJS.MemoryUsage): NodeSelfResourceSample | null;
}

interface SamplerBaseline {
  cpu: NodeCpuUsageSnapshot;
  monotonicTimeNs: bigint;
}

/** The CPU percentage keeps 4 decimal places, matching the calibration of CLI self-sampled figures. */
function roundResourceMetric(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

export function createNodeSelfResourceSampler(
  options: NodeSelfResourceSamplerOptions = {},
): NodeSelfResourceSampler {
  const readCpuUsage = options.readCpuUsage ?? (() => process.cpuUsage());
  const readMonotonicTimeNs = options.readMonotonicTimeNs ?? (() => process.hrtime.bigint());
  const logicalCpuCount = Math.max(
    1,
    Math.min(4_096, Math.trunc(options.logicalCpuCount ?? availableParallelism())),
  );

  const readBaseline = (): SamplerBaseline | null => {
    try {
      return { cpu: readCpuUsage(), monotonicTimeNs: readMonotonicTimeNs() };
    } catch {
      return null;
    }
  };

  // Establish the baseline at construction time so that the first 60-second tick can directly produce a sample instead of spinning empty for one round.
  let baseline = readBaseline();

  return {
    sample(memoryUsage) {
      const next = readBaseline();
      if (!next) {
        return null;
      }
      const previous = baseline;
      baseline = next;
      if (!previous) {
        return null;
      }

      const elapsedNs = next.monotonicTimeNs - previous.monotonicTimeNs;
      const cpuDeltaUs =
        next.cpu.user - previous.cpu.user + (next.cpu.system - previous.cpu.system);
      if (elapsedNs <= 0n || cpuDeltaUs < 0) {
        return null;
      }

      const cpuCores = cpuDeltaUs / (Number(elapsedNs) / 1_000);
      return {
        cpuPercent: roundResourceMetric((cpuCores / logicalCpuCount) * 100),
        rssKb: bytesToKb(memoryUsage.rss),
        heapUsedKb: bytesToKb(memoryUsage.heapUsed),
      };
    },
  };
}
