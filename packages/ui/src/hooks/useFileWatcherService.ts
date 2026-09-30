/**
 * useFileWatcherService —— filesystem watching hooks
 *
 * Adds an fs.watch subscription on top of useReaddir. Refreshes automatically when the directory
 * contents change, so no manual refresh is needed.
 */
import { useState, useEffect, useCallback } from "react";
import type { FileEntry } from "@zcode/shared";
import type { IDisposable } from "@zcode/rpc";
import { useServices } from "./useServices.js";
import { logger } from "@/logger.js";

/**
 * Directory reading hook with filesystem watching
 *
 * Same interface as useReaddir, but it watches the directory automatically on mount and refreshes
 * automatically when change events arrive. It unwatches on unmount.
 */
export function useWatchedReaddir(path: string) {
  const { fileService, fileWatcherService } = useServices();
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await fileService.readdir({ path });
      setEntries(result);
    } catch (e) {
      setError(e instanceof Error ? e : new Error(String(e)));
    } finally {
      setLoading(false);
    }
  }, [fileService, path]);

  // Initial read
  useEffect(() => {
    refresh();
  }, [refresh]);

  // Filesystem watching: watch on mount, unwatch on unmount
  useEffect(() => {
    let cancelled = false;
    let watcherId: string | null = null;
    const disposables: IDisposable[] = [];

    // Keep the refresh reference in a ref so event callback closures don't go stale
    const refreshRef = { current: refresh };

    fileWatcherService
      .watch({ path })
      .then(({ id }) => {
        if (cancelled) {
          // Component already unmounted; release the watcher immediately
          fileWatcherService.unwatch({ id });
          return;
        }
        watcherId = id;

        // Subscribe to change events; refresh the directory listing automatically when they arrive
        const sub = fileWatcherService.onDynamicChange(id)(() => {
          logger.info(`[FileWatcher] directory changed, refreshing path=${path}`);
          refreshRef.current();
        });
        disposables.push(sub);
      })
      .catch((err) => {
        // A watch failure doesn't affect core functionality (readdir still works); just log it
        if (!cancelled) {
          logger.warn(`[FileWatcher] failed to watch directory path=${path}:`, err);
        }
      });

    return () => {
      cancelled = true;
      for (const d of disposables) d.dispose();
      if (watcherId) fileWatcherService.unwatch({ id: watcherId });
    };
  }, [fileWatcherService, path, refresh]);

  return { entries, loading, error, refresh };
}
