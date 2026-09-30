export const BROWSER_TAB_LIMIT = 32;

export type BrowserTabResidency =
  | "live-visible"
  | "live-background"
  | "suspend-pending"
  | "suspended"
  | "restoring";

export interface BrowserTabResidencyCandidate {
  tabId: string;
  windowId: number;
  sessionId: string;
  residency: BrowserTabResidency;
  /** The physical guest is attached and not destroyed; logical residency does not replace this fact. */
  guestAttached: boolean;
  openedAt: number;
  lastActivityAt: number;
  lastSelectedAt: number | null;
  /** The last selected main tab of the current task; at most one in the same window/session. */
  preferred: boolean;
  currentTask: boolean;
  selected: boolean;
  visible: boolean;
  operationActive: boolean;
  captureActive: boolean;
  audible: boolean;
  mediaActive: boolean;
  loading: boolean;
  downloadActive: boolean;
}

interface BrowserTabResidencySelectionOptions {
  windowId: number;
  tabLimit?: number;
}

function isBrowserTabResidencyProtected(candidate: BrowserTabResidencyCandidate): boolean {
  // Product boundary: preferred is only used to restore the default selection; when the logical tab limit is reached, only the user is visible or
  // The running state is protected, and the suspended shell can also be closed directly.
  return (
    candidate.residency === "live-visible" ||
    candidate.residency === "restoring" ||
    candidate.residency === "suspend-pending" ||
    candidate.selected ||
    candidate.visible ||
    candidate.operationActive ||
    candidate.captureActive ||
    candidate.audible ||
    candidate.mediaActive ||
    candidate.loading ||
    candidate.downloadActive
  );
}

export function selectBrowserTabLimitVictim(
  candidates: readonly BrowserTabResidencyCandidate[],
  options: BrowserTabResidencySelectionOptions,
): BrowserTabResidencyCandidate | null {
  const tabLimit = options.tabLimit ?? BROWSER_TAB_LIMIT;
  const windowCandidates = candidates.filter(
    (candidate) => candidate.windowId === options.windowId,
  );
  if (windowCandidates.length <= tabLimit) return null;

  const eligible = windowCandidates.filter(
    (candidate) => !isBrowserTabResidencyProtected(candidate),
  );
  eligible.sort((left, right) => {
    const activityDelta = left.lastActivityAt - right.lastActivityAt;
    if (activityDelta !== 0) return activityDelta;
    const selectionDelta =
      (left.lastSelectedAt ?? Number.NEGATIVE_INFINITY) -
      (right.lastSelectedAt ?? Number.NEGATIVE_INFINITY);
    if (selectionDelta !== 0) return selectionDelta;
    const openedDelta = left.openedAt - right.openedAt;
    if (openedDelta !== 0) return openedDelta;
    return left.tabId.localeCompare(right.tabId);
  });
  return eligible[0] ?? null;
}
