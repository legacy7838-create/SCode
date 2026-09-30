import { isDeepStrictEqual } from "node:util";
import type { JsonObject, OpenAiMessage } from "./types.js";

export function isAppendOnly(
  previous: readonly OpenAiMessage[],
  next: readonly OpenAiMessage[],
): boolean {
  if (next.length < previous.length) return false;
  return previous.every(
    (message, index) =>
      isTrajectoryMessageEqual(message, next[index]) ||
      (index === previous.length - 1 && isUserContentAppend(message, next[index])),
  );
}

function isUserContentAppend(previous: OpenAiMessage, next: OpenAiMessage): boolean {
  if (previous.role !== "user" || next.role !== "user") return false;
  const { content: before, ...previousFields } = previous;
  const { content: after, ...nextFields } = next;
  if (!Array.isArray(before) || !Array.isArray(after) || after.length <= before.length)
    return false;
  // Merging adjacent users will extend the last message; only appends that leave the old block unchanged will be accepted, and historical rewrites cannot be obscured.
  return (
    isTrajectoryMessageEqual(previousFields, nextFields) &&
    isDeepStrictEqual(removeCacheControl(before), removeCacheControl(after.slice(0, before.length)))
  );
}

export function isTrajectoryMessageEqual(previous: OpenAiMessage, next: OpenAiMessage): boolean {
  // Anthropic cache tags drift; only ignored when comparing, the output retains the original value of the latest request.
  return isDeepStrictEqual(removeCacheControl(previous), removeCacheControl(next));
}

function removeCacheControl(value: unknown): unknown {
  if (!value || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(removeCacheControl);
  const result: JsonObject = {};
  for (const [key, nestedValue] of Object.entries(value)) {
    if (key !== "cache_control") result[key] = removeCacheControl(nestedValue);
  }
  return result;
}
