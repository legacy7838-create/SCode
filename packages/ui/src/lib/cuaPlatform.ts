import type { IPlatformService } from "@zcode/shared";

// Only macOS has TCC permissions, authorized booting and Helper status polling; Windows local desktop can only be reused
// zcode-cua plug-in master switch, does not read TCC or Helper status. Linux, ordinary Web and mobile phone remote control do not display computer control settings.
// Therefore, permission pop-ups, pre-checks and Helper status polling must first determine that the local computer is macOS desktop.
// Use navigator.userAgent to determine and explicitly exclude iOS (UA for iPhone/iPad contains Macintosh substring).
//
// Changed from module-level constants to lazy functions. The original constant is evaluated when the module is imported, resulting in a single test based on the UA branch.
// Unable to cover multiple platforms within the same process (changing navigator.userAgent has no effect on evaluated constants). Runtime behavioral equivalence -
// In the real environment, UA will not change midway.
function isMacOsDesktopUserAgent(): boolean {
  return (
    typeof navigator !== "undefined" &&
    /Macintosh|Mac OS X/.test(navigator.userAgent) &&
    !/iPhone|iPad|iPod/.test(navigator.userAgent)
  );
}

function isWindowsDesktopUserAgent(): boolean {
  return typeof navigator !== "undefined" && /Windows/i.test(navigator.userAgent);
}

/**
 * The real platform-capability gate for the CUA permission UI.
 *
 * Looking at the UA alone would misread macOS Safari/Web as desktop and open a permission dialog
 * that cannot execute any native IPC. The desktop preload injects the onboarding method only when
 * that capability exists, so the UA and the capability must both be satisfied.
 */
export function supportsLocalMacCuaPermissionOnboarding(
  platform: Pick<IPlatformService, "openCuaPermissionOnboarding"> | null | undefined,
): boolean {
  return isMacOsDesktopUserAgent() && typeof platform?.openCuaPermissionOnboarding === "function";
}

/**
 * The CUA capability gate for a local Windows desktop (symmetric to the mac gate above).
 *
 * Windows has no TCC and does not read Helper permissions, so openCuaPermissionOnboarding cannot
 * serve as the capability criterion; executeDesktopCommand is used instead — it is injected only by
 * the desktop preload, which rules out an ordinary browser on Windows.
 */
export function supportsLocalWindowsCuaEntry(
  platform: Pick<IPlatformService, "executeDesktopCommand"> | null | undefined,
): boolean {
  return isWindowsDesktopUserAgent() && typeof platform?.executeDesktopCommand === "function";
}
