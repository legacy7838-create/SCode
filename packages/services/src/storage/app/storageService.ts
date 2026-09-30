/**
 * IStorageService implementation: the single owner of scan jobs, the latest snapshot and
 * cleanup. It performs no IO; roots, traversal, deletion and system location are all injected
 * through ports.
 */
import { Emitter } from "@zcode/rpc";
import type { IStorageService } from "../contract.js";
import { planStorageClean } from "../domain/cleanPlan.js";
import { getStorageCategoryCleanability, getStorageCleanScopes } from "../domain/storageCatalog.js";
import type { StorageRootId, StorageRootSpec, StorageUsageSnapshot } from "@zcode/shared";
import type { FsCleanerPort, RootsResolverPort, ScanRunnerPort } from "./ports.js";
import { createScanJob, type ScanJob } from "./scanJob.js";

interface StorageServiceDependencies {
  roots: RootsResolverPort;
  scanRunner: ScanRunnerPort;
  cleaner: FsCleanerPort;
  now?: () => number;
  /** Minimum interval between progress events, 300ms by default. */
  progressThrottleMs?: number;
}

const DEFAULT_STORAGE_PROGRESS_THROTTLE_MS = 300;

export function createStorageService(deps: StorageServiceDependencies): IStorageService {
  const now = deps.now ?? Date.now;
  const throttleMs = deps.progressThrottleMs ?? DEFAULT_STORAGE_PROGRESS_THROTTLE_MS;
  const progressEmitter = new Emitter<StorageUsageSnapshot>();
  let currentJob: ScanJob | null = null;
  let latestSnapshot: StorageUsageSnapshot | null = null;
  let latestJobId: string | null = null;
  let jobCounter = 0;

  function cancelCurrentJob(): void {
    currentJob?.cancel();
    currentJob = null;
  }

  async function resolveRoot(rootId: StorageRootId): Promise<StorageRootSpec> {
    const root = (await deps.roots.resolveRoots()).find((candidate) => candidate.id === rootId);
    if (!root) throw new Error(`storage root not available: ${rootId}`);
    return root;
  }

  return {
    async startScan() {
      cancelCurrentJob();
      const jobId = `scan-${++jobCounter}`;
      latestJobId = jobId;
      const roots = await deps.roots.resolveRoots();
      const job = createScanJob({
        jobId,
        roots,
        runner: deps.scanRunner,
        now,
        throttleMs,
        emit: (snapshot) => {
          // Using currentJob for determination would lose the cancellation state snapshot after the user actively cancels a scan (currentJob is already cleared).
          // Here we determine by "the most recently started job": tail packets sent after an old job is replaced by a new job cannot overwrite the new job's snapshot.
          if (jobId === latestJobId) {
            latestSnapshot = snapshot;
          }
          progressEmitter.fire(snapshot);
        },
      });
      currentJob = job;
      void job.done.then(() => {
        if (currentJob?.jobId === jobId) currentJob = null;
      });
      return { jobId };
    },

    async cancelScan(jobId) {
      if (currentJob?.jobId !== jobId) return;
      cancelCurrentJob();
    },

    async getSnapshot() {
      return latestSnapshot;
    },

    onScanProgress: progressEmitter.event,

    async clean(request) {
      if (getStorageCategoryCleanability(request.categoryId) === "none") {
        throw new Error(`storage category is not cleanable: ${request.categoryId}`);
      }
      // Cleanup changes disk content, making in-progress scan results inaccurate; cancel first, then UI rescans after cleanup.
      cancelCurrentJob();
      const root = await resolveRoot(request.rootId);
      const scopes = getStorageCleanScopes(request.categoryId);
      const candidates = await deps.cleaner.listCandidates(root.path, scopes);
      const plan = planStorageClean({
        categoryId: request.categoryId,
        candidates,
        context: { rootId: root.id, hasCustomDataBaseDir: root.hasCustomDataBaseDir },
        now: now(),
      });
      const result = await deps.cleaner.deleteFiles(root.path, plan.targets, {
        keepDirectories: scopes.map((scope) => scope.prefix),
      });
      return { ...result, skippedCount: plan.skippedCount };
    },

    dispose() {
      cancelCurrentJob();
      progressEmitter.dispose();
    },
  };
}
