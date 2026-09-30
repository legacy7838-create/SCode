// ============================================================
// Saved workflows - storage layer (scope root + parse/enumerate/write)
// ============================================================
//
// All are **synchronous** fs. The reason is not to save trouble: the `prepareApproval` contract of the confirmation window is synchronous (core's
// ToolEntry annotation: "it inspects the input the executor already holds"), and with `saved` source
// The initiated run must read the script before the pop-up window - without the script, there will be no cause and effect diagram, and the user will be on an empty window.
// Approval for execution. These files are local, single, and measured in KB, and the cost of synchronous reading is much less than opening a new asynchronous approval path for it.
// There is a precedent of the same form on the handler side of core (readFileSync of bash-git-runtime-safety.ts).

import {
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  SAVED_WORKFLOW_FILE_EXTENSION,
  SAVED_WORKFLOW_GLOBAL_DIR,
  SAVED_WORKFLOW_MAX_NAME_CHARS,
  SAVED_WORKFLOW_PROJECT_DIR,
  isValidSavedWorkflowName,
  type SavedWorkflowEntry,
  type SavedWorkflowInvalidEntry,
  type SavedWorkflowMeta,
  type SavedWorkflowScope,
  type SavedWorkflowShadowing,
} from "@zcode/contracts";
import { parseSavedWorkflow, serializeSavedWorkflow } from "./frontmatter.js";

/** One lookup root: a scope label plus an absolute directory. */
export interface SavedWorkflowRoot {
  scope: SavedWorkflowScope;
  dir: string;
}

/**
 * The optional argument of `savedWorkflowRoots` and the derived functions. `homeDir` exists only for test injection: in production it always comes from
 * `os.homedir()` (the home directory of the machine the agent process runs on), and **never** follows any `storage.dir` setting.
 */
export interface SavedWorkflowRootsOptions {
  homeDir?: string;
}

/**
 * The lookup roots of this session, **ordered by priority**: `[project, global]`.
 *
 * Project files live under the session working directory's `.zcode/workflows/`, global ones under `~/.zcode/workflows/` in the home directory.
 * Every lookup is first-wins in that order: the copy in the project always beats the global one (same-name shadowing).
 */
export function savedWorkflowRoots(
  cwd: string,
  options?: SavedWorkflowRootsOptions,
): SavedWorkflowRoot[] {
  return [
    { scope: "project", dir: join(cwd, SAVED_WORKFLOW_PROJECT_DIR) },
    { scope: "global", dir: join(options?.homeDir ?? homedir(), SAVED_WORKFLOW_GLOBAL_DIR) },
  ];
}

/** The lookup root of a single scope. Scopes are a known enumeration, so `savedWorkflowRoots` always contains one. */
export function savedWorkflowRoot(
  cwd: string,
  scope: SavedWorkflowScope,
  options?: SavedWorkflowRootsOptions,
): SavedWorkflowRoot {
  const root = savedWorkflowRoots(cwd, options).find((candidate) => candidate.scope === scope);
  // Scope is a member of the SavedWorkflowScope enumeration, roots covers all members, and find will not fail.
  return root!;
}

/** One successfully parsed saved definition. */
export interface ResolvedSavedWorkflow {
  name: string;
  path: string;
  scope: SavedWorkflowScope;
  meta: SavedWorkflowMeta;
  script: string;
  /**
   * The raw file text (metadata block + body), **byte for byte**. This is exactly what a draft copy takes: a copy has to be identical to the bytes just read, and
   * re-serializing would let the `args` defaults, comments, and hand-written YAML formatting drift inside the copy — and
   * that copy is precisely what the model is about to `path` back.
   */
  source: string;
  /** The number of lines before the body; it is added when a diagnostic is converted into a file line (see {@link parseSavedWorkflow}). */
  bodyLineOffset: number;
}

export type SavedWorkflowResolveFailure =
  | { ok: false; reason: "invalid_name"; detail: string }
  | { ok: false; reason: "not_found" }
  | { ok: false; reason: "parse_error"; path: string; detail: string }
  | { ok: false; reason: "read_error"; path: string; detail: string };

export type SavedWorkflowResolveResult =
  | ({ ok: true } & ResolvedSavedWorkflow)
  | SavedWorkflowResolveFailure;

export interface SavedWorkflowListResult {
  entries: SavedWorkflowEntry[];
  invalid: SavedWorkflowInvalidEntry[];
}

/** name → filename. The name has already passed {@link isValidSavedWorkflowName}, so nothing is re-guarded here. */
export function savedWorkflowFileName(name: string): string {
  return `${name}${SAVED_WORKFLOW_FILE_EXTENSION}`;
}

/**
 * Where a name lands under the given root. The write side and the read side share it — the two sides each assembling the path on their own is exactly the classic
 * cause of "the save succeeded but it cannot be read back".
 */
export function savedWorkflowPath(root: SavedWorkflowRoot, name: string): string {
  return join(root.dir, savedWorkflowFileName(name));
}

/**
 * Resolves a saved workflow by name.
 *
 * The name passes the legality check before the path is assembled: this ordering *is* the path-traversal defence, not an input-hygiene nicety —
 * `../../.ssh/id_rsa` joined in becomes a readable absolute path.
 *
 * With `scope`: only that root is searched (targeted lookups from the hub and from `saved.scope`); without it: both roots in order, first-wins.
 */
export function resolveSavedWorkflow(options: {
  cwd: string;
  name: string;
  scope?: SavedWorkflowScope;
  homeDir?: string;
}): SavedWorkflowResolveResult {
  const { cwd, name, scope, homeDir } = options;
  if (!isValidSavedWorkflowName(name)) {
    return {
      ok: false,
      reason: "invalid_name",
      detail: `workflow names may only contain letters, digits, '.', '-' and '_', and must be 1-${SAVED_WORKFLOW_MAX_NAME_CHARS} characters`,
    };
  }

  const roots =
    scope === undefined
      ? savedWorkflowRoots(cwd, { homeDir })
      : [savedWorkflowRoot(cwd, scope, { homeDir })];

  for (const root of roots) {
    const path = savedWorkflowPath(root, name);
    let source: string;
    try {
      source = readFileSync(path, "utf8");
    } catch (error) {
      // This one doesn't have it, look at the next one. The rest of the misreadings (permissions, directories) are problems with this file. Say it instead.
      // Pretending not to be found - "not found" will send the user to check for a name that actually exists.
      if (isNotFound(error)) continue;
      return { ok: false, reason: "read_error", path, detail: describeError(error) };
    }

    const parsed = parseSavedWorkflow(source);
    if (!parsed.ok) {
      return { ok: false, reason: "parse_error", path, detail: parsed.detail };
    }
    return {
      ok: true,
      name,
      path,
      scope: root.scope,
      meta: parsed.meta,
      script: parsed.script,
      source,
      bodyLineOffset: parsed.bodyLineOffset,
    };
  }

  return { ok: false, reason: "not_found" };
}

/**
 * Enumerates the saved definitions (a flat scan of depth 1, not recursing into subdirectories).
 *
 * Bad files go into `invalid` instead of throwing: these files are hand-edited by users, and one typo should not make the whole listing disappear.
 *
 * Without `scope`: both roots in order, first-wins for same-name definitions, and the shadowed copy **does not** appear in the list — the list is meant to say
 * "what calling this name will run", not "how many copies are on disk". With `scope`: only that root is scanned and **no** shadowing is applied
 * (the hub's global group has to see the copy shadowed by a project file).
 */
export function listSavedWorkflows(options: {
  cwd: string;
  scope?: SavedWorkflowScope;
  homeDir?: string;
}): SavedWorkflowListResult {
  const entries: SavedWorkflowEntry[] = [];
  const invalid: SavedWorkflowInvalidEntry[] = [];
  const claimed = new Set<string>();

  const roots =
    options.scope === undefined
      ? savedWorkflowRoots(options.cwd, { homeDir: options.homeDir })
      : [savedWorkflowRoot(options.cwd, options.scope, { homeDir: options.homeDir })];

  for (const root of roots) {
    let fileNames: string[];
    try {
      fileNames = readdirSync(root.dir);
    } catch (error) {
      // It is normal that the directory does not exist (most projects have not saved the workflow), and it is not an error.
      if (isNotFound(error)) continue;
      invalid.push({ path: root.dir, reason: describeError(error) });
      continue;
    }

    // The order of readdir depends on the file system; the ordering makes the list consistent on both machines.
    for (const fileName of [...fileNames].sort()) {
      if (!fileName.endsWith(SAVED_WORKFLOW_FILE_EXTENSION)) continue;
      const name = fileName.slice(0, -SAVED_WORKFLOW_FILE_EXTENSION.length);
      const path = join(root.dir, fileName);

      if (!isValidSavedWorkflowName(name)) {
        invalid.push({ path, reason: "file name is not a usable workflow name" });
        continue;
      }
      // It has been claimed by a higher priority scope: this one cannot be reached, so it will not be listed.
      if (claimed.has(name)) continue;

      let source: string;
      try {
        source = readFileSync(path, "utf8");
      } catch (error) {
        // The directory entry exists but cannot be read (subdirectories, permissions) - it's not "no", it's "broken".
        invalid.push({ path, reason: describeError(error) });
        continue;
      }

      const parsed = parseSavedWorkflow(source);
      if (!parsed.ok) {
        invalid.push({ path, reason: `${parsed.reason}: ${parsed.detail}` });
        continue;
      }

      claimed.add(name);
      entries.push({
        name,
        description: parsed.meta.description,
        ...(parsed.meta.whenToUse === undefined ? {} : { whenToUse: parsed.meta.whenToUse }),
        ...(parsed.meta.args === undefined ? {} : { args: parsed.meta.args }),
        scope: root.scope,
        path,
      });
    }
  }

  return { entries, invalid };
}

/**
 * Writes a saved definition and returns where it landed together with "was this an overwrite".
 *
 * `scope` decides which root it lands in (defaulting to `project`, preserving the existing semantics). The scope is a **write-side choice** now — the model
 * always fills it in inside SaveWorkflow.
 */
export function saveSavedWorkflow(options: {
  cwd: string;
  name: string;
  meta: SavedWorkflowMeta;
  script: string;
  scope?: SavedWorkflowScope;
  homeDir?: string;
}): { path: string; scope: SavedWorkflowScope; overwritten: boolean } {
  const root = savedWorkflowRoot(options.cwd, options.scope ?? "project", {
    homeDir: options.homeDir,
  });
  const path = savedWorkflowPath(root, options.name);
  mkdirSync(root.dir, { recursive: true });
  const overwritten = fileExists(path);
  writeFileSync(path, serializeSavedWorkflow(options.meta, options.script), "utf8");
  return { path, scope: root.scope, overwritten };
}

/** Whether the target already exists (the confirmation dialog has to phrase "overwrite" and "create" as two different things). The project file is checked by default. */
export function savedWorkflowExists(options: {
  cwd: string;
  name: string;
  scope?: SavedWorkflowScope;
  homeDir?: string;
}): boolean {
  if (!isValidSavedWorkflowName(options.name)) return false;
  const root = savedWorkflowRoot(options.cwd, options.scope ?? "project", {
    homeDir: options.homeDir,
  });
  return fileExists(savedWorkflowPath(root, options.name));
}

/**
 * When saving to `scope`, whether the other scope already has a same-name definition (the shadowing fact, for the confirmation dialog to display).
 *
 * Saving a project file while the global one has the same name → `hides_global` (in this project the project file wins); saving a global file while the project one has
 * the same name → `hidden_by_project` (in this project it can never run). Neither scope has it → `undefined`.
 */
export function findSavedWorkflowShadowing(options: {
  cwd: string;
  name: string;
  scope: SavedWorkflowScope;
  homeDir?: string;
}): SavedWorkflowShadowing | undefined {
  if (!isValidSavedWorkflowName(options.name)) return undefined;
  const otherScope: SavedWorkflowScope = options.scope === "project" ? "global" : "project";
  const otherRoot = savedWorkflowRoot(options.cwd, otherScope, { homeDir: options.homeDir });
  if (!fileExists(savedWorkflowPath(otherRoot, options.name))) return undefined;
  return options.scope === "project" ? "hides_global" : "hidden_by_project";
}

/** The result of moving the global file back into the project scope. */
export type SavedWorkflowMoveResult =
  | { ok: true; from: string; to: string }
  | { ok: false; reason: "invalid_name"; detail: string }
  | { ok: false; reason: "not_found" }
  | { ok: false; reason: "target_exists"; path: string }
  | { ok: false; reason: "read_error" | "write_error"; path: string; detail: string };

/**
 * Moves `name` from the global root to the project root of `cwd` (**this direction only**).
 *
 * The reverse direction (project→global) is not a file move: a project file usually references paths / commands / conventions of this repository, and moving it byte for byte would just
 * produce a global definition that is guaranteed to break in another project. That direction is the model's generalization ("promote to global": the GUI opens a
 * new session in that project and sends the generalization prompt, and the model saves a separate global file via SaveWorkflow). Global→project is a specialization, since a global definition
 * landing in some project still runs as-is, so it stays a file move.
 *
 * **Moved byte for byte** (no parse, no reserialize): the frontmatter does not store the scope, so moving it is moving the file.
 * `renameSync` is preferred, and a cross-device (EXDEV) case falls back to read→write→delete. An already existing target is refused (no overwrite: overwriting is
 * an action SaveWorkflow only performs after the confirmation dialog). The name passes the legality check first — that is the path-traversal defence itself.
 */
export function moveSavedWorkflow(options: {
  cwd: string;
  name: string;
  homeDir?: string;
}): SavedWorkflowMoveResult {
  const { cwd, name, homeDir } = options;
  if (!isValidSavedWorkflowName(name)) {
    return {
      ok: false,
      reason: "invalid_name",
      detail: `workflow names may only contain letters, digits, '.', '-' and '_', and must be 1-${SAVED_WORKFLOW_MAX_NAME_CHARS} characters`,
    };
  }

  const fromRoot = savedWorkflowRoot(cwd, "global", { homeDir });
  const toRoot = savedWorkflowRoot(cwd, "project", { homeDir });
  const fromPath = savedWorkflowPath(fromRoot, name);
  const toPath = savedWorkflowPath(toRoot, name);

  if (!fileExists(fromPath)) return { ok: false, reason: "not_found" };
  if (fileExists(toPath)) return { ok: false, reason: "target_exists", path: toPath };

  try {
    mkdirSync(toRoot.dir, { recursive: true });
  } catch (error) {
    return { ok: false, reason: "write_error", path: toPath, detail: describeError(error) };
  }

  try {
    renameSync(fromPath, toPath);
    return { ok: true, from: fromPath, to: toPath };
  } catch (error) {
    // When rename crosses devices (for example, the home directory and the project are at different mount points), rename reports EXDEV: read → write → delete fallback transfer,
    // Reading and writing are assigned to separate errors, so that the upper management can say "the source cannot be read" and "the target cannot be written" as two different things.
    if ((error as NodeJS.ErrnoException | undefined)?.code !== "EXDEV") {
      return { ok: false, reason: "write_error", path: toPath, detail: describeError(error) };
    }
  }

  let bytes: Buffer;
  try {
    bytes = readFileSync(fromPath);
  } catch (error) {
    return { ok: false, reason: "read_error", path: fromPath, detail: describeError(error) };
  }
  try {
    writeFileSync(toPath, bytes);
    unlinkSync(fromPath);
  } catch (error) {
    return { ok: false, reason: "write_error", path: toPath, detail: describeError(error) };
  }
  return { ok: true, from: fromPath, to: toPath };
}

function fileExists(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function isNotFound(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  // ENOTDIR: There is a section in the middle of the path that is a file (`.zcode/workflows` was created into a file). For search purposes the same as
  // "Directory does not exist" is the same thing.
  return code === "ENOENT" || code === "ENOTDIR";
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
