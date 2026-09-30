import { useEffect, useState } from "react";
import type { ZCodeTaskMeta } from "@zcode/shared";
import { useZCodeSessionService } from "@/hooks/useZCodeSessionService.js";
import { zcodeSessionSnapshotToTaskMeta } from "@/lib/zcodeSessionProjection.js";

function resolveImmediateActiveTaskSnapshotMeta(
  previousSnapshotMeta: ZCodeTaskMeta | null,
  taskId: string | null,
  taskMetaFromLists?: ZCodeTaskMeta | null,
) {
  if (!taskId || taskMetaFromLists) {
    return null;
  }

  // When switching pin / archive task, if the target task is not in the list data source at the beginning,
  // The new snapshot cannot continue to use the snapshot meta of the previous task before it returns.
  // Otherwise, the Header will first display the old title, and then be corrected by the asynchronous result, which feels like "the name is half a beat slow".
  // Only old snapshots with the same taskId are allowed to be reused here, and they will be cleared immediately when switching between tasks.
  return previousSnapshotMeta?.taskId === taskId ? previousSnapshotMeta : null;
}

/**
 * A snapshot meta fallback for the currently active task.
 *
 * Archived tasks are not in the regular taskListCache / pinnedTasks data sources, so when one is
 * opened directly the App has no title, provider, traceId or similar fields from list metadata
 * alone. When the current task is not found in the lists, this reads snapshot.meta one extra time
 * as a display fallback: it only serves the currently active task and never mixes archived tasks
 * back into the regular lists.
 */
export function useActiveTaskSnapshotMeta(
  workspacePath: string,
  taskId: string | null,
  preferredRemoteSessionId?: string | null,
  workspaceIdentity?: string,
  taskMetaFromLists?: ZCodeTaskMeta | null,
) {
  const zcodeSessionService = useZCodeSessionService(
    workspacePath,
    preferredRemoteSessionId,
    workspaceIdentity,
  );
  const [snapshotMeta, setSnapshotMeta] = useState<ZCodeTaskMeta | null>(null);

  useEffect(() => {
    let cancelled = false;

    setSnapshotMeta((currentSnapshotMeta) =>
      resolveImmediateActiveTaskSnapshotMeta(currentSnapshotMeta, taskId, taskMetaFromLists),
    );

    if (!taskId) {
      return () => {
        cancelled = true;
      };
    }

    if (taskMetaFromLists) {
      return () => {
        cancelled = true;
      };
    }

    void zcodeSessionService
      // The active header only needs the session meta/title to be fully understood, and uses ZCode Protocol's lightweight reading method.
      // Avoid continuing to pull the entire package of large task messages back to the UI through legacy snapshot.
      .readSession({
        workspacePath,
        workspaceIdentity,
        sessionId: taskId,
        messageLimit: 1,
      })
      .then((snapshot) => {
        if (cancelled) {
          return;
        }
        setSnapshotMeta(zcodeSessionSnapshotToTaskMeta(snapshot));
      })
      .catch(() => {
        if (cancelled) {
          return;
        }
        setSnapshotMeta(null);
      });

    return () => {
      cancelled = true;
    };
  }, [zcodeSessionService, taskId, taskMetaFromLists, workspaceIdentity, workspacePath]);

  return snapshotMeta;
}
