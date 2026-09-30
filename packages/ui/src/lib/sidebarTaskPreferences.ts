import type { BrowserStorageLike } from "@/lib/browserEnvironment.js";
import { getSafeLocalStorage } from "@/lib/browserEnvironment.js";

export type SidebarTaskOrganizeBy = "grouped" | "project" | "chronological";
export type SidebarTaskSortBy = "created" | "updated";

interface SidebarTaskPreferences {
  organizeBy: SidebarTaskOrganizeBy;
  sortBy: SidebarTaskSortBy;
}

const SIDEBAR_TASK_PREFERENCES_STORAGE_KEY = "zcode-sidebar-task-preferences";

const DEFAULT_SIDEBAR_TASK_PREFERENCES: SidebarTaskPreferences = {
  organizeBy: "project",
  sortBy: "updated",
};

function isSidebarTaskOrganizeBy(value: unknown): value is SidebarTaskOrganizeBy {
  return value === "grouped" || value === "project" || value === "chronological";
}

function isSidebarTaskSortBy(value: unknown): value is SidebarTaskSortBy {
  return value === "created" || value === "updated";
}

export function readSidebarTaskPreferences(
  storage: BrowserStorageLike | null = getSafeLocalStorage(),
): SidebarTaskPreferences {
  let rawValue: string | null = null;
  try {
    rawValue = storage?.getItem(SIDEBAR_TASK_PREFERENCES_STORAGE_KEY) ?? null;
  } catch {
    rawValue = null;
  }
  if (!rawValue) {
    return DEFAULT_SIDEBAR_TASK_PREFERENCES;
  }

  try {
    const parsed = JSON.parse(rawValue) as Partial<SidebarTaskPreferences>;
    return {
      organizeBy: isSidebarTaskOrganizeBy(parsed.organizeBy)
        ? parsed.organizeBy
        : DEFAULT_SIDEBAR_TASK_PREFERENCES.organizeBy,
      sortBy: isSidebarTaskSortBy(parsed.sortBy)
        ? parsed.sortBy
        : DEFAULT_SIDEBAR_TASK_PREFERENCES.sortBy,
    };
  } catch {
    return DEFAULT_SIDEBAR_TASK_PREFERENCES;
  }
}

export function persistSidebarTaskPreferences(
  preferences: SidebarTaskPreferences,
  storage: BrowserStorageLike | null = getSafeLocalStorage(),
) {
  // The timeline/sorting settings previously only existed in the React state of WorkspaceSidebar.
  // After refreshing or restarting, it will return to the default project/updated, and the user will think that the timeline setting has not taken effect.
  // Local preferences are written here uniformly, and the same sidebar display method can be restored on both the desktop and the web.
  try {
    storage?.setItem(
      SIDEBAR_TASK_PREFERENCES_STORAGE_KEY,
      JSON.stringify({
        organizeBy: preferences.organizeBy,
        sortBy: preferences.sortBy,
      }),
    );
  } catch {
    // Storage may not be writable in restricted browsers or SSR tests, and failure to write preferences cannot block sidebar interaction.
  }
}
