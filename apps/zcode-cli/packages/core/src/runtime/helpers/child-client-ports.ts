// ============================================================
// The "external interaction" port derivation of the child runtime (the only exit)
// ============================================================
//
// The child runtime has two session identity axes:
//   Ledger identity sessionId - event persistence / transcript / trace / session store, use your own;
//   Routing identity - all agent → app reverse requests (permission, AskUserQuestion, provider
//                        runtime headers), the child must use the parent's, up to the root session.
// The client only knows the root session; when asking about the sub-session, the session cannot be found on the desktop side, the response is never sent, and the sub-agent hangs.
//
// In the past, this rule was scattered in various child assembly points: core's subagent included two layers of private wrappers, dwf actor and legacy
// The workflow child directly transparently transmits the port of appOptions - so two things are wrong and one is right. Here the derivation is converged into one place, and is given by
// **Parent runtime** calls (`AgentRuntime.createChildClientPorts`), `parentSessionId` is filled in by the parent itself,
// The caller cannot give the wrong value.

import type { PermissionBrokerPort, SessionId } from "../deps.js";
import type { ProviderRuntimeHeadersPort } from "../types.js";
import type { SubagentInteractionOriginContext } from "../../subagent/interaction-origin.js";
import { createSubagentInteractionBroker } from "./subagent-interaction-broker.js";

/** The set of ports one runtime exposes to protocol clients. */
export interface ClientFacingPorts {
  permissionBroker?: PermissionBrokerPort;
  providerRuntimeHeadersPort?: ProviderRuntimeHeadersPort;
}

/**
 * The ownership information needed to mint a child. `parentSessionId` is not here -- it can only be supplied by the parent runtime,
 * which is the mechanical guarantee against "picking the wrong routing identity".
 */
export type ChildClientPortsContext = Omit<SubagentInteractionOriginContext, "parentSessionId">;

/**
 * Derives the child's outward-facing ports from the parent's.
 *
 * - `providerRuntimeHeadersPort`: wrapped in a layer that rewrites the incoming `sessionId` to the parent session (the main runtime reports its own
 *   session, see methods/model-runtime-headers.ts). With nested layers **the outer one writes last** (the layer closest to the client runs last), so the
 *   final value is necessarily the root session.
 * - `permissionBroker`: wrapped in a layer that rewrites `request.sessionId`, again with the outer one writing last; `origin` instead keeps the innermost value that
 *   is already there, so the subagent's ownership is not erased by an outer layer.
 */
export function deriveChildClientPorts(
  parent: ClientFacingPorts,
  context: ChildClientPortsContext & { parentSessionId: SessionId },
): ClientFacingPorts {
  return {
    ...(parent.permissionBroker === undefined
      ? {}
      : { permissionBroker: createSubagentInteractionBroker(parent.permissionBroker, context) }),
    ...(parent.providerRuntimeHeadersPort === undefined
      ? {}
      : {
          providerRuntimeHeadersPort: rerouteProviderRuntimeHeadersPort(
            parent.providerRuntimeHeadersPort,
            context.parentSessionId,
          ),
        }),
  };
}

/**
 * Provider runtime headers are an independent reverse protocol request and do not go through the child event mirror; the child session's sessionId is only
 * an internal CLI ledger entry, and the desktop subscribes only to the parent task's session, so refreshing account-credential headers must be routed through the parent session. The service layer
 * recognizes whether the requested model matches the parent session's current model, and when it does not, it only syncs this header round without switching the parent session to the child model.
 */
function rerouteProviderRuntimeHeadersPort(
  parentPort: ProviderRuntimeHeadersPort,
  parentSessionId: SessionId,
): ProviderRuntimeHeadersPort {
  return {
    shouldRefreshBeforeModelRequest(input) {
      return parentPort.shouldRefreshBeforeModelRequest?.(input) ?? true;
    },
    refreshBeforeModelRequest(input) {
      return parentPort.refreshBeforeModelRequest({ ...input, sessionId: parentSessionId });
    },
  };
}
