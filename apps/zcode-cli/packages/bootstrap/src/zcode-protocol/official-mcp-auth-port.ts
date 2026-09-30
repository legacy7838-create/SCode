/* The official MCP identity-header port on the agent side.
   The agent process is not the identity authority: it makes a reverse request to the host through interaction/requestOfficialMcpAuthHeaders,
   and the host resolves the current Coding Plan credential and returns the identity headers for this request. The credential never lands in the runtime config,
   is never persisted and never enters the logs. */
import {
  zcodeOfficialMcpAuthHeadersResponseSchema,
  zcodeProtocolMethods,
  type ZCodeWorkspaceRef,
} from "@zcode/shared";
import type { OfficialMcpAuthHeadersPort } from "@zcode/contracts";
import type { ZCodeProtocolAgentServerContext } from "./server-types.js";

let requestSequence = 0;

/** The port only needs the ability to issue reverse requests, not the whole server context. */
export type OfficialMcpAuthRequestContext = Pick<
  ZCodeProtocolAgentServerContext,
  "requestClient"
>;

/**
 * Builds the port that fetches identity headers through a reverse protocol request.
 *
 * `resolveContext` is lazy: the MCP connection pool is built earlier than the ZCodeProtocolAgentServer, and before
 * the server is ready it returns undefined, which is handled as unavailable (no downgrade to an anonymous request).
 *
 * Failures always go through the return value (ok:false + an enumerable reason) and never throw:
 * transport exceptions are uniformly mapped to official_auth_unavailable, and the MCP adapter marks that server as failed.
 *
 * What the workspace is for, and the known gap:
 * - the host side does **not** use it to route the response -- the response returns through `client.respond(request.id, ...)` on the
 *   stdio connection that made the request, and the routing is decided by that connection itself. The field is only request context / auditing;
 * - it must still honor the repository convention `workspaceKey = workspaceIdentity?.trim() || workspacePath`,
 *   otherwise remote workspaces at the same path with different identities cannot be told apart in the audit context;
 * - **remaining gap**: the CLI agent process currently has no source of workspaceIdentity
 *   (`RunZCodeProtocolAgentOptions` only has cwd/env/..., and there is no matching env var), so the field effectively
 *   degrades to workspacePath. What is guaranteed here is "an identity that is available is passed through correctly", not "an identity always exists".
 *   Should auditing later need the real remote identity, the identity has to be handed to the agent at spawn or in the protocol layer, which is out of scope for this stage.
 */
export function createOfficialMcpAuthHeadersPort(input: {
  resolveContext: () => OfficialMcpAuthRequestContext | undefined;
  resolveWorkspace: (input: {
    workspaceIdentity?: string;
    workspacePath?: string;
  }) => ZCodeWorkspaceRef | undefined;
}): OfficialMcpAuthHeadersPort {
  return {
    async resolveHeaders(request) {
      const context = input.resolveContext();
      const workspace = input.resolveWorkspace({
        ...(request.workspaceIdentity ? { workspaceIdentity: request.workspaceIdentity } : {}),
        ...(request.workspacePath ? { workspacePath: request.workspacePath } : {}),
      });
      if (!context || !workspace) {
        return { ok: false, reason: "official_auth_unavailable" };
      }
      requestSequence += 1;
      try {
        return await context.requestClient(
          zcodeProtocolMethods.interactionRequestOfficialMcpAuthHeaders,
          {
            mcpKey: request.mcpKey,
            pluginId: request.pluginId,
            requestId: `official-mcp-auth:${requestSequence}`,
            targetOrigin: request.targetOrigin,
            workspace,
          },
          zcodeOfficialMcpAuthHeadersResponseSchema,
          request.signal ? { signal: request.signal } : {},
        );
      } catch {
        // Host unreachable/protocol error: treated as unavailable. Error details are not brought out (may include request context),
        // Classification logs without secrets have been recorded on the host side.
        return { ok: false, reason: "official_auth_unavailable" };
      }
    },
  };
}
