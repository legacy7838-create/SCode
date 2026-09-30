/**
 * Builds the display of the CreateWorkflow result card. Split out of result-display.ts (the 400-line discipline):
 * of the same family as workflow-observation-display.ts — dispatch by tool name, safeParse the output schema,
 * an independent length bound on the display side.
 */

import {
  AMEND_WORKFLOW_TOOL_NAME,
  CREATE_WORKFLOW_DISPLAY_MAX_DIAGNOSTICS,
  CREATE_WORKFLOW_DISPLAY_MAX_MESSAGE_CHARS,
  CREATE_WORKFLOW_TOOL_NAME,
  CreateWorkflowOutputSchema,
  type ToolResultDisplayPayload,
} from "@zcode/contracts";

/**
 * ⚠ The field set of this projection is **frozen** (the schema comment in contracts explains why). Gate-specific
 * facts — such as the origin of a saved run and the resolved script — go through the **tool input** channel
 * only, never onto the display.
 */
export function createCreateWorkflowDisplay(
  toolName: string,
  output: unknown,
): ToolResultDisplayPayload | undefined {
  // The two startup tools share the same display kind: there is only one implementation on the UI side for pictures, scratch pens and diagnostic cards.
  if (toolName !== CREATE_WORKFLOW_TOOL_NAME && toolName !== AMEND_WORKFLOW_TOOL_NAME) {
    return undefined;
  }
  const parsed = CreateWorkflowOutputSchema.safeParse(output);
  if (!parsed.success) return undefined;
  // There is no display for in-place concurrency adjustment: not a single line of script in this path is compiled, and the `ok` of the `create_workflow` payload is read on the UI as
  // "Compiled". The criterion is an explicit `retuned` block** rather than a shape - "ok and no status" is also available on this tool
  // This is the origin of "no run port, only typecheck". The tool card therefore returns to the response body section.
  if (parsed.data.retuned !== undefined) return undefined;

  const { causalityGraph, diagnostics, ok } = parsed.data;
  // Display does not go through the tool result budget: the number of diagnoses and the length of a single message must be entered into the real-time event and
  // The length of persistent metadata is independently limited to avoid type errors and extending continuous/replayable messages into unbounded payloads.
  // The causalityGraph has been bounded by the tool output boundary (handler's boundCausalityGraph + output schema),
  // Direct passthrough.
  const errorCount = diagnostics.length;
  const bounded = diagnostics
    .slice(0, CREATE_WORKFLOW_DISPLAY_MAX_DIAGNOSTICS)
    .map((diagnostic) => ({
      line: diagnostic.line,
      column: diagnostic.column,
      code: diagnostic.code,
      message: diagnostic.message.slice(0, CREATE_WORKFLOW_DISPLAY_MAX_MESSAGE_CHARS),
    }));
  const truncated = errorCount > bounded.length;

  return {
    kind: "create_workflow",
    ok,
    errorCount,
    diagnostics: bounded,
    ...(causalityGraph === undefined ? {} : { causalityGraph }),
    ...(truncated ? { truncated: true } : {}),
  };
}
