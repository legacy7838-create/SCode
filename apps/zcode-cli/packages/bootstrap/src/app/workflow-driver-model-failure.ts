// ============================================================
// AgentRuntime-backed WorkflowDriver: Model-side failed containment
// ============================================================
// workflow-driver.ts reaches the upper limit of oxlint max-lines (400 lines), and corrects the error on the model side when the turn is rejected.
// Containment (strategy statement stop → entire run
// stopped(provider); context_exceeded → node ContextLimit failed; retry / canceled → back off and redrive)
// Split into this file. The free function reads the driver's dependencies and sink, callback runTurn through {@link ModelFailureHost}; private state
// Not exposed. Constants and pure helpers (backoff curve, Retry-After reading, calling) live in workflow-driver-helpers.ts.

import {
  inspectWorkflowModelFailure,
  type WorkflowModelFailureInspection,
} from "@zcode/adapters/model";
import {
  refToString,
  WorkflowError,
  type InstanceRef,
  type ProviderStopDetails,
  type WorkflowReportSink,
} from "@zcode/dynamic-workflow";
import {
  PROVIDER_STOP_RAW_MESSAGE_MAX_CHARS,
  TRANSIENT_CONTINUE_PROMPT,
  defaultSchedule,
  readRetryAfterMs,
  subagentLabel,
  transientBackoffMs,
} from "./workflow-driver-helpers.js";
import type { AgentRuntimeWorkflowDriverDeps, SessionState } from "./workflow-driver-types.js";

/** The host surface the driver hands to the containment logic: dependencies, sink, whether it is already disposed, and starting one more turn on the same session. */
export interface ModelFailureHost {
  readonly deps: Pick<AgentRuntimeWorkflowDriverDeps, "clock" | "logger" | "runId">;
  readonly sink: WorkflowReportSink;
  isDisposed(): boolean;
  runTurn(state: SessionState, instance: InstanceRef, input: string, epilogueStart: number): void;
}

/**
 * Model-side containment when a turn is rejected: the driver and the runner read the same policy table. Returning `false` means this is not a model-layer error
 * (the inspection returned undefined) and the caller treats it as a driver-side failure; returning `true` means it has already been handled per policy.
 */
export function handleModelTurnFailure(
  host: ModelFailureHost,
  state: SessionState,
  instance: InstanceRef,
  error: unknown,
): boolean {
  const inspected = inspectWorkflowModelFailure(error);
  if (inspected === undefined) return false;
  switch (inspected.policy.decision) {
    case "stop":
      // Deterministic model-side error: The entire run is stopped (stopped(provider), recoverable), and the node is not settled.
      host.sink.stopRun(providerStopError(state, inspected, error));
      return true;
    case "context_exceeded":
      // Core has failed to compress: the ask itself is too large, it is the fault of the script - the node failed with ContextLimit, the script can catch.
      host.sink.askFailed(
        instance,
        new WorkflowError(
          "ContextLimit",
          `Subagent ${subagentLabel(state)} exceeded the model's context window even after ` +
            `compaction. Give this ask a smaller input or split the work across subagents.`,
          { cause: error },
        ),
      );
      return true;
    default:
      // retry/cancelled: Transient failure released by the runner (stream recovery exhaustion, etc.)——
      // It is the same curve as the runner's retreat. After waiting and starting again, only cancel can end it.
      scheduleTransientRedrive(host, state, instance, inspected, error);
      return true;
  }
}

/**
 * Driver-side redrive of a transient failure: a per-ask counter, 2s→60s jittered backoff (Retry-After takes priority), report an
 * `askWaiting(backoff)` first and only then wait, honour cancellation while waiting, and then issue one continuation turn
 * on the same persistent runtime (the same mechanism as a nudge). No upper bound — the run-level stall clock is what tells people it is waiting.
 */
function scheduleTransientRedrive(
  host: ModelFailureHost,
  state: SessionState,
  instance: InstanceRef,
  inspected: WorkflowModelFailureInspection,
  error: unknown,
): void {
  state.transientAttempts += 1;
  const attempt = state.transientAttempts;
  const retryAfterMs = readRetryAfterMs(error);
  const delayMs = retryAfterMs ?? transientBackoffMs(attempt, host.deps.clock?.random);
  host.sink.askWaiting(instance, {
    cause: "backoff",
    reason: inspected.reason,
    attempt,
    delayMs,
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
  });
  host.deps.logger?.warn?.("Dynamic workflow subagent turn failed transiently; redriving", {
    attempt,
    delayMs,
    event: "dynamic_workflow.ask.transient_redrive",
    instance: refToString(instance),
    module: "bootstrap.app",
    reason: inspected.reason,
    runId: host.deps.runId ?? "run",
  });
  const schedule = host.deps.clock?.schedule ?? defaultSchedule;
  state.cancelRedrive?.();
  state.cancelRedrive = schedule(() => {
    state.cancelRedrive = undefined;
    // During the waiting period, ask was canceled/settled/substituted: there are no listeners in this round of continuation.
    if (
      host.isDisposed() ||
      state.cancelled ||
      state.accepted ||
      state.abortController?.signal.aborted === true ||
      state.currentInstance === undefined ||
      refToString(state.currentInstance) !== refToString(instance)
    ) {
      return;
    }
    host.runTurn(state, instance, TRANSIENT_CONTINUE_PROMPT, 0);
  }, delayMs);
}

/** A `ProviderStop` error: a model-side error the policy table classifies as a stop + the structured details the notification copy needs. */
function providerStopError(
  state: SessionState,
  inspected: WorkflowModelFailureInspection,
  cause: unknown,
): WorkflowError {
  const kind = inspected.policy.decision === "stop" ? inspected.policy.kind : "other";
  const rawMessage = (
    inspected.rawMessage ?? (cause instanceof Error ? cause.message : String(cause))
  ).slice(0, PROVIDER_STOP_RAW_MESSAGE_MAX_CHARS);
  const details: ProviderStopDetails = {
    kind,
    reason: inspected.reason,
    subagent: refToString(state.actor),
    ...(state.actorName === undefined ? {} : { subagentName: state.actorName }),
    ...(inspected.providerId === undefined ? {} : { providerId: inspected.providerId }),
    ...(inspected.modelId === undefined ? {} : { modelId: inspected.modelId }),
    ...(inspected.providerCode === undefined ? {} : { providerCode: inspected.providerCode }),
    ...(rawMessage.length === 0 ? {} : { rawMessage }),
    ...(inspected.resetAt === undefined ? {} : { resetAt: inspected.resetAt }),
  };
  const code = inspected.providerCode === undefined ? "" : ` [${inspected.providerCode}]`;
  return new WorkflowError(
    "ProviderStop",
    `Subagent ${subagentLabel(state)} hit a permanent model-side error ` +
      `(${inspected.reason}${code}): ${rawMessage}`,
    { cause, providerStop: details },
  );
}
