// ============================================================
// AmendWorkflow Tool - revise a run: stop it if it is still going, import its finished work, start the revision
// ============================================================
//
// The reason for splitting CreateWorkflow into two tools: Revision is another action, another card - the model is not initiating anything,
// It's changing what the user is looking at, and the precursor may still be running. Both share the same output shape, so executor's
// There is only one copy of background tracking, `backgrounded` contract and display payload.

import { z } from "zod";
import { toToolJsonSchema } from "./json-schema.js";
import {
  WORKFLOW_RUN_LIFECYCLE_STATUSES,
  WORKFLOW_RUN_STOP_REASONS,
} from "./list-workflow-runs.js";

export const AMEND_WORKFLOW_TOOL_NAME = "AmendWorkflow";

/**
 * The violation explanation for "at most one amended script". Same place and same tone as
 * `CREATE_WORKFLOW_SOURCE_ERROR`; what differs is that giving neither one is **legal** here — that is "reuse the predecessor's script".
 */
export const AMEND_WORKFLOW_SOURCE_ERROR =
  "Provide at most one revised script: `path` for the script file you edited (the usual form), or `script` for the whole revised script inline. Passing both is ambiguous; omit both to keep the predecessor's script unchanged.";

/**
 * The model-facing input. Only `run_id` is required, and every other field follows the same rule:
 * **omitted means inherit the predecessor's**. `predecessor` is not here — that is a fact backfilled by resolveInput (below), and the model's JSON schema does not list it.
 */
const AmendWorkflowModelInputSchema = z.object({
  run_id: z
    .string()
    .min(1)
    .describe(
      "ID of the run to amend (from a result, a notification, GetWorkflowRun or ListWorkflowRuns).",
    ),
  /**
   * Both `script` and `path` omitted = reuse the script archived for the predecessor: an amend that only changes settings should not
   * have to copy a script of several thousand tokens again. Same lifetime as the two settings — `resolveInput` reads the
   * predecessor's script, backfills it and stamps `predecessor.script_inherited`; from then on hooks, the confirmation window and
   * the handler all face a single script. The runtime schema must still accept absence: after a hook rewrites it, the call runner revalidates the model's original shape.
   */
  script: z
    .string()
    .min(1)
    .optional()
    .describe(
      "The whole revised script, inline. This OR `path`, never both; omit both to keep the predecessor's script.",
    ),
  /**
   * The normal source of an amend: edit one line in the predecessor's script file in place, then hand the same path back. Inline
   * is still accepted, but it has to stream the whole script again — and that is exactly what this path is meant to save.
   */
  path: z
    .string()
    .min(1)
    .optional()
    .describe(
      "The revised script's file, usually the predecessor's own script file edited in place. This OR `script`, never both.",
    ),
  name: z
    .string()
    .min(1)
    .optional()
    .describe("Display label for the new run; defaults to the predecessor's."),
  /**
   * Three states: omitted = inherit the predecessor's bound, `null` = lift it (back to the ceiling), a number = set it (clamped
   * below the ceiling). The three states only live until `resolveInput`: there it is normalized into a number or absence, so what
   * the confirmation window and the handler read is the value that will take effect. The runtime schema keeps `nullable` because
   * after a hook rewrite the call runner revalidates the model's original shape.
   */
  max_concurrency: z
    .number()
    .int()
    .positive()
    .nullable()
    .optional()
    .describe(
      "Omit to keep the predecessor's limit, null to remove it, a number to set one (only when the user asks).",
    ),
  /**
   * Three states, following exactly the same rule as `max_concurrency`: omitted = inherit the predecessor's choice
   * (`resolveInput` backfills it from the predecessor snapshot and **re-resolves it once**, so that a model that has already been
   * deleted fails right away instead of dragging it out until the subagent first speaks), `null` = clear it (back to the session
   * model), a string = set it. The three states only live until `resolveInput`: there they are normalized into one canonical string or absence.
   */
  subagent_model: z
    .string()
    .trim()
    .min(1)
    .nullable()
    .optional()
    .describe(
      "Omit to keep the predecessor's choice, null for the session model, a model id to set one (only when the user asks).",
    ),
});

/**
 * The predecessor facts backfilled by resolveInput (step 2).
 *
 * The permission decision (this session's runs skip confirmation) and the confirmation window ("still running, will be stopped") both read it,
 * and both do so before the handler and must be synchronous — so resolveInput (asynchronous, the only port read in the whole flow)
 * computes it and places it into the input. The normalization **overwrites unconditionally**: forging it is useless to the model (the same precedent as saved.path).
 */
export const AmendWorkflowPredecessorSchema = z
  .object({
    name: z.string().min(1).optional(),
    status: z.enum(WORKFLOW_RUN_LIFECYCLE_STATUSES),
    stop_reason: z.enum(WORKFLOW_RUN_STOP_REASONS).optional(),
    owned_by_this_session: z.boolean(),
    /**
     * In this call neither `script` nor `path` was given, so `script` in the input is what resolveInput read from the predecessor's
     * archive. There is only one value — "present means true": the confirmation window uses it to say "the script is unchanged" on
     * the lineage row, and the handler uses it to switch to the "inherited" wording and the first sentence of the diagnostics.
     */
    script_inherited: z.literal(true).optional(),
  })
  .strict();

export type AmendWorkflowPredecessor = z.infer<typeof AmendWorkflowPredecessorSchema>;

/**
 * "This predecessor belongs to this session, and was not stopped by the user" — the owner rule that skips confirmation.
 *
 * It lives in the contract rather than in the permission service because it now has **two** readers, and the two must agree word
 * for word: the permission service lets it through in the always-ask branch, and when an in-place concurrency change runs into
 * `not_live` the handler uses it to decide whether this fallback amend should have opened a window in the first place. Written out
 * twice, one day it will let a call that "approved nothing" quietly start a new run.
 *
 * It accepts `unknown`: the permission service receives tool inputs that have not been resolved yet, the handler receives the resolved fact block.
 */
export function isAmendWorkflowOwnedPredecessor(predecessor: unknown): boolean {
  if (!predecessor || typeof predecessor !== "object") return false;
  const facts = predecessor as Record<string, unknown>;
  return facts.owned_by_this_session === true && facts.stop_reason !== "user";
}

/**
 * Runtime input: the model-facing keys plus the backfilled `predecessor` and `script_line_offset`.
 * `.strict()`: an old spelling such as `resume_from` is a visible error here too.
 */
export const AmendWorkflowInputSchema = AmendWorkflowModelInputSchema.extend({
  predecessor: AmendWorkflowPredecessorSchema.optional(),
  /**
   * The offset from body lines to file lines, non-zero only for a `path` file carrying a `/* zcode-workflow` block. The same
   * posture as `predecessor`: it is a resolution result, not a fillable parameter, and the model's JSON schema does not list it.
   */
  script_line_offset: z.number().int().nonnegative().optional(),
}).strict();

export type AmendWorkflowInput = z.infer<typeof AmendWorkflowInputSchema>;

/** The JSON schema handed to the model: without `predecessor`, and without `script_line_offset`. */
export const AmendWorkflowInputJsonSchema = toToolJsonSchema(
  AmendWorkflowModelInputSchema.strict(),
);
