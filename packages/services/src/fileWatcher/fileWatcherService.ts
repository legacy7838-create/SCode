import { watch, type FSWatcher } from "node:fs";
import { resolve } from "node:path";
import { Emitter, Event, type Event as RpcEvent } from "@zcode/rpc";
import type { FileWatchEvent } from "@zcode/shared";
import { createServiceLogger, type ServiceLogger } from "#src/logger/serviceLogger.js";
import type { IFileWatcherService } from "./fileWatcher.js";
import { registerMemoryDiagnosticsProvider } from "#src/memoryDiagnostics.js";

/** Anti-shake time (ms) - avoid frequent refreshes when batch file changes (such as git checkout) */
const DEBOUNCE_MS = 150;

interface WatcherInstance {
  path: string;
  watcher: FSWatcher;
  changeEmitter: Emitter<FileWatchEvent>;
  /** Anti-shake timer */
  debounceTimer: ReturnType<typeof setTimeout> | null;
  /** The same anti-shake window only contains a clear path and is transparently transmitted to avoid filtering out target file events in the same batch. */
  pendingChangedPaths: Set<string>;
  hasUnknownChangedPath: boolean;
}

function resolveFileWatchChangedPath(
  watchedDirectoryPath: string,
  fileName: string | Buffer | null,
): string | undefined {
  if (fileName === null) {
    return undefined;
  }
  const normalizedFileName = fileName.toString().trim();
  return normalizedFileName ? resolve(watchedDirectoryPath, normalizedFileName) : undefined;
}

export function createFileWatcherService(options?: {
  logger?: ServiceLogger;
}): IFileWatcherService {
  const log = options?.logger ?? createServiceLogger("file-watcher");
  const watchers = new Map<string, WatcherInstance>();
  let nextId = 0;
  // Memory diagnostic counter: when the client is disconnected and does not recycle the watcher
  // It will only increase, not decrease.
  const memoryDiagnostics = registerMemoryDiagnosticsProvider("fileWatcher", () => ({
    open: watchers.size,
  }));

  function cleanup(id: string): void {
    const w = watchers.get(id);
    if (!w) return;
    if (w.debounceTimer) clearTimeout(w.debounceTimer);
    w.watcher.close();
    w.changeEmitter.dispose();
    watchers.delete(id);
  }

  return {
    async watch(params: { path: string; recursive?: boolean }): Promise<{ id: string }> {
      const id = String(nextId++);
      const changeEmitter = new Emitter<FileWatchEvent>();
      const recursive = params.recursive ?? false;

      let fsWatcher: FSWatcher;
      try {
        // The default is to watch a single directory non-recursively; workspace-level signals such as Git status explicitly turn recursive on.
        fsWatcher = watch(params.path, { recursive }, (_eventType, fileName) => {
          const instance = watchers.get(id);
          if (!instance) return;

          const changedPath = resolveFileWatchChangedPath(instance.path, fileName);
          if (changedPath) {
            instance.pendingChangedPaths.add(changedPath);
          } else {
            instance.hasUnknownChangedPath = true;
          }

          // Anti-shake: Continuous changes only trigger one refresh
          if (instance.debounceTimer) clearTimeout(instance.debounceTimer);
          instance.debounceTimer = setTimeout(() => {
            instance.debounceTimer = null;
            const onlyChangedPath =
              !instance.hasUnknownChangedPath && instance.pendingChangedPaths.size === 1
                ? instance.pendingChangedPaths.values().next().value
                : undefined;
            instance.pendingChangedPaths.clear();
            instance.hasUnknownChangedPath = false;
            instance.changeEmitter.fire({
              dirPath: instance.path,
              ...(onlyChangedPath ? { changedPath: onlyChangedPath } : {}),
            });
          }, DEBOUNCE_MS);
        });
      } catch (error) {
        changeEmitter.dispose();
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`cannot watch directory '${params.path}': ${message}`);
      }

      // Watch when a directory is deleted/renamed, send a final event and clean up
      fsWatcher.on("error", (error) => {
        const instance = watchers.get(id);
        if (instance) {
          log.warn(undefined, "file watcher error, cleaning up watcher", {
            id,
            path: instance.path,
            error: error instanceof Error ? error.message : String(error),
          });
          instance.changeEmitter.fire({ dirPath: instance.path });
          cleanup(id);
        }
      });

      watchers.set(id, {
        path: params.path,
        watcher: fsWatcher,
        changeEmitter,
        debounceTimer: null,
        pendingChangedPaths: new Set(),
        hasUnknownChangedPath: false,
      });

      return { id };
    },

    async unwatch(params: { id: string }): Promise<void> {
      cleanup(params.id);
    },

    disposeAll(): void {
      memoryDiagnostics.dispose();
      const ids = Array.from(watchers.keys());
      for (const id of ids) {
        cleanup(id);
      }
    },

    onDynamicChange(id: string): RpcEvent<FileWatchEvent> {
      const watcher = watchers.get(id);
      if (!watcher) {
        // After watch() returns successfully, before the renderer subscribes to onDynamicChange, the underlying fs.watch
        // Cleanup may still be triggered by directory deletion/rename/platform watcher errors. stale watcher id
        // It is a recoverable state and cannot be thrown to the RPC event subscription link to cause the host process to exit.
        log.warn(undefined, "ignoring stale file watch subscription", { id });
        return Event.None;
      }
      return watcher.changeEmitter.event;
    },
  };
}
