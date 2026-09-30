// ============================================================
// The execution side of world reading (executeWorldRead of Boundary B)
// ============================================================
// Half of workflow-driver.ts. On the driver side are actor sessions, turn orchestration and submit bridging;
// This is "turning an (op, args) into a real read-only observation" - the only contact between the two is
// {@link executeWorldRead}, and this half does not touch the session, model and journal at all.
//
// Three things are here and only here:
//   1. **Check the element number and actual parameters of each op**. Boundary A's `worldRead(siteId, op, args)` only promises
//      "The actual parameters are served as-is by position" (lowering does not look at the op), so "what does a pattern / a base ref look like"
//      Return to this side.
//   2. **Enforcement of upper limit**. The constant is in the pure package (WORLD_READ_CAPS of `@zcode/dynamic-workflow`), implemented here,
//      Because only this side can "not produce" - it is better to stop ripgrep at 2000 items than to materialize a million items and then go back.
//   3. **git fixed argv**. Constructed in workflow-git-world-read.ts (pure), spawned here.

import {
  isAbsolute as isAbsolutePath,
  relative as relativePath,
  resolve as resolvePath,
  sep,
} from "node:path";
import type { ExecutionPort, FileSystemPort } from "@zcode/contracts";
import { WORLD_READ_CAPS, WorkflowError, type WorldReadOp } from "@zcode/dynamic-workflow";
import {
  GIT_SHOW_PREFIX_ARGV,
  GIT_STATUS_ARGV,
  gitChangedFilesPlan,
  gitDiffArgv,
  gitLogArgv,
  parseGitLog,
  parseGitPathList,
  parseGitShowPrefix,
  parseGitStatusPorcelainV2,
  type GitCommitResult,
  type GitStatusResult,
} from "./workflow-git-world-read.js";

/** The ports and the base directory a world read needs (a subset of the driver deps). */
export interface WorldReadDeps {
  /** The file system port that files.glob / files.read / files.grep land on. */
  readonly fileSystemPort: FileSystemPort;
  /** The subprocess execution port that git.* lands on (cwd = the workspace root). */
  readonly executionPort: ExecutionPort;
  /** The base directory for path resolution and relativization (the workspace root). */
  readonly cwd: string;
  /**
   * The approved command set of world.run (collected at compile time from literal cmd values, the very set the confirmation window displayed). **Absent means every world.run is rejected** (fail-closed):
   * an empty set on the authorization surface and a "forgot to wire it up" have to be equally safe, and the re-verification here is only defence in depth — the real authorization
   * happens at the compile-time literal + submit confirmation.
   */
  readonly declaredRunCommands?: ReadonlySet<string>;
}

/**
 * Pulls arguments out of the **positional argument array** per op and performs one world read. Boundary A only promises "positional arguments arrive as-is"
 * (lowering does not look at the op), so each op's arity and type checks live here — this is the side that knows
 * "what one pattern / one base ref looks like".
 * Any shape mismatch rejects the node with a structured `DriverError`, never a silent coercion: a path that quietly became `"undefined"` through
 * `String(undefined)` would produce an unexplainable read failure instead of an actionable error.
 *
 * Declared `async` on purpose: the throw from argument validation has to become a **promise rejection of that node**. A synchronous throw would escape
 * through `engine.worldRead` (the engine only `.then(...)`s once admission has landed in the journal), leaving a node
 * running forever.
 */
export async function executeWorldRead(
  deps: WorldReadDeps,
  op: WorldReadOp,
  args: unknown[],
): Promise<unknown> {
  switch (op) {
    case "glob":
      return await worldGlob(deps, worldReadStringArgs(op, args, ["pattern"])[0]!);
    case "read":
      return await worldRead(deps, worldReadStringArgs(op, args, ["path"])[0]!);
    case "grep": {
      const [pattern, glob] = worldReadOptionalStringArgs(op, args, ["pattern"], ["glob"]);
      return await worldGrep(deps, pattern!, glob);
    }
    case "git-changed-files": {
      const [base] = worldReadOptionalStringArgs(op, args, [], ["base"]);
      return await gitChangedFiles(deps, base);
    }
    case "git-diff": {
      const [base, path] = worldReadOptionalStringArgs(op, args, [], ["base", "path"]);
      return await gitDiff(deps, base, path);
    }
    case "git-status": {
      // No-parameter op: `names` is empty, which means "exactly 0 actual parameters". Passing one more will still fail loudly.
      worldReadStringArgs(op, args, []);
      return await gitStatus(deps);
    }
    case "git-log":
      return await gitLog(deps, worldReadOptionalCount(op, args, "count"));
    case "run":
      return await worldRun(deps, args);
    default: {
      // The op vocabulary is derived from the world-read registry: if a new line is added and it is not connected here, it will fail loudly here.
      const unknownOp: never = op;
      throw new WorkflowError("DriverError", `Unsupported world-read op "${String(unknownOp)}".`);
    }
  }
}

/**
 * `files.glob(pattern)`: through the FileSystemPort's searchFiles, normalized into the shape the facade promises.
 *
 * All three normalizations come from the gap between the port semantics and the facade promise — the port result cannot be handed over as-is.
 * The port was designed for the UI's Glob tool: absolute paths, mtime descending, truncated to 100 by default.
 *
 * - **Reject at cap+1** (the same idiom as worldGrep): the port's default truncation applies silently, so a glob over 5000 files
 *   hands back only 2%, and the error view enters the journal and gets replayed on resume. The cap belongs to WORLD_READ_CAPS,
 *   and exactly cap hits cannot be told apart from "exactly right" versus "truncated", so one extra is asked for.
 * - **Workspace relativization**: absolute paths make every routing a script writes with a workspace-relative prefix (`startsWith("apps/…")`)
 *   fall through, silently collapsing 6-way fan-out into 1; grep/git were already relativized, glob is the one that slipped through.
 * - **Reordering lexicographically**: mtime drifts with every file write, while journaled values must be deterministic — two submissions of the same script
 *   should not fan out in a different order. The rejection semantics guarantee that what we hold here is the full match set, so the reordering is complete.
 */
async function worldGlob(deps: WorldReadDeps, pattern: string): Promise<string[]> {
  const cap = WORLD_READ_CAPS.globMaxFiles;
  const result = await deps.fileSystemPort.searchFiles({
    path: deps.cwd,
    pattern,
    maxResults: cap + 1,
  });
  if (result.files.length > cap || result.truncated) {
    throw capExceeded(`files.glob: over ${cap} files match (the cap). Narrow the pattern.`);
  }
  return result.files.map((path) => toWorkspaceRelative(deps.cwd, path)).sort();
}

/**
 * `files.read(path)`: after resolving to an absolute path, **first confirm it is still inside the workspace**, then hand it to the port.
 *
 * Why this check is only being added now: before `git.*` landed, every path reaching here was a literal the script itself wrote, so going out of bounds was an explicit
 * act. `git.*` is the first primitive that can **produce** paths — `changedFiles() → files.read(p)`
 * is the most obvious two-line combination, and git's native output carries a `../` prefix when the workspace is a repository subdirectory. The git side
 * already holds its scope inside the workspace with a pathspec, so this check is the same invariant landing at the other end: an obvious combination of primitives
 * should not be a trap.
 */
async function worldRead(deps: WorldReadDeps, arg: string): Promise<string> {
  const path = assertWithinWorkspace("read", deps.cwd, arg);
  const result = await deps.fileSystemPort.readTextFile({ path });
  return result.content;
}

/**
 * `files.grep(pattern, glob?)`: through the FileSystemPort's searchText (ripgrep semantics).
 *
 * **headLimit takes cap + 1**, and that is the one non-obvious line of this method. The rule is "reject when the hits exceed the cap",
 * while the port only truncates at headLimit — so taking exactly cap yields an ambiguous result: cap hits could mean
 * exactly cap (which should be let through) or that a million more were cut off (which should be rejected). Asking for one extra removes that
 * ambiguity: receiving cap+1 rows proves the overflow, and the cost is still a single record instead of materializing the whole result set.
 * `truncated` is the second line of the same judgement (if the port truncated for some other reason, what we hold is not the complete result).
 */
async function worldGrep(
  deps: WorldReadDeps,
  pattern: string,
  glob: string | undefined,
): Promise<GrepMatch[]> {
  const cap = WORLD_READ_CAPS.grepMaxMatches;
  const result = await deps.fileSystemPort.searchText({
    path: deps.cwd,
    pattern,
    ...(glob === undefined ? {} : { glob }),
    outputMode: "content",
    showLineNumbers: true,
    headLimit: cap + 1,
  });
  if (result.entries.length > cap || result.truncated) {
    throw capExceeded(
      `files.grep: over ${cap} matches (the cap). Narrow the pattern or add a glob.`,
    );
  }
  const matches: GrepMatch[] = [];
  for (const entry of result.entries) {
    // In content mode, each hit has a line number and line text; an entry missing either is not a content hit (for example, the port in
    // Count items output under other outputMode), skip instead of filling in 0 / "" to create a false hit.
    if (entry.lineNumber === undefined || entry.text === undefined) continue;
    matches.push({
      path: toWorkspaceRelative(deps.cwd, entry.path),
      line: entry.lineNumber,
      text: entry.text,
    });
  }
  const serializedBytes = Buffer.byteLength(JSON.stringify(matches), "utf8");
  if (serializedBytes > WORLD_READ_CAPS.grepMaxSerializedBytes) {
    throw capExceeded(
      `files.grep: result is ${serializedBytes} bytes, over the ` +
        `${WORLD_READ_CAPS.grepMaxSerializedBytes}-byte cap. Narrow the pattern or add a glob.`,
    );
  }
  return matches;
}

// —————————————————————————————— Internal: git.* world-read ——————————————————————————

/**
 * Runs one git command and returns stdout. argv is **constructed** by workflow-git-world-read.ts (a fixed array,
 * never a shell string); this method only hands it to the port and normalizes a failure into a node-level `DriverError`.
 *
 * `maxInlineBytes` comes from the caller: git.diff needs it for limit probing (the same cap+1 trick as grep),
 * the other ops use a large enough default.
 */
async function runGit(
  deps: WorldReadDeps,
  op: WorldReadOp,
  argv: readonly string[],
  maxInlineBytes: number,
): Promise<{ text: string; bytes: number; truncated: boolean }> {
  const result = await deps.executionPort.run({
    command: { mode: "argv", file: "git", args: [...argv] },
    cwd: deps.cwd,
    outputLimit: { maxInlineBytes },
  });
  if (result.status !== "completed" || (result.exitCode ?? 0) !== 0) {
    // Missing git, non-repository, and bad refs all go here. Normalized to a **catchable** DriverError instead of run level
    // fails, allowing the script to use files.glob via try/catch instead.
    const detail = firstLine(result.stderr.text) || firstLine(result.stdout.text) || result.status;
    throw new WorkflowError(
      "DriverError",
      `git ${argv.join(" ")} failed (${result.status}, exit=${result.exitCode ?? "n/a"}): ${detail}`,
    );
  }
  return {
    text: result.stdout.text,
    bytes: result.stdout.bytes,
    truncated: result.stdout.truncated,
  };
}

/**
 * The prefix of the repository root relative to the workspace (an empty string when it is the repository root). Every path on the wire is relative to the repository root,
 * and stripping this prefix is what produces the workspace-relative path the facade promises (see output contract 2 at the top of workflow-git-world-read.ts).
 *
 * Every read asks once instead of caching: a `rev-parse` is on the order of milliseconds, and a world read happens once per site×ordinal
 * and is journaled, so it is on no hot path. In exchange this side is completely stateless.
 */
async function gitWorkspacePrefix(deps: WorldReadDeps, op: WorldReadOp): Promise<string> {
  const out = await runGit(deps, op, GIT_SHOW_PREFIX_ARGV, GIT_TEXT_OUTPUT_BYTES);
  return parseGitShowPrefix(out.text);
}

async function gitChangedFiles(deps: WorldReadDeps, base: string | undefined): Promise<string[]> {
  // Construct argv first: if base is illegal, it should be rejected before running any git.
  const plans = gitChangedFilesPlan(base);
  const prefix = await gitWorkspacePrefix(deps, "git-changed-files");
  const paths: string[] = [];
  for (const plan of plans) {
    const out = await runGit(deps, "git-changed-files", plan.argv, GIT_TEXT_OUTPUT_BYTES);
    paths.push(...parseGitPathList(out.text, prefix));
  }
  // Union deduplication and sorting: two commands can report the same path, and the journal stores this value, so it must only
  // Whichever command returns first depends on the content or does not depend on the content.
  return [...new Set(paths)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

async function gitDiff(
  deps: WorldReadDeps,
  base: string | undefined,
  path: string | undefined,
): Promise<string> {
  const cap = WORLD_READ_CAPS.gitDiffMaxBytes;
  // cap + 1: Same reason as grep - "exactly cap bytes" and "truncated" must be distinguishable.
  const out = await runGit(deps, "git-diff", gitDiffArgv(base, path), cap + 1);
  if (out.bytes > cap || out.truncated) {
    throw capExceeded(
      `git.diff: output is ${out.bytes} bytes, over the ${cap}-byte cap. Pass a path to narrow.`,
    );
  }
  return out.text;
}

async function gitStatus(deps: WorldReadDeps): Promise<GitStatusResult> {
  const prefix = await gitWorkspacePrefix(deps, "git-status");
  const out = await runGit(deps, "git-status", GIT_STATUS_ARGV, GIT_TEXT_OUTPUT_BYTES);
  return parseGitStatusPorcelainV2(out.text, prefix);
}

async function gitLog(deps: WorldReadDeps, count: number): Promise<GitCommitResult[]> {
  const out = await runGit(deps, "git-log", gitLogArgv(count), GIT_TEXT_OUTPUT_BYTES);
  return parseGitLog(out.text);
}

// ———————————————————————————————— Internal: world.run ————————————————————————————

/** The return value of `world.run`. The authoritative declaration is `declare interface WorldRunResult` in FACADE_DTS. */
interface WorldRunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * `world.run(cmd, args?, opts?)`: journaled command execution.
 *
 * Three deliberate differences from `git.*`, each of them a contract rather than an oversight:
 *   1. **A nonzero exit is a value.** The execution adapter maps a nonzero exit to `status:"failed"` with `error` absent
 *      (statusFromExit/statusFailure in node-execution-adapter-results.ts), which reliably tells it apart from
 *      a spawn failure / timeout. The normal path of a gated loop should not travel through exception control flow.
 *   2. **Re-verification of cmd.** Authorization happens at the compile-time literal + submit confirmation; comparing against declaredRunCommands
 *      here only guards against wiring mistakes (lowering / the wire protocol handing in some other string), and it fails closed —
 *      an absent set and a command not in the set are rejected the same way.
 *   3. **No upper bound on the timeout.** 300s by default, and a script can raise it arbitrarily (designed for genuinely long-running tests);
 *      cancel remains the last control.
 *
 * 256KB each for stdout/stderr, with cap+1 probing (`maxInlineBytes` is the larger of the two caps + 1, after which each stream is judged separately),
 * over-limit rejects rather than truncating — the message gives an actionable next step, the same house policy as grep/diff.
 */
async function worldRun(deps: WorldReadDeps, args: unknown[]): Promise<WorldRunResult> {
  const { argv, cmd, timeoutMs } = worldRunArgs(args);

  const declared = deps.declaredRunCommands;
  if (declared === undefined || !declared.has(cmd)) {
    // Fail-closed wiring defense: The cmd that can reach here should be collected and confirmed through compile-time literals.
    throw new WorkflowError(
      "DriverError",
      `world.run: command '${cmd}' is not in the declared set of commands (a wiring error).`,
    );
  }

  const stdoutCap = WORLD_READ_CAPS.runStdoutMaxBytes;
  const stderrCap = WORLD_READ_CAPS.runStderrMaxBytes;
  const result = await deps.executionPort.run({
    command: { mode: "argv", file: cmd, args: argv },
    cwd: deps.cwd,
    timeoutMs,
    outputLimit: { maxInlineBytes: Math.max(stdoutCap, stderrCap) + 1 },
  });

  if (result.status === "timed_out") {
    throw new WorkflowError(
      "DriverError",
      `world.run '${cmd}' timed out after ${timeoutMs}ms. Raise opts.timeoutMs or narrow the work.`,
    );
  }
  // Completed (exit 0) and failed-none-error (non-zero exit) are both **finished observations** and hand over the value;
  // The rest (spawn_error / canceled / failed with error, such as output_limit) are due to the observation itself not being established.
  const ranToExit =
    result.status === "completed" ||
    (result.status === "failed" &&
      result.error === undefined &&
      typeof result.exitCode === "number");
  if (!ranToExit) {
    const detail = result.error?.message ?? (firstLine(result.stderr.text) || result.status);
    throw new WorkflowError(
      "DriverError",
      `world.run '${cmd}' did not run to completion (${result.status}): ${detail}`,
    );
  }

  if (result.stdout.bytes > stdoutCap || result.stdout.truncated) {
    throw capExceeded(
      `world.run '${cmd}': stdout is ${result.stdout.bytes} bytes, over the ${stdoutCap}-byte cap. ` +
        `Quiet the output (e.g. --quiet), or write a file and files.read a summary.`,
    );
  }
  if (result.stderr.bytes > stderrCap || result.stderr.truncated) {
    throw capExceeded(
      `world.run '${cmd}': stderr is ${result.stderr.bytes} bytes, over the ${stderrCap}-byte cap. ` +
        `Reduce the diagnostics, or write a file and files.read a summary.`,
    );
  }

  return {
    exitCode: result.exitCode ?? 0,
    stdout: result.stdout.text,
    stderr: result.stderr.text,
  };
}

/**
 * The argument shape of `world.run`: `[cmd: string, args?: string[], opts?: { timeoutMs?: number }]`.
 * It follows the same discipline as {@link worldReadStringArgs} (fail loudly, never coerce), but the shape (array + options bag)
 * goes beyond what a string-sequence helper can express, so it gets its own entry.
 */
function worldRunArgs(args: unknown[]): { cmd: string; argv: string[]; timeoutMs: number } {
  if (args.length < 1 || args.length > 3) {
    throw new WorkflowError(
      "DriverError",
      `world.run takes 1 to 3 arguments (cmd, args?, opts?), got ${args.length}.`,
    );
  }
  const cmd = requireStringArg("run", args[0], "cmd", 0);

  const rawArgv = args[1];
  let argv: string[] = [];
  if (rawArgv !== undefined) {
    if (!Array.isArray(rawArgv)) {
      throw new WorkflowError(
        "DriverError",
        `world.run: argument 2 (args) must be an array of strings, got ${describeArg(rawArgv)}.`,
      );
    }
    argv = rawArgv.map((item, index) => {
      if (typeof item !== "string") {
        throw new WorkflowError(
          "DriverError",
          `world.run: args[${index}] must be a string, got ${describeArg(item)}. Stringify values.`,
        );
      }
      return item;
    });
  }

  const rawOpts = args[2];
  let timeoutMs: number = WORLD_READ_CAPS.runDefaultTimeoutMs;
  if (rawOpts !== undefined) {
    if (typeof rawOpts !== "object" || rawOpts === null || Array.isArray(rawOpts)) {
      throw new WorkflowError(
        "DriverError",
        `world.run: arg 3 (opts) must be an options object or omitted, got ${describeArg(rawOpts)}.`,
      );
    }
    const rawTimeout = (rawOpts as { timeoutMs?: unknown }).timeoutMs;
    if (rawTimeout !== undefined) {
      if (typeof rawTimeout !== "number" || !Number.isInteger(rawTimeout) || rawTimeout < 1) {
        throw new WorkflowError(
          "DriverError",
          `world.run: opts.timeoutMs must be an integer >= 1, got ${describeArg(rawTimeout)}.`,
        );
      }
      // Deliberately uncapped clamp: Designed for real long-distance testing; cancel is the final control.
      timeoutMs = rawTimeout;
    }
  }

  return { argv, cmd, timeoutMs };
}

// ———————————————————————————————— Pure support ————————————————————————————

/**
 * Takes the **required string arguments** described by `names` out of a world-read positional argument array, and throws a structured
 * `DriverError` on a shape mismatch (a node-level failure the script can `catch`). Arity is checked exactly against `names.length`: extra arguments can only
 * come from a wiring mistake — the facade's type signature already stops extra arguments at compile time, so seeing one at runtime means lowering
 * or the wire protocol went astray, and silently ignoring it would hide a locatable bug behind a semantically unclear read.
 *
 * Why validate instead of coerce: Boundary A's `args: unknown[]` are script arguments passed through **as-is**, and this side is the first
 * and only place that knows each op's arity.
 * `String(args[0])` turns `undefined` into the path `"undefined"`, and the reported ENOENT points nowhere near the real mistake.
 *
 * Multi-arg ops with optional arguments (`files.grep(pattern, glob?)`, `git.diff(base?, path?)`) use the variant that allows a missing
 * tail, {@link worldReadOptionalStringArgs}; the seam lives inside these two functions, not at the call sites.
 */
function worldReadStringArgs(op: WorldReadOp, args: unknown[], names: readonly string[]): string[] {
  if (args.length !== names.length) {
    throw new WorkflowError(
      "DriverError",
      `world-read ${op} takes ${names.length} arguments (${names.join(", ")}), got ${args.length}.`,
    );
  }
  return names.map((name, index) => requireStringArg(op, args[index], name, index));
}

/**
 * The **trailing-optional** variant of {@link worldReadStringArgs}: `required` is the required prefix, `optional` the optional tail.
 * It returns an array of fixed length `required.length + optional.length`, with an absent optional slot being `undefined`.
 *
 * Three rules, all on the "fail loudly" side:
 *   1. Fewer arguments than the required count, or more than the total → a structured `DriverError`. Extra arguments are still rejected, for the same reason
 *      as in the exact variant: the facade's signature already stops extra arguments at compile time, so at runtime it can only be a lowering / wire protocol
 *      wiring mistake, and silently ignoring it would hide a locatable bug behind a semantically unclear read.
 *   2. A required slot must be a string.
 *   3. **An optional slot may be an explicit `undefined`**, because it is writable in the script: `git.diff(undefined, "a.ts")`
 *      is legal under `base?: string`, lowering packs positionally as-is, and the driver really does receive an
 *      `undefined` prefix. Reading it as "absent" is the only defensible interpretation.
 *
 * Note that lowering packs a missing **trailing** argument as a **shorter array** (not an undefined hole), and
 * `inputHash({op, args})` is the journal key — so `["TODO"]` and `["TODO", "*.ts"]` are naturally two different keys.
 * This function only normalizes both arrival shapes into the same call shape; it does not rewrite args.
 */
function worldReadOptionalStringArgs(
  op: WorldReadOp,
  args: unknown[],
  required: readonly string[],
  optional: readonly string[],
): (string | undefined)[] {
  const max = required.length + optional.length;
  if (args.length < required.length || args.length > max) {
    const range = required.length === max ? `${max}` : `${required.length}~${max}`;
    throw new WorkflowError(
      "DriverError",
      `world-read ${op} takes ${range} arguments ` +
        `(${[...required, ...optional.map((n) => `${n}?`)].join(", ")}), got ${args.length}.`,
    );
  }
  const out: (string | undefined)[] = [];
  required.forEach((name, index) => out.push(requireStringArg(op, args[index], name, index)));
  optional.forEach((name, offset) => {
    const index = required.length + offset;
    if (index >= args.length) {
      out.push(undefined);
      return;
    }
    const value = args[index];
    if (value === undefined) {
      out.push(undefined);
      return;
    }
    out.push(requireStringArg(op, value, name, index));
  });
  return out;
}

/**
 * The arguments of `git.log(count?)`: 0 or 1, and it must be a positive integer no larger than the limit. When absent it takes
 * {@link WORLD_READ_CAPS.gitLogDefaultCount}.
 *
 * Over the limit **rejects** rather than silently clamping to it: a script that asks for 500 entries and gets 100 turns that into
 * an unexplainable "why is the history so short" inside its own logic. An error naming the limit lets the script fix it directly.
 */
function worldReadOptionalCount(op: WorldReadOp, args: unknown[], name: string): number {
  const max = WORLD_READ_CAPS.gitLogMaxCount;
  if (args.length > 1) {
    throw new WorkflowError(
      "DriverError",
      `world-read ${op} takes at most 1 argument (${name}?), got ${args.length}.`,
    );
  }
  const raw = args[0];
  if (raw === undefined) return WORLD_READ_CAPS.gitLogDefaultCount;
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 1) {
    throw new WorkflowError(
      "DriverError",
      `world-read ${op}: argument '${name}' must be an integer >= 1, got ${describeArg(raw)}.`,
    );
  }
  if (raw > max) {
    throw new WorkflowError(
      "DriverError",
      `world-read ${op}: argument '${name}'=${raw} is over the cap of ${max}; pass at most ${max}.`,
    );
  }
  return raw;
}

/** Takes one positional argument that must be a string, otherwise rejects in structured form (never a `String(...)` coercion). */
function requireStringArg(op: WorldReadOp, value: unknown, name: string, index: number): string {
  if (typeof value !== "string") {
    throw new WorkflowError(
      "DriverError",
      `world-read ${op}: arg ${index + 1} (${name}) must be a string, got ${describeArg(value)}.`,
    );
  }
  return value;
}

/**
 * The structured rejection for a limit overflow. The message always carries an **actionable next step** ("narrow the pattern or add a glob"):
 * the limit is a contract the script can rewrite itself against, and an error that only says "you went over" wastes that.
 */
function capExceeded(message: string): WorkflowError {
  return new WorkflowError("WorldReadCapExceeded", message);
}

/**
 * Resolves a script-supplied relative path into an absolute one and judges **lexically** whether it is still inside the workspace; out of bounds it returns
 * `undefined` (the wording of the error and the structured code belong to the caller — world reads report `DriverError`, artifact publishing
 * reports `ArtifactPathOutsideWorkspace`).
 *
 * The criterion is `relative(cwd, resolved)`: its output is already normalized, so `..` can only appear at the front, and
 * "does not start with a `..` segment and is not an absolute path" is therefore equivalent to "still inside the workspace". The second condition is required on windows
 * — across drive letters `relative` returns an absolute path instead of a run of `..`.
 *
 * **Lexical check only, no symlink following**: a symlink inside the workspace that points outside still passes at this layer. World reads
 * accept that known edge (the bytes they read are the values the script itself sees); artifact publishing does not accept it, because it copies those bytes
 * **into a persistent store handed to the user**, so that side re-checks with realpath on top of this function
 * (see workflow-artifact-publish.ts).
 *
 * **The export is deliberate**: the definition of out-of-bounds must have exactly one implementation. Writing it twice means that one day
 * the two disagree about the same path, and one of them is a security boundary.
 */
export function resolveWithinWorkspace(cwd: string, arg: string): string | undefined {
  const resolved = resolvePath(cwd, arg);
  const rel = relativePath(cwd, resolved);
  const escapes = rel === ".." || rel.startsWith(`..${sep}`) || rel.startsWith("../");
  return escapes || isAbsolutePath(rel) ? undefined : resolved;
}

/** The world-read wrapper around {@link resolveWithinWorkspace}: out of bounds becomes a structured `DriverError` (the script can `catch` it). */
function assertWithinWorkspace(op: string, cwd: string, arg: string): string {
  const resolved = resolveWithinWorkspace(cwd, arg);
  if (resolved === undefined) {
    throw new WorkflowError(
      "DriverError",
      `world-read ${op}: path '${arg}' is outside the workspace; pass a path inside it.`,
    );
  }
  return resolved;
}

/**
 * Normalizes a path returned by the port into a **workspace-relative** path (the shape the facade promises). The port may hand back an absolute path
 * or an already-relative one, and both are accepted. Separators are unified to `/`: this value goes into the journal and is interpolated into model prompts,
 * so it must not deform with the host platform (the same script should read the same path on windows and on mac).
 *
 * **The export is deliberate** (same as {@link resolveWithinWorkspace}): the `sourcePath` in an artifact record is the same kind
 * of value — workspace-relative, forward slashes — and "the same kind of value" must have exactly one definition, otherwise the two diverge on windows one day.
 */
export function toWorkspaceRelative(cwd: string, path: string): string {
  const rel = resolvePath(cwd, path) === path ? relativePath(cwd, path) : path;
  return rel.replace(/\\/g, "/");
}

/** The first line of stderr / stdout (for error messages; the whole output is never echoed back). */
function firstLine(text: string): string {
  return text.split("\n", 1)[0]?.trim() ?? "";
}

/**
 * The inline limit for git text output (path lists / status / log). These ops have no spec-level limit, but an unbounded
 * buffer is not an option — 100 commits and the path list of a working tree are several orders of magnitude below 4MB. git.diff does **not**
 * use this value: it has its own 512KB limit and needs cap+1 for overflow probing.
 */
const GIT_TEXT_OUTPUT_BYTES = 4 * 1024 * 1024;

/** One `files.grep` hit. The authoritative declaration is `declare interface GrepMatch` in FACADE_DTS. */
interface GrepMatch {
  path: string;
  line: number;
  text: string;
}

/** A short description of the argument shape (used only in error messages; the full content is never echoed back). */
function describeArg(value: unknown): string {
  if (value === undefined) return "undefined";
  if (value === null) return "null";
  return Array.isArray(value) ? "array" : typeof value;
}
