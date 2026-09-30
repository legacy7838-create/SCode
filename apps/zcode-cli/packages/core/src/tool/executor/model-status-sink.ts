import {
  SessionEventType,
  getCurrentModelInvocationContext,
  type Model,
  type ModelNetworkStatusEvent,
  type ModelStatusSink,
} from "@zcode/contracts";
import { withModelInvocationContext } from "../../runtime/methods/runtime-model.js";
import type { ToolExecutionContext } from "../types.js";

/**
 * The default status sink for model requests made inside a tool.
 *
 * `statusSink` cannot be each call site's own responsibility: WebSearch remembers to set one and WebFetch's
 * handler does not.
 * A request without a sink still passes the admission gate and still queues, but the queued / admitted / 429
 * events emitted by the runner have nowhere to go: the executor's deadline does not know it should pause
 * (measured: 18 WebFetch calls waited 20-45 s in the queue and were then cancelled by the 60 s timeout, with
 * `queuedMs: 0` in the error), and the driver cannot see that this subagent is waiting.
 * Handled the same way as the admission port: the default is bound to the **boundary** instead of relying on
 * call sites remembering: the `context.model` the executor hands to the handler is wrapped first, and when the
 * call site set no sink the session event sink is added; if the call site set one itself, it is kept as is.
 */
export function createToolModelStatusSink(
  context: Pick<ToolExecutionContext, "emitEvent" | "sessionId" | "turnId" | "traceId">,
): ModelStatusSink | undefined {
  if (!context.emitEvent) return undefined;

  return {
    publish: async (statusEvent: ModelNetworkStatusEvent) => {
      await context.emitEvent?.({
        id: crypto.randomUUID() as never,
        sessionId: context.sessionId,
        turnId: context.turnId,
        type: SessionEventType.ModelNetworkStatus,
        timestamp: new Date(),
        traceId: context.traceId,
        sequenceNumber: 0,
        payload: statusEvent,
      });
    },
  };
}

/** Adds the default sink when the call site set no `statusSink`; keeps one that was set (the default never overrides the call layer). */
export function withDefaultToolModelStatusSink(
  model: Model | undefined,
  sink: ModelStatusSink | undefined,
): Model | undefined {
  if (model === undefined || sink === undefined) return model;
  return withModelInvocationContext(model, () =>
    getCurrentModelInvocationContext()?.statusSink === undefined ? { statusSink: sink } : {},
  );
}
