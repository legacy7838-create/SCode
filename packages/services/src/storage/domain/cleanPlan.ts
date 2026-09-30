/**
 * Cleanup plan: given a category and a list of candidate files, decides which of them can be
 * deleted. A pure function; the deletion itself is performed by adapters.
 */
import {
  classifyStoragePath,
  getStorageCategoryCleanability,
  isProtectedStoragePath,
  type StorageCatalogContext,
} from "./storageCatalog.js";
import type { StorageCategoryId } from "@zcode/shared";

export interface StorageCleanCandidate {
  relativePath: string;
  bytes: number;
  mtimeMs: number;
}

interface StorageCleanPlan {
  targets: StorageCleanCandidate[];
  skippedCount: number;
}

/** Subagent output: a session directory with an update within 24 hours is skipped as a whole, so an in-flight subagent's transcript is not deleted. */
const SUBAGENT_ACTIVE_WINDOW_MS = 24 * 60 * 60 * 1000;

export function planStorageClean(params: {
  categoryId: StorageCategoryId;
  candidates: StorageCleanCandidate[];
  context: StorageCatalogContext;
  now: number;
}): StorageCleanPlan {
  const { categoryId, candidates, context, now } = params;
  if (getStorageCategoryCleanability(categoryId) === "none") {
    return { targets: [], skippedCount: candidates.length };
  }
  // Candidates come from prefix-based enumeration and may include other categories (such as cache under cli/plugins); only keep those with matching classification and not protected.
  const owned = candidates.filter(
    (candidate) =>
      classifyStoragePath(candidate.relativePath, context).categoryId === categoryId &&
      !isProtectedStoragePath(candidate.relativePath),
  );
  let targets = owned;
  if (categoryId === "logs") {
    targets = owned.filter((candidate) => !isSameLocalDay(candidate.mtimeMs, now));
  } else if (categoryId === "subagentTranscripts") {
    // If activity determination only looks at owned (already filtered by category, leaving only transcript.jsonl), it would miss same-directory
    // newly written metadata/output files, judging in-progress subagent transcripts as inactive. Here we use all candidates to calculate activity time.
    targets = filterInactiveSessionDirs(owned, candidates, now);
  }
  return { targets, skippedCount: candidates.length - targets.length };
}

function isSameLocalDay(a: number, b: number): boolean {
  const da = new Date(a);
  const db = new Date(b);
  return (
    da.getFullYear() === db.getFullYear() &&
    da.getMonth() === db.getMonth() &&
    da.getDate() === db.getDate()
  );
}

/** Session directory = the first three segments (cli/agents/sess_x); the whole group is skipped if any file falls inside the activity window. */
function filterInactiveSessionDirs(
  targets: StorageCleanCandidate[],
  allCandidates: StorageCleanCandidate[],
  now: number,
): StorageCleanCandidate[] {
  const latestBySession = new Map<string, number>();
  const sessionKey = (path: string) => path.split("/").slice(0, 3).join("/");
  for (const candidate of allCandidates) {
    const key = sessionKey(candidate.relativePath);
    latestBySession.set(key, Math.max(latestBySession.get(key) ?? 0, candidate.mtimeMs));
  }
  return targets.filter(
    (candidate) =>
      now - (latestBySession.get(sessionKey(candidate.relativePath)) ?? 0) >
      SUBAGENT_ACTIVE_WINDOW_MS,
  );
}
