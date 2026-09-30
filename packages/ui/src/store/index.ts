/**
 * Zustand Store — global state management
 *
 * State that needs cross-window sync is broadcast through BroadcastService. The broadcast channel
 * prefix "state:" marks state-sync messages.
 */
import { create } from "zustand";
import type { IBroadcastService, BroadcastMessage } from "@zcode/services";
import type { OAuthProviderId, UserInfo } from "@zcode/shared";
import type { CodingPlanResetType } from "@zcode/shared";
import type { CodePreviewSettings } from "@/lib/codePreviewSettings.js";
import type {
  CodingPlanQuotaResetUiEntries,
  CodingPlanQuotaResetUiEntry,
} from "@/lib/codingPlanQuotaResetUi.js";
import {
  applyCodingPlanQuotaResetAutoPlayedBroadcast,
  createCodingPlanQuotaResetStoreActions,
  parseCodingPlanQuotaResetAutoPlayedBroadcastMessage,
  type CodingPlanQuotaResetAutomaticObservations,
  type CodingPlanQuotaResetAutoPlayReservation,
  type CodingPlanQuotaResetAutoPlayReservationAttempt,
  type CodingPlanQuotaResetAutoPlayedSlot,
} from "@/store/codingPlanQuotaResetState.js";
import { DEFAULT_CODE_PREVIEW_SETTINGS } from "@/lib/codePreviewSettings.js";
import { readSafeLocalStorage, writeSafeLocalStorage } from "@/lib/browserEnvironment.js";
import {
  applyUiFontSizePx,
  loadUiFontSizePx,
  normalizeUiFontSizePx,
  UI_FONT_SIZE_STORAGE_KEY,
} from "@/lib/uiFontSize.js";
import {
  isTaskNotificationEnabled,
  isTaskNotificationSoundPreferenceEnabled,
  persistTaskNotificationEnabled,
  persistTaskNotificationSoundEnabled,
} from "@/lib/taskNotificationPreferences.js";
import type { Theme } from "../useTheme.js";
import { applyTheme, normalizeThemePreference, resolveTheme } from "../useTheme.js";

import {
  INTERFACE_MODE_STORAGE_KEY,
  normalizeInterfaceMode,
  type InterfaceMode,
} from "@/lib/interfaceMode.js";
import { logger } from "@/logger.js";

export type LoginEntryPurpose = "app-login";

// v4 refactoring: types and default values are dropped to @/lib/codePreviewSettings.ts,
// Let the pure display component not depend on the store; here, re-export is retained to be compatible with the existing import path.
export type { CodePreviewSettings } from "@/lib/codePreviewSettings.js";
export { DEFAULT_CODE_PREVIEW_SETTINGS } from "@/lib/codePreviewSettings.js";

export type LoginEntryAttemptStatus =
  | "requested"
  | "waiting"
  | "succeeded"
  | "cancelled"
  | "failed";

export interface LoginEntryAttempt {
  id: number;
  providerId?: OAuthProviderId;
  purpose?: LoginEntryPurpose;
  status: LoginEntryAttemptStatus;
}

const CODE_PREVIEW_SETTINGS_KEY = "zcode-code-preview-settings";
const PERFORMANCE_MODE_STORAGE_KEY = "zcode-performance-mode";

function loadCodePreviewSettings(): CodePreviewSettings {
  try {
    const raw = readSafeLocalStorage(CODE_PREVIEW_SETTINGS_KEY);
    if (!raw) {
      return DEFAULT_CODE_PREVIEW_SETTINGS;
    }

    const parsed = JSON.parse(raw) as Partial<CodePreviewSettings>;
    return {
      ...DEFAULT_CODE_PREVIEW_SETTINGS,
      ...parsed,
      fontSizePx:
        typeof parsed.fontSizePx === "number"
          ? Math.min(20, Math.max(12, Math.round(parsed.fontSizePx)))
          : DEFAULT_CODE_PREVIEW_SETTINGS.fontSizePx,
    };
  } catch {
    return DEFAULT_CODE_PREVIEW_SETTINGS;
  }
}

function loadPerformanceMode(): boolean {
  return readSafeLocalStorage(PERFORMANCE_MODE_STORAGE_KEY) === "true";
}

// ============================================================================
// State definition
// ============================================================================

export interface ZCodeState {
  /**
   * Presentation detail preferences; they do not change Agent permissions or execution
   * capabilities.
   */
  interfaceMode: InterfaceMode;
  setInterfaceMode: (mode: InterfaceMode) => void;

  /** The current theme */
  theme: Theme;
  setTheme: (theme: Theme) => void;

  /** Code preview settings */
  codePreviewSettings: CodePreviewSettings;
  setCodePreviewSettings: (patch: Partial<CodePreviewSettings>) => void;

  /** The root rem font size of the UI (px) */
  uiFontSizePx: number;
  setUiFontSizePx: (fontSizePx: number) => void;

  /** Whether performance mode is enabled */
  performanceMode: boolean;
  setPerformanceMode: (enabled: boolean) => void;

  /**
   * Whether task notifications are enabled (desktop notifications; the sound is controlled by a
   * sub-toggle)
   */
  notificationEnabled: boolean;
  setNotificationEnabled: (enabled: boolean) => void;

  /**
   * Whether the task notification sound is enabled (dependent on the main task notification toggle)
   */
  notificationSoundEnabled: boolean;
  setNotificationSoundEnabled: (enabled: boolean) => void;

  /** The current user info */
  user: UserInfo | null;
  /**
   * Incremented when the user goes from signed out to signed in; connecting an extra provider is
   * not mistaken for a re-login.
   */
  authSessionSeq: number;
  setUser: (user: UserInfo | null) => void;

  /** Whether the OAuth session is still being restored during startup */
  isRestoringOAuthSession: boolean;
  setIsRestoringOAuthSession: (restoring: boolean) => void;

  /** OAuth callback error (written at the Root layer, read by the unified sign-in entry) */
  oauthError: string | null;
  setOAuthError: (error: string | null) => void;
  oauthPollingActive: boolean;
  setOAuthPollingActive: (active: boolean) => void;
  oauthSuccessSeq: number;
  lastOAuthSuccessProvider: OAuthProviderId | null;
  markOAuthSuccess: (provider?: OAuthProviderId) => void;
  apiKeyLoginSuccessSeq: number;
  lastApiKeyLoginModel: string | null;
  markApiKeyLoginSuccess: (preferredModel?: string | null) => void;
  /**
   * Requests opening the unified sign-in entry, optionally carrying the providers that need an
   * automatic sign-in/connection to be started
   */
  loginEntryRequest: {
    id: number;
    providerId?: OAuthProviderId;
    purpose?: LoginEntryPurpose;
  } | null;
  /**
   * The current unified sign-in attempt; follow-up actions such as purchase resume only the OAuth
   * they started themselves, by id.
   */
  loginEntryAttempt: LoginEntryAttempt | null;
  requestLoginEntry: (providerId?: OAuthProviderId, purpose?: LoginEntryPurpose) => number;
  clearLoginEntryRequest: (requestId?: number) => void;
  markLoginEntryAttemptStatus: (
    requestId: number,
    status: Exclude<LoginEntryAttemptStatus, "requested">,
  ) => void;

  /**
   * Coding Plan quota reset UI state; the entry/observation records are shared only within the
   * current window and are not persisted.
   */
  codingPlanQuotaResetUiBySource: Record<string, CodingPlanQuotaResetUiEntries>;
  /**
   * The auth session that the first observation of an auto/ops completion belongs to, used to
   * distinguish a later mount in the same session from a re-login.
   */
  codingPlanQuotaResetAutomaticObservationsBySource: Record<
    string,
    CodingPlanQuotaResetAutomaticObservations
  >;
  /**
   * The played used_at records backing the auto-completion hint "play only once across multiple
   * windows"; in-memory per window and mergeable via broadcast.
   */
  codingPlanQuotaResetAutoPlayedBySource: Record<string, CodingPlanQuotaResetAutoPlayedSlot>;
  /**
   * The state written to the server status / reconciled by a manual use; a null entry means
   * clearing that type.
   */
  setCodingPlanQuotaResetUiEntry: (
    sourceKey: string,
    resetType: CodingPlanResetType,
    entry: CodingPlanQuotaResetUiEntry | null,
    authSessionSeq: number,
  ) => void;
  /**
   * Requests a temporary reservation before the Composer is shown; this stage does not write
   * played.
   */
  reserveCodingPlanQuotaResetAutoPlay: (
    sourceKey: string,
    resetType: CodingPlanResetType,
    completedAt: number,
  ) => Promise<CodingPlanQuotaResetAutoPlayReservationAttempt>;
  /**
   * When the component is still valid and about to be shown, commits the reservation, played, and
   * the broadcast.
   */
  commitCodingPlanQuotaResetAutoPlay: (
    reservation: CodingPlanQuotaResetAutoPlayReservation,
  ) => boolean;
  /** When the component becomes invalid, releases the reservation that has not been committed. */
  releaseCodingPlanQuotaResetAutoPlay: (
    reservation: CodingPlanQuotaResetAutoPlayReservation,
  ) => Promise<void>;

  /** Manually requests opening the onboarding dialog */
  newUserOnboardingOpen: boolean;
  setNewUserOnboardingOpen: (open: boolean) => void;
  onboardingDialogRequested: boolean | "migration";
  requestOnboardingDialog: (entry?: "migration") => void;
  clearOnboardingDialogRequest: () => void;
}

// ============================================================================
// Fields that need to be broadcast - only changes to these fields will be sent to other windows
// ============================================================================

const BROADCAST_FIELDS = new Set(["theme", "uiFontSizePx", "interfaceMode"]);

type BroadcastField = "theme" | "uiFontSizePx" | "interfaceMode";

/** The broadcast channel name prefix */
const STATE_CHANNEL_PREFIX = "state:";

// ============================================================================
// Store creation factory
// ============================================================================

/**
 * Creates a Zustand store and connects the broadcast service to implement cross-window state sync
 *
 * @param broadcastService - The broadcast service. Desktop goes through RPC, Web can pass a no-op
 * implementation
 */
export function createZCodeStore(
  broadcastService: IBroadcastService,
  options: {
    initialIsRestoringOAuthSession?: boolean;
  } = {},
) {
  /**
   * Marker: an update from the broadcast is currently being applied, so it is not re-broadcast
   * (prevents loops)
   */
  let applyingBroadcast = false;
  let loginEntryRequestSeq = 0;
  let cleanupSystemThemeListener: (() => void) | null = null;
  let syncSystemThemeListener = (_theme: Theme) => {};

  const useStore = create<ZCodeState>()((set, get) => ({
    interfaceMode: normalizeInterfaceMode(readSafeLocalStorage(INTERFACE_MODE_STORAGE_KEY)),
    setInterfaceMode: (mode) => {
      const interfaceMode = normalizeInterfaceMode(mode);
      if (get().interfaceMode !== interfaceMode) {
        logger.debug("[InterfaceMode] switching interface mode", {
          interfaceMode,
          source: applyingBroadcast ? "broadcast" : "local",
        });
      }
      writeSafeLocalStorage(INTERFACE_MODE_STORAGE_KEY, interfaceMode);
      set({ interfaceMode });
    },
    // The default theme is uniformly converged to Zai dark to avoid inconsistent performance between the store and other theme entrances when starting for the first time.
    // The saved user choices in localStorage will still be respected first and existing preferences will not be overwritten.
    theme: normalizeThemePreference((readSafeLocalStorage("zcode-theme") as Theme) || "zai-dark"),
    setTheme: (theme: Theme) => {
      const normalizedTheme = normalizeThemePreference(theme);
      writeSafeLocalStorage("zcode-theme", normalizedTheme);
      syncSystemThemeListener(normalizedTheme);
      applyTheme(normalizedTheme);

      set({ theme: normalizedTheme });
    },

    codePreviewSettings: loadCodePreviewSettings(),
    setCodePreviewSettings: (patch: Partial<CodePreviewSettings>) =>
      set((state) => {
        const next = {
          ...state.codePreviewSettings,
          ...patch,
          fontSizePx:
            typeof patch.fontSizePx === "number"
              ? Math.min(20, Math.max(12, Math.round(patch.fontSizePx)))
              : state.codePreviewSettings.fontSizePx,
        };
        writeSafeLocalStorage(CODE_PREVIEW_SETTINGS_KEY, JSON.stringify(next));
        return { codePreviewSettings: next };
      }),

    uiFontSizePx: loadUiFontSizePx(),
    setUiFontSizePx: (fontSizePx: number) => {
      const normalizedFontSizePx = normalizeUiFontSizePx(fontSizePx);
      writeSafeLocalStorage(UI_FONT_SIZE_STORAGE_KEY, String(normalizedFontSizePx));
      applyUiFontSizePx(normalizedFontSizePx);
      set({ uiFontSizePx: normalizedFontSizePx });
    },

    performanceMode: loadPerformanceMode(),
    setPerformanceMode: (enabled: boolean) => {
      writeSafeLocalStorage(PERFORMANCE_MODE_STORAGE_KEY, enabled ? "true" : "false");
      set({ performanceMode: enabled });
    },

    notificationEnabled: isTaskNotificationEnabled(),
    setNotificationEnabled: (enabled: boolean) => {
      persistTaskNotificationEnabled(enabled);
      set({ notificationEnabled: enabled });
    },

    notificationSoundEnabled: isTaskNotificationSoundPreferenceEnabled(),
    setNotificationSoundEnabled: (enabled: boolean) => {
      persistTaskNotificationSoundEnabled(enabled);
      set({ notificationSoundEnabled: enabled });
    },

    user: null,
    authSessionSeq: 0,
    setUser: (user: UserInfo | null) =>
      set((state) => ({
        user,
        authSessionSeq:
          state.user === null && user !== null ? state.authSessionSeq + 1 : state.authSessionSeq,
      })),

    isRestoringOAuthSession: options.initialIsRestoringOAuthSession ?? false,
    setIsRestoringOAuthSession: (restoring: boolean) => set({ isRestoringOAuthSession: restoring }),

    oauthError: null,
    setOAuthError: (error: string | null) => set({ oauthError: error }),
    oauthPollingActive: false,
    setOAuthPollingActive: (active: boolean) => set({ oauthPollingActive: active }),
    oauthSuccessSeq: 0,
    lastOAuthSuccessProvider: null,
    markOAuthSuccess: (provider?: OAuthProviderId) =>
      set((state) => ({
        oauthSuccessSeq: state.oauthSuccessSeq + 1,
        lastOAuthSuccessProvider: provider ?? state.lastOAuthSuccessProvider,
      })),
    apiKeyLoginSuccessSeq: 0,
    lastApiKeyLoginModel: null,
    markApiKeyLoginSuccess: (preferredModel?: string | null) =>
      set((state) => ({
        apiKeyLoginSuccessSeq: state.apiKeyLoginSuccessSeq + 1,
        lastApiKeyLoginModel: preferredModel?.trim() || null,
      })),
    loginEntryRequest: null,
    loginEntryAttempt: null,
    requestLoginEntry: (providerId?: OAuthProviderId, purpose?: LoginEntryPurpose) => {
      const id = ++loginEntryRequestSeq;
      const attempt: LoginEntryAttempt = {
        id,
        providerId,
        purpose,
        status: "requested",
      };
      set({
        loginEntryRequest: {
          id,
          providerId,
          purpose,
        },
        loginEntryAttempt: attempt,
      });
      return id;
    },
    clearLoginEntryRequest: (requestId?: number) =>
      set((state) => {
        if (requestId !== undefined && state.loginEntryRequest?.id !== requestId) {
          return {};
        }
        return { loginEntryRequest: null };
      }),
    markLoginEntryAttemptStatus: (requestId, status) =>
      set((state) => {
        if (state.loginEntryAttempt?.id !== requestId) {
          return {};
        }
        return {
          loginEntryAttempt: {
            ...state.loginEntryAttempt,
            status,
          },
        };
      }),

    codingPlanQuotaResetUiBySource: {},
    codingPlanQuotaResetAutomaticObservationsBySource: {},
    codingPlanQuotaResetAutoPlayedBySource: {},
    ...createCodingPlanQuotaResetStoreActions({
      broadcastService,
      readState: get,
      writeState: (updater) => set((state) => updater(state)),
    }),

    newUserOnboardingOpen: false,
    setNewUserOnboardingOpen: (open) => set({ newUserOnboardingOpen: open }),
    onboardingDialogRequested: false,
    requestOnboardingDialog: (entry) => set({ onboardingDialogRequested: entry ?? true }),
    clearOnboardingDialogRequest: () => set({ onboardingDialogRequested: false }),
  }));

  syncSystemThemeListener = (theme: Theme) => {
    cleanupSystemThemeListener?.();
    cleanupSystemThemeListener = null;

    if (theme !== "system" || typeof window === "undefined") {
      return;
    }

    const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
    const handleSystemThemeChange = () => {
      if (useStore.getState().theme !== "system") {
        return;
      }

      // System mode requires continuous subscription to system light and dark changes and cannot be applied only once when switching to system.
      // Otherwise, when the user switches to the system theme, the dark class on the DOM will not be updated synchronously, and it will look like "following the system failure".
      applyTheme("system");
    };

    if (typeof mediaQuery.addEventListener === "function") {
      mediaQuery.addEventListener("change", handleSystemThemeChange);
      cleanupSystemThemeListener = () => {
        mediaQuery.removeEventListener("change", handleSystemThemeChange);
      };
      return;
    }

    // Some Electron / Chromium combinations still only support the legacy MediaQueryList listener API.
    // If you only call addEventListener here, you will not receive any notification when switching the system theme in system mode.
    mediaQuery.addListener(handleSystemThemeChange);
    cleanupSystemThemeListener = () => {
      mediaQuery.removeListener(handleSystemThemeChange);
    };
  };

  // Zustand v5's setState uses different overloads on replace=true/false,
  // Previously, if you directly wrap one layer and pass replace transparently, you will fall into mutually incompatible signature branches under strict types.
  // Here it is changed to broadcast after subscribing to status changes. Only the fields that really need to be synchronized across windows are compared. The logic is more intuitive and overload conflicts are avoided.
  useStore.subscribe((state, prevState) => {
    if (applyingBroadcast) {
      return;
    }

    for (const field of BROADCAST_FIELDS as Set<BroadcastField>) {
      if (state[field] === prevState[field]) {
        continue;
      }

      broadcastService.send({
        channel: `${STATE_CHANNEL_PREFIX}${field}`,
        payload: state[field],
      });
    }
  });

  // Listen for broadcasts from other windows
  broadcastService.onMessage((msg: BroadcastMessage) => {
    // Automatically complete "play multiple windows only once". After other windows broadcast used_at, this window merges
    // played records and collapses the same used_at prompt that is being played; local echoes have been ignored during the parsing phase.
    const autoPlayed = parseCodingPlanQuotaResetAutoPlayedBroadcastMessage(msg);
    if (autoPlayed) {
      useStore.setState((state) => applyCodingPlanQuotaResetAutoPlayedBroadcast(state, autoPlayed));
      return;
    }

    if (!msg.channel.startsWith(STATE_CHANNEL_PREFIX)) return;

    const field = msg.channel.slice(STATE_CHANNEL_PREFIX.length) as BroadcastField;
    if (!BROADCAST_FIELDS.has(field)) return;

    applyingBroadcast = true;
    try {
      // Call the corresponding setter to ensure that side effects (localStorage, DOM) are also executed
      const state = useStore.getState();
      if (field === "theme" && typeof msg.payload === "string") {
        state.setTheme(msg.payload as Theme);
      } else if (
        field === "interfaceMode" &&
        (msg.payload === "office" || msg.payload === "coding")
      ) {
        state.setInterfaceMode(normalizeInterfaceMode(msg.payload));
      } else if (field === "uiFontSizePx" && typeof msg.payload === "number") {
        state.setUiFontSizePx(msg.payload);
      }
    } finally {
      applyingBroadcast = false;
    }
  });

  syncSystemThemeListener(useStore.getState().theme);
  applyTheme(useStore.getState().theme);
  applyUiFontSizePx(useStore.getState().uiFontSizePx);
  document.documentElement.classList.toggle(
    "dark",
    resolveTheme(useStore.getState().theme) === "dark",
  );

  return useStore;
}

export type ZCodeStore = ReturnType<typeof createZCodeStore>;
