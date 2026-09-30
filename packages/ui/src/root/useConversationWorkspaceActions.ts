import { useCallback } from "react";
import type { IServiceAccessor } from "@zcode/services";
import { logger } from "@/logger.js";
import type { TabStoreState } from "@/store/tabStore.js";
import { useZCodeSessionStore } from "@/store/zcodeSessionStore.js";
import { usePaneLayoutStore } from "@/v4/paneLayoutStore.js";
import { useWorkbenchGroupStore } from "@/v4/workbenchGroupStore.js";

export function useConversationWorkspaceActions({
  services,
  addTab,
  setWorkspaceActionError,
}: {
  services: IServiceAccessor;
  addTab: TabStoreState["addTab"];
  setWorkspaceActionError: (error: string | null) => void;
}) {
  const handleSelectConversationWorkspace = useCallback(
    (path: string) => {
      // The conversation workspace is a shared cwd managed by the app and does not belong to the user project: no cross-window project activation is required.
      // Don't write recentProjects, just use purpose to let the presentation layer classify it as "conversation".
      logger.info("[Root] select conversation workspace", { path });
      addTab(path, { workspacePurpose: "conversation" });
      setWorkspaceActionError(null);
    },
    [addTab, setWorkspaceActionError],
  );

  const handleResolveConversationWorkspace = useCallback(async () => {
    try {
      const result = await services.fileService.ensureConversationWorkspace();
      setWorkspaceActionError(null);
      return result.path;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error("[Root] ensure conversation workspace failed", { error });
      setWorkspaceActionError(message);
      throw error;
    }
  }, [services.fileService, setWorkspaceActionError]);

  const handleEnsureConversationWorkspace = useCallback(async () => {
    const path = await handleResolveConversationWorkspace();
    handleSelectConversationWorkspace(path);
    return path;
  }, [handleResolveConversationWorkspace, handleSelectConversationWorkspace]);

  const handleCreateConversationTask = useCallback(async () => {
    try {
      const path = await handleResolveConversationWorkspace();
      handleSelectConversationWorkspace(path);
      // "Conversation+" is an explicit target and should not be overridden by the current split pane / workbench group's project bindings.
      useWorkbenchGroupStore.getState().deactivateActiveGroup();
      usePaneLayoutStore.getState().resetToPrimaryPane();
      useZCodeSessionStore.getState().startDraft(path);
    } catch {
      // handleResolveConversationWorkspace The error was logged and the current workspace is retained.
    }
  }, [handleResolveConversationWorkspace, handleSelectConversationWorkspace]);

  return {
    handleSelectConversationWorkspace,
    handleResolveConversationWorkspace,
    handleEnsureConversationWorkspace,
    handleCreateConversationTask,
  };
}
