import { useEffect, useRef, useState } from "react";
import type { ZCodeProvider } from "@zcode/shared";
import { logger } from "@/logger.js";
import { useZCodeTaskService } from "@/hooks/useZCodeTaskService.js";

/**
 * The exported return type of useWorkspaceActiveTaskState references this interface indirectly, so
 * declaration generation requires it to be exportable. @lintignore
 */
export interface TaskNativeSessionLogFileState {
  provider: ZCodeProvider | null;
  path: string | null;
  exists: boolean;
  loading: boolean;
  error: string | null;
}

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

const INITIAL_STATE: TaskNativeSessionLogFileState = {
  provider: null,
  path: null,
  exists: false,
  loading: false,
  error: null,
};

function supportsTaskNativeSessionLogFile(_provider: ZCodeProvider | null | undefined): boolean {
  // Only the glm provider remains; it always supports reading the native session log.
  return true;
}

/**
 * Reads the native session log path of the current task.
 *
 * The path rule is resolved uniformly through zcodeTaskService, so the UI layer never guesses the
 * provider's own directory layout.
 */
export function useTaskNativeSessionLogFile(
  workspacePath: string,
  taskId: string | null,
  providerHint?: ZCodeProvider | null,
  workspaceIdentity?: string,
  options: { enabled?: boolean } = {},
) {
  const zcodeTaskService = useZCodeTaskService(workspacePath, undefined, workspaceIdentity);
  const [state, setState] = useState<TaskNativeSessionLogFileState>(INITIAL_STATE);
  const requestVersionRef = useRef(0);
  const enabled = options.enabled ?? true;

  useEffect(() => {
    let disposed = false;

    if (!enabled || !workspacePath || !taskId) {
      requestVersionRef.current += 1;
      // The native log path is only used by menu actions; while dragging, every row must not fire a path RPC.
      setState(INITIAL_STATE);
      return () => {
        disposed = true;
      };
    }

    if (!supportsTaskNativeSessionLogFile(providerHint)) {
      requestVersionRef.current += 1;
      setState({
        provider: providerHint ?? null,
        path: null,
        exists: false,
        loading: false,
        error: null,
      });
      return () => {
        disposed = true;
      };
    }

    const requestVersion = requestVersionRef.current + 1;
    requestVersionRef.current = requestVersion;

    setState({
      provider: providerHint ?? null,
      path: null,
      exists: false,
      loading: true,
      error: null,
    });

    void zcodeTaskService
      .getTaskNativeSessionLogFile({
        taskId,
        workspacePath,
        ...(workspaceIdentity ? { workspaceIdentity } : {}),
      })
      .then((result) => {
        if (disposed || requestVersionRef.current !== requestVersion) {
          return;
        }

        setState({
          provider: result.provider ?? providerHint ?? null,
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
        logger.warn("[useTaskNativeSessionLogFile] failed to read the task native log path", {
          workspacePath,
          taskId,
          providerHint,
          workspaceIdentity,
          error: message,
        });
        setState({
          provider: providerHint ?? null,
          path: null,
          exists: false,
          loading: false,
          error: message,
        });
      });

    return () => {
      disposed = true;
    };
  }, [enabled, zcodeTaskService, providerHint, taskId, workspaceIdentity, workspacePath]);

  return state;
}
