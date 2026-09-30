import {
  createMemoryDiagnosticsRegistry,
  createMemorySampleWriteGate,
  formatMemorySampleLine,
  MEMORY_SAMPLE_INTERVAL_MS,
  type MemoryDiagnosticsRegistry,
  type MemorySample,
  type RendererHeapSample,
} from "@zcode/shared";
import { logMemoryDiagnostics } from "@/logger.js";

/**
 * The registry of renderer memory diagnostics counters. Each cache/store module registers a
 * read-only provider when the module loads; `startMemoryDiagnosticsLogger` samples once every 60
 * seconds and, once gated, writes to the desktop main log via `logger.logMemoryDiagnostics`.
 */
export const uiMemoryDiagnosticsRegistry: MemoryDiagnosticsRegistry =
  createMemoryDiagnosticsRegistry();

interface RendererHeapSnapshot {
  usedJSHeapSize?: number;
  totalJSHeapSize?: number;
}

/** Chromium-only `performance.memory`; returns undefined when the Web-side browser lacks it. */
function readRendererHeapSnapshot(): RendererHeapSnapshot | undefined {
  if (typeof performance === "undefined") {
    return undefined;
  }
  const memory = (performance as Performance & { memory?: RendererHeapSnapshot }).memory;
  if (!memory || typeof memory.usedJSHeapSize !== "number") {
    return undefined;
  }
  return memory;
}

interface StartMemoryDiagnosticsLoggerOptions {
  intervalMs?: number;
  now?: () => number;
  readHeap?: () => RendererHeapSnapshot | undefined;
  write?: (line: string) => void;
  registry?: MemoryDiagnosticsRegistry;
  /**
   * The resource telemetry sink: besides writing the local diagnostics log, the same reading is
   * also sent through the preload bridge to main as a `renderer_main` role event. The App injects
   * `platform.reportRendererHeapSample`; the Web side and phone remote control have no bridge, so
   * with nothing injected it is a no-op.
   */
  reportHeapSample?: (sample: RendererHeapSample) => void;
}

interface MemoryDiagnosticsLoggerHandle {
  sampleNow(): boolean;
  stop(): void;
}

export function startMemoryDiagnosticsLogger(
  options: StartMemoryDiagnosticsLoggerOptions = {},
): MemoryDiagnosticsLoggerHandle {
  const now = options.now ?? (() => Date.now());
  const readHeap = options.readHeap ?? readRendererHeapSnapshot;
  const write = options.write ?? logMemoryDiagnostics;
  const registry = options.registry ?? uiMemoryDiagnosticsRegistry;
  const reportHeapSample = options.reportHeapSample;
  const gate = createMemorySampleWriteGate();

  const sampleNow = (): boolean => {
    try {
      const heap = readHeap();
      const heapUsedKb = heap ? Math.round(heap.usedJSHeapSize! / 1024) : undefined;
      // After reading, it is handed over to resource telemetry first: ARMS requires a complete 60-second sequence, and the local log is only written when there are changes.
      // Two exits cannot share the same gating conclusion; counter acquisition and formatting should not drag away this heap sample.
      if (heapUsedKb !== undefined) {
        try {
          reportHeapSample?.({ heapUsedKb });
        } catch {
          // If the bridge fails, only this telemetry sample will be lost, and local diagnostic logs and rendering will not be affected.
        }
      }
      const sample: MemorySample = {
        role: "renderer",
        counters: registry.collect(),
      };
      if (heap) {
        sample.heapUsedKb = heapUsedKb;
        if (typeof heap.totalJSHeapSize === "number") {
          sample.heapTotalKb = Math.round(heap.totalJSHeapSize / 1024);
        }
      }
      const reason = gate.evaluate(sample, now());
      if (!reason) {
        return false;
      }
      write(formatMemorySampleLine(sample, reason));
      return true;
    } catch {
      // If diagnostic sampling fails, only the current sample will be lost and rendering will not be affected.
      return false;
    }
  };

  let handle: ReturnType<typeof setInterval> | undefined = setInterval(
    sampleNow,
    options.intervalMs ?? MEMORY_SAMPLE_INTERVAL_MS,
  );

  return {
    sampleNow,
    stop() {
      if (handle === undefined) {
        return;
      }
      clearInterval(handle);
      handle = undefined;
    },
  };
}
