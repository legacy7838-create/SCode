import type { WorkflowRunState } from "@zcode/shared/zcode-protocol-v4";
import { phaseBinder } from "./instance-phases.js";
import { aggregateRunStatuses, statusOfRunNode } from "./run-status.js";
import {
  IMPLICIT_PHASE_ID,
  type StepRunStatus,
  type StepStatusTable,
  type WorkflowCausalityGraphData,
  type WorkflowHandoffData,
  type WorkflowParticipantData,
  type WorkflowPhaseData,
} from "./types.js";

/**
 * Pure selectors for the participant layer.
 *
 * The payload's `participants` are already in the **handoff order** sorted by the analyzer (the
 * first card is the opener), and `handoffs` have already been reduced; all that happens here is
 * bucketing, status collapsing, counting, plus two things that belong to the UI itself:
 * - an untagged script is composed into a single implicit phase (`withImplicitPhase`), so the board
 *   has only one way to draw;
 * - while running, `many` cards are split by real instance, member cards are narrowed by ordinal,
 *   and a single card either binds its only instance or is split the same way when there are
 *   several (`liveParticipantView`).
 *
 * No React, no DOM: the projection layer and the components both consume it, and tests call it
 * directly.
 */

export { IMPLICIT_PHASE_ID };

/**
 * It used to be the single decision behind switching views; now it only answers "should this graph
 * compose an implicit phase".
 */
export function hasPhaseVocabulary(graph: WorkflowCausalityGraphData): boolean {
  return graph.phases !== undefined && graph.phases.length > 0;
}

/**
 * A script with no `phase()` markers → a single implicit module: the phase table holds only
 * `workflow` (no name, the UI localizes it to "Workflow"), there are no phase edges, control flow
 * reaches normal completion if and only if the script has a return value; every step and every card
 * belongs to it (the `unphased` the analyzer gives them is only a "no phase" placeholder — the card
 * ids are unchanged). Graphs that do have a glossary are returned as-is (reference equality, memo
 * friendly).
 */
export function withImplicitPhase(graph: WorkflowCausalityGraphData): WorkflowCausalityGraphData {
  if (hasPhaseVocabulary(graph)) return graph;
  return {
    ...graph,
    exits: graph.sink !== undefined && graph.sink.length > 0 ? [IMPLICIT_PHASE_ID] : [],
    participants: graph.participants.map((participant) => ({
      ...participant,
      phase: IMPLICIT_PHASE_ID,
    })),
    phaseEdges: [],
    phases: [{ id: IMPLICIT_PHASE_ID }],
    steps: graph.steps.map((step) => ({ ...step, phase: IMPLICIT_PHASE_ID })),
  };
}

/** The participants of one phase, in payload order (= handoff order). */
export function participantsOfPhase(
  graph: WorkflowCausalityGraphData,
  phaseId: string,
): WorkflowParticipantData[] {
  return graph.participants.filter((participant) => participant.phase === phaseId);
}

export function participantById(
  graph: WorkflowCausalityGraphData,
  id: string,
): WorkflowParticipantData | undefined {
  return graph.participants.find((participant) => participant.id === id);
}

/** Handoff edges whose both ends are in the given set (edges inside a phase). */
export function handoffsWithin(
  graph: WorkflowCausalityGraphData,
  ids: ReadonlySet<string>,
): WorkflowHandoffData[] {
  return graph.handoffs.filter((edge) => ids.has(edge.from) && ids.has(edge.to));
}

export function handoffsAround(
  graph: WorkflowCausalityGraphData,
  id: string,
): { incoming: WorkflowHandoffData[]; outgoing: WorkflowHandoffData[] } {
  return {
    incoming: graph.handoffs.filter((edge) => edge.to === id),
    outgoing: graph.handoffs.filter((edge) => edge.from === id),
  };
}

/**
 * Count material for a card's second line: ask count and workspace read count (a card only ever has
 * one of the two non-zero).
 */
export interface ParticipantCounts {
  asks: number;
  reads: number;
}

export function participantCounts(
  graph: WorkflowCausalityGraphData,
  participant: WorkflowParticipantData,
): ParticipantCounts {
  const kinds = new Map(graph.steps.map((step) => [step.id, step.kind]));
  let asks = 0;
  let reads = 0;
  for (const id of participant.steps) {
    if (kinds.get(id) === "world-read") reads += 1;
    else asks += 1;
  }
  return { asks, reads };
}

/**
 * Any step carrying `repeat` ⇒ the card shows the repeat glyph (self-loops disappear at participant
 * granularity, and this is the trace they leave).
 */
export function participantRepeats(
  graph: WorkflowCausalityGraphData,
  participant: WorkflowParticipantData,
): boolean {
  const repeating = new Set(
    graph.steps.filter((step) => step.repeat !== undefined).map((step) => step.id),
  );
  return participant.steps.some((id) => repeating.has(id));
}

/**
 * Collapsing the statuses of several steps: the statuses of the steps under the name that **have
 * entries** are collected and handed to `aggregateRunStatuses` (the one and only collapse; for its
 * grid, see that cell). Steps with no entries do not take part — they are sites control flow never
 * reached, not nodes queued up. With no entries at all (or a static render) this returns undefined.
 * Shared by the card, the station and the inspector's title lamp.
 */
export function collapseStatuses(
  stepIds: readonly string[],
  statuses: StepStatusTable | undefined,
): StepRunStatus | undefined {
  if (statuses === undefined) return undefined;
  const values: StepRunStatus[] = [];
  for (const id of stepIds) {
    const status = statuses[id];
    if (status !== undefined) values.push(status);
  }
  return aggregateRunStatuses(values);
}

/**
 * A card's status: the per-instance narrowed override supplied by the live view wins (member cards
 * / split instance cards); otherwise it comes from collapsing its steps.
 */
export function participantStatus(
  participant: WorkflowParticipantData,
  statuses: StepStatusTable | undefined,
  participantStatuses?: Record<string, StepRunStatus>,
): StepRunStatus | undefined {
  return participantStatuses?.[participant.id] ?? collapseStatuses(participant.steps, statuses);
}

/** Which other phases the same lane also appears in (the inspector's "also in" row). */
export function participantAlsoIn(
  graph: WorkflowCausalityGraphData,
  participant: WorkflowParticipantData,
): WorkflowPhaseData[] {
  const phases = new Set(
    graph.participants
      .filter((other) => other.lane === participant.lane && other.phase !== participant.phase)
      .map((other) => other.phase),
  );
  return (graph.phases ?? []).filter((phase) => phases.has(phase.id));
}

/** Id of a split instance card: `${participant.id}@${ordinal}`. */
export function instanceCardId(participantId: string, ordinal: number): string {
  return `${participantId}@${ordinal}`;
}

/**
 * The instances under one card: the one belonging to each split instance card (`many` cards, single
 * cards with several instances), or the one the original card **binds** (a single card with exactly
 * one instance, the i-th member of a member card). The name is the effective name emitted by the
 * engine, and the card face reads it first.
 */
export interface ParticipantInstance {
  /** The participant id before splitting (for a bound card, this card's own id). */
  participant: string;
  ordinal: number;
  name?: string;
  /**
   * The original card is bound rather than split: the card id is unchanged, and so is the label
   * rule (member cards are still `#i`, single cards carry no label) — the runtime name gets no
   * visual marker. Absent = a split instance card, whose label reads `#ordinal`.
   */
  bound?: true;
}

export interface LiveParticipantView {
  /**
   * The graph with participants and handoffs split by instance; with no run it is the input graph
   * (reference equality).
   */
  graph: WorkflowCausalityGraphData;
  /**
   * Card statuses narrowed by instance (member cards, instance cards); the remaining cards come
   * from collapsing steps.
   */
  participantStatuses: Record<string, StepRunStatus>;
  /** Instance card id → identity. */
  instances: Record<string, ParticipantInstance>;
}

/**
 * Live view
 *
 * - `many` cards: one card per actor instance that has appeared on the lane, with the handoff edges
 *   copied from the original card onto every instance card; while an instance has not appeared yet
 *   the original single card is kept (its status comes from collapsing steps).
 * - Single cards: exactly one instance on the lane → the original card binds it (id unchanged,
 *   status still collapsed from steps, it just has a name now); two or more → the same split path
 *   as `many` — runtime cardinality beats static cardinality.
 * - Member cards (literal cardinality expansion): the i-th member corresponds to the i-th instance
 *   of the lane ordered by ordinal and binds it, its status looking only at that instance's nodes;
 *   an instance that has not appeared → pending, unbound. Instances beyond `of` get no card.
 * - Composed lanes such as the workspace have no instances, so their cards do not move.
 *
 * Nodes are narrowed by `(siteId ∈ the card's sites, actorSiteId === lane, actorOrdinal ===
 * ordinal, the card's phase ∈ phasesOf(node))`; the site is `step.source ?? step.id` (a may-set
 * copy reports the site id, the same source as the correlation key in run-status.ts). An instance
 * that is present but has no node at any of its sites → pending: the instance is an observed fact
 * that simply has not acted at that station yet (the collapse itself only says undefined for an
 * empty set; resolving absence is this function's job).
 *
 * "Instance binding": an instance claimed by a card is no longer an instance of the **whole lane**
 * — when the same site is re-entered by k phases, k cards share one lane, and claiming by lane is a
 * broadcast (every station would list all 100 of them). See {@link instancesOfCard}.
 */
export function liveParticipantView(
  graph: WorkflowCausalityGraphData,
  run: WorkflowRunState | undefined,
): LiveParticipantView {
  if (run === undefined) return { graph, instances: {}, participantStatuses: {} };
  const siteOf = new Map(graph.steps.map((step) => [step.id, step.source ?? step.id]));
  const binder = phaseBinder(graph, run);
  const sitesOf = (participant: WorkflowParticipantData) =>
    new Set(participant.steps.map((id) => siteOf.get(id) ?? id));
  const index = runIndex(run);
  /**
   * The instances under this card: actors on the lane that have left nodes at **this card's sites**
   * and whose node timestamps fall in this card's phase; actors with no node at all at those sites
   * (created but not yet asked, or not yet reached this station) are placed by **their own birth
   * timestamp** instead. In a run without timestamps `phasesOf` is always the full set of phases,
   * and the two rules together are exactly today's "by lane" — old runs are byte-for-byte
   * unchanged.
   *
   * It goes through the lane index instead of re-scanning `run.nodes` for every card: see {@link
   * runIndex}. The whole lane is ordered only once, in the same order as the previous "filter
   * first, then sort" — the sort is stable and the filter preserves order.
   */
  const instancesOfCard = (participant: WorkflowParticipantData, sites: ReadonlySet<string>) => {
    const claimed: WorkflowRunState["actors"][number][] = [];
    for (const actor of index.actorsBySite.get(participant.lane) ?? []) {
      let seen = false;
      let here = false;
      for (const node of index.nodesByActor.get(actorKey(participant.lane, actor.ordinal)) ?? []) {
        if (!sites.has(node.siteId)) continue;
        seen = true;
        if (binder.has(participant.phase, node.phaseName)) {
          here = true;
          break;
        }
      }
      if (here || (!seen && binder.has(participant.phase, actor.phaseName))) claimed.push(actor);
    }
    return claimed;
  };
  const statusFor = (
    participant: WorkflowParticipantData,
    ordinal: number,
    sites: ReadonlySet<string>,
  ): StepRunStatus => {
    const values: StepRunStatus[] = [];
    for (const node of index.nodesByActor.get(actorKey(participant.lane, ordinal)) ?? []) {
      if (!sites.has(node.siteId) || !binder.has(participant.phase, node.phaseName)) continue;
      values.push(statusOfRunNode(node));
    }
    return aggregateRunStatuses(values) ?? "pending";
  };

  const participants: WorkflowParticipantData[] = [];
  const replacements = new Map<string, string[]>();
  const participantStatuses: Record<string, StepRunStatus> = {};
  const instances: Record<string, ParticipantInstance> = {};
  let changed = false;
  for (const participant of graph.participants) {
    const sites = sitesOf(participant);
    const actors = instancesOfCard(participant, sites);
    if (participant.member !== undefined) {
      const actor = actors[participant.member.index];
      participantStatuses[participant.id] =
        actor === undefined ? "pending" : statusFor(participant, actor.ordinal, sites);
      if (actor !== undefined) instances[participant.id] = boundInstance(participant.id, actor);
      participants.push(participant);
      continue;
    }
    if (participant.many !== true && actors.length === 1) {
      instances[participant.id] = boundInstance(participant.id, actors[0]!);
      participants.push(participant);
      continue;
    }
    if (participant.many === true || actors.length > 1) {
      if (actors.length === 0) {
        participants.push(participant);
        continue;
      }
      changed = true;
      const ids: string[] = [];
      for (const actor of actors) {
        const id = instanceCardId(participant.id, actor.ordinal);
        const { many: _many, ...rest } = participant;
        participants.push({ ...rest, id });
        participantStatuses[id] = statusFor(participant, actor.ordinal, sites);
        instances[id] = {
          ordinal: actor.ordinal,
          participant: participant.id,
          ...(actor.name === undefined ? {} : { name: actor.name }),
        };
        ids.push(id);
      }
      replacements.set(participant.id, ids);
      continue;
    }
    participants.push(participant);
  }
  if (!changed) return { graph, instances, participantStatuses };

  const handoffs: WorkflowHandoffData[] = [];
  for (const edge of graph.handoffs) {
    const froms = replacements.get(edge.from) ?? [edge.from];
    const tos = replacements.get(edge.to) ?? [edge.to];
    for (const from of froms) for (const to of tos) handoffs.push({ ...edge, from, to });
  }
  return { graph: { ...graph, handoffs, participants }, instances, participantStatuses };
}

/**
 * Keys are joined with `\0`, for the same reason as the shared `workflow-runs-actor-status.ts`: a
 * siteId is an arbitrary string from the engine, and a printable separator such as `-` would make
 * ("a-1", 2) collide with ("a", "1-2").
 */
function actorKey(siteId: string, ordinal: number): string {
  return `${siteId}\0${ordinal}`;
}

interface RunIndex {
  /** `actorKey` → the nodes under that instance, in `run.nodes` order. */
  nodesByActor: ReadonlyMap<string, WorkflowRunState["nodes"][number][]>;
  /** Lane → the actors on that lane, sorted by ascending ordinal (claim order). */
  actorsBySite: ReadonlyMap<string, WorkflowRunState["actors"][number][]>;
}

/**
 * The two indexes built once per view. Without them every instance card would have to re-scan
 * `run.nodes` to collect its own status — at the table limit that is 1024 instances × 1024 nodes, a
 * million comparisons per frame. With the indexes, modelling is linear in actors + nodes.
 *
 * Nodes without an actor (world-reads) and older payloads without an ordinal do not go into the
 * indexes: the original filter condition `node.actorSiteId === lane && node.actorOrdinal ===
 * ordinal` is always false for them, so dropping them is equivalent.
 */
function runIndex(run: WorkflowRunState): RunIndex {
  const nodesByActor = new Map<string, WorkflowRunState["nodes"][number][]>();
  for (const node of run.nodes) {
    if (node.actorSiteId === undefined || node.actorOrdinal === undefined) continue;
    const key = actorKey(node.actorSiteId, node.actorOrdinal);
    const bucket = nodesByActor.get(key);
    if (bucket === undefined) nodesByActor.set(key, [node]);
    else bucket.push(node);
  }
  const actorsBySite = new Map<string, WorkflowRunState["actors"][number][]>();
  for (const actor of run.actors) {
    const bucket = actorsBySite.get(actor.siteId);
    if (bucket === undefined) actorsBySite.set(actor.siteId, [actor]);
    else bucket.push(actor);
  }
  for (const actors of actorsBySite.values()) actors.sort((a, b) => a.ordinal - b.ordinal);
  return { actorsBySite, nodesByActor };
}

function boundInstance(
  participantId: string,
  actor: WorkflowRunState["actors"][number],
): ParticipantInstance {
  return {
    bound: true,
    ordinal: actor.ordinal,
    participant: participantId,
    ...(actor.name === undefined ? {} : { name: actor.name }),
  };
}
