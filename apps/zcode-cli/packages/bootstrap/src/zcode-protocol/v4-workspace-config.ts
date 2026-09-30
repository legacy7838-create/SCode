// v4 workspace-config only hosts workspace presentation; model candidates and preferences are determined by the target Host
// Provided by ModelSelectionView, a second model directory cannot be created reversely from live Session settings.
import { getZCodeAgentModeSelectOptions, normalizeAvailableZCodeMode } from "@zcode/shared";
import type { ZCodeSessionSettingsState, ZCodeSlashCommand } from "@zcode/shared";
import type { WorkspaceConfigState } from "@zcode/shared/zcode-protocol-v4";
import { mapSessionSettings } from "./mapper.js";
import { listProtocolSlashCommands } from "./slash-commands.js";
import type { ZCodeProtocolAgentServerContext } from "./server-types.js";

/** Session settings project only the non-model workspace mode and slash commands. */
function toV4WorkspaceConfigState(
  settings: ZCodeSessionSettingsState,
  slashCommands: readonly ZCodeSlashCommand[],
): WorkspaceConfigState {
  return {
    configOptions: [
      {
        id: "mode",
        name: "Mode",
        category: "mode",
        type: "select",
        currentValue: normalizeAvailableZCodeMode(settings.mode.current),
        options: getZCodeAgentModeSelectOptions(),
      },
    ],
    slashCommands: slashCommands.map((command) => ({
      name: command.name,
      description: command.description,
      ...(command.inputHint !== undefined ? { inputHint: command.inputHint } : {}),
      ...(command.source !== undefined ? { source: command.source } : {}),
    })),
  };
}

/**
 * The seed taken on subscribe: it only takes the live-session fast path (mapSessionSettings reads the
 * registered app directly).
 * A temporary app is deliberately not created — the host's startup warm-up reads the workspace
 * presentation early, which would create a temporary app when there is no active session and would
 * then have the MCP close drag the protocol channel down with it (see the comment on desktop
 * warmUpZCodeAgent).
 * Returns null when no session is registered (an empty catalog seed); the model selection catalog is
 * provided by the Host's own process Registry View, and this session protocol publishes task-level
 * configuration only once a live session exists.
 */
export async function buildLiveWorkspaceConfigStateV4(
  context: ZCodeProtocolAgentServerContext,
  workspaceId: string,
): Promise<WorkspaceConfigState | null> {
  const record = Array.from(context.sessions.values()).find(
    (candidate) => candidate.workspace.workspaceKey === workspaceId,
  );
  if (!record) return null;
  const settings = await mapSessionSettings(record.app);
  const slashCommands = await listProtocolSlashCommands({
    // The gray gate is the workspace-level fact determined by the Host, and the directory is equipped with a read process cache.
    dynamicWorkflowEnabled: context.appRuntimePreferences.dynamicWorkflowEnabled,
    env: context.deps.env,
    logger: context.logger,
    workingDirectory: record.workspace.workspacePath,
  });
  return toV4WorkspaceConfigState(settings, slashCommands);
}
