/**
 * Folds scan entries into a per-root usage snapshot. A purely functional accumulator that can run inside a Worker.
 * It keeps the snapshot size bounded: per category, entries keeps only the top N largest by bytes, and the rest are folded into STORAGE_MORE_ENTRIES_PATH.
 */
import { classifyStoragePath, getStorageCategoryCleanability } from "./storageCatalog.js";
import {
  STORAGE_CATEGORY_IDS,
  STORAGE_MORE_ENTRIES_PATH,
  type StorageCategoryId,
  type StorageCategoryUsage,
  type StorageEntryUsage,
  type StorageRootSpec,
  type StorageRootUsage,
  type StorageVolume,
} from "@zcode/shared";

export interface StorageScanEntry {
  relativePath: string;
  bytes: number;
  mtimeMs: number;
}

interface StorageUsageAccumulator {
  add(entry: StorageScanEntry): void;
  snapshot(volume: StorageVolume | null): StorageRootUsage;
}

const DEFAULT_MAX_ENTRIES_PER_CATEGORY = 100;

interface CategoryBucket {
  bytes: number;
  fileCount: number;
  entries: Map<string, { bytes: number; fileCount: number }>;
}

export function createStorageUsageAccumulator(
  spec: StorageRootSpec,
  options: { maxEntriesPerCategory?: number } = {},
): StorageUsageAccumulator {
  const maxEntries = options.maxEntriesPerCategory ?? DEFAULT_MAX_ENTRIES_PER_CATEGORY;
  const context = { rootId: spec.id, hasCustomDataBaseDir: spec.hasCustomDataBaseDir };
  const buckets = new Map<StorageCategoryId, CategoryBucket>();
  let totalBytes = 0;
  let totalFiles = 0;

  return {
    add(entry) {
      const { categoryId, entryKey } = classifyStoragePath(entry.relativePath, context);
      let bucket = buckets.get(categoryId);
      if (!bucket) {
        bucket = { bytes: 0, fileCount: 0, entries: new Map() };
        buckets.set(categoryId, bucket);
      }
      bucket.bytes += entry.bytes;
      bucket.fileCount += 1;
      const current = bucket.entries.get(entryKey);
      if (current) {
        current.bytes += entry.bytes;
        current.fileCount += 1;
      } else {
        bucket.entries.set(entryKey, { bytes: entry.bytes, fileCount: 1 });
      }
      totalBytes += entry.bytes;
      totalFiles += 1;
    },
    snapshot(volume) {
      const categories: StorageCategoryUsage[] = STORAGE_CATEGORY_IDS.map((id) => {
        const bucket = buckets.get(id);
        return {
          id,
          bytes: bucket?.bytes ?? 0,
          fileCount: bucket?.fileCount ?? 0,
          cleanability: getStorageCategoryCleanability(id),
          entries: bucket ? foldEntries(bucket.entries, maxEntries) : [],
        };
      });
      return {
        id: spec.id,
        path: spec.path,
        volume,
        bytes: totalBytes,
        fileCount: totalFiles,
        categories,
      };
    },
  };
}

function foldEntries(
  entries: Map<string, { bytes: number; fileCount: number }>,
  maxEntries: number,
): StorageEntryUsage[] {
  const sorted = [...entries.entries()]
    .map(([relativePath, usage]) => ({ relativePath, ...usage }))
    .sort((a, b) => b.bytes - a.bytes || a.relativePath.localeCompare(b.relativePath));
  if (sorted.length <= maxEntries) return sorted;
  const kept = sorted.slice(0, maxEntries);
  const rest = sorted.slice(maxEntries);
  kept.push({
    relativePath: STORAGE_MORE_ENTRIES_PATH,
    bytes: rest.reduce((sum, item) => sum + item.bytes, 0),
    fileCount: rest.reduce((sum, item) => sum + item.fileCount, 0),
  });
  return kept;
}
