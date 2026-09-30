/* eslint-disable max-lines -- settings navigation intents centrally manage sessionStorage, the
 * event bridge, and parse validation; splitting them would make the one-shot intent consumption
 * order harder to guarantee.
 */
import { logger } from "@/logger.js";

export type SettingsSectionId =
  | "general"
  | "appearance"
  | "migration"
  | "browser"
  | "modelProvider"
  | "memory"
  | "plugin"
  | "mcp"
  | "skill"
  | "plugins"
  | "usage"
  | "subagents"
  | "commands"
  | "hooks"
  | "workspaceFileSearch"
  | "computerUse"
  | "automations"
  | "shortcuts";

type SettingsUsageTabTarget = "app" | "codingPlan";
type SettingsPluginTabTarget = "plugins" | "mcps" | "skills" | "commands";
type SettingsPluginNavigationOrigin = "plugin-store";

const SETTINGS_SECTION_INTENT_KEY = "zcode-settings-section-intent",
  SETTINGS_USAGE_TAB_INTENT_KEY = "zcode-settings-usage-tab-intent",
  SETTINGS_PLUGIN_TAB_INTENT_KEY = "zcode-settings-plugin-tab-intent",
  SETTINGS_PLUGIN_ORIGIN_INTENT_KEY = "zcode-settings-plugin-origin-intent",
  SETTINGS_PLUGIN_SCOPE_KEY_INTENT_KEY = "zcode-settings-plugin-scope-key-intent";
const SETTINGS_MODEL_PROVIDER_ID_INTENT_KEY = "zcode-settings-model-provider-id-intent";
const SETTINGS_SECTION_INTENT_EVENT = "zcode:settings-section-intent",
  SETTINGS_LAST_SECTION_STORAGE_KEY = "zcode-settings-last-section";
const HIDDEN_SETTINGS_SECTIONS = new Set<SettingsSectionId>([
  // Product semantics: Scheduled tasks are the main view of the workspace and can no longer appear as settings page partitions.
  // Note: hooks is already an official settings page partition and is not listed here.
  "automations",
  // The old plugin market has been moved out of the settings page; the ids are retained only for migrating historical preferences and old calls.
  "plugins",
  // The workspace search (.zcodeignore) setting entry is hidden first: the rule file is still in effect and can be edited manually.
  // The edit page code is retained and can be removed from here when released.
  "workspaceFileSearch",
  "computerUse",
]);

interface SettingsSectionIntentEventDetail {
  section: SettingsSectionId;
  pluginTab?: SettingsPluginTabTarget;
  pluginOrigin?: SettingsPluginNavigationOrigin;
  pluginScopeKey?: string;
  usageTab?: SettingsUsageTabTarget;
  modelProviderId?: string;
}

export interface SettingsModelProviderTarget {
  providerId: string;
}

function isSettingsSectionId(value: string): value is SettingsSectionId {
  return (
    value === "general" ||
    value === "appearance" ||
    value === "migration" ||
    value === "browser" ||
    value === "modelProvider" ||
    value === "memory" ||
    value === "plugin" ||
    value === "mcp" ||
    value === "skill" ||
    value === "plugins" ||
    value === "usage" ||
    value === "subagents" ||
    value === "commands" ||
    value === "hooks" ||
    value === "workspaceFileSearch" ||
    value === "computerUse" ||
    value === "automations" ||
    value === "shortcuts"
  );
}

export function isSettingsSectionEnabled(section: SettingsSectionId): boolean {
  return !HIDDEN_SETTINGS_SECTIONS.has(section);
}

export function resolveSettingsSection(
  section: SettingsSectionId,
  fallbackSection: SettingsSectionId = "general",
): SettingsSectionId {
  if (section === "plugins") return "plugin";
  return isSettingsSectionEnabled(section) ? section : fallbackSection;
}

function getLocalStorage(): Storage | null {
  if (typeof window === "undefined") {
    return null;
  }
  try {
    return window.localStorage;
  } catch (error) {
    // Some WebView / mobile remote control containers may disable localStorage.
    // The settings page partition memory is just a UI preference. When the storage is unavailable, it will fall back to the default entry and should not block the opening of the settings page.
    logger.warn("[settingsNavigation] localStorage unavailable", {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

function readLastSettingsSectionPreference(
  fallbackSection: SettingsSectionId = "general",
): SettingsSectionId {
  const storage = getLocalStorage();
  if (!storage) {
    return fallbackSection;
  }

  try {
    const raw = storage.getItem(SETTINGS_LAST_SECTION_STORAGE_KEY);
    // The old section id has been merged into the plugin; the persistent value is migrated to avoid continuing to propagate historical routing semantics.
    if (raw === "plugins") {
      storage.setItem(SETTINGS_LAST_SECTION_STORAGE_KEY, "plugin");
      setPendingPluginTab("plugins");
      return "plugin";
    }
    if (raw === "skills") {
      storage.setItem(SETTINGS_LAST_SECTION_STORAGE_KEY, "skill");
      return "skill";
    }
    // The old version of "Code Preview" has been merged into "Appearance", retaining the migration semantics of the user's last stay.
    if (raw === "codePreview") {
      storage.setItem(SETTINGS_LAST_SECTION_STORAGE_KEY, "appearance");
      return "appearance";
    }
    if (raw && isSettingsSectionId(raw)) {
      return resolveSettingsSection(raw, fallbackSection);
    }
    if (raw !== null) {
      storage.removeItem(SETTINGS_LAST_SECTION_STORAGE_KEY);
    }
  } catch (error) {
    logger.warn("[settingsNavigation] failed to read last settings section", {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  return fallbackSection;
}

export function writeLastSettingsSectionPreference(section: SettingsSectionId): void {
  const resolvedSection = resolveSettingsSection(section);
  const storage = getLocalStorage();
  if (!storage) {
    return;
  }

  try {
    storage.setItem(SETTINGS_LAST_SECTION_STORAGE_KEY, resolvedSection);
  } catch (error) {
    logger.warn("[settingsNavigation] failed to write last settings section", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export function consumeInitialSettingsSection(
  fallbackSection: SettingsSectionId = "general",
): SettingsSectionId {
  const lastSection = readLastSettingsSectionPreference(fallbackSection);
  // Before opening the settings page, write the fallback of consumePendingSettingsSection as
  // modelProvider, causing the "model provider" to always be entered when there is no explicit jump intention. Here we first read the last stay partition,
  // Then let one-time intents such as quickpick / manage models override it, retaining the direct semantics of explicit entry.
  return resolveSettingsSection(consumePendingSettingsSection(lastSection), lastSection);
}

export function setPendingSettingsSection(section: SettingsSectionId): void {
  setPendingSettingsSectionIntent(section);
}

export function setPendingSettingsUsageIntent(): void {
  // The usage statistics portal is only responsible for opening the Usage partition and does not forcefully cover the specific statistics tabs that users want to see.
  setPendingSettingsSectionIntent("usage");
}

export function setPendingSettingsUsageCodingPlanIntent(): void {
  // The remaining balance details entry needs to go directly to the Coding Plan usage statistics;
  // The avatar menu entry only opens the Usage partition to avoid overwriting the statistics tab last viewed by the user.
  setPendingSettingsSectionIntent("usage", { usageTab: "codingPlan" });
}

export function setPendingSettingsPluginIntent(
  tab: SettingsPluginTabTarget,
  options: {
    origin?: SettingsPluginNavigationOrigin;
    scopeKey?: string;
  } = {},
): void {
  const section =
    tab === "mcps"
      ? "mcp"
      : tab === "skills"
        ? "skill"
        : tab === "commands"
          ? "commands"
          : "plugin";
  setPendingSettingsSectionIntent(section, {
    pluginTab: tab === "plugins" ? tab : undefined,
    pluginOrigin: options.origin,
    pluginScopeKey: options.scopeKey,
  });
}

export function setPendingSettingsSectionIntent(
  section: SettingsSectionId,
  options: {
    pluginTab?: SettingsPluginTabTarget;
    pluginOrigin?: SettingsPluginNavigationOrigin;
    pluginScopeKey?: string;
    modelProviderId?: string;
    usageTab?: SettingsUsageTabTarget;
  } = {},
): void {
  if (typeof window === "undefined") {
    return;
  }

  try {
    window.sessionStorage.setItem(SETTINGS_SECTION_INTENT_KEY, section);
    if (options.pluginTab) {
      window.sessionStorage.setItem(SETTINGS_PLUGIN_TAB_INTENT_KEY, options.pluginTab);
    } else {
      window.sessionStorage.removeItem(SETTINGS_PLUGIN_TAB_INTENT_KEY);
    }
    if (options.pluginOrigin) {
      window.sessionStorage.setItem(SETTINGS_PLUGIN_ORIGIN_INTENT_KEY, options.pluginOrigin);
    } else {
      window.sessionStorage.removeItem(SETTINGS_PLUGIN_ORIGIN_INTENT_KEY);
    }
    const normalizedPluginScopeKey = options.pluginScopeKey?.trim();
    if (normalizedPluginScopeKey) {
      window.sessionStorage.setItem(SETTINGS_PLUGIN_SCOPE_KEY_INTENT_KEY, normalizedPluginScopeKey);
    } else {
      window.sessionStorage.removeItem(SETTINGS_PLUGIN_SCOPE_KEY_INTENT_KEY);
    }
    if (options.usageTab) {
      window.sessionStorage.setItem(SETTINGS_USAGE_TAB_INTENT_KEY, options.usageTab);
    }
    if (options.modelProviderId) {
      window.sessionStorage.setItem(SETTINGS_MODEL_PROVIDER_ID_INTENT_KEY, options.modelProviderId);
    } else {
      window.sessionStorage.removeItem(SETTINGS_MODEL_PROVIDER_ID_INTENT_KEY);
    }
  } catch {
    // Ignore browser storage exceptions and do not affect the main process.
  }

  // When the settings page is already open, it will not be remounted. No subscribers will respond if you simply write sessionStorage.
  // Reissue custom events in the same window, so that the opened SettingsPage can jump to the quickpick designated partition immediately.
  window.dispatchEvent(
    new CustomEvent<SettingsSectionIntentEventDetail>(SETTINGS_SECTION_INTENT_EVENT, {
      detail: {
        section,
        pluginTab: options.pluginTab,
        pluginOrigin: options.pluginOrigin,
        pluginScopeKey: options.pluginScopeKey?.trim() || undefined,
        usageTab: options.usageTab,
        modelProviderId: options.modelProviderId,
      },
    }),
  );
}

function clearPendingSettingsSectionIntent(): void {
  if (typeof window === "undefined") {
    return;
  }

  try {
    window.sessionStorage.removeItem(SETTINGS_SECTION_INTENT_KEY);
    window.sessionStorage.removeItem(SETTINGS_USAGE_TAB_INTENT_KEY);
    window.sessionStorage.removeItem(SETTINGS_MODEL_PROVIDER_ID_INTENT_KEY);
    window.sessionStorage.removeItem(SETTINGS_PLUGIN_TAB_INTENT_KEY);
    window.sessionStorage.removeItem(SETTINGS_PLUGIN_ORIGIN_INTENT_KEY);
    window.sessionStorage.removeItem(SETTINGS_PLUGIN_SCOPE_KEY_INTENT_KEY);
  } catch {
    // Ignore browser storage exceptions and do not affect the main process.
  }
}

function consumePendingSettingsSection(
  fallbackSection: SettingsSectionId = "general",
): SettingsSectionId {
  if (typeof window === "undefined") {
    return fallbackSection;
  }

  try {
    const raw = window.sessionStorage.getItem(SETTINGS_SECTION_INTENT_KEY);
    if (raw !== null) {
      window.sessionStorage.removeItem(SETTINGS_SECTION_INTENT_KEY);
    }

    if (raw === "skills") {
      // Old Skills use plural ids; migrated to current independent skill partition.
      return "skill";
    }
    if (raw && isSettingsSectionId(raw)) {
      return resolveSettingsSection(raw, fallbackSection);
    }
  } catch {
    // Ignore browser storage exceptions and do not affect the main process.
  }

  return fallbackSection;
}

function setPendingPluginTab(tab: SettingsPluginTabTarget): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(SETTINGS_PLUGIN_TAB_INTENT_KEY, tab);
  } catch {
    // Ignore browser storage exceptions and do not affect the opening of the settings page.
  }
}

export function consumePendingSettingsPluginTab(): SettingsPluginTabTarget | undefined {
  if (typeof window === "undefined") return undefined;
  try {
    const raw = window.sessionStorage.getItem(SETTINGS_PLUGIN_TAB_INTENT_KEY);
    window.sessionStorage.removeItem(SETTINGS_PLUGIN_TAB_INTENT_KEY);
    return raw === "plugins" || raw === "mcps" || raw === "skills" ? raw : undefined;
  } catch {
    return undefined;
  }
}

export function consumePendingSettingsPluginOrigin(): SettingsPluginNavigationOrigin | undefined {
  if (typeof window === "undefined") return undefined;
  try {
    const raw = window.sessionStorage.getItem(SETTINGS_PLUGIN_ORIGIN_INTENT_KEY);
    return raw === "plugin-store" ? raw : undefined;
  } catch {
    return undefined;
  }
}

export function consumePendingSettingsPluginScopeKey(): string | undefined {
  if (typeof window === "undefined") return undefined;
  try {
    const raw = window.sessionStorage.getItem(SETTINGS_PLUGIN_SCOPE_KEY_INTENT_KEY);
    return raw?.trim() || undefined;
  } catch {
    return undefined;
  }
}

export function clearPendingSettingsPluginScopeKey(): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.removeItem(SETTINGS_PLUGIN_SCOPE_KEY_INTENT_KEY);
  } catch {
    // Ignore browser storage exceptions and do not affect the main process.
  }
}

export function clearPendingSettingsPluginOrigin(): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.removeItem(SETTINGS_PLUGIN_ORIGIN_INTENT_KEY);
  } catch {
    // Ignore browser storage exceptions and do not affect the opening of the settings page.
  }
}

export function consumePendingSettingsUsageTab(): SettingsUsageTabTarget | undefined {
  if (typeof window === "undefined") {
    return undefined;
  }

  try {
    const raw = window.sessionStorage.getItem(SETTINGS_USAGE_TAB_INTENT_KEY);
    if (raw !== null) {
      window.sessionStorage.removeItem(SETTINGS_USAGE_TAB_INTENT_KEY);
    }
    return raw === "app" || raw === "codingPlan" ? raw : undefined;
  } catch {
    // Ignore browser storage exceptions and do not affect the main process.
    return undefined;
  }
}

export function consumePendingSettingsModelProviderTarget():
  | SettingsModelProviderTarget
  | undefined {
  if (typeof window === "undefined") {
    return undefined;
  }

  try {
    const providerId = window.sessionStorage.getItem(SETTINGS_MODEL_PROVIDER_ID_INTENT_KEY);
    window.sessionStorage.removeItem(SETTINGS_MODEL_PROVIDER_ID_INTENT_KEY);
    if (!providerId?.trim()) {
      return undefined;
    }
    return {
      providerId: providerId.trim(),
    };
  } catch {
    // Ignore browser storage exceptions and do not affect the main process.
    return undefined;
  }
}

export function shouldFallbackSettingsUsageTabToApp({
  activeTab,
  checkingCodingPlanTab,
  loadingModelProviders,
  showCodingPlanTab,
}: {
  activeTab: SettingsUsageTabTarget;
  checkingCodingPlanTab: boolean;
  loadingModelProviders: boolean;
  showCodingPlanTab: boolean;
}): boolean {
  // Coding Plan jump intent may finish loading before provider/entitlement data.
  // Only return to App Usage when it is confirmed that it is no longer loading and there is still no valid package to avoid accidentally changing back to the default tab in the first frame after clicking "More".
  return (
    activeTab === "codingPlan" &&
    !showCodingPlanTab &&
    !loadingModelProviders &&
    !checkingCodingPlanTab
  );
}

export function addPendingSettingsSectionListener(
  listener: (section: SettingsSectionId, detail?: SettingsSectionIntentEventDetail) => void,
): () => void {
  if (typeof window === "undefined") {
    return () => {};
  }

  const handleIntent = (event: Event) => {
    const detail = (event as CustomEvent<SettingsSectionIntentEventDetail>).detail;
    if (detail?.section && isSettingsSectionId(detail.section)) {
      // When the settings page is opened, the event has already carried the jump intention.
      // SessionStorage is cleared synchronously here to prevent the user from switching to another partition and exiting later.
      // The next time the mount is mounted, the "last stay partition" will be overwritten by the stale pending intent.
      clearPendingSettingsSectionIntent();
      listener(detail.section, detail);
    }
  };

  window.addEventListener(SETTINGS_SECTION_INTENT_EVENT, handleIntent);
  return () => {
    window.removeEventListener(SETTINGS_SECTION_INTENT_EVENT, handleIntent);
  };
}
