import { randomUUID } from "node:crypto";
import {
  CREATE_WORKFLOW_TOOL_NAME,
  boundWorkflowLaunchMeta,
  createWorkflowPhaseAlongside,
  createWorkflowPhaseNames,
  type SavedWorkflowScope,
  type TraceContext,
} from "@zcode/contracts";
import type { CompileDiagnostic } from "@zcode/dynamic-workflow";
import {
  resolveSavedWorkflow,
  validateWorkflowArgs,
} from "../../tool/handlers/saved-workflows/index.js";
import {
  boundGraphOfAnalysis,
  displayOfAnalysis,
} from "../../tool/handlers/workflow-analysis-display.js";
import { writeWorkflowDraft } from "../../tool/handlers/workflow-drafts.js";
import { analyzeScript } from "../../tool/handlers/workflow-script-analysis.js";
import type { ExecutableToolCall } from "../../tool/types.js";
import { uuidv7 } from "@zcode/shared";
import { createMessageId, traceContextToLogContext } from "../deps.js";
import type { AgentRuntimeInternal } from "../internal.js";
import { emitControlOnlyUserTurn, persistWorkflowLaunchUserMessage } from "./control-only-turn.js";

/**
 * The structured result of `startSavedWorkflowRun`. On success it gives the run's two correlation keys
 * (`runId` ≡ backgroundTaskId ≡ the workId of cancelBackgroundWork; `toolCallId` links the tool card
 * → the details page); on failure it goes through the `reason` discriminant key (house rule: flow
 * decisions are made on error codes rather than on text), and `message` carries the human-readable
 * cause for inline display in the GUI.
 */
export type StartSavedWorkflowRunResult =
  | { ok: true; runId: string; toolCallId: string }
  | {
      ok: false;
      reason:
        | "invalid_name"
        | "not_found"
        | "invalid_args"
        | "compile_failed"
        | "session_busy"
        | "start_failed";
      message?: string;
    };

/** The bound on merged compile diagnostics (≈2KB): the diagnostics travel over the protocol in the ACK's `message`, and an overlong stack has no reading value. */
const COMPILE_DIAGNOSTICS_MAX_CHARS = 2_000;

/**
 * The hub directly starting an already-saved workflow.
 *
 * It is the **second caller** of `port.submit` and is isomorphic to the `CreateWorkflow` tool path: the
 * same saved normalization (`resolveSavedWorkflow` + `validateWorkflowArgs`, not copied), the same
 * background tracker (`trackExternalBackgroundTask` fed a synthetic CreateWorkflow descriptor), and
 * the run it produces is indistinguishable to notification / cancellation / resume / the details side
 * panel. The differences are only these: it does not go through `ToolExecutor.execute` (bypassing the
 * permission decision + `alwaysAsk` — which is the entire point of this feature, the user's click in
 * the hub IS the consent), and a controlOnly "starting turn" records the user's real action in the
 * session (the model only hears about this run when completion / a question notification arrives).
 *
 * The order is fixed, and a failure at ①② happens **before any persistence** (no run, no message, no
 * event, no task); a failure after ④ is only logged and not rolled back (the run is already in flight
 * and can be cancelled from the side panel), and ok is still returned.
 */
export async function startSavedWorkflowRun(
  this: AgentRuntimeInternal,
  input: {
    name: string;
    scope?: SavedWorkflowScope;
    args?: Record<string, unknown>;
    traceContext?: TraceContext;
  },
): Promise<StartSavedWorkflowRunResult> {
  const traceContext = input.traceContext ?? this.rootTraceContext;

  // (0) Busy session rejected. This method is only meaningful for newly created empty sessions; queuing the startup into the queue of the active turn requires controlOnly
  // Coordination with provider grammar (future work of "join current session"). The GUI only sends it to empty sessions, so it is not triggered normally.
  if (this.hasActiveOrQueuedTurnWork()) {
    return { ok: false, reason: "session_busy" };
  }

  const cwd = this.workingDirectory;

  // (1) Parsing + actual parameter verification: reuse the same normalization section of create-workflow-source (the second caller, no copying).
  const found = resolveSavedWorkflow({ cwd, name: input.name, scope: input.scope });
  if (!found.ok) {
    if (found.reason === "invalid_name") {
      return {
        ok: false,
        reason: "invalid_name",
        message: `'${input.name}' is not a usable workflow name: ${found.detail}`,
      };
    }
    if (found.reason === "not_found") {
      return {
        ok: false,
        reason: "not_found",
        message:
          input.scope === undefined
            ? `No saved workflow named '${input.name}' in this project or globally.`
            : `No ${input.scope} workflow named '${input.name}'.`,
      };
    }
    // parse_error/read_error: The file exists but is broken. For GUI and "not found" is the same next step (this name cannot run
    // up), return to not_found; but the message clearly states that it is a file problem rather than a name problem, so that the user can repair the file instead of changing the name.
    return {
      ok: false,
      reason: "not_found",
      message: `The saved workflow '${input.name}' at ${found.path} could not be read: ${found.detail}`,
    };
  }

  const validated = validateWorkflowArgs(found.meta.args, input.args);
  if (!validated.ok) {
    return {
      ok: false,
      reason: "invalid_args",
      message: [
        `The arguments for saved workflow '${found.name}' are not valid:`,
        ...validated.errors.map((error) => `- ${error}`),
      ].join("\n"),
    };
  }

  // (2) Compile. Any diagnosis is rejected - the same principle as CreateWorkflow's handling of unscriptable (playing a doomed to fail)
  // run just delays the same error). Diagnosis into message, bounded.
  const analysis = analyzeScript(found.script);
  if (!analysis.ok || analysis.diagnostics.length > 0) {
    return {
      ok: false,
      reason: "compile_failed",
      message: boundedCompileDiagnostics(
        `The saved workflow '${found.name}' has errors:`,
        analysis.diagnostics,
      ),
    };
  }

  // ——Zero side effects so far: no runs, no messages, no events, no tasks. ——

  const port = this.dynamicWorkflowRunPort;
  if (port === undefined) {
    // Absent port (stub/single test host): GUI access capability does not support the interface. Deliberately not downgrading to "pretending to be activated".
    return { ok: false, reason: "start_failed", message: "dynamic workflow port unavailable" };
  }

  // Initialize the context and persist the parent session before submitting. actor's session_task_link passes
  // parent_session_id refers to the parent session; when the parent row does not exist, the creation of the first actor fails due to foreign key constraints.
  // The parent session starts with the workflow name as the input title, and subsequent startup rounds will be reused idempotently. Submission fails when received by the GUI
  // After rejected ACK, the empty session is recycled through deleteSession.
  await this.ensureContextInitialized(traceContext);
  await this.ensureSessionPersisted(found.name, traceContext);

  // (3) toolCallId: `launch-` prefix, logs and tool cards can be distinguished from the model tool call id (`tool_*`) and resume heavy arm.
  const toolCallId = `launch-${randomUUID()}`;
  const hasArgs = Object.keys(validated.args).length > 0;
  // Launch anchor: launch directly without user wheel, cast a UUID v7 and act as
  // run's `run-launched.inputId` and the inputId of the controlOnly launch wheel below - launch wheel run card and subagent
  // agent_step therefore hangs under the same message.
  const launchInputId = uuidv7();
  // The submitted declaration stage table reading and the startup wheel display have the same "Analysis Result → Bounded Display Map" projection (the stage comes from the control flow layer,
  // There are no stages if only the cause and effect diagram is passed), and then the same createWorkflowPhaseNames - the same script draws the same sidebar track on both roads.
  const launchGraph = boundGraphOfAnalysis(analysis);
  const phaseNames = createWorkflowPhaseNames(launchGraph);
  // The index of the "running at the same time" table points to `phaseNames`, so it must come from the same image and the same projection.
  const phaseAlongside =
    phaseNames === undefined ? undefined : createWorkflowPhaseAlongside(launchGraph);

  // (3b) Working copy. The direct startup of the hub is the same thing as the saved source of `CreateWorkflow`, so the copy also follows the same procedure.
  // The rules are written: byte by byte (metadata block together), the saved definition itself does not change a word. If you can't write it, there will be no `scriptPath` - run as usual.
  // It's just that there is no editable file to point to in the final notification.
  const draft = await writeWorkflowDraft({ cwd, name: found.name, source: found.source });

  // (4) Commit to start. Submission failures (rejection/error) exit before starting the round - never result in success with runId.
  let runId: string;
  try {
    const submitted = await port.submit({
      scriptText: found.script,
      cwd,
      name: found.name,
      ...(hasArgs ? { args: validated.args } : {}),
      parentSessionId: this.sessionId,
      toolCallId,
      launchInputId,
      ...(phaseNames === undefined ? {} : { phaseNames }),
      ...(phaseAlongside === undefined ? {} : { phaseAlongside }),
      ...(draft === undefined ? {} : { scriptPath: draft.path }),
      trace: traceContext,
    });
    runId = submitted.runId;
  } catch (error) {
    return { ok: false, reason: "start_failed", message: describeError(error) };
  }

  const launchText = buildLaunchMessageText(found.name, found.scope, runId, validated.args);
  // Pictures and scripts follow the startup wheel: run details side panel and wheel tail run card press toolCallId to find the "initiation line" and get display.causalityGraph
  // With input.script, there is no tool line for direct startup, and the same display and script are attached to the startup metadata.
  // (Otherwise, the run side panel started directly will have no picture or script). display follows the same path as CreateWorkflow "Analysis results → Display graph"
  // Projection, three layers (site/stage/sub-agent card) are present together - the actual parameters were manually spelled here and only the cause and effect diagram was transmitted.
  // The figure has sites but no stages and sub-agent cards, so the side panels are left with only an empty ridge line.
  const display = displayOfAnalysis(analysis);
  const meta = boundWorkflowLaunchMeta({
    runId,
    toolCallId,
    name: found.name,
    scope: found.scope,
    path: found.path,
    ...(hasArgs ? { args: validated.args } : {}),
    description: found.meta.description,
    ...(display?.kind === "create_workflow" ? { display } : {}),
    script: found.script,
  });

  // ④ Subsequent failures are only logged and not rolled back: the run is already in flight and can be canceled on the side panel; withdrawing it will create an orphan run without ownership.
  try {
    // (5) Launch wheel: user visible message (synthetic + workflowLaunch metadata) + history + controlOnly turn
    // Boundary; session title = workflow name (ensureSessionPersisted enters the title starting with name).
    const messageId = createMessageId();
    await emitControlOnlyUserTurn.call(this, {
      messageId,
      titleInput: found.name,
      historyText: launchText,
      turnInput: launchText,
      traceContext,
      inputId: launchInputId,
      inputSource: "workflow_launch",
      workflowLaunch: meta,
      persistMessage: () =>
        persistWorkflowLaunchUserMessage.call(this, {
          messageID: messageId,
          text: launchText,
          meta,
          traceContext,
        }),
    });

    // (6) Background tracking: synthesize a CreateWorkflow descriptor and run the same trackBackgroundTask of the executor
    // (runtime-task registry registration = session recycling guardrail, BackgroundTaskStarted, final state waiter, settlement notification).
    // `input.name` feeds the notification subject (workflowTaskSubject), `name: CreateWorkflow` allows per-tool lifecycle
    // Assigned to "workflow" - complete notification/cancel/revert/details side panel with zero changes.
    const toolCall: ExecutableToolCall = {
      id: toolCallId,
      name: CREATE_WORKFLOW_TOOL_NAME,
      input: {
        name: found.name,
        saved: {
          name: found.name,
          scope: found.scope,
          ...(hasArgs ? { args: validated.args } : {}),
        },
      },
    };
    await this.executor.trackExternalBackgroundTask(
      toolCall,
      { backgroundTaskId: runId, status: "backgrounded" },
      traceContext,
      undefined,
    );
  } catch (error) {
    this.logger?.error(
      "Saved workflow launched but post-submit bookkeeping failed",
      error instanceof Error ? error : new Error(String(error)),
      {
        ...traceContextToLogContext(traceContext),
        event: "dynamic_workflow.launch.post_submit_failed",
        module: "core.runtime",
        runId,
        toolCallId,
      },
    );
  }

  return { ok: true, runId, toolCallId };
}

/**
 * The model-facing canonical sentence of the starting turn (English, not localized — it enters the
 * provider transcript and is what the model reads on its next turn).
 * When there are arguments, they are attached as a JSON block; the closing sentence unconditionally
 * discourages a repeated start (the run is already in flight and its progress comes back as a
 * notification).
 */
function buildLaunchMessageText(
  name: string,
  scope: SavedWorkflowScope,
  runId: string,
  args: Record<string, unknown>,
): string {
  const lines = [
    `Started the saved workflow "${name}" (${scope}) from the workflows hub as run ${runId}.`,
  ];
  if (Object.keys(args).length > 0) {
    lines.push("", "Arguments:", "```json", JSON.stringify(args, null, 2), "```");
  }
  lines.push("", "Progress and results arrive as background notifications; do not start it again.");
  return lines.join("\n");
}

/**
 * Merge the compile diagnostics into one bounded piece of text (one `L{line}:C{column} {message}` per
 * entry). It is shared by the hub's start and the GUI's "Configure":
 * both hand the diagnostics to the GUI's bounded monospace block through the ACK's `message`.
 */
export function boundedCompileDiagnostics(
  heading: string,
  diagnostics: readonly CompileDiagnostic[],
): string {
  const body = [
    heading,
    ...diagnostics.map(
      (diagnostic) => `L${diagnostic.line}:C${diagnostic.column} ${diagnostic.message}`,
    ),
  ].join("\n");
  return body.length > COMPILE_DIAGNOSTICS_MAX_CHARS
    ? `${body.slice(0, COMPILE_DIAGNOSTICS_MAX_CHARS - 1)}…`
    : body;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
