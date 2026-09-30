// ============================================================
// Skill root scanning rules (shared implementation)
// ============================================================

// The skills item of the manifest can point to either a single skill directory or a layer of skill collections.
// When the root directory contains SKILL.md, identify the root skill first, and then scan a layer of subdirectories; consistent with the desktop discovery rules,
// Avoid mistaking a single skill for a collection and silently missing the sweep.
// The plug-in discovery link (countSkillFiles/collectSkillComponents) is synchronous code, and the skill adapter goes
// fs/promises, therefore provides two variants of sync/async. The rules are only written once and followed by respective implementations.
//
// Error contract: only swallow "normal missing" - return an empty array when the path does not exist (ENOENT) or is not a directory; other errors
// (such as EACCES permissions, EMFILE) must be thrown upward, and it is up to the caller to decide whether to issue skill_scan_failed diagnosis or
// Graceful downgrade. The outer catch cannot swallow all errors: permission errors will degenerate into silent empty, skill_scan_failed
// Diagnostics became dead code and the silent failure path was reintroduced.
//
// Trust boundary: plugin-scope content is not trusted, symbolic links (including Windows
// junction - Dirent.isSymbolicLink/lstat returns true for both) can point to anything outside the plugin root
// Directory or file (directory level skills/evil-link -> ../../outside, file level SKILL.md -> ~/.aws/
// credentials). Realpath containment was tried, but the boundaries were spread along the data stream as optional parameters, each
// Remember to verify file contact points (file-level links, relative predicates across drive letters, manifest failure fallback)
// gap). Converged to a single rule: plugin scans never follow symbolic links - root itself, subdirectory candidates,
// The SKILL.md file rejects links at all three granularities (rejection means no escape, no need to determine where the link points).
// User-level skill roots (symlink imports of ~/.zcode/skills are a supported feature) remain the default to follow.

import { lstatSync, readdirSync, statSync } from "node:fs";
import { lstat, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { SKILL_FILE_NAME, shouldWalkSkillDirectoryEntry } from "@zcode/shared";

interface ScanSkillFilesOptions {
  /**
   * Whether to follow symlinks (directory-level and file-level), default true (symlink imports
   * at a user-level skill root are a supported feature). plugin-scope scans must pass false: a
   * link can point outside the plugin root, so refusing links is refusing escapes - no need to
   * resolve where it points with realpath.
   */
  followSymbolicLinks?: boolean;
}

/**
 * The absolute paths of every SKILL.md that really exists under the root (the root itself included).
 * A missing root, or one that is not a directory, returns an empty array; any other error during
 * the scan (EACCES and friends) is thrown upward.
 */
export async function scanSkillFilesUnderRoot(
  rootPath: string,
  options: ScanSkillFilesOptions = {},
): Promise<string[]> {
  const followSymlinks = options.followSymbolicLinks ?? true;
  // When the root itself is a link (including junction), the plug-in scan directly determines that it is empty.
  if (!followSymlinks && (await isSymbolicLink(rootPath))) return [];

  const rootInfo = await stat(rootPath).catch((error) => {
    throwIfUnexpectedScanError(error);
    return null;
  });
  if (!rootInfo?.isDirectory()) return [];

  const files: string[] = [];
  const own = join(rootPath, SKILL_FILE_NAME);
  // It is normal that there is no SKILL.md in the root itself. Continue to scan one layer of subdirectories.
  if (await isLoadableSkillFile(own, followSymlinks)) files.push(own);

  const entries = await readdir(rootPath, { withFileTypes: true });
  for (const entry of entries) {
    const walkable = entry.isDirectory() || (followSymlinks && entry.isSymbolicLink());
    if (!walkable) continue;
    if (!shouldWalkSkillDirectoryEntry(entry.name)) continue;
    // The path hit by the subdirectory must verify that the file actually exists: classified directory (such as skills/engineering/)
    // It is not a skill directory, and the spelled out path does not exist; parseSkill will skip it silently, but the count is the same as
    // Component enumeration consumes this result, and if it is not verified, "non-existent skills" will be included.
    const candidate = join(rootPath, entry.name, SKILL_FILE_NAME);
    if (await isLoadableSkillFile(candidate, followSymlinks)) files.push(candidate);
  }
  return files;
}

/** Synchronous variant of scanSkillFilesUnderRoot, with the same error contract. */
export function scanSkillFilesUnderRootSync(
  rootPath: string,
  options: ScanSkillFilesOptions = {},
): string[] {
  const followSymlinks = options.followSymbolicLinks ?? true;
  if (!followSymlinks && isSymbolicLinkSync(rootPath)) return [];

  const rootInfo = statSyncOrNull(rootPath);
  if (!rootInfo?.isDirectory()) return [];

  const files: string[] = [];
  const own = join(rootPath, SKILL_FILE_NAME);
  if (isLoadableSkillFileSync(own, followSymlinks)) files.push(own);

  for (const entry of readdirSync(rootPath, { withFileTypes: true })) {
    const walkable = entry.isDirectory() || (followSymlinks && entry.isSymbolicLink());
    if (!walkable) continue;
    if (!shouldWalkSkillDirectoryEntry(entry.name)) continue;
    const candidate = join(rootPath, entry.name, SKILL_FILE_NAME);
    if (isLoadableSkillFileSync(candidate, followSymlinks)) files.push(candidate);
  }
  return files;
}

/**
 * Loadability verdict for a SKILL.md candidate: only real files are admitted. When links are not
 * followed, symlink files (junctions included) are rejected outright - this is the defence
 * against file-level escapes (SKILL.md -> any file outside).
 */
async function isLoadableSkillFile(path: string, followSymlinks: boolean): Promise<boolean> {
  if (!followSymlinks && (await isSymbolicLink(path))) return false;
  const info = await stat(path).catch((error) => {
    throwIfUnexpectedScanError(error);
    return null;
  });
  return info?.isFile() ?? false;
}

function isLoadableSkillFileSync(path: string, followSymlinks: boolean): boolean {
  if (!followSymlinks && isSymbolicLinkSync(path)) return false;
  return statSyncOrNull(path)?.isFile() ?? false;
}

async function isSymbolicLink(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isSymbolicLink();
  } catch {
    return false;
  }
}

function isSymbolicLinkSync(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

function statSyncOrNull(path: string): { isFile(): boolean; isDirectory(): boolean } | null {
  try {
    return statSync(path);
  } catch (error) {
    throwIfUnexpectedScanError(error);
    return null;
  }
}

/** ENOENT (the path does not exist) is the normal case during a scan, so it is swallowed; every other error (EACCES and friends) is thrown upward. */
function throwIfUnexpectedScanError(error: unknown): void {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  ) {
    return;
  }
  throw error;
}
