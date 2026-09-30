// ============================================================
// **Stage table** of situation cross-section: declared site + visited site
// ============================================================
// The name and phase read the same reduction in the run panel.
// Status (`run.phaseNames` / `run.phases` / `run.currentPhase` / `run.nodes`), what is read at all times is
// Event index - the division of labor on both sides is the same as what is written in the -roster-events.ts file header.
//
// Why does the node count take **reduced state** instead of journal's node row: phase coordinate (`phaseName`) only lives in reduced state
// (The engine only stamps the birth event, there is no such column in the row), taking the row to join will only combine the nodes that cannot be accommodated in the reduction state
// Throw it away; and the reduction state still contains queued nodes that have not yet been executed, which is what counts in "how many are running at the current stage".

import type { DynamicWorkflowRunPhaseView } from "@zcode/contracts";
import type { WorkflowRunNode, WorkflowRunState } from "@zcode/shared/zcode-protocol-v4";
import type { RosterEventIndex } from "./dynamic-workflow-run-roster-events.js";

/** Nodes other than world-read / world-run are all recorded as asks: `kind` is carried only on the birth event, and absent means unknown. */
const WORLD_NODE_KIND = "world-read";

/**
 * The phase table: the declared phases in declaration order, followed by those "entered but never declared"
 * (in first-entry order).
 *
 * **When the script declares nothing and nothing was ever entered, the whole thing returns undefined**: such a run
 * has no notion of phases at all, and emitting an empty array would read as "the phase table is empty", which is a
 * different statement.
 */
export function buildPhaseViews(input: {
  run: WorkflowRunState | undefined;
  index: RosterEventIndex;
  terminal: boolean;
}): DynamicWorkflowRunPhaseView[] | undefined {
  const { run, index, terminal } = input;
  const declared = run?.phaseNames ?? [];
  const entered = run?.phases ?? [];
  if (declared.length === 0 && entered.length === 0) return undefined;

  const names = [...declared];
  const seen = new Set(declared);
  for (const phase of entered) {
    if (seen.has(phase.name)) continue;
    seen.add(phase.name);
    names.push(phase.name);
  }

  const nodes = run?.nodes ?? [];
  return names.map((name) => {
    const rounds = entered.find((phase) => phase.name === name)?.rounds ?? 0;
    const owned = nodes.filter((node) => node.phaseName === name);
    const settled = owned.filter((node) => node.phase === "settled").length;
    const running = owned.length - settled;
    const trace = index.phases.get(name);
    return {
      name,
      state: phaseStateOf({ rounds, terminal, owned, isCurrent: run?.currentPhase === name }),
      rounds,
      nodesSettled: settled,
      nodesRunning: running,
      ...(trace?.enteredAt === undefined ? {} : { enteredAt: trace.enteredAt }),
      ...(trace?.exitedAt === undefined ? {} : { exitedAt: trace.exitedAt }),
    };
  });
}

/**
 * The situation of one phase (see the four words of `DynamicWorkflowRunPhaseState`).
 *
 * `unfinished` **only holds for a terminal run**: while the run is still alive, an in-flight ask in a non-current
 * phase is the norm for a parallel branch, not an abandoned tail — how many of them are in flight is already stated
 * faithfully by `nodesRunning`.
 */
function phaseStateOf(input: {
  rounds: number;
  terminal: boolean;
  owned: readonly WorkflowRunNode[];
  isCurrent: boolean;
}): DynamicWorkflowRunPhaseView["state"] {
  const { rounds, terminal, owned, isCurrent } = input;
  if (rounds === 0) return "ahead";
  if (terminal) {
    const leftover = owned.some(
      (node) => node.phase !== "settled" && node.kind !== WORLD_NODE_KIND,
    );
    return leftover ? "unfinished" : "done";
  }
  return isCurrent ? "current" : "done";
}
