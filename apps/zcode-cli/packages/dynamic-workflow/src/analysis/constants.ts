/**
 * The tracing vocabulary: region kinds, jump kinds and the fallback phase ids. They used
 * to live in causality-order.ts, but that file imports `typescript` at runtime (the AST walk itself),
 * while the core-only pure projections (causality-graph / flow-phase / phase-graph) need just these values. Putting
 * them into a zero-dependency little file means the projection modules no longer drag `typescript` into
 * the runtime closure — the prerequisite for the portfolio browser bundle (`@zcode/dynamic-workflow/projections`) to exist at
 * all. causality-order.ts re-exports them as-is, so every existing reference site and every behavior stays unchanged.
 */

/**
 * Region kinds. The analyzer emits `seq` (the root), `loop`,
 * `fanout` and `branch`. `parallel` stays derived — incomparability in the ordering
 * already defines concurrency, and storing it would be a second source of truth.
 * `shared` is reserved for the future specialization cap.
 */
export type RegionKind = "seq" | "parallel" | "loop" | "fanout" | "branch" | "shared";

/**
 * STRUCTURAL region kinds: the tree nodes
 * the walk always saw but did not record before the control-flow projection needed them.
 * The causality projection looks THROUGH every one of them (its "transparency rule"), which
 * is what keeps the three older views byte-identical while the trace grows.
 *
 *  - `choice`: one if / ternary / switch / short-circuit; its arms are `branch` children
 *  - `call`: one inlined helper body (a `return` target)
 *  - `try` / `attempt` / `catch` / `finally`: one try statement and its three parts
 */
export type StructuralRegionKind = "choice" | "call" | "try" | "attempt" | "catch" | "finally";

/** Every kind the trace can hold. The public causality `RegionKind` stays the narrow union. */
export type TraceRegionKind = RegionKind | StructuralRegionKind;

const STRUCTURAL_REGION_KINDS: ReadonlySet<string> = new Set<StructuralRegionKind>([
  "choice",
  "call",
  "try",
  "attempt",
  "catch",
  "finally",
]);

export function isStructuralRegionKind(kind: TraceRegionKind): kind is StructuralRegionKind {
  return STRUCTURAL_REGION_KINDS.has(kind);
}

/** The reserved fallback phase: the root block's initial current phase, and where every
 * step issued before the script's first marker lands. It has no `name` — the UI shows a
 * localized word, exactly as it does for the `workspace` / `unknown` lanes. */
export const UNPHASED_ID = "unphased";

export type JumpKind = "continue" | "break" | "return" | "throw" | "recur";
