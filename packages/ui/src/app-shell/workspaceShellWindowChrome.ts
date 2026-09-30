interface WorkspaceShellWindowChromeOptions {
  isMacDesktop?: boolean;
  isWindowsDesktop?: boolean;
  isLinuxDesktop?: boolean;
  macOSMajorVersion?: number | null;
  isWindowsMaximized: boolean;
  supportsNativeRoundedCorners: boolean | null;
}

type WorkspaceShellPlatformRadiusOptions = Pick<
  WorkspaceShellWindowChromeOptions,
  "isMacDesktop" | "isWindowsDesktop" | "isLinuxDesktop" | "macOSMajorVersion"
>;

export function resolveWorkspaceShellPanelRadiusPx({
  isMacDesktop,
  isWindowsDesktop,
  macOSMajorVersion,
}: WorkspaceShellPlatformRadiusOptions): number {
  if (isWindowsDesktop) return 5;
  // Ignoring the macOS version will make Sequoia's inner 12px rounded corners inconsistent with the native window's small rounded corners.
  // Keep 4px as outer space, use 6px for old systems and unknown versions, and use 12px only to clearly identify Tahoe 26+.
  if (isMacDesktop) return (macOSMajorVersion ?? 0) >= 26 ? 12 : 6;
  return 12;
}

export function resolveWorkspaceShellResizeHandleInsetPx(
  options: WorkspaceShellPlatformRadiusOptions,
): number {
  return resolveWorkspaceShellPanelRadiusPx(options) + 4;
}

export function resolveWorkspaceShellWindowChromeClass({
  isMacDesktop,
  isWindowsDesktop,
  isLinuxDesktop,
  macOSMajorVersion,
  supportsNativeRoundedCorners,
}: WorkspaceShellWindowChromeOptions): string {
  // Linux uses xl consistently with the settings page; the panel has an independent blank space and does not bear the outer edge of the system window.
  if (isLinuxDesktop) return "rounded-xl border border-border";
  if (!isWindowsDesktop) {
    const radius = resolveWorkspaceShellPanelRadiusPx({ isMacDesktop, macOSMajorVersion });
    return radius === 6 ? "rounded-[6px] border border-border" : "rounded-xl border border-border";
  }

  if (supportsNativeRoundedCorners === null) {
    // "Unknown" cannot be interpreted directly as Windows 10 when the bridge is unavailable or the first query has not yet completed.
    // Maintain the pre-change style to prevent Win11 from permanently degenerating into a right-angled appearance on the failed path.
    return "rounded-[5px] border border-border";
  }

  if (!supportsNativeRoundedCorners) {
    // Only drawing the right rounded corners uniformly according to the Windows platform will cause problems in Windows 10 which does not support native rounded corners.
    // Forge a layer of window appearance. Only the right outer corner is straightened, and the three original weak borders of the panel cannot be deleted.
    return "rounded-l-[5px] border border-border";
  }

  // The old maximization rules treated the panel as the outer edge of the system window, eliminating rounded corners and three borders.
  // The panel now has an independent 4px white space, and the complete rounded corners and borders must be maintained when maximized.
  // After the outer edge of Windows is reduced by 4px, the 12px rounded corners will form an excessively thick arc-shaped blank space; the layout panel uses 5px uniformly.
  return "rounded-[5px] border border-border";
}
