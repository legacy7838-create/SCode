import { extname } from "node:path";

const SKIPPED_DIRECTORY_NAMES = new Set([
  ".git",
  ".hg",
  ".svn",
  "node_modules",
  "bower_components",
  "jspm_packages",
  "__pycache__",
  "site-packages",
  "venv",
  "coverage",
  "htmlcov",
  "lcov-report",
  "cmakefiles",
  "pods",
  "deriveddata",
  "storybook-static",
  "playwright-report",
  "test-results",
  "allure-results",
  "allure-report",
  "cdk.out",
  "eggs",
  "pip-wheel-metadata",
  "wheels",
]);
const SKIPPED_DIRECTORY_PREFIXES = ["cmake-build-", "bazel-"];
const SKIPPED_DIRECTORY_SUFFIXES = [".egg-info", ".dist-info"];
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

export interface WorkspaceFileSearchEntry {
  name: string;
  path: string;
  relativePath: string;
  type: "file" | "directory";
}

export interface WorkspaceFileSearchDecision {
  include: boolean;
  traverse: boolean;
}

export interface WorkspaceFileSearchFilterContext {
  /**
   * True when `.zcodeignore` rules loaded successfully: the rule file is the single source of
   * truth for directory exclusions and the built-in directory blacklist is retired (removing
   * node_modules/ from the file must restore searching); only file-level rules (.env/binary
   * suffixes) and hidden-directory semantics keep stacking on top.
   * In the fail-open case (rule file entirely unavailable) it is false/absent and the
   * blacklist still applies as a fallback.
   */
  ignoreRulesActive: boolean;
}

/**
 * The workspace file index depends only on this final filter and does not care whether rules
 * come from the built-in list, a config file or the settings page.
 * Future custom rules should inject another complete implementation to replace the default
 * one, rather than being forced into a union with the default blacklist.
 */
export interface WorkspaceFileSearchFilter {
  evaluate(
    entry: WorkspaceFileSearchEntry,
    context?: WorkspaceFileSearchFilterContext,
  ): WorkspaceFileSearchDecision;
}

function shouldSkipDirectory(name: string): boolean {
  const normalizedName = name.toLowerCase();
  return (
    SKIPPED_DIRECTORY_NAMES.has(normalizedName) ||
    SKIPPED_DIRECTORY_PREFIXES.some((prefix) => normalizedName.startsWith(prefix)) ||
    SKIPPED_DIRECTORY_SUFFIXES.some((suffix) => normalizedName.endsWith(suffix))
  );
}

function shouldSkipFile(name: string): boolean {
  const normalizedName = name.toLowerCase();
  return (
    normalizedName === ".env" ||
    normalizedName.startsWith(".env.") ||
    SKIPPED_FILE_NAMES.has(normalizedName) ||
    SKIPPED_FILE_EXTENSIONS.has(extname(normalizedName))
  );
}

function isInsideHiddenDirectory(relativePath: string): boolean {
  const segments = relativePath.split("/");
  const directorySegments = segments.slice(0, -1);
  return directorySegments.some((segment) => segment.startsWith("."));
}

export const defaultWorkspaceFileSearchFilter: WorkspaceFileSearchFilter = {
  evaluate(entry, context) {
    if (entry.type === "directory") {
      // Directory blacklist decommissioning when ignoreRulesActive: the only source of directory exclusion is the .zcodeignore rule file.
      if (!context?.ignoreRulesActive && shouldSkipDirectory(entry.name)) {
        return { include: false, traverse: false };
      }
      // If you encounter any hidden directory and prune the entire tree, valid files in .github and other directories cannot be searched by name.
      // Hidden directories and their subordinate directories do not account for the candidate list, but are retained for traversal and allow ordinary files in them to enter the index.
      const hiddenDirectory =
        entry.name.startsWith(".") || isInsideHiddenDirectory(entry.relativePath);
      return { include: !hiddenDirectory, traverse: true };
    }

    return { include: !shouldSkipFile(entry.name), traverse: false };
  },
};
