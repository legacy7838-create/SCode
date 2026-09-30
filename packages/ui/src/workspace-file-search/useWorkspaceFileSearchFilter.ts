import { useEffect, useRef, useState } from "react";
import type { WorkspaceFileEntry } from "@zcode/shared";
import {
  createWorkerWorkspaceFileSearchFilterBackend,
  type WorkspaceFileSearchFilterBackend,
} from "./workspaceFileSearchFilterBackend.js";

interface UseWorkspaceFileSearchFilterOptions {
  requireQuery?: boolean;
  limit?: number;
}

interface WorkspaceFileSearchFilterState {
  /** The original entry list, filtered by query and mapped back (ordered). */
  items: WorkspaceFileEntry[];
  /**
   * Whether the filter for the current query is still in flight (the Worker is asynchronous).
   * Callers in situations such as a miss determination should treat the in-flight state as "result
   * unknown", so that a momentary empty list does not trigger the wrong action.
   */
  filtering: boolean;
}

/**
 * The shared entry point for workspace file search filtering: candidate scoring runs in a Web
 * Worker (falling back to synchronous work on the main thread) and returns the entry list mapped
 * back. @-file candidates and the file tree search share the same semantics.
 *
 * Timing contract:
 * - when entries change (index rebuild) the items are cleared first and filtering runs
 *   asynchronously, so stale results never leak into the new index;
 * - stale results triggered by a query change are discarded by the backend's seq mechanism (resolve
 *   null);
 * - the main thread does no full Map / candidate construction (it was measured at ~630ms of
 *   synchronous blocking with 370k entries and has been moved entirely into the worker), and the
 *   worker is disposed on component unmount.
 */
export function useWorkspaceFileSearchFilterEntries(
  packed: string,
  query: string,
  options: UseWorkspaceFileSearchFilterOptions,
  rootPath: string,
): WorkspaceFileSearchFilterState {
  const backendRef = useRef<WorkspaceFileSearchFilterBackend | null>(null);
  if (backendRef.current === null) {
    backendRef.current = createWorkerWorkspaceFileSearchFilterBackend();
  }
  const [items, setItems] = useState<WorkspaceFileEntry[]>([]);
  const [filtering, setFiltering] = useState(false);

  useEffect(() => {
    const backend = backendRef.current;
    if (!backend) {
      return;
    }
    // Index reconstruction: clear old results (filtering of the new index has not yet occurred), and then push all candidates (packed through).
    setItems([]);
    backend.setPacked(packed, rootPath);
  }, [backendRef, packed, rootPath]);

  useEffect(() => {
    const backend = backendRef.current;
    if (!backend) {
      return;
    }
    let cancelled = false;
    setFiltering(true);
    void backend.filter(query, options).then((result) => {
      if (cancelled) {
        return;
      }
      setFiltering(false);
      if (result === null) {
        // Expired results (after an index rebuild or updated filter), leaving the current items unchanged.
        return;
      }
      setItems(result);
    });
    return () => {
      cancelled = true;
    };
    // entries must be in dependencies: filtering must be reinitiated after index reconstruction (setEntries), otherwise the result
    // Staying at the empty list of the old index (this trigger chain was accidentally deleted when deleting the entryMap).
    // options are new object literals for each rendering; expanded by fields as dependencies to avoid refiltering every frame.
  }, [backendRef, options.limit, options.requireQuery, packed, query, rootPath]);

  useEffect(() => {
    return () => {
      backendRef.current?.dispose();
      backendRef.current = null;
    };
  }, [backendRef]);

  return { items, filtering };
}
