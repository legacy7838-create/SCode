// ============================================================
// Folding and reduction of stage edges - display the only edge deletion point of the stage layer of the graph
// ============================================================
// Extracted from create-workflow-graph-bounds.ts: folding itself is a self-consistent piece of pure graph theory (ordered pair folding +
// Strongly connected components + reduction that runs the analyzer on contraction points), while the rest of the clipping layer is about referential integrity and upper bounds. After disassembling
// This logic can be read and pinned separately, and max-lines margin is left for the bounds file.

import {
  reduceOrdering,
  type ReducibleEdge,
  // The same reason as bounds: use the /projections subpath instead of the root bucket, which will cause the typescript compiler to
  // Drag them together into the browser package (portfolio playback reuses this link in the browser).
} from "@zcode/dynamic-workflow/projections";

/** One edge before folding: its kind has already been collapsed into "is it a back edge". */
export interface RawEdge {
  from: string;
  to: string;
  back: boolean;
}

/**
 * The folding of the phase edges (the handoff edges were already reduced by the analyzer with the same algorithm and are delivered as they are, so they are not touched here):
 *
 * I. The same ordered pair folds into one (first-seen order), and `back` holds if and only if **all** the edges before the folding were back edges -- if
 * any forward fact exists it is treated as forward, and rather have the ranking carry one extra constraint than miss one; self-loops are dropped.
 *
 * II. The reduction runs on the **condensation**, not on the original graph. Take the strongly connected components of the forward edges (back edges do not count): edges inside
 * one component are kept unconditionally, and the cross-component edges are deduplicated by (component pair, kind) before being fed to the analyzer's greedy irredundant reduction (a forward edge of the same
 * kind, a back edge as carry (`carryOf: "seq"`) makes it degenerate into a kindless reduction), and are then expanded back into original edges over the surviving component pairs.
 * The output keeps the input order.
 *
 * Feeding the original graph straight into the reduction is wrong: a witness path can loop around and come
 * back. When two unrelated if/else groups reuse the same pair of phase names, both branch->A and A->branch are ordinary branch edges in the
 * condensed graph, so the reduction decides that branch->A is implied by branch->A->branch and deletes it, and the picture becomes "the conditional
 * branch always takes A, and B is a side road off A" -- a false statement. A path passing through a node in the same cycle as an endpoint asserts nothing about
 * "whether control can get there", so the witness only holds on this condensation DAG.
 */
export function foldPhaseEdges(raw: readonly RawEdge[]): RawEdge[] {
  const folded = foldPairs(raw);
  const componentOf = componentsOf(folded);
  const component = (id: string): string => componentOf.get(id) ?? id;
  const keyOf = (from: string, to: string, back: boolean): string => `${from} ${to} ${back}`;

  // The edges across components are deduplicated according to (component pair, kind), and the edges with the same component are not reduced at all - they are self-loops in the contraction point,
  // Says nothing about reachability relations on the DAG.
  const order: string[] = [];
  const byKey = new Map<string, ReducibleEdge>();
  for (const edge of folded) {
    const from = component(edge.from);
    const to = component(edge.to);
    if (from === to) continue;
    const key = keyOf(from, to, edge.back);
    if (byKey.has(key)) continue;
    order.push(key);
    byKey.set(
      key,
      edge.back ? { carryOf: "seq", from, kind: "carry", to } : { from, kind: "seq", to },
    );
  }
  const condensed = order.map((key) => byKey.get(key) as ReducibleEdge);
  const kept = new Set(
    reduceOrdering(condensed).map((edge) => keyOf(edge.from, edge.to, edge.kind === "carry")),
  );
  return folded.filter((edge) => {
    const from = component(edge.from);
    const to = component(edge.to);
    return from === to || kept.has(keyOf(from, to, edge.back));
  });
}

/** The same ordered pair folds into one, in first-seen order; `back` is the conjunction of the folded members; self-loops are dropped. */
function foldPairs(raw: readonly RawEdge[]): RawEdge[] {
  const order: string[] = [];
  const byKey = new Map<string, RawEdge>();
  for (const edge of raw) {
    if (edge.from === edge.to) continue;
    const key = `${edge.from} ${edge.to}`;
    const seen = byKey.get(key);
    if (seen === undefined) {
      order.push(key);
      byKey.set(key, { ...edge });
    } else {
      seen.back = seen.back && edge.back;
    }
  }
  return order.map((key) => byKey.get(key) as RawEdge);
}

/**
 * Each node → the representative of the strongly connected component it is in (the first node to appear in the component). Forward edges only: a back edge means
 * "the next round", and counting it into the components would collapse the whole loop body into a single point, so the edges that are genuinely redundant inside the loop body could never be deleted again.
 *
 * Mutual reachability rather than Tarjan: the phase graph is bounded at 32 nodes (`CREATE_WORKFLOW_GRAPH_MAX_PHASES`), so the
 * cost is irrelevant, and "a reaches b and b reaches a" is the component definition itself, which does not need proving again to be read.
 */
function componentsOf(folded: readonly RawEdge[]): Map<string, string> {
  const nodes: string[] = [];
  const seen = new Set<string>();
  const next = new Map<string, string[]>();
  for (const edge of folded) {
    for (const id of [edge.from, edge.to]) {
      if (seen.has(id)) continue;
      seen.add(id);
      nodes.push(id);
    }
    if (edge.back) continue;
    const list = next.get(edge.from);
    if (list === undefined) next.set(edge.from, [edge.to]);
    else list.push(edge.to);
  }

  const reach = new Map<string, Set<string>>();
  for (const start of nodes) {
    const reached = new Set<string>();
    const stack = [...(next.get(start) ?? [])];
    while (stack.length > 0) {
      const node = stack.pop() as string;
      if (reached.has(node)) continue;
      reached.add(node);
      stack.push(...(next.get(node) ?? []));
    }
    reach.set(start, reached);
  }

  const componentOf = new Map<string, string>();
  for (const node of nodes) {
    if (componentOf.has(node)) continue;
    componentOf.set(node, node);
    for (const other of reach.get(node) ?? []) {
      if (componentOf.has(other)) continue;
      if (reach.get(other)?.has(node) === true) componentOf.set(other, node);
    }
  }
  return componentOf;
}
