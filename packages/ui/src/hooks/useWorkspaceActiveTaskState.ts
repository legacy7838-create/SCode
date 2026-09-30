import { useMemo, useRef } from "react";
import type { ZCodeProvider, ZCodeTaskMeta } from "@zcode/shared";
import { useActiveTaskSnapshotMeta } from "@/hooks/useActiveTaskSnapshotMeta.js";
import { useTaskNativeSessionLogFile } from "@/hooks/useTaskNativeSessionLogFile.js";
import { useTaskSessionFilePath } from "@/hooks/useTaskSessionFilePath.js";
import { buildTaskEntityKey } from "@/lib/taskQueryCache.js";
import { mergeTaskMetaCandidates } from "@/lib/zcodeTaskMetaMerge.js";
import { resolveWorkspaceHeaderProvider } from "@/lib/workspaceHeaderProvider.js";
import {
  getTaskMeta,
  selectWorkspaceZCodeState,
  useZCodeSessionStore,
} from "@/store/zcodeSessionStore.js";
import { useTaskQueryCacheStore } from "@/store/taskQueryCacheStore.js";

interface UseWorkspaceActiveTaskStateParams {
  workspaceAbsPath: string;
  activeTaskId: string | null;
  workspaceRemoteSessionId?: string | null;
  workspaceIdentity?: string;
  selectedProvider: ZCodeProvider;
  intl: {
    formatMessage(descriptor: { id: string }): string;
  };
}

function areTaskMetaJsonFieldsEqual(left: unknown, right: unknown) {
  return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
}

function areResolvedTaskMetasEqual(left: ZCodeTaskMeta | null, right: ZCodeTaskMeta | null) {
  if (left === right) {
    return true;
  }

  if (!left || !right) {
    return false;
  }

  return (
    left.taskId === right.taskId &&
    left.traceId === right.traceId &&
    left.title === right.title &&
    left.titleOverridden === right.titleOverridden &&
    left.workspacePath === right.workspacePath &&
    left.workspaceIdentity === right.workspaceIdentity &&
    left.createdAt === right.createdAt &&
    left.updatedAt === right.updatedAt &&
    left.mode === right.mode &&
    left.model === right.model &&
    left.thoughtLevel === right.thoughtLevel &&
    left.runtimeEpoch === right.runtimeEpoch &&
    left.provider === right.provider &&
    left.migrationSource === right.migrationSource &&
    left.forkedFromTaskId === right.forkedFromTaskId &&
    left.unreadAt === right.unreadAt &&
    left.status === right.status &&
    areTaskMetaJsonFieldsEqual(left.lastError, right.lastError) &&
    areTaskMetaJsonFieldsEqual(left.changeSummary, right.changeSummary) &&
    areTaskMetaJsonFieldsEqual(left.target, right.target)
  );
}

function useStableResolvedActiveTaskMeta(taskMeta: ZCodeTaskMeta | null) {
  const stableTaskMetaRef = useRef<ZCodeTaskMeta | null>(null);
  const stableTaskMeta = stableTaskMetaRef.current;
  // When a stream chunk only updates the message stream, the active task meta re-synthesized through the list/optimistic layer may have identical fields but a changed reference.
  // Header/Shell depend on memo props; reuse the previous reference for an equivalent meta here so consecutive streaming updates do not drag the title bar into re-rendering.
  if (!areResolvedTaskMetasEqual(stableTaskMeta, taskMeta)) {
    stableTaskMetaRef.current = taskMeta;
  }
  return stableTaskMetaRef.current;
}

export function useWorkspaceActiveTaskState({
  workspaceAbsPath,
  activeTaskId,
  workspaceRemoteSessionId,
  workspaceIdentity,
  selectedProvider,
  intl,
}: UseWorkspaceActiveTaskStateParams) {
  const workspaceState = useZCodeSessionStore((state) =>
    selectWorkspaceZCodeState(state, workspaceAbsPath, workspaceIdentity),
  );
  const activeTaskQueryMeta = useTaskQueryCacheStore((state) => {
    if (!activeTaskId) {
      return null;
    }
    return (
      state.taskMetaByEntityKey[
        buildTaskEntityKey({
          taskId: activeTaskId,
          workspacePath: workspaceAbsPath,
          workspaceIdentity,
        })
      ] ?? null
    );
  });
  const activeTaskMeta = useMemo(() => {
    if (!activeTaskId) {
      return null;
    }

    // The App used to rely on zcodeTaskMetaMerge to pull both the regular and pinned lists, just to find a meta
    // for the currently active task. Any list refresh would then re-render the whole App along with it.
    // Now read the merged result of taskListCache + optimistic meta directly from the workspace store;
    // regular tasks hit synchronously, pinned / archived fall back to snapshot meta, and the App no longer has to stay subscribed to the old list hook.
    // After restart recovery, raw snapshot meta may reach the workspace store first while the sqlite/list
    // query cache still holds the titleOverridden manual title. The Header must merge both sides under the same title authority,
    // or the current task would look reverted to the generated title or the first query.
    return (
      mergeTaskMetaCandidates(getTaskMeta(workspaceState, activeTaskId), activeTaskQueryMeta) ??
      null
    );
  }, [activeTaskId, activeTaskQueryMeta, workspaceState]);

  const activeTaskSnapshotMeta = useActiveTaskSnapshotMeta(
    workspaceAbsPath,
    activeTaskId,
    workspaceRemoteSessionId,
    workspaceIdentity,
    activeTaskMeta,
  );
  const resolvedActiveTaskMeta = useStableResolvedActiveTaskMeta(
    activeTaskMeta ?? activeTaskSnapshotMeta,
  );
  // Store wrap-up: taskMessagesByTaskId no longer has any writer (the old ChatView/broadcast message replay is retired),
  // so the live change summary derived from the message stream is always empty; the summary display falls back to task meta.changeSummary (persisted side).
  const activeTaskChangeSummary = null;
  const activeTraceId = resolvedActiveTaskMeta?.traceId ?? null;
  const activeSessionId = resolvedActiveTaskMeta?.taskId ?? null;
  const activeTaskProvider = resolvedActiveTaskMeta?.provider ?? null;
  const workspaceHeaderProvider = resolveWorkspaceHeaderProvider(
    activeTaskProvider,
    selectedProvider,
  );
  const activeTaskBaseTitle = resolvedActiveTaskMeta?.title?.trim()
    ? resolvedActiveTaskMeta.title
    : intl.formatMessage({
        id: resolvedActiveTaskMeta?.forkedFromTaskId
          ? "taskList.forkedUntitled"
          : "taskList.newThread",
      });
  const activeTaskTitle = activeTaskBaseTitle;
  const taskNativeSessionLogFile = useTaskNativeSessionLogFile(
    workspaceAbsPath,
    activeTaskId,
    activeTaskProvider,
    workspaceIdentity,
  );
  const taskSessionFile = useTaskSessionFilePath(workspaceAbsPath, activeTaskId, workspaceIdentity);

  return {
    activeTaskMeta,
    resolvedActiveTaskMeta,
    activeTraceId,
    activeSessionId,
    activeTaskProvider,
    workspaceHeaderProvider,
    activeTaskChangeSummary,
    activeTaskTitle,
    taskNativeSessionLogFile,
    taskSessionFile,
  };
}
