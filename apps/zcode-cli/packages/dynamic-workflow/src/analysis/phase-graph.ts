import { UNPHASED_ID } from "./constants.js";
import type { OrderEvent, PhaseInfo } from "./causality-order.js";
import { KIND_RANK, reduceOrdering, type OrderKind } from "./causality-reduce.js";
import type { CausalityGraph, Certainty, OrderEdge, Phase, Step } from "./causality-graph.js";

/**
 * The phase view: the grouping imposed by the author's `phase("name")` markers, and its **quotient graph** over the causality graph.
 *
 * The causality graph itself is not touched by a single character — only two things are done here, and both are mechanical rewrites of the finished graph:
 *
 *  - **Cross-phase copies**: a step claimed by more than one phase becomes one copy per claiming phase (a `~`-suffixed id plus a `source` correlation
 *    key, the same mechanism and the same separator as a may-set lane copy), which makes the total partition "every step has exactly one phase"
 *    hold;
 *  - **Quotient graph**: the reduced step edges are projected onto phase pairs along the claim relation, deduplicated, and run through the very same
 *    {@link reduceOrdering}.
 *
 * For a script with no markers this is the identity function overall: all three fields are absent and existing snapshots stay byte-identical. That is not an optimization, it is
 * the contract — "is the phase vocabulary present" is exactly the UI's view-toggle condition.
 *
 * A module of its own rather than stuffed into causality-graph.ts: that file is already over its max-lines, and phases are a layer of view
 * above it, just as the causality graph is a layer of view above the site graph.
 */

/** The copy id separator: the same one as a may-set lane copy (when the two expansions stack, it looks like `ask#2~actor#1~phase#2`). */
const COPY_SEPARATOR = "~";

/** The claim relation: who belongs to which phase, and how certain that claim is. All of it keyed by **site id**. */
interface PhaseClaims {
  /** site -> the phases that claim it, deduplicated in issue order. */
  bySite: Map<string, string[]>;
  /** `${site}|${phase}` -> the certainty of the claim inside that phase. */
  certainty: Map<string, Certainty>;
  /** phase -> the clock position of its first member issue; the sort key of a quotient-graph fact. */
  position: Map<string, number>;
  /** `${site}|${phase}` -> that site's first / last issue position within that phase (for the temporal feasibility decision). */
  firstIssue: Map<string, number>;
  lastIssue: Map<string, number>;
}

/** The input of the quotient graph: the reduced step edges (sink edges already removed), with certainty already inherited along the endpoints. */
export interface PhaseSourceFact {
  from: string;
  to: string;
  kind: OrderKind;
  certainty: Certainty;
  /** The underlying kind of a carry edge before retyping; carry minimization judges witness strength by it. */
  carryOf?: Exclude<OrderKind, "carry">;
  /**
   * The set of phases the issue event witnessing this fact lives in (only the seq facts produced by an await barrier carry it; see
   * `Fact.toPhases` in causality-graph.ts). Head-side narrowing follows {@link headPhasesOf}.
   */
  toPhases?: ReadonlySet<string>;
}

/**
 * Which phases the head of an edge should land on: **take the intersection when there is provenance information, expand it fully when there is none**.
 *
 * Copy rewriting and quotient-graph projection must use one and the same rule, otherwise `phaseEdges` and the step edges in the drill-down would tell two different
 * stories — that is the whole reason for binding two consumers to a single function.
 *
 * In practice the intersection equals `toPhases` itself (the witnessing phases of a barrier fact are necessarily the claim phases of the head site), and writing it out as an intersection
 * is what keeps upstream changes such as "a phase was dropped/narrowed" from hanging an edge on a phase that does not exist.
 */
function headPhasesOf(claiming: readonly string[], toPhases: ReadonlySet<string> | undefined): string[] {
  if (toPhases === undefined) return [...claiming];
  const narrowed = claiming.filter((phase) => toPhases.has(phase));
  return narrowed.length > 0 ? narrowed : [...claiming];
}

/**
 * The claim relation is read out of the issue events. An issue is the identity moment of a step, so this single pass is all of the attribution logic.
 *
 * The certainty of each (site, phase) is derived on its own: an issue determined by the region chain **exists** within that phase, and that
 * step is not the target of a control edge. It corresponds verbatim to `certaintyOf` in causality-graph.ts, only with "all issues" replaced by
 * "that phase's issues" — when the shared helper has one copy at preflight (top level) and another at gate (inside loops + branches),
 * the certainties of the two copies may therefore differ, which is exactly why copies have to be derived separately.
 */
export function collectPhaseClaims(
  events: readonly OrderEvent[],
  steps: ReadonlySet<string>,
  certainChain: (chain: readonly string[]) => boolean,
  controlled: ReadonlySet<string>,
): PhaseClaims {
  const bySite = new Map<string, string[]>();
  const position = new Map<string, number>();
  const firstIssue = new Map<string, number>();
  const lastIssue = new Map<string, number>();
  const certainSeen = new Set<string>();
  // The same clock as causality-graph.ts: each issue event moves one grid, regardless of whether it falls on a step in the graph.
  let clock = 0;
  for (const event of events) {
    if (event.at !== "issue") continue;
    const at = clock;
    clock += 1;
    if (!steps.has(event.step)) continue;
    const claiming = bySite.get(event.step);
    if (claiming === undefined) bySite.set(event.step, [event.phase]);
    else if (!claiming.includes(event.phase)) claiming.push(event.phase);
    if (!position.has(event.phase)) position.set(event.phase, at);
    const key = `${event.step}|${event.phase}`;
    if (!firstIssue.has(key)) firstIssue.set(key, at);
    lastIssue.set(key, at);
    if (certainChain(event.regions)) certainSeen.add(key);
  }

  const certainty = new Map<string, Certainty>();
  for (const [site, claiming] of bySite) {
    for (const phase of claiming) {
      const key = `${site}|${phase}`;
      certainty.set(key, certainSeen.has(key) && !controlled.has(site) ? "always" : "maybe");
    }
  }
  return { bySite, certainty, firstIssue, lastIssue, position };
}

/**
 * Adds the phase vocabulary to the finished causality graph: the copies, `Step.phase`, the phase table, the phase edges.
 *
 * It runs **after** `expandMaySetLanes` (claiming each lane copy individually), and just like it is a "mechanical rewrite of the finished
 * graph": the existing contents of the step set, the lanes, the regions and the step edges are all left unrecomputed.
 */
export function projectPhaseGraph(
  graph: CausalityGraph,
  phases: readonly PhaseInfo[],
  claims: PhaseClaims,
  facts: readonly PhaseSourceFact[],
  sharesIteration: (a: string, b: string) => boolean,
): CausalityGraph {
  if (phases.length === 0) return graph; // Zero tag → zero vocabulary, the image does not move byte by byte

  const claimsOf = (siteId: string): string[] => claims.bySite.get(siteId) ?? [UNPHASED_ID];
  const certaintyOfClaim = (siteId: string, phase: string): Certainty =>
    claims.certainty.get(`${siteId}|${phase}`) ?? "maybe";

  /**
   * Temporal feasibility: whether an a→b edge can land on the copy pair (a@P, b@Q).
   *
   * Every phase copy **occupies one temporal position**, and that is the fundamental difference from a may-set lane copy — lane copies sit side by side
   * at the same rank, so full expansion asserts no order at all, while a full expansion of phase copies asserts a false order ("the gate's bench settle
   * comes before the preflight's bench issue"). And the information walk does exist here: the issue position of every (site, phase). Multiple orderings
   * are the permitted direction, wrong orderings are not.
   *
   * Two channels, in disjunction:
   *  - **Position**: b has at least one issue in Q that falls after a's first issue in P;
   *  - **Repetition**: the two sites share a closed iteration region. This one **is not optional** — a producer in round k feeds the copy in round
   *    k+1, which positionally is "before" yet is actually realizable (the lesson of reduce-accumulator). Drop it and
   *    cross-phase loops carrying data would vanish wholesale, and that is fabricating concurrency out of thin air, the one forbidden direction.
   *
   * It shares the same `sharesIteration` with `realizableCarry` in causality-graph.ts: the very same question about the very same relation
   * must not be answered once in each of the two places.
   */
  const admits = (from: string, fromPhase: string, to: string, toPhase: string): boolean => {
    const firstFrom = claims.firstIssue.get(`${from}|${fromPhase}`);
    const lastTo = claims.lastIssue.get(`${to}|${toPhase}`);
    if (firstFrom === undefined || lastTo === undefined) return true; // No position to judge: no block
    return lastTo > firstFrom || sharesIteration(from, to);
  };
  /**
   * The kinds that are subject to temporal feasibility. `carry` is not among them: its own realizability was already decided by `realizableCarry`,
   * and carry asserts precisely "the next round", so a positional comparison is meaningless for it. `fifo` is not among them either: the lane rules already decide
   * it, and two copies of the same site share a lane and really are FIFO-ordered against each other.
   */
  const ADMITTED_KINDS = new Set<OrderKind>(["data", "control", "seq"]);

  // --- 1. Cross-stage copy ------------------------------------------------------------------
  // Copies are both-run, not candidates - don't just change the may-set copy analogy to maybe. The site really starts from
  // The two callers issue each one (the shared helper runs once in preflight and gate), and both copies will be executed; each copy
  // Certainty only reflects how certain the claim of **its own stage** is, and does not mean "one of the two".
  //
  // `region` and `repeat` are **site-level facts** (taken from the first issue of the site), deliberately not recalculated according to stages: the copy is
  // For mechanical rewriting of the finished map, recalculating region ownership requires a copy of the region tree at each stage, which is another decision. So
  // The bench copy of gate carries the `region` and `stack` of the first issue of preflight - don’t make a decision without
  // "Fix it" if possible.
  const copiesOf = new Map<string, (Step & { phase: string })[]>();
  for (const step of graph.steps) {
    const siteId = step.source ?? step.id;
    const claiming = claimsOf(siteId);
    if (claiming.length < 2) continue;
    copiesOf.set(
      step.id,
      claiming.map((phase) => ({
        ...step,
        certainty: weakest([step.certainty, certaintyOfClaim(siteId, phase)]),
        id: `${step.id}${COPY_SEPARATOR}${phase}`,
        phase,
        // `source` is the site id actually reported at runtime, **only set once**: the lane copy has been brought, so it will be used.
        source: siteId,
      })),
    );
  }

  const steps: Step[] = graph.steps.flatMap((step) => {
    const copies = copiesOf.get(step.id);
    if (copies !== undefined) return copies;
    // k = 1: The claim is unique, so the certainty of this stage is literally equal to step itself (all issues are in
    // at this stage), no need to overwrite.
    return [{ ...step, phase: claimsOf(step.source ?? step.id)[0] as string }];
  });

  // --- 2. Edge rewriting: mirroring the mechanism of expandMaySetLanes -----------------------------------------
  const stepById = new Map(graph.steps.map((step) => [step.id, step]));
  const siteOf = (id: string): string => {
    const step = stepById.get(id);
    return step === undefined ? id : (step.source ?? step.id);
  };
  // The source information of the fact is indexed by **site pair** (the fact exists before two copies, and there is only one for each ordered pair), so
  // The edge of the lane copy is first converted back to the site and then checked.
  const provenance = new Map<string, ReadonlySet<string>>();
  for (const fact of facts) {
    if (fact.toPhases !== undefined) provenance.set(`${fact.from}|${fact.to}`, fact.toPhases);
  }

  const endpointsOf = (
    id: string,
    toPhases?: ReadonlySet<string>,
  ): { certainty: Certainty; id: string; lane?: string; phase: string }[] => {
    const copies = copiesOf.get(id);
    if (copies !== undefined) {
      const heads = new Set(headPhasesOf(claimsOf(siteOf(id)), toPhases));
      return copies
        .filter((copy) => heads.has(copy.phase))
        .map((copy) => ({
          certainty: copy.certainty,
          id: copy.id,
          lane: copy.lane,
          phase: copy.phase,
        }));
    }
    const step = stepById.get(id);
    return [
      {
        certainty: step?.certainty ?? "maybe",
        id,
        lane: step?.lane,
        phase: claimsOf(siteOf(id))[0] as string,
      },
    ];
  };

  const edges: OrderEdge[] = [];
  for (const edge of graph.edges) {
    // Neither end is a copy → left as is. This early retirement is also a structural guarantee of "the zero mark is unchanged byte by byte": a single endpoint pair
    // Never pass any of the following rules.
    if (!copiesOf.has(edge.from) && !copiesOf.has(edge.to)) {
      edges.push(edge);
      continue;
    }
    const fromSite = siteOf(edge.from);
    const toSite = siteOf(edge.to);
    // The tail end is not narrowed by provenance (the settle event does not have a stage), but the tail end is also subject to time feasibility constraints**——
    // This is where the trailing pseudo-edge (the copy comes before the ask that produces its own arguments) ends up.
    const pairs: { certainty: Certainty; from: string; to: string }[] = [];
    const admitted: typeof pairs = [];
    for (const tail of endpointsOf(edge.from)) {
      for (const head of endpointsOf(edge.to, provenance.get(`${fromSite}|${toSite}`))) {
        // fifo matches by lane, same rule as lane expansion. Stage copies at the same site share lanes, so the
        // fifo edges survive - That's right: two emits from a site are indeed FIFO-ordered with each other.
        if (edge.kind === "fifo" && tail.lane !== head.lane) continue;
        // The same copy is copied to itself: This is true only when the original edge is originally the self edge (the copy IDs of different sites cannot be equal),
        // So this is writing down the invariants, not the branches that have been reached in the corpus.
        if (tail.id === head.id && edge.from !== edge.to) continue;
        const pair = {
          certainty: weakest([edge.certainty, tail.certainty, head.certainty]),
          from: tail.id,
          to: head.id,
        };
        pairs.push(pair);
        if (!ADMITTED_KINDS.has(edge.kind) || admits(fromSite, tail.phase, toSite, head.phase)) {
          admitted.push(pair);
        }
      }
    }
    // All blocked → return to full expansion, the same posture as {@link headPhasesOf}: a true sequence is nowhere to be found
    // It is achievable, which shows that the position judgment has misled us, and silently deleting a real sequence is creating concurrency out of thin air.
    for (const pair of admitted.length > 0 ? admitted : pairs) {
      edges.push({ ...edge, ...pair });
    }
  }

  // --- 3. Stage table: Stages with members, unphased ranks first ----------------------------------------
  const members = new Set<string>(steps.map((step) => step.phase as string));
  const phaseList: Phase[] = [];
  if (members.has(UNPHASED_ID)) phaseList.push({ id: UNPHASED_ID });
  for (const phase of phases) {
    // Stages with zero members are lost (may-set narrowing may take away all steps of a certain stage) - empty nodes have no home to point to.
    if (!members.has(phase.id)) continue;
    phaseList.push({ id: phase.id, loc: phase.loc, name: phase.name });
  }
  const live = new Set(phaseList.map((phase) => phase.id));

  // --- 4. Business map: calculated based on the claiming relationship and does not rely on the materialization of the copy ------------------------------------
  const quotient: PhaseSourceFact[] = [];
  for (const fact of facts) {
    // The same rules as copy rewriting: head end narrowing ({@link headPhasesOf}) + time feasibility ({@link admits}),
    // And it also only takes effect when at least one end is copied. Two consumers cannot each tell a story - `phaseEdges` and drill-down
    // Both steps must be talking about the same thing.
    const tails = claimsOf(fact.from);
    const heads = headPhasesOf(claimsOf(fact.to), fact.toPhases);
    const copied = tails.length > 1 || claimsOf(fact.to).length > 1;
    const gated = copied && ADMITTED_KINDS.has(fact.kind);
    const pairs: { from: string; to: string }[] = [];
    const admitted: typeof pairs = [];
    for (const from of tails) {
      for (const to of heads) {
        pairs.push({ from, to });
        if (!gated || admits(fact.from, from, fact.to, to)) admitted.push({ from, to });
      }
    }
    for (const { from, to } of admitted.length > 0 ? admitted : pairs) {
      if (!live.has(from) || !live.has(to)) continue;
      // There is no picture in the order within the stage; the carry within the stage is a drawing method of "the entire cycle lives in one stage", leaving it as a self-loop.
      if (from === to && fact.kind !== "carry") continue;
      quotient.push({
        certainty: fact.certainty,
        from,
        kind: fact.kind,
        to,
        ...(fact.carryOf === undefined ? {} : { carryOf: fact.carryOf }),
      });
    }
  }

  const position = (id: string): number => claims.position.get(id) ?? 0;
  const deduped = dedupePhaseFacts(quotient).sort(
    (a, b) =>
      position(a.from) - position(b.from) ||
      position(a.to) - position(b.to) ||
      a.kind.localeCompare(b.kind),
  );
  // The stage edge does not carry `exact`: that is the taint witness bit of the data edge, which is undefined on the quotient.
  const phaseEdges: OrderEdge[] = reduceOrdering(deduped).map((fact) => ({
    certainty: fact.certainty,
    from: fact.from,
    kind: fact.kind,
    to: fact.to,
  }));

  const sink = graph.sink;
  return {
    edges,
    lanes: graph.lanes,
    phaseEdges,
    phases: phaseList,
    regions: graph.regions,
    steps,
    // The phase-level sink edge does not appear in the graph (the UI is derived from the phase of the fedBy step), but fedBy itself has to follow the copy.
    ...(sink === undefined
      ? {}
      : { sink: { fedBy: sink.fedBy.flatMap((id) => endpointsOf(id).map((end) => end.id)) } }),
  };
}

/**
 * One fact is kept per ordered phase pair: the kind takes the strongest value
 * ({@link KIND_RANK}) and certainty is maybe-wins — a **verbatim mirror of the step-level `dedupeFacts`**, consistency first
 * ("witnessed always by any one of them means always" is semantically more accurate on a quotient).
 */
function dedupePhaseFacts(facts: readonly PhaseSourceFact[]): PhaseSourceFact[] {
  const byPair = new Map<string, PhaseSourceFact>();
  for (const fact of facts) {
    const key = `${fact.from}|${fact.to}`;
    const existing = byPair.get(key);
    if (existing === undefined) {
      byPair.set(key, { ...fact });
      continue;
    }
    if (KIND_RANK[fact.kind] > KIND_RANK[existing.kind]) existing.kind = fact.kind;
    if (existing.carryOf === undefined && fact.carryOf !== undefined) existing.carryOf = fact.carryOf;
    if (fact.certainty === "maybe") existing.certainty = "maybe";
  }
  return [...byPair.values()];
}

function weakest(values: readonly Certainty[]): Certainty {
  return values.includes("maybe") ? "maybe" : "always";
}
