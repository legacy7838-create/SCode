const PLAYWRIGHT_DEFAULT_TIMEOUT_MS = 3_000;

/**
 * The built-in browser uses a short failure budget for ordinary Playwright operations: 3s by
 * default, with the call site supplying the upper bound. The old IAB went straight to 30s, which
 * caused long useless polling loops after a mis-guessed locator; a single normalizer keeps the
 * adapters from drifting apart again.
 */
export function normalizePlaywrightTimeout(
  timeoutMs: number | undefined,
  max = PLAYWRIGHT_DEFAULT_TIMEOUT_MS,
): number {
  const requested = typeof timeoutMs === "number" ? timeoutMs : PLAYWRIGHT_DEFAULT_TIMEOUT_MS;
  return Math.min(Math.max(0, requested), max || PLAYWRIGHT_DEFAULT_TIMEOUT_MS);
}
