// ============================================================
// Saved workflows - A shared vocabulary of saved dwf definitions
// ============================================================
//
// This module **only** declares "what a saved workflow is": the legal shape of the name, file placement, parameter declaration and
// metadata. Three tools (SaveWorkflow for writing, ListSavedWorkflows for reading, CreateWorkflow with `saved`
// Source run) all use it as a contract, and the store on the core side also takes the schema from here - once the metadata shape is changed between the write side and the read side
// They evolve separately, and the symptom is "the newly saved workflow cannot be listed", and that is the most difficult type of fork to be caught by one-sided testing.

import { z } from "zod";

/**
 * The extension of a saved file. `.dwf.ts` rather than `.ts`: editors highlight it as TypeScript (the frontmatter is a block comment,
 * so it is syntactically legal), while the `.dwf` stretch lets a scan tell it apart from project source without opening the file.
 */
export const SAVED_WORKFLOW_FILE_EXTENSION = ".dwf.ts";

/** The project-scoped storage directory (relative to the session working directory). */
export const SAVED_WORKFLOW_PROJECT_DIR = ".zcode/workflows";

/**
 * The draft directory (relative to the session working directory). Script files the model edits in place between two submits land here; it is a
 * sibling directory of `.zcode/workflows/` (the user-saved definitions), owned by the machine and carrying its own `.gitignore: *`.
 */
export const WORKFLOW_DRAFTS_DIR = ".zcode/workflow-drafts";

/**
 * The global-scoped storage directory (relative to the agent process's home directory). The landing spot is `~/.zcode/workflows/<name>.dwf.ts`
 * -- the very same user root as the legacy Workflow tool, visible from every project.
 */
export const SAVED_WORKFLOW_GLOBAL_DIR = ".zcode/workflows";

/**
 * The legal shape of a name. The very same pattern as the old `Workflow` tool's parser (script-workflow-tool-port.ts) --
 * the name has to double as a file name, so slashes, `..` and whitespace are flatly disallowed: this regex **is** the defence against path traversal,
 * not a stylistic preference.
 */
export const SAVED_WORKFLOW_NAME_PATTERN = /^[A-Za-z0-9_.-]+$/u;

/** The upper bound on name length. A file name has to hold up on every platform; 64 is far inside any PATH_MAX and descriptive enough. */
export const SAVED_WORKFLOW_MAX_NAME_CHARS = 64;

/**
 * The scope. Two levels: `project` lands in the project's `.zcode/workflows/` and is visible only inside that project; `global`
 * lands in `~/.zcode/workflows/` (the agent process's home directory) and is visible from every project. A file's scope is inferred from the directory it sits in, the frontmatter does not store it.
 */
export const SAVED_WORKFLOW_SCOPES = ["project", "global"] as const;

export const SavedWorkflowScopeSchema = z.enum(SAVED_WORKFLOW_SCOPES);

export type SavedWorkflowScope = z.infer<typeof SavedWorkflowScopeSchema>;

/**
 * The shadowing fact: the other scope already has a definition with the same name. Computed at save time, for the confirmation window to show.
 * `hides_global`: this save is the project one, and it will shadow the same-named global one inside this project;
 * `hidden_by_project`: this save is the global one, and a same-named project one already in this project will shadow it.
 */
export const SAVED_WORKFLOW_SHADOWING = ["hides_global", "hidden_by_project"] as const;

export const SavedWorkflowShadowingSchema = z.enum(SAVED_WORKFLOW_SHADOWING);

export type SavedWorkflowShadowing = z.infer<typeof SavedWorkflowShadowingSchema>;

/**
 * The type vocabulary for parameters. Three primitives plus a `json` catch-all: a primitive can be validated into "you passed the wrong thing", while `json` states outright
 * "anything goes here", so that "not validated" and "deliberately not validated" are two different things in the declaration instead of one and the same hole.
 */
export const SAVED_WORKFLOW_ARG_TYPES = ["string", "number", "boolean", "json"] as const;

export const SavedWorkflowArgTypeSchema = z.enum(SAVED_WORKFLOW_ARG_TYPES);

export type SavedWorkflowArgType = z.infer<typeof SavedWorkflowArgTypeSchema>;

export const SavedWorkflowArgDeclarationSchema = z
  .object({
    type: SavedWorkflowArgTypeSchema.describe(
      'Value type. "json" accepts any JSON value without further checking.',
    ),
    description: z
      .string()
      .optional()
      .describe("What this argument means, for whoever calls the workflow later."),
    required: z
      .boolean()
      .optional()
      .describe("When true the workflow cannot run without this argument."),
    // `default` is deliberately unknown rather than a union by `type`: the type correctness of the default value is determined by
    // validateWorkflowArgs goes through the same verification as the incoming value after applying the default value, one rule instead of two.
    default: z.unknown().optional().describe("Value used when the caller omits this argument."),
  })
  .strict();

export type SavedWorkflowArgDeclaration = z.infer<typeof SavedWorkflowArgDeclarationSchema>;

export const SavedWorkflowArgsDeclarationSchema = z.record(SavedWorkflowArgDeclarationSchema);

export type SavedWorkflowArgsDeclaration = z.infer<typeof SavedWorkflowArgsDeclarationSchema>;

/**
 * The metadata body in the frontmatter. `.strict()` turns a mistyped key into a visible invalid line rather than
 * a field silently dropped -- the saved files are ones users will hand-edit, so a typo has to be pointable.
 */
export const SavedWorkflowMetaSchema = z
  .object({
    description: z.string().min(1),
    whenToUse: z.string().min(1).optional(),
    args: SavedWorkflowArgsDeclarationSchema.optional(),
  })
  .strict();

export type SavedWorkflowMeta = z.infer<typeof SavedWorkflowMetaSchema>;

/** One row in a listing: metadata + landing spot, **without the script body** (enumerating is not reading). */
export const SavedWorkflowEntrySchema = z
  .object({
    name: z.string().min(1),
    description: z.string(),
    whenToUse: z.string().optional(),
    args: SavedWorkflowArgsDeclarationSchema.optional(),
    scope: SavedWorkflowScopeSchema,
    path: z.string().min(1),
  })
  .strict();

export type SavedWorkflowEntry = z.infer<typeof SavedWorkflowEntrySchema>;

/**
 * A file that exists but cannot be read. The listing **does not fail because of one bad file**: when a user hand-edits a frontmatter into
 * a broken state, the remaining workflows must stay usable, and the bad file has to be named outright, otherwise it has merely vanished.
 */
export const SavedWorkflowInvalidEntrySchema = z
  .object({
    path: z.string().min(1),
    reason: z.string().min(1),
  })
  .strict();

export type SavedWorkflowInvalidEntry = z.infer<typeof SavedWorkflowInvalidEntrySchema>;

/** Whether a name is usable as a file name (that is, whether it could point at a saved workflow). */
export function isValidSavedWorkflowName(name: string): boolean {
  if (name.length === 0 || name.length > SAVED_WORKFLOW_MAX_NAME_CHARS) return false;
  if (!SAVED_WORKFLOW_NAME_PATTERN.test(name)) return false;
  // `.` and `..` pass the above character set check but are directory entries, not names.
  return name.replaceAll(".", "").length > 0;
}
