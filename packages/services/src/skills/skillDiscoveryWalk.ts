import { readdir, realpath, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  MAX_SKILL_SCAN_DEPTH,
  SKILL_FILE_NAME,
  shouldWalkSkillDirectoryEntry,
} from "@zcode/shared";

// The scanning strategy comes from @zcode/shared and is shared between the desktop side (this package) and the agent side (@zcode/adapters).
// Avoid disagreements between the two ends about "which directories to enter." Transfer out here and keep the existing import path unchanged.
export {
  MAX_SKILL_SCAN_DEPTH,
  SKILL_FILE_NAME,
  SKILL_SCAN_EXCLUDED_DIRECTORY_NAMES,
  shouldWalkSkillDirectoryEntry,
} from "@zcode/shared";

interface WalkSkillMarkdownOptions {
  /** Called when readdir / stat fails; when not passed, the directory is silently skipped and the caller collects diagnostics as it needs them. */
  onError?: (path: string, error: unknown) => void;
}

/**
 * Walks depth-first from the root directory and yields the absolute path of every SKILL.md.
 *
 * Bound by the scanning policy in @zcode/shared:
 * - it skips content directories such as node_modules and dot-directories (except .system);
 * - it caps the maximum depth (MAX_SKILL_SCAN_DEPTH) as a backstop brake for absurdly deep directory chains;
 * - it deduplicates only symlinked directories by realpath, avoiding duplicates or endless scans caused by Windows junctions / cycles, since
 *   a normal directory tree cannot form a cycle, so the hot path skips the extra realpath.
 *
 */
export async function* walkSkillMarkdownPaths(
  rootPath: string,
  options: WalkSkillMarkdownOptions = {},
): AsyncGenerator<string> {
  const stack: Array<{ dir: string; depth: number }> = [{ dir: rootPath, depth: 0 }];
  const visitedSymlinkTargets = new Set<string>();

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) {
      continue;
    }
    const { dir, depth } = current;

    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (error) {
      options.onError?.(dir, error);
      continue;
    }

    let hasSkillFile = false;
    const childDirectories: string[] = [];
    const childSymlinks: string[] = [];
    for (const entry of entries) {
      // Ordinary files or soft links pointing to files named SKILL.md are considered skill definitions.
      if (entry.name === SKILL_FILE_NAME && !entry.isDirectory()) {
        hasSkillFile = true;
        continue;
      }
      if (!shouldWalkSkillDirectoryEntry(entry.name)) {
        continue;
      }
      const entryPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        childDirectories.push(entryPath);
      } else if (entry.isSymbolicLink()) {
        childSymlinks.push(entryPath);
      }
    }

    if (hasSkillFile) {
      yield join(dir, SKILL_FILE_NAME);
    }

    if (depth >= MAX_SKILL_SCAN_DEPTH) {
      continue;
    }

    for (const childDirectory of childDirectories) {
      stack.push({ dir: childDirectory, depth: depth + 1 });
    }

    // Soft link directory: first confirm the pointing directory, and then press realpath to remove duplicates to avoid junction/loop duplication or infinite scanning.
    for (const childSymlink of childSymlinks) {
      let targetStat;
      try {
        targetStat = await stat(childSymlink);
      } catch (error) {
        options.onError?.(childSymlink, error);
        continue;
      }
      if (!targetStat.isDirectory()) {
        continue;
      }
      const canonical = await realpath(childSymlink).catch(() => childSymlink);
      if (visitedSymlinkTargets.has(canonical)) {
        continue;
      }
      visitedSymlinkTargets.add(canonical);
      stack.push({ dir: childSymlink, depth: depth + 1 });
    }
  }
}
