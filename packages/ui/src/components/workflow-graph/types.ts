import type { ToolCallCreateWorkflowCausalityGraph } from "@zcode/shared/zcode-protocol-v4";

/**
 * The graph the renderer consumes is exactly the bounded display payload from the
 * CreateWorkflow tool — one vocabulary from analyzer to pixels. A future live runtime
 * view reuses the same component by feeding `statuses` (and flipping `animatedEdges`);
 * absence of both renders the static analysis picture.
 *
 * The whole visual vocabulary, deliberately small
 *
 *   a module = a phase · a card = a participant (a subagent, or the workspace, in that
 *   phase) · a collapsed module = a deck of its participants' cards · an arrow = "runs
 *   after" · a terminal dot = the returned artifact
 * Hand-off arrows inside a module are causality facts quotiented by participant; arrows
 * between modules are control flow (the CFG's phase quotient); both are the same arrow.
 * `back` marks a loop's back edge for ranking only — same ink. Steps and lanes stay in the
 * payload as the run-status join key and the inspector's material; neither is drawn.
 */
export type WorkflowCausalityGraphData = ToolCallCreateWorkflowCausalityGraph;
export type WorkflowStepData = WorkflowCausalityGraphData["steps"][number];
export type WorkflowLaneData = WorkflowCausalityGraphData["lanes"][number];
export type WorkflowParticipantData = WorkflowCausalityGraphData["participants"][number];
export type WorkflowHandoffData = WorkflowCausalityGraphData["handoffs"][number];
/**
 * The grouping structure the author imposes with `phase("…")`. It is the first level of the board;
 * for unmarked scripts the UI synthesizes one implicit phase (participant-model.ts). `phases` /
 * `phaseEdges` are optional, so these two aliases strip undefined first — consumers always get the
 * array element type.
 */
export type WorkflowPhaseData = NonNullable<WorkflowCausalityGraphData["phases"]>[number];
export type WorkflowPhaseEdgeData = NonNullable<WorkflowCausalityGraphData["phaseEdges"]>[number];

/** Per-step run state for the live-execution view; keyed by step id. */
export type StepRunStatus = "pending" | "running" | "done" | "failed";

/**
 * The status table indexed by step id. **Table-biased**: a step with no observed instance has no
 * entry. Absence and `pending` are two different things — the former means "nothing happened here",
 * the latter means "a real instance is queued"; writing both as the same value lets branch sites
 * the control flow never visited drag the whole station into pending.
 */
export type StepStatusTable = Partial<Record<string, StepRunStatus>>;

/**
 * The three kinds of things that can be selected on the board: a participant card, a phase module,
 * and a terminal return. `line` is a convenience field the host uses to locate script lines
 * (permission blocks).
 */
export type WorkflowGraphSelectionKind = "participant" | "phase" | "sink";
export interface WorkflowCausalityGraphSelection {
  id: string;
  kind: WorkflowGraphSelectionKind;
  line?: number;
}

/** The single lane every `files.*` read runs in. */
export const WORKSPACE_LANE_ID = "workspace";
/** Lane of an ask whose receiver the analysis could not resolve to an actor site. */
export const UNKNOWN_LANE_ID = "unknown";
/** The terminal marker node: the artifact the workflow returns. */
export const SINK_NODE_ID = "sink";
/**
 * The fallback phase: the home of steps emitted before the first `phase()` marker, and also the
 * single implicit phase of an unmarked script (the analyzer always gives participants `phase:
 * "unphased"`). It keeps its id and has **no name** — the display name is localized by the UI,
 * following the same pattern as the `workspace`/`unknown` lanes (see phase-name.ts).
 */
export const UNPHASED_PHASE_ID = "unphased";
/**
 * The id of the single implicit module of an unmarked script (synthesized by the UI, see
 * `withImplicitPhase` in participant-model.ts). Kept separate from `unphased`: in a marked script
 * that word means "before the first marker" (Ungrouped), whereas the implicit module is the whole
 * workflow (Workflow).
 */
export const IMPLICIT_PHASE_ID = "workflow";

/**
 * What a lane IS, which is the only thing colour encodes in this view. `workspace` is
 * not an actor (no mailbox, hence no `fifo`) and `unresolved` is an ask whose receiver
 * the analysis could not site — both are real distinctions. Per-actor identity is
 * carried by the name on the card, not by a tint.
 *
 * It lives here, next to the ids it is derived from, because both the projection and the
 * naming policy (lane-name.ts) key on it.
 */
export type LaneClass = "agent" | "workspace" | "unresolved";

export function laneClassOf(laneId: string): LaneClass {
  if (laneId === WORKSPACE_LANE_ID) return "workspace";
  if (laneId === UNKNOWN_LANE_ID) return "unresolved";
  return "agent";
}

export function isSyntheticLaneId(id: string): boolean {
  return id === WORKSPACE_LANE_ID || id === UNKNOWN_LANE_ID;
}
