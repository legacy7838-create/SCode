import { useEffect, useState } from "react";
import type { IDisposable } from "@zcode/rpc";
import type { IFileWatcherService } from "@zcode/services";
import type { FileWatchEvent } from "@zcode/shared";
import { logger } from "@/logger.js";
import { getContainingDirectoryPath } from "@/lib/path.js";

interface PptxFileWatchSnapshot {
  filePath: string | null;
  fileWatcherService: IFileWatcherService | null;
  ready: boolean;
  reloadGeneration: number;
}

function normalizeFileWatchPathForCompare(path: string): string {
  const normalized = path.trim().replaceAll("\\", "/").replace(/\/+$/, "");
  return /^[a-zA-Z]:\//.test(normalized) || normalized.startsWith("//")
    ? normalized.toLowerCase()
    : normalized;
}

function shouldReloadPptxPreviewForWatchEvent(event: FileWatchEvent, filePath: string): boolean {
  if (!event.changedPath) {
    return true;
  }
  return (
    normalizeFileWatchPathForCompare(event.changedPath) ===
    normalizeFileWatchPathForCompare(filePath)
  );
}

export function usePptxFileWatch({
  filePath,
  fileWatcherService,
}: {
  filePath: string | null;
  fileWatcherService: IFileWatcherService;
}): { ready: boolean; reloadGeneration: number } {
  const [snapshot, setSnapshot] = useState<PptxFileWatchSnapshot>({
    filePath: null,
    fileWatcherService: null,
    ready: false,
    reloadGeneration: 0,
  });

  useEffect(() => {
    let cancelled = false;
    let watcherId: string | null = null;
    let subscription: IDisposable | null = null;

    setSnapshot({
      filePath,
      fileWatcherService,
      ready: false,
      reloadGeneration: 0,
    });
    if (!filePath) {
      return () => {
        cancelled = true;
      };
    }

    const directoryPath = getContainingDirectoryPath(filePath);
    if (!directoryPath) {
      setSnapshot({
        filePath,
        fileWatcherService,
        ready: true,
        reloadGeneration: 0,
      });
      return () => {
        cancelled = true;
      };
    }

    void fileWatcherService
      .watch({ path: directoryPath })
      .then(({ id }) => {
        if (cancelled) {
          void fileWatcherService.unwatch({ id });
          return;
        }
        watcherId = id;
        subscription = fileWatcherService.onDynamicChange(id)((event) => {
          if (!shouldReloadPptxPreviewForWatchEvent(event, filePath)) {
            return;
          }
          logger.debug("[PptxFileWatch] source file changed, refreshing the open preview", {
            path: filePath,
            changedPath: event.changedPath,
          });
          setSnapshot((current) =>
            current.filePath === filePath && current.fileWatcherService === fileWatcherService
              ? {
                  ...current,
                  ready: true,
                  reloadGeneration: current.reloadGeneration + 1,
                }
              : current,
          );
        });
        setSnapshot((current) =>
          current.filePath === filePath && current.fileWatcherService === fileWatcherService
            ? { ...current, ready: true }
            : current,
        );
      })
      .catch((error: unknown) => {
        if (cancelled) {
          return;
        }
        // File watching only drives automatic refresh; when registration fails, the initial read and manual file reopening are still allowed.
        logger.warn("[PptxFileWatch] failed to watch the pptx directory", {
          path: filePath,
          directoryPath,
          error: error instanceof Error ? error.message : String(error),
        });
        setSnapshot((current) =>
          current.filePath === filePath && current.fileWatcherService === fileWatcherService
            ? { ...current, ready: true }
            : current,
        );
      });

    return () => {
      cancelled = true;
      subscription?.dispose();
      if (watcherId) {
        void fileWatcherService.unwatch({ id: watcherId }).catch((error: unknown) => {
          logger.warn("[PptxFileWatch] failed to stop watching the pptx directory", {
            path: filePath,
            error: error instanceof Error ? error.message : String(error),
          });
        });
      }
    };
  }, [filePath, fileWatcherService]);

  // Remote reconnection or a Host replacement swaps the workspace service while the source path stays the same.
  // `ready` must belong to the current watcher service and must not reuse the old service's subscription state before the effect cleans up.
  return snapshot.filePath === filePath && snapshot.fileWatcherService === fileWatcherService
    ? {
        ready: snapshot.ready,
        reloadGeneration: snapshot.reloadGeneration,
      }
    : { ready: false, reloadGeneration: 0 };
}
