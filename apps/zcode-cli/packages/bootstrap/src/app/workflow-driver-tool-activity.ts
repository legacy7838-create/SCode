// ============================================================
// Observation of tool activity on the driver side: The subagent is about to rewrite the workspace → engine off import cache
// ============================================================
// The same attitude as the active side of the model in workflow-driver-concurrency.ts: read-only session event flow of the actor runtime, without touching the turn
// Arrangement. Only one event is recognized here - `ToolCallStarted`, which is issued by the executor after the permission is determined and before the handler takes action. On the payload
// With `readOnly` / `sideEffectScope` after parsing the input parameters (Bash's read-only command judgment has been settled). Determine using contracts
// `isWorkspaceMutatingToolCall`; The same subload also counts the number of calls that "touched the external world" by `isWorldTouchingToolCall`.
// That number determines whether a cache entry is pure (see below).
//
// The same subscription is also responsible for the number of tool calls for this ask (the total number of writes in it), since AskStats requires it, and
// There are no tool events in `TurnResult.events` - according to the number, `toolCalls` is always 0 (actual measurement: 2097 events in the production journal
// ask line without exception, including subagents who explicitly wrote the file). The count is reset to zero at startAsk and accumulated across repair / nudge rounds,
// So the last askStats report is the full amount of this ask.
//
// The two counting divisions are different: `toolCalls` counts all calls (auditing is honest), `worldToolCalls` only counts those that have viewed or moved the external world
// ——Protocol tools (`submit_result`, `escalate`) do not count, otherwise each typed ask will appear to have "touched the world" because of the result.
// None of the pure ask exemptions are used.
//
// Each ask is only reported once to close the door: the engine side door is idempotent, reporting less times will only save event traffic; reset when changing ask.
//
// The same subscription also notes the name of the most recent tool call and a bounded target thread (the `lastTool` of `node-progress`). The name is on `ToolCallStarted`, but the input parameter is not——
// It is only on the earlier `ToolCallScheduled`, so subscribe to both here: scheduled. Save the input parameters by toolCallId.
// started Take it back, compress it into a clue, and then delete that move. Only drop `lastTool` on started, at the same time as both counts,
// So a call that is denied permission and never actually runs won't pretend to be "what it's doing".

import {
  isWorkspaceMutatingToolCall,
  isWorldTouchingToolCall,
  SessionEventType,
  type SessionEvent,
  type SessionId,
  type ToolCallScheduledPayload,
  type ToolCallStartedPayload,
} from "@zcode/contracts";
import type { AgentRuntime } from "@zcode/core";
import type { AskLastTool } from "@zcode/dynamic-workflow";
import { summarizeToolCall } from "./workflow-driver-tool-target.js";

/**
 * At most this many pending scheduled argument sets are kept waiting to be claimed. Normally each one is claimed by the started event that follows it immediately, but calls that
 * were denied by permissions, cancelled, or skipped as a whole batch are not — without a cap, one long ask can accumulate them into a memory leak.
 * On overflow the oldest one is dropped (the Map is iterated in insertion order): the newer call is the answer to "what is it doing right now".
 */
const MAX_PENDING_SCHEDULED_CALLS = 64;

/** The tool call counts observed within one ask (the two fields of `AskStats` are exactly this). */
export interface ActorToolCounts {
  /** All calls, including protocol tools such as `submit_result` / `escalate`. */
  toolCalls: number;
  /** The subset that looked at or touched the outside world (read files, ran commands, reached the network); 0 means this ask is pure. */
  worldToolCalls: number;
}

interface ActorToolActivity {
  /** Reset when switching asks: the counting starts over, and the first write of the next ask has to be reported again. */
  reset(): void;
  /** The tool call counts observed so far in this ask. */
  counts(): ActorToolCounts;
  /**
   * The number of tool calls **still running** right now (started minus result / error, deduplicated by toolCallId, so four WebSearch calls
   * issued in parallel within one turn count as 4).
   *
   * The only reader is the seat gate (workflow-seat-gate.ts): an admission call carries only `{model}`, which cannot tell whether a model request
   * is this subagent's next turn step or one issued from inside one of its tools, and **tool-side requests never linger**. If a tool is
   * running it is tool-side, if there is none at all it is the next turn step. Use started/finished pairing rather than "what was the last event":
   * under parallel calls the latter would already misjudge it as idle the moment the first tool returns.
   */
  inFlight(): number;
  /** The **most recent** tool call of this ask that actually started running; absent if there has never been one. */
  lastTool(): AskLastTool | undefined;
  /** Subscribes to the runtime's `ToolCallStarted` session event; a no-op when the minimal stub runtime has no subscribeEvents. */
  observe(runtime: AgentRuntime, sessionId: SessionId): void;
  unsubscribe(): void;
}

export function createActorToolActivity(handlers: {
  /** The subagent of the current ask is about to run a tool that rewrites the workspace (at most once per ask). */
  onMutating(): void;
}): ActorToolActivity {
  let reported = false;
  let toolCalls = 0;
  let worldToolCalls = 0;
  let lastTool: AskLastTool | undefined;
  /** toolCallId → the name and arguments as of scheduled time, waiting for started to claim it. */
  const scheduled = new Map<string, ToolCallSummaryHold>();
  /** The toolCallIds that have started and are still waiting for a result / error (see {@link ActorToolActivity.inFlight}). */
  const running = new Set<string>();
  let unsubscribeEvents: (() => void) | undefined;
  return {
    reset: () => {
      reported = false;
      toolCalls = 0;
      worldToolCalls = 0;
      lastTool = undefined;
      scheduled.clear();
      // There should not be any tools running on the ask boundary (the turn of the previous ask has already landed or been aborted), and zeroing is just not allowed.
      // An abnormal path carries residue into the next ask - that would cause the gate to always treat it as a tool-side request.
      running.clear();
    },
    counts: () => ({ toolCalls, worldToolCalls }),
    inFlight: () => running.size,
    lastTool: () => lastTool,
    observe: (runtime, sessionId) => {
      if (typeof (runtime as Partial<AgentRuntime>).subscribeEvents !== "function") return;
      unsubscribeEvents = runtime.subscribeEvents({
        onSessionEvent: (event: SessionEvent) => {
          if (event.sessionId !== sessionId) return;
          if (event.type === SessionEventType.ToolCallScheduled) {
            holdScheduled(scheduled, event.payload as ToolCallScheduledPayload);
            return;
          }
          // The end of a call: the executor sends one message to each of the two try/catch blocks after started, so started must have a match.
          // (Permission denial, schema failure, and registry miss all occur before started **, only errors are sent, and pairing is not affected).
          if (
            event.type === SessionEventType.ToolCallResult ||
            event.type === SessionEventType.ToolCallError
          ) {
            running.delete(String((event.payload as { toolCallId: unknown }).toolCallId));
            return;
          }
          if (event.type !== SessionEventType.ToolCallStarted) return;
          const capability = event.payload as ToolCallStartedPayload;
          running.add(String(capability.toolCallId));
          const hold = scheduled.get(String(capability.toolCallId));
          scheduled.delete(String(capability.toolCallId));
          lastTool =
            summarizeToolCall({
              ...(hold === undefined ? {} : { input: hold.input }),
              toolName: capability.toolName ?? hold?.toolName,
            }) ?? lastTool;
          toolCalls++;
          if (isWorldTouchingToolCall(capability)) worldToolCalls++;
          if (!isWorkspaceMutatingToolCall(capability)) return;
          if (reported) return;
          reported = true;
          handlers.onMutating();
        },
      });
    },
    unsubscribe: () => {
      unsubscribeEvents?.();
      unsubscribeEvents = undefined;
    },
  };
}

/** One set (name + arguments) parked on a scheduled event, waiting for the matching started to take it. */
interface ToolCallSummaryHold {
  toolName?: string;
  input?: unknown;
}

/** Parks one set of scheduled arguments and keeps the table within {@link MAX_PENDING_SCHEDULED_CALLS} (dropping the oldest). */
function holdScheduled(
  scheduled: Map<string, ToolCallSummaryHold>,
  payload: ToolCallScheduledPayload,
): void {
  scheduled.set(String(payload.toolCallId), { toolName: payload.toolName, input: payload.input });
  while (scheduled.size > MAX_PENDING_SCHEDULED_CALLS) {
    const oldest = scheduled.keys().next();
    if (oldest.done === true) return;
    scheduled.delete(oldest.value);
  }
}
