import {
  SessionEventType,
  type UserInputAutoResolutionUpdatedPayload,
  type TraceContext,
} from "../deps.js";
import type { AgentRuntimeInternal } from "../internal.js";

/**
 * Record the auto-resolution phase of an AskUserQuestion. The event must travel the runtime's durable
 * append/sink chain, so that both desktop continuous and web remote replayable recover the same absolute times.
 */
export async function recordUserInputAutoResolutionUpdate(
  this: AgentRuntimeInternal,
  input: UserInputAutoResolutionUpdatedPayload & { traceContext?: TraceContext },
): Promise<void> {
  const traceContext = input.traceContext ?? this.rootTraceContext;
  await this.appendEvent(
    this.createEvent(
      SessionEventType.UserInputAutoResolutionUpdated,
      {
        interactionId: input.interactionId,
        toolCallId: input.toolCallId,
        autoResolution: input.autoResolution,
      } satisfies UserInputAutoResolutionUpdatedPayload,
      traceContext,
    ),
    traceContext,
  );
}
