import type { ZCodeProvider } from "@zcode/shared";
import type { WorkspaceZCodeUIState } from "@/store/zcodeSessionStore.js";

interface ResolveWorkspaceSwitchDraftProviderOptions {
  currentSelectedProvider: ZCodeProvider;
  targetWorkspacePath: string;
  targetWorkspaceIdentity?: string;
  workspaces: Record<string, WorkspaceZCodeUIState | undefined>;
}

export function resolveWorkspaceSwitchDraftProvider({
  currentSelectedProvider,
  targetWorkspacePath,
  targetWorkspaceIdentity,
  workspaces,
}: ResolveWorkspaceSwitchDraftProviderOptions): ZCodeProvider {
  const workspaceKey = targetWorkspaceIdentity?.trim() || targetWorkspacePath;
  const targetWorkspaceState = workspaces[workspaceKey] ?? workspaces[targetWorkspacePath];

  // When creating a new draft directly after switching workspaces in an empty state, the "source workspace currently selected Agent" was always
  // Forcibly writing to the target workspace will cause the Agent just used by the target project to be overwritten.
  // Here, priority is given to the provider that has been remembered by the target workspace, and the current selection is only inherited when the target has not established UI state.
  return targetWorkspaceState?.selectedProvider ?? currentSelectedProvider;
}
