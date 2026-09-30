// ============================================================
// AmendWorkflow: confirm everything before (resolveInput fails with its structuring)
// ============================================================
//
// Take it out from amend-workflow.ts: there are handler and tool declarations, here is the only read port in the whole process - put the model
// The input parameters are normalized into "execution facts that will occur". Each omitted field follows the same rule (if omitted, the predecessor will be used). All three are here.
// Settled: scripts (three sources, see amend-workflow-source.ts), concurrency upper bound, sub-agent model. Afterwards hook, permission,
// The confirmation window and handler face only "a script, a number or nothing, a specification form or nothing".

import {
  AmendWorkflowInputSchema,
  type AmendWorkflowInput,
  type ModelCatalogPort,
} from "@zcode/contracts";
import type {
  ToolHandlerFailure,
  ToolInputResolutionContext,
  ToolInputResolutionResult,
} from "../types.js";
import { SUBAGENT_MODEL_UNAVAILABLE } from "./create-workflow-source.js";
import { resolveConcurrencyRetuneRoute } from "./amend-workflow-retune.js";
import {
  AMEND_WORKFLOW_ERROR_CODE,
  describePredecessor,
  refuseUnchangedScript,
  resolveAmendMaxConcurrency,
  resolveAmendScript,
} from "./amend-workflow-source.js";
import { resolveModelReference } from "./model-reference.js";
import { workflowRunNotFoundFailure } from "./workflow-run-introspection.js";

export {
  AMEND_WORKFLOW_ERROR_CODE,
  resolveAmendMaxConcurrency,
  scriptUnavailableFailure,
  validateAmendWorkflowSource,
} from "./amend-workflow-source.js";

/** The predecessor does not exist: reuses the introspection tool's `run_not_found`, only adding a sentence that names `run_id`. */
export function predecessorNotFoundFailure(runId: string): ToolHandlerFailure {
  const base = workflowRunNotFoundFailure(runId);
  return {
    ...base,
    message: `${base.message} Nothing was stopped or created: \`run_id\` pointed at a run that does not exist — pass an existing run's ID (see ListWorkflowRuns), or start a fresh run with CreateWorkflow.`,
  };
}

/**
 * The one and only read of the port in the whole flow: it resolves `run_id` into a `predecessor` fact block written back into the input.
 *
 * Both the permission decision (a run of this session is confirmation-free, permission/service.ts) and the confirmation window ("still running, it will be stopped") read
 * it, and both happen before the handler and must be synchronous, so it can only be computed here. It **overrides unconditionally** whatever
 * `predecessor` the model supplied: forging one is useless. A non-existent predecessor is closed out right here -- no confirmation window that is certain to fail is shown.
 *
 * The order cannot be swapped: predecessor lookup (non-existence is `run_not_found`, unrelated to the script) -> settle the script (read the file or the predecessor's
 * archive; when it cannot be read, name the reason) -> compare bytes (`script_unchanged`). Done the other way round, a call pointing at a non-existent run would
 * fail first with "cannot read the file", and the model would go fix something that was never the problem.
 *
 * When the port is absent (a host that is not wired up), a given script (inline or a file) passes through as is: the handler takes the "typecheck only,
 * no execution" path, structurally the same as CreateWorkflow; on the permission side, not finding `predecessor` just asks as usual. If neither source is given there is
 * nothing to carry over and it fails on the spot -- it must not degrade to "typecheck only", because there is nothing compilable at all.
 */
export async function resolveAmendWorkflowInput(
  input: unknown,
  context: ToolInputResolutionContext,
): Promise<ToolInputResolutionResult> {
  const parsed = AmendWorkflowInputSchema.safeParse(input);
  if (!parsed.success) return { result: true, input };
  const cwd = context.workingDirectory ?? ".";
  const port = context.dynamicWorkflowRunPort;
  if (port === undefined) {
    const {
      predecessor: _forged,
      max_concurrency: requested,
      subagent_model: _model,
      script_line_offset: _offset,
      ...rest
    } = parsed.data;
    void _forged;
    void _model;
    void _offset;
    // Without a port, there is neither a precursor nor a ceiling: `null` (removal) and "inherit" both collapse into absence, leaving the data unchanged.
    // The normalized input parameters will always have the shape of "one number or none".
    const subagentModel = resolveAmendSubagentModel(
      parsed.data.subagent_model,
      undefined,
      context.modelCatalogPort,
    );
    if (!subagentModel.result) return subagentModel;
    const script = await resolveAmendScript({
      model: parsed.data,
      cwd,
      port,
      predecessorScriptPath: undefined,
    });
    if (!script.result) return script;
    return {
      result: true,
      input: {
        ...rest,
        ...script.fields,
        ...(typeof requested === "number" ? { max_concurrency: requested } : {}),
        ...subagentModel.field,
      },
    };
  }
  const snapshot = await port.getTask(parsed.data.run_id);
  if (snapshot === undefined) return predecessorNotFoundFailure(parsed.data.run_id);
  const predecessor = describePredecessor(snapshot, context.sessionId);
  // The route bifurcates here, and only here: I just finished reading the precursor (so I know whether it is still alive or not), and the shape of the entry is in front of me again.
  // (So I know if there is anything else to change besides concurrency). Hit is to adjust concurrency in place - no script reading, no inheritance, no compilation,
  // The normalized input parameters do not have script, which is also the basis for handler and prepareApproval to recognize this path.
  const retune = resolveConcurrencyRetuneRoute({
    model: parsed.data,
    port,
    predecessor,
    inherited: snapshot.maxConcurrency,
  });
  if (retune !== undefined) return retune;
  const subagentModel = resolveAmendSubagentModel(
    parsed.data.subagent_model,
    snapshot.subagentModel,
    context.modelCatalogPort,
  );
  if (!subagentModel.result) return subagentModel;
  const script = await resolveAmendScript({
    model: parsed.data,
    cwd,
    port,
    predecessorScriptPath: snapshot.scriptPath,
  });
  if (!script.result) return script;
  const unchanged = await refuseUnchangedScript({
    port,
    model: parsed.data,
    resolvedScript: script.fields.script,
    described: script.described,
  });
  if (unchanged !== undefined) return unchanged;
  const {
    predecessor: _forged,
    max_concurrency: _tristate,
    subagent_model: _model,
    // The row offset is the same as `predecessor`: the analysis results and those given by the model will be invalid (recalculated according to the file below).
    script_line_offset: _offset,
    ...rest
  } = parsed.data;
  void _forged;
  void _model;
  void _offset;
  const resolved: AmendWorkflowInput = {
    ...rest,
    ...script.fields,
    ...resolveAmendMaxConcurrency(
      parsed.data.max_concurrency,
      snapshot.maxConcurrency,
      port.concurrencyCeiling?.(),
    ),
    ...subagentModel.field,
    predecessor: {
      ...predecessor,
      ...(script.inherited ? { script_inherited: true as const } : {}),
    },
  };
  return { result: true, input: resolved };
}

/**
 * Three-state normalization of the subagent model, following the very same shape convention
 * as the concurrency upper bound -- the three states live only here, and after this the confirmation window and the handler face nothing but "one canonical form or none":
 *
 *   - A string -> resolve it; if it cannot be resolved, the whole call fails (nothing was stopped, nothing was created, no window opens).
 *   - `null` -> clear it, the key disappears entirely (the new run goes back to the session model).
 *   - Omitted -> carry over the one from the predecessor's snapshot, and **resolve it again**. The predecessor may have started days ago and that model may have been deleted
 *     or disabled since; without re-resolving, the failure would only surface when the subagent first speaks, by which point it looks like a runtime fault.
 *
 * When the catalog is absent the two sources are handled separately: a string the model supplied itself is rejected exactly as `CreateWorkflow` does (a thing the host cannot resolve
 * is never silently let through), while the one being **carried over** is passed through as is -- it was already resolved for the predecessor, and failing an entire revision
 * over a field this call never even mentioned would blame the user for a gap in the host's wiring.
 */
function resolveAmendSubagentModel(
  requested: string | null | undefined,
  inherited: string | undefined,
  catalog: ModelCatalogPort | undefined,
): { result: true; field: { subagent_model?: string } } | ToolHandlerFailure {
  const choice = resolveAmendSubagentModelChoice(requested, inherited, catalog);
  if (choice.ok) {
    return {
      result: true,
      field: choice.canonical === undefined ? {} : { subagent_model: choice.canonical },
    };
  }
  // When the inherited one fails, it must be clearly stated that it is **inherited**: the model is not mentioned at all in this call, and the parsing is directly
  // If you throw diagnostics to it, it will think that it has passed the wrong parameters and try again as is.
  return subagentModelFailure(
    choice.inherited
      ? `This amend inherited the predecessor run's subagent model (\`${choice.text}\`), which is no longer usable. ${choice.message}\n\nPass \`subagent_model: null\` to run the revision on the session model instead.`
      : choice.message,
  );
}

/**
 * The **decision body** for the three states of the subagent model, shared by the tool and the GUI "settings" (the runtime's amendWorkflowRunSettings)
 * (the parsing code is shared, not copied). The two differ only in how they **word** a failure
 * -- the tool talks to the model (with a `subagent_model: null` suggestion), the GUI talks to a human (the diagnostics go into the ACK message).
 *
 * Result: an absent `canonical` means "the session model"; a failure carries `inherited` (the carried-over one is what failed) together with the resolution diagnostics.
 */
export function resolveAmendSubagentModelChoice(
  requested: string | null | undefined,
  inherited: string | undefined,
  catalog: ModelCatalogPort | undefined,
):
  | { ok: true; canonical?: string }
  | { ok: false; inherited: boolean; text: string; message: string } {
  if (requested === null) return { ok: true };
  const text = requested ?? inherited;
  if (text === undefined) return { ok: true };
  if (catalog === undefined) {
    return requested === undefined
      ? { ok: true, canonical: text }
      : { ok: false, inherited: false, text, message: SUBAGENT_MODEL_UNAVAILABLE };
  }
  const resolution = resolveModelReference(text, catalog.listModels());
  if (!resolution.ok) {
    return { ok: false, inherited: requested === undefined, text, message: resolution.message };
  }
  return { ok: true, canonical: resolution.canonical };
}

/** Resolution failure -> a structured business failure. The discriminating key sits in the message prefix (same as the other codes in this file). */
function subagentModelFailure(message: string): ToolHandlerFailure {
  return {
    result: false,
    errorCode: AMEND_WORKFLOW_ERROR_CODE.SUBAGENT_MODEL,
    message: `workflow_subagent_model_unresolved: ${message} Nothing was stopped or created.`,
  };
}
