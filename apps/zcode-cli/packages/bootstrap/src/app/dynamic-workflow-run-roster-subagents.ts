// ============================================================
// **Sub-agent roster** for situational cross-section: What each sub-agent is doing at the moment
// ============================================================
// a subagent = an actor instance named under
// ask runs sequentially by `actorSeq`, so "what is it doing at the moment" = where does its ask chain go.
//
// The three figures each perform their own duties and do not pretend to be each other:
//   - **actor row/node row** (journal): who exists, whether each ask was successful, and how many tokens were spent. Action is a lasting fact,
//     There is no upper bound, and it will not be eaten by the elimination rules of projection.
//   - **Reduction status**: Task summary and progress reading of this ask (`instructionsHead` / `turn` / `toolCalls` /
//     `lastTool`), and the node's stage coordinates - they only live on events, there are no such columns on rows.
//   - **Event Index**: All moments. See the header of -roster-events.ts.

import type {
  DynamicWorkflowRunPendingQuestion,
  DynamicWorkflowRunSubagentAsk,
  DynamicWorkflowRunSubagentState,
  DynamicWorkflowRunSubagentView,
} from "@zcode/contracts";
import type { ActorRecord, NodeRecord } from "@zcode/dynamic-workflow";
import type { WorkflowRunNode, WorkflowRunState } from "@zcode/shared/zcode-protocol-v4";
import {
  instanceKey,
  laterOf,
  type RosterEventIndex,
  type RosterNodeTrace,
} from "./dynamic-workflow-run-roster-events.js";

/** The node row's "not settled yet" state, and the criterion for `unfinished` / `leftoverRunning`. */
export const NODE_ROW_RUNNING = "running";

/** The ask rows under one subagent, ascending by `actorSeq` (legacy rows missing this column sort first, the order is stable). */
function asksOf(
  nodes: readonly NodeRecord[],
  actor: Pick<ActorRecord, "siteId" | "ordinal">,
): NodeRecord[] {
  return nodes
    .filter((node) => node.actorSiteId === actor.siteId && node.actorOrdinal === actor.ordinal)
    .sort((left, right) => (left.actorSeq ?? 0) - (right.actorSeq ?? 0));
}

/**
 * The roster, in actor row order (= the minting order). **Always returns an array**; no actors at all means an empty array:
 * "how many subagents does this run have" is always a question with an answer, and 0 is that answer.
 *
 * `pendingQuestions` being `undefined` means "this read cannot reach the parked table" (the run belongs to another process): then
 * **no subagent at all is reported as `parked`**, because at this moment "nobody is waiting" and "unknown" cannot be told apart.
 */
export function buildSubagentViews(input: {
  actors: readonly ActorRecord[];
  nodes: readonly NodeRecord[];
  run: WorkflowRunState | undefined;
  index: RosterEventIndex;
  terminal: boolean;
  pendingQuestions?: readonly DynamicWorkflowRunPendingQuestion[];
}): DynamicWorkflowRunSubagentView[] {
  const { actors, nodes, run, index, terminal, pendingQuestions } = input;
  const reduced = new Map<string, WorkflowRunNode>();
  for (const node of run?.nodes ?? []) reduced.set(instanceKey(node.siteId, node.ordinal), node);

  return actors.map((actor) => {
    const asks = asksOf(nodes, actor);
    const settled = asks.filter((ask) => ask.status !== NODE_ROW_RUNNING);
    // The asks of the same subagent are serial, so "the one running" can be at most one; if there are more than one, use actorSeq
    // The biggest one - it was sent down recently.
    const runningAsk = asks.filter((ask) => ask.status === NODE_ROW_RUNNING).at(-1);
    const trace =
      runningAsk === undefined
        ? undefined
        : index.nodes.get(instanceKey(runningAsk.siteId, runningAsk.ordinal));
    const parkedOn = pendingQuestions?.find(
      (question) => question.actor === instanceKey(actor.siteId, actor.ordinal),
    )?.qid;
    const lastAskFailed = settled.at(-1)?.status === "failed";

    return {
      siteId: actor.siteId,
      ordinal: actor.ordinal,
      ...(actor.name === undefined ? {} : { name: actor.name }),
      state: subagentStateOf({
        terminal,
        running: runningAsk !== undefined,
        waiting: trace?.lastLifecycleType === "node-waiting",
        parked: parkedOn !== undefined,
        lastAskFailed,
      }),
      ...phaseNameField({ actor, runningAsk, settled, reduced, run }),
      ...(runningAsk === undefined ? {} : { currentAsk: currentAskOf(runningAsk, reduced, trace) }),
      ...(trace?.wait === undefined ? {} : { wait: trace.wait }),
      ...(parkedOn === undefined ? {} : { parkedOn }),
      stepsSettled: settled.length,
      stepsFailed: settled.filter((ask) => ask.status === "failed").length,
      // Only the tokens of settled ask are accumulated: the one in flight has not yet been accounted for (`stats` is backfilled by the driver during settlement).
      tokens: settled.reduce((total, ask) => total + (ask.stats?.tokens ?? 0), 0),
      ...lastProgressField(asks, index),
    };
  });
}

/**
 * The subagent's situation. **The decision order is the order of this code**, the first match decides — the order is itself part of the contract:
 * a subagent parked waiting for an answer is also "running an ask", so reporting `executing` would hide the one thing that needs a human.
 */
function subagentStateOf(input: {
  terminal: boolean;
  running: boolean;
  waiting: boolean;
  parked: boolean;
  lastAskFailed: boolean;
}): DynamicWorkflowRunSubagentState {
  const { terminal, running, waiting, parked, lastAskFailed } = input;
  if (terminal) {
    // All three alive words in the final state run are gone: the line still marked running only means that the process died under it.
    if (running) return "unfinished";
    return lastAskFailed ? "failed" : "done";
  }
  if (parked) return "parked";
  if (running) return waiting ? "waiting" : "executing";
  return lastAskFailed ? "failed" : "idle";
}

/** The cross-section of the current ask: identity from the row, task and progress from the reduced state, moments from the event index. */
function currentAskOf(
  ask: NodeRecord,
  reduced: ReadonlyMap<string, WorkflowRunNode>,
  trace: RosterNodeTrace | undefined,
): DynamicWorkflowRunSubagentAsk {
  const node = reduced.get(instanceKey(ask.siteId, ask.ordinal));
  const lastTool = node?.lastTool;
  return {
    siteId: ask.siteId,
    ordinal: ask.ordinal,
    ...(ask.actorSeq === undefined ? {} : { actorSeq: ask.actorSeq }),
    ...(node?.instructionsHead === undefined ? {} : { instructionsHead: node.instructionsHead }),
    ...(trace?.dispatchedAt === undefined ? {} : { startedAt: trace.dispatchedAt }),
    ...(node?.turn === undefined ? {} : { turn: node.turn }),
    ...(node?.toolCalls === undefined ? {} : { toolCalls: node.toolCalls }),
    ...(lastTool === undefined
      ? {}
      : {
          lastTool: {
            name: lastTool.name,
            ...(lastTool.target === undefined ? {} : { target: lastTool.target }),
            ...(trace?.lastToolAt === undefined ? {} : { at: trace.lastToolAt }),
          },
        }),
  };
}

/**
 * The phase its current (or last) ask was born in; when neither of the two asks can be read, it falls back to the actor's own birth phase.
 * The phase coordinate only exists on the reduced state, so what is looked up here is the reduced node, not the row.
 */
function phaseNameField(input: {
  actor: Pick<ActorRecord, "siteId" | "ordinal">;
  runningAsk: NodeRecord | undefined;
  settled: readonly NodeRecord[];
  reduced: ReadonlyMap<string, WorkflowRunNode>;
  run: WorkflowRunState | undefined;
}): Pick<DynamicWorkflowRunSubagentView, "phaseName"> {
  const { actor, runningAsk, settled, reduced, run } = input;
  const candidates = [runningAsk, settled.at(-1)];
  for (const ask of candidates) {
    if (ask === undefined) continue;
    const phaseName = reduced.get(instanceKey(ask.siteId, ask.ordinal))?.phaseName;
    if (phaseName !== undefined) return { phaseName };
  }
  const born = run?.actors.find(
    (entry) => entry.siteId === actor.siteId && entry.ordinal === actor.ordinal,
  )?.phaseName;
  return born === undefined ? {} : { phaseName: born };
}

/** The last moment it was observed moving: the last progress-type event of any ask under it. */
function lastProgressField(
  asks: readonly NodeRecord[],
  index: RosterEventIndex,
): Pick<DynamicWorkflowRunSubagentView, "lastProgressAt"> {
  let latest: number | undefined;
  for (const ask of asks) {
    latest = laterOf(latest, index.nodes.get(instanceKey(ask.siteId, ask.ordinal))?.lastActivityAt);
  }
  return latest === undefined ? {} : { lastProgressAt: latest };
}
