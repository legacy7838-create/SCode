import type { BrowserPageState } from "@zcode/shared";
import type { ControlledViewWebContents } from "./browserCommandTypes.js";

/**
 * The default navigation budget for navigate commands is 10s. A timeout or a real `loadURL`
 * failure must return a failure result — swallowing the error and faking success would leave the
 * model building locators on top of an error page.
 */
export const DEFAULT_NAVIGATE_SETTLE_MS = 10_000;

export class BrowserNavigationTimeoutError extends Error {
  override name = "BrowserNavigationTimeoutError";
}

/**
 * Browser navigation allowlist: only http/https and the exact `about:blank`.
 * Arbitrary `about:*` URLs must never be let through.
 */
export function isAllowedBrowserUrl(rawUrl: string): boolean {
  if (rawUrl === "about:blank") return true;
  try {
    const u = new URL(rawUrl);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

export function now(): number {
  return Date.now();
}

export function readState(wc: ControlledViewWebContents): BrowserPageState {
  return {
    url: safe(() => wc.getURL(), ""),
    title: safe(() => wc.getTitle(), ""),
    canGoBack: safe(() => wc.canGoBack(), false),
    canGoForward: safe(() => wc.canGoForward(), false),
  };
}

/** Races `loadURL` against the timeout/cancellation; only real completion counts as a successful navigation. */
export async function settleNavigation(
  loadPromise: Promise<void>,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted) throw new DOMException("aborted", "AbortError");
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new BrowserNavigationTimeoutError(`Navigation timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );
  });
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(new DOMException("aborted", "AbortError"));
    signal?.addEventListener("abort", onAbort, { once: true });
  });
  try {
    await Promise.race([loadPromise, timeout, aborted]);
  } finally {
    if (timer) clearTimeout(timer);
    if (onAbort) signal?.removeEventListener("abort", onAbort);
  }
}

function safe<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}
