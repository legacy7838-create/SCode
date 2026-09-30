// ============================================================
// Skill scan policy (pure, no I/O)
// ============================================================
//
// Sharing strategy for skills catalog scanning, used by @zcode/services (desktop recursive scanning) and
// @zcode/adapters (agent-side single-layer scanning) of apps/zcode-cli are consumed together,
// Avoid disagreements between the two ends about "which directory should be entered."
//
// Must keep pure logic and do not introduce node:* dependencies, otherwise it will break the web bundle.

/** The skill definition file name. */
export const SKILL_FILE_NAME = "SKILL.md";

/**
 * Subdirectory names that are skipped outright when recursively scanning skill directories.
 *
 * Skipping only directories that start with `.` is not enough:
 * content directories such as `node_modules` get swallowed whole by the recursion, inflating a single
 * `skills.list` to 69–256s on Windows. User skills are never stored in these directories, so they are excluded uniformly.
 */
export const SKILL_SCAN_EXCLUDED_DIRECTORY_NAMES: ReadonlySet<string> = new Set([
  "node_modules",
  "dist",
  "build",
  "out",
  "target",
  "vendor",
  "coverage",
  ".cache",
  ".next",
  ".turbo",
  ".venv",
  "__pycache__",
]);

/**
 * The maximum depth of a recursive scan (relative to the scan root, where the root itself is 0).
 *
 * Real skill layouts are very shallow: `root/<name>/SKILL.md`, and with grouping at most
 * `root/<group>/<name>/SKILL.md`. Allowing 8 levels leaves plenty of headroom while still acting as a
 * last-resort brake for very deep directory chains formed by symlinks/junctions.
 */
export const MAX_SKILL_SCAN_DEPTH = 8;

/**
 * Under skill directories (including ~/.zcode/skills), subdirectories starting with `.` are not entered by default,
 * so that vendored copies such as .agents/.cursor and symlink mirrors are not listed twice;
 * content directories such as node_modules are skipped as well.
 */
const SKILL_DISCOVERY_DOT_DIR_ALLOWLIST = new Set([".system"]);

/** Decides whether a recursive scan should descend into a given subdirectory entry. */
export function shouldWalkSkillDirectoryEntry(entryName: string): boolean {
  if (SKILL_SCAN_EXCLUDED_DIRECTORY_NAMES.has(entryName)) {
    return false;
  }
  if (!entryName.startsWith(".")) {
    return true;
  }
  return SKILL_DISCOVERY_DOT_DIR_ALLOWLIST.has(entryName);
}
