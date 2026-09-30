import { useServices } from "@/hooks/useServices.js";
import { useWorkspaceServices } from "@/hooks/useWorkspaceServices.js";
import type { IZCodeTaskService } from "@zcode/services";
import type { ZCodeTaskSnapshot } from "@zcode/shared";
import { uiMemoryDiagnosticsRegistry } from "@/lib/memoryDiagnostics.js";

type GetTaskSnapshotParams = Parameters<IZCodeTaskService["getTaskSnapshot"]>[0];
type GetTaskSnapshotResult = Promise<ZCodeTaskSnapshot | null>;
type GetTaskSnapshotWithEtagParams = Parameters<IZCodeTaskService["getTaskSnapshotWithEtag"]>[0];

const zcodeTaskServiceProxyCache = new WeakMap<IZCodeTaskService, IZCodeTaskService>();
const snapshotInflightRequestsByService = new WeakMap<
  IZCodeTaskService,
  Map<string, GetTaskSnapshotResult>
>();
const snapshotCacheByService = new WeakMap<
  IZCodeTaskService,
  Map<string, { etag: string; snapshot: ZCodeTaskSnapshot }>
>();
const SNAPSHOT_CACHE_STORAGE_KEY = "zcode-task-snapshot-cache:v1";
const SNAPSHOT_CACHE_MAX_ENTRY_BYTES = 256 * 1024;
const SNAPSHOT_CACHE_MAX_TOTAL_BYTES = 2 * 1024 * 1024;
const SNAPSHOT_CACHE_MAX_ENTRIES = 20;
type PersistedSnapshotCacheEntry = {
  key: string;
  etag: string;
  snapshot: ZCodeTaskSnapshot;
  updatedAt: number;
  sizeBytes: number;
};
let persistedSnapshotCacheLoaded = false;
const persistedSnapshotCache = new Map<string, PersistedSnapshotCacheEntry>();
// In-memory diagnostics counter: WeakMap cannot be enumerated, so remember the most recent
// service's in-memory cache (there is actually only one task service instance in the renderer).
let latestSnapshotCache: Map<string, { etag: string; snapshot: ZCodeTaskSnapshot }> | undefined;
uiMemoryDiagnosticsRegistry.register("taskSnapshotCache", () => ({
  entries: latestSnapshotCache?.size ?? 0,
  persisted: persistedSnapshotCache.size,
}));

function buildSnapshotDedupeKey(params: GetTaskSnapshotParams): string {
  return [
    params.workspacePath,
    params.workspaceIdentity ?? "",
    params.taskId,
    typeof params.messageLimit === "number" ? String(params.messageLimit) : "",
    typeof params.byteBudget === "number" ? String(params.byteBudget) : "",
    typeof params.toolLimit === "number" ? String(params.toolLimit) : "",
    // Desktop continuous and mobile remote replayable snapshots may pass through different recovery logic.
    // The cache key must distinguish clientMode, or one side's snapshot would be reused by the other.
    params.clientMode ?? "desktop-continuous",
    // Mobile read-only recovery deliberately skips task-index model backfill.
    // Different policies mean different host-side recovery semantics, so the same snapshot cache cannot be shared.
    params.resumeModelPolicy ?? "task-index",
    // Mobile first-screen recovery activates the session with a historical model hint.
    // For the same task, different model hints may also mean different context windows, so the cache must be isolated.
    params.model ?? "",
    // Replayable snapshots now carry configOptions projected from the session settings.
    // Under the same model, a different thoughtLevel also changes the toolbar config and the follow-up send hint, so an old snapshot cannot be reused.
    params.thoughtLevel ?? "",
  ].join("::");
}

function getOrCreateSnapshotInflightMap(
  service: IZCodeTaskService,
): Map<string, GetTaskSnapshotResult> {
  if (!service || typeof service !== "object") {
    return new Map();
  }
  const existing = snapshotInflightRequestsByService.get(service);
  if (existing) {
    return existing;
  }
  const created = new Map<string, GetTaskSnapshotResult>();
  snapshotInflightRequestsByService.set(service, created);
  return created;
}

function getOrCreateSnapshotCacheMap(
  service: IZCodeTaskService,
): Map<string, { etag: string; snapshot: ZCodeTaskSnapshot }> {
  if (!service || typeof service !== "object") {
    return new Map();
  }
  const existing = snapshotCacheByService.get(service);
  if (existing) {
    latestSnapshotCache = existing;
    return existing;
  }
  const created = new Map<string, { etag: string; snapshot: ZCodeTaskSnapshot }>();
  snapshotCacheByService.set(service, created);
  latestSnapshotCache = created;
  return created;
}

function getBrowserStorage(): Storage | null {
  if (typeof window === "undefined") {
    return null;
  }
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function ensurePersistedSnapshotCacheLoaded() {
  if (persistedSnapshotCacheLoaded) {
    return;
  }
  persistedSnapshotCacheLoaded = true;
  const storage = getBrowserStorage();
  const raw = storage?.getItem(SNAPSHOT_CACHE_STORAGE_KEY);
  if (!raw) {
    return;
  }

  try {
    const parsed = JSON.parse(raw) as {
      entries?: PersistedSnapshotCacheEntry[];
    };
    const entries = Array.isArray(parsed.entries) ? parsed.entries : [];
    for (const entry of entries) {
      if (
        typeof entry?.key !== "string" ||
        typeof entry?.etag !== "string" ||
        !entry.snapshot ||
        typeof entry.updatedAt !== "number" ||
        typeof entry.sizeBytes !== "number"
      ) {
        continue;
      }
      persistedSnapshotCache.set(entry.key, entry);
    }
  } catch {
    // ignore storage parse errors
  }
}

function flushPersistedSnapshotCache() {
  const storage = getBrowserStorage();
  if (!storage) {
    return;
  }
  try {
    storage.setItem(
      SNAPSHOT_CACHE_STORAGE_KEY,
      JSON.stringify({ entries: [...persistedSnapshotCache.values()] }),
    );
  } catch {
    // ignore storage write errors (quota/private mode)
  }
}

function prunePersistedSnapshotCache() {
  const entries = [...persistedSnapshotCache.values()].sort(
    (left, right) => right.updatedAt - left.updatedAt,
  );
  const nextEntries: PersistedSnapshotCacheEntry[] = [];
  let totalBytes = 0;
  for (const entry of entries) {
    if (nextEntries.length >= SNAPSHOT_CACHE_MAX_ENTRIES) {
      continue;
    }
    if (totalBytes + entry.sizeBytes > SNAPSHOT_CACHE_MAX_TOTAL_BYTES) {
      continue;
    }
    nextEntries.push(entry);
    totalBytes += entry.sizeBytes;
  }
  persistedSnapshotCache.clear();
  for (const entry of nextEntries) {
    persistedSnapshotCache.set(entry.key, entry);
  }
}

function readPersistedSnapshotEntry(key: string) {
  ensurePersistedSnapshotCacheLoaded();
  const entry = persistedSnapshotCache.get(key);
  if (!entry) {
    return null;
  }
  return { etag: entry.etag, snapshot: entry.snapshot };
}

function writePersistedSnapshotEntry(key: string, etag: string, snapshot: ZCodeTaskSnapshot): void {
  ensurePersistedSnapshotCacheLoaded();
  const serializedSnapshot = JSON.stringify(snapshot);
  const sizeBytes = new TextEncoder().encode(serializedSnapshot).byteLength;
  if (sizeBytes > SNAPSHOT_CACHE_MAX_ENTRY_BYTES) {
    // Writing a large-message task's snapshot straight to localStorage would quickly hit the quota limit and slow the main thread.
    // Only small snapshots are persisted here, and old cache entries are deleted on overflow, avoiding "causing storage pressure in the name of faster loading".
    persistedSnapshotCache.delete(key);
    flushPersistedSnapshotCache();
    return;
  }

  persistedSnapshotCache.set(key, {
    key,
    etag,
    snapshot,
    updatedAt: Date.now(),
    sizeBytes,
  });
  prunePersistedSnapshotCache();
  flushPersistedSnapshotCache();
}

function deletePersistedSnapshotEntry(key: string): void {
  ensurePersistedSnapshotCacheLoaded();
  persistedSnapshotCache.delete(key);
  flushPersistedSnapshotCache();
}

function createZCodeTaskServiceProxy(service: IZCodeTaskService): IZCodeTaskService {
  const inflight = getOrCreateSnapshotInflightMap(service);
  const snapshotCache = getOrCreateSnapshotCacheMap(service);

  return new Proxy(service, {
    get(target, prop, receiver) {
      if (prop !== "getTaskSnapshot") {
        return Reflect.get(target, prop, receiver);
      }

      return (params: GetTaskSnapshotParams) => {
        const requestKey = buildSnapshotDedupeKey(params);
        const existing = inflight.get(requestKey);
        if (existing) {
          return existing;
        }
        const cachedSnapshotEntry =
          snapshotCache.get(requestKey) ?? readPersistedSnapshotEntry(requestKey);
        if (cachedSnapshotEntry && !snapshotCache.has(requestKey)) {
          snapshotCache.set(requestKey, cachedSnapshotEntry);
        }

        // On remote first-screen recovery, multiple hooks concurrently request the same task snapshot,
        // making the host run getTaskSnapshot several times in a row and ship huge snapshots to the relay repeatedly.
        // Deduplicate concurrency by "same service + same parameters" here, reusing one Promise on a hit,
        // so only one RPC goes out at a time; also send if-none-match so an unchanged snapshot reuses the local cached copy,
        // avoiding repeated delivery of large JSON.
        const request = (async () => {
          const firstResult = await target.getTaskSnapshotWithEtag({
            ...(params as GetTaskSnapshotWithEtagParams),
            ...(cachedSnapshotEntry?.etag ? { ifNoneMatch: cachedSnapshotEntry.etag } : {}),
          });
          if (firstResult.notModified) {
            if (cachedSnapshotEntry?.snapshot) {
              return cachedSnapshotEntry.snapshot;
            }
            // When only the etag was persisted but no usable snapshot body exists, notModified must not be passed straight up,
            // or the first screen would get empty data. Fall back to one hard fetch without if-none-match here, prioritizing data integrity.
            const fallbackResult = await target.getTaskSnapshotWithEtag(
              params as GetTaskSnapshotWithEtagParams,
            );
            if (fallbackResult.snapshot && fallbackResult.etag) {
              const nextEntry = {
                etag: fallbackResult.etag,
                snapshot: fallbackResult.snapshot,
              };
              snapshotCache.set(requestKey, nextEntry);
              writePersistedSnapshotEntry(requestKey, fallbackResult.etag, fallbackResult.snapshot);
            }
            return fallbackResult.snapshot;
          }
          if (firstResult.snapshot && firstResult.etag) {
            const nextEntry = {
              etag: firstResult.etag,
              snapshot: firstResult.snapshot,
            };
            snapshotCache.set(requestKey, nextEntry);
            writePersistedSnapshotEntry(requestKey, firstResult.etag, firstResult.snapshot);
          } else if (!firstResult.snapshot) {
            snapshotCache.delete(requestKey);
            deletePersistedSnapshotEntry(requestKey);
          }
          return firstResult.snapshot;
        })().finally(() => {
          if (inflight.get(requestKey) === request) {
            inflight.delete(requestKey);
          }
        });
        inflight.set(requestKey, request);
        return request;
      };
    },
  });
}

/** Get the ZCode task wrapper service instance */
export function useZCodeTaskService(
  workspacePath?: string,
  preferredRemoteSessionId?: string | null,
  workspaceIdentity?: string | null,
): IZCodeTaskService {
  // The ZCode task service resolves by workspace identity, ensuring all task RPCs land on the right host.
  const services = workspacePath
    ? useWorkspaceServices(workspacePath, preferredRemoteSessionId, workspaceIdentity)
    : useServices();
  const rawService = services.zcodeTaskService;
  if (!rawService || typeof rawService !== "object") {
    return rawService;
  }
  const cachedProxy = zcodeTaskServiceProxyCache.get(rawService);
  if (cachedProxy) {
    return cachedProxy;
  }
  const nextProxy = createZCodeTaskServiceProxy(rawService);
  zcodeTaskServiceProxyCache.set(rawService, nextProxy);
  return nextProxy;
}
