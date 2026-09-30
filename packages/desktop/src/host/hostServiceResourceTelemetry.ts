import { registerHostToolExecResourceTelemetry } from "./hostToolExecResourceTelemetry.js";
import { registerHostMcpResourceTelemetry } from "./hostMcpResourceTelemetry.js";
import type { IDisposable } from "@zcode/rpc";
import { IZCodeAgentService, type ServiceCollection } from "@zcode/services";
import type { ProcessResourceRuntimeSurface } from "@zcode/shared";
import { registerHostAgentResourceTelemetry } from "./hostAgentResourceTelemetry.js";
import { registerHostMcpTelemetry } from "./hostMcpTelemetry.js";

interface RegisterHostServiceResourceTelemetryOptions {
  services: Pick<ServiceCollection, "getOptional">;
  postMessage(message: unknown): void;
  runtimeSurface: ProcessResourceRuntimeSurface;
  /** Standalone servers must explicitly declare support; local and supporting remote deployments support it by default. */
  telemetrySupported?: boolean;
  /** The hashed running environment identity of Host is only transparently transmitted to the resource group of main and does not enter ARMS. */
  environmentKey?: string;
  onError?(error: unknown): void;
}

const NO_TELEMETRY: IDisposable = { dispose() {} };

function disposeAll(registrations: IDisposable[]): void {
  while (registrations.length > 0) {
    try {
      registrations.pop()?.dispose();
    } catch {
      // Failure to release a single subscription cannot block other subscriptions, otherwise the listener will remain when the connection is closed.
    }
  }
}

/**
 * The resource telemetry subscription for one service collection. Forwards CLI self-sampled
 * resource samples, MCP process-tree resource samples, Bash slow-command completion facts, and
 * MCP lifecycle telemetry.
 *
 * Local host services and each remote workspace connection call this once, with the caller
 * supplying `runtimeSurface`: a CLI on this machine is local, a CLI on a remote zcode-server is
 * remote, and the hardware dimensions self-reported by a sample are overridden by main with the
 * global defaults. The subscription lives exactly as long as that collection; when a remote
 * connection is released the handle calls `dispose()`, leaving no listeners behind. Multiple
 * dedicated connections to the same remote machine produce multiple subscriptions; main merges
 * the latest CLI/MCP readings per environment and instance, and dedupes Bash completion facts
 * by completionToken, so multiple connections or windows never double-count.
 *
 * Attachments (desktop renderer / phone remote control) are not an entry point here: an
 * attachment only reuses an already-ready collection, and these events are confined to the
 * trusted host relay within the Agent connection scope, never reaching the session message plane.
 */
export function registerHostServiceResourceTelemetry(
  options: RegisterHostServiceResourceTelemetryOptions,
): IDisposable {
  // The unknown event exception of the old server occurs in the peer's asynchronous read loop, and the following local try/catch cannot protect it;
  // Therefore, when capabilities are lacking, you must exit before obtaining services and sending any EventListen.
  if (options.telemetrySupported === false) {
    return NO_TELEMETRY;
  }
  const agentService = options.services.getOptional(IZCodeAgentService);
  if (!agentService) {
    return NO_TELEMETRY;
  }
  const registrations: IDisposable[] = [];
  try {
    registrations.push(
      registerHostAgentResourceTelemetry({
        agentService,
        postMessage: options.postMessage,
        runtimeSurface: options.runtimeSurface,
        environmentKey: options.environmentKey,
      }),
    );
    registrations.push(
      registerHostMcpTelemetry({
        agentService,
        postMessage: options.postMessage,
        runtimeSurface: options.runtimeSurface,
      }),
    );
    registrations.push(
      registerHostMcpResourceTelemetry({
        agentService,
        postMessage: options.postMessage,
        runtimeSurface: options.runtimeSurface,
        environmentKey: options.environmentKey,
      }),
    );
    registrations.push(
      registerHostToolExecResourceTelemetry({
        agentService,
        postMessage: options.postMessage,
        runtimeSurface: options.runtimeSurface,
      }),
    );
  } catch (error) {
    // Telemetry subscription failure cannot change the Host service initialization or remote connection results, nor can it leave half of the link.
    disposeAll(registrations);
    options.onError?.(error);
    return NO_TELEMETRY;
  }
  let disposed = false;
  return {
    dispose() {
      if (disposed) {
        return;
      }
      disposed = true;
      disposeAll(registrations);
    },
  };
}
