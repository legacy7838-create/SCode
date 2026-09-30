import type { RegionKind } from "./constants.js";
import type { OrderKind } from "./causality-reduce.js";
import type { SiteLoc, NamePattern } from "./types.js";

// causality-graph.ts reaches the upper limit of oxlint max-lines (400 lines) and adds the public type of causality graph
// (Step / Region / OrderEdge / Lane / Phase / CausalityGraph with three lane constants) and internal
// Fact is split into this file; the public side is still exported from causality-graph.ts (export it as it is there). This file does not import
// `typescript`, the browser-side `./projections` bucket is safe to reach.

export type StepKind = "ask" | "world-read";
export type Certainty = "always" | "maybe";

/** The single lane every `files.*` read runs in. */
export const WORKSPACE_LANE = "workspace";
/** Lane of an ask whose receiver the analysis could not resolve to any actor site. */
export const UNKNOWN_LANE = "unknown";
/** The terminal marker: the artifact the script returns. */
export const SINK_ID = "sink";

export interface Step {
  /** A site id (`ask#3`, `world-read#1`); it is also the runtime instance's key. */
  id: string;
  kind: StepKind;
  label: string;
  /** The template shape of an inlined `agent()` receiver when `label` only got the fallback string. */
  labelPattern?: NamePattern;
  loc: SiteLoc;
  /** Actor site id, or `workspace` / `unknown`. For an unexpanded may-set, `lanes[0]`. */
  lane: string;
  /** Present only when the ask receiver is dynamically selected: the candidate lanes. */
  lanes?: string[];
  /**
   * The step this one was expanded from, emitted only on a may-set copy (see
   * `expandMaySetLanes` in causality-graph-lanes.ts). It is the site id a runtime instance
   * actually reports, which is what makes it the live overlay's join key (`source ?? id`
   * against `node.siteId`, narrowed by `node.actorSiteId === lane`).
   *
   * This composes with future per-callsite specialization rather than competing with it. Once
   * specialization lands, the expanded-from id IS the specialized site id —
   * `ask#3/2~actor#1` carries source `ask#3/2` — so the join stays stable under both
   * features. On a copy the field means "the site the runtime reports", NOT "the site
   * before specialization".
   */
  source?: string;
  /** Innermost enclosing region id. */
  region: string;
  certainty: Certainty;
  /**
   * The author-declared phase this step belongs to (`phase#2`, or the reserved
   * `unphased`). Present only when the script declares at least one `phase()` marker, in
   * which case EVERY step carries one — a step claimed by k>1 phases is expanded into k
   * copies to keep the partition total (see phase-graph.ts).
   */
  phase?: string;
  /**
   * How this step's instances relate when an enclosing region repeats:
   *   `stack`  — they coexist, which is the one multiplicity cue (stacked cards);
   *   `serial` — they follow one another, already visible as the cycle-closing arrow.
   * Absent when the step runs at most once. Finding: the cue splits on
   * CONCURRENCY, not cardinality — a step is `serial` exactly when a barrier inside
   * the repeating region settles it, or when a fixed actor's mailbox serializes it.
   */
  repeat?: "stack" | "serial";
}

export interface Region {
  id: string;
  kind: RegionKind;
  parent?: string;
  loc?: SiteLoc;
  /** Derivable literal round count of a `for`; model-only, never displayed. */
  bound?: number;
  label?: string;
}

export interface OrderEdge {
  from: string;
  to: string;
  kind: OrderKind;
  certainty: Certainty;
  /** `data` edges only: the taint witness path's exactness bit. Model-only. */
  exact?: boolean;
}

export interface Lane {
  id: string;
  /** The author's verbatim word, when `agent()` was given a literal. Never a reconstruction. */
  name?: string;
  /**
   * The static shape of that name when `name` is absent and the first argument of `agent()` is a template string with holes. The ellipsis is only added at render time.
   */
  namePattern?: NamePattern;
  loc?: SiteLoc;
  /**
   * Enclosing iteration regions of the `agent()` call, outermost first. A non-empty
   * list makes the lane a family — one fresh actor per element — and nested iterations
   * MULTIPLY, so multiplicity is the product and a single id cannot express it.
   */
  families?: string[];
}

/**
 * An author-declared phase: a name for a group of steps, and the position of the marker
 * that opened it. The synthetic fallback `unphased` carries neither — the UI shows a
 * localized word for it, exactly as it does for the `workspace` / `unknown` lanes.
 */
export interface Phase {
  id: string;
  name?: string;
  loc?: SiteLoc;
}

export interface CausalityGraph {
  steps: Step[];
  regions: Region[];
  lanes: Lane[];
  edges: OrderEdge[];
  /** Step ids whose artifacts reach the script's return; absent when it returns nothing. */
  sink?: { fedBy: string[] };
  /**
   * The phase vocabulary, present TOGETHER WITH `phaseEdges` and `Step.phase` or not at
   * all: a script with no `phase()` markers gets none of the three and its graph is
   * byte-identical to what it was before the feature. `unphased` first when it has
   * members, then the author's phases in first-reach order.
   */
  phases?: Phase[];
  /** The quotient of `edges` by the phase partition. Never carries `exact`. */
  phaseEdges?: OrderEdge[];
}

/** The ordered facts internal to the projection (dedup, back-edge finalization, and the input of reduction); not part of the package's public surface. */
export interface Fact {
  from: string;
  to: string;
  kind: OrderKind;
  certainty: Certainty;
  exact?: boolean;
  /** The underlying kind of a carry edge (the forward kind before re-typing); carry minimization judges witness strength by it. */
  carryOf?: Exclude<OrderKind, "carry">;
  /**
   * The set of phases in which the issue event witnessing this fact occurred (**only seq facts produced by an await barrier** carry it).
   * A phase copy narrows the head of the edge by it: a barrier fact was witnessed on one specific issue, while the current "one site, one step"
   * design folds multiple issues of the same site at different call sites into a single step; dropping this source would make
   * "cargo test had already settled before the gate's bench was issued" also hold for the preflight bench —
   * a time assertion in the wrong direction (extra order is permitted, wrong order is not).
   *
   * Absent = no source information = the head is fully expanded (data/control/fifo and region-duplicate facts are fully expanded by contract).
   *
   * There is no symmetric source information on the tail side (a settle event carries no phase), but **the tail side is no longer a gap**: the time-feasibility check for a phase copy
   * (`admits` in phase-graph.ts) blocks by position symmetrically for **both** ends, so bogus edges of the "copy scheduled before the step that produced its
   * own argument" kind are removed by that rule, not by the source information here.
   */
  toPhases?: Set<string>;
  /**
   * This `seq` fact can only hold via the **next iteration**: `from` is emitted in a branch arm ending in `continue`,
   * and `to` sits at a later position in the same loop body. A linear time walk with may semantics walks on through the rest of the loop body, and thereby
   * records "fixer@k precedes juries@k+1" as a forward order within the same iteration; the control-flow projection for the same place yields
   * `loop via=continue`. Facts carrying this marker are treated as carry when the back edge is finalized (it only counts when every fact in a pair carries it,
   * see `dedupeFacts`, causality-graph-lanes.ts). An arm ending in `break` is stronger: a step inside it simply cannot precede a later step in the same loop, so such a fact is not emitted at all.
   */
  viaJump?: true;
}
