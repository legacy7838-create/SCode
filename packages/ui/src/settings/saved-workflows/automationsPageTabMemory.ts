// The memory of the top-level label of the automation page: recorded in sessionStorage,
// Follow the last-section precedent of settingsNavigation.ts - you are still in the "workflow" when you switch back from the details page/dialogue.
// After the hub is upgraded to a cross-project view, the page no longer depends on the active project: it uses a single app-level key and no longer buckets by workspaceKey;
// No entering Zustand, no cross-window broadcasting.
import type { AutomationsPageTab } from "@/settings/saved-workflows/AutomationsPageTitleSwitch.js";

const STORAGE_KEY = "zcode-automations-page-tab";

function storage(): Storage | null {
  try {
    return typeof sessionStorage === "undefined" ? null : sessionStorage;
  } catch {
    return null;
  }
}

export function readAutomationsPageTab(): AutomationsPageTab {
  try {
    const value = storage()?.getItem(STORAGE_KEY);
    return value === "workflow" ? "workflow" : "automation";
  } catch {
    return "automation";
  }
}

export function writeAutomationsPageTab(tab: AutomationsPageTab): void {
  try {
    storage()?.setItem(STORAGE_KEY, tab);
  } catch {
    // If sessionStorage is unavailable (privacy mode/quota), it will not be remembered; it will return to the default tab next time it is opened, and the functionality will not be affected.
  }
}
