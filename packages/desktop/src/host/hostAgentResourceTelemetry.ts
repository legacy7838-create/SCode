import type { IDisposable } from "@zcode/rpc";
import type { IZCodeAgentService } from "@zcode/services";
import type { ProcessResourceRuntimeSurface } from "@zcode/shared";
import { HostResponseTypes } from "@zcode/shared";

interface RegisterHostAgentResourceTelemetryOptions {
  agentService: Pick<IZCodeAgentService, "onDynamicProcessResourceSample">;
  postMessage(message: unknown): void;
  runtimeSurface: ProcessResourceRuntimeSurface;
  environmentKey?: string;
}

/**
 * Host-side forwarding of CLI resource samples.
 *
 * The host is a pure pass-through: services already tag each sample's lane when parsing the
 * protocol notification, based on the process manager that owns it, and the newer fields
 * (heap / uptime / host machine memory / instanceToken) are forwarded to main verbatim.
 * Main decides role attribution and aggregation. The host does no statistics and holds no window.
 */
export function registerHostAgentResourceTelemetry(
  options: RegisterHostAgentResourceTelemetryOptions,
): IDisposable {
  return options.agentService.onDynamicProcessResourceSample()((sample) => {
    try {
      options.postMessage({
        type: HostResponseTypes.AgentResourceSample,
        runtimeSurface: options.runtimeSurface,
        ...(options.environmentKey === undefined ? {} : { environmentKey: options.environmentKey }),
        sample,
      });
    } catch {
      // When main has exited or IPC is unavailable, only the current sample will be lost, and it is prohibited to affect Agent service notification distribution.
    }
  });
}
