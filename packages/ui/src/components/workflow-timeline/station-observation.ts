import type { WorkflowRunState } from "@zcode/shared/zcode-protocol-v4";
import type { PhaseBinder } from "@/components/workflow-graph/instance-phases.js";
import { phaseNameMatches } from "@/components/workflow-graph/phase-name.js";
import type { WorkflowCausalityGraphData } from "@/components/workflow-graph/types.js";

/**
 * What one station observed: the instances landing on that station's sites, plus the **off-table**
 * entries whose boundary falls on this station.
 *
 * Like timeline-bands.ts it only computes a display model, with no dependency on React, the DOM, or
 * a clock.
 */

export interface ObservedPhase {
  visited: boolean;
  rounds: number;
  settled: number;
  observed: number;
  /** The control flow has entered this station (there is an entry record for it in `run.phases`). */
  entered: boolean;
}

/**
 * The ones the reduction cannot list (`run.unlistedByPhase`). `actors` are the subagents born at
 * this station and absent from the table right now — those rejected at birth, those dropped while
 * queued, and those dropped after finishing all count; they have no pill, no face, and no
 * transcript. `settled` is the subset known to have finished, with `failed ⊆ settled`;
 * `nodesSettled` is the number of off-table settled **nodes** recorded on this cell. Absence = this
 * station is missing nothing.
 */
export interface StationUnlisted {
  actors: number;
  settled: number;
  failed: number;
  nodesSettled: number;
}

/**
 * The off-table cell is placed by its **birth-phase stamp**: the same `phaseBinder` as the pill
 * binding and the station observation — one partition, not one broadcast. A cell with no
 * `phaseName` therefore lands on the unnamed station (the same rule as stamp-less instances)
 * instead of arbitrarily picking a station. Two stations re-entered under the same name each take
 * one copy, consistent with the node algorithm.
 */
export function stationUnlisted(
  run: WorkflowRunState | undefined,
  binder: PhaseBinder,
  phaseId: string,
): StationUnlisted | undefined {
  const buckets = run?.unlistedByPhase;
  if (buckets === undefined) return undefined;
  const total: StationUnlisted = { actors: 0, failed: 0, nodesSettled: 0, settled: 0 };
  for (const bucket of buckets) {
    if (!binder.has(phaseId, bucket.phaseName)) continue;
    total.actors += bucket.actors;
    // The zeroed subkeys are absent online: absent refers to "zero", not "don't know" - those that have not yet been completed are therefore left in pending.
    total.settled += bucket.actorsSettled ?? 0;
    total.failed += bucket.actorsFailed ?? 0;
    total.nodesSettled += bucket.settled;
  }
  return total.actors === 0 && total.settled === 0 && total.nodesSettled === 0 ? undefined : total;
}

type WorkflowRunPhaseEntry = NonNullable<WorkflowRunState["phases"]>[number];

/**
 * An entry record for a station: matched by name (`phaseNameMatches`, sharing the rules in
 * phase-name.ts with instance binding). Under the same 128-character prefix there may be two
 * records; the exact one takes precedence.
 */
export function phaseEntryFor(
  run: WorkflowRunState | undefined,
  name: string | undefined,
): WorkflowRunPhaseEntry | undefined {
  const entries = run?.phases;
  if (entries === undefined || name === undefined) return undefined;
  return (
    entries.find((entry) => entry.name === name) ??
    entries.find((entry) => phaseNameMatches(name, entry.name))
  );
}

/**
 * The set of sites: the `source ?? id` of the member steps — a may-set copy reports the site id,
 * from the same source as the correlation key in run-status.ts; dropping `source` would leave copy
 * sites "not yet arrived" forever.
 */
export function siteIdsOf(
  steps: readonly WorkflowCausalityGraphData["steps"][number][],
): Set<string> {
  return new Set(steps.map((step) => step.source ?? step.id));
}

/**
 * The nodes observed at a station: an identical site is not enough — when the same site is
 * re-entered by k phases, the k cards share the site id, and the node must additionally land on
 * this station by the instance's birth stamp (`belongs`), otherwise visited / rounds / fraction are
 * all inflated k-fold.
 */
export function observePhase(
  run: WorkflowRunState | undefined,
  siteIds: ReadonlySet<string>,
  entry: WorkflowRunPhaseEntry | undefined,
  belongs: (node: WorkflowRunState["nodes"][number]) => boolean,
  unlisted: StationUnlisted | undefined,
): ObservedPhase {
  const result: ObservedPhase = {
    entered: false,
    observed: 0,
    rounds: 0,
    settled: 0,
    visited: false,
  };
  if (run === undefined) return result;
  for (const node of run.nodes) {
    if (!siteIds.has(node.siteId) || !belongs(node)) continue;
    result.visited = true;
    result.observed += 1;
    if (node.ordinal > result.rounds) result.rounds = node.ordinal;
    if (node.phase === "settled") result.settled += 1;
  }
  // Settled **node** outside the table: the numerator and denominator are raised together. They did run, but the details stopped at the boundary - undercounting the denominator would make
  // "300/300" becomes "1/1", which is a lie; visited / rounds does not move, those two are talking about control flow.
  result.observed += unlisted?.nodesSettled ?? 0;
  result.settled += unlisted?.nodesSettled ?? 0;
  // Entry record: visited = there is a node at this station ∨ The control flow has entered; the round is the larger of the two (the second round of the single-stage loop
  // Counted by nodes, the second round of zero member stations is only known by entry records).
  if (entry !== undefined) {
    result.entered = true;
    result.visited = true;
    if (entry.rounds > result.rounds) result.rounds = entry.rounds;
  }
  return result;
}
