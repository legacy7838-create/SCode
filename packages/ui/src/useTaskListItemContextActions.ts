import type { ZCodeProvider } from "@zcode/shared";
import { useCallback } from "react";
import { usePlatform } from "@/hooks/usePlatform.js";
import { useTaskNativeSessionLogFile } from "@/hooks/useTaskNativeSessionLogFile.js";
import { useTaskSessionFilePath } from "@/hooks/useTaskSessionFilePath.js";
import { useWorkspaceOpenInEditorTarget } from "@/hooks/useWorkspaceOpenInEditorTarget.js";
import { logger } from "@/logger.js";

interface TaskPathState {
  loading: boolean;
  path: string | null;
  exists: boolean;
}

interface TaskListItemContextActionsResult {
  taskSessionFile: TaskPathState;
  taskNativeSessionLogFile: TaskPathState;
  fileManagerLabel: string;
  handleCopyText: (label: string, value: string | null) => Promise<void>;
  handleOpenTaskPathInFileManager: () => Promise<void>;
}

export function useTaskListItemContextActions({
  workspacePath,
  remoteSessionId,
  workspaceIdentity,
  taskId,
  provider,
  intl,
  loadTaskPaths = true,
}: {
  workspacePath: string;
  remoteSessionId?: string;
  workspaceIdentity?: string;
  taskId: string;
  provider?: ZCodeProvider;
  intl: {
    formatMessage: (desc: { id: string }, values?: Record<string, string>) => string;
  };
  loadTaskPaths?: boolean;
}): TaskListItemContextActionsResult {
  const platform = usePlatform();
  const workspaceOpenTarget = useWorkspaceOpenInEditorTarget({
    workspacePath,
    workspaceIdentity,
    workspaceRemoteSessionId: remoteSessionId,
  });
  const taskSessionFile = useTaskSessionFilePath(workspacePath, taskId, workspaceIdentity, {
    // Task session/log paths are only used for context menu items; do not batch-trigger RPCs during list reordering when the menu is not open.
    enabled: loadTaskPaths,
  });
  const taskNativeSessionLogFile = useTaskNativeSessionLogFile(
    workspacePath,
    taskId,
    provider ?? null,
    workspaceIdentity,
    { enabled: loadTaskPaths },
  );
  const handleCopyText = useCallback(async (label: string, value: string | null) => {
    if (!value) {
      return;
    }

    try {
      await navigator.clipboard.writeText(value);
      logger.info(`[TaskListItem] ${label} copied: ${value}`);
    } catch (error) {
      logger.warn("[TaskListItem] failed to copy text", {
        label,
        value,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }, []);

  const handleOpenTaskPathInFileManager = useCallback(async () => {
    const hasRemoteWorkspaceScope = Boolean(
      remoteSessionId || workspaceIdentity?.trim() || workspaceOpenTarget.isRemoteWorkspace,
    );
    if (hasRemoteWorkspaceScope) {
      if (workspaceOpenTarget.remoteTarget?.kind !== "wsl") {
        // The remote project path is not a host machine path. When it cannot be precisely resolved to WSL, it must fail closed
        // to prevent SSH Linux paths from incorrectly landing in the native Windows, macOS, or Linux file manager.
        logger.warn("[TaskListItem] remote workspace does not support the local file manager", {
          taskId,
          path: workspacePath,
          remoteKind: workspaceOpenTarget.remoteTarget?.kind ?? "unresolved",
        });
        return;
      }

      const result = await platform.openInEditor("explorer", workspacePath, {
        pathKind: "directory",
        remoteTarget: workspaceOpenTarget.remoteTarget,
        workspaceIdentity,
      });
      if (!result.success) {
        logger.warn("[TaskListItem] failed to open WSL workspace path", {
          taskId,
          path: workspacePath,
          error: result.error ?? "unknown-error",
        });
      }
      return;
    }

    const isMac = isMacLike();
    const isWindows = isWindowsLike();
    if (isMac || isWindows) {
      const editorId = isMac ? "finder" : "explorer";
      const result = await platform.openInEditor(editorId, workspacePath);
      if (result.success) {
        return;
      }
    }

    const result = await platform.openInFileManager(workspacePath);
    if (!result.success) {
      // The "Open in Finder" semantics in the Header / task menu should be to open the project directory.
      // Previously this was incorrectly bound to the task session file path, so menu availability depended on the task snapshot file.
      // Once the session file hadn't been resolved yet, users would see the Finder entry inexplicably unavailable.
      // Here it is unified to always open workspacePath, keeping behavior consistent with "Copy path = project path".
      logger.warn("[TaskListItem] failed to open workspace path", {
        taskId,
        path: workspacePath,
        error: result.error ?? "unknown-error",
      });
    }
  }, [
    platform,
    remoteSessionId,
    taskId,
    workspaceIdentity,
    workspaceOpenTarget.isRemoteWorkspace,
    workspaceOpenTarget.remoteTarget,
    workspacePath,
  ]);

  return {
    taskSessionFile,
    taskNativeSessionLogFile,
    fileManagerLabel: getFileManagerLabel(intl),
    handleCopyText,
    handleOpenTaskPathInFileManager,
  };
}

function isMacLike(): boolean {
  if (typeof navigator === "undefined") {
    return false;
  }

  return /mac/i.test(navigator.userAgent);
}

function isWindowsLike(): boolean {
  if (typeof navigator === "undefined") {
    return false;
  }

  return /windows/i.test(navigator.userAgent);
}

function getFileManagerLabel(intl: {
  formatMessage: (desc: { id: string }, values?: Record<string, string>) => string;
}) {
  if (isMacLike()) {
    return intl.formatMessage({ id: "appHeader.openInFinder" });
  }

  if (isWindowsLike()) {
    return intl.formatMessage({ id: "appHeader.openInFileExplorer" });
  }

  return intl.formatMessage({ id: "appHeader.openInFileManager" });
}
