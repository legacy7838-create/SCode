import type { WorkspaceFileEntry } from "@zcode/shared";
import {
  filterWorkspaceFileSearchCandidates,
  mapWorkspaceFileEntriesToSearchCandidates,
  type FilterWorkspaceFileSearchCandidatesOptions,
} from "./workspaceFileSearch.js";
import { unpackWorkspaceFileEntries } from "@zcode/shared/workspaceFileEntriesCodec";

/**
 * Workspace file search and filtering Worker: holds all candidates, collects query, and scores +top-K in the background thread.
 * Return the mapped entry list (≤limit entries) to prevent the scoring and data transfer of hundreds of thousands of candidates from blocking the main thread.
 * The logic completely reuses the main thread pure function (workspaceFileSearch.ts), and the behavior is consistent with the downgrade path;
 * entries are transferred as column-packed strings (see comments inside backend).
 */

let entries: WorkspaceFileEntry[] = [];
let candidates: ReturnType<typeof mapWorkspaceFileEntriesToSearchCandidates> = [];
let byId: Map<string, WorkspaceFileEntry> = new Map();

self.onmessage = (
  event: MessageEvent<{
    type: string;
    seq?: number;
    query?: string;
    options?: FilterWorkspaceFileSearchCandidatesOptions;
    packed?: string;
    rootPath?: string;
  }>,
) => {
  const data = event.data;
  if (data.type === "entries" && typeof data.packed === "string") {
    entries = unpackWorkspaceFileEntries(
      data.packed,
      typeof data.rootPath === "string" ? data.rootPath : "",
    );
    candidates = mapWorkspaceFileEntriesToSearchCandidates(entries);
    byId = new Map(entries.map((entry) => [entry.relativePath, entry]));
    return;
  }
  if (data.type === "filter" && typeof data.seq === "number" && typeof data.query === "string") {
    const result = filterWorkspaceFileSearchCandidates(candidates, data.query, data.options ?? {})
      .map((candidate) => byId.get(candidate.id) ?? null)
      .filter((entry): entry is WorkspaceFileEntry => entry !== null);
    (self as unknown as Worker).postMessage({ type: "result", seq: data.seq, entries: result });
  }
};
