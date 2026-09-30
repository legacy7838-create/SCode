import {
  SessionEventType,
  createEventId,
  type SessionEvent,
  type SessionEventStorePort,
  type SessionId,
  type SessionStorePort,
  type TraceId,
} from "@zcode/contracts";

interface PersistAssistantFeedbackInput {
  sessionStore: SessionStorePort;
  eventStore: SessionEventStorePort;
  sessionId: string;
  messageId: string;
  entityId: string;
  feedback: "like" | "dislike" | null;
  traceId: string;
  now?: () => number;
  onPersistedEvent(event: SessionEvent): void;
  onLiveProjectionError?(error: unknown): void;
}

/** The transcript is the authority for feedback persistence; the event only drives the very same write into the live/cold projections. */
export async function persistAssistantFeedback(
  input: PersistAssistantFeedbackInput,
): Promise<void> {
  const sessionId = input.sessionId as SessionId;
  const messages = await input.sessionStore.messages({ sessionID: sessionId });
  const assistant = messages.find((message) => String(message.info.id) === input.messageId);
  if (!assistant || assistant.info.role !== "assistant") {
    throw new Error("proto.staleTarget");
  }
  const metadata = { ...assistant.info.metadata };
  if (input.feedback === null) {
    delete metadata.assistantFeedback;
  } else {
    metadata.assistantFeedback = input.feedback;
  }
  const { metadata: _previousMetadata, ...assistantInfoWithoutMetadata } = assistant.info;
  const nextAssistantInfo = {
    ...assistantInfoWithoutMetadata,
    ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
  };
  await input.sessionStore.saveMessage(nextAssistantInfo);

  const event: SessionEvent = {
    id: createEventId(),
    sessionId,
    type: SessionEventType.AssistantFeedbackUpdated,
    timestamp: new Date((input.now ?? Date.now)()),
    traceId: input.traceId as TraceId,
    sequenceNumber: (await input.eventStore.getLatestSequenceNumber(sessionId)) + 1,
    payload: {
      entityId: input.entityId,
      feedback: input.feedback,
    },
  };
  let persisted: SessionEvent;
  try {
    persisted = await input.eventStore.append(event);
  } catch (error) {
    // When transcript succeeds first and event append fails later, the renderer will roll back with failure ACK.
    // But reopening restores feedback from the half-commit metadata. Failure of append must be compensated back to the original message info.
    try {
      await input.sessionStore.saveMessage(assistant.info);
    } catch (rollbackError) {
      throw new AggregateError(
        [error, rollbackError],
        "assistant feedback event append failed and transcript rollback failed",
      );
    }
    throw error;
  }

  try {
    input.onPersistedEvent(persisted);
  } catch (error) {
    // After the event has been durable, it cannot fail to give ACK to the renderer, otherwise the UI rollback will be contrary to the fact that it is durable;
    // Live projection failure leaves resync/hydration to converge and only takes diagnostic callbacks.
    input.onLiveProjectionError?.(error);
  }
}
