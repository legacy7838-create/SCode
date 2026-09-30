/**
 * Resource telemetry for the cron scheduler process itself.
 *
 * The scheduler had no sampling at all before; this module adds its one and only unref'd timer:
 * every 60 seconds it reads `process.cpuUsage()` and `process.memoryUsage()` and sends the sample to
 * main over parentPort, becoming the heap source for scheduler-role events. A failed read or send
 * only drops the current sample and never affects the dispatch main loop. Zero external processes;
 * the timer is unref'd, so it does not extend the process lifetime.
 */

import {
  createNodeSelfResourceSampler,
  NODE_SELF_RESOURCE_SAMPLE_INTERVAL_MS,
  type NodeSelfResourceSamplerOptions,
} from "@zcode/shared/node";
import type { SchedulerToMainMessage } from "./schedulerProtocol.js";

interface SchedulerResourceTelemetryTimerHandle {
  unref?(): void;
}

interface StartSchedulerResourceTelemetryOptions extends NodeSelfResourceSamplerOptions {
  /** The sending port of parentPort; the caller passes a no-op when parentPort is unavailable. */
  postMessage: (message: SchedulerToMainMessage) => void;
  readMemoryUsage?: () => NodeJS.MemoryUsage;
  intervalMs?: number;
  timer?: {
    setInterval(callback: () => void, intervalMs: number): SchedulerResourceTelemetryTimerHandle;
    clearInterval(handle: SchedulerResourceTelemetryTimerHandle): void;
  };
}

export interface SchedulerResourceTelemetry {
  stop(): void;
}

export function startSchedulerResourceTelemetry(
  options: StartSchedulerResourceTelemetryOptions,
): SchedulerResourceTelemetry {
  const sampler = createNodeSelfResourceSampler(options);
  const readMemoryUsage = options.readMemoryUsage ?? (() => process.memoryUsage());
  const timer = options.timer ?? {
    setInterval: (callback: () => void, intervalMs: number) => setInterval(callback, intervalMs),
    clearInterval: (handle: SchedulerResourceTelemetryTimerHandle) =>
      clearInterval(handle as ReturnType<typeof setInterval>),
  };

  const sampleNow = (): void => {
    try {
      const sample = sampler.sample(readMemoryUsage());
      if (!sample) {
        return;
      }
      options.postMessage({ type: "scheduler-resource-sample", sample });
    } catch {
      // Only the current sample is lost when reading is abnormal, parentPort is unavailable or postMessage throws an error.
    }
  };

  let handle: SchedulerResourceTelemetryTimerHandle | undefined = timer.setInterval(
    sampleNow,
    options.intervalMs ?? NODE_SELF_RESOURCE_SAMPLE_INTERVAL_MS,
  );
  try {
    handle.unref?.();
  } catch {
    // When unref is unavailable, the handle is still retained for stop recycling.
  }

  return {
    stop() {
      if (!handle) {
        return;
      }
      const current = handle;
      handle = undefined;
      try {
        timer.clearInterval(current);
      } catch {
        // Cleanup failure cannot block the scheduler's existing exit process.
      }
    },
  };
}
