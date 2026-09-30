/**
 * App-layer ports: storageService depends only on these interfaces; the IO is implemented by adapters and injected in the desktop host.
 */
import type { StorageCleanCandidate } from "../domain/cleanPlan.js";
import type { StorageCleanScope } from "../domain/storageCatalog.js";
import type {
  StoragePathError,
  StorageRootSpec,
  StorageRootUsage,
  StorageVolume,
} from "@zcode/shared";

export interface RootsResolverPort {
  resolveRoots(): Promise<StorageRootSpec[]>;
}

export interface StorageScanProgress {
  roots: StorageRootUsage[];
  errors: StoragePathError[];
}

export interface StorageScanRunRequest {
  roots: StorageRootSpec[];
  signal: AbortSignal;
  /** The runner reports at its own pace; throttling is the job of the app-layer job. */
  onProgress: (progress: StorageScanProgress) => void;
}

export interface ScanRunnerPort {
  /** On cancellation it rejects with AbortError (name === "AbortError"). */
  run(request: StorageScanRunRequest): Promise<StorageScanProgress>;
}

export interface VolumeProbePort {
  probe(path: string): Promise<StorageVolume | null>;
}

export interface StorageDeleteResult {
  deletedCount: number;
  freedBytes: number;
  failures: StoragePathError[];
}

export interface FsCleanerPort {
  listCandidates(rootPath: string, scopes: StorageCleanScope[]): Promise<StorageCleanCandidate[]>;
  deleteFiles(
    rootPath: string,
    targets: StorageCleanCandidate[],
    options: { keepDirectories: string[] },
  ): Promise<StorageDeleteResult>;
}
