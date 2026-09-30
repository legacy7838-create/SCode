import { useEffect, useState } from "react";
import { useWorkspaceServices } from "@/hooks/useWorkspaceServices.js";
import { formatWorkspaceContextPath } from "@/WorkspaceHeaderSections/workspaceContextPathFormat.js";

export function WorkspaceContextPath({
  workspacePath,
  workspaceIdentity,
  remoteSessionId,
}: {
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
}) {
  const { systemService } = useWorkspaceServices(workspacePath, remoteSessionId, workspaceIdentity);
  const [home, setHome] = useState<{ service: typeof systemService; path: string } | null>(null);
  useEffect(() => {
    let disposed = false;
    // The path abbreviation must use the host information of the current workspace, and the local home cannot be applied to the remote path.
    void systemService.info().then(
      (info) => {
        if (!disposed) setHome({ service: systemService, path: info.homedir });
      },
      () => {},
    );
    return () => {
      disposed = true;
    };
  }, [systemService]);
  return (
    <span
      data-workspace-context-path=""
      className="min-w-0 break-words text-ui-sm font-normal text-foreground-subtle [overflow-wrap:anywhere]"
    >
      {formatWorkspaceContextPath(
        workspacePath,
        home?.service === systemService ? home.path : undefined,
      )}
    </span>
  );
}
