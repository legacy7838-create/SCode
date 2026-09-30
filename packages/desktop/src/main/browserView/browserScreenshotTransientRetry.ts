/** Chromium throws UnknownVizError when CopyFromSurface runs before the Viz surface is established; once the
 * surface exists, the same request succeeds immediately. Every other failure (guest destroyed, cross-window, …) is fatal. */
export function isTransientScreenshotCaptureError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("UnknownVizError");
}

interface ScreenshotTransientRetryContext {
  target: "owner" | "guest";
  windowId: number;
  webContentsId: number;
}

const TRANSIENT_CAPTURE_RETRY_DELAY_MS = 100;
// The budget must be less than the 3s timeout for surface prepare (BROWSER_SCREENSHOT_SURFACE_PREPARE_TIMEOUT_MS),
// Leave margin for renderer handshake.
const TRANSIENT_CAPTURE_RETRY_BUDGET_MS = 2_000;

/**
 * Transient retry budget for probes during the prepare phase: UnknownVizError counts as transient
 * and the caller retries it serially with backoff; once consecutive failures accumulate past the
 * budget it gives up (falling back to fail-fast invalidate semantics). Any success resets the count.
 */
export class DesktopBrowserScreenshotTransientRetry {
  private startedAt: number | undefined;
  private attempts = 0;

  constructor(
    private readonly options: {
      delayMs?: number;
      budgetMs?: number;
      log?(message: string): void;
    } = {},
  ) {}

  retryDelayMs(): number {
    return this.options.delayMs ?? TRANSIENT_CAPTURE_RETRY_DELAY_MS;
  }

  /** Records one transient failure; returns false when the budget is exhausted and retrying stops. */
  schedule(context: ScreenshotTransientRetryContext): boolean {
    this.startedAt ??= Date.now();
    this.attempts += 1;
    if (
      Date.now() - this.startedAt >=
      (this.options.budgetMs ?? TRANSIENT_CAPTURE_RETRY_BUDGET_MS)
    ) {
      this.options.log?.(
        `[browser-screenshot-activity] transient capture retry budget exhausted target=${context.target} windowId=${context.windowId} webContentsId=${context.webContentsId} attempts=${this.attempts}`,
      );
      return false;
    }
    this.options.log?.(
      `[browser-screenshot-activity] transient capture retry scheduled target=${context.target} windowId=${context.windowId} webContentsId=${context.webContentsId} attempt=${this.attempts} delayMs=${this.retryDelayMs()}`,
    );
    return true;
  }

  reset(): void {
    this.startedAt = undefined;
    this.attempts = 0;
  }
}
