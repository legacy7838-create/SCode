import { useCallback, useEffect, useRef, useState } from "react";
import type { ZCodeModelTrajectory } from "@zcode/services";
import { logger } from "@/logger.js";
import { useZCodeTaskService } from "@/hooks/useZCodeTaskService.js";

interface ModelTrajectoryState {
  loading: boolean;
  data: ZCodeModelTrajectory | null;
  error: string | null;
}

const INITIAL_STATE: ModelTrajectoryState = {
  loading: false,
  data: null,
  error: null,
};

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message || error.name || String(error);
  }
  return String(error);
}

/**
 * Read the model call trajectory (model-io) of a given task/session.
 *
 * Both path resolution and file reading are funneled into zcodeTaskService.getModelTrajectory (host
 * side), so the desktop reads the local machine while the phone's remote control reads the remote
 * host; the UI only consumes the structured result.
 */
export function useModelTrajectory(
  workspacePath: string,
  taskId: string | null,
  workspaceIdentity?: string,
): ModelTrajectoryState & { refresh: () => void } {
  const zcodeTaskService = useZCodeTaskService(workspacePath, undefined, workspaceIdentity);
  const [state, setState] = useState<ModelTrajectoryState>(INITIAL_STATE);
  const [reloadToken, setReloadToken] = useState(0);
  const requestVersionRef = useRef(0);

  const refresh = useCallback(() => {
    setReloadToken((token) => token + 1);
  }, []);

  useEffect(() => {
    let disposed = false;

    if (!taskId) {
      requestVersionRef.current += 1;
      setState(INITIAL_STATE);
      return () => {
        disposed = true;
      };
    }

    const requestVersion = requestVersionRef.current + 1;
    requestVersionRef.current = requestVersion;
    setState({ loading: true, data: null, error: null });

    void zcodeTaskService
      .getModelTrajectory({ taskId })
      .then((data) => {
        if (disposed || requestVersionRef.current !== requestVersion) {
          return;
        }
        setState({ loading: false, data, error: null });
      })
      .catch((error: unknown) => {
        if (disposed || requestVersionRef.current !== requestVersion) {
          return;
        }
        const message = getErrorMessage(error);
        logger.warn("[useModelTrajectory] failed to read model call trajectory", {
          workspacePath,
          taskId,
          workspaceIdentity,
          error: message,
        });
        setState({ loading: false, data: null, error: message });
      });

    return () => {
      disposed = true;
    };
  }, [zcodeTaskService, taskId, workspaceIdentity, workspacePath, reloadToken]);

  return { ...state, refresh };
}
