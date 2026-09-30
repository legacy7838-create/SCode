import { zcodeWorkspaceUpdateDynamicWorkflowPolicyParamsSchema } from "@zcode/shared";
import { parseParams, type ZCodeProtocolAgentServerContext } from "./server-types.js";

/**
 * The dynamic-workflow rollout gate. The Host holds the decision:
 * it reads `dynamicWorkflow.mode` from `/client/configs`; the CLI only caches the conclusion and never reads a feature key
 * or a local-override environment variable. Isomorphic to off-peak-tool-policy.ts: CLI processes are isolated per workspace,
 * so caching one copy is enough; createRecord reads it uniformly for legacy create/resume, v4 createSession, and v4 cold resume
 * (subscribe → resumePersistedSession, which has no host argument channel).
 * It only affects records created/resumed afterwards; the tool surface of already-active records is not reclaimed (mid-rollout flips stay consistent).
 */
export async function updateDynamicWorkflowPolicy(
  context: ZCodeProtocolAgentServerContext,
  rawParams: unknown,
) {
  const params = parseParams(zcodeWorkspaceUpdateDynamicWorkflowPolicyParamsSchema, rawParams);
  context.appRuntimePreferences.dynamicWorkflowEnabled = params.enabled;
  return { workspace: params.workspace, enabled: params.enabled };
}
