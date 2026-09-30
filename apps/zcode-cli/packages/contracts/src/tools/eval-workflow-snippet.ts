// ============================================================
// EvalWorkflowSnippet Tool - synchronously compile and run a dynamic workflow snippet (scratch facade)
// ============================================================
// Experimental channels for workflow authoring:
// The same compilation / lowering / sandbox / world-read execution surface, memory journal, completely transient.

import { z } from "zod";
import { CreateWorkflowDiagnosticSchema } from "./create-workflow.js";
import { toToolJsonSchema } from "./json-schema.js";

export const EVAL_WORKFLOW_SNIPPET_TOOL_NAME = "EvalWorkflowSnippet";

/** The snippet wall clock defaults to 60s; the cap is 600s (real build-like checks need headroom). */
export const EVAL_WORKFLOW_SNIPPET_DEFAULT_TIMEOUT_MS = 60_000;
export const EVAL_WORKFLOW_SNIPPET_MAX_TIMEOUT_MS = 600_000;
export const EVAL_WORKFLOW_SNIPPET_MIN_TIMEOUT_MS = 1_000;

/** The violation message for "exactly one snippet" (the same tone as the other three tools). */
export const EVAL_WORKFLOW_SNIPPET_SOURCE_ERROR =
  "Provide exactly one snippet source: `code` for the snippet inline, or `path` for a file holding it. Passing both, or neither, is ambiguous.";

export const EvalWorkflowSnippetInputSchema = z
  .object({
    code: z.string().min(1).optional().describe("The snippet, inline. This OR `path`, never both."),
    /**
     * The second source for a snippet. **The whole file is the code**:
     * the snippet does not carry the saved-definition semantics, and a file that merely happens to start with `/* zcode-workflow` should not be stripped of its declaration block either.
     */
    path: z
      .string()
      .min(1)
      .optional()
      .describe("A file holding the snippet, read whole. This OR `code`, never both."),
    timeoutMs: z
      .number()
      .int()
      .min(EVAL_WORKFLOW_SNIPPET_MIN_TIMEOUT_MS)
      .max(EVAL_WORKFLOW_SNIPPET_MAX_TIMEOUT_MS)
      .optional()
      .describe("Wall clock for the whole snippet, in ms. Default 60000, at most 600000."),
  })
  .strict();

export type EvalWorkflowSnippetInput = z.infer<typeof EvalWorkflowSnippetInputSchema>;

export const EvalWorkflowSnippetInputJsonSchema = toToolJsonSchema(EvalWorkflowSnippetInputSchema);

// The limit of logs (all payloads on the protocol boundary are bounded): number of entries × length of a single entry. Excess logs will be truncated and marked on the service side.
export const EVAL_WORKFLOW_SNIPPET_MAX_LOGS = 100;
export const EVAL_WORKFLOW_SNIPPET_MAX_LOG_CHARS = 2_048;
/** Serialization cap for the top-level return value (the harness does not measure artifact size — that bound belongs to the service/tool layer). */
export const EVAL_WORKFLOW_SNIPPET_MAX_ARTIFACT_BYTES = 256 * 1024;

export const EvalWorkflowSnippetOutputSchema = z
  .object({
    /** True when compilation is clean and the script returns normally; false when diagnostics are present or the run fails (timeout / throw / cap). */
    ok: z.boolean(),
    diagnostics: z.array(CreateWorkflowDiagnosticSchema),
    /** Engine `log()` events captured in arrival order (bounded; when truncated, the last entry is an annotation). */
    logs: z.array(z.string().max(EVAL_WORKFLOW_SNIPPET_MAX_LOG_CHARS)),
    /** Model-facing text: artifact serialization / diagnostics list / structured failure (error code + message). */
    response: z.string(),
    durationMs: z.number().int().nonnegative(),
  })
  .strict();

export type EvalWorkflowSnippetOutput = z.infer<typeof EvalWorkflowSnippetOutputSchema>;

export const EvalWorkflowSnippetOutputJsonSchema = toToolJsonSchema(
  EvalWorkflowSnippetOutputSchema,
);
