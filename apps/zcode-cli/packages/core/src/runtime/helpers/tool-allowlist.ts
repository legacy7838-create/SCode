import {
  AMEND_WORKFLOW_TOOL_NAME,
  CREATE_WORKFLOW_TOOL_NAME,
  RESOLVE_WORKFLOW_QUESTION_TOOL_NAME,
  RESPOND_TO_COORDINATOR_TOOL_NAME,
  RESUME_WORKFLOW_RUN_TOOL_NAME,
  SAVE_WORKFLOW_TOOL_NAME,
} from "@zcode/contracts";
import { EXPLORE_AGENT_ALLOWED_TOOLS } from "../../subagent/explore-tools.js";
import type { AgentRuntimeConfig } from "../types.js";
import { normalizeToolNameAlias } from "../../tool/tool-visibility.js";

const EXPLORE_AGENT_ALLOWED_TOOL_SET = new Set<string>(EXPLORE_AGENT_ALLOWED_TOOLS);

/**
 * Tools that a workflow child runtime additionally does not register.
 *
 * Root cause: a workflow child (`/workflow`, `/expert`, and the agent call of a script workflow) is forced into
 * yolo, while its interaction events are mirrored to the parent session only along the subagent path (`runtime/methods/subagent.ts` is
 * the only entry point of `mirrorSubagentToolEvent`). CreateWorkflow declares alwaysAsk, so a script that compiles
 * raises a confirmation request inside the child that the parent UI never sees, and hangs all the way to the permission timeout. Not registering the tool at all
 * hands the child a clean "tool unavailable" error instead of an invisible hang.
 *
 * The long-term fix is to mirror the workflow child's interaction events to the parent session as well, handled together when the execution engine lands
 */
const WORKFLOW_CHILD_DISALLOWED_TOOLS = [
  CREATE_WORKFLOW_TOOL_NAME,
  // AmendWorkflow and CreateWorkflow have the same alwaysAsk gate, the same nested orchestration, and are enqueued by the same root cause.
  AMEND_WORKFLOW_TOOL_NAME,
  // SaveWorkflow is enqueued for the same root cause: it also declares alwaysAsk, so in the child it will also emit an
  // The parent interface cannot see the confirmation request and times out. ListSavedWorkflows is not listed - the reason for that ban is that there is no window to pop up,
  // Read-only queries do not apply (same as the two run introspection tools).
  SAVE_WORKFLOW_TOOL_NAME,
  // **Structural Disabled** - No further layout is allowed within the child. Recovery = re-execute the entire script (completed node replay, unfinished
  // redistributed), it is the same capability profile as CreateWorkflow new startup; even if the technical problem of "no window to pop up" disappears after no confirmation is required,
  // Nested orchestration (child is pulled up or revived again) is still not open.
  RESUME_WORKFLOW_RUN_TOOL_NAME,
  // ResolveWorkflowQuestion and ResumeWorkflowRun are both structurally disabled, but they adhere to another invariant:
  // The semantics of upgraded Q&A are "the actor asks a question, and the party who created this workflow answers".
  // Letting a child answer easily is tantamount to handing over the right to judge to someone who can change the door. It has quietly degenerated into a conflict between actors.
  // Convince each other - and an actor who is also blocked is the one least qualified to make the decision.
  //
  // **Intentionally duplicated** with bootstrap's `ACTOR_DISALLOWED_TOOLS` (CreateWorkflow already has the same double column
  // Precedent): That one is a subtraction of the persona tool surface on the driver side; this one covers all workflows by taskType
  // child, does not depend on driver, remember to write it.
  RESOLVE_WORKFLOW_QUESTION_TOOL_NAME,
] as const;

/**
 * The runtime's final tool disallow list: the turn-level `toolDisallowlist` overlaid with the structural bans derived from taskType.
 * It lives here rather than at each child runtime's construction point because there are two
 * construction points (`workflow-facade.ts` and `script-workflow-child-runtime.ts`), and two lists would inevitably drift.
 */
export function resolveRuntimeDisallowedTools(
  config: AgentRuntimeConfig,
): readonly string[] | undefined {
  if (config.taskType !== "workflow_child") return config.toolDisallowlist;

  const disallowed = new Set(config.toolDisallowlist ?? []);
  for (const toolName of WORKFLOW_CHILD_DISALLOWED_TOOLS) disallowed.add(toolName);
  return [...disallowed];
}

/**
 * The value of the dynamic workflow switch on registerBuiltInTools.
 * **Absent means enabled**: the TUI keeps the default tool surface; headless writes true/false explicitly according to --enable-workflow,
 * a protocol session is controlled by the trusted Host, and workflow_child inherits the parent configuration. The fail-closed default lives at
 * the headless entry point and in the protocol server's appRuntimePreferences, not in this layer.
 *
 * Why it is gathered here just like resolveRuntimeDisallowedTools instead of being written at the call site: the registration surface has **two** entry
 * points (the first wiring in helpers/runtime-tools.ts, the branch refresh in methods/embedded-search-branch.ts), and both
 * must use the same rule, otherwise refreshing the tool list could re-register an already disabled workflow tool.
 */
export function resolveRuntimeDynamicWorkflowToolsIncluded(config: AgentRuntimeConfig): boolean {
  return config.dynamicWorkflowEnabled !== false;
}

export function resolveBuiltInToolAllowlist(
  config: AgentRuntimeConfig,
): readonly string[] | undefined {
  const normalizedAllowlist = normalizeBuiltInToolAllowlist(config.toolAllowlist);

  if (config.toolset !== "explore") {
    return appendChildControlTool(config, normalizedAllowlist);
  }

  if (!normalizedAllowlist) {
    return appendChildControlTool(config, EXPLORE_AGENT_ALLOWED_TOOLS);
  }

  return appendChildControlTool(
    config,
    normalizedAllowlist.filter((toolName) => EXPLORE_AGENT_ALLOWED_TOOL_SET.has(toolName)),
  );
}

function appendChildControlTool(
  config: AgentRuntimeConfig,
  allowlist: readonly string[] | undefined,
): readonly string[] | undefined {
  if (!allowlist) {
    return allowlist;
  }

  if (config.taskType === "subagent_child") {
    if (allowlist.includes(RESPOND_TO_COORDINATOR_TOOL_NAME)) {
      return allowlist;
    }
    // Explore will seek tool intersection again before runtime registration, and the child control tool must make up for the final result.
    return [...allowlist, RESPOND_TO_COORDINATOR_TOOL_NAME];
  }

  // workflow child does not have allowlist narrowing (persona has no tool gear, and the tool surface only has subtraction, see
  // bootstrap's workflow-actor-tools.ts), submit_result/elevated by includeSubmitResult/
  // includeEscalate is registered in two gates and does not need to be filled in here.
  return allowlist;
}

function normalizeBuiltInToolAllowlist(
  allowlist: readonly string[] | undefined,
): readonly string[] | undefined {
  return allowlist?.map((toolName) => normalizeToolNameAlias(toolName));
}
