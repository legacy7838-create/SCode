import type { WorkflowRunState } from "@zcode/shared/zcode-protocol-v4";
import { phaseNameMatches } from "./phase-name.js";
import type { WorkflowCausalityGraphData } from "./types.js";

/**
 * The phase a runtime instance belongs to.
 *
 * The static may-set copy is indexed by phase (`ask#1~phase#3`), and a runtime instance carries the
 * same coordinate — the current phase name (`phaseName`) that the engine recorded at the moment it
 * minted the ordinal. This file collapses "which display phases does one stamp land on" into a
 * single rule, shared by card binding (participant-model.ts) and station observation
 * (timeline-model.ts): one **partition**, not one broadcast.
 */

/**
 * Has this run said anything about phases — does any actor / node carry a stamp? The legacy CLI,
 * legacy runs, and untagged scripts do not.
 */
export function runHasPhaseVocabulary(run: WorkflowRunState | undefined): boolean {
  if (run === undefined) return false;
  return (
    run.actors.some((actor) => actor.phaseName !== undefined) ||
    run.nodes.some((node) => node.phaseName !== undefined)
  );
}

/**
 * The set of phases one stamp belongs to:
 * - stamped → display phases whose names match (`phaseNameMatches`, where the truncation fallback
 *   lives);
 * - unstamped and the run has a vocabulary → the **unnamed** display phases (`unphased` / implicit
 *   `workflow`): the step analyzers from before the first marker sit exactly in the unnamed
 *   `unphased`, so "unstamped ↔ unnamed" is two sides of the same fact;
 * - unstamped and the run has no vocabulary → all phases (today's behavior). An empty result from
 *   any branch → all phases: showing something twice is better than hiding a subagent that is still
 *   running.
 */
export function phasesOf(
  phaseName: string | undefined,
  graph: WorkflowCausalityGraphData,
  runHasVocabulary: boolean,
): Set<string> {
  const phases = graph.phases ?? [];
  const all = () => new Set(phases.map((phase) => phase.id));
  if (phaseName === undefined && !runHasVocabulary) return all();
  const matched = phases.filter((phase) =>
    phaseName === undefined ? phase.name === undefined : phaseNameMatches(phase.name, phaseName),
  );
  return matched.length === 0 ? all() : new Set(matched.map((phase) => phase.id));
}

/**
 * A resolver computed once per view: the vocabulary check and each stamp's result are computed only
 * once (every node has to ask).
 */
export interface PhaseBinder {
  phasesOf(phaseName: string | undefined): ReadonlySet<string>;
  /** Does this stamp belong to this station / this card? */
  has(phaseId: string, phaseName: string | undefined): boolean;
}

export function phaseBinder(
  graph: WorkflowCausalityGraphData,
  run: WorkflowRunState | undefined,
): PhaseBinder {
  const vocabulary = runHasPhaseVocabulary(run);
  // The graph itself does not yet have a phase vocabulary (the original graph without markup script, before the implicit phase of UI composition): there are no coordinates to divide,
  // All are counted as belonging - otherwise "the belonging set is always empty" will erase all instances of each card.
  const ungrouped = (graph.phases ?? []).length === 0;
  const cache = new Map<string | undefined, ReadonlySet<string>>();
  const resolve = (phaseName: string | undefined): ReadonlySet<string> => {
    const hit = cache.get(phaseName);
    if (hit !== undefined) return hit;
    const phases = phasesOf(phaseName, graph, vocabulary);
    cache.set(phaseName, phases);
    return phases;
  };
  return {
    has: (phaseId, phaseName) => ungrouped || resolve(phaseName).has(phaseId),
    phasesOf: resolve,
  };
}
