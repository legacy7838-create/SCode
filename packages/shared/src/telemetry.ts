export interface TelemetryRendererContext {
  clientTimezone: string;
  clientLanguage: string;
  screenResolution: string;
}

export interface TelemetryEventPayload {
  elementName: string;
  eventRegion: string;
  eventType: string;
  eventText?: string;
  eventExtraDetail: Record<string, string>;
  userId?: string;
  talkId?: string;
  messageId?: string;
}

export interface RendererTelemetryEventPayload extends TelemetryEventPayload {
  context: TelemetryRendererContext;
}

export interface ArmsCustomEventPayload {
  name: string;
  group: string;
  value?: number;
  properties?: Record<string, string | number | boolean | undefined>;
}

/** The final arguments desktop main actually passes to armsRum.sendCustom. */
export interface FinalArmsCustomEventPayload {
  name: string;
  type: "custom";
  group: string;
  value: number;
  properties: Record<string, string>;
}

/** In-memory record in the main process, readable only by the E2E test bridge. */
export interface FinalArmsCustomEventE2EEntry {
  sequence: number;
  recordedAt: number;
  payload: FinalArmsCustomEventPayload;
}

export interface ConfigureFinalArmsCustomEventE2ERequest {
  /** A match still enters the ring but does not call the real armsRum.sendCustom. */
  suppressedEventNames: string[];
}

/**
 * Only the hostname may be extracted from a URL before it reaches business telemetry.
 * Invalid values and non-HTTP(S) protocols return an empty string, so a full URL, userinfo, or arbitrary text
 * can never slip into the payload by mistake.
 */
export function resolveSafeTelemetryHostname(value: string | null | undefined): string {
  const normalized = value?.trim();
  if (!normalized) return "";
  try {
    const parsed = new URL(normalized);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return "";
    return parsed.hostname.toLowerCase();
  } catch {
    return "";
  }
}

/** The raw error text may carry secrets in any format; it is dropped wholesale instead of guessing secret boundaries with a regex. */
export function sanitizeTelemetryErrorMessage(value: string | null | undefined): string {
  return value ? "[redacted]" : "";
}

function sanitizeLoginHostname(value: string): string {
  const hostname = resolveSafeTelemetryHostname(value);
  if (hostname) return hostname;
  // When the UI has obtained the hostname, the Core still needs to be idempotent; it only accepts the exact hostname and does not allow non-protocol paths or credentials.
  const normalized = value.trim().toLowerCase();
  return normalized && resolveSafeTelemetryHostname(`https://${normalized}`) === normalized
    ? normalized
    : "";
}

/** Only the reported copy is sanitized; the business error, the authorization address, and the detail held by the caller must not be modified. */
export function sanitizeTelemetryEventDetail(
  elementName: string,
  detail: Readonly<Record<string, string>>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(detail).map(([key, value]) => [
      key,
      key === "error_msg"
        ? sanitizeTelemetryErrorMessage(value)
        : elementName === "app_login_ck" && key === "login_url"
          ? sanitizeLoginHostname(value)
          : value,
    ]),
  );
}

interface TelemetryScreenLike {
  width: number;
  height: number;
}

interface TelemetryWindowLike {
  intlLocale?: string;
  timeZone?: string;
  screen: TelemetryScreenLike;
}

export function collectTelemetryRendererContext(
  options?: TelemetryWindowLike,
): TelemetryRendererContext {
  const resolvedIntlOptions =
    typeof Intl !== "undefined" ? Intl.DateTimeFormat().resolvedOptions() : undefined;
  const timeZone = options?.timeZone ?? resolvedIntlOptions?.timeZone ?? "UTC";
  const clientLanguage = options?.intlLocale ?? resolvedIntlOptions?.locale ?? "en-US";
  const runtimeScreen = (globalThis as { screen?: TelemetryScreenLike }).screen;
  const screen = options?.screen ?? runtimeScreen ?? { width: 0, height: 0 };

  return {
    clientTimezone: timeZone,
    clientLanguage,
    screenResolution: `${screen.width}x${screen.height}`,
  };
}
