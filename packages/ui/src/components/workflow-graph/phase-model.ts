import { collapseStatuses, hasPhaseVocabulary } from "./participant-model.js";
import type {
  StepRunStatus,
  StepStatusTable,
  WorkflowCausalityGraphData,
  WorkflowPhaseData,
  WorkflowStepData,
} from "./types.js";

/**
 * Pure selectors for the phase layer. A phase is one **layer of business** sitting above the graph:
 * nothing here rewrites the graph itself, it only buckets steps by `Step.phase`. The selectors for
 * the second layer (participants and handoffs) live in participant-model.ts; the old drill-down
 * filter (`filterGraphToPhase`) and roster (`phaseActors`) retired along with step-level rendering.
 *
 * No React, no DOM.
 */

export { hasPhaseVocabulary };

/**
 * Phase id → member steps, bucketed in `phases` order (the order of the phase list is the
 * top-to-bottom semantics on screen). A step copied across phases counts as a member of the phase
 * it actually sits in.
 */
export function phaseMembers(graph: WorkflowCausalityGraphData): Map<string, WorkflowStepData[]> {
  const members = new Map<string, WorkflowStepData[]>(
    (graph.phases ?? []).map((phase) => [phase.id, []]),
  );
  for (const step of graph.steps) {
    if (step.phase === undefined) continue;
    members.get(step.phase)?.push(step);
  }
  return members;
}

/**
 * Re-folding the status of the member steps (see `aggregateRunStatuses` for the cells): members
 * with no entries do not participate; having no entries at all means a static render or a station
 * that was never observed, and returns undefined.
 */
export function collapsePhaseStatus(
  members: readonly WorkflowStepData[],
  statuses: StepStatusTable | undefined,
): StepRunStatus | undefined {
  return collapseStatuses(
    members.map((step) => step.id),
    statuses,
  );
}

/** Look a phase up by id; the inspector and the host need it for display-name material. */
export function findPhase(
  graph: WorkflowCausalityGraphData,
  phaseId: string,
): WorkflowPhaseData | undefined {
  return (graph.phases ?? []).find((phase) => phase.id === phaseId);
}
