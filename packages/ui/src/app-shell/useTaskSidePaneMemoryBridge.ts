import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { GitChangeSourceId } from "@zcode/shared";
import {
  buildTaskSidePaneMemoryKey,
  readTaskSidePaneMemoryState,
  saveTaskSidePaneMemoryState,
} from "@/lib/taskSidePaneMemory.js";

export function useTaskSidePaneMemoryBridge({
  activeTaskId,
  gitSelectedSourceId,
  setGitSelectedSourceId,
  workspaceAbsPath,
  workspaceIdentity,
}: {
  activeTaskId: string | null;
  gitSelectedSourceId: GitChangeSourceId;
  setGitSelectedSourceId: (value: GitChangeSourceId) => void;
  workspaceAbsPath: string;
  workspaceIdentity?: string;
}) {
  const memoryKey = useMemo(
    () =>
      buildTaskSidePaneMemoryKey({
        workspacePath: workspaceAbsPath,
        workspaceIdentity,
        taskId: activeTaskId,
      }),
    [activeTaskId, workspaceAbsPath, workspaceIdentity],
  );
  const activeGitSourceMemoryKeyRef = useRef<string | null>(memoryKey);
  const [browserRestoreUrls, setBrowserRestoreUrls] = useState(() => {
    const restored = readTaskSidePaneMemoryState(memoryKey);
    return restored.browserUrl
      ? { browser: restored.browserUrl, ...restored.browserUrls }
      : restored.browserUrls;
  });
  const latestGitSourceRef = useRef(gitSelectedSourceId);
  latestGitSourceRef.current = gitSelectedSourceId;

  useEffect(() => {
    const previousKey = activeGitSourceMemoryKeyRef.current;
    if (previousKey === memoryKey) {
      return;
    }

    // Both the source and Browser URLs of Git pane belong to the workspace-level side pane UI state.
    // Before switching workspaces, write back the old key and then restore the new key to avoid resetting the Review/Browser tab after returning.
    // When switching tasks within the same workspace, the same key will continue to be reused, and the content will no longer be misjudged into another state.
    saveTaskSidePaneMemoryState(previousKey, {
      activeGitSourceId: latestGitSourceRef.current,
    });
    const restored = readTaskSidePaneMemoryState(memoryKey);
    activeGitSourceMemoryKeyRef.current = memoryKey;
    setGitSelectedSourceId(restored.activeGitSourceId);
    setBrowserRestoreUrls(
      restored.browserUrl
        ? { browser: restored.browserUrl, ...restored.browserUrls }
        : restored.browserUrls,
    );
  }, [memoryKey, setGitSelectedSourceId]);

  useEffect(() => {
    return () => {
      saveTaskSidePaneMemoryState(activeGitSourceMemoryKeyRef.current, {
        activeGitSourceId: latestGitSourceRef.current,
      });
    };
  }, []);

  const handleBrowserUrlChange = useCallback(
    (tabId: string, url: string) => {
      setBrowserRestoreUrls((current) => ({
        ...current,
        [tabId]: url,
      }));
      saveTaskSidePaneMemoryState(memoryKey, {
        browserUrls: {
          ...readTaskSidePaneMemoryState(memoryKey).browserUrls,
          [tabId]: url,
        },
      });
    },
    [memoryKey],
  );

  return {
    browserRestoreUrls,
    handleBrowserUrlChange,
  };
}
