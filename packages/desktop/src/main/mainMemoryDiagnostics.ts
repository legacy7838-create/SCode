import { createMemoryDiagnosticsRegistry, type MemoryDiagnosticsRegistry } from "@zcode/shared";

/**
 * Memory diagnostics counter registry for the main process.
 * `index.ts` registers the provider after instantiating TaskRealtimeBus / BroadcastHub /
 * BrowserGuestManager; `desktopResourceTelemetry.ts` collects once every 60 seconds and writes to
 * the main log.
 */
export const mainMemoryDiagnosticsRegistry: MemoryDiagnosticsRegistry =
  createMemoryDiagnosticsRegistry();
