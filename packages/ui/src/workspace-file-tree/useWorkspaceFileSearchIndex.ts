import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { WorkspaceFileEntry } from "@zcode/shared";
import {
  packWorkspaceFileEntries,
  unpackWorkspaceFileEntries,
} from "@zcode/shared/workspaceFileEntriesCodec";
import { useWorkspaceServices } from "@/hooks/useWorkspaceServices.js";
import { fetchWorkspaceFileEntriesPacked } from "@/workspace-file-search/fetchWorkspaceFileEntries.js";
import { useWorkspaceFileSearchFilterEntries } from "@/workspace-file-search/useWorkspaceFileSearchFilter.js";

interface WorkspaceFileSearchIndexState {
  entries: WorkspaceFileEntry[];
  loading: boolean;
  loaded: boolean;
  error: Error | null;
  refresh: () => void;
}

export function useWorkspaceFileSearchIndex({
  workspacePath,
  workspaceIdentity,
  workspaceRemoteSessionId,
  enabled,
}: {
  workspacePath: string;
  workspaceIdentity?: string;
  workspaceRemoteSessionId?: string;
  enabled: boolean;
}): WorkspaceFileSearchIndexState {
  const { fileService } = useWorkspaceServices(
    workspacePath,
    workspaceRemoteSessionId,
    workspaceIdentity,
  );
  // Packed direct storage (Host returns a columnar string): Use Memo unpack for tree rendering, and the search state is passed through the worker.
  const [packed, setPacked] = useState("");
  const entries = useMemo<WorkspaceFileEntry[]>(
    () => unpackWorkspaceFileEntries(packed, workspacePath),
    [packed, workspacePath],
  );
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const requestVersionRef = useRef(0);
  const [refreshVersion, setRefreshVersion] = useState(0);

  useEffect(() => {
    setPacked("");
    setLoading(false);
    setLoaded(false);
    setError(null);
    requestVersionRef.current += 1;
  }, [workspaceIdentity, workspacePath, workspaceRemoteSessionId]);

  const refresh = useCallback(() => {
    setRefreshVersion((current) => current + 1);
  }, []);

  useEffect(() => {
    if (!enabled) {
      return;
    }

    const currentVersion = requestVersionRef.current + 1;
    requestVersionRef.current = currentVersion;
    setLoading(true);
    setError(null);

    void fetchWorkspaceFileEntriesPacked(fileService, workspacePath)
      .then((result) => {
        if (requestVersionRef.current !== currentVersion) {
          return;
        }
        setPacked(result);
        setLoaded(true);
      })
      .catch((nextError) => {
        if (requestVersionRef.current !== currentVersion) {
          return;
        }
        setError(nextError instanceof Error ? nextError : new Error(String(nextError)));
      })
      .finally(() => {
        if (requestVersionRef.current === currentVersion) {
          setLoading(false);
        }
      });
  }, [enabled, fileService, refreshVersion, workspacePath]);

  return {
    entries,
    loading,
    loaded,
    error,
    refresh,
  };
}

export function useWorkspaceFileSearchResults({
  entries,
  query,
  workspacePath,
}: {
  entries: WorkspaceFileEntry[];
  query: string;
  workspacePath: string;
}): WorkspaceFileEntry[] {
  // Scoring is performed in a Web Worker (shares the same filtering semantics and degradation paths as @file candidates).
  // The input parameters are the unpacked entries of the tree (rendering reuse), which are repacked here (~31ms@370,000)
  // Leave it to the worker - to prevent the caller from maintaining a separate packed state for the search.
  // requireQuery: true maintains the file tree search behavior of "no results for an empty query".
  const packed = useMemo(() => packWorkspaceFileEntries(entries), [entries]);
  const { items } = useWorkspaceFileSearchFilterEntries(
    packed,
    query,
    { requireQuery: true },
    workspacePath,
  );
  return items;
}
