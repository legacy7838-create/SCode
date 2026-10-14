// The JavaScript scoring path this boundary REMOVED, preserved verbatim so the benchmark can
// measure what production actually ran.
//
// It is deliberately kept as its own module rather than reconstructed inside `bench.mts`: the
// number that matters is the one the shipped code produced, batching and all. `bench.mts` also
// reports a column for the SAME scoring without the batching, because that is the honest floor for
// "what JavaScript could have done" — quoting only the shipped number would overstate the win.
//
// Verbatim from the pre-change `packages/services/src/file/workspaceFileSearch.ts`
// (spec/native-boundary-fuzzy-score.md §5).

import { setImmediate } from "node:timers/promises";
import { unpackWorkspaceFileEntries } from "@zcode/shared/workspaceFileEntriesCodec";
import {
  filterWorkspaceFileSearchCandidates,
  mapWorkspaceFileEntriesToSearchCandidates,
  type WorkspaceFileSearchCandidate,
} from "@zcode/shared/workspaceFileSearch";
import type { WorkspaceFileEntry } from "@zcode/shared";

export async function buildHostFileSearchCandidates(packed: string, rootPath: string) {
  const candidates: WorkspaceFileSearchCandidate[] = [];
  for (let offset = 0; offset < packed.length; ) {
    const newline = packed.indexOf("\n", offset + 128_000);
    const end = newline < 0 ? packed.length : newline + 1;
    const entries = unpackWorkspaceFileEntries(packed.slice(offset, end), rootPath);
    for (const candidate of mapWorkspaceFileEntriesToSearchCandidates(entries))
      candidates.push(candidate);
    offset = end;
    await setImmediate();
  }
  return candidates;
}

export async function searchHostFileCandidates(
  candidates: WorkspaceFileSearchCandidate[],
  query: string,
  limit: number,
): Promise<WorkspaceFileEntry[]> {
  let best: WorkspaceFileSearchCandidate[] = [];
  for (let offset = 0; offset < candidates.length; offset += 2048) {
    best = filterWorkspaceFileSearchCandidates(
      [...best, ...candidates.slice(offset, offset + 2048)],
      query,
      { limit },
    );
    await setImmediate();
  }
  return best.map(({ name, path, relativePath, type }) => ({ name, path, relativePath, type }));
}
