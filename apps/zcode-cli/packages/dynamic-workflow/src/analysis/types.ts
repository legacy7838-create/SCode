import type { ScriptLoc } from "../compiler/compile.js";

/**
 * The site-graph types: the may-flow digraph over facade call sites emitted by the
 * analyzer. This module is the
 * shared vocabulary; the taint pass (later step) fills in the edges.
 */

/**
 * A node kind. `source`/`sink` are the two virtual endpoints; the rest are facade
 * call sites. `fan-out` nodes are only emitted by the taint pass once an iteration
 * candidate is shown to reach a facade site — this substrate never produces them.
 */
export type SiteKind = "ask" | "world-read" | "join" | "fan-out" | "source" | "sink";

/** A 1-based, prelude-stripped location in the author's script. */
export type SiteLoc = ScriptLoc;

/**
 * The part of the shape that is statically available when a name only takes concrete form at runtime (`` agent(`fellow${i + 1}`) ``): the literal before the first hole (`head`) and the literal after the last hole (`tail`).
 *
 * Why only the shape is available: folding the template into 8 concrete names would require expanding `map`, and the whole point of
 * `×N` and `maybe stack` existing is to refuse that expansion. So what is handed back here is a shape, not a name.
 *
 * Invariant: at least one of `head`/`tail` is present (when neither can be obtained it returns undefined, never an empty pattern),
 * both have been trimmed, and each contains at least one letter or digit — `` `${x}-` `` rendering as `…-` is worse than "unnamed agent",
 * so such an affix is dropped outright. The ellipsis is added only at **render** time; this function just moves data.
 */
export interface NamePattern {
  head?: string;
  tail?: string;
}

/**
 * A graph node. The virtual `source`/`sink` carry no location and a fixed label;
 * every other node is positioned at its facade call site. `actors` is populated for
 * `ask` nodes only: the may-set of actor site ids the ask's receiver resolves to
 * (the same set that drives the context relation), so the renderer can place the
 * node in its actor lane(s). Ordered by actor source order, deduped. `within` is the
 * id of the nearest enclosing promoted fan-out node when the site's call lies
 * lexically inside a promoted iteration candidate's body — the site then executes
 * once per element;
 * omitted otherwise. `artifactType` is the producer's statically known artifact type
 * (a human-readable type name, provenance semantics) for `ask`/`world-read`/`join`/
 * `fan-out` nodes; absent on the virtual endpoints and when the type is
 * unknowable/uninformative (`any`/`unknown`/`never`/`void`).
 */
export interface SiteNode {
  id: string;
  kind: SiteKind;
  loc?: SiteLoc;
  label: string;
  /**
   * The static shape of the template, for when `label` only got the fallback string (an inline `` agent(`researcher${i}`).ask(…) `` — the receiver is a call
   * expression, neither a literal nor an identifier, so it lands on `"ask"`). Only `ask` nodes can have this.
   */
  labelPattern?: NamePattern;
  actors?: string[];
  within?: string;
  artifactType?: string;
}

/**
 * An actor (`agent()` site). Rendered as a lane, not a graph node. `within` is the
 * id of the nearest enclosing promoted fan-out when the `agent()` call lies inside
 * that fan-out's body: a lane FAMILY (one fresh actor per element) rather than a
 * single shared lane. Omitted for actors created outside any fan-out.
 */
export interface ActorSite {
  id: string;
  loc: SiteLoc;
  name?: string;
  /**
   * The static shape when `name` is absent (the first argument of `agent()` is not a literal) and that first argument is a template string. It is mutually exclusive with an actual
   * `name`: a literal gives a name, a template gives a shape. **Deliberately not written into `name`** — the contract of `name` is "the word the author wrote
   * verbatim", and mixing a reconstruction in means downstream can never again tell a literal from an inference.
   */
  namePattern?: NamePattern;
  within?: string;
}

/**
 * A may-flow edge: "the output of `from` may feed `to`". `data` edges carry
 * artifacts; `context` edges relate asks sharing an actor. `exact` is false once
 * any widening rule fired along the witness path. `port` records a join input /
 * element position when the join argument is a static array literal. `type` is the
 * producer's artifact type name (provenance: the value feeding `to` was computed from
 * `from`'s output), port-refined for edges OUT OF a join; absent on context edges,
 * source-completion edges, and when the type is unknowable/uninformative.
 */
export interface SiteEdge {
  from: string;
  to: string;
  kind: "data" | "context";
  exact: boolean;
  port?: number;
  type?: string;
}

export interface SiteGraph {
  nodes: SiteNode[];
  actors: ActorSite[];
  edges: SiteEdge[];
}
