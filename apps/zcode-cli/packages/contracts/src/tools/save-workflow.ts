// ============================================================
// SaveWorkflow Tool - Save a dwf script along with metadata as a reusable definition in the project
// ============================================================

import { z } from "zod";
import { toToolJsonSchema } from "./json-schema.js";
import { CreateWorkflowDiagnosticSchema } from "./create-workflow.js";
import {
  SAVED_WORKFLOW_MAX_NAME_CHARS,
  SavedWorkflowArgsDeclarationSchema,
  SavedWorkflowScopeSchema,
  SavedWorkflowShadowingSchema,
} from "./saved-workflow.js";

export const SAVE_WORKFLOW_TOOL_NAME = "SaveWorkflow";

/**
 * The violation message for "exactly one body source". The field is not named `path` because `path` is already the **resolved-backfilled
 * landing spot** of this tool (the confirmation dialog and the UI read it); two fields with the same name, one input and one output, would only lead the model
 * to pass the save target in as the source file.
 */
export const SAVE_WORKFLOW_SOURCE_ERROR =
  "Provide exactly one script source: `script` for the body inline, or `script_path` for the file holding it (a draft, usually). Passing both, or neither, is ambiguous.";

/** The business failure message for when the model passes in a script that already carries frontmatter. */
export const SAVE_WORKFLOW_SENTINEL_IN_SCRIPT_ERROR =
  "The `script` must be the workflow body only — it already starts with a `/* zcode-workflow` metadata block. Pass the metadata through the `description` / `whenToUse` / `args` fields instead; the block is written for you.";

export const SaveWorkflowInputSchema = z
  .object({
    name: z
      .string()
      .min(1)
      .max(SAVED_WORKFLOW_MAX_NAME_CHARS)
      .describe("File-safe identifier: letters, digits, dot, dash and underscore."),
    description: z.string().min(1).describe("One line saying what the workflow does."),
    whenToUse: z.string().min(1).optional().describe("When this workflow is the right answer."),
    args: SavedWorkflowArgsDeclarationSchema.optional().describe(
      "Argument declarations the script reads off `args`.",
    ),
    script: z
      .string()
      .optional()
      .describe(
        "The script body, inline, without a metadata block. This OR `script_path`, never both.",
      ),
    /**
     * The second source for the body: a file already on disk,
     * usually the draft that just ran. When the file carries a metadata block, **the block is dropped** — the metadata is whatever this call's fields say;
     * what the user approved is those fields, not the copy inside the file.
     */
    script_path: z
      .string()
      .min(1)
      .optional()
      .describe(
        "A file holding the script body, usually a draft a result named. This OR `script`, never both.",
      ),
    // The scope is stated by the model, not guessed by the system - there is no default value, it must be judged every time. Criterion Neutral: Whether the script
    // Reference something from this repository? Yes → project, no → global.
    scope: SavedWorkflowScopeSchema.describe(
      '"project" when the script depends on this repository; "global" when it depends on nothing in it. Required, no default.',
    ),
    // ——The following three fields are parsed and backfilled by `resolveInput`, and are not filled in by the model——
    // They are the facts to be displayed in the confirmation window: which file this save falls into, whether it is overwritten once, and whether it blocks another file.
    // Enter parameter instead of display because the parameter input channel is transparent transmission without schema for each client version. The old desktop and
    // legacy v3 can therefore also see the full content.
    /** Resolution backfill: where the file lands. */
    path: z.string().min(1).optional(),
    /** Resolution backfill: the target already exists, and what is being approved this time is an **overwrite**. */
    overwrite: z.boolean().optional(),
    /** Resolution backfill: another tier already has a definition of the same name (a shadowing fact, for the confirmation dialog to show). Absent = no same-name definition. */
    shadowing: SavedWorkflowShadowingSchema.optional(),
  })
  .strict();

export type SaveWorkflowInput = z.infer<typeof SaveWorkflowInputSchema>;

export const SaveWorkflowInputJsonSchema = toToolJsonSchema(SaveWorkflowInputSchema);

/**
 * The output shares one schema with the diagnostics shape of CreateWorkflow: the two tools run the **same** type checker,
 * and showing the model differently shaped diagnostics in the two places would only teach it to write two parsers.
 *
 * `overwritten` appears only when a file was really written — a diagnostics-only result has no "was it overwritten" to speak of, and sending
 * a `false` would make the model think the write reached disk.
 */
export const SaveWorkflowOutputSchema = z
  .object({
    diagnostics: z.array(CreateWorkflowDiagnosticSchema),
    ok: z.boolean(),
    response: z.string(),
    name: z.string().min(1),
    scope: SavedWorkflowScopeSchema,
    /** Where the file lands (when it was not written, the place it **should have** gone, so that the model can state the error properly). */
    path: z.string().min(1),
    overwritten: z.boolean().optional(),
  })
  .strict();

export type SaveWorkflowOutput = z.infer<typeof SaveWorkflowOutputSchema>;

export const SaveWorkflowOutputJsonSchema = toToolJsonSchema(SaveWorkflowOutputSchema);
