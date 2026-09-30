import type { AgentRuntimeInternal } from "../internal.js";
import type { RegularTurnLoopState } from "./turn-loop-state.js";
import { applySubmissionExecutionState, sameModelSelection } from "./turn-model.js";
import { rebuildContextPrefix } from "./context-refresh.js";
import { appendTurnRequestEntries } from "./turn-output-token-continuation.js";
import { applyRuntimeExecutionState } from "../execution-state.js";

/**
 * Consumes at most one guide at a legitimate model-step boundary and prepares the next provider request.
 * SendMessage may arrive while the child's model request is in flight; if that step closes normally
 * as text-only, waiting for a future tool batch would leave the coordinator input permanently in a queue nobody ever wakes.
 */
export async function drainInlineGuideForNextRequest(
  runtime: AgentRuntimeInternal,
  state: RegularTurnLoopState,
): Promise<boolean> {
  const activeTurn = state.activeTurn;
  if (!activeTurn || !runtime.hasInlineGuidePendingInput(activeTurn)) return false;

  const drained = await runtime.drainPendingInput({
    activeTurn,
    events: state.events,
    traceContext: state.turnTraceContext,
  });
  if (!drained || drained.pendingInputIds.length === 0) return false;

  state.drainedSteerForNextRequest = drained;
  appendTurnRequestEntries(state.turnRequestState, drained.runtimeEntries ?? []);
  // The fixed execution model only prohibits mold cutting and should not also discard the Guide's permissions/Plan intentions.
  if (state.modelSelectionScope === "execution" && drained.intent) {
    await applyRuntimeExecutionState(runtime, drained.intent, {
      source: "command",
      traceContext: state.turnTraceContext,
    });
  }
  const guideModel =
    state.modelSelectionScope === "execution"
      ? undefined
      : await applySubmissionExecutionState(runtime, drained?.intent, state.turnTraceContext);
  if (guideModel) {
    // Configuration reparsing is not equivalent to die-cutting; compare the execution selection of the Loop, not the Session which may have been externally updated.
    const selectionChanged = !sameModelSelection(state.model, guideModel);
    state.model = guideModel;
    if (selectionChanged) {
      state.turnRequestState.entries = rebuildContextPrefix(runtime, {
        model: guideModel,
        turnRequestEntries: state.turnRequestState.entries,
      });
    }
  }
  state.currentUserMessageId = drained?.latestMessageId ?? state.currentUserMessageId;
  const nextQueryId = drained?.queryIds?.[0];
  if (nextQueryId) {
    // The guide continues the current active turn with user role; subsequent requests are attributed to the input query.
    state.turnTraceContext = { ...state.turnTraceContext, queryId: nextQueryId };
  }
  if ((drained.toolDisallowlist?.length ?? 0) > 0) {
    // The automation guide will not restart the start turn and must merge the restrictions into the current loop state.
    state.toolDisallowlist = [
      ...new Set([...(state.toolDisallowlist ?? []), ...(drained.toolDisallowlist ?? [])]),
    ];
  }
  state.repeatedToolCallSignature = undefined;
  state.repeatedToolCallStreakCount = 0;
  return true;
}
