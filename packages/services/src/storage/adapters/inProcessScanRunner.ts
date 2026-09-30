/**
 * In-process scan runner: walker + domain accumulator + volume probe.
 * The Worker entry point (desktop main) and the unit tests both call runStorageScan here, guaranteeing there is only one scan path.
 */
import type { StorageScanProgress, VolumeProbePort } from "../app/ports.js";
import type { StoragePathError, StorageRootSpec, StorageRootUsage } from "@zcode/shared";
import { createStorageUsageAccumulator } from "../domain/usageAggregate.js";
import { walkStorageRoot } from "./fsWalker.js";
import { createFsVolumeProbe } from "./volumeProbe.js";

interface RunStorageScanOptions {
  roots: StorageRootSpec[];
  signal: AbortSignal;
  onProgress: (progress: StorageScanProgress) => void;
  volumeProbe?: VolumeProbePort;
  /** The minimum interval between progress reports; the runner throttles itself too, so the Worker does not flood the main thread with messages. Defaults to 300ms. */
  progressIntervalMs?: number;
  concurrency?: number;
  now?: () => number;
}

export async function runStorageScan(options: RunStorageScanOptions): Promise<StorageScanProgress> {
  const now = options.now ?? Date.now;
  const probe = options.volumeProbe ?? createFsVolumeProbe();
  const interval = options.progressIntervalMs ?? 300;
  const errors: StoragePathError[] = [];
  const finished: StorageRootUsage[] = [];
  let lastReportAt = -Infinity;

  for (const root of options.roots) {
    const accumulator = createStorageUsageAccumulator(root);
    const volume = await probe.probe(root.path);
    const report = () => {
      lastReportAt = now();
      options.onProgress({
        roots: [...finished, accumulator.snapshot(volume)],
        errors: [...errors],
      });
    };
    await walkStorageRoot({
      rootPath: root.path,
      signal: options.signal,
      concurrency: options.concurrency,
      onEntry: (entry) => {
        accumulator.add(entry);
        if (now() - lastReportAt >= interval) report();
      },
      onError: (error) => errors.push({ ...error, path: `${root.id}:${error.path}` }),
    });
    finished.push(accumulator.snapshot(volume));
  }
  const progress = { roots: finished, errors };
  options.onProgress(progress);
  return progress;
}
