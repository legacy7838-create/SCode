import type { ArmsCustomEventPayload } from "@zcode/shared";
import { shouldExposeE2EStoreBridge } from "@/lib/e2eStoreBridge.js";

interface ArmsCustomEventE2EEntry extends ArmsCustomEventPayload {
  recordedAt: number;
}

const MAX_ARMS_CUSTOM_EVENT_ENTRIES = 200;

type ArmsCustomEventDebugWindow = Window & {
  __zcodeArmsCustomEventsE2E?: ArmsCustomEventE2EEntry[];
};

/**
 * E2E builds only: records the ARMS payloads the renderer actually submits to the desktop bridge.
 * The buffer stays bounded, and production builds never create the window field, so there is no
 * second persistence or replay channel.
 */
export function recordArmsCustomEventForE2E(
  payload: ArmsCustomEventPayload,
  options: {
    enabled?: boolean;
    host?: ArmsCustomEventDebugWindow;
    now?: () => number;
  } = {},
): void {
  const enabled = options.enabled ?? shouldExposeE2EStoreBridge();
  if (!enabled || (typeof window === "undefined" && !options.host)) return;

  const host = options.host ?? (window as ArmsCustomEventDebugWindow);
  const buffer = (host.__zcodeArmsCustomEventsE2E ??= []);
  buffer.push({
    ...payload,
    ...(payload.properties ? { properties: { ...payload.properties } } : {}),
    recordedAt: (options.now ?? Date.now)(),
  });
  if (buffer.length > MAX_ARMS_CUSTOM_EVENT_ENTRIES) {
    buffer.splice(0, buffer.length - MAX_ARMS_CUSTOM_EVENT_ENTRIES);
  }
}
