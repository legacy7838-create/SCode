export const DEFAULT_BROWSER_URL = "about:blank";

const RECOVERABLE_BROWSER_GUEST_EXIT_REASONS = new Set([
  "abnormal-exit",
  "killed",
  "crashed",
  "oom",
  "memory-eviction",
]);

/**
 * Restores in place only a guest that had already been running but was terminated abnormally by
 * Chromium.
 *
 * Previously only the `<webview>` DOM was kept, which did not cover the case where its renderer is
 * terminated by the system; but a launch/integrity failure is not “the original page being
 * reclaimed”, so blindly rebuilding would only form an infinite loop.
 */
export function isRecoverableBrowserGuestExitReason(reason: string): boolean {
  return RECOVERABLE_BROWSER_GUEST_EXIT_REASONS.has(reason);
}

// Electron <webview> tag synchronous methods (getURL/canGoBack/loadURL/executeJavaScript etc.) throw these two types of errors synchronously
// when the guest is not yet attached (before dom-ready) or when the guest frame is being destroyed/re-attached.
// These are expected races in the webview lifecycle, not real business exceptions. If left to be reported
// via the window.onerror global fallback, a single source would consume a massive exception volume; they must be contained at the call boundary.
const WEBVIEW_DETACHED_ERROR_FRAGMENTS = [
  "must be attached to the DOM",
  "Render frame was disposed",
] as const;

function isWebviewDetachedError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  if (!message) {
    return false;
  }
  return WEBVIEW_DETACHED_ERROR_FRAGMENTS.some((fragment) => message.includes(fragment));
}

/**
 * Safely performs one synchronous webview call:
 * - normally it returns the call result;
 * - when it hits a lifecycle race error such as “guest not mounted / frame destroyed”, it swallows
 *   the error and returns a fallback, optionally recording it via onDetached (for debug-level
 *   logging rather than for silence);
 * - all other errors keep propagating upward, so real bugs are never masked.
 */
export function safeWebviewCall<T>(
  call: () => T,
  fallback: T,
  onDetached?: (error: unknown) => void,
): T {
  try {
    return call();
  } catch (error) {
    if (isWebviewDetachedError(error)) {
      onDetached?.(error);
      return fallback;
    }
    throw error;
  }
}

const ALLOWED_BROWSER_PROTOCOLS = new Set(["about:", "data:", "file:", "http:", "https:"]);

const URL_PROTOCOL_RE = /^[a-zA-Z][a-zA-Z\d+.-]*:/;
const IPV4_RE = /^\d{1,3}(?:\.\d{1,3}){3}$/;

export interface BrowserGuestFailure {
  exitCode: number;
  reason: string;
}

export interface BrowserState {
  canGoBack: boolean;
  canGoForward: boolean;
  currentUrl: string;
  errorMessage: string | null;
  /**
   * Chromium net error codes for a main frame load failure.
   *
   * Electron's `<webview>` has no Chrome security interstitial, so a blocked navigation only lands
   * on a blank chrome-error page and the user sees pure black. The error code has to enter the
   * state together with errorMessage, otherwise it is impossible to render a readable error state
   * and to give certificate-type failures a pass-through instruction.
   */
  loadErrorCode: number | null;
  /**
   * Process-level failures where the guest never made it on screen; kept separate from load errors
   * that can render a readable error state.
   */
  guestFailure: BrowserGuestFailure | null;
  isLoading: boolean;
  isReady: boolean;
  title: string;
}

export interface BrowserNavigationRequest {
  id: string;
  url: string;
}

export const INITIAL_BROWSER_STATE: BrowserState = {
  canGoBack: false,
  canGoForward: false,
  currentUrl: DEFAULT_BROWSER_URL,
  errorMessage: null,
  loadErrorCode: null,
  guestFailure: null,
  isLoading: false,
  isReady: false,
  title: "",
};

/**
 * The Chromium certificate error code range (ERR_CERT_COMMON_NAME_INVALID …
 * ERR_CERT_KNOWN_INTERCEPTION_BLOCKED).
 */
const CERTIFICATE_LOAD_ERROR_CODE_MIN = -217;
const CERTIFICATE_LOAD_ERROR_CODE_MAX = -200;

/**
 * Determines whether a load failure originates from a certificate problem.
 *
 * Only certificate-type failures get the “you can turn on ignoring certificate validation” hint;
 * offering that instruction for DNS, connection refused and similar failures would mislead the
 * user.
 */
export function isCertificateBrowserLoadErrorCode(code: number | null | undefined): boolean {
  if (typeof code !== "number") return false;
  return code >= CERTIFICATE_LOAD_ERROR_CODE_MIN && code <= CERTIFICATE_LOAD_ERROR_CODE_MAX;
}

export function isAllowedBrowserUrl(url: string): boolean {
  try {
    return ALLOWED_BROWSER_PROTOCOLS.has(new URL(url).protocol);
  } catch {
    return false;
  }
}

/**
 * The system default browser entry accepts Web URLs and file URLs, so it cannot reuse the built-in
 * browser's wider local/inline protocol allowlist.
 */
export function isDefaultBrowserOpenableUrl(url: string): boolean {
  try {
    const protocol = new URL(url).protocol;
    return protocol === "http:" || protocol === "https:" || protocol === "file:";
  } catch {
    return false;
  }
}

function hasAllowedExplicitProtocol(input: string): boolean {
  const protocol = input.match(URL_PROTOCOL_RE)?.[0].toLowerCase();
  return protocol ? ALLOWED_BROWSER_PROTOCOLS.has(protocol) : false;
}

function hasDisallowedExplicitProtocol(input: string): boolean {
  const match = input.match(URL_PROTOCOL_RE);
  if (!match) {
    return false;
  }

  const protocol = match[0].toLowerCase();
  if (ALLOWED_BROWSER_PROTOCOLS.has(protocol)) {
    return false;
  }

  return !/^\d{1,5}(?:$|[/?#])/.test(input.slice(match[0].length));
}

function parseSchemeLessUrl(input: string): URL | null {
  try {
    const normalizedInput = normalizeBareIpv6LoopbackInput(input);
    return new URL(
      normalizedInput.startsWith("//") ? `http:${normalizedInput}` : `http://${normalizedInput}`,
    );
  } catch {
    return null;
  }
}

function normalizeBareIpv6LoopbackInput(input: string): string {
  if (input === "::1") {
    return "[::1]";
  }

  if (/^::1(?=[:/?#])/.test(input)) {
    return `[::1]${input.slice(3)}`;
  }

  return input;
}

function getSchemeLessExplicitPort(input: string): string | null {
  const normalizedInput = normalizeBareIpv6LoopbackInput(input);
  const withoutLeadingSlashes = normalizedInput.startsWith("//")
    ? normalizedInput.slice(2)
    : normalizedInput;
  const authority = withoutLeadingSlashes.split(/[/?#]/, 1)[0] ?? "";
  const hostWithPort = authority.split("@").at(-1) ?? authority;

  if (hostWithPort.startsWith("[")) {
    return hostWithPort.match(/^\[[^\]]+\]:(\d+)$/)?.[1] ?? null;
  }

  const portMatch = hostWithPort.match(/:(\d+)$/);
  if (!portMatch) {
    return null;
  }

  const host = hostWithPort.slice(0, portMatch.index);
  return host.includes(":") ? null : (portMatch[1] ?? null);
}

function parseIpv4Address(host: string): [number, number, number, number] | null {
  if (!IPV4_RE.test(host)) {
    return null;
  }

  const octets = host.split(".").map((part) => Number(part));
  if (octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) {
    return null;
  }

  return octets as [number, number, number, number];
}

function isLocalhostName(host: string): boolean {
  return host === "localhost" || host === "localhost.localdomain" || host.endsWith(".localhost");
}

function isLocalDevelopmentHost(host: string): boolean {
  const normalizedHost = host.toLowerCase().replace(/^\[(.*)]$/, "$1");
  if (
    isLocalhostName(normalizedHost) ||
    normalizedHost === "::1" ||
    normalizedHost === "0:0:0:0:0:0:0:1" ||
    normalizedHost.endsWith(".local") ||
    normalizedHost.endsWith(".test")
  ) {
    return true;
  }

  const ipv4 = parseIpv4Address(normalizedHost);
  if (!ipv4) {
    return false;
  }

  const [first, second, third, fourth] = ipv4;
  return (
    first === 127 ||
    (first === 0 && second === 0 && third === 0 && fourth === 0) ||
    first === 10 ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168) ||
    (first === 169 && second === 254)
  );
}

function isLocalDevelopmentBrowserUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return false;
    }

    return isLocalDevelopmentHost(parsed.hostname);
  } catch {
    return false;
  }
}

type MessageLinkOpenTarget = "app-browser" | "external-browser";

/**
 * Interaction semantics: the two context-menu items are explicitly complementary target choices,
 * and only a left click runs the local/private-network heuristic. The menu's “Open” used to reuse
 * the left-click default behavior, so for public-network links (such as Feishu docs) both items
 * would jump out to the system browser.
 */
export function resolveMessageLinkOpenTarget(input: {
  href: string;
  forceExternal?: boolean;
  forceInApp?: boolean;
}): MessageLinkOpenTarget {
  // When both flags are passed, forceExternal takes precedence to avoid callers combining ambiguous states.
  if (input.forceExternal) {
    return "external-browser";
  }

  if (input.forceInApp) {
    return "app-browser";
  }

  return isLocalDevelopmentBrowserUrl(input.href) ? "app-browser" : "external-browser";
}

function shouldPreferHttpForSchemeLessUrl(parsed: URL, explicitPort: string | null): boolean {
  if (isLocalDevelopmentHost(parsed.hostname)) {
    return true;
  }

  if (explicitPort && explicitPort !== "443") {
    return true;
  }

  return false;
}

function inferBrowserUrl(input: string): string {
  const normalizedInput = normalizeBareIpv6LoopbackInput(input);
  const parsed = parseSchemeLessUrl(normalizedInput);
  const protocol =
    parsed && shouldPreferHttpForSchemeLessUrl(parsed, getSchemeLessExplicitPort(normalizedInput))
      ? "http"
      : "https";
  return normalizedInput.startsWith("//")
    ? `${protocol}:${normalizedInput}`
    : `${protocol}://${normalizedInput}`;
}

export function normalizeBrowserUrl(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) {
    return null;
  }

  // The address bar previously prepended https:// to all protocol-less input, making localhost,
  // 127.0.0.1, and common dev ports impossible to open directly. Here we follow browser address bar conventions
  // by first identifying local/private-network/with-port addresses and defaulting to HTTP; public domains still keep HTTPS priority.
  if (hasDisallowedExplicitProtocol(trimmed)) {
    return null;
  }

  const url = hasAllowedExplicitProtocol(trimmed) ? trimmed : inferBrowserUrl(trimmed);
  return isAllowedBrowserUrl(url) ? url : null;
}

export function displayBrowserUrl(url: string): string {
  return url === DEFAULT_BROWSER_URL ? "" : url;
}
