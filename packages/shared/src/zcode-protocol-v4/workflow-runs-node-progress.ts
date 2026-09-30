// ============================================================
// **Task and progress reading** for an ask: three counts of node-queued instructionsHead + node-progress
// ============================================================
// Live outside the reducer main file for the same reason as workflow-runs-phases.ts: the main file's max-lines gate.
//
// These keys answer questions that the phase cannot answer: an ask can stay on `executing` for ten minutes, and you cannot tell the difference just by looking at the phase.
// "Doing a long job" and "already dead". `turn` / `toolCalls` / `lastTool` is the dividing line,
// `instructionsHead` answers "What is this subagent assigned to do?"
//
// Two structural facts that are easy to ignore:
//   1. Reduce the entire node object on each `node-*` event (only kind / actor ref / phaseName depends on
//      previousNode is carried forward). So these four keys must be carried explicitly - otherwise the next item in `node-progress`
//      Lifecycle events wipe clean the readings that just dropped.
//   2. There are two **birth** events for an ask: `node-queued`, and the one sent directly when replay hits.
//      `node-settled { cached: true }` (That node is not queued, it is a birth event - the same as in the main file
//      The precedent for phaseName is verbatim the same). When the same site instance is queued again in resume, it is a new one.
//      ask, the round is restarted from 1; the settlement of the cache hit is not run at all. So the **birth event clears out** the three from the previous life.
//      Count them instead of inheriting them - inheritance will cause a node that has not moved a step in this life to display "9th round, 40th tool"
//      Call", that is the illusion that these readings are used to rule out.

import {
  WORKFLOW_RUNS_LIMITS,
  type WorkflowRunNode,
  type WorkflowRunNodeLastTool,
  type WorkflowRunState,
} from "./workflow-runs.js";

/** The task and progress readings of one ask — the four keys this module is responsible for. */
type NodeProgressFields = Pick<
  WorkflowRunNode,
  "instructionsHead" | "turn" | "toolCalls" | "lastTool"
>;

/**
 * The values of those four keys on lifecycle events (`node-queued` … `node-settled`).
 *
 * The three counters are only carried forward (written by {@link reduceNodeProgress}) and
 * **cleared on the two birth events** — see rule 2 in the file header. `instructionsHead` only
 * arrives on the `node-queued` payload (the instructions at that moment are the author's original
 * text; the engine's trailing note is appended later by the driver); every other event carries it
 * forward.
 *
 * The task summary and the three counters are **deliberately out of sync** on a cache-hit
 * settlement: the completion cache hits on an input hash, so that ask's instructions are
 * verbatim identical to the previous life and the inherited summary says the same thing, whereas
 * the counters describe an execution that **did not happen in this life**. On a re-queue even
 * the summary only trusts the new payload: that is a new instruction that may have been revised.
 */
export function carryNodeProgress(
  eventType: string,
  payload: Record<string, unknown>,
  previousNode: WorkflowRunNode | undefined,
): Partial<NodeProgressFields> {
  const requeued = eventType === "node-queued";
  const born = requeued || (eventType === "node-settled" && payload.cached === true);
  const carried = born ? undefined : previousNode;
  const head = boundedText(
    payload.instructionsHead,
    WORKFLOW_RUNS_LIMITS.maxInstructionsHeadLength,
  );
  const instructionsHead = requeued ? head : (head ?? previousNode?.instructionsHead);
  return {
    ...(instructionsHead === undefined ? {} : { instructionsHead }),
    ...(carried?.turn === undefined ? {} : { turn: carried.turn }),
    ...(carried?.toolCalls === undefined ? {} : { toolCalls: carried.toolCalls }),
    ...(carried?.lastTool === undefined ? {} : { lastTool: carried.lastTool }),
  };
}

/**
 * The reduction of `node-progress`: the readings of a resolved turn land on the node that is
 * **already in the table**.
 *
 * **Only these three keys change** — no phase change, no step count, no actor state: a resolved
 * turn is not a lifecycle transition, and the phase is still governed by the `node-executing` /
 * `node-waiting` events. An instance that is not in the table (rejected for hitting the bound, or
 * whose progress precedes its `node-queued`) is ignored entirely with no entry created, in the
 * same family as every other node event for an unknown instance.
 *
 * A single unreadable field **keeps the known value** rather than being erased: an event that
 * only reports toolCalls should not make the turn count disappear. Writes are
 * **last-writer-wins** rather than a max (the opposite of `phases[].rounds`); see rule 2 in the
 * file header for the reasoning.
 */
export function reduceNodeProgress(
  run: WorkflowRunState,
  ref: { siteId: string; ordinal: number },
  payload: Record<string, unknown>,
): WorkflowRunState {
  const index = run.nodes.findIndex(
    (node) => node.siteId === ref.siteId && node.ordinal === ref.ordinal,
  );
  if (index < 0) return run;
  const node = run.nodes[index]!;
  const turn = readPositiveInt(payload.turn) ?? node.turn;
  const toolCalls = readNonNegativeInt(payload.toolCalls) ?? node.toolCalls;
  const lastTool = readLastTool(payload.lastTool) ?? node.lastTool;
  const nodes = [...run.nodes];
  nodes[index] = {
    ...node,
    ...(turn === undefined ? {} : { turn }),
    ...(toolCalls === undefined ? {} : { toolCalls }),
    ...(lastTool === undefined ? {} : { lastTool }),
  };
  return { ...run, nodes };
}

/** The turn is a positive integer starting at 1: there is no "turn 0", and 0 / fractional / NaN are all treated as unreadable. */
function readPositiveInt(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

/** The tool call count may be 0 — "not a single tool was called" is a fact, not an absence. */
function readNonNegativeInt(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}

/** The tool name is the reason this record exists; if it cannot be read the whole record is dropped (a lastTool with only a target says nothing). */
function readLastTool(value: unknown): WorkflowRunNodeLastTool | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const name = boundedText(record.name, WORKFLOW_RUNS_LIMITS.maxLastToolNameLength);
  if (name === undefined) return undefined;
  const target = boundedText(record.target, WORKFLOW_RUNS_LIMITS.maxLastToolTargetLength);
  return { name, ...(target === undefined ? {} : { target }) };
}

/**
 * Trims to the wire bound, treating the empty string as absent.
 *
 * The production side has already trimmed once (the engine's `INSTRUCTIONS_HEAD_MAX_CHARS` /
 * `LAST_TOOL_TARGET_MAX_CHARS`); this is the second gate, in the same family and for the same
 * reason as `boundedActorName` / `boundedPhaseName`: an over-bound string makes every frame after
 * the parent session be rejected by the renderer. **Truncate directly, with no ellipsis** — the
 * summary is a head by nature, marking the continuation is the renderer's business, and this
 * protocol rule only guarantees legality.
 */
function boundedText(value: unknown, limit: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.slice(0, limit);
  return text.length > 0 ? text : undefined;
}
