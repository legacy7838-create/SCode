import { useEffect } from "react";
import type { IFileWatcherService } from "@zcode/services";
import { logger } from "@/logger.js";

const WATCH_DEBOUNCE_MS = 300;

/**
 * workspacePath may be a Windows path; compose the subdirectory with its own separator instead of
 * mixing `/` into a `\\` path.
 */
function savedWorkflowsDirectoryPath(workspacePath: string): string {
  const separator = workspacePath.includes("\\") && !workspacePath.includes("/") ? "\\" : "/";
  const trimmed = workspacePath.replace(/[\\/]+$/u, "");
  return `${trimmed}${separator}.zcode${separator}workflows`;
}

/**
 * Directory watch: the hub updates itself once SaveWorkflow writes to disk from a conversation. The
 * watch fails when the directory does not exist — that is the normal case (most projects have never
 * saved a workflow) — so it is skipped silently and made up for by switching tabs / refreshing
 * manually. Non-recursive: only this level is watched (recursive fs.watch has known problems on
 * Linux). When the service instance changes (a remote reconnect), the effect's dependency change
 * tears down the old watcher and rebuilds it, so the old host's id never leaks.
 *
 * The project group passes `workspacePath` (composing `<ws>/.zcode/workflows`); the global group
 * passes `directory` (the absolute directory returned by the protocol's list, i.e.
 * `~/.zcode/workflows`); exactly one of the two — `directory` wins.
 */
export function useSavedWorkflowsDirectoryWatch({
  fileWatcherService,
  workspacePath,
  directory,
  enabled,
  refresh,
}: {
  fileWatcherService: IFileWatcherService;
  workspacePath?: string | null | undefined;
  directory?: string | null | undefined;
  enabled: boolean;
  refresh: (options: { bypassCache?: boolean }) => Promise<void>;
}): void {
  const resolvedDirectory =
    directory ?? (workspacePath ? savedWorkflowsDirectoryPath(workspacePath) : null);
  useEffect(() => {
    if (!enabled || !resolvedDirectory) return;
    let disposed = false;
    let watchId: string | null = null;
    let subscription: { dispose: () => void } | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const directoryPath = resolvedDirectory;
    void fileWatcherService
      .watch({ path: directoryPath })
      .then(({ id }) => {
        if (disposed) {
          void fileWatcherService.unwatch({ id });
          return;
        }
        watchId = id;
        subscription = fileWatcherService.onDynamicChange(id)(() => {
          if (timer) clearTimeout(timer);
          timer = setTimeout(() => {
            timer = null;
            void refresh({ bypassCache: true });
          }, WATCH_DEBOUNCE_MS);
        });
      })
      .catch((error: unknown) => {
        logger.debug(
          "[SavedWorkflows] watch .zcode/workflows failed (the directory may not exist yet)",
          {
            path: directoryPath,
            error: error instanceof Error ? error.message : String(error),
          },
        );
      });
    return () => {
      disposed = true;
      if (timer) clearTimeout(timer);
      subscription?.dispose();
      if (watchId) void fileWatcherService.unwatch({ id: watchId });
    };
  }, [enabled, fileWatcherService, refresh, resolvedDirectory]);
}
