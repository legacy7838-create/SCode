/**
 * The browser-safe pure projection bucket:
 * `@zcode/dynamic-workflow/projections`.
 *
 * Downstream browser-side consumers freeze `AnalysisCore` into core.json, decode it in the browser and recompute the site graph / causal graph /
 * CFG / handoff graph / actor graph on the spot, then draw them with `*ToMermaid` or the display contract. `typescript` must not be on that chain
 * -- it is a compiler only needed when the analyzer forges the core, it is several MB in size, and it does not belong in a frontend bundle.
 *
 * Therefore this module **only** re-exports the modules that do not import `typescript` at runtime: core's types and canonical text, JSON
 * encode/decode, the five projections, the reducers, the mermaid and text serializers, and the graph types. `analyzeWorkflowScript`,
 * the compiler, lowering and the engine are all absent -- they are served by the root export.
 */
export {
  isActorSite,
  serializeCore,
  type AnalysisCore,
  type CoreActorSite,
  type CoreAskSite,
  type CoreFacts,
  type CoreFanoutSite,
  type CoreSimpleSite,
  type CoreSites,
  type CoreTypes,
} from "./analysis/core.js";
export {
  decodeAnalysisCore,
  encodeAnalysisCore,
  type AnalysisCoreJson,
  type MapEntries,
} from "./analysis/core-json.js";
export type {
  ActorEvent,
  ControlFact,
  IssueEvent,
  JumpEvent,
  MarkEvent,
  OrderEvent,
  OrderRegion,
  OrderTrace,
  PhaseInfo,
  SettleEvent,
} from "./analysis/causality-order.js";
export {
  isStructuralRegionKind,
  UNPHASED_ID,
  type JumpKind,
  type RegionKind,
  type StructuralRegionKind,
  type TraceRegionKind,
} from "./analysis/constants.js";
export { projectSiteGraph } from "./analysis/graph.js";
export { toActorGraph, type ActorEdge, type ActorGraph, type ActorNode } from "./analysis/actor-graph.js";
export {
  projectCausalityGraph,
  SINK_ID,
  UNKNOWN_LANE,
  WORKSPACE_LANE,
  type CausalityGraph,
  type Certainty,
  type Lane,
  type NamePattern,
  type OrderEdge,
  type OrderKind,
  type Phase,
  type Region,
  type Step,
  type StepKind,
} from "./analysis/causality-graph.js";
export { reduceOrdering, type ReducibleEdge } from "./analysis/causality-reduce.js";
export {
  FLOW_ABORT,
  FLOW_ENTRY,
  FLOW_SINK,
  projectControlFlow,
  type ControlFlowGraph,
  type FlowEdge,
  type FlowEdgeKind,
  type FlowNode,
  type FlowNodeKind,
  type FlowPhase,
  type FlowVia,
} from "./analysis/flow-graph.js";
export {
  FANOUT_EXPAND_CAP,
  projectHandoffGraph,
  UNPHASED,
  type Handoff,
  type HandoffGraph,
  type HandoffParticipant,
} from "./analysis/handoff-graph.js";
export {
  actorGraphToMermaid,
  causalityGraphToMermaid,
  controlFlowToMermaid,
  handoffGraphToMermaid,
  phaseFlowToMermaid,
  phaseGraphToMermaid,
  siteGraphToMermaid,
} from "./analysis/mermaid.js";
export {
  serializeActorGraph,
  serializeCausalityGraph,
  serializeControlFlow,
  serializeGraph,
  serializeHandoffGraph,
} from "./analysis/serialize.js";
export type { ActorSite, SiteEdge, SiteGraph, SiteKind, SiteLoc, SiteNode } from "./analysis/types.js";
