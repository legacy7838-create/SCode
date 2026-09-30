import { randomUUID } from "node:crypto";
import {
  AMEND_WORKFLOW_TOOL_NAME,
  boundWorkflowLaunchMeta,
  createWorkflowPhaseAlongside,
  createWorkflowPhaseNames,
  type DynamicWorkflowRunRetuneResult,
  type TraceContext,
  type WorkflowSettingsAmendMeta,
} from "@zcode/contracts";
import {
  resolveAmendMaxConcurrency,
  resolveAmendSubagentModelChoice,
} from "../../tool/handlers/amend-workflow-resolve.js";
import { resolveKeptScriptFile } from "../../tool/handlers/amend-workflow-source.js";
import { parseWorkflowSubagentModel } from "../../tool/handlers/model-reference.js";
import {
  boundGraphOfAnalysis,
  displayOfAnalysis,
} from "../../tool/handlers/workflow-analysis-display.js";
import {
  resolveWorkflowDraftName,
  writeWorkflowDraft,
} from "../../tool/handlers/workflow-drafts.js";
import { analyzeScript } from "../../tool/handlers/workflow-script-analysis.js";
import type { ExecutableToolCall } from "../../tool/types.js";
import { traceContextToLogContext } from "../deps.js";
import type { AgentRuntimeInternal } from "../internal.js";
import { boundedCompileDiagnostics } from "./dynamic-workflow-run-start.js";
import {
  buildSettingsMessageText,
  enqueueSettingsTurn,
  fromTo,
  runSettingsOfSnapshot,
  type RunSettings,
} from "./dynamic-workflow-run-settings-turn.js";

export { buildSettingsMessageText } from "./dynamic-workflow-run-settings-turn.js";

/**
 * The GUI's "configure" request. The two settings guard the tool's three states:
 * omitted = inherit, `null` = back to the default (session model / machine limit), a value = set it.
 */
export interface AmendWorkflowRunSettingsInput {
  runId: string;
  subagentModel?: string | null;
  maxConcurrency?: number | null;
  traceContext?: TraceContext;
}

/** The rejection vocabulary is verbatim identical to shared's `workflowRunSettingsRejectionReasonSchema`. */
export type AmendWorkflowRunSettingsRejection =
  | "not_found"
  | "not_configurable"
  | "unchanged"
  | "script_missing"
  | "model_unavailable"
  | "compile_failed"
  | "missing_boundaries"
  | "start_failed";

export type AmendWorkflowRunSettingsResult =
  | { ok: true; runId: string; toolCallId: string; supersededRunId?: string }
  | { ok: false; reason: AmendWorkflowRunSettingsRejection; message?: string };

/**
 * The GUI's "configure": it revises a run with the same script and new settings.
 *
 * It is the **second caller** of `port.amend` and `port.retuneConcurrency`, isomorphic to the `AmendWorkflow` tool: the
 * same three-state normalization (`resolveAmendSubagentModelChoice` / `resolveAmendMaxConcurrency`, not copied), the
 * same route, the same compilation, the same background tracker (synthesizing an AmendWorkflow descriptor). The only
 * differences: no model turn, no confirmation window (the user clicking "Apply" in the popover is the consent, and
 * the script is the one he already approved), the arguments are inherited from the predecessor
 * (`inheritArgs`), and a queued controlOnly "settings turn" records the fact into the session.
 *
 * When only concurrency changes and the run is still in flight, it takes effect **in place** at the fork below: the
 * same runId, no stop, no successor minted.
 *
 * The order is fixed: every step failing before `port.amend` / `port.retuneConcurrency` has zero side effects — the old
 * run keeps running, there is no new row and no message.
 */
export async function amendWorkflowRunSettings(
  this: AgentRuntimeInternal,
  input: AmendWorkflowRunSettingsInput,
): Promise<AmendWorkflowRunSettingsResult> {
  const traceContext = input.traceContext ?? this.rootTraceContext;
  const port = this.dynamicWorkflowRunPort;
  if (port === undefined || typeof port.amend !== "function") {
    // The capability is only registered when the port has amend and getScript; the lack of it here is due to a wiring fault rather than user input.
    return { ok: false, reason: "start_failed", message: "dynamic workflow amend unavailable" };
  }

  // (1) This run must exist and belong to this session - whichever session the command is sent to, you can only change that session's own run.
  const snapshot = await port.getTask(input.runId);
  if (snapshot === undefined || snapshot.parentSessionId !== this.sessionId) {
    return { ok: false, reason: "not_found" };
  }
  // (2) Each ask of the completed run will be replayed from the cache, and the new settings will not take effect; the replaced run will be its successor.
  if (snapshot.runStatus === "completed" || snapshot.supersededBy !== undefined) {
    return { ok: false, reason: "not_configurable" };
  }
  // (3)(4) The three-state normalization of the two settings is the same code as the tool.
  const current = runSettingsOfSnapshot(snapshot);
  const model = resolveAmendSubagentModelChoice(
    input.subagentModel,
    current.subagentModel,
    this.modelCatalogPort,
  );
  if (!model.ok) {
    // The sentence when the directory is absent is written to the model ("omit subagent_model"), and the GUI only needs the reason code; when there is a directory
    // Parsing diagnostics (candidate names, etc.) is also useful for people, just go with the message.
    return {
      ok: false,
      reason: "model_unavailable",
      ...(this.modelCatalogPort === undefined ? {} : { message: model.message }),
    };
  }
  const ceiling = port.concurrencyCeiling?.();
  const bound = resolveAmendMaxConcurrency(input.maxConcurrency, current.maxConcurrency, ceiling);
  // A bound that is equal to the ceiling means "it has no bounds of its own": the snapshot only has maxConcurrency when it is lower than the ceiling, and the pronunciation is the same on both sides.
  // The "unchanged" comparison is only valid (the elastic layer also sends null when the stepper is pushed to the top, which covers the caller who directly gives the number).
  const nextBound =
    bound.max_concurrency === undefined || bound.max_concurrency === ceiling
      ? undefined
      : bound.max_concurrency;
  const next: RunSettings = {
    ...(model.canonical === undefined ? {} : { subagentModel: model.canonical }),
    ...(nextBound === undefined ? {} : { maxConcurrency: nextBound }),
  };
  // (5) If nothing has changed, you can’t afford a new run: One revision will stop the running run, and there is no reason to pay this price for zero changes.
  const modelChanged = next.subagentModel !== current.subagentModel;
  const boundChanged = next.maxConcurrency !== current.maxConcurrency;
  if (!modelChanged && !boundChanged) return { ok: false, reason: "unchanged" };

  // (6) Fork: only the concurrency has changed and the run is flying again, in place
  // Effective - same runId, no stopping, no successor casting, no cache import. port answer not_live (settled, or pending but engine
  // It hasn’t been built yet) Just follow this list and complete today’s revision.
  if (boundChanged && !modelChanged && typeof port.retuneConcurrency === "function") {
    // The `null` of the elastic layer is passed to the port as it is: only the port knows the number of the ceiling, so I won’t guess it a second time. Absence can only come from
    // "The inheritance boundary is higher than the ceiling of the local machine" (run was started on a larger machine), and what was wanted at that time was to get back to the ceiling.
    const answer = await port.retuneConcurrency({
      runId: input.runId,
      maxConcurrency: input.maxConcurrency ?? null,
    });
    if (answer.ok) {
      return retunedSettings.call(this, {
        answer,
        name: displayNameOfSnapshot(snapshot),
        runId: input.runId,
        traceContext,
      });
    }
    if (answer.reason === "unchanged") return { ok: false, reason: "unchanged" };
  }

  // (7) Inherited script (the same reading path as "Keeping the predecessor's script"). Read after forking **: in-place tuning
  // The same script is still run concurrently. A run that does not have an archived script or the script cannot be compiled can still be adjusted to the upper bound.
  const script =
    typeof port.getScript === "function" ? await port.getScript(input.runId) : undefined;
  if (script === undefined || script.length === 0) {
    return { ok: false, reason: "script_missing" };
  }

  // (8) Compile. The saved script may have been written on an earlier facade; if you can't edit it, it will stop here, and the old run will not move.
  const analysis = analyzeScript(script);
  if (!analysis.ok || analysis.diagnostics.length > 0) {
    return {
      ok: false,
      reason: "compile_failed",
      message: boundedCompileDiagnostics(
        `The stored script of run ${input.runId} has errors:`,
        analysis.diagnostics,
      ),
    };
  }

  // ——Zero side effects so far. ——

  // The new run script file follows the same rules as when the tool inherits the script.
  // The same piece of code: If the predecessor script file still has this byte, continue to remember it, otherwise write a new draft as a "script not from the file".
  // If you don't remember, the only way to revise this run after the model is to inline the entire script and copy it again. The draft was my best effort: I couldn’t write it.
  // In case of absence, run will continue as usual. It was the only release before amend, leaving at best a draft document that no one cited.
  const graph = boundGraphOfAnalysis(analysis);
  const keptFile = await resolveKeptScriptFile({
    cwd: this.workingDirectory,
    scriptPath: snapshot.scriptPath,
    script,
  });
  const scriptPath =
    keptFile?.path ??
    (
      await writeWorkflowDraft({
        cwd: this.workingDirectory,
        name: resolveWorkflowDraftName(snapshot.name, graph),
        source: script,
      })
    )?.path;

  // (8) Revision. The `settings-` prefix allows logs and cards to distinguish it from model tool calls (`tool_*`) and hub launches (`launch-`).
  const toolCallId = `settings-${randomUUID()}`;
  const phaseNames = createWorkflowPhaseNames(graph);
  const phaseAlongside = phaseNames === undefined ? undefined : createWorkflowPhaseAlongside(graph);
  const subagentModel = parseWorkflowSubagentModel(next.subagentModel);
  let amended: Awaited<ReturnType<NonNullable<typeof port.amend>>>;
  try {
    amended = await port.amend({
      scriptText: script,
      cwd: this.workingDirectory,
      predecessorRunId: input.runId,
      parentSessionId: this.sessionId,
      toolCallId,
      ...(phaseNames === undefined ? {} : { phaseNames }),
      ...(phaseAlongside === undefined ? {} : { phaseAlongside }),
      ...(next.maxConcurrency === undefined ? {} : { maxConcurrency: next.maxConcurrency }),
      ...(subagentModel === undefined ? {} : { subagentModel }),
      ...(scriptPath === undefined ? {} : { scriptPath }),
      // What is re-run is the precursor's own script, which reads the actual parameters when the precursor is started.
      inheritArgs: true,
      trace: traceContext,
    });
  } catch (error) {
    return {
      ok: false,
      reason: "start_failed",
      message: error instanceof Error ? error.message : String(error),
    };
  }
  if (!amended.ok) {
    return {
      ok: false,
      reason: amended.reason === "run_not_found" ? "not_found" : "missing_boundaries",
    };
  }

  // Only use the run's own name: unnamed runs do not have names, and cards, side panels, and notifications follow the rules of any unnamed run and use the underwords instead.
  // Here it is basically `run <id>`, and the setting wheel card and side panel title become a string of run ids.
  // And this pseudonym is passed down the revision chain.
  const name = displayNameOfSnapshot(snapshot);
  const amend: WorkflowSettingsAmendMeta = {
    predecessorRunId: input.runId,
    ...(modelChanged ? { subagentModel: fromTo(current.subagentModel, next.subagentModel) } : {}),
    ...(boundChanged
      ? { maxConcurrency: fromTo(current.maxConcurrency, next.maxConcurrency) }
      : {}),
    ...(ceiling === undefined ? {} : { ceiling }),
  };

  // (9)(10) Subsequent failures will only be logged and not rolled back: the new run is already flying and can be stopped on the side panel; withdrawing it will create orphans.
  try {
    // Background tracking: Synthesize an AmendWorkflow descriptor to go through the same registration of the executor (registry, final state waiter,
    // settlement notice). `input.name` feeds the notification topic, the tool name to assign to "workflow".
    const toolCall: ExecutableToolCall = {
      id: toolCallId,
      name: AMEND_WORKFLOW_TOOL_NAME,
      input: { run_id: input.runId, ...(name === undefined ? {} : { name }) },
    };
    await this.executor.trackExternalBackgroundTask(
      toolCall,
      { backgroundTaskId: amended.runId, status: "backgrounded" },
      traceContext,
      undefined,
    );
    enqueueSettingsTurn.call(this, {
      text: buildSettingsMessageText({
        ...(name === undefined ? {} : { name }),
        previous: input.runId,
        runId: amended.runId,
        superseded: amended.supersededRunId !== undefined,
        amend,
      }),
      meta: boundWorkflowLaunchMeta({
        runId: amended.runId,
        toolCallId,
        ...(name === undefined ? {} : { name }),
        ...(() => {
          const display = displayOfAnalysis(analysis);
          return display?.kind === "create_workflow" ? { display } : {};
        })(),
        amend,
      }),
      // The session must be logged out at this point (it has run in its name), and the title seed will not be used; just give it an honest value.
      titleInput: name ?? input.runId,
      traceContext,
    });
  } catch (error) {
    this.logger?.error(
      "Workflow settings amended but post-amend bookkeeping failed",
      error instanceof Error ? error : new Error(String(error)),
      {
        ...traceContextToLogContext(traceContext),
        event: "dynamic_workflow.settings.post_amend_failed",
        module: "core.runtime",
        runId: amended.runId,
        toolCallId,
      },
    );
  }

  return {
    ok: true,
    runId: amended.runId,
    toolCallId,
    ...(amended.supersededRunId === undefined ? {} : { supersededRunId: amended.supersededRunId }),
  };
}

/**
 * The tail end of the in-place effect: the same runId, no
 * `supersededRunId`, and **no second background task registered** — this run is already in the tracker, and
 * registering it again would clear the settlement surface of a run that never stopped, under AmendWorkflow's
 * rearm rule.
 *
 * The settings turn is recorded as usual, but the `amend` block carries no `predecessorRunId`: absent means
 * "in place", and the renderer uses that to draw only one line instead of a whole run card (two cards for one
 * run would read as two runs). There is no `display` either — this path never compiles one.
 */
function retunedSettings(
  this: AgentRuntimeInternal,
  options: {
    answer: Extract<DynamicWorkflowRunRetuneResult, { ok: true }>;
    name: string | undefined;
    runId: string;
    traceContext: TraceContext;
  },
): AmendWorkflowRunSettingsResult {
  const { answer, name, runId, traceContext } = options;
  const toolCallId = `settings-${randomUUID()}`;
  // The end equal to the ceiling is the "default", so the entire end is absent - the same reading as the revised road (the elastic layer pushes the stepper to the top
  // What is sent is `null`, but what is returned by the port is always an absolute value, and the conversion can only be done here).
  const amend: WorkflowSettingsAmendMeta = {
    maxConcurrency: fromTo(
      answer.previous === answer.ceiling ? undefined : answer.previous,
      answer.maxConcurrency === answer.ceiling ? undefined : answer.maxConcurrency,
    ),
    ceiling: answer.ceiling,
  };
  try {
    enqueueSettingsTurn.call(this, {
      text: buildSettingsMessageText({
        ...(name === undefined ? {} : { name }),
        previous: runId,
        runId,
        superseded: false,
        amend,
      }),
      meta: boundWorkflowLaunchMeta({
        runId,
        toolCallId,
        ...(name === undefined ? {} : { name }),
        amend,
      }),
      titleInput: name ?? runId,
      traceContext,
    });
  } catch (error) {
    // After recording the log, leave: the upper bound has taken effect. Rolling back a record cannot replace it. Undoing this adjustment is not what the user wants.
    this.logger?.error(
      "Workflow run retuned but the settings turn could not be queued",
      error instanceof Error ? error : new Error(String(error)),
      {
        ...traceContextToLogContext(traceContext),
        event: "dynamic_workflow.settings.post_retune_failed",
        module: "core.runtime",
        runId,
        toolCallId,
      },
    );
  }
  return { ok: true, runId, toolCallId };
}

/** The run's own name (absent when it has none): both the settings turn and the synthesized tracking use exactly this, and never take the run id as a title. */
function displayNameOfSnapshot(snapshot: { name?: string }): string | undefined {
  const trimmed = snapshot.name?.trim();
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
}
