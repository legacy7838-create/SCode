import { MAX_PROMPT_HISTORY } from "@/lib/promptHistory.js";

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const PROMPT_HISTORY_STORAGE_KEY_PREFIX = "zcode-chat-prompt-history:";

function getBrowserStorage(): StorageLike | null {
  if (typeof window === "undefined") {
    return null;
  }

  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function getPromptHistoryStorageKey(workspacePath: string) {
  return `${PROMPT_HISTORY_STORAGE_KEY_PREFIX}${workspacePath}`;
}

function normalizePromptHistoryEntries(entries: readonly unknown[]): string[] {
  return entries
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .slice(-MAX_PROMPT_HISTORY);
}

export function readPromptHistoryEntries(
  workspacePath: string,
  storage: StorageLike | null = getBrowserStorage(),
): string[] {
  const rawValue = storage?.getItem(getPromptHistoryStorageKey(workspacePath));
  if (!rawValue) {
    return [];
  }

  try {
    const parsed = JSON.parse(rawValue);
    if (!Array.isArray(parsed)) {
      return [];
    }

    return normalizePromptHistoryEntries(parsed);
  } catch {
    return [];
  }
}

export function persistPromptHistoryEntries(
  workspacePath: string,
  entries: readonly string[],
  storage: StorageLike | null = getBrowserStorage(),
) {
  const normalizedEntries = normalizePromptHistoryEntries(entries);

  // Previously, the chat input history was only stored in the ChatView memory. After refreshing the page or restarting the window, the entire chat input history will be lost.
  // The user cannot get the message they just sent even if they press the key. Here it is changed to write to localStorage according to workspace.
  // It not only retains the history after reopening, but also avoids stringing together the prompt word history between different projects.
  storage?.setItem(getPromptHistoryStorageKey(workspacePath), JSON.stringify(normalizedEntries));
}
