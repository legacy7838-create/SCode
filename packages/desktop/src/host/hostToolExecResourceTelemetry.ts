import type { IDisposable } from "@zcode/rpc";
import type { IZCodeAgentService } from "@zcode/services";
import { HostResponseTypes, type ProcessResourceRuntimeSurface } from "@zcode/shared";

export function registerHostToolExecResourceTelemetry(options: {
  agentService: Pick<IZCodeAgentService, "onDynamicToolExecResource">;
  postMessage(message: unknown): void;
  runtimeSurface: ProcessResourceRuntimeSurface;
}): IDisposable {
  return options.agentService.onDynamicToolExecResource()((sample) => {
    try {
      options.postMessage({
        type: HostResponseTypes.ToolExecResource,
        runtimeSurface: options.runtimeSurface,
        sample,
      });
    } catch {
      // When main exits or the channel is closed, only the current completion fact is lost and does not affect the Bash life cycle.
    }
  });
}
