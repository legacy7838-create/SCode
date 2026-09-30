import type { WorkspaceFileEntry } from "@zcode/shared";
import { logger } from "@/logger.js";
import { unpackWorkspaceFileEntries } from "@zcode/shared/workspaceFileEntriesCodec";
import {
  filterWorkspaceFileSearchCandidates,
  mapWorkspaceFileEntriesToSearchCandidates,
  type FilterWorkspaceFileSearchCandidatesOptions,
} from "./workspaceFileSearch.js";

/**
 * The filtering backend abstraction for workspace file search: where candidate scoring and top-K
 * ordering run.
 *
 * Context: after directories like node_modules were opened up, the candidate count can reach
 * hundreds of thousands, and scoring synchronously on the main thread blocks input for 50-300ms per
 * keystroke — so scoring has been moved into a Web Worker. Data transfer cannot go through
 * structured cloning either: a measured postMessage clone of 370k entries blocked the main thread
 * synchronously for ~471ms (one of the main reasons the whole window freezes for seconds when the @
 * panel is opened), so the worker transfer now uses a columnar packed string (measured at ~31ms),
 * and the worker decodes it to build the candidates.
 *
 * The synchronous implementation is kept for two purposes: (1) the degraded path when a Worker is
 * unavailable or fails to run, with behavior identical to historical versions; (2) injection in the
 * unit test environment (no Web Worker under Node).
 */
export interface WorkspaceFileSearchFilterBackend {
  /**
   * Full candidate update (columnar packed string + rootPath used to reassemble name/path); calling
   * it invalidates the existing filter results.
   */
  setPacked(packed: string, rootPath: string): void;
  /**
   * Filters by query and returns an ordered list of entries (mapped back to the original objects,
   * at most limit of them). The promise never rejects: a stale result (after setEntries or a newer
   * filter) resolves to null, and the caller discards it on that basis.
   */
  filter(
    query: string,
    options: FilterWorkspaceFileSearchCandidatesOptions,
  ): Promise<WorkspaceFileEntry[] | null>;
  dispose(): void;
}

function createSyncWorkspaceFileSearchFilterBackend(): WorkspaceFileSearchFilterBackend {
  let candidates: ReturnType<typeof mapWorkspaceFileEntriesToSearchCandidates> = [];
  let byId: Map<string, WorkspaceFileEntry> = new Map();
  return {
    setPacked(packed, rootPath) {
      const entries = unpackWorkspaceFileEntries(packed, rootPath);
      candidates = mapWorkspaceFileEntriesToSearchCandidates(entries);
      byId = new Map(entries.map((entry) => [entry.relativePath, entry]));
    },
    filter(query, options) {
      return Promise.resolve(
        filterWorkspaceFileSearchCandidates(candidates, query, options)
          .map((candidate) => byId.get(candidate.id) ?? null)
          .filter((entry): entry is WorkspaceFileEntry => entry !== null),
      );
    },
    dispose() {
      candidates = [];
      byId = new Map();
    },
  };
}

export function createWorkerWorkspaceFileSearchFilterBackend(): WorkspaceFileSearchFilterBackend {
  // When the Node test environment (vitest node project) does not have a module worker running, it directly takes the synchronization path;
  // Environments such as jsdom that have document but are not implemented by Worker are downgraded by try/catch below.
  if (typeof document === "undefined") {
    return createSyncWorkspaceFileSearchFilterBackend();
  }
  let worker: Worker;
  try {
    worker = new Worker(new URL("./workspaceFileSearchFilter.worker.ts", import.meta.url), {
      type: "module",
      name: "zcode-workspace-file-search",
    });
  } catch (error) {
    // Downgrade path: Fallback to synchronous scoring when very old event loops/test environments do not support module workers.
    logger.warn(
      "[workspace-file-search] failed to create worker, falling back to main-thread sync filtering",
      {
        error: error instanceof Error ? error.message : String(error),
      },
    );
    return createSyncWorkspaceFileSearchFilterBackend();
  }

  let seq = 0;
  const pending = new Map<number, { resolve: (entries: WorkspaceFileEntry[] | null) => void }>();

  worker.onmessage = (
    event: MessageEvent<{ type: string; seq?: number; entries?: WorkspaceFileEntry[] }>,
  ) => {
    const data = event.data;
    if (data.type !== "result" || typeof data.seq !== "number") {
      return;
    }
    const waiter = pending.get(data.seq);
    if (!waiter) {
      return;
    }
    pending.delete(data.seq);
    waiter.resolve(Array.isArray(data.entries) ? data.entries : null);
  };

  worker.onerror = (event) => {
    // Runtime failure: let all requests in transit expire (null), and subsequent filters will still try again;
    // Continuous failure is sensed by the caller via a null result and does not affect input.
    logger.warn(
      "[workspace-file-search] worker run failed, discarding this round's filter results",
      {
        message: event.message,
      },
    );
    for (const [, waiter] of pending) {
      waiter.resolve(null);
    }
    pending.clear();
  };

  return {
    setPacked(packed, rootPath) {
      seq += 1;
      for (const [, waiter] of pending) {
        waiter.resolve(null);
      }
      pending.clear();
      // packed is directly output by listWorkspaceFiles on the Host side (RPC returns a string, memcpy level transmission),
      // The renderer does not build entries objects in the entire process - 370,000 actual measurements save 11-14s of structured cloning.
      worker.postMessage({ type: "entries", packed, rootPath });
    },
    filter(query, options) {
      seq += 1;
      const currentSeq = seq;
      return new Promise<WorkspaceFileEntry[] | null>((resolve) => {
        pending.set(currentSeq, { resolve });
        worker.postMessage({
          type: "filter",
          seq: currentSeq,
          query,
          options,
        });
      });
    },
    dispose() {
      seq += 1;
      for (const [, waiter] of pending) {
        waiter.resolve(null);
      }
      pending.clear();
      worker.terminate();
    },
  };
}
