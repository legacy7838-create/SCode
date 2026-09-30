import {
  extractActivePromptInputTrigger,
  type ActivePromptInputTrigger,
} from "@/lib/promptInputTriggers.js";

interface PromptInputTextSelectionSnapshot {
  cursorOffset: number;
  nodeKey: string;
  text: string;
  textBeforeCursor: string;
}

export interface ActivePromptInputTokenSnapshot extends ActivePromptInputTrigger {
  nodeKey: string;
  tokenEnd: number;
  tokenStart: number;
  tokenText: string;
}

function isCaretInsideToken(
  snapshot: ActivePromptInputTokenSnapshot,
  cursorOffset: number,
): boolean {
  return cursorOffset >= snapshot.tokenStart + 1 && cursorOffset <= snapshot.tokenEnd;
}

function createActivePromptInputTokenSnapshot(
  selection: PromptInputTextSelectionSnapshot,
): ActivePromptInputTokenSnapshot | null {
  const activeTrigger = extractActivePromptInputTrigger(selection.textBeforeCursor);
  if (!activeTrigger) {
    return null;
  }

  const tokenStart = selection.cursorOffset - activeTrigger.query.length - 1;
  const tokenEnd = selection.cursorOffset;
  return {
    ...activeTrigger,
    nodeKey: selection.nodeKey,
    tokenEnd,
    tokenStart,
    tokenText: selection.text.slice(tokenStart, tokenEnd),
  };
}

export function reconcileActivePromptInputTokenSnapshot(
  previous: ActivePromptInputTokenSnapshot | null,
  selection: PromptInputTextSelectionSnapshot,
  selectionOnly: boolean,
): ActivePromptInputTokenSnapshot | null {
  if (!selectionOnly || !previous) {
    return createActivePromptInputTokenSnapshot(selection);
  }

  if (previous.nodeKey !== selection.nodeKey) {
    return null;
  }

  const currentTokenText = selection.text.slice(previous.tokenStart, previous.tokenEnd);
  if (currentTokenText !== previous.tokenText) {
    return createActivePromptInputTokenSnapshot(selection);
  }

  if (!isCaretInsideToken(previous, selection.cursorOffset)) {
    return null;
  }

  // ArrowLeft/ArrowRight only changes the selection, the token text does not change.
  // If the query is still recalculated based on the cursor prefix, candidates will be repeatedly filtered, selectedIndex will be reset, and the virtual list will be rebuilt.
  return previous;
}

export function getActivePromptInputTokenReplacementRange(
  snapshot: ActivePromptInputTokenSnapshot | null,
  selection: PromptInputTextSelectionSnapshot,
): { end: number; start: number } | null {
  if (
    !snapshot ||
    snapshot.nodeKey !== selection.nodeKey ||
    !isCaretInsideToken(snapshot, selection.cursorOffset) ||
    selection.text.slice(snapshot.tokenStart, snapshot.tokenEnd) !== snapshot.tokenText
  ) {
    return null;
  }

  return { end: snapshot.tokenEnd, start: snapshot.tokenStart };
}
