import type { Event } from "@zcode/rpc";
import type { FileWatchEvent } from "@zcode/shared";
import { ServiceChannels } from "@zcode/shared";
import { createServiceDescriptor } from "../descriptors.js";

/**
 * File system watching service
 *
 * Manages watcher instances per path. The UI calls the non-recursive watch() when expanding a
 * directory, while workspace-level state such as Git can call the recursive watch(). Events are
 * streamed over RPC via onDynamicChange.
 */
export interface IFileWatcherService {
  /** Starts watching a path. Returns a watcherId used for unwatch and event subscription */
  watch(params: { path: string; recursive?: boolean }): Promise<{ id: string }>;
  /** Stops watching. Releases the watcher and related resources */
  unwatch(params: { id: string }): Promise<void>;
  /** Stops all watches. Used during host exit cleanup to release the underlying fs.watch handles in one go */
  disposeAll(): void;
  /** Subscribes to change events by watcherId (the onDynamic* pattern, routed automatically by RPC) */
  onDynamicChange(id: string): Event<FileWatchEvent>;
}

export const IFileWatcherService = createServiceDescriptor<IFileWatcherService>(
  ServiceChannels.FileWatcher,
);
