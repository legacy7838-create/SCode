// ============================================================
// AmendWorkflow Tool Handler
// ============================================================
//
// There are only two differences with CreateWorkflow: resolveInput parses the **precursor run** instead of the saved file (the omitted
// The script, concurrency upper bound and sub-agent model are all inherited from the predecessor, see amend-workflow-resolve.ts; the three sources of the script are
// amend-workflow-source.ts), the handler adjusts
// `port.amend` (service is responsible for stopping in flight, waiting for settlement, import, and startup). Compilation, diagnostic path, display payload,
// The backgrounded contract is literally shared with CreateWorkflow - the response on the model side is also written like it, with only one more sentence
// "Which run has been replaced?" When using the script, add another sentence: "The script has not changed."

import {
  AMEND_WORKFLOW_TOOL_NAME,
  AmendWorkflowInputJsonSchema,
  AmendWorkflowInputSchema,
  CreateWorkflowOutputJsonSchema,
  CreateWorkflowOutputSchema,
  type AmendWorkflowInput,
  type CreateWorkflowOutput,
  type ModelMessageContent,
  createWorkflowPhaseAlongside,
  createWorkflowPhaseNames,
} from "@zcode/contracts";
import type {
  ToolApprovalGate,
  ToolEntry,
  ToolExecutionContext,
  ToolHandler,
  ToolHandlerFailure,
} from "../types.js";
import { AMEND_WORKFLOW_TOOL_DESCRIPTION } from "./amend-workflow-description.js";
import {
  AMEND_WORKFLOW_ERROR_CODE,
  predecessorNotFoundFailure,
  resolveAmendWorkflowInput,
  scriptUnavailableFailure,
  validateAmendWorkflowSource,
} from "./amend-workflow-resolve.js";
import {
  isConcurrencyOnlyAmend,
  resolveRetuneFallbackAmend,
  runConcurrencyRetune,
} from "./amend-workflow-retune.js";
import {
  DIAGNOSTICS_NOT_EXECUTED_NOTE,
  EXECUTION_UNAVAILABLE_NOTE,
  describeWorkflowConcurrencyLimit,
  resolveTraceContext,
} from "./create-workflow.js";
import { describeWorkflowSubagentModel, parseWorkflowSubagentModel } from "./model-reference.js";
import { boundGraphOfAnalysis, displayOfAnalysis } from "./workflow-analysis-display.js";
import { recordAuthoredWorkflowDraft } from "./workflow-draft-read-state.js";
import { resolveWorkflowDraftName, writeWorkflowDraft } from "./workflow-drafts.js";
import {
  formatWorkflowDiagnosticLines,
  workflowAmendedScriptSentence,
  workflowScriptFileNote,
  type WorkflowScriptLocation,
} from "./workflow-script-notes.js";
import { analyzeScript } from "./workflow-script-analysis.js";
import { describeWorkflowScriptPath } from "./workflow-script-path.js";
import { amendWorkflowNeedsSkill, requireDynamicWorkflowSkill } from "./workflow-skill-gate.js";

const AMEND_WORKFLOW_TIMEOUT_MS = 15_000;
const AMEND_WORKFLOW_MODEL_BYTES = 24_000;

function amendUnavailableFailure(): ToolHandlerFailure {
  return {
    result: false,
    errorCode: AMEND_WORKFLOW_ERROR_CODE.AMEND_UNAVAILABLE,
    message:
      "workflow_amend_unavailable: this session cannot amend workflow runs — workflow execution is not available here. This is a capability gap, not a status problem.",
  };
}

/** Two rejection reasons for the port → Structured failure with actionable text (discrimination key is in the message prefix). */
function amendRefusalFor(reason: string, runId: string): ToolHandlerFailure {
  switch (reason) {
    case "run_not_found":
      return predecessorNotFoundFailure(runId);
    case "missing_boundaries":
      return {
        result: false,
        errorCode: AMEND_WORKFLOW_ERROR_CODE.MISSING_BOUNDARIES,
        message: `workflow_amend_missing_boundaries: run ${runId}'s journal predates transcript-boundary bookkeeping (or its boundaries were never recorded), so its finished asks cannot seed an amended run — there is no fallback. Submit this script as a fresh CreateWorkflow instead. Nothing was stopped or created.`,
      };
    default:
      // Reason outside the port contract: still returns structural failure (throw is the channel of wiring failure), the copy contains the original word for log troubleshooting.
      return {
        result: false,
        errorCode: AMEND_WORKFLOW_ERROR_CODE.MISSING_BOUNDARIES,
        message: `workflow_amend_refused: the workflow runtime refused to amend run ${runId} (reason: ${reason}). Nothing was stopped or created.`,
      };
  }
}

/**
 * Write copy that will not turn in the model on time. The diagnostic line and NOTE are written as file coordinates according to "Script files" (if the script has files). Inherited
 * The script must first make it clear that it is ** inheritance
 * **: The model did not write these lines when it was called this time. Just by diagnosing it, it would think that it had passed the wrong parameters - and "the inherited sub-agent model has been
 * Not available" for the same reason. In both cases, add that the front drive is not running: otherwise the model will think that it has just stopped a running run.
 */
function compileFailureResponse(
  input: AmendWorkflowInput,
  diagnostics: CreateWorkflowOutput["diagnostics"],
  location: WorkflowScriptLocation | undefined,
): string {
  const inherited = input.predecessor?.script_inherited === true;
  const note =
    location !== undefined
      ? workflowScriptFileNote(location)
      : inherited
        ? "NOTE: Nothing ran — pass a rewritten `script` that compiles."
        : DIAGNOSTICS_NOT_EXECUTED_NOTE;
  return [
    inherited
      ? `This amend kept run ${input.run_id}'s script, inherited because you omitted both \`script\` and \`path\`, and that script no longer compiles against the current workflow facade:`
      : "The revised workflow script has errors:",
    ...formatWorkflowDiagnosticLines(diagnostics, location),
    "",
    `${note} Run ${input.run_id} was not touched.`,
  ].join("\n");
}

const amendWorkflowHandler: ToolHandler = async (input, context) => {
  const parsed = AmendWorkflowInputSchema.parse(input) as AmendWorkflowInput;
  // Adjust concurrency in place:
  // There is only one trace left here of the path determined by resolveInput - no script, only a concurrency value. Port answer `not_live`
  // (The run resolves between the two steps) when it falls back to a real revision, scripting and compilation are deferred until that moment.
  if (isConcurrencyOnlyAmend(parsed)) {
    const retuned = await runConcurrencyRetune(parsed, context);
    if (retuned !== undefined) return retuned;
    const fallback = await resolveRetuneFallbackAmend(parsed, context);
    if (!fallback.result) return fallback;
    return await amendResolvedWorkflow(fallback.input, context);
  }
  return await amendResolvedWorkflow(parsed, context);
};

/** Revision of the ontology: When entering the script, you must bring the script to be run (the tool routing and loopback have already settled on it). */
async function amendResolvedWorkflow(
  parsed: AmendWorkflowInput,
  context: ToolExecutionContext,
): Promise<CreateWorkflowOutput | ToolHandlerFailure> {
  // resolveInput always settles the script (`path` is read as `script`, omitted, backfill from the front drive, or fails on the spot); still here
  // Without a script, the only possibility is to bypass the normalized caller - which also returns a structural failure instead of handing undefined to the compiler.
  const script = parsed.script;
  if (script === undefined) return scriptUnavailableFailure(parsed.run_id, "host");
  const cwd = context.workingDirectory;

  const analysis = analyzeScript(script);
  const { diagnostics, ok } = analysis;
  const causalityGraph = boundGraphOfAnalysis(analysis);

  // Inline revision follows the same discipline as `CreateWorkflow`: the working copy is placed **regardless of the compilation result**, so that a section that cannot be compiled can be
  // Revisions also have files that can be modified; the analysis is ranked first just for the name (if there is no `name` or no predecessor name, the first stage name is used). `path` is present
  // No writing - that file is already a working copy. Both sides of the inherited script are possible: the predecessor script file is still the same byte time
  // resolveInput has filled it into `path` (the new run will continue to remember it), otherwise write a new one here according to the "script not from the file".
  const inlineDraft =
    parsed.path === undefined
      ? await writeWorkflowDraft({
          cwd,
          name: resolveWorkflowDraftName(parsed.name ?? parsed.predecessor?.name, causalityGraph),
          source: script,
        })
      : undefined;
  // Only the script written by the model this time is recorded as the file it has written; the new draft that uses the precursor script is not recorded - the bytes may come from other sources.
  // Guaranteeing the model for content it hasn't seen before session or compression is exactly what read-before-edit is trying to prevent.
  if (inlineDraft !== undefined && parsed.predecessor?.script_inherited !== true) {
    await recordAuthoredWorkflowDraft(context, {
      path: inlineDraft.path,
      source: script,
      toolName: "AmendWorkflow",
    });
  }
  // run always remembers the file containing this script. If the script is changed, the path of the predecessor will never be used: that file is installed with the old
  // The script is recorded in the new run to allow the model to edit a piece of code that is no longer running next time. Predecessor files can be continued when inheriting scripts
  // Remember, but only if its current bytes are still this script (resolveKeptScriptFile has checked).
  const scriptPath = parsed.path ?? inlineDraft?.path;
  const location: WorkflowScriptLocation | undefined =
    scriptPath === undefined
      ? undefined
      : {
          kind: parsed.path === undefined ? "draft" : "path",
          described: describeWorkflowScriptPath(scriptPath, cwd),
          lineOffset: parsed.script_line_offset ?? 0,
        };

  if (!ok) {
    // Can't make it up: nothing is stopped, nothing is built.
    return {
      diagnostics,
      ok,
      response: compileFailureResponse(parsed, diagnostics, location),
      ...(causalityGraph === undefined ? {} : { causalityGraph }),
    } satisfies CreateWorkflowOutput;
  }

  const port = context.dynamicWorkflowRunPort;
  if (port === undefined) {
    return {
      diagnostics,
      ok,
      response: `The revised workflow script compiled cleanly.\n\n${EXECUTION_UNAVAILABLE_NOTE}`,
      ...(causalityGraph === undefined ? {} : { causalityGraph }),
    } satisfies CreateWorkflowOutput;
  }
  if (typeof port.amend !== "function") return amendUnavailableFailure();

  const amended = await port.amend(
    {
      scriptText: script,
      cwd: context.workingDirectory,
      predecessorRunId: parsed.run_id,
      ...(parsed.name === undefined ? {} : { name: parsed.name }),
      parentSessionId: context.sessionId,
      toolCallId: context.toolCallId,
      // Declaration stage table of new script: Revised to use the inputId of the predecessor, but the sidebar track needs to draw the site of the new script. The subscript of the "simultaneously running" table
      // It is this new table that is pointed to, so both must be taken from the same picture together.
      ...(() => {
        const phaseNames = createWorkflowPhaseNames(causalityGraph);
        if (phaseNames === undefined) return {};
        const phaseAlongside = createWorkflowPhaseAlongside(causalityGraph);
        return { phaseNames, ...(phaseAlongside === undefined ? {} : { phaseAlongside }) };
      })(),
      // The three states have been normalized to "a number or none" in resolveInput; `null` here can only come from bypassing the normalization
      // The caller (the port does not accept it), also reads absent.
      ...(typeof parsed.max_concurrency === "number"
        ? { maxConcurrency: parsed.max_concurrency }
        : {}),
      // Same as above: the three states have been reduced to "a canonical form or none" in resolveInput, `null` can only come from bypassing here
      // Normalized caller, synonymous with absent (the port does not accept it).
      ...(() => {
        const subagentModel = parseWorkflowSubagentModel(parsed.subagent_model ?? undefined);
        return subagentModel === undefined ? {} : { subagentModel };
      })(),
      // This time revised script file. Absence means the draft cannot be written
      // Go down and the model will return to the old copy.
      ...(scriptPath === undefined ? {} : { scriptPath }),
      trace: resolveTraceContext(context),
    },
    { signal: context.abortSignal },
  );
  if (!amended.ok) return amendRefusalFor(amended.reason, parsed.run_id);

  const superseded =
    amended.supersededRunId === undefined
      ? `Run ${parsed.run_id} had already settled; its finished work is imported as cache.`
      : `Run ${amended.supersededRunId} was still running: it has been stopped and superseded, and everything it finished before the stop is imported as cache. It will not send a notification of its own.`;
  // When inheriting the script, indicate "the script has not changed": the model will know from this that it is only the settings that have been changed this time, rather than going through a new script that it has not written.
  const started =
    parsed.predecessor?.script_inherited === true
      ? `The script of run ${parsed.run_id} started unchanged in the background as run ${amended.runId}.`
      : `The revised script started in the background as run ${amended.runId}.`;
  return {
    diagnostics,
    ok,
    // Copywriting photo CreateWorkflow's backgrounded guide: Give the id, explain that it is still running, and the results will be returned in the form of notifications.
    // Default polling is explicitly discouraged.
    response: `${superseded} ${started} It is still running — you will be notified with the final output when it completes. Do not wait for it or poll it with TaskOutput; continue with other work unless the user asked you to wait.${describeWorkflowConcurrencyLimit(parsed.max_concurrency ?? undefined, port.concurrencyCeiling?.())}${describeWorkflowSubagentModel(parsed.subagent_model ?? undefined)}${location === undefined ? "" : workflowAmendedScriptSentence(location)}`,
    status: "backgrounded",
    backgroundTaskId: amended.runId,
    ...(causalityGraph === undefined ? {} : { causalityGraph }),
  } satisfies CreateWorkflowOutput;
}

/**
 * Confirmation window preview: the same code as CreateWorkflow (if it cannot be edited, it will be released to the handler for diagnosis). display kind
 * Still `create_workflow` - there is only one implementation of diagrams, scratch pens and diagnostic cards on the UI side; "This is a revision" is determined by the tool name and input parameters
 * The `run_id` / `predecessor` is spoken.
 */
function prepareAmendWorkflowApproval(input: unknown): ToolApprovalGate {
  const parsed = AmendWorkflowInputSchema.safeParse(input);
  // Without a script, there is nothing to approve. The two situations share this release:
  //   - Adjust concurrency in place: the purpose of the window is
  //     Put the script to be run in front of people, and do not run any part of the script in this path, but only move a number into `[1, ceiling]`;
  //     **Attribution is irrelevant** - there will be no pop-up window for other people's runs, otherwise a "nothing approval" will be regarded as approval of a new run.
  //   - Someone bypassed the normalization: if it is released to the handler, it will fail to structure and there will be nothing to approve even if the window is opened.
  if (!parsed.success || parsed.data.script === undefined) return { gate: "proceed" };
  const analysis = analyzeScript(parsed.data.script);
  if (!analysis.ok) return { gate: "proceed" };
  const display = displayOfAnalysis(analysis, AMEND_WORKFLOW_TOOL_NAME);
  return { gate: "ask", ...(display ? { display } : {}) };
}

export const amendWorkflowToolEntry: ToolEntry = {
  capability:
    "Revise an existing dynamic-workflow run with a new script: stop it if it is still running, import its finished work, and start the revision in the background",
  metadata: {
    name: AMEND_WORKFLOW_TOOL_NAME,
    description: AMEND_WORKFLOW_TOOL_DESCRIPTION,
    readOnly: false,
    destructive: false,
    concurrentSafe: true,
    timeoutMs: AMEND_WORKFLOW_TIMEOUT_MS,
    maxOutputBytes: AMEND_WORKFLOW_MODEL_BYTES,
    sideEffectScope: "none",
    riskLevel: "low",
    needsApproval: true,
  },
  handler: amendWorkflowHandler,
  // At most one revised script is given, and it is only true for model input parameters (after normalization, if `script` and `path` are present at the same time, it is a legal execution state).
  validateInput: (input) => validateAmendWorkflowSource(input),
  resolveInput: (input, context) => {
    // The skill gate is parsed before the predecessor: the revision with `path` / `script` is writing a script; the call that only changes the setting continues to use the predecessor script and is allowed.
    if (amendWorkflowNeedsSkill(input)) {
      const refused = requireDynamicWorkflowSkill(context, AMEND_WORKFLOW_TOOL_NAME);
      if (refused) return refused;
    }
    return resolveAmendWorkflowInput(input, context);
  },
  prepareApproval: prepareAmendWorkflowApproval,
  inputSchema: AmendWorkflowInputJsonSchema,
  outputSchema: CreateWorkflowOutputJsonSchema,
  runtimeInputSchema: AmendWorkflowInputSchema,
  runtimeOutputSchema: CreateWorkflowOutputSchema,
  formatModelContent: formatAmendWorkflowModelContent,
  permission: {
    permission: "createWorkflow",
    reason: "amendWorkflow.runConfirmation: user must confirm running the revised script",
    riskLevel: "low",
    sideEffectScope: "none",
    needsApproval: true,
    patternSources: ["toolName"],
    alwaysAllowPatternSources: ["toolName"],
    denyPriority: "beforeAsk",
    // The same door as CreateWorkflow (alwaysAsk); this session's own run is served by the owner rule of the permission.
    // always-ask is released in the branch.
    alwaysAsk: true,
    askOptions: { allowAlways: "session" },
  },
  resultBudget: {
    maxInlineBytes: AMEND_WORKFLOW_MODEL_BYTES,
    maxModelBytes: AMEND_WORKFLOW_MODEL_BYTES,
    strategy: "truncate",
    preview: { maxBytes: AMEND_WORKFLOW_MODEL_BYTES, direction: "head" },
  },
  timeout: {
    defaultMs: AMEND_WORKFLOW_TIMEOUT_MS,
    maxMs: AMEND_WORKFLOW_TIMEOUT_MS,
    allowCallOverride: false,
  },
  cancellation: {
    supported: false,
    cleanup: "none",
    userVisibleMessage: "AmendWorkflow typechecks synchronously and cannot be cancelled",
  },
  trace: {
    required: true,
    propagateToAdapters: true,
    recordInput: "summary",
    recordOutput: "summary",
  },
};

function formatAmendWorkflowModelContent(output: unknown): ModelMessageContent {
  const parsed = CreateWorkflowOutputSchema.safeParse(output);
  if (!parsed.success) return "AmendWorkflow returned an invalid result.";
  return parsed.data.response;
}
