import { useEffect, useRef, useState } from "react";
import { logger } from "@/logger.js";
import { useZCodeTaskService } from "@/hooks/useZCodeTaskService.js";

/**
 * The exported return type of useWorkspaceActiveTaskState references this interface indirectly, and
 * declaration emit requires it to be exportable. @lintignore
 */
export interface TaskSessionFilePathState {
  path: string | null;
  exists: boolean;
  loading: boolean;
  error: string | null;
}

const INITIAL_STATE: TaskSessionFilePathState = {
  path: null,
  exists: false,
  loading: false,
  error: null,
};

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message || error.name || String(error);
  }

  if (typeof error === "object" && error !== null && "message" in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string" && message.length > 0) {
      return message;
    }
  }

  return String(error);
}

/**
 * Reads the path of the persisted snapshot file for the current task.
 *
 * The UI used to reach for crypto.subtle directly in the browser to compute the workspace hash; in
 * a non-secure context such as an http preview or remote access, subtle may not exist, and the
 * effect phase would throw outright. Resolving the final path through zcodeTaskService instead
 * means the UI no longer has to guess the directory rules, and a remote workspace's remote home
 * directory still works.
 */
export function useTaskSessionFilePath(
  workspacePath: string,
  taskId: string | null,
  workspaceIdentity?: string,
  options: { enabled?: boolean } = {},
) {
  const zcodeTaskService = useZCodeTaskService(workspacePath, undefined, workspaceIdentity);
  const [state, setState] = useState<TaskSessionFilePathState>(INITIAL_STATE);
  const requestVersionRef = useRef(0);
  const enabled = options.enabled ?? true;

  useEffect(() => {
    let disposed = false;

    if (!enabled || !workspacePath || !taskId) {
      requestVersionRef.current += 1;
      // The task path only serves the context menu; stop the RPC while the menu is closed so drag-reorder does not amplify into a path-query storm.
      setState(INITIAL_STATE);
      return () => {
        disposed = true;
      };
    }

    const requestVersion = requestVersionRef.current + 1;
    requestVersionRef.current = requestVersion;

    setState({
      path: null,
      exists: false,
      loading: true,
      error: null,
    });

    void zcodeTaskService
      .getTaskSessionFilePath({
        workspacePath,
        taskId,
        ...(workspaceIdentity ? { workspaceIdentity } : {}),
      })
      .then((result) => {
        if (disposed || requestVersionRef.current !== requestVersion) {
          return;
        }

        setState({
          path: result.path,
          exists: result.exists,
          loading: false,
          error: null,
        });
      })
      .catch((error: unknown) => {
        if (disposed || requestVersionRef.current !== requestVersion) {
          return;
        }

        const message = getErrorMessage(error);
        logger.warn("[useTaskSessionFilePath] failed to read the task snapshot path", {
          workspacePath,
          taskId,
          workspaceIdentity,
          error: message,
        });
        setState({
          path: null,
          exists: false,
          loading: false,
          error: message,
        });
      });

    return () => {
      disposed = true;
    };
  }, [enabled, zcodeTaskService, taskId, workspaceIdentity, workspacePath]);

  return state;
}
