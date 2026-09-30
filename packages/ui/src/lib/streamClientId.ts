/**
 * Device identifier — a singleton cached within the renderer process
 *
 * Generation strategy:
 * - Desktop: use the deviceMid provided by the main process (a SHA-256 over the userData path,
 *   stable and unique)
 * - Mobile (Web remote control): use a physical-property fingerprint (browserPlatform +
 *   screen.width/height + colorDepth), which resists browser/network/language/timezone changes and
 *   only changes when the phone is swapped
 */
import { createUuid } from "@zcode/shared";

let cachedStreamClientId: string | null = null;

/**
 * Sets the stable device ID (supplied by platform.getDeviceId()). Must be called before the first
 * call to getStreamClientId().
 */
export function setStreamClientId(deviceId: string): void {
  const normalizedDeviceId = deviceId.trim();
  if (!normalizedDeviceId) {
    // If deviceId writes an empty string when injecting an exception, all instances will share "renderer:".
    // owner/observer filtering will misjudge the same client. This falls back to a stable random value within the process to avoid cross-instance collisions.
    cachedStreamClientId = cachedStreamClientId ?? `renderer:fallback-${createUuid()}`;
    return;
  }
  cachedStreamClientId = `renderer:${normalizedDeviceId}`;
}

/**
 * Generates the mobile physical-property fingerprint. Used on mobile to derive a stable device ID
 * on its own before platform.getDeviceId() returns.
 */
export function generateMobileDeviceFingerprint(): string {
  const nav = globalThis.navigator as Navigator & { platform?: string };
  const platform = nav?.platform ?? "";
  const screenWidth = globalThis.screen?.width;
  const screenHeight = globalThis.screen?.height;
  const colorDepth = globalThis.screen?.colorDepth;
  const parts = [
    platform,
    screenWidth !== undefined ? String(screenWidth) : "",
    screenHeight !== undefined ? String(screenHeight) : "",
    colorDepth !== undefined ? String(colorDepth) : "",
  ];
  return parts.filter(Boolean).join("|");
}
