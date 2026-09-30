import type { WorkflowRunState } from "@zcode/shared/zcode-protocol-v4";
import type { WorkflowCausalityGraphData } from "@/components/workflow-graph/types.js";

/**
 * Cache the calculation results of `timeline-model.ts` and build the same pair (graph, run) only once.
 *
 * Why keying by Object Identity is correct: Both inputs are immutable protocol objects - the picture is the verified one on the line
 * `causalityGraph` in the display load, run is an item in the `workflowRuns` projection; the reduction and key level of the projection
 * Increments are shallow reconstructions (changed items are replaced with new objects, and unchanged element references are retained as they are). So "the same object" is equivalent to
 * "The same content", and new objects must be replaced when the content changes - the cache will not feed expired models.
 *
 * Why not rely on their own `useMemo`: the run card and the run details page draw the same run in the same frame, and their respective useMemo only
 * To recognize your own share, one frame is built twice (each time is more than ten milliseconds in the world). Two-level WeakMap (run first and then graph) lets the second
 * Retreat to a table lookup. The key is a weak reference: the projection issues a new run object every frame, the entries from the previous frame are then recyclable, and the table does not grow long.
 */
const BY_RUN = new WeakMap<object, WeakMap<object, unknown>>();

/** Static images without run (confirmation window, compilation feedback card) also follow the same table, and use module-level sentinels to occupy the run level. */
const NO_RUN: object = {};

export function sharedTimelineModel<Model>(
  graph: WorkflowCausalityGraphData,
  run: WorkflowRunState | undefined,
  build: () => Model,
): Model {
  const runKey: object = run ?? NO_RUN;
  let byGraph = BY_RUN.get(runKey);
  if (byGraph === undefined) {
    byGraph = new WeakMap<object, unknown>();
    BY_RUN.set(runKey, byGraph);
  }
  // `has` instead of `get() !== undefined`: the model is always an object, but the decision should not rely on this.
  if (byGraph.has(graph)) return byGraph.get(graph) as Model;
  const model = build();
  byGraph.set(graph, model);
  return model;
}
