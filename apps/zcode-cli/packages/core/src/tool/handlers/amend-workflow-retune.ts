// AmendWorkflow: Only changes in concurrency will take effect locally.
// When called with only `run_id` and `max_concurrency`, and the predecessor is still running, the run ID, subagent, transcription and outstanding ask are preserved.
// This module is responsible for routing determination, port calling and result explanation; if run is settled between determination and calling, the predecessor facts are re-read,
// Then decide whether to allow a fallback to the revision process.

import {
  AmendWorkflowInputSchema,
  isAmendWorkflowOwnedPredecessor,
  type AmendWorkflowInput,
  type AmendWorkflowPredecessor,
  type CreateWorkflowOutput,
  type DynamicWorkflowRunPort,
  type DynamicWorkflowRunRetuneResult,
} from "@zcode/contracts";
import type { ToolExecutionContext, ToolHandlerFailure } from "../types.js";
import {
  AMEND_WORKFLOW_ERROR_CODE,
  describePredecessor,
  resolveAmendMaxConcurrency,
  resolveAmendScript,
} from "./amend-workflow-source.js";
import { clampWorkflowMaxConcurrency } from "./create-workflow-source.js";
import { workflowRunNotFoundFailure } from "./workflow-run-introspection.js";

/**
 * "Nothing changed except concurrency": what is judged is the **shape of the input**, not the new fields.
 * `script`, `path`, `subagent_model` and `name`, whatever they carry, send this call down the amend path — each of them
 * could change what is about to run, and that path's premise is "the same script and the same set of subagents are running as before".
 *
 * The same holds for the normalized input: the amend path always lands on a script, so "no script but a concurrency
 * setting" can only be an in-place concurrency change.
 */
export function isConcurrencyOnlyAmend(model: AmendWorkflowInput): boolean {
  return (
    model.max_concurrency !== undefined &&
    model.script === undefined &&
    model.path === undefined &&
    model.subagent_model === undefined &&
    model.name === undefined
  );
}

/**
 * The routing decision in resolveInput. On a hit it returns **script-free** normalized input — from then on
 * prepareApproval lets it through and the handler calls `retuneConcurrency`; on a miss it returns `undefined`, and the caller proceeds with the amend as usual.
 *
 * All three premises are required: the input shape only changes concurrency, the predecessor is still alive (both `pending`
 * and `running` are tried; whether it is alive is for the port to say), and the port can carry this control surface. When the
 * port has no `retuneConcurrency` (an old host) the entire path does not exist, and the call lands as today's amend as-is — including the confirmation window for someone else's run.
 */
export function resolveConcurrencyRetuneRoute(options: {
  model: AmendWorkflowInput;
  port: DynamicWorkflowRunPort;
  predecessor: AmendWorkflowPredecessor;
  /** The bound on the predecessor snapshot; absent means it runs at the ceiling. */
  inherited: number | undefined;
}): { result: true; input: AmendWorkflowInput } | ToolHandlerFailure | undefined {
  const { model, port, predecessor } = options;
  if (!isConcurrencyOnlyAmend(model)) return undefined;
  if (predecessor.status !== "pending" && predecessor.status !== "running") return undefined;
  if (typeof port.retuneConcurrency !== "function") return undefined;

  // Three states are **not** normalized here: `null` is passed to the port unchanged (see the comment on resolveAmendMaxConcurrency).
  const requested = model.max_concurrency ?? null;
  const ceiling = port.concurrencyCeiling?.();
  const unchanged = refuseUnchangedBound(model.run_id, requested, options.inherited, ceiling);
  if (unchanged !== undefined) return unchanged;
  return {
    result: true,
    input: { run_id: model.run_id, max_concurrency: requested, predecessor },
  };
}

/**
 * The "same value" closes out here — earlier than hooks, earlier than the confirmation window, without the port ever being
 * touched. When the ceiling cannot be read (an old host without `concurrencyCeiling`) `null` cannot be converted into a number, so this net steps aside and the port itself answers `unchanged`.
 */
function refuseUnchangedBound(
  runId: string,
  requested: number | null,
  inherited: number | undefined,
  ceiling: number | undefined,
): ToolHandlerFailure | undefined {
  const current = inherited ?? ceiling;
  const next = requested === null ? ceiling : clampWorkflowMaxConcurrency(requested, ceiling);
  if (current === undefined || next === undefined || current !== next) return undefined;
  return retuneUnchangedFailure(runId, current, ceiling);
}

/**
 * The handler-side body: call the port and turn the three kinds of reply into a model-facing result.
 *
 * Returning `undefined` has exactly one meaning — the port answered `not_live` (or the host has no such control surface at
 * all), and at this moment this call describes an amend; whether to proceed is decided by {@link resolveRetuneFallbackAmend}.
 */
export async function runConcurrencyRetune(
  parsed: AmendWorkflowInput,
  context: ToolExecutionContext,
): Promise<CreateWorkflowOutput | ToolHandlerFailure | undefined> {
  const port = context.dynamicWorkflowRunPort;
  if (port === undefined || typeof port.retuneConcurrency !== "function") return undefined;
  const answer = await port.retuneConcurrency({
    runId: parsed.run_id,
    // The routing decision already guarantees that this is "a number or null"; `?? null` just reads the absence of bypassing normalization as "back to the ceiling".
    maxConcurrency: parsed.max_concurrency ?? null,
  });
  if (answer.ok) {
    return {
      diagnostics: [],
      ok: true,
      // Do not enter the background tracker: the run is already in it, and it is the same run from beginning to end, without `backgrounded`
      // There is no contract to speak of, and there is no compiled product to draw. `retuned` is **explicit**
      // Judgment block: The consumer should not press "ok and no status" to guess, there are other sources of that shape.
      response: retuneResponse(parsed.run_id, answer),
      retuned: {
        runId: parsed.run_id,
        maxConcurrency: answer.maxConcurrency,
        previous: answer.previous,
        ceiling: answer.ceiling,
      },
    } satisfies CreateWorkflowOutput;
  }
  if (answer.reason === "unchanged") {
    return retuneUnchangedFailure(parsed.run_id, answer.current, port.concurrencyCeiling?.());
  }
  return undefined;
}

/**
 * Settlement race: at this moment the same input describes an amend. Whether it can be done depends on exactly one thing —
 * **whether that amend should have opened a window in the first place**.
 *
 * This session's own run, not stopped by the user: the owner rule would not open a window anyway, so amend as usual, with the
 * script and the compilation deferred to this moment (a missing script or a compile failure are reported as that amend's own
 * rejection). Someone else's run, or a run the user stopped: reject. This path has never popped a single window, so "nothing was approved" must not be stretched into "start another run".
 */
export async function resolveRetuneFallbackAmend(
  parsed: AmendWorkflowInput,
  context: ToolExecutionContext,
): Promise<{ result: true; input: AmendWorkflowInput } | ToolHandlerFailure> {
  const port = context.dynamicWorkflowRunPort;
  // The facts need to be read again: run has just settled between the survival determination and the port call, and the part in the parameter still says "running".
  const snapshot = port === undefined ? undefined : await port.getTask(parsed.run_id);
  if (snapshot === undefined) return predecessorNotFoundFailure(parsed.run_id);
  const predecessor = describePredecessor(snapshot, context.sessionId);
  if (!isAmendWorkflowOwnedPredecessor(predecessor)) {
    // Not yet settled (pending, the engine has not been built) and settled are two different words, but the next step is the same: adjust it again.
    return predecessor.status === "pending" || predecessor.status === "running"
      ? notRetunableFailure(parsed.run_id)
      : runSettledFailure(parsed.run_id);
  }
  const script = await resolveAmendScript({
    model: parsed,
    cwd: context.workingDirectory,
    port,
    predecessorScriptPath: snapshot.scriptPath,
  });
  if (!script.result) return script;
  return {
    result: true,
    input: AmendWorkflowInputSchema.parse({
      run_id: parsed.run_id,
      ...script.fields,
      // Falling back to revision returns to "a number or nothing": the value is explicitly given in this call, and there is nothing to inherit.
      ...resolveAmendMaxConcurrency(
        parsed.max_concurrency,
        undefined,
        port?.concurrencyCeiling?.(),
      ),
      predecessor: {
        ...predecessor,
        ...(script.inherited ? { script_inherited: true as const } : {}),
      },
    }) as AmendWorkflowInput,
  };
}

/** The predecessor does not exist: same source and same wording as the resolveInput case (a mistyped run id should get only one phrasing). */
function predecessorNotFoundFailure(runId: string): ToolHandlerFailure {
  const base = workflowRunNotFoundFailure(runId);
  return {
    ...base,
    message: `${base.message} Nothing was stopped or created: \`run_id\` pointed at a run that does not exist — pass an existing run's ID (see ListWorkflowRuns), or start a fresh run with CreateWorkflow.`,
  };
}

/** The bound now in effect as a sentence; equal to the ceiling means "no bound of its own". */
function describeBoundInForce(bound: number | undefined, ceiling: number | undefined): string {
  if (bound === undefined || bound === ceiling) {
    return "has no limit on how many subagents run at once (it runs at this machine's maximum)";
  }
  return bound === 1
    ? "already runs at most 1 subagent at once"
    : `already runs at most ${bound} subagents at once`;
}

/** Same value: nothing was written, nothing was stopped, and the rejection names the bound in effect right now. */
export function retuneUnchangedFailure(
  runId: string,
  current: number | undefined,
  ceiling: number | undefined,
): ToolHandlerFailure {
  return {
    result: false,
    errorCode: AMEND_WORKFLOW_ERROR_CODE.RETUNE_UNCHANGED,
    message: `workflow_retune_unchanged: run ${runId} ${describeBoundInForce(current, ceiling)}, so there is nothing to change. Nothing was stopped, created or changed — pass a different \`max_concurrency\`, or a revised script if you meant to amend the run.`,
  };
}

/** Someone else's run, already settled: changing it once more means that call goes through the amend path from the start, together with the confirmation window it wanted. */
export function runSettledFailure(runId: string): ToolHandlerFailure {
  return {
    result: false,
    errorCode: AMEND_WORKFLOW_ERROR_CODE.RUN_SETTLED,
    message: `workflow_run_settled: run ${runId} settled before the new parallelism limit could take hold, so there is nothing running to retune. Nothing was stopped, created or changed — call AmendWorkflow again if you want a new run of it under that limit.`,
  };
}

/** Someone else's run that this agent never held (`pending`, the engine has not created it yet): the same next step. */
export function notRetunableFailure(runId: string): ToolHandlerFailure {
  return {
    result: false,
    errorCode: AMEND_WORKFLOW_ERROR_CODE.NOT_RETUNABLE,
    message: `workflow_run_not_retunable: run ${runId} is not being executed by this agent, so its parallelism cannot be changed in place. Nothing was stopped, created or changed — call AmendWorkflow again if you want a new run of it under that limit.`,
  };
}

/**
 * The model-facing reply: **names a run, has no successor** — this is precisely how the model tells which path its call took,
 * without being told the routing itself. When the bound equals the ceiling it says "the limit was lifted" instead of
 * reporting a number, drawing the same line as `CreateWorkflow`.
 *
 * ⚠ This text is the **only** thing that survives v4: this path has no display payload (the `retuned` block only lives
 * in-process; the protocol's `toolOutputSchema` carries only text / display / truncated), and the tool card draws it as a whole
 * row. So it must be self-contained — name the run, name the current bound, state that there is no new run — and it must be stable: changing a word is changing the UI.
 */
function retuneResponse(
  runId: string,
  answer: Extract<DynamicWorkflowRunRetuneResult, { ok: true }>,
): string {
  const bound =
    answer.maxConcurrency === answer.ceiling
      ? "the limit on how many subagents run at once is removed (this machine's maximum applies)"
      : answer.maxConcurrency === 1
        ? "at most 1 subagent runs at once"
        : `at most ${answer.maxConcurrency} subagents run at once`;
  return `Applied to the running run ${runId}; ${bound}. Run ${runId} keeps running under it: nothing was stopped and no new run was started.`;
}
