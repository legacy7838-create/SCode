// Skill loading check for workflow authoring tools.
// Keep tool descriptions short for CreateWorkflow, AmendWorkflow, SaveWorkflow, and EvalWorkflowSnippet.
// The facade and writing rules are provided by the `dynamic-workflows` skill. Skills must be loaded before submitting script: not found in session history
// When a successful `Skill(dynamic-workflows)` is called, resolveInput is directly rejected to avoid entering the hook or displaying an invalid confirmation window.
//
// The criterion comes from the messageHistory currently visible to the model. After compaction removes the skill body and corresponding calls, it needs to be reloaded;
// resume/rewind restores the criterion along with the history and does not maintain the second session state.
// The absence of a probe indicates that the current assembly does not provide a skill loading check, and no prerequisites are set that cannot be met at this time.

import { DYNAMIC_WORKFLOW_SKILL_NAME } from "@zcode/contracts";
import type { ToolHandlerFailure, ToolInputResolutionContext } from "../types.js";

/**
 * The stable error code for "skill not loaded". It is separate from the four tools'
 * argument-level 400s: the caller has to be able to distinguish "the arguments are wrong"
 * from "go read the skill first" without reading the text — the former means fixing the
 * arguments, the latter means one more Skill call.
 */
export const WORKFLOW_SKILL_NOT_LOADED_CODE = 428;

/** The criterion when the gate is present; exported separately for probe implementations to reuse. */
export function isDynamicWorkflowSkillLoaded(context: ToolInputResolutionContext): boolean {
  return context.hasLoadedSkill?.(DYNAMIC_WORKFLOW_SKILL_NAME) ?? true;
}

/**
 * Reject when the skill has not been read. Returning `undefined` means the call is let
 * through: the skill is loaded, or this session has no probe (see the file header).
 *
 * @param toolName the tool named in the rejection wording, so the model knows which one to retry.
 */
export function requireDynamicWorkflowSkill(
  context: ToolInputResolutionContext,
  toolName: string,
): ToolHandlerFailure | undefined {
  if (isDynamicWorkflowSkillLoaded(context)) return undefined;
  return {
    result: false,
    errorCode: WORKFLOW_SKILL_NOT_LOADED_CODE,
    message: `${toolName} needs the \`${DYNAMIC_WORKFLOW_SKILL_NAME}\` skill loaded in this session before it accepts a script. Call the Skill tool with skill "${DYNAMIC_WORKFLOW_SKILL_NAME}" first — it carries the facade declarations the script is checked against, the authoring rules and this tool's full contract — then call ${toolName} again. Nothing was started.`,
  };
}

/** CreateWorkflow's exception: running a saved workflow by name is not writing a script, so it needs no skill. */
export function createWorkflowNeedsSkill(input: unknown): boolean {
  const fields = asRecord(input);
  if (fields === undefined) return true;
  const runsSavedOnly =
    fields.saved !== undefined && fields.script === undefined && fields.path === undefined;
  return !runsSavedOnly;
}

/** AmendWorkflow's exception: changing only settings (neither `path` nor `script` given) reuses the predecessor's script, which is not writing a script. */
export function amendWorkflowNeedsSkill(input: unknown): boolean {
  const fields = asRecord(input);
  if (fields === undefined) return true;
  return fields.script !== undefined || fields.path !== undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
