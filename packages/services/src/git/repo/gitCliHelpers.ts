/* eslint-disable max-lines */
import { access, readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type {
  GitBranchMutationIssue,
  GitChangeKind,
  GitDiffResult,
  GitHeadRefType,
} from "@zcode/shared";
import { normalizeGitPath } from "#src/git/config.js";
import type { GitCommandExecutionResult } from "../providers/gitCommandProvider.js";
import type { GitResolvedRepository, GitStatusEntry } from "./gitCliTypes.js";

function toResultMessage(result: GitCommandExecutionResult): string {
  return result.stderr.trim() || result.stdout.trim() || `exitCode=${result.exitCode ?? "null"}`;
}

function toNormalizedLines(text: string): string[] {
  return text
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.replace(/\s+$/g, ""));
}

function extractIndentedPaths(lines: string[], headerPattern: RegExp): string[] {
  const headerIndex = lines.findIndex((line) => headerPattern.test(line.toLowerCase()));
  if (headerIndex < 0) {
    return [];
  }

  const paths: string[] = [];
  for (let index = headerIndex + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line) {
      continue;
    }

    if (!/^\s+/.test(line)) {
      break;
    }

    const value = line.trim();
    if (value.length > 0) {
      paths.push(normalizeGitPath(value));
    }
  }

  return paths;
}

export function toInvalidBranchNameIssue(detail?: string | null): GitBranchMutationIssue {
  return {
    code: "invalid-branch-name",
    message: "Branch name is invalid.",
    detail: detail?.trim() || null,
  };
}

export function parseGitBranchMutationIssues(
  result: GitCommandExecutionResult,
): GitBranchMutationIssue[] {
  const detail = result.stderr.trim() || result.stdout.trim() || null;
  const lines = toNormalizedLines(detail ?? "");
  const normalizedDetail = detail?.toLowerCase() ?? "";

  // Whether branch switching is blocked will ultimately be determined by the actual error reported by the Git native command.
  // Here we focus on normalizing common stderr into stable issue code to avoid the UI directly relying on the volatile original copy.

  const trackedOverwritePaths = extractIndentedPaths(
    lines,
    /your local changes to the following files would be overwritten by (checkout|switch)/,
  );
  if (trackedOverwritePaths.length > 0) {
    return [
      {
        code: "tracked-changes-would-be-overwritten",
        message: "Tracked changes would be overwritten by switching branches.",
        paths: trackedOverwritePaths,
        detail,
      },
    ];
  }

  const untrackedOverwritePaths = extractIndentedPaths(
    lines,
    /the following untracked working tree files would be overwritten by (checkout|switch)/,
  );
  if (untrackedOverwritePaths.length > 0) {
    return [
      {
        code: "untracked-changes-would-be-overwritten",
        message: "Untracked files would be overwritten by switching branches.",
        paths: untrackedOverwritePaths,
        detail,
      },
    ];
  }

  if (normalizedDetail.includes("already exists")) {
    return [
      {
        code: "branch-already-exists",
        message: "Branch already exists.",
        detail,
      },
    ];
  }

  if (normalizedDetail.includes("invalid reference:")) {
    return [
      {
        code: "target-branch-not-found",
        message: "Target branch was not found.",
        detail,
      },
    ];
  }

  if (normalizedDetail.includes("is already used by worktree at")) {
    return [
      {
        code: "branch-in-other-worktree",
        message: "Branch is already checked out in another worktree.",
        detail,
      },
    ];
  }

  if (normalizedDetail.includes("resolve your current index first")) {
    return [
      {
        code: "conflicts-present",
        message: "Repository still has unresolved conflicts.",
        detail,
      },
    ];
  }

  if (
    /cannot switch branch while (merging|rebasing|cherry-picking|reverting|bisecting)/.test(
      normalizedDetail,
    ) ||
    normalizedDetail.includes("you have not concluded your merge") ||
    normalizedDetail.includes("rebase in progress")
  ) {
    return [
      {
        code: "operation-in-progress",
        message: "Another Git operation is still in progress.",
        detail,
      },
    ];
  }

  return [
    {
      code: "unknown",
      message: "Git could not complete the branch operation.",
      detail,
    },
  ];
}

export function ensureGitCommandSucceeded(
  label: string,
  result: GitCommandExecutionResult,
  allowedExitCodes: number[] = [0],
): GitCommandExecutionResult {
  if (result.timedOut) {
    // The timeout threshold and the total process cleanup time are not the same thing; both are retained in the log.
    // Avoid misinterpreting the scenario of "15s triggering timeout and then waiting for cleanup" as actually configuring a longer timeout.
    const timeoutMs = result.timeoutMs ?? result.durationMs;
    const details = [`elapsed=${result.durationMs}ms`];
    if (result.timeoutElapsedMs !== undefined) {
      details.push(`killAt=${result.timeoutElapsedMs}ms`);
    }
    if (result.timeoutCloseDelayMs !== undefined) {
      details.push(`cleanup=${result.timeoutCloseDelayMs}ms`);
    }
    if (result.forceKillAttempted) {
      details.push("forceKill=true");
    }
    if (result.orphaned) {
      details.push("orphaned=true");
    }
    throw new Error(`${label} timed out after ${timeoutMs}ms (${details.join(", ")})`);
  }

  if (result.outputTruncated) {
    throw new Error(`${label} output exceeded limit`);
  }

  if (allowedExitCodes.includes(result.exitCode ?? Number.NaN)) {
    return result;
  }

  throw new Error(`${label} failed: ${toResultMessage(result)}`);
}

// Status-entry kind derivation — shared by the commit path's
// parseStatusPorcelain and the native status assembly in gitCliRepo (spec:
// docs/specs/rust-native-git.md keeps this helper alive for both).
export function inferKindFromStatusCode(statusCode: string): GitChangeKind {
  if (statusCode === "A" || statusCode === "?") {
    return "added";
  }

  if (statusCode === "D") {
    return "deleted";
  }

  if (statusCode === "R" || statusCode === "C") {
    return "renamed";
  }

  return "modified";
}

function parseBranchAheadBehind(value: string): { ahead: number; behind: number } {
  const aheadMatch = value.match(/\+(\d+)/);
  const behindMatch = value.match(/-(\d+)/);
  return {
    ahead: aheadMatch ? Number.parseInt(aheadMatch[1]!, 10) : 0,
    behind: behindMatch ? Number.parseInt(behindMatch[1]!, 10) : 0,
  };
}

export function parseStatusPorcelain(stdout: string): {
  branchName: string | null;
  trackingBranchName: string | null;
  headRefType: GitHeadRefType;
  ahead: number;
  behind: number;
  entries: GitStatusEntry[];
} {
  const records = stdout.split("\0").filter((record) => record.length > 0);
  const entries: GitStatusEntry[] = [];
  let branchName: string | null = null;
  let trackingBranchName: string | null = null;
  let headRefType: GitHeadRefType = "branch";
  let ahead = 0;
  let behind = 0;

  // The value of `git status --porcelain=v2 -z` is that the format is stable and is not affected by the local language.
  // Here we do a centralized analysis and block low-level details such as branch/header/rename/unmerged in the repo layer.
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]!;
    if (record.startsWith("# ")) {
      if (record.startsWith("# branch.head ")) {
        const head = record.slice("# branch.head ".length);
        if (head === "(detached)") {
          branchName = null;
          headRefType = "detached";
        } else {
          branchName = head;
          headRefType = "branch";
        }
      } else if (record.startsWith("# branch.upstream ")) {
        trackingBranchName = record.slice("# branch.upstream ".length);
      } else if (record.startsWith("# branch.ab ")) {
        const parsed = parseBranchAheadBehind(record.slice("# branch.ab ".length));
        ahead = parsed.ahead;
        behind = parsed.behind;
      }
      continue;
    }

    if (record.startsWith("? ")) {
      entries.push({
        path: normalizeGitPath(record.slice(2)),
        originalPath: null,
        kind: "added",
        x: null,
        y: "?",
        isUntracked: true,
        isConflicted: false,
      });
      continue;
    }

    if (record.startsWith("1 ")) {
      const match = record.match(/^1 ([^ ]{2}) [^ ]+ [^ ]+ [^ ]+ [^ ]+ [^ ]+ [^ ]+ (.+)$/);
      if (!match) {
        continue;
      }

      const xy = match[1]!;
      entries.push({
        path: normalizeGitPath(match[2]!),
        originalPath: null,
        kind: inferKindFromStatusCode(xy[0] !== "." ? xy[0]! : xy[1]!),
        x: xy[0]!,
        y: xy[1]!,
        isUntracked: false,
        isConflicted: false,
      });
      continue;
    }

    if (record.startsWith("2 ")) {
      const match = record.match(/^2 ([^ ]{2}) [^ ]+ [^ ]+ [^ ]+ [^ ]+ [^ ]+ [^ ]+ [^ ]+ (.+)$/);
      if (!match) {
        continue;
      }

      const originalPath = records[index + 1] ?? null;
      index += 1;
      entries.push({
        path: normalizeGitPath(match[2]!),
        originalPath: originalPath ? normalizeGitPath(originalPath) : null,
        kind: "renamed",
        x: match[1]![0]!,
        y: match[1]![1]!,
        isUntracked: false,
        isConflicted: false,
      });
      continue;
    }

    if (!record.startsWith("u ")) {
      continue;
    }

    const match = record.match(
      /^u ([^ ]{2}) [^ ]+ [^ ]+ [^ ]+ [^ ]+ [^ ]+ [^ ]+ [^ ]+ [^ ]+ (.+)$/,
    );
    if (!match) {
      continue;
    }

    entries.push({
      path: normalizeGitPath(match[2]!),
      originalPath: null,
      kind: "modified",
      x: match[1]![0]!,
      y: match[1]![1]!,
      isUntracked: false,
      isConflicted: true,
    });
  }

  return { branchName, trackingBranchName, headRefType, ahead, behind, entries };
}

export async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function splitUntrackedText(content: string): {
  lines: string[];
  hasTrailingNewline: boolean;
} {
  const normalizedContent = content.replace(/\r\n/g, "\n");
  if (normalizedContent.length === 0) {
    return {
      lines: [],
      hasTrailingNewline: false,
    };
  }

  const hasTrailingNewline = normalizedContent.endsWith("\n");
  const lines = normalizedContent.split("\n");
  if (hasTrailingNewline) {
    lines.pop();
  }

  return {
    lines,
    hasTrailingNewline,
  };
}

export async function buildUntrackedTextDiffResult(
  absolutePath: string,
  repoRelativePath: string,
  maxPreviewBytes: number,
): Promise<GitDiffResult | null> {
  try {
    const content = await readFile(absolutePath);

    // Patches of untracked files cannot be generated by relying on `git diff --no-index`.
    // This type of patch will bring platform-specific headers on Windows, and `@pierre/diffs` will work with certain `diff --git`
    // The header format itself also has compatibility issues, and will eventually throw an exception directly when the UI is expanded.
    // Here, we return to the most stable unified diff form and only retain the `---/+++ / @@` information that is really needed for single file preview.
    if (content.includes(0)) {
      return {
        path: absolutePath,
        availability: "binary",
        patch: null,
        beforeContent: null,
        afterContent: null,
        summary: "Binary diff is not previewable.",
      };
    }

    if (content.byteLength > maxPreviewBytes) {
      return {
        path: absolutePath,
        availability: "truncated",
        patch: null,
        beforeContent: null,
        afterContent: null,
        summary: "Git diff output exceeded the preview limit.",
      };
    }

    const normalizedPath = normalizeGitPath(repoRelativePath);
    const { lines, hasTrailingNewline } = splitUntrackedText(content.toString("utf-8"));
    const patchLines = ["--- /dev/null", `+++ b/${normalizedPath}`];

    if (lines.length > 0) {
      patchLines.push(`@@ -0,0 +1,${lines.length} @@`);
      patchLines.push(...lines.map((line) => `+${line}`));
      if (!hasTrailingNewline) {
        patchLines.push("\\ No newline at end of file");
      }
    }

    return {
      path: absolutePath,
      availability: "patch",
      patch: `${patchLines.join("\n")}\n`,
      beforeContent: "",
      afterContent: content.toString("utf-8"),
      summary: null,
    };
  } catch {
    return null;
  }
}

function isBinaryDiff(stdout: string): boolean {
  return stdout.includes("GIT binary patch") || stdout.includes("Binary files ");
}

export function toDiffResult(
  path: string,
  result: GitCommandExecutionResult,
  options?: {
    allowedExitCodes?: number[];
    emptySummary?: string;
    binarySummary?: string;
  },
): GitDiffResult {
  if (result.timedOut) {
    return {
      path,
      availability: "unavailable",
      patch: null,
      beforeContent: null,
      afterContent: null,
      summary: "Git diff command timed out.",
    };
  }

  if (result.outputTruncated) {
    return {
      path,
      availability: "truncated",
      patch: null,
      beforeContent: null,
      afterContent: null,
      summary: "Git diff output exceeded the preview limit.",
    };
  }

  const allowedExitCodes = options?.allowedExitCodes ?? [0];
  if (!allowedExitCodes.includes(result.exitCode ?? Number.NaN)) {
    return {
      path,
      availability: "unavailable",
      patch: null,
      beforeContent: null,
      afterContent: null,
      summary: toResultMessage(result),
    };
  }

  if (!result.stdout.trim()) {
    return {
      path,
      availability: "unavailable",
      patch: null,
      beforeContent: null,
      afterContent: null,
      summary: options?.emptySummary ?? "No diff output available.",
    };
  }

  if (isBinaryDiff(result.stdout)) {
    return {
      path,
      availability: "binary",
      patch: null,
      beforeContent: null,
      afterContent: null,
      summary: options?.binarySummary ?? "Binary diff is not previewable.",
    };
  }

  return {
    path,
    availability: "patch",
    patch: result.stdout,
    beforeContent: null,
    afterContent: null,
    summary: null,
  };
}

export async function normalizeInputPath(
  resolution: GitResolvedRepository,
  path: string,
): Promise<string> {
  const rawAbsolutePath = isAbsolute(path)
    ? path
    : resolve(resolution.workspacePath, path.split("/").join(sep));
  const absolutePath = await realpath(rawAbsolutePath).catch(() => rawAbsolutePath);
  const repoRelativePath = normalizeGitPath(relative(resolution.repoRoot, absolutePath));
  if (
    repoRelativePath.length === 0 ||
    repoRelativePath === "." ||
    repoRelativePath === ".." ||
    repoRelativePath.startsWith("../")
  ) {
    throw new Error(`Path is outside repository scope: ${path}`);
  }

  return repoRelativePath;
}

export function ensureRepositoryAvailable(
  resolution: GitResolvedRepository,
  label: string,
): GitResolvedRepository {
  if (!resolution.isGitAvailable) {
    throw new Error(`Cannot ${label}: Git binary is not available`);
  }

  if (!resolution.isRepository) {
    throw new Error(`Cannot ${label}: workspace is not inside a Git repository`);
  }

  return resolution;
}
