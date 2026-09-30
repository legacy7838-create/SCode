// ============================================================
// Workflow analysis → display - unique projection of static analysis results to display graph/score card
// ============================================================
//
// The display diagram is composed of **three** analysis projections: the cause-and-effect diagram for stations and lanes, the control flow diagram for phase vocabularies and phase edges, and the handover diagram for
// Sub-agent cards and handover edges at each stage. If any copy is uploaded less, the picture will be silently missing a layer - the center will be activated directly.
// The run details side panel has no timeline and no subagents. The reason is that the startup path only passes the cause and effect diagram. So "Analysis results →
// "Bounded Display Diagram" is only spelled out here once; it is called in three places: CreateWorkflow's handler, confirmation window gate and direct startup.
// No one is calling `boundCausalityGraph(...)` anymore.

import {
  CREATE_WORKFLOW_TOOL_NAME,
  type CreateWorkflowCausalityGraph,
  type CreateWorkflowOutput,
  type ToolResultDisplayPayload,
} from "@zcode/contracts";
import type { AnalyzeResult } from "@zcode/dynamic-workflow";
import { createCreateWorkflowDisplay } from "../executor/result-display.js";
import { boundCausalityGraph } from "./create-workflow-graph-bounds.js";

/** The bounded display graph of the analysis result; absent when the script cannot analyze even a single site (the compile failure precedes the causal graph). */
export function boundGraphOfAnalysis(
  analysis: AnalyzeResult,
): CreateWorkflowCausalityGraph | undefined {
  return analysis.causality === undefined
    ? undefined
    : boundCausalityGraph(analysis.causality, analysis.flow, analysis.handoff);
}

/**
 * The `create_workflow` display of the analysis result (the confirmation window, the starting turn
 * metadata). The model-facing `response` carries no content for these readers — the display
 * projection itself does not read it either. AmendWorkflow passes its own tool name: the two start
 * tools share one and the same display kind.
 */
export function displayOfAnalysis(
  analysis: AnalyzeResult,
  toolName: string = CREATE_WORKFLOW_TOOL_NAME,
): ToolResultDisplayPayload | undefined {
  const causalityGraph = boundGraphOfAnalysis(analysis);
  return createCreateWorkflowDisplay(toolName, {
    diagnostics: analysis.diagnostics,
    ok: analysis.ok,
    response: "",
    ...(causalityGraph === undefined ? {} : { causalityGraph }),
  } satisfies CreateWorkflowOutput);
}
