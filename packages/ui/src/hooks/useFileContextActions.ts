import { useCallback } from "react";
import type { OpenInEditorRemoteTarget } from "@zcode/shared";
import { toast } from "@/components/ui/toast.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { getContainingDirectoryPath } from "@/lib/path.js";
import { logger } from "@/logger.js";

interface FileContextActionOptions {
  canOpenLocalFileManager?: boolean;
  isRemoteWorkspace?: boolean;
  remoteTarget?: OpenInEditorRemoteTarget;
  workspaceIdentity?: string;
  openFailedMessage?: string;
}

interface FileContextActionTarget {
  path: string;
  relativePath?: string;
  deleted?: boolean;
  kind?: "file" | "directory";
}

function resolveFileManagerOpenPath(target: FileContextActionTarget): string {
  if (target.kind === "directory") {
    return target.path;
  }

  // Interaction semantics: "Reveal in file manager" in the review panel is for returning to the directory containing the file;
  // never hand the file path to the system directly, otherwise on some platforms the default application opens instead of the folder.
  return getContainingDirectoryPath(target.path) ?? target.path;
}

export function useFileContextActions(options: FileContextActionOptions = {}) {
  const platform = usePlatform();
  const { intl } = useZCodeIntl();
  const canOpenLocalFileManager = Boolean(options.canOpenLocalFileManager);
  const isRemoteWorkspace = Boolean(options.isRemoteWorkspace);
  const remoteTarget = options.remoteTarget;
  const workspaceIdentity = options.workspaceIdentity;
  const openFailedMessage =
    options.openFailedMessage ?? intl.formatMessage({ id: "appHeader.openInFileManagerFailed" });

  const canRevealInFileManager = useCallback(
    (target: FileContextActionTarget) =>
      canOpenLocalFileManager &&
      !target.deleted &&
      (!isRemoteWorkspace || remoteTarget?.kind === "wsl"),
    [canOpenLocalFileManager, isRemoteWorkspace, remoteTarget?.kind],
  );

  const copyPathText = useCallback(async (path: string) => {
    if (typeof navigator === "undefined" || !navigator.clipboard?.writeText) {
      logger.warn("[FileContextActions] failed to copy file path", {
        path,
        error: "clipboard-unavailable",
      });
      return;
    }
    try {
      await navigator.clipboard.writeText(path);
      logger.info("[FileContextActions] file path copied", { path });
    } catch (error) {
      logger.warn("[FileContextActions] failed to copy file path", {
        path,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }, []);
  const copyPath = useCallback(
    (target: FileContextActionTarget) => copyPathText(target.path),
    [copyPathText],
  );
  const copyAbsolutePath = copyPath;
  const copyRelativePath = useCallback(
    (target: FileContextActionTarget) => copyPathText(target.relativePath ?? target.path),
    [copyPathText],
  );

  const revealInFileManager = useCallback(
    async (target: FileContextActionTarget) => {
      if (!canRevealInFileManager(target)) {
        return;
      }

      const openPath = resolveFileManagerOpenPath(target);
      // The review area used to disable all remote workspaces uniformly; simply enabling it would hand WSL's
      // Linux paths to the local file manager. Only go through Explorer when the target resolves exactly to WSL,
      // preserving this entry's "open the containing folder" semantics, with main converting to UNC at the platform boundary.
      const result =
        remoteTarget?.kind === "wsl"
          ? await platform.openInEditor("explorer", openPath, {
              pathKind: "directory",
              remoteTarget,
              workspaceIdentity,
            })
          : await platform.openInFileManager(openPath);
      if (result.success) {
        return;
      }
      logger.warn("[FileContextActions] failed to reveal item in file manager", {
        path: target.path,
        openPath,
        error: result.error ?? "unknown-error",
      });
      toast(openFailedMessage);
    },
    [canRevealInFileManager, openFailedMessage, platform, remoteTarget, workspaceIdentity],
  );

  return {
    canRevealInFileManager,
    copyAbsolutePath,
    copyPath,
    copyRelativePath,
    revealInFileManager,
  };
}
