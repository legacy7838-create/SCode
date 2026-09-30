import type { IDisposable } from "@zcode/rpc";
import {
  createMemoryDiagnosticsRegistry,
  type MemoryDiagnosticsProvider,
  type MemoryDiagnosticsRegistry,
} from "@zcode/shared";

/**
 * Process-level memory diagnostics counter registry for services.
 *
 * Each service factory registers a read-only provider when it is created and unregisters on
 * disposeAll; the Host collects once every 60 seconds and writes a local log. It is kept off the
 * service interfaces so that diagnostics methods are not exposed on the RPC channel.
 */
export const memoryDiagnosticsRegistry: MemoryDiagnosticsRegistry =
  createMemoryDiagnosticsRegistry();

export function registerMemoryDiagnosticsProvider(
  name: string,
  provider: MemoryDiagnosticsProvider,
): IDisposable {
  return memoryDiagnosticsRegistry.register(name, provider);
}

export function collectServiceMemoryDiagnostics(): Record<string, number> {
  return memoryDiagnosticsRegistry.collect();
}
