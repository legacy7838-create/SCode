import type {
  PermissionBrokerPort,
  PermissionBrokerRequest,
  PermissionBrokerRequestOptions,
  PermissionBrokerResult,
} from "../deps.js";
import { buildSubagentInteractionOrigin } from "@zcode/rust/subagent-profile";
import type {
  InteractionRequestOrigin,
  SessionId,
  ToolCallId,
  TurnId,
} from "@zcode/contracts";

/**
 * The branded ids stay here; the Rust boundary takes and returns plain strings. The cast
 * on the result is safe because `build_interaction_origin` builds the same fields from
 * the same inputs — and the mirror's own `permission_requested` origin is checked against
 * the TypeScript implementation by `subagent-mirror-golden.json`.
 */
export interface SubagentInteractionBrokerContext {
  agentId: string;
  agentType: string;
  childSessionId: SessionId;
  description: string;
  parentSessionId: SessionId;
  parentToolCallId?: ToolCallId | string;
  parentTurnId?: TurnId;
}

export function createSubagentInteractionBroker(
  parentBroker: PermissionBrokerPort,
  context: SubagentInteractionBrokerContext,
): PermissionBrokerPort {
  return {
    requestPermission(
      request: PermissionBrokerRequest,
      options?: PermissionBrokerRequestOptions,
    ): Promise<PermissionBrokerResult> {
      // The child agent's permission / AskUserQuestion / ExitPlanMode all require the UI response of the parent task;
      // The broker request is externally routed to the parent session, and the origin retains the child ownership, which facilitates UI and log identification of the source.
      //
      // This package can be stacked. `sessionId` is determined by the **outer layer** (the layer closer to the client)
      // Finally rewritten, so any depth will eventually fall to the root session; `origin` in turn retains the existing values ​​in the inner layer,
      // The attribution is always the sub-agent that actually initiated the request and will not be covered by the outer layer into an intermediate layer.
      return parentBroker.requestPermission(
        {
          ...request,
          sessionId: context.parentSessionId,
          origin:
            request.origin ??
            (buildSubagentInteractionOrigin(
              {
                ...context,
                background: false,
                parentToolCallId: context.parentToolCallId as string | undefined,
                parentTurnId: context.parentTurnId as string | undefined,
              },
              request.turnId as string | undefined,
            ) as InteractionRequestOrigin),
        },
        options,
      );
    },
  };
}
