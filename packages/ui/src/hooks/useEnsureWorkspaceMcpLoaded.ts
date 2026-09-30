import { useEffect } from "react";
import { useServices } from "@/hooks/useServices.js";
import { setMcpStoreDirectoryService, useMcpStore } from "@/store/mcpStore.js";

export function useEnsureWorkspaceMcpLoaded(
  workspaceAbsPath: string,
  workspaceIdentity: string | undefined,
  rpcReady: boolean,
) {
  const services = useServices();

  useEffect(() => {
    if (!rpcReady) {
      return;
    }
    setMcpStoreDirectoryService(services.mcpSyncService);
    return () => {
      setMcpStoreDirectoryService(null);
    };
  }, [rpcReady, services.mcpSyncService]);

  useEffect(() => {
    if (!rpcReady) {
      // While a remote tab is restoring, the App first gets a disconnected proxy; reading the MCP
      // directory right away would only swallow the disconnection error inside the store without honoring the workspace
      // RPC isolation boundary. Wait until the real services are registered before running — no caching and no cross-transport replay.
      return;
    }
    void useMcpStore
      .getState()
      .ensureLoadedForWorkspace(workspaceAbsPath, services.mcpSyncService, workspaceIdentity);
  }, [rpcReady, services.mcpSyncService, workspaceAbsPath, workspaceIdentity]);
}
