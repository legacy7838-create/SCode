import {
  zcodeProviderUpdateAccountConfigParamsSchema,
  type ZCodeProviderUpdateAccountConfigResult,
} from "@zcode/shared";
import { parseProcessAccountProviderConfigSnapshot } from "../app/process-provider-registry-runtime.js";
import {
  parseParams,
  ProtocolRequestError,
  type ZCodeProtocolAgentServerContext,
} from "./server-types.js";

/**
 * Updates the process-level Account Provider Config.
 *
 * The protocol carries the Account Overlay and the corresponding state; API Key, JWT and dynamic headers are handled by the request-time authentication protocol.
 */
export async function updateAccountProviderConfig(
  context: ZCodeProtocolAgentServerContext,
  params: unknown,
): Promise<ZCodeProviderUpdateAccountConfigResult> {
  const envelope = parseParams(zcodeProviderUpdateAccountConfigParamsSchema, params);
  const snapshot = parseProcessAccountProviderConfigSnapshot(envelope);
  if (!context.deps.syncAccountProviderConfig) {
    throw new ProtocolRequestError(-32018, "Account Provider Config runtime is not configured");
  }
  const changed = await context.deps.syncAccountProviderConfig(snapshot);
  return {
    receivedRevision: snapshot.revision,
    providerCount: snapshot.providers.keys().length,
    status: changed ? "received" : "unchanged",
  };
}
