import type { ConversationSelectionReference } from "@/lib/conversationSelectionReference.js";

const pendingCreations = new Map<string, Promise<string>>();
const blockedChildSessionIds = new Set<string>();
const listeners = new Set<() => void>();
type SelectionSideChatOpener = (reference?: ConversationSelectionReference) => Promise<void>;
interface SelectionSideChatOpenerEntry {
  focused: boolean;
  referenceBlocked: boolean;
  open: SelectionSideChatOpener;
}
const openers = new Map<string, Map<symbol, SelectionSideChatOpenerEntry>>();

export function buildSelectionSideChatKey(workspaceKey: string, parentSessionId: string): string {
  return `${workspaceKey}\0${parentSessionId}`;
}

/**
 * The same user gesture creates at most one child while the command is pending; the parent scope is
 * released immediately on completion, so the next click on the fixed entry point can create a new
 * child instead of degrading back to the old singleton binding.
 */
export async function createSelectionSideChat(
  key: string,
  create: () => Promise<string>,
): Promise<string> {
  const current = pendingCreations.get(key);
  if (current) return current;
  const pending = create().finally(() => {
    if (pendingCreations.get(key) === pending) {
      pendingCreations.delete(key);
    }
    emitChange();
  });
  pendingCreations.set(key, pending);
  return pending;
}

export function clearSelectionSideChat(childSessionId: string): void {
  const changed = blockedChildSessionIds.delete(childSessionId);
  if (!changed) return;
  emitChange();
}

export function setSelectionSideChatBlocked(childSessionId: string, blocked: boolean): void {
  const changed = blocked
    ? !blockedChildSessionIds.has(childSessionId)
    : blockedChildSessionIds.has(childSessionId);
  if (!changed) return;
  if (blocked) blockedChildSessionIds.add(childSessionId);
  else blockedChildSessionIds.delete(childSessionId);
  emitChange();
}

export function isSelectionSideChatBlocked(childSessionId: string): boolean {
  return blockedChildSessionIds.has(childSessionId);
}

export function subscribeSelectionSideChatRuntime(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * The fixed entry point of the Side Pane sits outside the session Provider and cannot compose
 * protocol commands on its own. The mounted primary SessionPane registers the create capability and
 * the launcher only routes by workspace + parent; when the same parent session is shown in several
 * split panes the focused pane is preferred, keeping the command owner consistent with the current
 * input focus.
 */
export function registerSelectionSideChatOpener(
  key: string,
  opener: SelectionSideChatOpener,
  focused: boolean,
  referenceBlocked = false,
): () => void {
  const token = Symbol(key);
  const scoped = openers.get(key) ?? new Map<symbol, SelectionSideChatOpenerEntry>();
  scoped.set(token, { focused, open: opener, referenceBlocked });
  openers.set(key, scoped);
  emitChange();

  return () => {
    const current = openers.get(key);
    current?.delete(token);
    if (current?.size === 0) openers.delete(key);
    emitChange();
  };
}

function getSelectionSideChatOpener(key: string): SelectionSideChatOpenerEntry | undefined {
  const scoped = openers.get(key);
  if (!scoped?.size) return undefined;
  const candidates = Array.from(scoped.values());
  return candidates.find((candidate) => candidate.focused) ?? candidates[0];
}

export function getSelectionSideChatOpenState(key: string): "ready" | "blocked" | "unavailable" {
  const target = getSelectionSideChatOpener(key);
  return !target ? "unavailable" : target.referenceBlocked ? "blocked" : "ready";
}

export function requestSelectionSideChatOpen(
  key: string,
  reference?: ConversationSelectionReference,
): boolean {
  const target = getSelectionSideChatOpener(key);
  if (!target || (reference && target.referenceBlocked)) return false;
  if (reference) void target.open(reference);
  else void target.open();
  return true;
}

function emitChange(): void {
  for (const listener of listeners) listener();
}
