// ============================================================
// git.* world reads: read-only **by construct**
// ============================================================
// This module is the **pure** half of git world-read: argument verification, fixed argv construction, and porcelain-v2/
// log/parsing of path list output. Side effects (really spawning out a git) remain in workflow-world-read.ts.
//
// Why split it into a pure module: Each item here is a property that can be pinned separately - "The argv of this op happens to be these
// element", "branch is absent when detached HEAD", "`-foo` is rejected as base", "filenames with newlines are passed through unchanged".
// If they are placed on the execution side, they can only be asserted indirectly through a fake port; if they are placed here, they can be asserted directly.
//
// ————————————————————————————————————————————————————————————————
// Read-only is **constructed**, not checked.
// ————————————————————————————————————————————————————————————————
// This module can only construct the argv of five allowed subcommands. There is no path that spells out the shell string, nor is there a
// Treat the string given by the script directly as a subcommand or option: base ref passes a strict character set (the first character `-` is prohibited, and the `..` interval is prohibited),
// path must be relative to the workspace and not out of bounds, and always comes after `--`. So "can't write it in" is what this code can express
// The nature of the thing, not a permissions check that might someday be forgotten.
//
// ————————————————————————————————————————————————————————————————
// Two output contracts that run through the entire module (both are measured in practice, not inferred from documents)
// ————————————————————————————————————————————————————————————————
// **1. `-z`: NUL separated, the path is byte by byte as it is. ** When `-z` is not added, `core.quotePath` defaults to true, and git will
// Non-ASCII path C references plus octal escaping - `document.md` becomes a string of `"\346\226\207..."`. This user in this repository
// The body is the norm rather than the corner. `-z` solves two things at once: paths are no longer quote-escaped, and filenames with newlines are no longer
// Destruction of splitting by row (cutting by row will split it into two non-existent paths without any error - "rare and silent error" is exactly
// Failure patterns not accepted by this code). Our own `git log` has also used `%x00` to separate fields, so the whole family is consistent.
//
// **2. The path is always handed over as "relative to the workspace", and the conversion is done once on our side. ** Actual measurement: `-z` will make
// `status --porcelain=v2` outputs the **repository root relative** path, and no flag or config can change it back to cwd relative
// (`status.relativePaths` is invalid for porcelain -z); `diff --name-only` defaults to relative to the warehouse root; and
// `ls-files --others` defaults to **cwd relative**. Three commands and three benchmarks.
//
// So here is a unified rule: **Online, always take the relative position of the warehouse root** (`ls-files` complement `--full-name` for alignment),
// Use `rev-parse --show-prefix` again to get the prefix of the workspace relative to the repository root and strip it off during parsing. This way
// There is only one "baseline" in one place, rather than three commands each relying on a different git default - that mash-up is exactly that
// A bug that causes `changedFiles()` to spit out two base paths at the same time (the three are exactly the same when the workspace is the warehouse root.
// So it will remain undiscovered until a workspace is a subdirectory).
//
// The only exception is the **patch text** of `git.diff`: it is not a list of paths we parse, but a paragraph with `a/… b/…`
// The overall output of the header, there is no way to strip the prefix afterwards. That one therefore uses git's own `--relative` to align the bases.

import { WorkflowError } from "@zcode/dynamic-workflow";

/**
 * One command to run for a git world read. `argv` does not include `"git"` itself — the executable name is supplied by the execution side,
 * which keeps this module entirely free of process handling.
 */
interface GitCommandPlan {
  readonly argv: readonly string[];
}

/** The return shape of `git.status()`. The authoritative declaration is `declare interface GitStatus` in FACADE_DTS. */
export interface GitStatusResult {
  branch?: string;
  clean: boolean;
  staged: string[];
  unstaged: string[];
  untracked: string[];
}

/** One record of `git.log()`. The authoritative declaration is `declare interface GitCommit` in FACADE_DTS. */
export interface GitCommitResult {
  hash: string;
  subject: string;
  author: string;
  date: string;
}

/**
 * The strict character set for a base ref: the first character must be a letter/digit, and `[A-Za-z0-9._/@^~-]` is allowed after it.
 *
 * Forbidding `-` as the first character is the only **security-relevant** part of this rule: git would treat `-foo` as an option rather than a ref,
 * and which options exist is not for us to decide. The first character may not be `.` either, which incidentally blocks `.` / `..` — inputs that are
 * neither valid refs nor anything that looks like a range.
 *
 * Deliberately excluded: whitespace (there is no legitimate reason for a ref to contain it), `{`/`}` (reflog syntax such as `@{u}`, which
 * v1 does not support), `:` (the `ref:path` syntax), and any `..` (a range — v1 accepts only a **single** ref). None of these are "dangerous", they merely fall outside the semantics v1 promised; accepting them would mean
 * letting scripts depend on a contract nobody ever wrote down.
 */
const GIT_REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/@^~-]*$/;

/** The field format for `git log`: NUL-separated hash / subject / author name / author date (ISO-8601). */
const GIT_LOG_PRETTY = "--pretty=format:%H%x00%s%x00%an%x00%aI";

/**
 * The prefix of the workspace relative to the repository root (`"sub/nested/"`; the empty string at the repository root). This is the only basis for converting repo-root-relative paths
 * into workspace-relative paths, see output contract 2 at the top of this module.
 */
export const GIT_SHOW_PREFIX_ARGV: readonly string[] = ["rev-parse", "--show-prefix"];

/**
 * The fixed argv for `git status`. `--branch` is the source of GitStatus.branch; `-- .` confines the observation scope to
 * inside the workspace (see {@link WORKSPACE_PATHSPEC}).
 */
export const GIT_STATUS_ARGV: readonly string[] = [
  "status",
  "--porcelain=v2",
  "-z",
  "--branch",
  "--",
  ".",
];

/**
 * The fixed argv for untracked files. `--exclude-standard` makes it respect .gitignore; `--full-name` lifts it from
 * cwd-relative to repo-root-relative, aligning it with status / diff (output contract 2 at the top of this module).
 */
const GIT_UNTRACKED_ARGV: readonly string[] = [
  "ls-files",
  "--others",
  "--exclude-standard",
  "-z",
  "--full-name",
  "--",
  ".",
];

/**
 * The workspace pathspec. git.* is a **world read**, and this workflow's "world" is the workspace everywhere:
 * files.glob/read/grep are workspace-scoped, actor sub-sessions run with the workspace as cwd, and permission tiers are workspace-scoped too.
 * So git's observation is confined to that same world — otherwise `changedFiles()` would hand out paths outside the workspace, and
 * the most obvious two-line combination `changedFiles() → files.read(p)` would become a trap.
 *
 * The cost (deliberately accepted in v1): when the workspace is a subdirectory of the repository, changes outside that subdirectory are invisible.
 */
const WORKSPACE_PATHSPEC = ".";

/**
 * Validates a base ref and returns the original string. A shape mismatch produces a structured `DriverError` (node level, so scripts can `catch` it).
 * The error message explains **why** it was rejected, because the script-writing side has to rewrite accordingly rather than guess.
 */
function validateGitRef(op: string, value: string): string {
  if (value.length === 0) {
    throw new WorkflowError(
      "DriverError",
      `world-read ${op}: base must not be empty. Pass a ref such as "main" or omit it.`,
    );
  }
  if (value.startsWith("-")) {
    throw new WorkflowError(
      "DriverError",
      `world-read ${op}: base '${value}' starts with '-', which git would read as an option, ` +
        `not a ref. Pass a plain ref.`,
    );
  }
  if (value.includes("..")) {
    throw new WorkflowError(
      "DriverError",
      `world-read ${op}: base '${value}' is a '..' range; only a single ref is accepted. Pass ` +
        `one ref.`,
    );
  }
  if (!GIT_REF_PATTERN.test(value)) {
    throw new WorkflowError(
      "DriverError",
      `world-read ${op}: base '${value}' is not a valid ref. A ref starts with a letter or ` +
        `digit, followed by letters, digits and . _ / @ ^ ~ - (no whitespace or syntax ` +
        `characters such as {} :).`,
    );
  }
  return value;
}

/**
 * Validates a workspace-relative path and returns the normalized string (separators unified to `/`).
 *
 * Three rules, all of them **lexical confinement** (symbolic links are not followed, see the v1 notes): no absolute paths, no leading `-`,
 * no `..` segments. The third one is this side's out-of-bounds check: in the normalized form of `relative`, `..` can only ever appear
 * at the beginning, so "no `..` segments and not absolute" is equivalent to "still inside the workspace after resolution".
 *
 * A leading `-` is rejected even though it would already be safe after `--`: this is defense in depth — the day `--` gets dropped somewhere,
 * a path like `-foo` is an option.
 */
function validateGitPath(op: string, value: string): string {
  if (value.length === 0) {
    throw new WorkflowError(
      "DriverError",
      `world-read ${op}: path must not be empty. Pass a workspace-relative path or omit it.`,
    );
  }
  if (value.startsWith("-")) {
    throw new WorkflowError(
      "DriverError",
      `world-read ${op}: path '${value}' starts with '-', which git could read as an option. ` +
        `Pass a path that does not start with '-'.`,
    );
  }
  if (looksAbsolute(value)) {
    throw new WorkflowError(
      "DriverError",
      `world-read ${op}: path '${value}' is absolute; only workspace-relative paths are ` +
        `accepted. Pass the path relative to the workspace root.`,
    );
  }
  // The delimiters are unified into `/`: git's pathspec eats `/` on all three platforms, and the model is written in windows style
  // Relative paths are commonplace. Normalization must be done before `..` is checked, otherwise `..\x` will slip through the segmentation.
  const normalized = value.replace(/\\/g, "/");
  if (normalized.split("/").includes("..")) {
    throw new WorkflowError(
      "DriverError",
      `world-read ${op}: path '${value}' contains a '..' segment and would leave the ` +
        `workspace. Pass a path inside the workspace.`,
    );
  }
  return normalized;
}

/**
 * Absolute-path detection that **does not depend on the current platform**: the posix version of `node:path` does not recognize `C:\x`, and this check has to give
 * the same answer on all three platforms (cross-platform principle: do not implement against the dev machine's system behaviour).
 */
function looksAbsolute(value: string): boolean {
  return value.startsWith("/") || value.startsWith("\\") || /^[A-Za-z]:[\\/]?/.test(value);
}

/**
 * The commands `git.changedFiles(base?)` has to run.
 *
 * Without a base it is the union of **two** commands: `diff --name-only HEAD` plus `ls-files --others
 * --exclude-standard`. An untracked file is a change as far as a reader is concerned, and leaving them out would make this primitive useless on a freshly opened
 * feature branch (at that point nearly every new file is still untracked).
 *
 * With a base it is only one: `diff --name-only <base>`. "What changed relative to some ref" is a question about
 * **tracked history** — a file that never entered git cannot be compared against any ref.
 */
export function gitChangedFilesPlan(base: string | undefined): GitCommandPlan[] {
  const ref = base === undefined ? "HEAD" : validateGitRef("git-changed-files", base);
  const tracked: GitCommandPlan = {
    argv: ["diff", "--name-only", "-z", ref, "--", WORKSPACE_PATHSPEC],
  };
  if (base !== undefined) return [tracked];
  return [tracked, { argv: [...GIT_UNTRACKED_ARGV] }];
}

/**
 * The argv for `git.diff(base?, path?)`. base defaults to `HEAD`; path defaults to the workspace pathspec `.`,
 * and is **always** placed after `--`, so that a path which happens to share a name with a branch is not read by git as a ref (and neither is the reverse).
 *
 * `--relative` is required here, for a different reason than elsewhere: the `a/… b/…` headers in the patch text are written by git itself,
 * we do not parse them and cannot strip the prefix afterwards, so the only option is to have git emit relative to cwd (= the workspace). Without it,
 * `changedFiles()` says "only a.md changed" while `diff()` hands over a repo-level patch containing `../x` — the two primitives would
 * give different answers to "what counts as a change".
 *
 * `--relative` itself also excludes changes outside cwd, so `-- .` is redundant when there is no path. **The redundancy is intentional**:
 * scope confinement must not silently depend on another flag's side effect; writing it out is what lets argv tests pin it down.
 */
export function gitDiffArgv(base: string | undefined, path: string | undefined): string[] {
  const ref = base === undefined ? "HEAD" : validateGitRef("git-diff", base);
  const pathspec = path === undefined ? WORKSPACE_PATHSPEC : validateGitPath("git-diff", path);
  return ["diff", "--relative", ref, "--", pathspec];
}

/**
 * The argv for `git.log(count)`. count is validated by the caller and clamped into [1, cap].
 *
 * **Deliberately carries no pathspec, asymmetrically with the rest of this op family.** A commit is a repo-level object; giving log a
 * pathspec would change its semantics into "the commits that touched the workspace", which is a different question nobody ever asked. log reads
 * historical metadata (hash / subject / author / date), not paths in the workspace, so workspace confinement has no
 * object to apply to.
 */
export function gitLogArgv(count: number): string[] {
  return ["log", `-n${count}`, GIT_LOG_PRETTY];
}

/** The output of `rev-parse --show-prefix` → the prefix string (the empty string at the repository root). */
export function parseGitShowPrefix(stdout: string): string {
  return stdout.replace(/\r?\n$/, "");
}

/**
 * Splits `-z` output into segments: split on NUL and drop the empty segments (the trailing NUL terminator leaves one behind).
 *
 * Dropping empty segments is safe and does not affect the two-segment consumption of rename entries: a path is never the empty string, so an empty segment
 * can only come from the terminator itself.
 */
function nulSegments(stdout: string): string[] {
  return stdout.split("\u0000").filter((segment) => segment.length > 0);
}

/**
 * Strips the workspace prefix, converting a repo-root-relative path into a **workspace-relative** one (output contract 2 at the top of this module).
 *
 * A path outside the prefix **fails loudly** instead of being handed through as-is. `-- .` already guarantees every path is inside the workspace, so
 * getting here means some assumption has collapsed; handing a script a path carrying `../` is exactly what this confinement exists to prevent,
 * and the script will feed it to `files.read`. Better for the node to fail.
 */
function stripWorkspacePrefix(prefix: string, path: string): string {
  if (prefix.length === 0) return path;
  if (path.startsWith(prefix)) return path.slice(prefix.length);
  throw new WorkflowError(
    "DriverError",
    `git reported path '${path}' outside the workspace prefix '${prefix}'. The pathspec should ` +
      `have scoped the read to the workspace, so the scoping is broken; report this as a bug.`,
  );
}

/**
 * Parses `git status --porcelain=v2 -z --branch -- .`.
 *
 * The first character of a segment is the record type: `#` header, `1` ordinary change, `2` rename/copy, `u` unmerged, `?` untracked,
 * `!` ignored (only appears under `--ignored`, never here). The two `XY` digits of `1`/`2` are the **index** and
 * **worktree** states respectively, with `.` meaning unchanged — so one file can be staged and unstaged at the same time (edited, staged,
 * then edited again).
 *
 * Two shapes specific to `-z` (both verified in practice):
 *   - Header lines are NUL-terminated too, not newline-terminated.
 *   - **A rename/copy entry spans two segments**: `2 … R100 <new path>\0<old path>` (without `-z` these two are TAB-separated).
 *     So the parser must explicitly consume one extra segment, otherwise the old path would be taken as the next record — and it does not start
 *     with a type character, so it would be silently dropped. The old path itself is not handed out: what the facade reports is "which paths changed now".
 *
 * A path is the record's **trailing** part, not a fixed-width field: a path may contain spaces (even newlines, preserved as-is under `-z`), so it is parsed by
 * "skip the first N space-separated fields, take the remainder", never by splitting the whole segment.
 */
export function parseGitStatusPorcelainV2(stdout: string, prefix = ""): GitStatusResult {
  const staged: string[] = [];
  const unstaged: string[] = [];
  const untracked: string[] = [];
  let branch: string | undefined;

  const segments = nulSegments(stdout);
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index]!;
    if (segment.startsWith("# branch.head ")) {
      const head = segment.slice("# branch.head ".length);
      // When detached HEAD, git writes the literal "(detached)". At this point branch is **absent** instead of carrying this
      // Placeholder string - hand it over as the branch name and the script will use it to do diff.
      if (head !== "(detached)") branch = head;
      continue;
    }
    if (segment.startsWith("#")) continue;

    const kind = segment[0];
    if (kind === "1" || kind === "2") {
      const xy = segment.split(" ")[1] ?? "..";
      // The path of `1` starts from the 8th field; `2` has one more `<X><score>` field, so it starts from the 9th field, and its **original path**
      // Occupies the entire paragraph immediately following it (the delimiter under `-z` is NUL) and must be explicitly skipped.
      const path = fieldTail(segment, kind === "1" ? 8 : 9);
      if (kind === "2") index += 1;
      if (path.length === 0) continue;
      const relative = stripWorkspacePrefix(prefix, path);
      if (xy[0] !== undefined && xy[0] !== ".") staged.push(relative);
      if (xy[1] !== undefined && xy[1] !== ".") unstaged.push(relative);
      continue;
    }
    if (kind === "u") {
      // Unmerged (conflict): Count the workspace as pending and fall into unstaged. It does "have something to do", and staged is misleading -
      // A conflicting file is not "ready to commit".
      const path = fieldTail(segment, 10);
      if (path.length > 0) unstaged.push(stripWorkspacePrefix(prefix, path));
      continue;
    }
    if (kind === "?") {
      const path = fieldTail(segment, 1);
      if (path.length > 0) untracked.push(stripWorkspacePrefix(prefix, path));
    }
    // `!` with unrecognized segments: skipped.
  }

  const clean = staged.length === 0 && unstaged.length === 0 && untracked.length === 0;
  return {
    ...(branch === undefined ? {} : { branch }),
    clean,
    staged: sortedUnique(staged),
    unstaged: sortedUnique(unstaged),
    untracked: sortedUnique(untracked),
  };
}

/**
 * Parses the output of {@link GIT_LOG_PRETTY}: one record per line, with fields separated by NUL.
 *
 * Splitting records on **newlines** is reliable here, unlike in the path-list case: `%s` is the first line of the commit message
 * and by definition contains no newline, and the other three fields (hash / author name / ISO date) contain none either. So `-z`
 * is not needed here.
 *
 * A field count other than 4 throws: the format string and the parser both live in this module, so a mismatch can only mean a local change went wrong,
 * and a commit filled in only halfway would flow all the way into the journal and the model's context.
 */
export function parseGitLog(stdout: string): GitCommitResult[] {
  const commits: GitCommitResult[] = [];
  for (const raw of stdout.split("\n")) {
    const record = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (record.length === 0) continue;
    const fields = record.split("\u0000");
    if (fields.length !== 4) {
      throw new WorkflowError(
        "DriverError",
        `world-read git-log: cannot parse the output; a record should have 4 NUL-separated ` +
          `fields, got ${fields.length}. Retry, and report this as a bug if it persists.`,
      );
    }
    commits.push({
      hash: fields[0]!,
      subject: fields[1]!,
      author: fields[2]!,
      date: fields[3]!,
    });
  }
  return commits;
}

/**
 * Splits the output of `--name-only -z` / `ls-files -z` into a list of **workspace-relative** paths.
 * Both have already been lifted to repo-root-relative by the argv (`--full-name`), so the prefix is stripped once, uniformly, here.
 */
export function parseGitPathList(stdout: string, prefix = ""): string[] {
  return nulSegments(stdout).map((path) => stripWorkspacePrefix(prefix, path));
}

/**
 * The **entire remainder** starting at the `index`-th space-separated field. porcelain v2 fields are single-space separated and fixed-width,
 * and only the path comes last and may contain spaces, so "skip N spaces then take the remainder" is the only correct parse here.
 */
function fieldTail(line: string, index: number): string {
  let at = 0;
  for (let i = 0; i < index; i += 1) {
    const next = line.indexOf(" ", at);
    if (next === -1) return "";
    at = next + 1;
  }
  return line.slice(at);
}

/** Deduplicated and sorted. The journal stores this value, so it must depend only on content and not on git's output order. */
function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}
