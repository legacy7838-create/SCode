/**
 * Shared types for storage management (the "Storage" tab of the resource manager).
 * The data is produced by the StorageService held in the main process and delivered to the resource manager renderer through the preload `window.resourceManager.storage`;
 * both the storage module of the services layer and the UI only reference the types here.
 */
/** The two data roots: .zcode under the user's home directory, and .zcode under the "data storage path". */
export type StorageRootId = "home" | "dataBaseDir";

export const STORAGE_CATEGORY_IDS = [
  "sessionStore",
  "subagentTranscripts",
  "toolOutputs",
  "modelTrajectory",
  "devTraces",
  "logs",
  "backups",
  "exports",
  "runtimes",
  "config",
  "other",
] as const;

export type StorageCategoryId = (typeof STORAGE_CATEGORY_IDS)[number];

/** The placeholder path for the collapsed item once entries exceed the cap; the UI shows it as "N more items". */
export const STORAGE_MORE_ENTRIES_PATH = "…";

/** none: no cleanup offered; safe: cleaned up directly; confirm: a second confirmation is required. */
export type StorageCleanability = "none" | "safe" | "confirm";

/** Scan input: the root directories resolved by RootsResolverPort. */
export interface StorageRootSpec {
  id: StorageRootId;
  path: string;
  /** Whether a custom data storage path is enabled; once enabled, v2 under the home root counts as a stale copy and falls into "other". */
  hasCustomDataBaseDir: boolean;
}

export interface StorageVolume {
  /** The stable key of the same physical volume (stat().dev); roots with the same key are merged into the same disk card. */
  deviceId: string;
  /** A mount point path on mac/Linux, a drive letter root on Windows. */
  mountPoint: string;
  totalBytes: number;
  freeBytes: number;
}

export interface StorageEntryUsage {
  /** The path relative to the root directory. */
  relativePath: string;
  bytes: number;
  fileCount: number;
}

export interface StorageCategoryUsage {
  id: StorageCategoryId;
  bytes: number;
  fileCount: number;
  cleanability: StorageCleanability;
  /** Drill-down detail: the level below the rule-matched path, sorted by bytes descending, with a count cap. */
  entries: StorageEntryUsage[];
}

export interface StorageRootUsage {
  id: StorageRootId;
  path: string;
  /** null when statfs fails: only usage is shown, not the disk capacity. */
  volume: StorageVolume | null;
  bytes: number;
  fileCount: number;
  categories: StorageCategoryUsage[];
}

export type StorageScanStatus = "scanning" | "complete" | "cancelled" | "failed";

export interface StoragePathError {
  path: string;
  code: string;
}

export interface StorageUsageSnapshot {
  jobId: string;
  status: StorageScanStatus;
  startedAt: number;
  finishedAt?: number;
  roots: StorageRootUsage[];
  /** Local errors such as EACCES / ENOENT; they do not interrupt the scan. */
  errors: StoragePathError[];
}

export interface StorageCleanRequest {
  rootId: StorageRootId;
  categoryId: StorageCategoryId;
}

export interface StorageCleanResult {
  freedBytes: number;
  deletedCount: number;
  /** The number of files skipped by protection rules (for example today's log, session directories from the last 24h). */
  skippedCount: number;
  failures: StoragePathError[];
}

/** Volume view: the roots on the same physical volume are aggregated together, for the disk cards to use. */
export interface StorageVolumeGroup {
  /** volume.deviceId; roots whose probe failed each form their own group, with the root path as the key. */
  key: string;
  volume: StorageVolume | null;
  roots: StorageRootUsage[];
  bytes: number;
}

/**
 * Group root directories by physical volume: roots with the same deviceId go into the same group, and roots whose probe failed each form their own group.
 * A pure function: the order of roots inside a group matches the input, and the groups are sorted by bytes descending.
 */
export function groupStorageRootsByVolume(roots: StorageRootUsage[]): StorageVolumeGroup[] {
  const groups = new Map<string, StorageVolumeGroup>();
  for (const root of roots) {
    const key = root.volume ? `dev:${root.volume.deviceId}` : `path:${root.path}`;
    const group = groups.get(key);
    if (group) {
      group.roots.push(root);
      group.bytes += root.bytes;
      continue;
    }
    groups.set(key, { key, volume: root.volume, roots: [root], bytes: root.bytes });
  }
  return [...groups.values()].sort((a, b) => b.bytes - a.bytes);
}

/** The command surface shared by the main-process storage service and the renderer bridge. */
export interface StorageManagementApi {
  /** Starts a scan; if a job is already in progress it is cancelled first. */
  startScan(): Promise<{ jobId: string }>;
  /** Cancels the given job; a job that is not the current one is a no-op. */
  cancelScan(jobId: string): Promise<void>;
  /** The most recent snapshot (in progress or finished); null when no scan has ever run. */
  getSnapshot(): Promise<StorageUsageSnapshot | null>;
  /** Cleans up by category; the caller is responsible for the second confirmation. Calling it during a scan cancels the current scan first. */
  clean(request: StorageCleanRequest): Promise<StorageCleanResult>;
}

/** The bridge that preload exposes to the resource manager renderer: `window.resourceManager.storage`. */
export interface StorageManagementBridge extends StorageManagementApi {
  /** Progress event: throttled to at most one every ≥300ms, with the full snapshot as payload; terminal states are emitted through it too. Returns the unsubscribe function. */
  subscribeScanProgress(listener: (snapshot: StorageUsageSnapshot) => void): () => void;
  /** Reveals a path in the system file manager (it must be inside one of the data roots; validated on the main side). */
  revealPath(absolutePath: string): Promise<void>;
}
