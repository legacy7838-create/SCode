import type { Event } from "@zcode/rpc";
import type { ConversationTelemetryFact } from "@zcode/shared/zcode-protocol-v4";
import type { IZCodeAgentService } from "#src/zcode-agent/zcodeAgent.js";

export interface ConversationTelemetryWorkspaceTarget {
  workspacePath: string;
  workspaceIdentity?: string;
}

/**
 * Workspace-level read-only service surface for conversation telemetry. It only wraps the
 * connection-scoped agent service after clientMode authorization has completed; it opens no
 * additional RPC channel and never lets Web/mobile bypass the desktop-continuous gate.
 */
export interface IConversationTelemetryService {
  onFact(target: ConversationTelemetryWorkspaceTarget): Event<ConversationTelemetryFact>;
}

export function createConversationTelemetryService(
  zcodeAgentService: Pick<IZCodeAgentService, "onDynamicConversationTelemetryFact">,
): IConversationTelemetryService {
  return {
    onFact: (target) =>
      // RPC Events with workspace parameters must be named onDynamic*.
      // Otherwise ProxyChannel will treat it as a normal Event and mistake the target as a listener.
      zcodeAgentService.onDynamicConversationTelemetryFact(target),
  };
}
