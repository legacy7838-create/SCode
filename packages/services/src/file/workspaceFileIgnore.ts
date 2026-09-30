import { open, readFile, rename, rm } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import ignoreFactory from "ignore";
import type { Ignore } from "ignore";
import type { ServiceLogger } from "../logger/serviceLogger.js";

/**
 * The single source of truth for workspace file-search ignore rules.
 *
 * `.zcodeignore` (workspace root, gitignore syntax) is the only rule file for the search index:
 * it is created automatically the first time rules are needed and the file is missing, with a copy
 * of the root `.gitignore` as content (or the default template when there is none); afterwards
 * changes to `.gitignore` no longer affect search — users edit it via the settings page or
 * "re-sync from .gitignore".
 *
 * Rule parsing is delegated to the `ignore` npm package (the gitignore spec 2.22 reference
 * implementation, the same one ESLint uses): later declarations override, `!` negation
 * (including git's native constraint that a child file cannot be re-included once its parent
 * directory is excluded), anchored/basename, `**` across levels, the directory suffix `/`,
 * character classes and escapes. Hand-writing gitignore parsing in this repo is forbidden.
 */

export const WORKSPACE_FILE_SEARCH_IGNORE_FILE_NAME = ".zcodeignore";
const GITIGNORE_FILE_NAME = ".gitignore";

type WorkspaceFileIgnoreLogger = Pick<ServiceLogger, "info" | "warn">;

type WorkspaceFileSearchIgnoreRulesSource =
  | "file"
  | "created-from-gitignore"
  | "created-from-template"
  | "fallback-gitignore"
  | "fallback-builtin";

interface WorkspaceFileSearchIgnoreRules {
  matcher: Ignore;
  source: WorkspaceFileSearchIgnoreRulesSource;
}

interface WorkspaceFileSearchIgnoreContent {
  content: string;
  /** file: .zcodeignore already exists; template: not created yet, content is the initial content preview that will be written on save. */
  source: "file" | "template";
}

/**
 * The built-in exclusion rules of the default template: they take over the retired part of the old
 * defaultWorkspaceFileSearchFilter directory blacklist, so a "created from scratch" workspace behaves
 * like the old default (node_modules/.git etc. are still pruned).
 * Prefix wildcards are expressed with gitignore syntax (cmake-build-* etc.), equivalent to the old
 * SKIPPED_DIRECTORY_PREFIXES.
 */
const BUILTIN_IGNORE_LINES = [
  ".git/",
  ".hg/",
  ".svn/",
  "node_modules/",
  "bower_components/",
  "jspm_packages/",
  "__pycache__/",
  "site-packages/",
  "venv/",
  "coverage/",
  "htmlcov/",
  "lcov-report/",
  "cmakefiles/",
  "cmake-build-*/",
  "bazel-*/",
  "pods/",
  "deriveddata/",
  "storybook-static/",
  "playwright-report/",
  "test-results/",
  "allure-results/",
  "allure-report/",
  "cdk.out/",
  "*.egg-info/",
  "*.dist-info/",
  "eggs/",
  "pip-wheel-metadata/",
  "wheels/",
];

const TEMPLATE_HEADER = [
  "# ZCode workspace file search ignore rules (.zcodeignore)",
  "# Syntax matches .gitignore; only affects ZCode's @ file candidates / Command Center / file tree search,",
  "# and does not affect file tree browsing, uploads, or Agent file access.",
  '# Editing .gitignore does not sync to this file automatically; use "Sync from .gitignore" in settings.',
  "",
];

/**
 * Section markers (matched exactly per line; deleting a marker degrades the corresponding button
 * into a full rebuild):
 * "Sync from .gitignore" only rewrites the content above the SYNC marker;
 * "Restore default rules" only rewrites the default exclusion section between the two markers;
 * the custom rules section below the DEFAULTS marker is never touched by any button.
 */
const WORKSPACE_FILE_SEARCH_IGNORE_SYNC_MARKER =
  '# ===== ↑ above is synced from .gitignore ("Sync from .gitignore" only rewrites the part above) =====';
const WORKSPACE_FILE_SEARCH_IGNORE_DEFAULTS_MARKER =
  "# ----- ↑ above are ZCode default exclusion rules (put custom rules below this line; sync/restore never touches them) -----";

const CUSTOM_SECTION_HINT = "# Custom rules go below (this hint line can be deleted)";

function buildBuiltinDefaultsSection(gitignoreContent: string | null): string {
  // Deduplication when creating/restoring the default: the declared rules in the gitignore area are not repeatedly written to the default section.
  // Ensure that there is at most one copy of each rule in the file - if the user deletes one place, it will be completely released and will not appear.
  // "The default section of node_modules/ has been deleted, but there is still one hidden in the gitignore copy area".
  // The judgment is conservative: lines are equal after trimming, or a single trailing '/' difference is ignored (node_modules overrides node_modules/);
  // Differences in writing such as anchored (/node_modules/) are not considered duplicates. It is better to repeat than to miss the rules.
  if (gitignoreContent === null) {
    return BUILTIN_IGNORE_LINES.join("\n");
  }
  const declared = new Set<string>();
  for (const rawLine of gitignoreContent.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || line.startsWith("!")) {
      continue;
    }
    declared.add(line);
    declared.add(line.replace(/\/$/, ""));
  }
  const deduped = BUILTIN_IGNORE_LINES.filter((line) => {
    const bare = line.replace(/\/$/, "");
    return !declared.has(line) && !declared.has(bare);
  });
  return deduped.join("\n");
}

/**
 * Builds the initial `.zcodeignore` content: a copy of the .gitignore rules + a two-marker split
 * (default exclusion section / custom section). Appending the default section is a behavioral
 * compatibility requirement: for repos whose .gitignore does not declare directories like
 * node_modules, a strict copy alone would leave dependency directories fully open to scanning
 * (bringing back the full-repo scan performance problem). The default section ships with the
 * file for the user to edit — deleting it opens everything up — preserving the promise of
 * "single source of truth, no code-level union".
 * The gitignore section is deduplicated before the default section is written (see buildBuiltinDefaultsSection).
 */
function buildWorkspaceFileSearchIgnoreTemplate(gitignoreContent: string | null): string {
  const gitignoreSection =
    gitignoreContent !== null && gitignoreContent.trim().length > 0
      ? gitignoreContent.endsWith("\n")
        ? gitignoreContent
        : `${gitignoreContent}\n`
      : `${TEMPLATE_HEADER.join("\n")}\n`;
  return [
    gitignoreSection,
    WORKSPACE_FILE_SEARCH_IGNORE_SYNC_MARKER,
    buildBuiltinDefaultsSection(gitignoreContent),
    WORKSPACE_FILE_SEARCH_IGNORE_DEFAULTS_MARKER,
    CUSTOM_SECTION_HINT,
    "",
  ].join("\n");
}

interface SplitWorkspaceFileSearchIgnoreSections {
  gitignoreSection: string;
  defaultsSection: string;
  customSection: string;
}

/** Splits the file by the two markers; returns null when either marker is missing (legacy format / user deletion), and the caller degrades into a full rebuild. */
function splitWorkspaceFileSearchIgnoreSections(
  content: string,
): SplitWorkspaceFileSearchIgnoreSections | null {
  const lines = content.split(/\r?\n/);
  const syncIndex = lines.findIndex(
    (line) => line.trim() === WORKSPACE_FILE_SEARCH_IGNORE_SYNC_MARKER,
  );
  const defaultsIndex = lines.findIndex(
    (line) => line.trim() === WORKSPACE_FILE_SEARCH_IGNORE_DEFAULTS_MARKER,
  );
  if (syncIndex === -1 || defaultsIndex === -1 || defaultsIndex <= syncIndex) {
    return null;
  }
  return {
    gitignoreSection: lines.slice(0, syncIndex).join("\n"),
    defaultsSection: lines
      .slice(syncIndex + 1, defaultsIndex)
      .join("\n")
      .trim(),
    customSection: lines
      .slice(defaultsIndex + 1)
      .join("\n")
      .replace(/^\n+/, ""),
  };
}

/**
 * "Sync from .gitignore": only rewrites the content above the SYNC marker to the current .gitignore,
 * leaving the default exclusion section and the custom section as-is (the user's edits to the
 * default section are unaffected).
 * When a marker is missing it degrades into a full rebuild of the initial content (the sections
 * cannot be located structurally).
 */
function syncWorkspaceFileSearchIgnoreFromGitignore(
  currentContent: string,
  gitignoreContent: string | null,
): string {
  const sections = splitWorkspaceFileSearchIgnoreSections(currentContent);
  if (!sections) {
    return buildWorkspaceFileSearchIgnoreTemplate(gitignoreContent);
  }
  const gitignoreSection =
    gitignoreContent !== null && gitignoreContent.trim().length > 0
      ? gitignoreContent.endsWith("\n")
        ? gitignoreContent
        : `${gitignoreContent}\n`
      : `${TEMPLATE_HEADER.join("\n")}\n`;
  return [
    gitignoreSection,
    WORKSPACE_FILE_SEARCH_IGNORE_SYNC_MARKER,
    sections.defaultsSection,
    WORKSPACE_FILE_SEARCH_IGNORE_DEFAULTS_MARKER,
    sections.customSection,
  ]
    .join("\n")
    .replace(/\n+$/, "\n");
}

/**
 * "Restore default rules": only resets the default exclusion section to the built-in list, leaving
 * the gitignore section and the custom section as-is.
 * When a marker is missing it degrades into a full rebuild of the initial content.
 */
function resetWorkspaceFileSearchIgnoreDefaults(
  currentContent: string,
  gitignoreContent: string | null,
): string {
  const sections = splitWorkspaceFileSearchIgnoreSections(currentContent);
  if (!sections) {
    return buildWorkspaceFileSearchIgnoreTemplate(gitignoreContent);
  }
  // Restore the default and de-calculate according to the current gitignore area rules: lines declared by gitignore will not be repeatedly written back to the default section;
  // If the user has deleted node_modules, etc. from .gitignore, the default section will make up for it during recovery (return to the bottom).
  return [
    sections.gitignoreSection,
    WORKSPACE_FILE_SEARCH_IGNORE_SYNC_MARKER,
    buildBuiltinDefaultsSection(sections.gitignoreSection),
    WORKSPACE_FILE_SEARCH_IGNORE_DEFAULTS_MARKER,
    sections.customSection,
  ]
    .join("\n")
    .replace(/\n+$/, "\n");
}

// The index.d.ts of the ignore package resolves the default import into the module namespace (no call signature) under nodenext.
// The runtime default is exactly the factory function itself (Node ESM interop actual test). This explicitly narrows back to the factory signature.
const createIgnoreMatcher: () => Ignore = ignoreFactory as unknown as () => Ignore;

function buildIgnoreMatcher(content: string): Ignore {
  return createIgnoreMatcher().add(content);
}

function isNotFoundError(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === "ENOENT";
}

async function readOptionalFile(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (isNotFoundError(error)) {
      return null;
    }
    throw error;
  }
}

/**
 * Atomic write: write a temp file inside the target directory (flush + close), then replace via
 * rename, following the workspace-hook-mutation.ts pattern so the Runtime/settings page never
 * observes a half-written rules file.
 */
async function atomicWriteIgnoreFile(path: string, content: string): Promise<void> {
  const directory = dirname(path);
  const tempPath = resolve(
    directory,
    `.${basename(path)}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`,
  );
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(tempPath, "wx", 0o644);
    await handle.writeFile(content, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(tempPath, path);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

/**
 * Loads the `.zcodeignore` rules before scanning, including the auto-create and fail-open
 * degradation chain:
 * file missing → create atomically (a .gitignore copy / the default template);
 * create or read failure (read-only fs, permissions) → use the .gitignore content in memory →
 * if that fails too, use the built-in default rules.
 * Any degradation only warns once; the @ panel must never fail to scan just because the rules
 * file is unavailable.
 */
export async function loadWorkspaceFileSearchIgnoreRules(
  rootPath: string,
  logger?: WorkspaceFileIgnoreLogger,
): Promise<WorkspaceFileSearchIgnoreRules> {
  const ignorePath = resolve(rootPath, WORKSPACE_FILE_SEARCH_IGNORE_FILE_NAME);

  const degradeToInMemory = async (
    reason: string,
    error: unknown,
  ): Promise<WorkspaceFileSearchIgnoreRules> => {
    const gitignoreContent = await readOptionalFile(resolve(rootPath, GITIGNORE_FILE_NAME)).catch(
      () => null,
    );
    if (gitignoreContent !== null) {
      logger?.warn(
        undefined,
        `[workspace-file-ignore] ${reason}, falling back to .gitignore rules at runtime`,
        error,
      );
      return {
        matcher: buildIgnoreMatcher(gitignoreContent),
        source: "fallback-gitignore",
      };
    }
    logger?.warn(
      undefined,
      `[workspace-file-ignore] ${reason}, falling back to built-in default ignore rules`,
      error,
    );
    const template = buildWorkspaceFileSearchIgnoreTemplate(null);
    return {
      matcher: buildIgnoreMatcher(template),
      source: "fallback-builtin",
    };
  };

  let existing: string | null;
  try {
    existing = await readOptionalFile(ignorePath);
  } catch (error) {
    return degradeToInMemory(`failed to read ${WORKSPACE_FILE_SEARCH_IGNORE_FILE_NAME}`, error);
  }
  if (existing !== null) {
    return { matcher: buildIgnoreMatcher(existing), source: "file" };
  }

  const gitignoreContent = await readOptionalFile(resolve(rootPath, GITIGNORE_FILE_NAME)).catch(
    () => null,
  );
  const initialContent = buildWorkspaceFileSearchIgnoreTemplate(gitignoreContent);
  try {
    await atomicWriteIgnoreFile(ignorePath, initialContent);
  } catch (error) {
    // Failure to create does not affect scanning: the initial content is deterministically known, and the memory is executed directly according to the initial content.
    // The source tag inherits the original content source (.gitignore copy / built-in template) to express fail-open degradation.
    logger?.warn(
      undefined,
      `[workspace-file-ignore] failed to auto-create ${WORKSPACE_FILE_SEARCH_IGNORE_FILE_NAME}, falling back to ${
        gitignoreContent !== null ? ".gitignore" : "built-in default"
      } rules at runtime`,
      error,
    );
    return {
      matcher: buildIgnoreMatcher(initialContent),
      source: gitignoreContent !== null ? "fallback-gitignore" : "fallback-builtin",
    };
  }
  logger?.info(
    undefined,
    `[workspace-file-ignore] auto-created ${WORKSPACE_FILE_SEARCH_IGNORE_FILE_NAME} (source: ${
      gitignoreContent !== null ? ".gitignore copy" : "default template"
    })`,
  );
  return {
    matcher: buildIgnoreMatcher(initialContent),
    source: gitignoreContent !== null ? "created-from-gitignore" : "created-from-template",
  };
}

/**
 * Decides whether a relative path is ignored. Directories must be passed with a trailing slash
 * (gitignore dirOnly rules only match directories), and relativePath is guaranteed by the caller
 * to use posix separators (fileService's normalizeRelativePath already converted it).
 */
export function isWorkspaceFileSearchPathIgnored(
  rules: WorkspaceFileSearchIgnoreRules,
  relativePath: string,
  type: "file" | "directory",
): boolean {
  return type === "directory"
    ? rules.matcher.ignores(`${relativePath}/`)
    : rules.matcher.ignores(relativePath);
}

/** Settings-page read: when the file is missing it returns the initial content preview (source: template) without writing to disk. */
export async function readWorkspaceFileSearchIgnore(
  rootPath: string,
): Promise<WorkspaceFileSearchIgnoreContent> {
  const ignorePath = resolve(rootPath, WORKSPACE_FILE_SEARCH_IGNORE_FILE_NAME);
  const existing = await readOptionalFile(ignorePath);
  if (existing !== null) {
    return { content: existing, source: "file" };
  }
  const gitignoreContent = await readOptionalFile(resolve(rootPath, GITIGNORE_FILE_NAME)).catch(
    () => null,
  );
  return {
    content: buildWorkspaceFileSearchIgnoreTemplate(gitignoreContent),
    source: "template",
  };
}

type WorkspaceFileSearchIgnoreTransform = "sync-gitignore" | "reset-defaults";

/**
 * Settings-page section operation (returns the new content to fill the editor; only saving writes to disk):
 * sync-gitignore only rewrites the gitignore sync section; reset-defaults only resets the default
 * exclusion section; both preserve user content outside the markers — see each pure function's
 * contract for details.
 */
export async function transformWorkspaceFileSearchIgnore(
  rootPath: string,
  transform: WorkspaceFileSearchIgnoreTransform,
): Promise<{ content: string }> {
  const ignorePath = resolve(rootPath, WORKSPACE_FILE_SEARCH_IGNORE_FILE_NAME);
  const existing = await readOptionalFile(ignorePath).catch(() => null);
  const gitignoreContent = await readOptionalFile(resolve(rootPath, GITIGNORE_FILE_NAME)).catch(
    () => null,
  );
  const currentContent = existing ?? buildWorkspaceFileSearchIgnoreTemplate(gitignoreContent);
  const content =
    transform === "sync-gitignore"
      ? syncWorkspaceFileSearchIgnoreFromGitignore(currentContent, gitignoreContent)
      : resetWorkspaceFileSearchIgnoreDefaults(currentContent, gitignoreContent);
  return { content };
}

/** Settings-page save: atomically writes the whole file, so the next scan read is the new content. */
export async function writeWorkspaceFileSearchIgnore(
  rootPath: string,
  content: string,
): Promise<void> {
  const ignorePath = resolve(rootPath, WORKSPACE_FILE_SEARCH_IGNORE_FILE_NAME);
  await atomicWriteIgnoreFile(ignorePath, content);
}
