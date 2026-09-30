export const MAX_PROMPT_HISTORY = 30;

type PromptHistoryDirection = "up" | "down";

interface PromptHistoryNavigationResult {
  nextIndex: number | null;
  nextValue: string;
  shouldHandle: boolean;
}

export function appendPromptHistoryEntry(
  entries: readonly string[],
  entry: string,
  limit = MAX_PROMPT_HISTORY,
): string[] {
  const trimmed = entry.trim();
  if (!trimmed) {
    return [...entries];
  }

  // Previously, each submission would be appended directly. Continuously sending the same prompt would cause the up key to hit the same item repeatedly.
  // Only the last item after trim is compared here to avoid accidentally deleting non-consecutive repeated histories such as A, B, and A.
  if (entries.at(-1)?.trim() === trimmed) {
    return [...entries];
  }

  const normalizedLimit = Math.max(1, Math.trunc(limit));
  return [...entries, trimmed].slice(-normalizedLimit);
}

export function navigatePromptHistory(
  entries: readonly string[],
  currentIndex: number | null,
  direction: PromptHistoryDirection,
): PromptHistoryNavigationResult {
  if (entries.length === 0) {
    return {
      nextIndex: currentIndex,
      nextValue: "",
      shouldHandle: false,
    };
  }

  if (direction === "up") {
    const nextIndex = currentIndex === null ? entries.length - 1 : Math.max(currentIndex - 1, 0);
    return {
      nextIndex,
      nextValue: entries[nextIndex] ?? "",
      shouldHandle: true,
    };
  }

  if (currentIndex === null) {
    const nextIndex = entries.length - 1;
    return {
      nextIndex,
      nextValue: entries[nextIndex] ?? "",
      shouldHandle: true,
    };
  }

  if (currentIndex >= entries.length - 1) {
    return {
      nextIndex: null,
      nextValue: "",
      shouldHandle: true,
    };
  }

  const nextIndex = currentIndex + 1;
  return {
    nextIndex,
    nextValue: entries[nextIndex] ?? "",
    shouldHandle: true,
  };
}
