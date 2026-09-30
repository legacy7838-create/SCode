// High-frequency event throttling for sessions-index fan-out.
// Pure scheduling: window status and timer here, publish is injected by the caller, and the gateway only retains the call point.
//
// The Workflow progress event will update record.updatedAt; if each summary is published immediately, the Host and renderer will press
// Engine event frequency recalculation task list. Therefore, progress updates within the merge window are controlled to control the release frequency of the task index.

/** The fan-out window for workflow progress events: progress inside the window is coalesced into one publish at the end of the window (sidebar run row ≤4Hz). */
export const WORKFLOW_PROGRESS_INDEX_FANOUT_MS = 250;

/** The timer handle is opaque to the scheduling logic: setTimeout by default, but callers may supply an implementation. */
export type FanoutTimerHandle = unknown;

export interface SessionsIndexFanoutThrottleOptions {
  /** Publishes a session's current summary to sessions-index (the gateway's publishCurrentSummaryToIndex). */
  publish: (sessionId: string) => void;
  windowMs?: number;
  setTimer?: (callback: () => void, delayMs: number) => FanoutTimerHandle;
  clearTimer?: (handle: FanoutTimerHandle) => void;
}

interface WindowState {
  /** Whether there is still unpublished progress inside the window; falls back to false once any immediate publish has satisfied it. */
  pending: boolean;
  handle: FanoutTimerHandle;
}

function defaultSetTimer(callback: () => void, delayMs: number): FanoutTimerHandle {
  const timer = setTimeout(callback, delayMs);
  // CLI process exit will not be hung by the throttling window (same attitude as scheduleFlush).
  timer.unref?.();
  return timer;
}

function defaultClearTimer(handle: FanoutTimerHandle): void {
  clearTimeout(handle as ReturnType<typeof setTimeout>);
}

/**
 * leading + trailing window throttle, with a separate window per session:
 * The first request after silence publishes immediately and opens the window; later requests inside the window only set pending, and are coalesced into one publish at the end of the window.
 * If there really is pending at the end of the window, publish and renew the window, guaranteeing at most one frame per window during a burst; if there is none, close the window,
 * and the next request goes through the leading edge again.
 */
export class SessionsIndexFanoutThrottle {
  private readonly windows = new Map<string, WindowState>();
  private readonly publish: (sessionId: string) => void;
  private readonly windowMs: number;
  private readonly setTimer: (callback: () => void, delayMs: number) => FanoutTimerHandle;
  private readonly clearTimer: (handle: FanoutTimerHandle) => void;

  constructor(options: SessionsIndexFanoutThrottleOptions) {
    this.publish = options.publish;
    this.windowMs = options.windowMs ?? WORKFLOW_PROGRESS_INDEX_FANOUT_MS;
    this.setTimer = options.setTimer ?? defaultSetTimer;
    this.clearTimer = options.clearTimer ?? defaultClearTimer;
  }

  /** A publish request from a high-frequency event: publish immediately (leading) or fold into the single publish at the end of the window (trailing). */
  request(sessionId: string): void {
    const open = this.windows.get(sessionId);
    if (open) {
      open.pending = true;
      return;
    }
    this.openWindow(sessionId);
    this.publish(sessionId);
  }

  /**
   * Any immediate publish (a non-progress event, a hydration replay, etc.) already carries the progress coalesced inside the window,
   * so the pending trailing is satisfied by it: just clear pending, keep the window throttled, and do not append another empty delta frame.
   */
  notePublished(sessionId: string): void {
    const open = this.windows.get(sessionId);
    if (open) open.pending = false;
  }

  /** Session runtime cleanup: the window timers must disappear along with it (cleanupSessionRuntime). */
  clearSession(sessionId: string): void {
    const open = this.windows.get(sessionId);
    if (!open) return;
    this.clearTimer(open.handle);
    this.windows.delete(sessionId);
  }

  /** Gateway dispose: clears all window timers. */
  clear(): void {
    for (const open of this.windows.values()) this.clearTimer(open.handle);
    this.windows.clear();
  }

  private openWindow(sessionId: string): void {
    this.windows.set(sessionId, {
      pending: false,
      handle: this.setTimer(() => this.onWindowElapsed(sessionId), this.windowMs),
    });
  }

  private onWindowElapsed(sessionId: string): void {
    const open = this.windows.get(sessionId);
    if (!open) return;
    if (!open.pending) {
      // There is no new progress in the window → Close the window; the next progress will be posted again immediately.
      this.windows.delete(sessionId);
      return;
    }
    // Extend the window first and then publish: publish will call back notePublished, and the status must be a new window.
    open.pending = false;
    open.handle = this.setTimer(() => this.onWindowElapsed(sessionId), this.windowMs);
    this.publish(sessionId);
  }
}
