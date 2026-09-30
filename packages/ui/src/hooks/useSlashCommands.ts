/**
 * Convenience hook for ZCode Agent slash commands
 *
 * Returns the list of available slash commands broadcast by the Agent in the current workspace.
 */
import { useZCodeSessionStore, selectWorkspaceZCodeState } from "../store/zcodeSessionStore.js";

export function useSlashCommands(workspacePath: string, workspaceIdentity?: string) {
  return useZCodeSessionStore(
    (state) => selectWorkspaceZCodeState(state, workspacePath, workspaceIdentity).slashCommands,
  );
}
