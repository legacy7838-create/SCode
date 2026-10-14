// Reference implementation of the PRE-PORT workspace scan, preserved verbatim for the parity gate.
//
// This file is deliberately NOT production code and must never be imported by the app. It exists so
// `read_parity.mts` can diff the retired JavaScript walk against the Rust `zcode-scan` addon on the
// same real workspace and prove the packed index is byte-identical.
//
// It is a faithful transcription of what used to live inside
// `packages/services/src/file/fileService.ts` (`ensureWorkspaceFileIndex`'s `scanning` closure)
// plus the two helpers it called. Nothing here may be "improved": any divergence from the original
// would make the parity result meaningless.
//
// Run from the repo root:
//   node_modules/.bin/tsx packages/desktop/zcode-scan/harness/reference_scan.mts <root> [rulesFile]
import { readdir, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import ignoreFactory, { type Ignore } from "ignore";

const WORKSPACE_FILE_SEARCH_IGNORE_FILE_NAME = ".zcodeignore";
const WORKSPACE_FILE_LIST_SCAN_CONCURRENCY = 8;

type EntryType = "file" | "directory";

interface WorkspaceFileEntry {
  name: string;
  path: string;
  relativePath: string;
  type: EntryType;
}

/** `normalizeRelativePath` — fileService.ts:115 */
function normalizeRelativePath(rootPath: string, targetPath: string): string {
  return relative(rootPath, targetPath).split(sep).join("/");
}

/** `isSkippableWorkspaceFileListError` — fileService.ts:118 */
function isSkippableWorkspaceFileListError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === "EACCES" || code === "EPERM" || code === "ENOENT";
}

/** `resolveReaddirEntryType` — fileService.ts:176 */
async function resolveReaddirEntryType(
  entryPath: string,
  isDirectory: boolean,
  isSymbolicLink: boolean,
): Promise<EntryType> {
  if (isDirectory) return "directory";
  if (!isSymbolicLink) return "file";
  try {
    const targetStat = await stat(entryPath);
    return targetStat.isDirectory() ? "directory" : "file";
  } catch {
    return "file";
  }
}

// --- defaultWorkspaceFileSearchFilter, with `ignoreRulesActive: true` (fileService.ts:327) ----
// The context flag is hardcoded `true` at the only call site, so the directory blacklist in the
// original was already dead on this path; only the hidden-directory and file rules were live.

const SKIPPED_FILE_NAMES = new Set(["coverage.out", "lcov.info"]);
const SKIPPED_FILE_EXTENSIONS = new Set([
  ".a",
  ".aar",
  ".beam",
  ".class",
  ".dll",
  ".dylib",
  ".ear",
  ".exe",
  ".gcda",
  ".gcno",
  ".gem",
  ".hi",
  ".idb",
  ".ilk",
  ".jar",
  ".lib",
  ".node",
  ".nupkg",
  ".o",
  ".obj",
  ".pdb",
  ".profdata",
  ".profraw",
  ".pyc",
  ".pyo",
  ".rlib",
  ".so",
  ".tsbuildinfo",
  ".war",
]);

/** `shouldSkipFile` — workspaceFileMentionFilter.ts:130 */
function shouldSkipFile(name: string): boolean {
  const normalizedName = name.toLowerCase();
  return (
    normalizedName === ".env" ||
    normalizedName.startsWith(".env.") ||
    SKIPPED_FILE_NAMES.has(normalizedName) ||
    SKIPPED_FILE_EXTENSIONS.has(extnameLower(normalizedName))
  );
}

/** Node's `path.extname`, lowercased; a leading dot is a dotfile, not an extension. */
function extnameLower(name: string): string {
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return "";
  return name.slice(dot);
}

/** `isInsideHiddenDirectory` + the entry-name check — workspaceFileMentionFilter.ts:133 */
function isHiddenDirectory(name: string, relativePath: string): boolean {
  if (name.startsWith(".")) return true;
  const segments = relativePath.split("/");
  return segments.slice(0, -1).some((segment) => segment.startsWith("."));
}

/** `isWorkspaceFileSearchPathIgnored` — workspaceFileIgnore.ts:369 */
function isPathIgnored(matcher: Ignore, relativePath: string, type: EntryType): boolean {
  return type === "directory" ? matcher.ignores(`${relativePath}/`) : matcher.ignores(relativePath);
}

/** `escapeField` — packages/shared/src/workspaceFileEntriesCodec.ts */
function escapeField(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\t/g, "\\t").replace(/\n/g, "\\n");
}

/** `packWorkspaceFileEntries` — packages/shared/src/workspaceFileEntriesCodec.ts */
function packWorkspaceFileEntries(entries: readonly WorkspaceFileEntry[]): string {
  const lines: string[] = [];
  for (const entry of entries) {
    lines.push(`${entry.type}\t${escapeField(entry.relativePath)}`);
  }
  return lines.join("\n");
}

export interface ReferenceScanResult {
  packed: string;
  entries: WorkspaceFileEntry[];
  elapsedMs: number;
}

/**
 * Run the retired JavaScript scan and return its packed index.
 *
 * @param rootPath workspace root to walk
 * @param ignoreRuleText verbatim `.zcodeignore` content; empty means "no rules"
 * @param locale collator locale, forwarded to `localeCompare` so the reference uses the same
 *               collation the Rust side is handed
 */
export async function referenceScan(
  rootPath: string,
  ignoreRuleText: string,
  locale: string,
): Promise<ReferenceScanResult> {
  const matcher = ignoreFactory().add(ignoreRuleText);
  const startedAt = performance.now();

  const entries: WorkspaceFileEntry[] = [];
  const pendingDirectories: string[] = [rootPath];

  const traverseWorker = async (): Promise<void> => {
    for (;;) {
      const currentPath = pendingDirectories.pop();
      if (!currentPath) return;
      let children;
      try {
        children = await readdir(currentPath, { withFileTypes: true });
      } catch (error) {
        if (isSkippableWorkspaceFileListError(error)) continue;
        throw error;
      }
      for (const entry of children) {
        const entryPath = join(currentPath, entry.name);
        const relativePath = normalizeRelativePath(rootPath, entryPath);
        if (relativePath === WORKSPACE_FILE_SEARCH_IGNORE_FILE_NAME) continue;
        const type = await resolveReaddirEntryType(
          entryPath,
          entry.isDirectory(),
          entry.isSymbolicLink(),
        );
        if (isPathIgnored(matcher, relativePath, type)) continue;
        if (type === "directory") {
          if (!isHiddenDirectory(entry.name, relativePath)) {
            entries.push({ name: entry.name, path: entryPath, relativePath, type });
          }
          if (!entry.isSymbolicLink()) pendingDirectories.push(entryPath);
        } else if (!shouldSkipFile(entry.name)) {
          entries.push({ name: entry.name, path: entryPath, relativePath, type });
        }
      }
    }
  };
  await Promise.all(
    Array.from({ length: WORKSPACE_FILE_LIST_SCAN_CONCURRENCY }, () => traverseWorker()),
  );

  const sorted = entries.sort((left, right) => {
    if (left.type !== right.type) {
      return left.type === "directory" ? -1 : 1;
    }
    return locale
      ? left.relativePath.localeCompare(right.relativePath, locale)
      : left.relativePath.localeCompare(right.relativePath);
  });

  return {
    packed: packWorkspaceFileEntries(sorted),
    entries: sorted,
    elapsedMs: performance.now() - startedAt,
  };
}

// Direct invocation: print the packed string to stdout for shell-level spot checks.
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/"))) {
  const [, , root = process.cwd(), rulesFile, localeArg] = process.argv;
  const { readFileSync } = await import("node:fs");
  const rules = rulesFile ? readFileSync(rulesFile, "utf8") : "";
  const locale = localeArg ?? new Intl.Collator().resolvedOptions().locale;
  const result = await referenceScan(root, rules, locale);
  process.stdout.write(result.packed);
}
