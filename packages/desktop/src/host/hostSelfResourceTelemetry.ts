/**
 * Resource telemetry for the Host process itself.
 *
 * Reuses the memory diagnostics log's existing 60 second timer: a single `process.memoryUsage()`
 * reading has two exit points — the local `[memory] role=utility_host` log line is written under
 * the existing gate, and the same reading is converted into a `HostResourceSample` and sent to
 * main over parentPort, becoming the heap source for host-role events. The process therefore still
 * has only one telemetry timer; a failure at any step only drops the current sample and leaves the
 * Host service untouched.
 */

import { HostResponseTypes } from "@zcode/shared";
import {
  createNodeSelfResourceSampler,
  type NodeSelfResourceSamplerOptions,
} from "@zcode/shared/node";
import {
  startHostMemoryDiagnosticsLog,
  type StartHostMemoryDiagnosticsLogOptions,
} from "./hostMemoryDiagnosticsLog.js";

interface StartHostSelfResourceTelemetryOptions
  extends
    Omit<StartHostMemoryDiagnosticsLogOptions, "onMemoryUsage">,
    NodeSelfResourceSamplerOptions {
  /**
   * The sending port of parentPort. Host has no parentPort in non-utilityProcess environments (local debugging),
   * At this time, only local logs are written and no samples are sent.
   */
  postMessage?: ((message: unknown) => void) | undefined;
}

interface HostSelfResourceTelemetry {
  /** Immediately sample once (for testing and manual triggering), and return whether the local log is written to disk. */
  sampleNow(): boolean;
  stop(): void;
}

export function startHostSelfResourceTelemetry(
  options: StartHostSelfResourceTelemetryOptions,
): HostSelfResourceTelemetry {
  const sampler = createNodeSelfResourceSampler(options);
  const postMessage = options.postMessage;

  // Pass item by item instead of whole spread: Sampler-specific options (readCpuUsage, etc.) should not leak into the diagnostic logging module.
  return startHostMemoryDiagnosticsLog({
    logger: options.logger,
    collectCounters: options.collectCounters,
    readMemoryUsage: options.readMemoryUsage,
    now: options.now,
    intervalMs: options.intervalMs,
    timer: options.timer,
    onMemoryUsage: (memoryUsage) => {
      if (!postMessage) {
        return;
      }
      const sample = sampler.sample(memoryUsage);
      if (!sample) {
        return;
      }
      try {
        postMessage({ type: HostResponseTypes.HostResourceSample, sample });
      } catch {
        // Only the current sample is lost when main has exited or IPC is unavailable.
      }
    },
  });
}
