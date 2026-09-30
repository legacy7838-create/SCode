/**
 * Workspace navigation history —— a browser-style forward/back stack
 *
 * A plain data structure plus immutable update functions, with no React dependency.
 * zcodeSessionStore holds the instance and drives the UI state from it.
 */

interface WorkspaceNavEntryBase {
  workspacePath: string;
  workspaceIdentity?: string;
}

export interface TaskNavEntry extends WorkspaceNavEntryBase {
  kind: "task";
  taskId: string;
}

// "workflow" is the top-level "workflow" tag of the automation page;
// scheduled / idle are still capsules inside the "Automation" tag.
export type AutomationsNavigationTab = "scheduled" | "idle" | "workflow";

export type OpenAutomationsMain = (
  automationId?: string,
  automationTab?: AutomationsNavigationTab,
) => void;

export interface AutomationsNavEntry extends WorkspaceNavEntryBase {
  kind: "automations";
  automationId?: string;
  automationTab?: AutomationsNavigationTab;
}

export interface PluginStoreNavEntry extends WorkspaceNavEntryBase {
  kind: "plugin-store";
}

export type WorkspaceNavEntry = TaskNavEntry | AutomationsNavEntry | PluginStoreNavEntry;

export interface TaskNavigationHistory {
  entries: WorkspaceNavEntry[];
  /** Current pointer, an index into entries; -1 means empty */
  cursor: number;
}

const MAX_HISTORY = 50;

export function createTaskNavigationHistory(): TaskNavigationHistory {
  return { entries: [], cursor: -1 };
}

function isTaskNavEntry(entry: WorkspaceNavEntry): entry is TaskNavEntry {
  return entry.kind === "task";
}

export function isAutomationsNavEntry(entry: WorkspaceNavEntry): entry is AutomationsNavEntry {
  return entry.kind === "automations";
}

export function isPluginStoreNavEntry(entry: WorkspaceNavEntry): entry is PluginStoreNavEntry {
  return entry.kind === "plugin-store";
}

function isSameNavEntry(left: WorkspaceNavEntry, right: WorkspaceNavEntry): boolean {
  if (
    left.kind !== right.kind ||
    left.workspacePath !== right.workspacePath ||
    left.workspaceIdentity !== right.workspaceIdentity
  ) {
    return false;
  }

  if (left.kind === "task") return left.taskId === (right as TaskNavEntry).taskId;
  if (left.kind === "automations") {
    const rightAutomations = right as AutomationsNavEntry;
    return (
      left.automationId === rightAutomations.automationId &&
      left.automationTab === rightAutomations.automationTab
    );
  }
  return true;
}

function pushEntry(
  history: TaskNavigationHistory,
  entry: WorkspaceNavEntry,
): TaskNavigationHistory {
  const current = history.cursor >= 0 ? history.entries[history.cursor] : null;

  // Adjacent deduplication: no repeated stacking when replaying history or opening the same target continuously.
  if (current && isSameNavEntry(current, entry)) {
    return history;
  }

  // Truncate the forward history after the cursor, maintaining browser-like navigation semantics.
  const next = [...history.entries.slice(0, history.cursor + 1), entry];
  if (next.length > MAX_HISTORY) {
    const overflow = next.length - MAX_HISTORY;
    return {
      entries: next.slice(overflow),
      cursor: next.length - overflow - 1,
    };
  }

  return { entries: next, cursor: next.length - 1 };
}

/** Called when the user actively selects/creates a task. */
export function pushNavEntry(
  history: TaskNavigationHistory,
  workspacePath: string,
  taskId: string,
  workspaceIdentity?: string,
): TaskNavigationHistory {
  // The navigation of the remote workspace cannot just remember the path.
  // The same path may exist locally/remotely or on multiple remote machines at the same time, and the identity isolation key must be pushed onto the stack together.
  return pushEntry(history, {
    kind: "task",
    workspacePath,
    ...(workspaceIdentity ? { workspaceIdentity } : {}),
    taskId,
  });
}

/** Called when the user actively opens the Automations main view or a specific detail. */
export function pushAutomationsNavEntry(
  history: TaskNavigationHistory,
  workspacePath: string,
  workspaceIdentity?: string,
  automationId?: string,
  automationTab?: AutomationsNavigationTab,
): TaskNavigationHistory {
  return pushEntry(history, {
    kind: "automations",
    workspacePath,
    ...(workspaceIdentity ? { workspaceIdentity } : {}),
    ...(automationId ? { automationId } : {}),
    ...(automationTab ? { automationTab } : {}),
  });
}

export function pushPluginStoreNavEntry(
  history: TaskNavigationHistory,
  workspacePath: string,
  workspaceIdentity?: string,
): TaskNavigationHistory {
  return pushEntry(history, {
    kind: "plugin-store",
    workspacePath,
    ...(workspaceIdentity ? { workspaceIdentity } : {}),
  });
}

export function canGoBack(history: TaskNavigationHistory): boolean {
  return history.cursor > 0;
}

export function canGoForward(history: TaskNavigationHistory): boolean {
  return history.cursor < history.entries.length - 1;
}

/** Go back one step, returning the new history and the target entry. */
export function goBack(
  history: TaskNavigationHistory,
): { history: TaskNavigationHistory; entry: WorkspaceNavEntry } | null {
  if (!canGoBack(history)) {
    return null;
  }

  const nextCursor = history.cursor - 1;
  const entry = history.entries[nextCursor];
  if (!entry) {
    return null;
  }

  return {
    history: { ...history, cursor: nextCursor },
    entry,
  };
}

/** Go forward one step, returning the new history and the target entry. */
export function goForward(
  history: TaskNavigationHistory,
): { history: TaskNavigationHistory; entry: WorkspaceNavEntry } | null {
  if (!canGoForward(history)) {
    return null;
  }

  const nextCursor = history.cursor + 1;
  const entry = history.entries[nextCursor];
  if (!entry) {
    return null;
  }

  return {
    history: { ...history, cursor: nextCursor },
    entry,
  };
}

/**
 * Removes every task entry with the given taskId from the history (called when a task is deleted).
 * Automations entries do not belong to the task lifecycle and must be kept as they are.
 */
export function removeTaskFromHistory(
  history: TaskNavigationHistory,
  taskId: string,
): TaskNavigationHistory {
  const currentEntry = history.cursor >= 0 ? history.entries[history.cursor] : null;
  const filtered = history.entries.filter(
    (entry) => !isTaskNavEntry(entry) || entry.taskId !== taskId,
  );

  if (filtered.length === history.entries.length) {
    return history;
  }

  if (filtered.length === 0) {
    return createTaskNavigationHistory();
  }

  // If the current entry is not deleted, keep pointing to it; if it is deleted, the old position will be used to select the nearest target.
  const currentEntryIndex = currentEntry ? filtered.indexOf(currentEntry) : -1;
  const cursor =
    currentEntryIndex >= 0 ? currentEntryIndex : Math.min(history.cursor, filtered.length - 1);

  return { entries: filtered, cursor };
}
