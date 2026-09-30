/**
 * State derivation for the CUA composer's resident entry button (a zero-dependency pure function).
 *
 * Why it is extracted as a pure function: the state combination is the cartesian product of
 * "platform × hidden toggle × plugin state × permission state × session busy"; inside a component
 * or hook the only way to test it is to build store mocks, which cannot cover the whole product.
 * Nothing here imports React or reads a store — every input is injected by the caller
 * (useCuaComposerEntry).
 */
import { isCuaPermissionStatusAvailable, type CuaPermissionStatusResult } from "@zcode/services";
import { isCuaPermissionTccGranted } from "@/lib/cuaPermissionStatusStore.js";
import type { StatusDotTone } from "@/settings/StatusDot.js";

/**
 * The 4 UI states exposed outward; the finer internal states are only used for logging and are
 * never exposed to the user.
 *
 * There is no "disabled" (plugin not enabled) state: now that computer use is off by default, "not
 * enabled" no longer renders as a grey dot that pulls a fresh version — the entry is not rendered
 * at all (see the plugin gate in isEntryVisible), which makes that state unreachable.
 */
export type CuaComposerEntryUiState =
  | "starting"
  /**
   * Lazy start: the Helper is not running (a normal idle state, it auto-starts on first use) — a
   * neutral grey dot, not an error.
   */
  | "idle"
  | "permission-required"
  | "ready"
  | "error";

interface CuaComposerEntryInputs {
  /** Local macOS desktop with CUA onboarding capability (judged by both UA + preload capability). */
  macLocalDesktop: boolean;
  /** Local Windows desktop. */
  windowsLocalDesktop: boolean;
  /**
   * The Settings page option "show the computer-use button in the composer" is off (the internal
   * hidden state).
   */
  hiddenBySettings: boolean;
  /** Whether cuaPermissionService exists; false on a remote host. */
  permissionServiceAvailable: boolean;
  /** Whether the zcode-cua plugin is enabled. */
  pluginEnabled: boolean;
  /** The zcode-cua plugin is mid-toggle. */
  pluginToggling: boolean;
  /** The most recent zcode-cua plugin operation failed. */
  pluginError: boolean;
  /**
   * Helper permission state. The entry does not query permissions and is always null (the idle
   * neutral state); the real value is read only on the Settings page.
   */
  permissionStatus: CuaPermissionStatusResult | null;
  /** A turn of any task in the current workspace is running. */
  sessionBusy: boolean;
}

export type CuaComposerEntryView =
  | { visible: false }
  | {
      visible: true;
      uiState: CuaComposerEntryUiState;
      tone: StatusDotTone;
      spinning: boolean;
      tooltipMessageId: string;
      /**
       * open-settings = jump to the computerUse section of the Settings page; none = hover tooltip
       * only. Every visible state is open-settings; only the session-busy override makes it none
       * (see the comment at the tail of the resolve function).
       */
      clickAction: "open-settings" | "none";
      /**
       * session-busy override: greyed out and unresponsive to clicks. Leaves uiState and tone
       * unchanged.
       */
      interactionDisabled: boolean;
    };

const TOOLTIP_MESSAGE_ID: Record<CuaComposerEntryUiState, string> = {
  idle: "chat.toolbar.computerUse.tooltip.idle",
  starting: "chat.toolbar.computerUse.tooltip.starting",
  "permission-required": "chat.toolbar.computerUse.tooltip.permissionRequired",
  ready: "chat.toolbar.computerUse.tooltip.ready",
  error: "chat.toolbar.computerUse.tooltip.error",
};

const BUSY_TOOLTIP_MESSAGE_ID = "chat.toolbar.computerUse.tooltip.sessionBusy";

/**
 * The four-layer visibility gate. Failing any one of them → no DOM is rendered, rather than a
 * disabled button: leaving a grey button in an unavailable scenario would mislead users into
 * thinking "install it and it works".
 */
function isEntryVisible(inputs: CuaComposerEntryInputs): boolean {
  // Platform door: remote workspace / linux local / ordinary Web / mobile phone remote control are not satisfied.
  if (!inputs.macLocalDesktop && !inputs.windowsLocalDesktop) return false;
  // Setting gate: It will no longer be rendered after the user explicitly hides it, and it will not self-heal due to restart or version update.
  if (inputs.hiddenBySettings) return false;
  // Service Gate: Mac status all comes from Helper; the button cannot reflect any true value when the service is missing.
  // Windows does not have TCC or read Helper permissions, so it is not subject to this gate.
  if (inputs.macLocalDesktop && !inputs.permissionServiceAvailable) return false;
  // The entrance will not be displayed when the computer control plug-in is not enabled to avoid being closed by default or manually closed by the user.
  // The input box still has a gray button used for promotion, making the closed state difficult to identify.
  // The exception is switching: when toggling, pluginEnabled is still the old value before switching. Blocking it all will make "enabled"
  // The spinner disappears into a gap, and the user cannot see any progress when switching back to the session from the settings page.
  if (!inputs.pluginEnabled && !inputs.pluginToggling) return false;
  return true;
}

/**
 * Internal state determination, short-circuiting from the top down (a fixed highest-to-lowest
 * priority).
 *
 * Precondition: the caller has already passed isEntryVisible, so pluginEnabled || pluginToggling
 * necessarily holds here. "Plugin not enabled" is no longer a UI state but a not-rendered case, so
 * this function has no corresponding branch any more.
 */
function resolveUiState(inputs: CuaComposerEntryInputs): CuaComposerEntryUiState {
  // toggling has the highest priority: the intermediate state during the switching process should not be overwritten by the old enabled/permission value.
  // It also captures the only unactivated combination that can pass the plug-in door, which is "unactivated + switching".
  if (inputs.pluginToggling) return "starting";
  if (inputs.pluginError) return "error";

  // Windows does not have TCC: the plug-in is ready when enabled and does not participate in permission determination.
  if (!inputs.macLocalDesktop) return "ready";

  // The lazy start entry does not carry status display, and permissionStatus is always null——
  // There is no intermediate state of "cold start query" (the query will start the Helper on demand, and mounting the query is equivalent to opening the app
  // Just pull up Helper). null is classified into the idle neutral state; the true value is only read in the settings page (query when opening).
  if (inputs.permissionStatus === null) return "idle";

  // Helper is unhealthy (there is no accessibility field in the status) → Error status, corresponding to "Helper startup failed".
  if (!isCuaPermissionStatusAvailable(inputs.permissionStatus)) {
    // The unavailable marked with idle is the normal return packet after the Helper is idle (no access for 300s).
    // Not an error. An error will be reported only if there is a clear failure (no idle mark).
    if ((inputs.permissionStatus as { idle?: true }).idle === true) return "idle";
    return "error";
  }

  // Whether the permissions are available needs to be tested, but the permanent entrance can only be read-only refreshed: the active screenshot probe must be explicit
  // User intent (upstream shouldRunCuaScreenCaptureProbe requires includeFunctionalProbes),
  // screenCaptureProbeOk obtained by background refresh is always false. If it is used to determine readiness, users who have completed authorization will always
  // Stops at the "Lack of macOS permissions" yellow dot. This is the same as the settings page permission line. Instead, use the TCC caliber; when the tool is truly unavailable,
  // Returns a normal error, restored by the model according to the original reason, and the Renderer does not automatically trigger permission guidance.
  return isCuaPermissionTccGranted(inputs.permissionStatus) ? "ready" : "permission-required";
}

export function resolveCuaComposerEntryView(inputs: CuaComposerEntryInputs): CuaComposerEntryView {
  if (!isEntryVisible(inputs)) return { visible: false };

  const uiState = resolveUiState(inputs);
  // session-busy is an interactive overlay: switching plug-ins will change the tool set of all sessions in the workspace.
  // The prompt cache is invalid and the cost is the highest during operation. It does not change uiState/tone and will be automatically restored after all turns are completed.
  // Simplification (user decision-making): The entry of the input box no longer carries the status color point - fixed to be clickable and fixed to the settings page;
  // The status display responsibility is completely handed over to the settings page (open it to start the Helper on demand and read the true value). sessionBusy no longer disables clicks.
  const interactionDisabled = false;

  return {
    visible: true,
    uiState,
    tone: "subtle",
    spinning: uiState === "starting",
    tooltipMessageId: interactionDisabled ? BUSY_TOOLTIP_MESSAGE_ID : TOOLTIP_MESSAGE_ID[uiState],
    // In the past, there were only "not enabled" and
    // permission-required can be clicked, and the three states of ready / starting / error are pure status lights.
    // The online performance is that after the user completes the authorization process and the button turns green, there is no response when clicking again.
    // It reads like it's broken; and the computerUse section of the settings page has things to do in any state - plug-in switches, permission lines,
    // The error details are all there. Therefore, cancel the clickable whitelist, jump when visible, and it will not respond only when session-busy is overridden.
    // (At that time, the button has been grayed out and replaced with a "Session in progress" tooltip. Allowing the jump to continue would be inconsistent with the visual performance).
    clickAction: interactionDisabled ? "none" : "open-settings",
    interactionDisabled,
  };
}
