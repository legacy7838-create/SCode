import type {
  WorkflowRunActor,
  WorkflowRunNode,
  WorkflowRunState,
} from "@zcode/shared/zcode-protocol-v4";
import { phaseBinder } from "./instance-phases.js";
import {
  isSyntheticLaneId,
  type StepRunStatus,
  type StepStatusTable,
  type WorkflowCausalityGraphData,
} from "./types.js";

/**
 * A pure selector for the live overlay view (live view v1).
 *
 * This view deliberately does **not** expand into an instance graph: it is the static causal graph
 * as submitted, with a layer of status decoration on top. The strongest property that buys is that
 * the graph's node and edge sets **never change while a run is in flight** — ranks are monotonic
 * and no reordering happens by construction, because the overlay never places cards. There is
 * exactly one price for that, and only one: a static step corresponds to N runtime instances (loops
 * / fan-out), so statuses have to collapse, and "iteration 3 failed, iteration 4 is running" is a
 * sentence a single card cannot say.
 */
export interface WorkflowRunOverlay {
  /**
   * Statuses indexed by the step ids on the graph. Leaning table-shaped: a step with no observed
   * instances has **no entry**. "Every step has a value" used to be a promise made for the React
   * Flow surface (every card gets decorated); once that surface was retired no consumer needed it,
   * and it made "never ran" share a single `pending` with "queued".
   */
  statuses: StepStatusTable;
  /** Whether ranking edges leaving a running step animate. */
  animatedEdges: boolean;
}

/**
 * Engine phase → four-valued `StepRunStatus`.
 *
 * The vocabulary is written against **the events the engine actually emits**: queued / dispatched /
 * executing / waiting / repairing / nudged / settled. `executing` / `waiting` are the driver's
 * observations: the model request has genuinely gone out / it is waiting on a process-level slot or
 * a backoff.
 *
 * Folding queued / dispatched / waiting into pending is deliberate: all three phases mean "no
 * request is running over at the provider yet" — waiting on FIFO and the per-run cap, a session
 * that is ready but whose first request has not been admitted, or gate queuing and backoff. Actual
 * motion is what executing reports.
 */
export function statusOfRunNode(node: WorkflowRunNode): StepRunStatus {
  switch (node.phase) {
    case "executing":
    case "repairing":
    case "nudged":
      return "running";
    case "settled":
      // Failure and cancellation are both drawn as failed (the two have different semantics in the journal, but the overlay view only uses a four-value vocabulary).
      // Outcome is not reachable in the engine by default (settled must contain outcome); when it does appear, it will be treated as "Ended".
      // Because lying about pending (not started) is worse than missing one color, and lying about failed will cause false alarms.
      return node.outcome === "failed" || node.outcome === "cancelled" ? "failed" : "done";
    default:
      return "pending";
  }
}

/**
 * The single collapse: multiset of instance statuses → one status.
 *
 * - Empty set → `undefined`. Absence is not a status, and the fold does not invent one out of
 *   nothing; consumers resolve the absence along their own control flow.
 * - Any running → running. **Deliberately takes priority over failed**: what a reader most needs to
 *   know is "is it still moving".
 * - Both settled and queued → running: it started, it has not finished. The old rule read that as
 *   pending ("has not started yet"), which is the same confusion in different clothes.
 * - All queued → pending.
 * - All settled: any failed → failed, otherwise done.
 *
 * All four are `any` predicates, so folding by site first and then by participant gives the same
 * result as folding directly by instance — the two-level fold does not drift. The input can be
 * instance statuses (`statusOfRunNode`) or site statuses (this function's output); the vocabulary
 * is the same.
 */
export function aggregateRunStatuses(
  statuses: readonly StepRunStatus[],
): StepRunStatus | undefined {
  if (statuses.length === 0) return undefined;
  if (statuses.includes("running")) return "running";
  const queued = statuses.includes("pending");
  const settled = statuses.some((status) => status === "done" || status === "failed");
  if (queued) return settled ? "running" : "pending";
  return statuses.includes("failed") ? "failed" : "done";
}

/**
 * A card's status-collection entry point. `lane` exists only on a copy that may be set — it is the
 * card's **entire** claim ("this ask may have run on this lane"), so instances on other lanes are
 * irrelevant to it. `phase` is the same kind of claim for a phase copy ("this ask was issued in
 * this phase"): instances born in another phase are irrelevant to it.
 */
interface OverlayTarget {
  instances: StepRunStatus[];
  lane?: string;
  phase?: string;
}

export function workflowRunOverlay(
  run: WorkflowRunState | undefined,
  graph: WorkflowCausalityGraphData,
): WorkflowRunOverlay {
  // Without run, it is static rendering: returning an empty table instead of a full pending table, allowing the component to maintain the appearance of "zero runtime data".
  if (!run) return { statuses: {}, animatedEdges: false };

  // The associated key is **site id**, not card id: may-set. After the lane is expanded, one site corresponds to one card for each candidate lane.
  // The site after the phase copy corresponds to one card in each claiming stage (`ask#1~phase#3`); `source` notes the site expanded from,
  // Both copies are narrowed according to it, and then each is narrowed according to its own opinion - the lane copy is according to the actor lane, and the stage copy is according to the birth stage of the instance.
  // (`phaseName`, the same `phaseBinder` as the card binding and station observation). Missing the last one, a shared helper
  // When a batch of sub-agents are dispatched from each of the five stages, the lights of the first batch of five stations will all light up.
  const byStepId = new Map<string, StepRunStatus[]>();
  const targetsBySiteId = new Map<string, OverlayTarget[]>();
  for (const step of graph.steps) {
    const instances: StepRunStatus[] = [];
    byStepId.set(step.id, instances);
    // Step without source **does not do** lane narrowing: >4 candidate (or including unknown) single card for rollback is drawn in lanes[0],
    // Instances may fall in any of the candidate lanes, and the narrowing will permanently extinguish such cards.
    const target: OverlayTarget = {
      instances,
      ...(step.source === undefined ? {} : { lane: step.lane }),
      ...(step.phase === undefined ? {} : { phase: step.phase }),
    };
    const siteId = step.source ?? step.id;
    const targets = targetsBySiteId.get(siteId);
    if (targets === undefined) targetsBySiteId.set(siteId, [target]);
    else targets.push(target);
  }

  const binder = phaseBinder(graph, run);
  for (const node of run.nodes) {
    // Site ids that do not exist in the graph are ignored: superposition will never add or delete nodes.
    const targets = targetsBySiteId.get(node.siteId);
    if (targets === undefined) continue;
    const status = statusOfRunNode(node);
    for (const target of targets) {
      // ActorSiteId Absence of instances into **all** copies of the site: degenerated into an over-lighting of the old card, rather than a dead map -
      // The liveness clue would rather light up one more square than not light up at all.
      const belongsToOtherLane =
        target.lane !== undefined &&
        node.actorSiteId !== undefined &&
        node.actorSiteId !== target.lane;
      if (belongsToOtherLane) continue;
      // The same is true for the birth stage: instances without stamps (old runs, born before marking) are returned by binder according to existing rules - runs without vocabulary
      // Falling all stages, degenerating into today's over-lighting, rather than lights-out.
      const belongsToOtherPhase =
        target.phase !== undefined && !binder.has(target.phase, node.phaseName);
      if (belongsToOtherPhase) continue;
      target.instances.push(status);
    }
  }

  const statuses: StepStatusTable = {};
  let anyRunning = false;
  for (const [stepId, instanceStatuses] of byStepId) {
    const status = aggregateRunStatuses(instanceStatuses);
    if (status === undefined) continue;
    statuses[stepId] = status;
    if (status === "running") anyRunning = true;
  }

  return { statuses, animatedEdges: anyRunning };
}

/**
 * Lane → the actor instances on that lane (phase 5's transcript drill-down: a single instance opens
 * directly, multiple instances pop a picker).
 *
 * The lane site id is the identity; the display name is presentation only (following the naming
 * contract of causality-graph). `workspace` and `unknown` are synthetic lanes with no session on
 * them, so they always return empty — a world-read step therefore has a selected state but no
 * drill-down.
 */
export function workflowRunActorsForLane(
  run: WorkflowRunState | undefined,
  laneId: string,
): WorkflowRunActor[] {
  if (!run || isSyntheticLaneId(laneId)) return [];
  return run.actors
    .filter((actor) => actor.siteId === laneId)
    .sort((left, right) => left.ordinal - right.ordinal);
}
