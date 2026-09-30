import type { WorkspaceFileEntry } from "@zcode/shared";

/**
 * Safety-net cap for virtualized display. Large enough to never feel
 * "incomplete" to users, small enough to keep fuzzy-sort and virtualizer
 * memory in check for enormous monorepos.
 */
export const WORKSPACE_FILE_SEARCH_DISPLAY_CAP = 1000;

export interface WorkspaceFileSearchCandidate {
  id: string;
  name: string;
  path: string;
  relativePath: string;
  type: WorkspaceFileEntry["type"];
  /**
   * Pre-computed lowercase form: the scoring hot path no longer repeatedly calls toLowerCase for each candidate.
   * After opening up node_modules, the candidate base can reach hundreds of thousands,
   * 3-4 full-string toLowerCase per keystroke is one of the main causes of lag; normalize once during index construction.
   */
  lowercaseName: string;
  lowercaseRelativePath: string;
  lowercasePath: string;
}

export interface FilterWorkspaceFileSearchCandidatesOptions {
  limit?: number;
  requireQuery?: boolean;
}

export function hasWorkspaceFileSearchQuery(query: string): boolean {
  return query.trim().length > 0;
}

export function mapWorkspaceFileEntriesToSearchCandidates(
  entries: WorkspaceFileEntry[],
): WorkspaceFileSearchCandidate[] {
  return entries.map((entry) => {
    // trim is consistent with the original scoring function's normalization (defending against leading/trailing space filenames), strictly equivalent behavior.
    const lowercaseRelativePath = entry.relativePath.trim().toLowerCase();
    return {
      id: entry.relativePath,
      name: entry.name,
      path: entry.path,
      relativePath: entry.relativePath,
      type: entry.type,
      lowercaseName: entry.name.trim().toLowerCase(),
      lowercaseRelativePath,
      lowercasePath: entry.path.trim().toLowerCase(),
    };
  });
}

export function scoreWorkspaceFileFuzzyMatch(text: string, query: string): number | null {
  const normalizedText = text.trim().toLowerCase();
  const normalizedQuery = query.trim().toLowerCase();

  if (!normalizedText) {
    return null;
  }

  if (!normalizedQuery) {
    return 0;
  }

  if (normalizedText.startsWith(normalizedQuery)) {
    return normalizedText.length - normalizedQuery.length;
  }

  const substringIndex = normalizedText.indexOf(normalizedQuery);
  if (substringIndex !== -1) {
    return 100 + substringIndex;
  }

  let score = 200;
  let searchStart = 0;

  for (const char of normalizedQuery) {
    const foundIndex = normalizedText.indexOf(char, searchStart);
    if (foundIndex === -1) {
      return null;
    }

    score += foundIndex - searchStart;
    searchStart = foundIndex + 1;
  }

  return score + (normalizedText.length - normalizedQuery.length);
}

/** Hot-path version of scoreWorkspaceFileFuzzyMatch: text/query are both normalized (trim+lower) inputs. */
function scoreNormalizedFuzzyMatch(normalizedText: string, normalizedQuery: string): number | null {
  if (!normalizedText) {
    return null;
  }

  if (normalizedText.startsWith(normalizedQuery)) {
    return normalizedText.length - normalizedQuery.length;
  }

  const substringIndex = normalizedText.indexOf(normalizedQuery);
  if (substringIndex !== -1) {
    return 100 + substringIndex;
  }

  let score = 200;
  let searchStart = 0;

  for (const char of normalizedQuery) {
    const foundIndex = normalizedText.indexOf(char, searchStart);
    if (foundIndex === -1) {
      return null;
    }

    score += foundIndex - searchStart;
    searchStart = foundIndex + 1;
  }

  return score + (normalizedText.length - normalizedQuery.length);
}

export function getWorkspaceFileSearchCandidateScore(
  candidate: WorkspaceFileSearchCandidate,
  query: string,
): number | null {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) {
    return 0;
  }
  const nameScore = scoreNormalizedFuzzyMatch(candidate.lowercaseName, normalizedQuery);
  const relativePathScore = scoreNormalizedFuzzyMatch(
    candidate.lowercaseRelativePath,
    normalizedQuery,
  );
  const pathScore = scoreNormalizedFuzzyMatch(candidate.lowercasePath, normalizedQuery);
  // relativePath scoring only counts the +25 tier; the higher +100 tier is always suppressed by the +25 items with the same score, making it dead code;
  // keywords items (+300) are retained, covering the scenario of "query spanning directory segment subsequence matches".
  const keywordScore = Math.min(
    relativePathScore !== null ? relativePathScore + 300 : Number.POSITIVE_INFINITY,
    pathScore !== null ? pathScore + 300 : Number.POSITIVE_INFINITY,
  );
  const bestScore = Math.min(
    nameScore ?? Number.POSITIVE_INFINITY,
    relativePathScore !== null ? relativePathScore + 25 : Number.POSITIVE_INFINITY,
    keywordScore,
  );

  return Number.isFinite(bestScore) ? bestScore : null;
}

function applyWorkspaceFileSearchLimit<T>(items: T[], limit?: number): T[] {
  if (!Number.isFinite(limit)) {
    return items;
  }

  const safeLimit = Math.max(0, Math.trunc(limit ?? 0));
  return items.slice(0, safeLimit);
}

function getDefaultWorkspaceFileSearchPriority(candidate: WorkspaceFileSearchCandidate): number {
  return candidate.type === "directory" ? 1 : 0;
}

function sortDefaultWorkspaceFileSearchCandidates(
  candidates: WorkspaceFileSearchCandidate[],
): WorkspaceFileSearchCandidate[] {
  return candidates
    .map((candidate, index) => ({
      candidate,
      index,
      priority: getDefaultWorkspaceFileSearchPriority(candidate),
    }))
    .sort((left, right) => left.priority - right.priority || left.index - right.index)
    .map(({ candidate }) => candidate);
}

interface ScoredWorkspaceFileSearchCandidate {
  candidate: WorkspaceFileSearchCandidate;
  index: number;
  score: number;
}

function compareScoredWorkspaceFileSearchCandidates(
  left: ScoredWorkspaceFileSearchCandidate,
  right: ScoredWorkspaceFileSearchCandidate,
): number {
  if (left.score !== right.score) {
    return left.score - right.score;
  }
  if (left.index !== right.index) {
    return left.index - right.index;
  }
  return left.candidate.name.localeCompare(right.candidate.name);
}

/**
 * In large workspaces (tens of thousands of candidates), the top-K insertion point previously used findIndex for linear scanning, with worst case
 * O(candidates × limit) (65k candidates × 1000 ≈ 65 million comparisons, measured 155ms synchronous blocking per keystroke
 * main thread, entire window freezes when typing in the @ panel). compareScoredWorkspaceFileSearchCandidates follows
 * (score, index) strict total order (index is unique within a single traversal), binary search for insertion point is safe,
 * single filtering reduced to O(n log K).
 */
function findInsertionIndexByBinarySearch(
  bestMatches: ScoredWorkspaceFileSearchCandidate[],
  scored: ScoredWorkspaceFileSearchCandidate,
): number {
  let low = 0;
  let high = bestMatches.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    const midItem = bestMatches[mid];
    if (midItem !== undefined && compareScoredWorkspaceFileSearchCandidates(scored, midItem) < 0) {
      high = mid;
    } else {
      low = mid + 1;
    }
  }
  return low === bestMatches.length ? -1 : low;
}

export function filterWorkspaceFileSearchCandidates(
  candidates: WorkspaceFileSearchCandidate[],
  query: string,
  options: FilterWorkspaceFileSearchCandidatesOptions = {},
): WorkspaceFileSearchCandidate[] {
  const effectiveLimit = options.limit ?? WORKSPACE_FILE_SEARCH_DISPLAY_CAP;
  const normalizedQuery = query.trim();

  if (!normalizedQuery) {
    return options.requireQuery
      ? []
      : applyWorkspaceFileSearchLimit(
          sortDefaultWorkspaceFileSearchCandidates(candidates),
          effectiveLimit,
        );
  }

  const bestMatches: ScoredWorkspaceFileSearchCandidate[] = [];
  for (const [index, candidate] of candidates.entries()) {
    const score = getWorkspaceFileSearchCandidateScore(candidate, normalizedQuery);
    if (score === null) {
      continue;
    }

    const scored = { candidate, index, score };
    // Fast path: the array is maintained in order, with the end being the current worst; when full and scored is not better than the end, it is definitely eliminated,
    // skip search and splice (most candidates take this branch under broad match queries).
    const worst = bestMatches[bestMatches.length - 1];
    if (
      worst !== undefined &&
      bestMatches.length >= effectiveLimit &&
      compareScoredWorkspaceFileSearchCandidates(scored, worst) >= 0
    ) {
      continue;
    }

    const insertionIndex = findInsertionIndexByBinarySearch(bestMatches, scored);
    if (insertionIndex === -1) {
      if (bestMatches.length < effectiveLimit) {
        bestMatches.push(scored);
      }
      continue;
    }

    bestMatches.splice(insertionIndex, 0, scored);
    if (bestMatches.length > effectiveLimit) {
      bestMatches.pop();
    }
  }

  return bestMatches.map(({ candidate }) => candidate);
}
