// ============================================================
// ListModels Tool - List the configured models of this host
// ============================================================
//
// The read-only, side-effect-free discovery surface serves one thing: the main agent has to select a sub-agent model for a workflow run.
// (`subagent_model` of `CreateWorkflow` / `AmendWorkflow`). It is not a mode selector switch - this tool cannot change it
// Session's own model, the master agent always stays on the one selected by the user.
//
// There are **two complementary ways** with the parser: first, pass the name directly according to the user's name. If it cannot be solved, the tool will return it together with the candidate;
// This tool is proactive ("What models do we have available?"). Both paths read the same living directory
// ({@link import("../interfaces/model-catalog.port.js").ModelCatalogPort}).

import { z } from "zod";
import { toToolJsonSchema } from "./json-schema.js";

export const LIST_MODELS_TOOL_NAME = "ListModels";

export const ListModelsInputSchema = z
  .object({})
  // The same constraint as ListSavedWorkflows: no input parameters. Filtering, paging, and fuzzy queries are not provided - the directory is
  // In a table with dozens of rows, one more knob means one more place that makes the model think "not all columns are listed".
  .strict();

export type ListModelsInput = z.infer<typeof ListModelsInputSchema>;

export const ListModelsInputJsonSchema = toToolJsonSchema(ListModelsInputSchema);

/** One row of the catalog. `id` is the canonical form that can be pasted **verbatim** into `subagent_model`. */
export const ListModelsEntrySchema = z
  .object({
    /** The canonical form `providerId/modelId` (no reasoning level; append `$level` yourself if you need one). */
    id: z.string(),
    providerId: z.string(),
    modelId: z.string(),
    /** The human-readable name of the provider; absent when the registry does not give one. */
    providerLabel: z.string().optional(),
    /** The legal `$level` values. A model with no levels is an empty array — the read side uses that to know that "appending `$` is wrong". */
    reasoningLevels: z.array(z.string()),
    /** The level that applies when `$level` is not appended; absent when `reasoningLevels` is empty. */
    defaultReasoningLevel: z.string().optional(),
    contextWindow: z.number().optional(),
    /** The reason it cannot be selected; absent when it can be selected (rather than an empty string). */
    disabledReason: z.string().optional(),
  })
  .strict();

export type ListModelsEntry = z.infer<typeof ListModelsEntrySchema>;

export const ListModelsOutputSchema = z
  .object({
    /**
     * The model this session is using right now (canonical form). **It is only a coordinate, not a recommendation**: it is exactly what runs when a subagent omits `subagent_model`, so "set the subagent to this one" amounts to doing nothing. Absent when not a single catalog row matches.
     */
    current: z.string().optional(),
    models: z.array(ListModelsEntrySchema),
  })
  .strict();

export type ListModelsOutput = z.infer<typeof ListModelsOutputSchema>;

export const ListModelsOutputJsonSchema = toToolJsonSchema(ListModelsOutputSchema);
