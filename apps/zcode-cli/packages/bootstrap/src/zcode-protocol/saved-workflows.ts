// GUI hub for saved workflows: a workspace-level, sessionless approach.
//
// The same precedent as skills/referenceCatalog: without sessionId, the directory will be scanned every time it is called - the snapshot will be missed when mounting.
// The user has manually modified the file/the model has just been saved to disk by SaveWorkflow.
// The parser and serializer are only taken from @zcode/core: frontmatter is not parsed here, nor YAML is spelled.
//
// Global scope: The params of five methods receive optional `scope` (default
// `project`). When `global` is used, the operation is based on the local global root (`~/.zcode/workflows/`). `workspace` is just a **carrier**——
// The processor does not read the path to the global file. `workflows/move` moves global files back to the `workspace` project (only this time).
import { unlink, writeFile } from "node:fs/promises";
import { SavedWorkflowMetaSchema, isValidSavedWorkflowName } from "@zcode/contracts";
import {
  listSavedWorkflows,
  moveSavedWorkflow,
  resolveSavedWorkflow,
  savedWorkflowPath,
  savedWorkflowRoot,
  serializeSavedWorkflow,
  type SavedWorkflowResolveFailure,
} from "@zcode/core";
import {
  ZCODE_WORKFLOWS_RUNS_MAX_LIMIT,
  zcodeWorkflowsDeleteParamsSchema,
  zcodeWorkflowsGetParamsSchema,
  zcodeWorkflowsListParamsSchema,
  zcodeWorkflowsMoveParamsSchema,
  zcodeWorkflowsRunsParamsSchema,
  zcodeWorkflowsUpdateMetaParamsSchema,
  type ZCodeSavedWorkflowRun,
  type ZCodeSavedWorkflowScope,
  type ZCodeWorkflowsDeleteResult,
  type ZCodeWorkflowsGetResult,
  type ZCodeWorkflowsListResult,
  type ZCodeWorkflowsMoveResult,
  type ZCodeWorkflowsRunsResult,
  type ZCodeWorkflowsUpdateMetaResult,
} from "@zcode/shared";
import type { JournalStorePort } from "@zcode/dynamic-workflow";
import { artifactsOf } from "../app/dynamic-workflow-run-observation.js";
import {
  resolveDynamicWorkflowJournalStore,
  supportsRunIntrospection,
} from "../app/dynamic-workflow-run-service.js";
import { parseParams, type ZCodeProtocolAgentServerContext } from "./server-types.js";

// The default is `project`: the old GUI and project file calls without scope will go to the root of the project verbatim, and the shape will not change (version skew).
function scopeOf(params: { scope?: ZCodeSavedWorkflowScope }): ZCodeSavedWorkflowScope {
  return params.scope ?? "project";
}

export async function listSavedWorkflowsOp(
  _context: ZCodeProtocolAgentServerContext,
  rawParams: unknown,
): Promise<ZCodeWorkflowsListResult> {
  const params = parseParams(zcodeWorkflowsListParamsSchema, rawParams);
  const cwd = params.workspace.workspacePath;
  const scope = scopeOf(params);
  // The central PROJECT group only lists the project's share, and the global group only lists the global share - **always** pass the directional scope and never leave it.
  // Undirected variant (two first-wins will mix global into the project group and hide the obscured global from the global group).
  const listed = listSavedWorkflows({ cwd, scope });
  // Scanned directory (returned even if it does not exist): GUI's file monitoring relies on watch.
  return {
    workflows: listed.entries,
    invalid: listed.invalid,
    dir: savedWorkflowRoot(cwd, scope).dir,
  };
}

export async function getSavedWorkflowOp(
  _context: ZCodeProtocolAgentServerContext,
  rawParams: unknown,
): Promise<ZCodeWorkflowsGetResult> {
  const params = parseParams(zcodeWorkflowsGetParamsSchema, rawParams);
  // Directed scope: `global` only checks the global root and does not block it - the central global group must see the copy blocked by the project file.
  const resolved = resolveSavedWorkflow({
    cwd: params.workspace.workspacePath,
    name: params.name,
    scope: scopeOf(params),
  });
  if (!resolved.ok) return toFailure(resolved);
  return {
    ok: true,
    name: resolved.name,
    path: resolved.path,
    scope: resolved.scope,
    meta: resolved.meta,
    script: resolved.script,
  };
}

/**
 * Rewrites only the metadata at the top of the file: read the current script body back, then overwrite the whole file
 * as `serialize(newMeta, script)`. The read-modify-write happens within one call; there is no three-way merge (small file, single machine, the user is the one editing it).
 */
export async function updateSavedWorkflowMetaOp(
  _context: ZCodeProtocolAgentServerContext,
  rawParams: unknown,
): Promise<ZCodeWorkflowsUpdateMetaResult> {
  const params = parseParams(zcodeWorkflowsUpdateMetaParamsSchema, rawParams);
  // The meta schema of shared is aligned verbatim with contracts, but the serializer recognizes the type of contracts; go through it again
  // Let "drift on both sides" blow up to -32602 here instead of writing a file that you can't read back.
  const meta = SavedWorkflowMetaSchema.parse(params.meta);
  const resolved = resolveSavedWorkflow({
    cwd: params.workspace.workspacePath,
    name: params.name,
    scope: scopeOf(params),
  });
  if (!resolved.ok) return toFailure(resolved);
  await writeFile(resolved.path, serializeSavedWorkflow(meta, resolved.script), "utf8");
  return { ok: true, path: resolved.path };
}

/**
 * Deletes by name only: `isValidSavedWorkflowName` runs before the path is assembled — that ordering **is** the path-traversal defence
 * (the same argument as in store.ts), so the protocol takes no path and does not accept `..`. The root is chosen
 * by scope (no longer hardcoding roots[0]): `global` deletes the copy in this machine's global root. A legacy
 * `.workflow.js` file of the same name belongs to a different parser and is out of scope here.
 */
export async function deleteSavedWorkflowOp(
  _context: ZCodeProtocolAgentServerContext,
  rawParams: unknown,
): Promise<ZCodeWorkflowsDeleteResult> {
  const params = parseParams(zcodeWorkflowsDeleteParamsSchema, rawParams);
  if (!isValidSavedWorkflowName(params.name)) {
    return { ok: false, reason: "invalid_name" };
  }
  const root = savedWorkflowRoot(params.workspace.workspacePath, scopeOf(params));
  const path = savedWorkflowPath(root, params.name);
  try {
    await unlink(path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code === "ENOENT" || code === "ENOTDIR") return { ok: false, reason: "not_found" };
    return { ok: false, reason: "read_error", detail: describeError(error) };
  }
  return { ok: true, path };
}

/**
 * Run history, attributed to a workflow by `dwf_run.name`. Journal-only: the hub lives outside every session and cannot
 * see the registry gap between "submit has returned" and "the row is not written yet" — those few microtasks are
 * filled in by the next refresh, which is not worth binding the hub to a session for. A missing journal (an injected
 * test store, an implementation without introspection queries) returns an empty page instead of throwing: the hub then
 * shows "has not run yet".
 *
 * `project` (the default): queries only `dwf_run.cwd === workspacePath`. `global`: does **not** filter by cwd, and takes the
 * run history of that name across all projects (a global workflow runs in any project, so its history spans cwds);
 * every row returns its `cwd` so the GUI can label the project.
 */
export async function listSavedWorkflowRunsOp(
  context: ZCodeProtocolAgentServerContext,
  rawParams: unknown,
): Promise<ZCodeWorkflowsRunsResult> {
  const params = parseParams(zcodeWorkflowsRunsParamsSchema, rawParams);
  const journal = resolveDynamicWorkflowJournalStore(context.deps.sessionStore);
  if (journal === undefined || !supportsRunIntrospection(journal)) return { runs: [] };
  const limit = Math.min(ZCODE_WORKFLOWS_RUNS_MAX_LIMIT, params.limit);
  const global = scopeOf(params) === "global";
  // Take an extra ** just to determine truncated** (the same convention of run service and v4 event paging).
  // The global variant omits the cwd predicate (journal's cwd is optional = across all projects); the project variant passes the cwd, unchanged verbatim.
  const rows = journal.listRuns({
    ...(global ? {} : { cwd: params.workspace.workspacePath }),
    limit: limit + 1,
    ...(params.name === undefined ? {} : { name: params.name }),
  });
  const truncated = rows.length > limit;
  const page = truncated ? rows.slice(0, limit) : rows;
  // Product summary: `listArtifactRows` (journal's persistent home) once per row, only done when the ability is present - if it is absent,
  // If the entire field is absent, the central chips will not be drawn. **Only count the rows** of this page, so the cost is of the same order as the page size (≤ 50).
  const artifactsByRun = savedWorkflowRunArtifacts(journal, page);
  const runs: ZCodeSavedWorkflowRun[] = page.map((row) => ({
    runId: row.runId,
    ...(row.name === undefined ? {} : { name: row.name }),
    status: row.status,
    ...(row.stopReason === undefined ? {} : { stopReason: row.stopReason }),
    createdAt: row.timeCreated,
    updatedAt: row.timeUpdated,
    spentTokens: row.spentTokens,
    ...(row.parentSessionId === undefined ? {} : { parentSessionId: row.parentSessionId }),
    ...(row.toolCallId === undefined ? {} : { toolCallId: row.toolCallId }),
    ...(row.args === undefined ? {} : { args: row.args }),
    // The actual running project directory: the global variant uses it to mark each row of the project; in the project variant, it is always equal to the workspacePath, which is harmless.
    ...(row.cwd === undefined ? {} : { cwd: row.cwd }),
    ...(artifactsByRun.get(row.runId) === undefined
      ? {}
      : { artifacts: artifactsByRun.get(row.runId)! }),
  }));
  return { runs, ...(truncated ? { truncated: true } : {}) };
}

/** The hub chip upper bound: how many kind icons one row can draw (the same value as the protocol schema's `.max(8)`). */
const SAVED_WORKFLOW_RUN_ARTIFACTS_LIMIT = 8;

/**
 * One page of run rows -> the **user-facing artifact** summary of each row.
 *
 * ⚠ Terminology: the artifact here is what the script publishes for the user through `artifact.*`, not the script's top-level
 * return value (the engine's internal `RunSettlement.artifact`).
 *
 * The rows come via {@link artifactsOf}: **the same merge rule** as the snapshot / `GetWorkflowRun` (completed rows only,
 * same id in ascending version order, top-level fields taken from the newest version), and the hub writing its own second
 * copy would make one and the same run's artifacts look different on the hub and on the side panel. `listArtifactRows` is
 * not on the engine port, so the capability probe happens inside `artifactsOf`: absent ⇒ no row gets
 * any entry ⇒ the field is absent as a whole (verbatim unchanged for an old CLI / an injected test store).
 *
 * A run with no artifacts does not enter the table — the caller uses that to make the whole field absent instead of emitting an empty array.
 */
function savedWorkflowRunArtifacts(
  journal: JournalStorePort,
  page: readonly { runId: string }[],
): Map<string, ZCodeSavedWorkflowRun["artifacts"]> {
  const byRun = new Map<string, ZCodeSavedWorkflowRun["artifacts"]>();
  for (const row of page) {
    const { artifacts } = artifactsOf(row.runId, journal);
    if (artifacts === undefined || artifacts.length === 0) continue;
    byRun.set(
      row.runId,
      artifacts.slice(0, SAVED_WORKFLOW_RUN_ARTIFACTS_LIMIT).map((artifact) => ({
        id: artifact.id,
        kind: artifact.kind,
        ...(artifact.title === undefined ? {} : { title: artifact.title }),
        version: artifact.version,
        ...(artifact.contentType === undefined ? {} : { contentType: artifact.contentType }),
      })),
    );
  }
  return byRun;
}

/**
 * Moves the same-named file from this machine's global root to the `workspace` project root (one direction only: project -> global is the model's abstract "promote to global", not a file move). Moved byte
 * for byte (the frontmatter does not store scope), never overwriting (an existing destination is refused, invariant 7). The name is
 * validated before the path is assembled. `workspace` is both the carrier and the target project: core derives the
 * two roots from its cwd and this machine's home.
 */
export async function moveSavedWorkflowOp(
  _context: ZCodeProtocolAgentServerContext,
  rawParams: unknown,
): Promise<ZCodeWorkflowsMoveResult> {
  const params = parseParams(zcodeWorkflowsMoveParamsSchema, rawParams);
  const result = moveSavedWorkflow({ cwd: params.workspace.workspacePath, name: params.name });
  if (result.ok) {
    return { ok: true, from: result.from, to: result.to };
  }
  // The failing branch of core is aligned verbatim with the protocol result; path / detail is brought out unchanged when present (the key is omitted in its absence).
  switch (result.reason) {
    case "invalid_name":
      return { ok: false, reason: "invalid_name", detail: result.detail };
    case "not_found":
      return { ok: false, reason: "not_found" };
    case "target_exists":
      return { ok: false, reason: "target_exists", path: result.path };
    case "read_error":
    case "write_error":
      return { ok: false, reason: result.reason, path: result.path, detail: result.detail };
  }
}

function toFailure(failure: SavedWorkflowResolveFailure) {
  switch (failure.reason) {
    case "invalid_name":
      return { ok: false as const, reason: failure.reason, detail: failure.detail };
    case "not_found":
      return { ok: false as const, reason: failure.reason };
    case "parse_error":
    case "read_error":
      return { ok: false as const, reason: failure.reason, detail: failure.detail };
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
