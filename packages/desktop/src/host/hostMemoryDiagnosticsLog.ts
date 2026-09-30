import {
  createMemorySampleWriteGate,
  formatMemorySampleLine,
  MEMORY_SAMPLE_INTERVAL_MS,
  memoryUsageToSampleFields,
  type MemorySample,
} from "@zcode/shared";

interface HostMemoryDiagnosticsLogger {
  info(...args: unknown[]): void;
}

interface HostMemoryDiagnosticsTimerHandle {
  unref?(): void;
}

export interface StartHostMemoryDiagnosticsLogOptions {
  logger: HostMemoryDiagnosticsLogger;
  /** Domain counters from the services layer (`collectServiceMemoryDiagnostics`). */
  collectCounters(): Record<string, number>;
  readMemoryUsage?: () => NodeJS.MemoryUsage;
  /**
   * The second exit point for a single `memoryUsage()` reading: the host sample for resource telemetry.
   *
   * Independent of the write gate — the local log line may be gated away, but the telemetry sample
   * must be sent every 60 seconds; a throw from this callback only drops the telemetry sample and
   * leaves the local log untouched.
   */
  onMemoryUsage?: (memoryUsage: NodeJS.MemoryUsage) => void;
  now?: () => number;
  intervalMs?: number;
  timer?: {
    setInterval(callback: () => void, intervalMs: number): HostMemoryDiagnosticsTimerHandle;
    clearInterval(handle: HostMemoryDiagnosticsTimerHandle): void;
  };
}

interface HostMemoryDiagnosticsLog {
  /** Sample once immediately (for testing and manual triggering) and return whether to write to disk. */
  sampleNow(): boolean;
  stop(): void;
}

/**
 * In-process memory diagnostics log for the Local Host process.
 * Samples every 60s, and once the change/heartbeat gate passes, writes a single
 * `[memory] role=utility_host ...` line forwarded through the existing host logger into the Desktop
 * main log; no new parentPort message type is introduced.
 */
export function startHostMemoryDiagnosticsLog(
  options: StartHostMemoryDiagnosticsLogOptions,
): HostMemoryDiagnosticsLog {
  const readMemoryUsage = options.readMemoryUsage ?? (() => process.memoryUsage());
  const now = options.now ?? (() => Date.now());
  const timer = options.timer ?? {
    setInterval: (callback: () => void, intervalMs: number) => setInterval(callback, intervalMs),
    clearInterval: (handle: HostMemoryDiagnosticsTimerHandle) =>
      clearInterval(handle as ReturnType<typeof setInterval>),
  };
  const gate = createMemorySampleWriteGate();

  const sampleNow = (): boolean => {
    let memoryUsage: NodeJS.MemoryUsage;
    try {
      memoryUsage = readMemoryUsage();
    } catch {
      // When a read fails, neither outlet has facts available and only the current sample is lost.
      return false;
    }

    try {
      options.onMemoryUsage?.(memoryUsage);
    } catch {
      // If the telemetry export fails, only the current sample will be lost, and the local diagnostic log will still be written.
    }

    try {
      const sample: MemorySample = {
        role: "utility_host",
        ...memoryUsageToSampleFields(memoryUsage),
        counters: options.collectCounters(),
      };
      const reason = gate.evaluate(sample, now());
      if (!reason) {
        return false;
      }
      options.logger.info(formatMemorySampleLine(sample, reason));
      return true;
    } catch {
      // If diagnostic sampling fails, only the current sample will be lost and the Host service will not be affected.
      return false;
    }
  };

  let handle: HostMemoryDiagnosticsTimerHandle | undefined = timer.setInterval(
    sampleNow,
    options.intervalMs ?? MEMORY_SAMPLE_INTERVAL_MS,
  );
  try {
    handle.unref?.();
  } catch {
    // When unref is unavailable, the handle is still retained for stop recycling.
  }

  return {
    sampleNow,
    stop() {
      if (!handle) {
        return;
      }
      const current = handle;
      handle = undefined;
      timer.clearInterval(current);
    },
  };
}
