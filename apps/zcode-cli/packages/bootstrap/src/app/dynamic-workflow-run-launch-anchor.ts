// ============================================================
// dwf run launch anchor point
// ============================================================
// The agent_step of the subagent should be classified under "the round that initiated this run". The anchor is an inputId,
// Live in the journal event `run-launched` with zero SQL (only once in the run generation):
//   - It is parsed from this file when submitting (active wheel / direct start casting value / front-wheel drive run anchor point / pocket casting value)
//     Leave it to the engine for storage;
//   - The derived fields of resume and progress events are read back from the journal, and the anchor points of the same run are therefore unique across the life cycle.
//
// The same event also carries three pieces of the same host metadata: the phase table (`phaseNames`) declared by the script, the run subagent's
// Which file does the selection (`subagentModel`) and the script come from (`scriptPath`). All four are only written once in the life of the build run, the engine does not read at all, and they all have zero SQL - `dwf_run`.
// There is no corresponding column.

import type { TraceContext } from "@zcode/contracts";
import type { JournalStorePort } from "@zcode/dynamic-workflow";
import { uuidv7 } from "@zcode/shared";

export interface RunLaunchAnchor {
  /** The inputId of the turn that initiated the run (a minted UUID v7 for a hub direct launch). */
  inputId: string;
}

/**
 * Everything handed to the engine to record in `run-launched`: the anchor + the phase table declared by the script + the subagent selection for this run (`subagentModel`, the canonical picker string
 * `providerId/modelId[$reasoningLevel]`).
 *
 * The latter two are **not** part of the anchor: a revision resume reuses the predecessor's inputId, yet takes the phase table of the new script, and it never reuses
 * the predecessor's model either ("omitted means inherit the predecessor" is a tri-state on the tool surface, normalized by AmendWorkflow's resolveInput) —
 * so they are merged alongside the anchor in submit rather than stuffed into {@link resolveLaunchAnchor}.
 */
export interface RunLaunch extends RunLaunchAnchor {
  phaseNames?: string[];
  subagentModel?: string;
  /**
   * The absolute path of this run's script file. Just like the phase table and the
   * subagent selection, it is not part of the anchor: a revision records which file **this** revision's script came from, and never reuses the predecessor's.
   */
  scriptPath?: string;
  /** The "running alongside" table positionally aligned with `phaseNames` (its indices point into the same table); likewise only journaled in the lifetime of run creation. */
  phaseAlongside?: number[][];
}

/**
 * Reads a run's anchor back from the journal: the first `run-launched`. A run launched before the upgrade has no such event → `undefined`,
 * and the caller then does not derive `launchInputId` (the fact layer accordingly emits no `workflow.lifecycle`, the subagent reports nothing, and nothing is fabricated).
 *
 * The anchor immediately follows the first `run-started` (the engine's recording order), so only the first few journal entries are read
 * instead of pulling the whole journal into memory; `RUN_LAUNCH_ANCHOR_SCAN_LIMIT` leaves headroom in case run-creation events are ever inserted ahead of it.
 */
const RUN_LAUNCH_ANCHOR_SCAN_LIMIT = 8;

export function readRunLaunchAnchor(
  journal: JournalStorePort,
  runId: string,
): RunLaunchAnchor | undefined {
  for (const stored of journal.listEvents(runId, { limit: RUN_LAUNCH_ANCHOR_SCAN_LIMIT })) {
    if (stored.event.type === "run-launched") return { inputId: stored.event.inputId };
  }
  return undefined;
}

/**
 * Reads this run's subagent selection back from the journal: the `subagentModel` on that same `run-launched`. Resume, both read surfaces and cold replay all restore the same canonical string from it —
 * zero SQL, there is no such column on `dwf_run`. Absence means the subagent runs on the session model (the vast majority of runs, including those
 * launched before the upgrade).
 *
 * Same scan and same limit as the anchor, yet **deliberately not hung on** {@link RunLaunchAnchor}:
 * {@link resolveLaunchAnchor} lets a revision resume inherit the predecessor's anchor, but the model must never be inherited that way — that is
 * the tri-state on the tool surface (omitted = inherit the predecessor, null = fall back to the session model, string = set it), normalized in
 * `AmendWorkflow`'s resolveInput, by the same argument as `max_concurrency`.
 */
export function readRunSubagentModel(journal: JournalStorePort, runId: string): string | undefined {
  for (const stored of journal.listEvents(runId, { limit: RUN_LAUNCH_ANCHOR_SCAN_LIMIT })) {
    if (stored.event.type === "run-launched") return stored.event.subagentModel;
  }
  return undefined;
}

/**
 * Reads this run's script file back from the journal: the `scriptPath` on that same `run-launched`. The cold path of both read surfaces restores
 * the same absolute path from it — zero SQL, there is no such column on `dwf_run`. Absence means this run has no editable script file
 * (projects whose draft could not be written, runs launched before this feature).
 *
 * Same scan and same limit as {@link readRunSubagentModel}, and likewise **deliberately not hung on**
 * {@link RunLaunchAnchor}: the anchor is inherited by a revision resume, whereas the predecessor's script path points at the old script,
 * and reusing it would send the model off to edit a file that is no longer running.
 */
export function readRunScriptPath(journal: JournalStorePort, runId: string): string | undefined {
  for (const stored of journal.listEvents(runId, { limit: RUN_LAUNCH_ANCHOR_SCAN_LIMIT })) {
    if (stored.event.type === "run-launched") return stored.event.scriptPath;
  }
  return undefined;
}

/**
 * Resolves the anchor at submit time. Priority:
 *   1. A revision resume (`resume_from`) reuses the **predecessor's** anchor — every step of the same work hangs off the same message;
 *   2. The `launchInputId` explicitly given by the caller (hub direct launch: one UUID v7 shared with the controlOnly launch turn);
 *   3. The inputId of the parent runtime's active turn (chat CreateWorkflow: the tool executes in that turn);
 *   4. Fallback: mint a UUID v7 (CLI, hosts with no active turn, revisions whose predecessor has no anchor).
 */
export function resolveLaunchAnchor(input: {
  requested?: string;
  trace: TraceContext;
  resolveLaunchInputId?: (trace: TraceContext) => string | undefined;
  predecessor?: RunLaunchAnchor;
  mint?: () => string;
}): RunLaunchAnchor {
  if (input.predecessor !== undefined) return input.predecessor;
  const inputId =
    input.requested ?? input.resolveLaunchInputId?.(input.trace) ?? (input.mint ?? uuidv7)();
  return { inputId };
}
