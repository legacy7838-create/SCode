// ============================================================
// Toolface for workflow actor (AgentRuntime tool configuration)
// ============================================================
//
// The tool interface of the child agent must fall on the tool registration of the child runtime, otherwise the real offer transcript
// The referee actor also received a complete set of interactive tools. Two types of risks:
//   1. Suspension: AskUserQuestion / EnterPlanMode There is no one to ask in the headless child, and the turn never ends;
//   2. Override and recursion: CreateWorkflow allows the actor to submit another workflow, and ReadSessionContext reads the parent session out of bounds.
// This module is the missing mapping, which is expanded by the runtime factory on the driver side when creating AgentRuntime.
//
// Persona tool-less gear: Each actor takes the complete working toolset minus the following subtraction table;
// "The referee should not change the file" is made clear by the ask text - this is what normal subagents do (Explore retains Bash,
// Read only by prompt).

import {
  ASK_USER_QUESTION_TOOL_NAME,
  ENTER_PLAN_MODE_TOOL_NAME,
  EXIT_PLAN_MODE_TOOL_NAME,
  READ_SESSION_CONTEXT_TOOL_NAME,
  RESOLVE_WORKFLOW_QUESTION_TOOL_NAME,
} from "@zcode/contracts";

/** The tool-surface slice of AgentRuntimeConfig. */
interface WorkflowActorToolPolicy {
  toolDisallowlist: readonly string[];
}

/**
 * The tools subtracted from the full set: the first three would block on a human who does not exist (a headless child has nobody to answer,
 * so the turn never ends); CreateWorkflow would let an actor recursively submit workflows; ReadSessionContext reads out of bounds into the parent session.
 * The rest (Bash / Edit / Write / search / web) are kept as usual — an actor is meant to get work done.
 */
const ACTOR_DISALLOWED_TOOLS: readonly string[] = [
  ASK_USER_QUESTION_TOOL_NAME,
  ENTER_PLAN_MODE_TOOL_NAME,
  EXIT_PLAN_MODE_TOOL_NAME,
  "CreateWorkflow",
  // The revision entry is the same nested arrangement as CreateWorkflow, and the same root cause is enqueued.
  "AmendWorkflow",
  READ_SESSION_CONTEXT_TOOL_NAME,
  // Subagents are not allowed to answer upgrade questions for the primary agent.
  // The root causes of the above are different: this is not suspension or overreaching, but **identity** - the whole meaning of the upgrade is to transfer the right to judge.
  // Leave it to the party who created this workflow; letting another actor answer it is equivalent to quietly degenerating it into an inter-actor interaction.
  // Convince each other. Actors use `escalate` (constant registration) to ask questions, and answers only belong to the main session.
  RESOLVE_WORKFLOW_QUESTION_TOOL_NAME,
];

/**
 * The AgentRuntime tool configuration for a workflow actor. A pure function, for the driver-side runtime factory to spread into
 * AgentRuntimeConfig: it does not narrow, it only subtracts the interactive/meta tools that would hang or overstep.
 *
 * It covers built-in tools only; filtering MCP / plugin tools is left to production wiring (the same factory seam).
 */
export function workflowActorToolPolicy(): WorkflowActorToolPolicy {
  return { toolDisallowlist: ACTOR_DISALLOWED_TOOLS };
}
