import { useCallback, useLayoutEffect, useRef } from "react";
import type { WorkspaceMainView } from "@/app-shell/types.js";

export function useWorkspaceMainViewSettingsExit({
  isWorkspaceVisible,
  workspaceMainView,
  onExitSettings,
}: {
  isWorkspaceVisible: boolean;
  workspaceMainView: WorkspaceMainView;
  onExitSettings: () => void;
}) {
  const wasWorkspaceVisibleRef = useRef(isWorkspaceVisible);
  const settingsEntryMainViewRef = useRef(workspaceMainView);
  const preserveNextSettingsExitRef = useRef(false);

  const preserveNextSettingsExit = useCallback(() => {
    if (!wasWorkspaceVisibleRef.current) {
      preserveNextSettingsExitRef.current = true;
    }
  }, []);

  useLayoutEffect(() => {
    const wasWorkspaceVisible = wasWorkspaceVisibleRef.current;
    wasWorkspaceVisibleRef.current = isWorkspaceVisible;

    if (wasWorkspaceVisible && !isWorkspaceVisible) {
      settingsEntryMainViewRef.current = workspaceMainView;
      preserveNextSettingsExitRef.current = false;
      return;
    }

    if (!wasWorkspaceVisible && isWorkspaceVisible) {
      if (preserveNextSettingsExitRef.current) {
        // When the plug-in market has been opened, click "New" again from the settings page, and the main view value is still
        // plugin-store, it is impossible to identify this as an explicit navigation based on the before and after values alone. Consume this one-time token,
        // Prevent the setup exit process from closing the market incorrectly; the flag only allows writing when the setup layer is open.
        preserveNextSettingsExitRef.current = false;
        return;
      }

      if (workspaceMainView === settingsEntryMainViewRef.current) {
        // Settings only covers the workspace, and the underlying App is not uninstalled.
        // The automations main view will always be retained. Return to the dialog when exiting the settings layer.
        // Let Back, plug-in prompts, create skills, and settings page shortcuts share the same navigation semantics.
        onExitSettings();
      }
    }
  }, [isWorkspaceVisible, onExitSettings, workspaceMainView]);

  return { preserveNextSettingsExit };
}
