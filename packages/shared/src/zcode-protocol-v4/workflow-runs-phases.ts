import {
  WORKFLOW_RUNS_LIMITS,
  type WorkflowRunPhase,
  type WorkflowRunState,
} from "./workflow-runs.js";

/**
 * The reduction of `phase-entered`: the control flow passed
 * through a `phase("…")` marker. Living outside the reducer's main file for the same reason as
 * concurrency observation — the main file's max-lines gate.
 *
 * Does not touch nodes / actors — a marker is not a unit of work. `rounds` takes a **max** rather
 * than +1: the engine re-emits the prefix when re-running on resume (a marker has no journal line
 * to dedup against), and a monotonic reduction makes replay a no-op event by event; a missing
 * ordinal (old CLI / truncated payload) is recorded as 1. On hitting the bound, semantics are the
 * same family as actors / nodes: reject the new entry, keep updating existing entries as usual,
 * and the over-bound fact stays in the journal; `currentPhase` is not subject to the limit —
 * "where the control flow is" is a fact and must be stated even if it does not fit in the table.
 */
/**
 * The reduction of `run-launched`: the anchor (inputId) is
 * a matter of event ownership and is not stored in the state; here we only carry over the
 * script-declared phase table `phaseNames`, in declaration order, trimmed to the same pair of
 * bounds as `phases`. Absent or empty table → returned unchanged (only bumping the watermark),
 * the key is not created: the UI draws one implicit station from the absence. It is recorded only
 * once per life, so a resume's `run-started` does not clear it and replay is a no-op event by
 * event.
 *
 * The "running at the same time" table `phaseAlongside` rides along with it (its indices point
 * precisely into the accepted `phaseNames`), so it is only read once the name table has been
 * established, and it is trimmed to that table's length — see {@link readPhaseAlongside}.
 */
export function reduceRunLaunched(
  run: WorkflowRunState,
  payload: Record<string, unknown>,
): WorkflowRunState {
  if (!Array.isArray(payload.phaseNames)) return run;
  const phaseNames: string[] = [];
  for (const raw of payload.phaseNames) {
    if (typeof raw !== "string") continue;
    const name = raw.slice(0, WORKFLOW_RUNS_LIMITS.maxPhaseNameLength);
    if (name.length === 0) continue;
    phaseNames.push(name);
    if (phaseNames.length >= WORKFLOW_RUNS_LIMITS.maxPhases) break;
  }
  if (phaseNames.length === 0) return run;
  const phaseAlongside = readPhaseAlongside(payload.phaseAlongside, phaseNames.length);
  return { ...run, phaseNames, ...(phaseAlongside === undefined ? {} : { phaseAlongside }) };
}

/**
 * The carry-over of the "running at the same time" table, called only after `phaseNames` has been
 * accepted.
 *
 * The indices point into the **accepted** name table, so the whole table is trimmed to its length
 * (padded with empty arrays when the payload is shorter), and each entry is checked again:
 * integer, within `[0, count)`, not itself (a phase does not run in parallel with itself),
 * deduplicated while preserving order, and bounded by the same count. An out-of-range index would
 * make the sidebar connect a double segment to a station that does not exist, so drawing less is
 * preferred.
 *
 * Returns `undefined` when not a single entry survives: the key is not created, and the UI draws a
 * straight line from the absence — the same posture as an empty `phaseNames` table.
 */
function readPhaseAlongside(raw: unknown, count: number): number[][] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: number[][] = [];
  let any = false;
  for (let index = 0; index < count; index += 1) {
    const entry: unknown = raw[index];
    const indexes: number[] = [];
    if (Array.isArray(entry)) {
      for (const value of entry) {
        if (typeof value !== "number" || !Number.isInteger(value)) continue;
        if (value < 0 || value >= count || value === index) continue;
        if (indexes.includes(value)) continue;
        indexes.push(value);
        if (indexes.length >= WORKFLOW_RUNS_LIMITS.maxPhases) break;
      }
    }
    if (indexes.length > 0) any = true;
    out.push(indexes);
  }
  return any ? out : undefined;
}

export function reducePhaseEntered(
  run: WorkflowRunState,
  payload: Record<string, unknown>,
): WorkflowRunState {
  const raw = typeof payload.name === "string" ? payload.name : undefined;
  const name = raw?.slice(0, WORKFLOW_RUNS_LIMITS.maxPhaseNameLength);
  if (name === undefined || name.length === 0) return run;
  const ordinal =
    typeof payload.ordinal === "number" && Number.isInteger(payload.ordinal) && payload.ordinal > 0
      ? payload.ordinal
      : 1;
  const existing = run.phases ?? [];
  const index = existing.findIndex((phase) => phase.name === name);
  let phases: WorkflowRunPhase[];
  let truncated = run.truncated === true;
  if (index >= 0) {
    const current = existing[index]!;
    phases =
      current.rounds >= ordinal
        ? existing
        : existing.map((phase, i) => (i === index ? { ...phase, rounds: ordinal } : phase));
  } else if (existing.length >= WORKFLOW_RUNS_LIMITS.maxPhases) {
    phases = existing;
    truncated = true;
  } else {
    phases = [...existing, { name, rounds: ordinal }];
  }
  return {
    ...run,
    phases,
    currentPhase: name,
    ...(truncated ? { truncated: true } : {}),
  };
}
