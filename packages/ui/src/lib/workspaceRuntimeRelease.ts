import type { IZCodeTaskService } from "@zcode/services";
import type { WorkspaceTabState } from "@/store/tabStore.js";
import { logger } from "@/logger.js";

export function releaseWorkspaceRuntimeAfterProjectRemoval({
  tab,
  zcodeTaskService,
}: {
  tab: Pick<WorkspaceTabState, "workspacePath" | "workspaceIdentity">;
  zcodeTaskService: Pick<IZCodeTaskService, "releaseWorkspacePreparation">;
}): void {
  const workspaceIdentity = tab.workspaceIdentity?.trim() || undefined;
  void zcodeTaskService
    .releaseWorkspacePreparation({
      workspacePath: tab.workspacePath,
      ...(workspaceIdentity ? { workspaceIdentity } : {}),
    })
    .catch((error: unknown) => {
      // Windows will treat the Agent/terminal subprocess cwd as directory occupation; removing the project must actively release the runtime.
      // If the release fails, the UI removal cannot be rolled back. Only the workspace key is recorded to facilitate locating the remaining processes.
      logger.error("[WorkspaceSidebarItem] failed to release runtime after removing workspace", {
        workspaceKey: workspaceIdentity ?? tab.workspacePath,
        error,
      });
    });
}
