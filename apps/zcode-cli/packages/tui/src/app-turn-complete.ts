// Turn_complete processing: usage/cache statistics + results summary.
//
// The two things are put together because they have the same origin as one event; by the way, let the switch of app-events.ts stay within max-lines.
import type React from "react";
import type { ModelUsageSummary } from "@zcode/contracts";
import type { CacheStats, Message } from "./app-model.js";
import { cacheStatsFromPayload, usageFromPayload } from "./app-event-data.js";
import { projectedTranscriptHasResponse } from "./app-transcript-stream.js";
import { stringField } from "./state.js";

/**
 * turn_complete carries the authoritative `response`; it is only filled in when the transcript does
 * **not** yet have that text.
 *
 * Why it is needed: a notification-driven turn has no submitPrompt, and therefore no applyResult to
 * append the result with. In the vast majority of cases the streaming events have already painted the
 * text, but a turn with only tool calls, or one whose stream broke with an error midway, leaves not a
 * single word behind — and then this backstop is the only source of the answer.
 *
 * Why it never double-writes: the criterion is the **content**, not the timing.
 * `projectedTranscriptHasResponse` already exists on the very same guard in appendAgentResult, so
 * whichever side fills it in first, the other one sees that the content is already there and skips —
 * the same idea as deduplicating by event id (idempotent by content/identity, never betting on who
 * wins the race).
 *
 * This symmetry does have one premise: the guard only scans the `streamProjected` messages, so the
 * message filled in here must **carry `streamProjected: true` itself** — otherwise, in the user-turn
 * case where "the stream broke but turn_complete carries a response", this would first add an
 * ordinary message, after which the guard in applyResult would not see it and would add a second
 * one, and the same answer would appear twice. `transcriptText` falls back to `content` for a message
 * with no parts, so no parts have to be synthesized.
 */
export function applyTurnCompleteFallbackResponse(
  payload: Record<string, unknown>,
  setMessages: React.Dispatch<React.SetStateAction<Message[]>>,
): void {
  const response = stringField(payload, "response");
  if (!response || response.trim().length === 0) return;
  setMessages((current) =>
    projectedTranscriptHasResponse(current, response)
      ? current
      : [...current, { content: response, role: "agent", streamProjected: true }],
  );
}

export function applyTurnCompleteEvent(
  payload: Record<string, unknown>,
  setUsage: React.Dispatch<React.SetStateAction<ModelUsageSummary | undefined>>,
  setCacheStats: React.Dispatch<React.SetStateAction<CacheStats | undefined>>,
): void {
  const turnUsage = usageFromPayload(payload);
  if (turnUsage) setUsage(turnUsage);

  const cacheStats = cacheStatsFromPayload(payload);
  if (cacheStats) setCacheStats(cacheStats);
}
