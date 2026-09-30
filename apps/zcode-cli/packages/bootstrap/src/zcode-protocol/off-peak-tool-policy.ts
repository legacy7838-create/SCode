import { zcodeWorkspaceUpdateOffPeakToolPolicyParamsSchema } from "@zcode/shared";
import { parseParams, type ZCodeProtocolAgentServerContext } from "./server-types.js";

/**
 * The Off-Peak tool surface gate (rollout enabled && local workspace) is a workspace-level fact. CLI processes are isolated per workspace,
 * so caching one copy is enough; createRecord reads it uniformly for legacy create/resume, v4 createSession and v4 cold recovery
 * (subscribe → resumePersistedSession, which has no host parameter channel).
 * It only affects records created/resumed afterwards; the tool surface of an already active record is not reclaimed (consistent with the mid-rollout flip policy).
 */
export async function updateOffPeakToolPolicy(
  context: ZCodeProtocolAgentServerContext,
  rawParams: unknown,
) {
  const params = parseParams(zcodeWorkspaceUpdateOffPeakToolPolicyParamsSchema, rawParams);
  context.appRuntimePreferences.offPeakToolEnabled = params.enabled;
  return { workspace: params.workspace, enabled: params.enabled };
}
