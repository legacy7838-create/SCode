import { randomUUID } from "node:crypto";
import {
  zcodeProtocolMethods,
  zcodeProtocolNotifications,
  zcodeProviderRuntimeHeadersResponseSchema,
  type ZCodeWorkspaceRef,
} from "@zcode/shared";
import type { ZCodeAppOptions } from "../app/types.js";
import {
  ProtocolRequestError,
  protocolTraceFromTraceContext,
  type ZCodeProtocolAgentServerContext,
} from "./server-types.js";

// The SDK timeout of the UI will not start when there is no responder; the total port timeout covers both queuing and credential resolution.
const PROVIDER_RUNTIME_HEADERS_TIMEOUT_MS = 180_000;
const CLIENT_REQUEST_TIMEOUT_CODE = -32022;

export function createProviderRuntimeHeadersPort(
  context: ZCodeProtocolAgentServerContext,
  workspace: ZCodeWorkspaceRef,
): NonNullable<ZCodeAppOptions["providerRuntimeHeadersPort"]> {
  return {
    shouldRefreshBeforeModelRequest() {
      // Account requests are determined by the bound Model whether to enter authentication, and all accounts cannot be narrowed down to the old Start ID.
      // Ordinary APIs do not enter this port; Team/Individual continues to reuse the request-level authentication contract.
      return true;
    },
    async refreshBeforeModelRequest(input) {
      const requestId = `${input.sessionId}:provider-runtime-headers:${randomUUID()}`;
      let result;
      try {
        result = await context.requestClient(
          zcodeProtocolMethods.interactionRequestProviderRuntimeHeaders,
          {
            // Concurrent requests within the same millisecond cannot share the association key, otherwise the pending responses will be overwritten or used in series.
            requestId,
            sessionId: input.sessionId,
            turnId: input.turnId,
            workspace,
            modelSelection: { providerId: input.providerId, modelId: input.modelId },
            providerId: input.providerId,
            ...(input.accountAccess ? { accountAccess: input.accountAccess } : {}),
            reason: input.reason,
          },
          zcodeProviderRuntimeHeadersResponseSchema,
          {
            signal: input.abortSignal,
            trace: protocolTraceFromTraceContext(input.traceContext),
            timeoutMs: PROVIDER_RUNTIME_HEADERS_TIMEOUT_MS,
          },
        );
      } catch (error) {
        // requestClient abort only clears the CLI wait, and the Host still occupies the credential resolution queue until timeout.
        // Cancellation is sent only on this port and does not change the life cycle of other reverse RPCs.
        const timedOut =
          error instanceof ProtocolRequestError && error.code === CLIENT_REQUEST_TIMEOUT_CODE;
        // Both total timeout and active stopping must release the Host; otherwise the CLI has failed and old requests will still occupy the queue.
        if (input.abortSignal?.aborted || timedOut) {
          context.notify({
            method: zcodeProtocolNotifications.providerRuntimeHeadersCancelled,
            trace: protocolTraceFromTraceContext(input.traceContext),
            params: { workspace, sessionId: input.sessionId, requestId },
          });
        }
        if (timedOut) {
          const timeoutError = new ProtocolRequestError(
            CLIENT_REQUEST_TIMEOUT_CODE,
            "Provider runtime headers request timed out. Please send your message again.",
            error.data,
          );
          timeoutError.cause = error;
          throw timeoutError;
        }
        throw error;
      }
      if (!result.headersApplied) {
        // Runtime header refresh failure may result from configuration read failure or missing credentials;
        // It cannot be rewritten uniformly into a single failure copy, otherwise it will cover up the true root cause and mislead the retry strategy.
        throw new ProtocolRequestError(
          -32031,
          result.errorMessage ??
            "Provider runtime headers were not applied before model request attempt.",
          {
            providerId: input.providerId,
            reason: input.reason,
            workspaceKey: workspace.workspaceKey,
          },
        );
      }
      // The account authentication material of zcode-plan is a runtime configuration that is refreshed every time it is requested.
      // However, provider registry revision is a workspace-level global state; during concurrent refresh, the latter request will advance the global revision.
      // Global revision inequality can no longer be used to misjudge that the headers of the current request are not applied.
      return result;
    },
  };
}
