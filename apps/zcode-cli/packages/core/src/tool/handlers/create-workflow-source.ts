// ============================================================
// CreateWorkflow - Verification and normalization of input parameters
// ============================================================
//
// This module is where two sources are merged into one script, and it is also the only disk read in the entire process. The confluence point must remain single:
// Put it back in the handler, it will gradually be entangled with the handler's branch, and the next person will naturally open another "saved run special"
// "Processing" side road, and the first victim of that side road is the confirmation window - it will start showing bytes that are different from what is going to be executed.

import {
  CREATE_WORKFLOW_ARGS_WITHOUT_PATH_ERROR,
  CREATE_WORKFLOW_SOURCE_ERROR,
  CreateWorkflowInputSchema,
  type CreateWorkflowInput,
  type ModelCatalogPort,
  type SavedWorkflowArgsDeclaration,
  type SavedWorkflowScope,
} from "@zcode/contracts";
import type { ToolHandlerFailure, ToolInputResolutionResult } from "../types.js";
import { resolveModelReference } from "./model-reference.js";
import {
  listSavedWorkflows,
  resolveSavedWorkflow,
  validateWorkflowArgs,
} from "./saved-workflows/index.js";
import { writeWorkflowDraft } from "./workflow-drafts.js";
import { readWorkflowScriptFile } from "./workflow-path-source.js";

/** The error code of a business failure, shaped like the existing handler failure convention. */
const CREATE_WORKFLOW_FAILURE_CODE = 400;

function failure(message: string): ToolHandlerFailure {
  return { result: false, errorCode: CREATE_WORKFLOW_FAILURE_CODE, message };
}

/**
 * Exactly one of the three sources (plus "`args` only travels with `path`"), which holds only
 * for **model-emitted** arguments.
 *
 * This cannot go into zod: after normalization `script` and `saved` / `path` being present
 * together is a legal execution state, yet the schema would blow up on the handler's parse
 * and on the re-validation after a hook rewrite — and only on the non-inline path.
 */
export function validateCreateWorkflowSource(
  input: unknown,
): { result: true } | ToolHandlerFailure {
  const parsed = CreateWorkflowInputSchema.safeParse(input);
  // The failure of the schema itself has been closed by the executor at an earlier position, and only XOR is used here.
  if (!parsed.success) return { result: true };
  const sources = [parsed.data.script, parsed.data.saved, parsed.data.path].filter(
    (source) => source !== undefined,
  );
  if (sources.length !== 1) return failure(CREATE_WORKFLOW_SOURCE_ERROR);
  // `args` and `path` go together: the actual parameters of `saved` go to `saved.args`, and the inline script has no declaration to verify. silence
  // Ignoring it will make the caller think that the parameters are valid, and the `args` read by the script is empty.
  if (parsed.data.args !== undefined && parsed.data.path === undefined) {
    return failure(CREATE_WORKFLOW_ARGS_WITHOUT_PATH_ERROR);
  }
  return { result: true };
}

/**
 * Clamping of the concurrency upper bound: `[1, ceiling]`. A value above the ceiling is
 * **pulled down, not rejected** — when the model says "at most 32", the user wants an upper
 * bound, not an error.
 *
 * When the ceiling is unknown (the port is absent, or the host's port has no
 * `concurrencyCeiling`) the value passes through unchanged: the port implementation clamps
 * again by itself, so clamping once fewer here only makes the confirmation window display a
 * slightly too large number, whereas refusing to run would collapse the whole path.
 *
 * `CreateWorkflow` and `AmendWorkflow` share this function: the same number clamping to
 * different results on two tools is exactly the kind of inconsistency that only surfaces when
 * a user changes the concurrency once.
 */
export function clampWorkflowMaxConcurrency(value: number, ceiling: number | undefined): number {
  // The value has passed the schema (positive integer), and the lower bound is still written: This helper is the common entry point of the two tools, and the schema has been changed.
  // You also shouldn't let 0 or negative numbers pass through it.
  const atLeastOne = Math.max(1, value);
  return ceiling === undefined ? atLeastOne : Math.min(atLeastOne, Math.max(1, ceiling));
}

/**
 * The normalization result for the subagent model: either the resolved canonical form or a
 * business failure.
 *
 * The discriminant is `result` rather than a homemade `ok`: the call site has to be able to
 * `return` the failure verbatim, and `ToolHandlerFailure`'s discriminant is exactly
 * `result: false`.
 */
type SubagentModelResolution = { result: true; canonical?: string } | ToolHandlerFailure;

/**
 * Resolve `subagent_model` into canonical form (the `CreateWorkflow` half; the tri-state
 * `AmendWorkflow` version lives in amend-workflow.ts, and both sides share
 * `resolveModelReference`).
 *
 * When the port is absent while the field is present, **reject explicitly** instead of passing
 * it through silently: a string the host cannot resolve travels all the way down and finally
 * blows up the first time the subagent speaks — long after the user pressed confirm, and by
 * then it looks like the model's fault.
 */
function resolveCreateSubagentModel(
  requested: string | undefined,
  catalog: ModelCatalogPort | undefined,
): SubagentModelResolution {
  if (requested === undefined) return { result: true };
  if (catalog === undefined) return failure(SUBAGENT_MODEL_UNAVAILABLE);
  const resolution = resolveModelReference(requested, catalog.listModels());
  // If it cannot be solved, the entire call fails: nothing is started, and the confirmation window is not opened (the same path as "the saved definition does not exist").
  if (!resolution.ok) return failure(resolution.message);
  return { result: true, canonical: resolution.canonical };
}

/** The rejection wording used when the host has no model catalog (shared with `AmendWorkflow`, hence a constant rather than an inline string). */
export const SUBAGENT_MODEL_UNAVAILABLE =
  "This host cannot choose a subagent model; omit subagent_model.";

/**
 * Normalize the arguments into execution facts. The inline source is the **identity
 * function** (it performs not a single disk operation); the saved source parses the file,
 * validates the arguments, fills in defaults, writes a working copy and yields
 * `{name, script, saved: {name, args, path, scope, draft}}`; the `path` source reads that file
 * (stripping the metadata block when present and validating `args`) and yields
 * `{name, script, path, args?, script_line_offset?}`.
 *
 * After normalization `script` is always present, so downstream (hook, permission rules,
 * prepareApproval, handler) is one piece of code for all three sources. From then on
 * `saved` / `path` are only **provenance**: the run label's fallback, the persistence of the
 * arguments and the recorded script file read them, while execution never reads a single byte
 * of them.
 *
 * `ceiling` is the machine's concurrency ceiling (`port.concurrencyCeiling?.()`, absent
 * meaning no clamping); `catalog` is the machine's model catalog
 * (`context.modelCatalogPort`, absent meaning a model cannot be chosen).
 * `max_concurrency` and `subagent_model` are both top-level fields and all three sources
 * handle them the same way.
 */
export async function resolveCreateWorkflowInput(
  input: unknown,
  cwd: string,
  ceiling?: number,
  catalog?: ModelCatalogPort,
): Promise<ToolInputResolutionResult> {
  const parsed = CreateWorkflowInputSchema.safeParse(input);
  if (!parsed.success) return { result: true, input };
  const model: CreateWorkflowInput = parsed.data;
  const requested = model.max_concurrency;

  // Model parsing comes before disk reading: three sources come from the same code, and a call that cannot be solved should not scan the disk first.
  const subagentModel = resolveCreateSubagentModel(model.subagent_model, catalog);
  if (!subagentModel.result) return subagentModel;
  const subagentModelField =
    subagentModel.canonical === undefined ? {} : { subagent_model: subagentModel.canonical };
  const clampedField =
    requested === undefined
      ? {}
      : { max_concurrency: clampWorkflowMaxConcurrency(requested, ceiling) };

  if (model.path !== undefined) {
    return resolvePathSource(model, model.path, cwd, {
      ...clampedField,
      ...subagentModelField,
    });
  }

  // Inline: Identity. The inline path must not be touched once - that is a measurable form of "zero regression".
  if (model.saved === undefined) {
    // The two exceptions are "If you rewrite it, it will not read the disk. If you don't rewrite it, the confirmation window will show something other than what will take effect.": Overcrowded concurrency
    // Upper bound, and the name of the model that has not yet been normalized to canonical form. When neither is touched, it remains the same byte by byte.
    const clamped =
      requested === undefined ? undefined : clampWorkflowMaxConcurrency(requested, ceiling);
    // The model name compares to the **original** input parameters instead of `model.subagent_model`: the schema has `.trim()`, so there are
    // The blank string is parsed to be equal to the canonical form, and the identity release will cause the confirmation window to display the string of blanks.
    const rawSubagentModel = (input as { subagent_model?: unknown } | null)?.subagent_model;
    if (clamped === requested && subagentModel.canonical === rawSubagentModel) {
      return { result: true, input };
    }
    return {
      result: true,
      input: {
        ...model,
        ...(clamped === undefined ? {} : { max_concurrency: clamped }),
        ...subagentModelField,
      } satisfies CreateWorkflowInput,
    };
  }

  const found = resolveSavedWorkflow({ cwd, name: model.saved.name, scope: model.saved.scope });
  if (!found.ok) return describeResolveFailure(model.saved.name, found, cwd, model.saved.scope);

  const validated = validateWorkflowArgs(found.meta.args, model.saved.args);
  if (!validated.ok) {
    return failure(
      [
        `The arguments for saved workflow '${model.saved.name}' are not valid:`,
        ...validated.errors.map((error) => `- ${error}`),
        "",
        describeArgsDeclaration(`'${found.name}'`, found.meta.args),
      ].join("\n"),
    );
  }

  // The working copy is written just after this read. What is written is the string of bytes just read (together with the metadata block), so there is no possibility
  // The second read forked with it. The definition itself is never changed from one run: the model changes this copy.
  const draft = await writeWorkflowDraft({
    cwd,
    name: model.name ?? found.name,
    source: found.source,
  });

  return {
    result: true,
    input: {
      // When no display name is specified, the saved name is taken: run enumerated across sessions so you can still identify which workflow it is, rather than
      // A string of bare runIds. The existing read rule for `readWorkflowName` (reading input.name) therefore hits unchanged.
      name: model.name ?? found.name,
      // Verbatim script ontology. Old desktop's `readWorkflowScript(raw.script)` so **structural** hits -
      // Not compatible processing.
      script: found.script,
      saved: {
        name: found.name,
        args: validated.args,
        path: found.path,
        scope: found.scope,
        // When the draft cannot be written, the entire field will be absent (best effort), and the model will be returned to the old copy.
        ...(draft === undefined ? {} : { draft: draft.path }),
      },
      // The copy is byte-by-byte with metadata blocks, so the diagnostic file lines skip those lines in the block.
      ...(found.bodyLineOffset === 0 ? {} : { script_line_offset: found.bodyLineOffset }),
      ...(requested === undefined
        ? {}
        : { max_concurrency: clampWorkflowMaxConcurrency(requested, ceiling) }),
      // The saved branch is composed of new parameters from scratch, so each top-level field must be named here once, otherwise it will be
      // Silently lost - and "only lost on the saved path" is the most difficult kind of failure to detect.
      ...subagentModelField,
    } satisfies CreateWorkflowInput,
  };
}

/**
 * Normalization of the `path` source.
 *
 * It writes no draft: the file already is the working copy, and copying it again would only
 * leave the model unsure which one to edit next.
 *
 * A file with a metadata block is parsed as a saved definition and `args` is validated
 * against the declarations in the block (with defaults filled in as well); a file without a
 * block is entirely script, in which case passing `args` is simply wrong — no declaration can
 * validate them, and silently dropping them would leave the caller believing the arguments
 * took effect.
 */
async function resolvePathSource(
  model: CreateWorkflowInput,
  inputPath: string,
  cwd: string,
  extraFields: { max_concurrency?: number; subagent_model?: string },
): Promise<ToolInputResolutionResult> {
  const read = await readWorkflowScriptFile({ cwd, inputPath });
  if (!read.ok) return failure(read.message);
  const file = read.file;

  if (file.meta === undefined && model.args !== undefined) {
    return failure(
      `The workflow script file ${file.described} declares no arguments (it has no \`/* zcode-workflow\` metadata block), so it takes none. Drop \`args\`, or add a block declaring them.`,
    );
  }

  const validated = validateWorkflowArgs(file.meta?.args, model.args);
  if (!validated.ok) {
    return failure(
      [
        `The arguments for the workflow script file ${file.described} are not valid:`,
        ...validated.errors.map((error) => `- ${error}`),
        "",
        describeArgsDeclaration(file.described, file.meta?.args),
      ].join("\n"),
    );
  }

  return {
    result: true,
    input: {
      // The same discipline as the saved branch: here a new input parameter is assembled from scratch, and each top-level field must be named once.
      ...(model.name === undefined ? {} : { name: model.name }),
      script: file.script,
      path: file.path,
      // When declared empty, the actual parameter is always `{}`; no empty shell key is created, and it maintains the same shape as the "no actual parameter" of inline run.
      ...(Object.keys(validated.args).length === 0 ? {} : { args: validated.args }),
      ...(file.bodyLineOffset === 0 ? {} : { script_line_offset: file.bodyLineOffset }),
      ...extraFields,
    } satisfies CreateWorkflowInput,
  };
}

/**
 * The explanation for a resolution failure. When nothing is found, **list the names that are
 * actually available** (with scope tags): after guessing a name wrong, the most useful next
 * piece of information for the model is the correct set, otherwise it will just guess once
 * more.
 *
 * The "not found" wording comes in two tiers: with a `scope` it says "none under that scope",
 * without one it says "nowhere at all" — both list the names from both archives, so the model
 * can see whether the one it wanted lives in the other tier.
 */
function describeResolveFailure(
  name: string,
  found: Exclude<ReturnType<typeof resolveSavedWorkflow>, { ok: true }>,
  cwd: string,
  scope: SavedWorkflowScope | undefined,
): ToolHandlerFailure {
  if (found.reason === "invalid_name") {
    return failure(`'${name}' is not a usable workflow name: ${found.detail}`);
  }
  if (found.reason === "parse_error") {
    return failure(
      [
        `The saved workflow '${name}' at ${found.path} could not be read: ${found.detail}`,
        "",
        "Its metadata block is malformed — most likely hand-edited. Fix the file, or save the workflow again.",
      ].join("\n"),
    );
  }
  if (found.reason === "read_error") {
    return failure(
      `The saved workflow '${name}' at ${found.path} could not be read: ${found.detail}`,
    );
  }

  const headline =
    scope === undefined
      ? `No saved workflow named '${name}' in this project or globally.`
      : `No ${scope} workflow named '${name}'.`;
  return failure(`${headline}\n\n${describeAvailableWorkflows(cwd)}`);
}

/**
 * The names actually available in both archives, each tagged with its scope. Each root is
 * scanned deliberately (without shadowing) so that a global definition shadowed by a project
 * archive still shows up in the listing — that is how the model learns it has to ask for
 * `scope: "global"` to get it.
 */
function describeAvailableWorkflows(cwd: string): string {
  const project = listSavedWorkflows({ cwd, scope: "project" }).entries;
  const global = listSavedWorkflows({ cwd, scope: "global" }).entries;
  const tagged = [
    ...project.map((entry) => `${entry.name} (project)`),
    ...global.map((entry) => `${entry.name} (global)`),
  ];
  if (tagged.length === 0) {
    return "There are no saved workflows yet, in this project or globally. Use SaveWorkflow to create one, or pass an inline `script` instead.";
  }
  return `Available saved workflows: ${tagged.join(", ")}. Use ListSavedWorkflows for their descriptions.`;
}

/** A compact restatement of the argument declarations, appended after an argument validation failure so the model can get it right in one shot instead of guessing another round. */
function describeArgsDeclaration(
  label: string,
  args: SavedWorkflowArgsDeclaration | undefined,
): string {
  const declared = Object.entries(args ?? {});
  if (declared.length === 0) return `${label} declares no arguments.`;
  return [
    `${label} declares:`,
    ...declared.map(([key, spec]) => {
      const notes = [
        spec.type,
        spec.required === true ? "required" : "optional",
        spec.default === undefined ? undefined : `default ${JSON.stringify(spec.default)}`,
      ].filter((note) => note !== undefined);
      return `- ${key} (${notes.join(", ")})${spec.description === undefined ? "" : `: ${spec.description}`}`;
    }),
  ].join("\n");
}
