import { zcodeWorkspaceUpdateModelIoPreferencesParamsSchema } from "@zcode/shared";
import { parseParams, type ZCodeProtocolAgentServerContext } from "./server-types.js";

/**
 * The ModelIO disk-writing policy is an app-wide preference, but every resident session holds its own adapter. The protocol layer therefore both
 * caches the preference for future sessions to inherit and updates the existing sessions immediately, so old and new tasks never behave divergently.
 */
export async function updateModelIoPreferences(
  context: ZCodeProtocolAgentServerContext,
  rawParams: unknown,
) {
  const params = parseParams(zcodeWorkspaceUpdateModelIoPreferencesParamsSchema, rawParams);
  const enabled = params.preferences.fullRetentionEnabled;
  context.appRuntimePreferences.modelIoFullRetentionEnabled = enabled;

  let updatedSessionCount = 0;
  for (const record of context.sessions.values()) {
    if (!record.app.setModelIoFullRetentionEnabled) continue;
    record.app.setModelIoFullRetentionEnabled(enabled);
    updatedSessionCount += 1;
  }

  return {
    workspace: params.workspace,
    fullRetentionEnabled: enabled,
    updatedSessionCount,
  };
}
