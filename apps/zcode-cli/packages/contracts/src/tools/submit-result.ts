// ============================================================
// submit_result Tool - actor terminal structured-result submission
// ============================================================
// The workflow actor (sub-AgentRuntime) uses it to submit the structured results of this ask. The declared input is universal
// Arbitrary JSON (single `result` attribute) - the specific schema for each ask is not declared in the tool, but is appended to the ask
// The epilogue of the command message is issued to maintain the frozen-per-actor tool cache invariant.

import { z } from "zod";
import { TOOL_JSON_SCHEMA_VERSION, toToolJsonSchema } from "./json-schema.js";

export const SUBMIT_RESULT_TOOL_NAME = "submit_result";

export const SubmitResultInputSchema = z
  .object({
    // Intentionally kept generic: the shape of result is not constrained. The specific per-ask schema is in the ask command epilogue,
    // Verified by the engine on the WorkflowSubmitPort side; this way tool declarations can cross ask freezes and hit prompt cache.
    result: z
      .unknown()
      .describe(
        "The structured result for this ask, matching the JSON schema given in the ask instructions.",
      ),
  })
  .strict();

export type SubmitResultInput = z.infer<typeof SubmitResultInputSchema>;

export const SubmitResultInputJsonSchema = toToolJsonSchema(SubmitResultInputSchema);

/**
 * The typed tool declaration of a mono sub-agent: the sub-schema of `result` is that actor's only ask-result schema. The runtime zod validation is still the
 * general `SubmitResultInputSchema` above — the per-ask shape is validated by the engine on the WorkflowSubmitPort side, the tool declaration only lets the
 * provider see it (and natively constrain it when supported). The outer object is shaped like the general declaration: a single required `result`, extra keys forbidden.
 */
export function typedSubmitResultInputSchema(
  resultSchema: Record<string, unknown>,
): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      result: {
        description: "The structured result for this ask.",
        ...resultSchema,
      },
    },
    required: ["result"],
    additionalProperties: false,
    $schema: TOOL_JSON_SCHEMA_VERSION,
  };
}

export const SubmitResultOutputSchema = z
  .object({
    status: z.literal("accepted"),
  })
  .strict();

export type SubmitResultOutput = z.infer<typeof SubmitResultOutputSchema>;

export const SubmitResultOutputJsonSchema = toToolJsonSchema(SubmitResultOutputSchema);
