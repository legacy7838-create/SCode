// ── Old protocol compatibility (transition period)─────────────────────────────
// 11 remaining exports: goal iteration/visible message projection function.
// Consumer: zcodeTaskServiceAdapter/zcodeSessionProjection/zcodeTaskIndexSyncer,
// CLI bootstrap session-mapper. textFromZCodeMessageParts has been migrated
// zcode-protocol-legacy-types.ts (survival side). This file has the same life cycle as the old projection stack.
import type { ZCodeSessionGoal } from "./zcode-protocol/index.js";
import { getConversationMessageProjectionPolicy } from "./conversation-message-projection-policy.js";
import {
  type ZCodeMessageWithParts,
  textFromZCodeMessageParts,
} from "./zcode-protocol-legacy-types.js";

const GOAL_CONTINUATION_REMINDER_PREFIX = '<system-reminder source="goal-continuation">';
const GOAL_CONTINUATION_TEXT_MARKER = "Continue working toward the active session goal.";
const GOAL_STATE_TEXT_MARKER = "Current session goal state";
const SUBAGENT_MESSAGE_SOURCE = "subagent_message";

export function isZCodeGoalContinuationReminderText(text: string): boolean {
  const normalized = text.trimStart();
  if (normalized.startsWith(GOAL_CONTINUATION_REMINDER_PREFIX)) {
    return true;
  }
  return (
    normalized.startsWith("<system-reminder>") && normalized.includes(GOAL_CONTINUATION_TEXT_MARKER)
  );
}

export function isZCodeGoalContinuationReminderMessage(message: ZCodeMessageWithParts): boolean {
  return (
    message.info.role === "user" &&
    (message.info.source === "goal-continuation" ||
      String(message.info.metadata?.["source"] ?? "") === "goal-continuation" ||
      isZCodeGoalContinuationReminderText(textFromZCodeMessageParts(message.parts)))
  );
}

export function isZCodeGoalStateReminderText(text: string): boolean {
  const normalized = text.trimStart();
  return normalized.startsWith("<system-reminder>") && normalized.includes(GOAL_STATE_TEXT_MARKER);
}

export function isZCodeGoalModelOnlyReminderMessage(message: ZCodeMessageWithParts): boolean {
  return (
    message.info.role === "user" &&
    (isZCodeGoalContinuationReminderMessage(message) ||
      isZCodeGoalStateReminderText(textFromZCodeMessageParts(message.parts)))
  );
}

export function isZCodeModelOnlySyntheticUserMessage(message: ZCodeMessageWithParts): boolean {
  if (
    message.info.role === "user" &&
    (String(message.info.source ?? "") === SUBAGENT_MESSAGE_SOURCE ||
      String(message.info.metadata?.["source"] ?? "") === SUBAGENT_MESSAGE_SOURCE ||
      message.parts.some(
        (part) =>
          part.type === "text" &&
          String(part.metadata?.["source"] ?? "") === SUBAGENT_MESSAGE_SOURCE,
      ))
  ) {
    return true;
  }
  const policy = getConversationMessageProjectionPolicy(message);
  return policy === "providerContextOnly" || policy === "hiddenSynthetic";
}

export function isZCodeCompactSummaryMessage(message: ZCodeMessageWithParts): boolean {
  return (
    message.info.role === "user" &&
    message.parts.some((part) => {
      if (part.type !== "compaction") {
        return false;
      }
      const timelineStatus = part.metadata?.["timelineStatus"];
      // compact summary user message is the compressed model context, not user-visible input.
      // The lifecycle part that is actually rendered into a timeline will have timelineStatus and will be carried by the assistant message.
      return typeof timelineStatus !== "string";
    })
  );
}

export function getZCodeUserVisibleMessages(
  messages: readonly ZCodeMessageWithParts[],
  _options: { target?: ZCodeSessionGoal | null } = {},
): ZCodeMessageWithParts[] {
  const visibleMessages: ZCodeMessageWithParts[] = [];
  for (const message of messages) {
    if (isZCodeModelOnlySyntheticUserMessage(message) || isZCodeCompactSummaryMessage(message)) {
      // /goal continuation, background tasks, sub-agent, rewind notification and compact summary
      // They are all contexts injected by the runtime into the model to continue reasoning, not the user's real query; visible projections must be filtered.
      // Avoid rendering the user bubble on the right side or occupying the timeline position during snapshot/remote control restoration.
      continue;
    }
    visibleMessages.push(message);
  }
  return visibleMessages;
}

export function getZCodeGoalIterationByAssistantMessageId(
  messages: readonly ZCodeMessageWithParts[],
  options: { maxGoalIteration?: number; target?: ZCodeSessionGoal | null } = {},
): Map<string, number> {
  const target = options.target ?? null;
  if (!target) {
    return new Map();
  }

  const iterationByAssistantId = new Map<string, number>();
  const sortedMessages = [...messages].sort(compareZCodeMessagesByCreatedTime);
  const inactiveAt = target.status === "active" ? null : target.updatedAt;
  let currentIteration = 0;
  let pendingVisibleGoalUserIteration = false;

  for (const message of sortedMessages) {
    if (message.info.role === "user") {
      if (isZCodeGoalContinuationReminderMessage(message)) {
        // The goal continuation boundary only comes from Continue/source=goal-continuation;
        // Current session goal state is a status prompt injected repeatedly in the same round, and the iteration number cannot be advanced here.
        currentIteration += 1;
        pendingVisibleGoalUserIteration = false;
        continue;
      }
      if (isVisibleRealGoalUserMessage(message, target)) {
        // The new protocol persists both visible /goal input and model-only continuations.
        // It can be seen that the input is only used to fill in the first boundary when the old snapshot lacks a continuation, and cannot be superimposed with the continuation to count as two rounds.
        pendingVisibleGoalUserIteration = true;
      }
      continue;
    }

    if (message.info.role !== "assistant") {
      continue;
    }
    if (inactiveAt !== null && message.info.time.created > inactiveAt) {
      // Ordinary questioning after the goal is stopped/completed is still within the same session and cannot continue to inherit the old goal round.
      // Otherwise, when restoring the snapshot, the follow-up reply will be treated as the "Nth iteration" in the history area, and it will look like it is folded by the old completion horizontal line.
      continue;
    }
    if (pendingVisibleGoalUserIteration) {
      currentIteration += 1;
      pendingVisibleGoalUserIteration = false;
    }
    if (currentIteration === 0 && message.info.time.created >= target.createdAt) {
      // The goal creation input in the old session may not have a `/goal` visible bubble or may be earlier than target.createdAt.
      // The assistant after the first goal must still be classified into the first iteration, otherwise the history area will return to normal "worked".
      currentIteration = 1;
    }
    if (currentIteration > 0) {
      // The assistant message bucket is only used for historical status display and cannot advance the goal round to
      // The verifier timeline is the next round that has not yet been confirmed; new sessions converge according to the verifier upper limit after passing in maxGoalIteration.
      const boundedIteration =
        options.maxGoalIteration && options.maxGoalIteration > 0
          ? Math.min(currentIteration, options.maxGoalIteration)
          : currentIteration;
      iterationByAssistantId.set(message.info.messageId, boundedIteration);
    }
  }

  return iterationByAssistantId;
}

export interface ZCodeGoalIterationCountTimelineItem {
  goalIteration?: number;
  status: "started" | "completed" | "failed_closed" | "cancelled";
  verification?: { passed?: boolean | null } | null;
}

export function getZCodeGoalActiveIterationCount(input: {
  targetStatus?: string | null;
  timeline?: readonly ZCodeGoalIterationCountTimelineItem[] | null;
}): number {
  if (!input.targetStatus) {
    return 0;
  }
  const timeline = input.timeline ?? [];
  if (timeline.length === 0) {
    return 1;
  }
  const latest = timeline[timeline.length - 1];
  if (!latest) {
    return 1;
  }
  const latestIteration = latest.goalIteration ?? timeline.length;
  if (latest.status === "started") {
    return latestIteration;
  }
  if (
    (latest.status === "completed" && latest.verification?.passed === true) ||
    input.targetStatus === "complete"
  ) {
    return latestIteration;
  }
  if (input.targetStatus !== "active") {
    // stop will first change the target to paused, and then close the running verifier to canceled.
    // Non-active targets will not automatically continue running, and canceled/failed verifiers cannot be pre-projected into the next round.
    return latestIteration;
  }
  return latestIteration + 1;
}

function compareZCodeMessagesByCreatedTime(
  left: ZCodeMessageWithParts,
  right: ZCodeMessageWithParts,
) {
  const diff = left.info.time.created - right.info.time.created;
  if (diff !== 0) {
    return diff;
  }
  return left.info.messageId.localeCompare(right.info.messageId);
}

function isVisibleRealGoalUserMessage(message: ZCodeMessageWithParts, target: ZCodeSessionGoal) {
  if (
    message.info.role !== "user" ||
    getConversationMessageProjectionPolicy(message) !== "realUserInput"
  ) {
    return false;
  }

  const createdAt = message.info.time.created;
  const nearGoalStart = createdAt >= target.createdAt - 30_000;
  if (!nearGoalStart) {
    return false;
  }

  return true;
}

export function resolveZCodeVisibleSessionTitle(input: {
  title?: string;
  messages: readonly ZCodeMessageWithParts[];
  target?: ZCodeSessionGoal | null;
  fallback?: string;
}): string {
  const normalizedTitle = input.title?.trim() ?? "";
  if (
    normalizedTitle &&
    !isZCodeGoalContinuationReminderText(normalizedTitle) &&
    !isZCodeGoalStateReminderText(normalizedTitle)
  ) {
    return normalizedTitle;
  }

  const firstUser = input.messages.find(
    (message) =>
      message.info.role === "user" &&
      getConversationMessageProjectionPolicy(message) === "realUserInput" &&
      !isZCodeGoalModelOnlyReminderMessage(message),
  );
  const firstUserText = textFromZCodeMessageParts(firstUser?.parts ?? []).trim();
  if (firstUserText) {
    return firstUserText.slice(0, 80);
  }

  const objective = input.target?.objective.trim() ?? "";
  if (objective) {
    return objective.slice(0, 80);
  }

  return input.fallback ?? "New session";
}
