import type { ZCodePersistedMessage, ZCodePersistedMessagePart } from "./zcode-task-types-core.js";

// ZCode runtime converts each round of LLM calls in the same user turn into independent assistant messages (each with time.created/completed).
// The old task projection model only has one assistant for each turn, and the UI is also designed according to this model (one assistant → one "Worked for X seconds" block).
// Here, the adjacent assistants after mapping are merged back into one, and the invariant of "one turn, one assistant" is restored;
// The old projection data itself is strictly alternating and is a no-op for it.
//
// By the way, explicitly assign the value of turnIndex according to the user count and remove the hood of `toTaskChatMessages`
// `Math.floor(index / 2)` Minor bug of miscalculation when using multiple assistants.
export function coalesceConsecutiveZCodeAssistants(
  messages: readonly ZCodePersistedMessage[],
): ZCodePersistedMessage[] {
  const merged: ZCodePersistedMessage[] = [];
  for (const message of messages) {
    const last = merged[merged.length - 1];
    // Although the role of synthetic timeline such as compact/fork/goal verifier is assistant,
    // But they are message boundaries, not the same round of text; participating in the merge will swallow the horizontal line and count the maintenance time into the previous reply.
    if (
      message.role === "assistant" &&
      last?.role === "assistant" &&
      !last.syntheticTimeline &&
      !message.syntheticTimeline &&
      last.goalIteration === message.goalIteration
    ) {
      merged[merged.length - 1] = mergeAssistantPair(last, message);
      continue;
    }
    merged.push(message);
  }

  let turn = -1;
  return merged.map((message) => {
    if (message.role === "user") {
      turn += 1;
    }
    const effectiveTurn = turn < 0 ? 0 : turn;
    return message.turnIndex === effectiveTurn ? message : { ...message, turnIndex: effectiveTurn };
  });
}

function mergeAssistantPair(
  first: ZCodePersistedMessage,
  next: ZCodePersistedMessage,
): ZCodePersistedMessage {
  const firstTools = first.tools ?? [];
  const nextTools = next.tools ?? [];
  const mergedTools =
    firstTools.length + nextTools.length > 0 ? [...firstTools, ...nextTools] : undefined;

  const toolIndexOffset = firstTools.length;
  const firstParts = first.parts ?? [];
  const shiftedNextParts: ZCodePersistedMessagePart[] = (next.parts ?? []).map((part) =>
    part.type === "tool-call"
      ? { type: "tool-call", toolIndex: part.toolIndex + toolIndexOffset }
      : part,
  );
  const mergedParts =
    firstParts.length + shiftedNextParts.length > 0
      ? [...firstParts, ...shiftedNextParts]
      : undefined;

  const mergedContent = first.content + next.content;
  const mergedThought =
    first.thought === undefined && next.thought === undefined
      ? undefined
      : (first.thought ?? "") + (next.thought ?? "");

  // If any round has not completed time, it is considered that the entire turn has not ended; leave the duration blank to let the UI display "Working".
  const durationMs =
    first.durationMs === undefined || next.durationMs === undefined
      ? undefined
      : Math.max(next.timestamp + next.durationMs - first.timestamp, 0);

  const characterCount =
    first.characterCount === undefined && next.characterCount === undefined
      ? undefined
      : mergedContent.length;
  const mergedMessageIds = collectMergedMessageIds(first, next);

  return {
    ...first,
    content: mergedContent,
    timestamp: first.timestamp,
    model: next.model ?? first.model,
    durationMs,
    characterCount,
    interrupted: next.interrupted ?? first.interrupted,
    feedback: next.feedback ?? first.feedback,
    mergedMessageIds: mergedMessageIds.length > 0 ? mergedMessageIds : undefined,
    goalIteration: next.goalIteration ?? first.goalIteration,
    attachments: next.attachments ?? first.attachments,
    tools: mergedTools,
    thought: mergedThought,
    parts: mergedParts,
    checkpointState: next.checkpointState ?? first.checkpointState,
    checkpointReason: next.checkpointReason ?? first.checkpointReason,
    checkpointUpdatedAt: next.checkpointUpdatedAt ?? first.checkpointUpdatedAt,
    bodyRefs: next.bodyRefs ?? first.bodyRefs,
    toolSlice: next.toolSlice ?? first.toolSlice,
  };
}

function collectMergedMessageIds(
  first: ZCodePersistedMessage,
  next: ZCodePersistedMessage,
): string[] {
  const ids = [
    first.id,
    ...(first.mergedMessageIds ?? []),
    next.id,
    ...(next.mergedMessageIds ?? []),
  ].filter((id): id is string => Boolean(id));
  return [...new Set(ids)];
}
