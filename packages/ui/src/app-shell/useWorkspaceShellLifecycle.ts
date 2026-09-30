import { useEffect, useRef, type Dispatch, type SetStateAction } from "react";
import type { IServiceAccessor } from "@zcode/services";
import type { TaskChatMessage as TestChatMessage } from "@/lib/taskChatMessageTypes.js";
import type { BrowserNavigationRequest } from "@/hooks/useAppPanels.js";
import { logger } from "@/logger.js";
import {
  getWorkspaceDisplayedTaskState,
  getWorkspaceInitState,
  useZCodeSessionStore,
} from "@/store/zcodeSessionStore.js";

export function useWorkspaceShellLifecycle({
  workspaceAbsPath,
  workspaceIdentity,
  services,
  setBrowserNavigationRequest,
  setTestMessages,
}: {
  workspaceAbsPath: string;
  workspaceIdentity?: string;
  services: IServiceAccessor;
  setBrowserNavigationRequest: Dispatch<SetStateAction<BrowserNavigationRequest | null>>;
  setTestMessages: Dispatch<SetStateAction<TestChatMessage[] | null>>;
}) {
  const previousWorkspaceAbsPathRef = useRef(workspaceAbsPath);

  useEffect(() => {
    if (previousWorkspaceAbsPathRef.current === workspaceAbsPath) {
      return;
    }

    previousWorkspaceAbsPathRef.current = workspaceAbsPath;

    // Root previously relied on changing the key by pressing the workspacePath to "rebuild the entire app by cutting the workspace".
    // Although this clears the partial state, it will also unload the sidebar/TaskList together, causing the entire column to flicker when switching tasks.
    // Now after changing to retain the same App instance, only the state that is truly strongly bound to the old workspace is explicitly cleared.
    // Avoid stringing code preview or test coverage messages from the previous project into the new project.
    // The side pane now performs memory recovery by workspaceIdentity/workspacePath.
    // Here you can no longer clear Git/source or tabs based on workspacePath changes, otherwise the cache will be overwritten when switching back across workspaces.
    setBrowserNavigationRequest(null);
    setTestMessages(null);
  }, [setBrowserNavigationRequest, setTestMessages, workspaceAbsPath]);

  useEffect(() => {
    return () => {
      const currentWorkspaceState = useZCodeSessionStore
        .getState()
        .getWorkspaceState(workspaceAbsPath);
      const displayedTaskState = getWorkspaceDisplayedTaskState(currentWorkspaceState);
      if (
        currentWorkspaceState.activeTaskId ||
        displayedTaskState.taskStatus === "creating" ||
        displayedTaskState.taskStatus === "streaming"
      ) {
        return;
      }

      // Warming up the session will cause a ZCode Agent process to reside in the workspace without tasks.
      // If you do not clean up this kind of "only warm-up, not actually used" sessions when switching tabs, after switching back and forth between multiple workspaces,
      // There will be multiple idling processes left in the background. Here, a best-effort recycling is done when leaving the current workspace.
      // In addition, the workspace initialization state must be synchronously returned to idle, otherwise you may still see it the next time you enter the page.
      // The last remaining ready/failed. Under single ZCode Agent, there is no longer a cleanup cycle based on provider.
      const workspaceInitState = getWorkspaceInitState(currentWorkspaceState);
      if (workspaceInitState.status === "idle") {
        return;
      }

      const provider = currentWorkspaceState.selectedProvider;
      logger.info(
        `[App] rolling back workspace warmup state workspace=${workspaceAbsPath} provider=${provider}`,
      );
      useZCodeSessionStore
        .getState()
        .setWorkspaceInitAttempts(workspaceAbsPath, 0, workspaceIdentity);
      useZCodeSessionStore
        .getState()
        .setWorkspaceInitState(workspaceAbsPath, "idle", null, workspaceIdentity);

      void services.zcodeTaskService
        .releaseWorkspacePreparation({
          workspacePath: workspaceAbsPath,
          ...(workspaceIdentity ? { workspaceIdentity } : {}),
          provider,
        })
        .catch((error: unknown) => {
          logger.error(
            `[App] failed to release workspace warmup state workspace=${workspaceAbsPath} provider=${provider}:`,
            error,
          );
        });
    };
  }, [services.zcodeTaskService, workspaceIdentity, workspaceAbsPath]);
}
