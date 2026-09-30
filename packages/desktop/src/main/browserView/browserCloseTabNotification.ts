import type { BrowserViewCloseTabNotification } from "@zcode/shared";
import type { BrowserGuestExecutionContext } from "./browserGuestManager.js";

/** Constructs the subset of owner scope required by main→renderer to turn off notifications; the remaining fields of the full execution context are independent of renderer. */
type BrowserCloseTabNotificationOwner = Pick<
  BrowserGuestExecutionContext,
  "workspaceKey" | "sessionId" | "remoteSessionId"
>;

/**
 * Folds the main-side tab owner into a close notification the renderer can route.
 *
 * The old payload carried only `tabId`, so the renderer could only look it up in the side pane
 * state of the "currently active workspace"; once the user had switched to another workspace the
 * notification was silently dropped, leaving an unclosable ghost tab in the original workspace's
 * persisted state. With the owner scope attached, the renderer can locate that workspace's side
 * pane directly and delete the tab from memory.
 *
 * This is a pure function so the field mapping is unit-testable: inlined into the manager
 * construction callback in `index.ts` it had no coverage, because the Electron entry point does
 * not run in unit tests and `closeTabFromRenderer` takes the `notifyRenderer=false` path and never
 * comes through here — leaving the field assembly of the whole Agent close notification chain
 * completely untested.
 *
 * The owner is optional: internal paths such as recovery-orphan only have a `tabId`, and the
 * renderer then falls back to "current workspace only" semantics.
 */
export function buildBrowserViewCloseTabNotification(
  tabId: string,
  owner?: BrowserCloseTabNotificationOwner,
): BrowserViewCloseTabNotification {
  if (!owner) return { tabId };
  return {
    tabId,
    workspaceKey: owner.workspaceKey,
    sessionId: owner.sessionId,
    // Remote workspace only has remoteSessionId; local workspace must make this field absent instead of explicitly undefined.
    // The renderer side-clicks `payload.remoteSessionId` to see if there is a different scope.
    ...(owner.remoteSessionId ? { remoteSessionId: owner.remoteSessionId } : {}),
  };
}
