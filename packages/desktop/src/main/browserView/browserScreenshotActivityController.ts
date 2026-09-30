import type { BrowserScreenshotActivityLease } from "./browserScreenshotSurfaceContracts.js";
import {
  DesktopBrowserScreenshotTransientRetry,
  isTransientScreenshotCaptureError,
} from "./browserScreenshotTransientRetry.js";
import {
  startBrowserScreenshotTransparentWindowBootstrap,
  TRANSPARENT_WINDOW_PRESENTATION_GRACE_MS,
  type BrowserWindowForTransparentBootstrap,
  type TransparentWindowBootstrap,
} from "./browserTransparentWindowBootstrap.js";

interface BrowserWindowForActivity extends BrowserWindowForTransparentBootstrap {
  webContents: {
    id: number;
    isDestroyed(): boolean;
    capturePage(rect: { x: number; y: number; width: number; height: number }): Promise<unknown>;
  };
}

interface GuestWebContentsForActivity {
  id: number;
  isDestroyed(): boolean;
  readonly hostWebContents: { id: number } | null;
  capturePage(rect: { x: number; y: number; width: number; height: number }): Promise<unknown>;
}

interface ScreenshotActivityState {
  key: string;
  windowId: number;
  webContentsId: number;
  tokens: Map<symbol, { prepared: boolean }>;
  restoreGeneration: number;
  active: boolean;
  invalidationController: AbortController;
  transparentWindowBootstrap?: TransparentWindowBootstrap;
  capturePumpsAllowed: boolean;
  capturePumpStartTimer?: ReturnType<typeof setTimeout>;
  pumps: Record<"owner" | "guest", CapturePumpRuntime>;
}

interface CapturePumpRuntime {
  running: boolean;
  wakeDelay?: () => void;
  transientRetry: DesktopBrowserScreenshotTransientRetry;
}

/** 1×1 detection result: transient means that the Viz surface has not yet established such a self-healing failure. */
type CaptureProbeOutcome = { ok: true } | { ok: false; transient: boolean };

const CAPTURE_PROBE_SUCCEEDED: CaptureProbeOutcome = { ok: true };
const CAPTURE_PROBE_FATAL: CaptureProbeOutcome = { ok: false, transient: false };
const CAPTURE_PROBE_TRANSIENT: CaptureProbeOutcome = { ok: false, transient: true };

const ACTIVITY_CAPTURE_RECT = { x: 0, y: 0, width: 1, height: 1 };
const CAPTURING_GUEST_MIN_INTERVAL_MS = 200;

/**
 * Manages short-lived background activity leases per owner BrowserWindow.
 *
 * Electron's backgroundThrottling=false wakes every WebContents inside the same BrowserWindow.
 * A browser-use tab is additionally kept alive for the process lifetime, so permanently disabling
 * throttling at window creation would keep the renderer, every guest and the GPU rendering frames
 * after the window goes to the background — and setting it back to true dynamically never
 * re-triggers hidden scheduling. Here we hold a reversible capturer count for the owner renderer
 * and the target guest simultaneously, within the screenshot preparation group; when the group
 * ends, Chromium's native capture lifecycle restores background throttling without waking the
 * window's other guests.
 */
export class DesktopBrowserScreenshotActivityController {
  private readonly states = new Map<string, ScreenshotActivityState>();

  constructor(
    private readonly options: {
      fromId(windowId: number): BrowserWindowForActivity | null;
      fromWebContentsId(webContentsId: number): GuestWebContentsForActivity | null;
      allowTransparentWindowBootstrap?: boolean;
      hideTaskbarDuringTransparentWindowBootstrap?: boolean;
      log?(message: string): void;
    },
  ) {}

  acquire(input: {
    windowId: number;
    webContentsId: number;
    requestId: string;
    reason: "browser-screenshot";
  }): BrowserScreenshotActivityLease | undefined {
    const stateKey = this.getStateKey(input.windowId, input.webContentsId);
    let state = this.states.get(stateKey);
    if (state && !state.active) {
      this.states.delete(stateKey);
      state = undefined;
    }
    if (!state) {
      const targets = this.resolveActivityTargets(input.windowId, input.webContentsId);
      if (!targets) {
        this.options.log?.(
          `[browser-screenshot-activity] acquire skipped windowId=${input.windowId} webContentsId=${input.webContentsId} requestId=${input.requestId}`,
        );
        return undefined;
      }
      const transparentWindowBootstrap = startBrowserScreenshotTransparentWindowBootstrap({
        win: targets.window,
        enabled: this.options.allowTransparentWindowBootstrap === true,
        windowId: input.windowId,
        webContentsId: input.webContentsId,
        requestId: input.requestId,
        hideTaskbarDuringBootstrap:
          this.options.hideTaskbarDuringTransparentWindowBootstrap === true,
        log: this.options.log,
      });
      if (transparentWindowBootstrap === false) {
        return undefined;
      }
      state = {
        key: stateKey,
        windowId: input.windowId,
        webContentsId: input.webContentsId,
        tokens: new Map(),
        restoreGeneration: 0,
        active: true,
        invalidationController: new AbortController(),
        transparentWindowBootstrap,
        capturePumpsAllowed: !transparentWindowBootstrap,
        pumps: {
          owner: { running: false, transientRetry: this.createTransientRetry() },
          guest: { running: false, transientRetry: this.createTransientRetry() },
        },
      };
      this.states.set(stateKey, state);
      this.scheduleCapturePumpsAfterTransparentBootstrap(state);
    } else {
      // Cancel the microtask scheduled in the previous lease and stop the pump, and reuse the same capturer activity in continuous screenshots.
      state.restoreGeneration += 1;
      state.pumps.owner.transientRetry.reset();
      state.pumps.guest.transientRetry.reset();
    }

    const token = Symbol(input.requestId);
    state.tokens.set(token, { prepared: false });
    this.wakeCapturePumps(state);
    this.ensureCapturePumps(state);
    let released = false;
    return {
      invalidated: state.invalidationController.signal,
      markPrepared: () => {
        if (released) return;
        const leaseState = state.tokens.get(token);
        if (!leaseState || leaseState.prepared) return;
        leaseState.prepared = true;
        this.maybeReleaseTransparentWindowBootstrap(state);
        // After Ready, continue to let owner/guest CopyFromSurface back to back, which will take 35s at worst.
        // watchdog all become high frequency GPU readback. owner has completed the rAF handshake and the pump should be stopped; guest
        // Simply low-frequency boost to the hidden page, cut into a single in-flight 5Hz pulse.
        this.wakeCapturePumps(state);
        this.ensureCapturePumps(state);
      },
      release: () => {
        if (released) return;
        released = true;
        this.releaseToken(stateKey, state, token);
      },
    };
  }

  private releaseToken(stateKey: string, state: ScreenshotActivityState, token: symbol): void {
    if (this.states.get(stateKey) !== state || !state.tokens.delete(token)) return;
    this.wakeCapturePumps(state);
    if (state.tokens.size > 0) return;

    const restoreGeneration = ++state.restoreGeneration;
    queueMicrotask(() => {
      if (
        this.states.get(stateKey) !== state ||
        state.tokens.size > 0 ||
        state.restoreGeneration !== restoreGeneration
      ) {
        return;
      }
      state.active = false;
      this.releaseTransparentWindowBootstrap(state);
      this.wakeCapturePumps(state);
      if (this.states.get(stateKey) === state) {
        this.states.delete(stateKey);
      }
    });
  }

  private async runCapturePump(
    state: ScreenshotActivityState,
    target: "owner" | "guest",
  ): Promise<void> {
    const runtime = state.pumps[target];
    runtime.running = true;
    let pendingStartedAt = Date.now();
    let pending: Promise<CaptureProbeOutcome> | undefined = this.captureOnce(state, target);
    try {
      while (pending) {
        const mode = this.getPumpMode(state, target);
        if (mode === "stopped") {
          const completed = await pending;
          if (!completed.ok) this.invalidateActivity(state, target);
          pending = undefined;
          continue;
        }

        if (mode === "continuous") {
          // The Prepare phase must first start the next copy and then wait for the previous one to ensure that the owner's two-frame stable verification will not
          // When the capturer count returns to zero, it will be rescheduled by hidden; each target can have up to two in-flight copies.
          const nextStartedAt = Date.now();
          const next = this.captureOnce(state, target);
          const completed = await pending;
          if (!completed.ok) {
            if (!completed.transient) {
              // Fatal Error Keep Fast Fail: Waiting for concurrent probes that may be pending forever (under hidden window
              // capturePage will hang), it will be invalid immediately; the pending has been settled, and the loop will press the stopped branch.
              // After emptying and exiting, the remaining content will be digested internally by captureOnce and no dangling rejection will occur.
              this.invalidateActivity(state, target);
              continue;
            }
            // Wrap the reissue probe with an object: the async function directly returns Promise and it will be absorbed into
            // "Wait until the detection settles before returning", the pump will stop on the serial detection and cannot resume the overlap rhythm.
            const recovered = await this.recoverFromPreparingCaptureFailure(
              state,
              runtime,
              target,
              next,
            );
            pending = recovered?.pending;
            continue;
          }
          runtime.transientRetry.reset();
          pending = next;
          pendingStartedAt = nextStartedAt;
          // Electron's 1×1 capturePage under hidden window may resolve immediately.
          // If the pump is continued directly here, Promise continuation will occupy the microtask queue indefinitely, even Ready IPC,
          // The timeout, watchdog and second-instance events cannot be scheduled, causing the application to freeze and cannot be opened.
          // Keep the "start the next one first" capturer overlap, but must yield the main event loop once per round.
          await this.waitForContinuousCaptureTurn(state, runtime, target);
          continue;
        }

        const completed = await pending;
        if (!completed.ok) {
          this.invalidateActivity(state, target);
          pending = undefined;
          continue;
        }
        pending = undefined;
        await this.waitForGuestCaptureSlot(state, runtime, pendingStartedAt);
        if (this.getPumpMode(state, target) === "stopped") continue;
        pendingStartedAt = Date.now();
        pending = this.captureOnce(state, target);
      }
    } finally {
      runtime.wakeDelay = undefined;
      runtime.running = false;
      if (this.getPumpMode(state, target) !== "stopped") {
        this.ensureCapturePump(state, target);
      }
    }
  }

  /**
   * When the first frame of the newly activated cold guest has not been synthesized, the 1×1 detection in the prepare phase is in the screenshot request.
   * The same turn will hit an uncreated Viz surface, and Chromium throws UnknownVizError; any
   * A detection failure will be treated as a fatal error and will be invalidate immediately. The first screenshot will be sentenced to death within 45ms. You can only rely on the agent.
   * Retry the entire round.
   * UnknownVizError is transient - similar requests succeed immediately after the surface is created. The first failure to enter this function
   * Transient has been confirmed; here we wait for the next part of the concurrency to settle (no more concurrency is allowed during the failure processing CopyFromSurface,
   * Concurrent readback when the surface is not ready has triggered SIGSEGV in smoke), and then serial backoff retries; budget exhausted
   * Or return to the original invalidate semantics when the concurrency is a fatal error. After Ready (paced phase)
   * Failure will still invalidate immediately and will not be relaxed.
   */
  private async recoverFromPreparingCaptureFailure(
    state: ScreenshotActivityState,
    runtime: CapturePumpRuntime,
    target: "owner" | "guest",
    next: Promise<CaptureProbeOutcome>,
  ): Promise<{ pending: Promise<CaptureProbeOutcome> } | undefined> {
    const nextCompleted = await next;
    if (nextCompleted.ok) {
      // The concurrent part has been successful: the surface has appeared, no need to back off, and the regular overlapping rhythm is restored directly.
      runtime.transientRetry.reset();
      return { pending: this.captureOnce(state, target) };
    }
    if (
      !nextCompleted.transient ||
      !runtime.transientRetry.schedule({
        target,
        windowId: state.windowId,
        webContentsId: state.webContentsId,
      })
    ) {
      this.invalidateActivity(state, target);
      return undefined;
    }
    await this.waitForTransientCaptureRetry(state, runtime, target);
    if (this.getPumpMode(state, target) === "stopped") return undefined;
    return { pending: this.captureOnce(state, target) };
  }

  private async captureOnce(
    state: ScreenshotActivityState,
    target: "owner" | "guest",
  ): Promise<CaptureProbeOutcome> {
    const targets = this.resolveActivityTargets(state.windowId, state.webContentsId);
    if (!targets) return CAPTURE_PROBE_FATAL;
    try {
      await targets[target].capturePage(ACTIVITY_CAPTURE_RECT);
      return CAPTURE_PROBE_SUCCEEDED;
    } catch (error) {
      this.options.log?.(
        `[browser-screenshot-activity] capture failed target=${target} windowId=${state.windowId} webContentsId=${state.webContentsId} error=${error instanceof Error ? error.message : String(error)}`,
      );
      return isTransientScreenshotCaptureError(error)
        ? CAPTURE_PROBE_TRANSIENT
        : CAPTURE_PROBE_FATAL;
    }
  }

  private createTransientRetry(): DesktopBrowserScreenshotTransientRetry {
    return new DesktopBrowserScreenshotTransientRetry({ log: this.options.log });
  }

  private ensureCapturePumps(state: ScreenshotActivityState): void {
    if (!state.capturePumpsAllowed) return;
    this.ensureCapturePump(state, "owner");
    this.ensureCapturePump(state, "guest");
  }

  private ensureCapturePump(state: ScreenshotActivityState, target: "owner" | "guest"): void {
    const runtime = state.pumps[target];
    if (runtime.running || this.getPumpMode(state, target) === "stopped") return;
    void this.runCapturePump(state, target);
  }

  private getPumpMode(
    state: ScreenshotActivityState,
    target: "owner" | "guest",
  ): "continuous" | "paced" | "stopped" {
    if (!state.active || state.tokens.size === 0) return "stopped";
    const preparing = Array.from(state.tokens.values()).some((token) => !token.prepared);
    if (preparing) return "continuous";
    return target === "guest" ? "paced" : "stopped";
  }

  private async waitForGuestCaptureSlot(
    state: ScreenshotActivityState,
    runtime: CapturePumpRuntime,
    captureStartedAt: number,
  ): Promise<void> {
    const remainingMs = Math.max(
      0,
      CAPTURING_GUEST_MIN_INTERVAL_MS - (Date.now() - captureStartedAt),
    );
    if (remainingMs === 0 || this.getPumpMode(state, "guest") !== "paced") return;
    await this.waitForPumpTurn(runtime, remainingMs);
  }

  private async waitForContinuousCaptureTurn(
    state: ScreenshotActivityState,
    runtime: CapturePumpRuntime,
    target: "owner" | "guest",
  ): Promise<void> {
    if (this.getPumpMode(state, target) !== "continuous") return;
    await this.waitForPumpTurn(runtime, 0);
  }

  private async waitForTransientCaptureRetry(
    state: ScreenshotActivityState,
    runtime: CapturePumpRuntime,
    target: "owner" | "guest",
  ): Promise<void> {
    if (this.getPumpMode(state, target) === "stopped") return;
    await this.waitForPumpTurn(runtime, runtime.transientRetry.retryDelayMs());
  }

  /** Bounded wait that can be woken up early by wakeCapturePumps; pump must give way to the main event loop before each round of pumping. */
  private waitForPumpTurn(runtime: CapturePumpRuntime, delayMs: number): Promise<void> {
    return new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (runtime.wakeDelay === finish) runtime.wakeDelay = undefined;
        resolve();
      };
      const timer = setTimeout(finish, delayMs);
      runtime.wakeDelay = finish;
    });
  }

  private wakeCapturePumps(state: ScreenshotActivityState): void {
    state.pumps.owner.wakeDelay?.();
    state.pumps.guest.wakeDelay?.();
  }

  private invalidateActivity(state: ScreenshotActivityState, target: "owner" | "guest"): void {
    if (!state.active || state.tokens.size === 0) return;
    state.active = false;
    this.releaseTransparentWindowBootstrap(state);
    this.wakeCapturePumps(state);
    if (this.states.get(state.key) === state) {
      this.states.delete(state.key);
    }
    if (!state.invalidationController.signal.aborted) {
      // Just stopping the pump is not enough: the lease already obtained by the coordinator is still shown to be valid and can only wait for the complete
      // Surface preparation timed out. Explicit invalidation causes the preparation phase to fail immediately, and late screenshots can also be rejected after Ready.
      state.invalidationController.abort(
        new Error(`browser screenshot activity capture failed for ${target}`),
      );
    }
  }

  private resolveActivityTargets(
    windowId: number,
    webContentsId: number,
  ):
    | {
        window: BrowserWindowForActivity;
        owner: BrowserWindowForActivity["webContents"];
        guest: GuestWebContentsForActivity;
      }
    | undefined {
    const win = this.options.fromId(windowId);
    if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return undefined;
    const guest = this.options.fromWebContentsId(webContentsId);
    if (
      !guest ||
      guest.isDestroyed() ||
      guest.id !== webContentsId ||
      guest.hostWebContents?.id !== win.webContents.id
    ) {
      return undefined;
    }
    return { window: win, owner: win.webContents, guest };
  }

  private releaseTransparentWindowBootstrap(state: ScreenshotActivityState): void {
    if (state.capturePumpStartTimer) {
      clearTimeout(state.capturePumpStartTimer);
      state.capturePumpStartTimer = undefined;
    }
    state.transparentWindowBootstrap?.release();
    state.transparentWindowBootstrap = undefined;
  }

  private scheduleCapturePumpsAfterTransparentBootstrap(state: ScreenshotActivityState): void {
    if (!state.transparentWindowBootstrap) return;
    state.capturePumpStartTimer = setTimeout(() => {
      state.capturePumpStartTimer = undefined;
      if (!state.active || this.states.get(state.key) !== state) return;
      state.capturePumpsAllowed = true;
      // When showInactive concurrently calls CopyFromSurface in the same turn, Viz has not yet established the surface.
      // Electron will report UnknownVizError, and real smoke may even trigger SIGSEGV. First give the window a bounded
      // presentation grace, then start the capturer; if the renderer is Ready, only the guest paced pump will be started.
      this.ensureCapturePumps(state);
      this.maybeReleaseTransparentWindowBootstrap(state);
    }, TRANSPARENT_WINDOW_PRESENTATION_GRACE_MS);
  }

  private maybeReleaseTransparentWindowBootstrap(state: ScreenshotActivityState): void {
    if (
      !state.capturePumpsAllowed ||
      Array.from(state.tokens.values()).some((candidate) => !candidate.prepared)
    ) {
      return;
    }
    this.releaseTransparentWindowBootstrap(state);
  }

  private getStateKey(windowId: number, webContentsId: number): string {
    return `${windowId}:${webContentsId}`;
  }
}
