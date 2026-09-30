// ============================================================
// **Situation Cross-section** of Dynamic Workflow Run: Stages / Subagents / Health
// ============================================================
// `getRunDetail` originally only gave the count and a cut
// The log tail cannot answer the three things that the model really wants to ask: where has run gone, what is each sub-agent doing at the moment, and is it still moving.
// This module is a derivation of those three things, and it is just a derivation - a pure function, without touching the journal, registry, or clock:
// Events, node lines, actor lines, reduction states, parking issues, and `now` are all passed in by the caller.
//
// The reason why it is necessary to be pure: the rules of these three groups of fields (the order of determination of status words, the pronunciation of absence, and the only source of time) are high in density and
// Error prone, and their access point (SQLite journal + engine registry) was ridiculously expensive in testing. Separate the rules from the numbers,
// The rules can be nailed down with a handful of events and rows, and only one integration use case is needed to obtain the data to prove that the wiring is connected.
//
// Split: event scan in -roster-events.ts, phase table in -roster-phases.ts, roster in
// -roster-subagents.ts (each file header has its own numbering rules); this file leaves open contracts, health aspects and layout.

import type {
  DynamicWorkflowRunHealth,
  DynamicWorkflowRunLifecycleStatus,
  DynamicWorkflowRunPendingQuestion,
  DynamicWorkflowRunPhaseView,
  DynamicWorkflowRunSubagentView,
} from "@zcode/contracts";
import type { ActorRecord, NodeRecord, StoredEvent } from "@zcode/dynamic-workflow";
import type { WorkflowRunState } from "@zcode/shared/zcode-protocol-v4";
import { TERMINAL_RUN_STATUSES } from "./dynamic-workflow-run-observation.js";
import {
  indexRosterEvents,
  instanceKey,
  type RosterEventIndex,
} from "./dynamic-workflow-run-roster-events.js";
import { buildPhaseViews } from "./dynamic-workflow-run-roster-phases.js";
import { buildSubagentViews, NODE_ROW_RUNNING } from "./dynamic-workflow-run-roster-subagents.js";

/** The `kind` of an ask node row. A losing streak only counts ask settlements: a failed world read is not "the subagent keeps dying". */
const ASK_NODE_KIND = "ask";

/** Input parameters for fetching the situation snapshot. */
interface WorkflowRunRosterInput {
  /**
   * This run's reduced state (the result of replaying journal events through the same reducer the run panel uses).
   * A run with not a single event (a gap in the registry) is passed `undefined`: the phase table is absent then and the roster is empty.
   */
  run: WorkflowRunState | undefined;
  /** All of this run's journal events, in ascending sequence order. The **only** source of time. */
  events: readonly StoredEvent[];
  /** `journal.listNodes(runId)`. Contributes only state and `stats`; the rows carry no time columns at all. */
  nodes: readonly NodeRecord[];
  /** `journal.listActors(runId)`. The roster's roster itself. */
  actors: readonly ActorRecord[];
  /** The run's lifecycle state, the same value the detail surface gives (being terminal rewrites half of the state word). */
  status: DynamicWorkflowRunLifecycleStatus;
  /**
   * The questions currently parked on this run; **`undefined` means this read cannot see the parking table** (the run belongs to
   * another process), in which case `health.pendingQuestionsKnown` is false and no subagent is reported as `parked`.
   * An empty array is the opposite: a definite "nobody is waiting".
   */
  pendingQuestions?: readonly DynamicWorkflowRunPendingQuestion[];
  /** The moment of this read, used only to **upper-clamp** event times (see `timeOf` in -roster-events.ts). */
  now: number;
}

/** The situation snapshot: the detail surface expands these three keys directly. */
interface WorkflowRunRoster {
  phases?: DynamicWorkflowRunPhaseView[];
  subagents: DynamicWorkflowRunSubagentView[];
  health: DynamicWorkflowRunHealth;
}

/** Derives the situation snapshot from the facts already read by one getRunDetail. */
export function buildWorkflowRunRoster(input: WorkflowRunRosterInput): WorkflowRunRoster {
  const { run, events, nodes, actors, status, pendingQuestions, now } = input;
  const terminal = TERMINAL_RUN_STATUSES.has(status);
  const index = indexRosterEvents(events, now);
  const phases = buildPhaseViews({ run, index, terminal });
  return {
    ...(phases === undefined ? {} : { phases }),
    subagents: buildSubagentViews({
      actors,
      nodes,
      run,
      index,
      terminal,
      ...(pendingQuestions === undefined ? {} : { pendingQuestions }),
    }),
    health: buildHealth({ run, nodes, index, terminal, pendingQuestions }),
  };
}

/** Whether the run as a whole is still moving (see `DynamicWorkflowRunHealth`). */
function buildHealth(input: {
  run: WorkflowRunState | undefined;
  nodes: readonly NodeRecord[];
  index: RosterEventIndex;
  terminal: boolean;
  pendingQuestions?: readonly DynamicWorkflowRunPendingQuestion[];
}): DynamicWorkflowRunHealth {
  const { run, nodes, index, terminal, pendingQuestions } = input;
  // The final state of run is a legacy: when run is still alive, "there is a line marked running", which means it is working normally.
  const leftoverRunning = terminal
    ? nodes.filter((node) => node.status === NODE_ROW_RUNNING).length
    : 0;
  return {
    ...(index.lastProgressAt === undefined ? {} : { lastProgressAt: index.lastProgressAt }),
    ...(index.stalledSince === undefined ? {} : { stalledSince: index.stalledSince }),
    ...concurrencyField(run, index),
    consecutiveFailures: countTrailingFailures(nodes, index),
    cachedSteps: index.settlements.filter((settlement) => settlement.cached).length,
    ...(leftoverRunning === 0 ? {} : { leftoverRunning }),
    pendingQuestionsKnown: pendingQuestions !== undefined,
  };
}

/**
 * Concurrency status.
 *
 * `cap` is **this run's own** bound: if the user set one, that is the number; if not, it is the machine ceiling. `effective` is the number
 * the governor is actually letting through right now, i.e. the min of the two with the shared gate.
 *
 * **Present only when `effective < cap`**, following the same absence rule as the detail surface's `maxConcurrency`: a run running at its own
 * bound has nothing to say. Reporting the machine ceiling as `cap` would be wrong — a run started with `max_concurrency: 3` on a six-core
 * machine would display "3/6" forever, which reads like being rate-limited while it is actually running on the bound the user set by hand.
 */
function concurrencyField(
  run: WorkflowRunState | undefined,
  index: RosterEventIndex,
): Pick<DynamicWorkflowRunHealth, "concurrency"> {
  const concurrency = run?.concurrency;
  if (concurrency === undefined) return {};
  const cap = concurrency.limit ?? concurrency.ceiling;
  const effective = Math.min(concurrency.cap, cap);
  if (effective >= cap) return {};
  return {
    concurrency: {
      effective,
      cap,
      ...(index.concurrencyReason === undefined ? {} : { reason: index.concurrencyReason }),
      ...(index.concurrencySince === undefined ? {} : { since: index.concurrencySince }),
    },
  };
}

/**
 * The number of ask failures **consecutive at the end** of the settlement order: failing 3 times in a row and failing 3 times scattered around
 * are two different situations, and the former says the next one will likely fail too. Only asks are counted — a world-read failure is
 * the script's business, not a subagent falling apart. `cancelled` breaks the streak just like a success does: being cancelled is not a failure.
 */
function countTrailingFailures(nodes: readonly NodeRecord[], index: RosterEventIndex): number {
  const askKeys = new Set(
    nodes
      .filter((node) => node.kind === ASK_NODE_KIND)
      .map((node) => instanceKey(node.siteId, node.ordinal)),
  );
  let failures = 0;
  for (let position = index.settlements.length - 1; position >= 0; position -= 1) {
    const settlement = index.settlements[position]!;
    if (!askKeys.has(settlement.key)) continue;
    if (settlement.outcome !== "failed") break;
    failures += 1;
  }
  return failures;
}
