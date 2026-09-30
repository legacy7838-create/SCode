/* eslint-disable max-lines -- The IAB owner registry, the ready/abort lifecycle, and guest CDP state must be maintained atomically inside a single state machine; splitting them apart would reintroduce cross-scope races. */
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { webContents, type WebFrameMain } from "electron";
import {
  BROWSER_VIEWPORT_LIMITS,
  DEFAULT_AGENT_BROWSER_VIEWPORT,
  type BrowserClientMode,
  type BrowserCommand,
  type BrowserCommandResult,
  type BrowserGuestAttachRejectReason,
  type BrowserGuestAttachResult,
  type BrowserDialog,
  type BrowserRecordingAction,
  type BrowserRecordingJob,
  type BrowserRecordingOptions,
  type BrowserResponseMeta,
  type BrowserTabSummary,
  type BrowserUserTabInfo,
  type BrowserViewCloseTabRequest,
  type BrowserViewResidencyReportPayload,
  type BrowserViewResidencyTransitionPayload,
  type BrowserViewRestoredTabShell,
  type BrowserViewportSize,
} from "@zcode/shared";
import { executeBrowserCommandOnView, type ControlledView } from "./browserCommandExecutor.js";
import { executeIabPlaywrightLocator } from "./browserPlaywrightLocatorExecutor.js";
import { recordBrowserVideo, type BrowserWebmRecorderFactory } from "./browserVideoRecorder.js";
import { normalizePlaywrightTimeout } from "./browserPlaywrightTimeout.js";
import type {
  BrowserScreenshotSurfaceCoordinator,
  BrowserScreenshotSurfaceLease,
} from "./browserScreenshotSurfaceCoordinator.js";
import {
  startBrowserScreenshotTransparentWindowBootstrap,
  TRANSPARENT_WINDOW_PRESENTATION_GRACE_MS,
  type BrowserWindowForTransparentBootstrap,
  type TransparentWindowBootstrap,
} from "./browserTransparentWindowBootstrap.js";
import {
  BrowserTabResidencyCoordinator,
  type BrowserTabResidencyRecord,
} from "./browserTabResidencyCoordinator.js";
import type {
  BrowserTabPageStateRecord,
  BrowserTabRecoveryStore,
  BrowserTabShellRecord,
} from "./browserTabRecoveryStore.js";

interface GuestWebContents {
  readonly id: number;
  readonly hostWebContents?: { getZoomFactor(): number } | null;
  readonly mainFrame: WebFrameMain;
  getType(): string;
  getZoomFactor(): number;
  setZoomFactor(factor: number): void;
  isDestroyed(): boolean;
  loadURL(url: string): Promise<void>;
  getURL(): string;
  getTitle(): string;
  reload(): void;
  stop(): void;
  capturePage(): Promise<{ toPNG(): Buffer }>;
  executeJavaScript(script: string, userGesture?: boolean): Promise<unknown>;
  navigationHistory: {
    canGoBack(): boolean;
    canGoForward(): boolean;
    goBack(): void;
    goForward(): void;
    getAllEntries(): Array<{ url: string; title?: string; pageState?: string }>;
    getActiveIndex(): number;
    restore(options: {
      entries: Array<{ url: string; title?: string; pageState?: string }>;
      index: number;
    }): Promise<void>;
  };
  close(options?: { waitForBeforeUnload?: boolean }): void;
  isCurrentlyAudible?(): boolean;
  isBeingCaptured?(): boolean;
  on?(event: string, listener: (...args: unknown[]) => void): void;
  removeListener?(event: string, listener: (...args: unknown[]) => void): void;
  debugger: {
    isAttached(): boolean;
    attach(protocolVersion?: string): void;
    detach(): void;
    sendCommand(method: string, params?: unknown, sessionId?: string): Promise<unknown>;
    on(event: "message", listener: (event: unknown, method: string, params: unknown) => void): void;
    removeListener(
      event: "message",
      listener: (event: unknown, method: string, params: unknown) => void,
    ): void;
  };
  once(event: "destroyed", listener: () => void): void;
  session?: {
    on(
      event: "will-download",
      listener: (event: unknown, item: GuestDownloadItem, contents: GuestWebContents) => void,
    ): void;
    removeListener(
      event: "will-download",
      listener: (event: unknown, item: GuestDownloadItem, contents: GuestWebContents) => void,
    ): void;
  };
}

interface GuestDownloadItem {
  getSavePath(): string;
  once(event: "done", listener: (event: unknown, state: string) => void): void;
}

export interface BrowserGuestExecutionContext {
  requestId: string;
  browserId: string;
  browserGeneration: number;
  windowId: number;
  workspaceKey: string;
  sessionId: string;
  turnId?: string;
  remoteSessionId?: string;
  clientMode: BrowserClientMode;
}

interface InternalExecutionContext extends BrowserGuestExecutionContext {
  legacy?: boolean;
}

type TabLifecycle = "active" | "deliverable" | "handoff" | "closed";
type GuestBindingLifecycle = "detached" | "attached" | "detaching" | "destroyed";
type GuestRecoveryReason = BrowserGuestAttachRejectReason | "guest-destroyed" | "attach-timeout";

const TAB_CONTEXT_RECOVERY_HINT =
  "This is pre-action stale-binding recovery, not post-action popup observation. " +
  "Keep the existing browser binding; call browser.tabs.list(), then browser.tabs.get(info.id). " +
  "If the controlled list is empty, inspect browser.user.openTabs() and use browser.user.claimTab(info) " +
  "before creating a new tab.";

interface ManagedTab {
  tabId: string;
  owner: InternalExecutionContext;
  guest?: GuestWebContents;
  /** guest replacement generation; used before command dispatch to reject stale guests. */
  guestGeneration: number;
  /** The guest has been successfully bound; used to distinguish the first wait for a new tab from the self-healing of an existing tab. */
  hasAttachedGuest: boolean;
  attachFailure?: GuestRecoveryReason;
  rebindRequested: boolean;
  cdpAttached: boolean;
  /** Guest's native CDP life cycle; DOM must go through detaching before being destroyed. */
  guestLifecycle: GuestBindingLifecycle;
  /** The number of debugger.sendCommand that has not yet been settled, teardown will wait for it to return to zero or timeout. */
  pendingCdpCommands: number;
  /** The timer for idle release of the command stream; reset after each CDP command is completed and cleared when detachGuest. */
  guestCdpIdleTimer?: ReturnType<typeof setTimeout>;
  /** re-attach session resumes flight; business commands must wait for its completion before being dispatched (serial barrier). */
  guestCdpRestoreFlight?: Promise<void>;
  /** The viewport critical section is currently held; CDP reconnects and replays directly, and cannot be queued to wait for itself again. */
  insideViewportMutation?: boolean;
  /** Replacement teardown for the same guest only allows one flight, with repeated ACK sharing results. */
  guestTeardownFlight?: Promise<boolean>;
  lifecycle: TabLifecycle;
  origin: "agent" | "user";
  /** The human IAB tab can be discovered by any session before the first operation in the same window/workspace. */
  claimable: boolean;
  /** Claimed user tab reverts to user tab when finalize/closeSession and cannot be closed like agent tab. */
  userOwner?: InternalExecutionContext;
  active: boolean;
  /** Single tab CSS viewport set by Agent/UI; undefined means following the host's natural size. */
  viewportOverride?: BrowserViewportSize;
  /** Desktop page zoom is designed to correct the guest native raster when zooming in; does not change the CSS viewport. */
  desktopZoomFactor?: number;
  /** The magnification that was successfully handed down to Chromium; the input must not use a target magnification that is still in the viewport queue. */
  appliedViewportScale?: number;
  /** When the pane is hidden as 0×0, it is only used for background execution; it must be cleared after it is visible in the foreground again. */
  backgroundViewportFallback?: BrowserViewportSize;
  /** Serialize transient clear and explicit set/reset to ensure the last user/agent setting wins. */
  viewportMutation?: Promise<void>;
  downloadCleanup?: () => void;
  activityCleanup?: () => void;
  /**
   * Unregister the "message" listener of the debugger. The old listener should not continue to hang after the guest is replaced: it needs to look up the table for every event.
   * Then rely on current.guest !== guest to discard it completely, which is pure leakage. Note that this is only JS layer cleaning, native side
   * The CDP channel is truly disconnected by debugger.detach().
   */
  cdpMessageCleanup?: () => void;
  /**
   * Unregister the render-process-gone listener. This listener is responsible for when the guest renderer is killed and WebContents remain.
   * Actively disconnect CDP in the window - this is the only time to avoid implicit destruction of api::Debugger.
   */
  crashGuardCleanup?: () => void;
  loading: boolean;
  mediaActive: boolean;
  cachedUrl: string;
  cachedTitle: string;
  cachedFaviconUrl: string | null;
  openedAt: number;
  restoredFromStore?: boolean;
}

interface PendingWaiter {
  resolve: (guest: GuestWebContents | null) => void;
  timer: ReturnType<typeof setTimeout>;
  signal?: AbortSignal;
  onAbort?: () => void;
}

interface RunningRequest {
  context: InternalExecutionContext;
  controller: AbortController;
  dispatched: boolean;
  tabId?: string;
}

interface InFlightScreenshot {
  execution: Promise<BrowserCommandResult>;
  requestId: string;
  startedAt: number;
}

interface BrowserRecordingEntry {
  id: string;
  context: InternalExecutionContext;
  tabId: string;
  controller: AbortController;
  status: BrowserRecordingJob["status"];
  phase: BrowserRecordingJob["phase"];
  progress: number;
  startedAt: number;
  updatedAt: number;
  artifact?: BrowserRecordingJob["artifact"];
  error?: string;
  cleanupTimer?: ReturnType<typeof setTimeout>;
}

interface DownloadRecord {
  tabId: string;
  path: string | null;
  state: "pending" | "completed" | "cancelled" | "interrupted";
}

interface DownloadWaiter {
  resolve: (downloadId: string | null) => void;
  timer: ReturnType<typeof setTimeout>;
  signal: AbortSignal;
  onAbort: () => void;
}

const DEFAULT_ATTACH_TIMEOUT_MS = 10_000;
// Hard cap on full capture when transparent presentation is in place; should normally complete within hundreds of ms.
const HIDDEN_WINDOW_CAPTURE_DEADLINE_MS = 5_000;
// Hard cap on "Waiting abandoned but underlying CDP capture still unsettled" on a single tab. CDP screenshot without single request
// Canceling the API and retrying will leave a pending command in Chromium; when the compositor continues to be unavailable
// Without an upper limit, they will overlap infinitely (they will be drained at the same time when the frame is restored, but pendingCdpCommands will not return to zero,
// detach takes the timeout path). After reaching the upper limit, the same tab screenshot quickly fails and prompts to reopen the tab, the old capture
// The quota will be automatically recovered after it is confirmed.
const MAX_ABANDONED_SCREENSHOT_CAPTURES = 3;
/** teardown The upper limit for waiting for CDP in-flight commands to converge; native detach will still be attempted after the timeout. */
const DEFAULT_GUEST_CDP_TEARDOWN_TIMEOUT_MS = 1_000;
// CDP command stream idle release threshold: while covering the measured crash window (command gap within turn 0.4~9s),
// Do not interrupt the agent's intensive operation flow (the command interval is usually much smaller than this value).
const DEFAULT_GUEST_CDP_IDLE_RELEASE_MS = 1_500;
const RECORDING_RESULT_TTL_MS = 60 * 60 * 1_000;
const DEFAULT_BACKGROUND_BROWSER_VIEWPORT: BrowserViewportSize = {
  width: 800,
  height: 600,
};

type BrowserTabRecoveryStorePort = Pick<
  BrowserTabRecoveryStore,
  "upsert" | "upsertPageState" | "getPageState" | "removePageState" | "remove" | "listShells"
> &
  Partial<Pick<BrowserTabRecoveryStore, "whenIdle">>;

interface BrowserGuestManagerResidencyOptions {
  tabLimit?: number;
  suspendAckTimeoutMs?: number;
  now?: () => number;
  recoveryStore?: BrowserTabRecoveryStorePort;
  onSuspendTabRequested?(payload: BrowserViewResidencyTransitionPayload): void;
  onRestoreTabRequested?(payload: BrowserViewResidencyTransitionPayload): void;
  onResidencyChanged?(payload: BrowserViewResidencyTransitionPayload): void;
  onRecoveryOrphanCloseRequested?(payload: { tabId: string; reason: "recovery-orphan" }): void;
  warn?(message: string): void;
  recording?: {
    tempRoot?: string;
    createRecorder?: BrowserWebmRecorderFactory;
    now?: () => number;
  };
}
function normalizeDesktopZoomMetricsScale(desktopZoomFactor: number | undefined): number {
  return Number.isFinite(desktopZoomFactor) && (desktopZoomFactor ?? 1) > 1
    ? (desktopZoomFactor ?? 1)
    : 1;
}

function buildViewportMetricsOverride(
  viewport: BrowserViewportSize,
  desktopZoomFactor?: number,
): Record<string, unknown> {
  const metricsScale = normalizeDesktopZoomMetricsScale(desktopZoomFactor);
  return {
    width: viewport.width,
    height: viewport.height,
    // By default, CDP will allow page indicators with DPR=1 to take over the visible size at the same time, so only allocate
    // 1x native surface, although the DOM bounds are correct, the web page only covers the upper left corner of the frame. visible surface
    // It should continue to be managed by the actual bounds of Electron <webview>, and CDP is only responsible for CSS viewport and screenshot DPR.
    deviceScaleFactor: 1,
    mobile: false,
    dontSetVisibleSize: true,
    // When Desktop page zoom > 1, Electron's guest target screenshot itself has only
    // 1 / zoom content of the frame, the outer CSS transform cannot complete the native raster. CDP scale
    // Only visible areas are corrected at the zoom level; zoom out remains at the default 1 to avoid shrinking the content again.
    ...(metricsScale > 1 ? { scale: metricsScale } : {}),
  };
}

function scopeKey(context: InternalExecutionContext): string {
  if (context.legacy) return "legacy";
  return [
    context.browserId,
    String(context.browserGeneration),
    String(context.windowId),
    context.workspaceKey,
    context.remoteSessionId ?? "",
    context.sessionId,
    context.clientMode,
  ].join("\u0000");
}

function sameScope(left: InternalExecutionContext, right: InternalExecutionContext): boolean {
  return (left.legacy === true && right.legacy === true) || scopeKey(left) === scopeKey(right);
}

function normalizeLegacyContext(defaultKey: string): InternalExecutionContext {
  return {
    requestId: `legacy:${randomUUID()}`,
    browserId: "legacy-iab",
    browserGeneration: 0,
    windowId: 0,
    workspaceKey: defaultKey,
    sessionId: defaultKey,
    clientMode: "desktop-continuous",
    legacy: true,
  };
}

function suspendAckKey(tabId: string, generation: number): string {
  return `${tabId}\u0000${generation}`;
}

function toRestoredShell(
  record: BrowserTabShellRecord,
  owner: InternalExecutionContext,
): BrowserViewRestoredTabShell {
  return {
    tabId: record.tabId,
    workspaceKey: record.workspaceKey,
    ...(record.remoteSessionId ? { remoteSessionId: record.remoteSessionId } : {}),
    sessionId: record.sessionId,
    browserId: owner.browserId,
    browserGeneration: owner.browserGeneration,
    origin: record.origin,
    restoreUrl: record.restoreUrl,
    title: record.title,
    faviconUrl: record.faviconUrl,
    openedAt: record.openedAt,
    lastSelectedAt: record.lastSelectedAt,
  };
}

function isSideEffecting(command: BrowserCommand): boolean {
  if (command.method === "playwright" && command.action.name === "locator") {
    return [
      "click",
      "dblclick",
      "downloadMedia",
      "fill",
      "press",
      "selectOption",
      "setChecked",
    ].includes(command.action.operation);
  }
  if (command.method === "playwright" && command.action.name === "evaluate") return true;
  return [
    "navigate",
    "back",
    "forward",
    "reload",
    "click",
    "fill",
    "type",
    "press",
    "cuaKeypress",
    "scroll",
    "cuaScroll",
    "domCuaScroll",
    "hover",
    "select",
    "check",
    "drag",
    "cuaDrag",
    "recordingStart",
    "recordingCancel",
    "handleDialog",
    "close",
    "evaluate",
    "finalize",
    "finalizeTabs",
    "claimTab",
    "activateTab",
    "markDeliverable",
    "markHandoff",
    "newTab",
  ].includes(command.method);
}

/**
 * IAB guest registry. The production path is strictly isolated by BrowserGuestExecutionContext; the string input parameter is only reserved for
 * Old renderer/unit tests are compatible and cannot be used by new callers.
 */
function safeNumber(read: () => number | undefined): number | undefined {
  try {
    const value = read();
    return typeof value === "number" ? value : undefined;
  } catch {
    // Accessing the id when the guest has been destroyed will throw an error; the resource manager simply skips the tab.
    return undefined;
  }
}

export class BrowserGuestManager {
  private readonly tabs = new Map<string, ManagedTab>();

  /** Resource manager: the webContents ids of the browser guests that are still alive, used to attribute their renderer to the built-in browser-use plugin */
  listGuestWebContentsIds(): number[] {
    const ids: number[] = [];
    for (const tab of this.tabs.values()) {
      if (tab.lifecycle === "closed" || !tab.guest) continue;
      const id = safeNumber(() => tab.guest?.id);
      if (id !== undefined) ids.push(id);
    }
    return ids;
  }
  /** After close, only the opaque id tombstone is retained, late renderer attach is rejected, and owner/guest is not retained. */
  private readonly closedTabIds = new Set<string>();
  private readonly activeTabByScope = new Map<string, string>();
  private readonly defaultTabByScope = new Map<string, string>();
  private readonly waiters = new Map<string, PendingWaiter[]>();
  private readonly pendingDialogs = new Map<string, BrowserDialog>();
  private readonly runningRequests = new Map<string, RunningRequest>();
  /**
   * CDP Page.captureScreenshot does not have a single request cancellation API. The promise may still be there after the outer timeout/cancel
   * Executed within Chromium. Request abort/deadline immediately
   * settle and release the barrier, allowing the same tab to be retried immediately - the overlap is transient and self-draining: transparency for next screenshot
   * The presentation will resume producing frames, and the old pending capture will be settled; the results will be attributed according to their respective promise chains, and will be late
   * The result will not be mistakenly hung on new requests (clearTrackedScreenshot is idempotent with entry identity). The old "retention barrier"
   * Until real settle" will turn the pending request that never settles into a screenshot of the tab deadlock (production actual test pendingMs
   * 120s+), has been abandoned. Stacking risk is covered by a hard cap on abandonedScreenshotCaptures.
   */
  private readonly inFlightScreenshots = new Map<string, InFlightScreenshot>();
  /** See MAX_ABANDONED_SCREENSHOT_CAPTURES; key is tabId. */
  private readonly abandonedScreenshotCaptures = new Map<string, number>();
  private readonly recordings = new Map<string, BrowserRecordingEntry>();
  private readonly downloads = new Map<string, DownloadRecord>();
  private readonly queuedDownloads = new Map<string, string[]>();
  private readonly downloadWaiters = new Map<string, DownloadWaiter[]>();
  private readonly sessionNames = new Map<string, string>();
  private readonly visibilityByScope = new Map<string, boolean>();
  private readonly naturalViewportByWindow = new Map<number, BrowserViewportSize>();
  private readonly residencyCoordinator: BrowserTabResidencyCoordinator;
  private readonly suspendAckWaiters = new Map<string, () => void>();
  private readonly suspendFlights = new Map<string, Promise<void>>();
  private readonly restoreFlights = new Map<string, Promise<GuestWebContents | null>>();
  /** When the guest is destroyed and then reconnected, the replacement guest must first complete the restoration of the original page before receiving new browser commands. */
  private readonly guestRecoveryFlights = new Map<string, Promise<GuestWebContents | null>>();
  /** The attach/rebind of the same tab only allows one flight to avoid concurrent commands to rebuild the webview separately. */
  private readonly guestAttachFlights = new Map<string, Promise<GuestWebContents | null>>();
  private readonly restoredTabClaims = new Map<string, number>();

  constructor(
    private readonly log?: (msg: string) => void,
    private readonly attachTimeoutMs: number = DEFAULT_ATTACH_TIMEOUT_MS,
    private readonly onCloseTabRequested?: (
      tabId: string,
      owner?: BrowserGuestExecutionContext,
    ) => void,
    private readonly onOpenTabRequested?: (
      tabId: string,
      owner: BrowserGuestExecutionContext,
    ) => void,
    private readonly onVisibilityChanged?: (
      visible: boolean,
      owner: BrowserGuestExecutionContext,
      tabId?: string,
    ) => void,
    private readonly onViewportChanged?: (
      viewport: BrowserViewportSize | null,
      owner: BrowserGuestExecutionContext,
      tabId: string,
    ) => void,
    // The seventh bit has been used by screenshot CSS pixel normalization; new access control dependencies can only be appended to avoid breaking existing main/test calls.
    private readonly resizeScreenshotToCssPixels?: ControlledView["resizeScreenshotToCssPixels"],
    private readonly screenshotSurfaceCoordinator?: BrowserScreenshotSurfaceCoordinator,
    private readonly residencyOptions: BrowserGuestManagerResidencyOptions = {},
    // The transparent presentation that hides window screenshots relies on owner BrowserWindow; the test injects a double, and the production is
    // index.ts takes over from BrowserWindow.fromId. When not injected, this ability is disabled as a whole, and the behavior is consistent with the old version.
    private readonly resolveOwnerWindow?: (
      windowId: number,
    ) => BrowserWindowForTransparentBootstrap | null,
    // How long the CDP command stream will be idle before it is actively released (detach). guest renderer was
    // When Chromium kills and render-process-gone is not delivered to main, it is destroyed directly + CDP attached that is
    // Main process UAF; the command gap (0.4~9s) within turn is the measured crash window, which is narrowed by command-level idle release.
    private readonly cdpIdleReleaseMs: number = DEFAULT_GUEST_CDP_IDLE_RELEASE_MS,
  ) {
    this.residencyCoordinator = new BrowserTabResidencyCoordinator({
      tabLimit: residencyOptions.tabLimit,
      now: residencyOptions.now,
      onEvict: (record) => this.closeTabForLimit(record),
    });
  }

  attachGuest(
    tabId: string,
    webContentsId: number,
    options?: {
      active?: boolean;
      windowId?: number;
      workspaceKey?: string;
      remoteSessionId?: string;
      sessionId?: string;
      residencyGeneration?: number;
    },
  ): BrowserGuestAttachResult {
    let tab = this.tabs.get(tabId);
    const guest = webContents.fromId(webContentsId) as GuestWebContents | undefined;
    if (!guest || guest.isDestroyed()) {
      const recoveryRequested =
        tab && tab.lifecycle !== "closed"
          ? this.requestGuestRebind(tab, guest ? "destroyed" : "not-found")
          : false;
      this.log?.(
        `[browser-use] attachGuest skip tabId=${tabId} id=${webContentsId} reason=${guest ? "destroyed" : "not-found"}`,
      );
      return {
        ok: false,
        reason: guest ? "destroyed" : "not-found",
        recoveryRequested,
      };
    }
    if (guest.getType() !== "webview") {
      // fromId accepts any WebContents id in the process; if the renderer misrepresents the main window id, subsequent
      // CDP/Runtime input operates directly on ZCode composer. IAB only allows real <webview> guest fail closed.
      this.log?.(
        `[browser-use] attachGuest rejected tabId=${tabId} id=${webContentsId} reason=not-webview type=${guest.getType()}`,
      );
      return { ok: false, reason: "not-webview", recoveryRequested: false };
    }

    if (this.closedTabIds.has(tabId)) {
      this.log?.(`[browser-use] attachGuest rejected tabId=${tabId} reason=closed`);
      return { ok: false, reason: "closed", recoveryRequested: false };
    }
    // Compatible with old renderers: keys that have not undergone create request only enter legacy scope.
    if (!tab) {
      const owner = options?.workspaceKey
        ? {
            requestId: `unclaimed:${randomUUID()}`,
            browserId: "unclaimed-iab",
            browserGeneration: 0,
            windowId: options.windowId ?? 0,
            workspaceKey: options.workspaceKey,
            // Human tab originally only registered as global unclaimed by workspace, any new conversation can
            // Enumerate and take over from user.openTabs(). ownerTaskId is now frozen with attach; old renderer
            // When the sessionId is not passed, the unclaimable sentinel is retained. It would rather be hidden than leaked across sessions.
            sessionId: options.sessionId?.trim() || "unscoped",
            ...(options.remoteSessionId ? { remoteSessionId: options.remoteSessionId } : {}),
            clientMode: "desktop-continuous" as const,
          }
        : normalizeLegacyContext(tabId);
      if (options?.windowId !== undefined) owner.windowId = options.windowId;
      tab = {
        tabId,
        owner,
        cdpAttached: false,
        guestLifecycle: "detached",
        pendingCdpCommands: 0,
        guestGeneration: 0,
        hasAttachedGuest: false,
        rebindRequested: false,
        lifecycle: "active",
        origin: options?.workspaceKey ? "user" : "agent",
        claimable: Boolean(options?.workspaceKey && options.sessionId?.trim()),
        ...(options?.workspaceKey ? { userOwner: { ...owner } } : {}),
        active: false,
        loading: false,
        mediaActive: false,
        cachedUrl: "",
        cachedTitle: "",
        cachedFaviconUrl: null,
        openedAt: this.now(),
      };
      this.tabs.set(tabId, tab);
      this.registerTabResidency(tab, options?.active === true);
    }
    if (tab.lifecycle === "closed") {
      this.log?.(`[browser-use] attachGuest rejected tabId=${tabId} reason=closed`);
      return { ok: false, reason: "closed", recoveryRequested: false };
    }
    if (options?.windowId !== undefined && tab.owner.windowId !== options.windowId) {
      this.log?.(
        `[browser-use] attachGuest rejected tabId=${tabId} reason=window-mismatch expected=${tab.owner.windowId} actual=${options.windowId}`,
      );
      return { ok: false, reason: "window-mismatch", recoveryRequested: false };
    }
    if (options?.workspaceKey && tab.owner.workspaceKey !== options.workspaceKey) {
      this.log?.(`[browser-use] attachGuest rejected tabId=${tabId} reason=workspace-mismatch`);
      return this.rejectGuestAttach(tab, guest, "workspace-mismatch");
    }
    if (options?.sessionId && tab.owner.sessionId !== options.sessionId) {
      // A dom-ready renderer cannot reuse an existing tabId with another conversation's ownership.
      // Window/workspace must also be rejected to prevent guest from bypassing openTabs isolation after being replaced across sessions.
      this.log?.(`[browser-use] attachGuest rejected tabId=${tabId} reason=session-mismatch`);
      return this.rejectGuestAttach(tab, guest, "session-mismatch");
    }
    if ((tab.owner.remoteSessionId ?? "") !== (options?.remoteSessionId ?? "")) {
      // In the past, remote owner was only verified when the renderer actively provided remoteSessionId. Missing values would
      // fail-open; the old tab after remote reconnection may be attached by the new runtime.
      this.log?.(
        `[browser-use] attachGuest rejected tabId=${tabId} reason=remote-session-mismatch`,
      );
      return this.rejectGuestAttach(tab, guest, "remote-session-mismatch");
    }

    const residency = this.residencyCoordinator.get(tabId);
    const rejectsNewGuest =
      tab.guest !== guest &&
      (residency?.residency === "suspended" || residency?.residency === "suspend-pending");
    if (rejectsNewGuest) {
      // After the recovery timeout has been rolled back, late guests from the old generation will still bypass the restoration.
      // Verify and reoccupy the tab. Suspended/pending only allows the current old guest to report repeatedly, and does not accept new attaches.
      this.log?.(
        `[browser-use] attachGuest rejected tabId=${tabId} reason=residency-${residency.residency}`,
      );
      this.closeGuestWebContents(tab, guest);
      return {
        ok: false,
        reason: "residency-suspended",
        recoveryRequested: false,
      };
    }
    if (
      residency?.residency === "restoring" &&
      !this.residencyCoordinator.markAttached(
        tabId,
        options?.active === true,
        options?.residencyGeneration,
      )
    ) {
      this.log?.(
        `[browser-use] attachGuest rejected tabId=${tabId} reason=residency-generation-mismatch expected=${residency.generation} actual=${options?.residencyGeneration ?? "missing"}`,
      );
      this.closeGuestWebContents(tab, guest);
      return {
        ok: false,
        reason: "residency-generation-mismatch",
        recoveryRequested: false,
      };
    }
    const isSameGuest = tab.guest === guest;
    if (residency?.residency === "restoring") {
      // The recovery state src uses a delay protocol that does not submit the document; after the scope/generation verification passes
      // Terminate the provisional request and ensure restoreGuestState creates a unique first-time valid navigation.
      try {
        guest.stop();
      } catch (error) {
        this.warn(`browser tab provisional navigation stop failed tabId=${tabId}`, error);
      }
    }
    if (tab.guest && !isSameGuest) this.detachGuest(tab);
    if (!isSameGuest) this.guestRecoveryFlights.delete(tab.tabId);

    // detachGuest will read the last URL from the old guest that is still alive; the recovery decision must be placed after it to avoid renderer
    // Before the residency is reported, the navigation that just occurred was misjudged as having no recoverable facts.
    const rebindReason = tab.attachFailure;
    const shouldRestoreAfterRebind =
      tab.hasAttachedGuest &&
      !isSameGuest &&
      rebindReason !== undefined &&
      rebindReason !== "residency-suspended" &&
      rebindReason !== "residency-generation-mismatch" &&
      tab.cachedUrl.trim() !== "" &&
      tab.cachedUrl !== "about:blank";

    let cdpAttached = false;
    try {
      if (!guest.debugger.isAttached()) guest.debugger.attach("1.3");
      cdpAttached = guest.debugger.isAttached();
    } catch {
      cdpAttached = safeBool(() => guest.debugger.isAttached(), false);
    }
    tab.guest = guest;
    tab.cdpAttached = cdpAttached;
    tab.guestLifecycle = "attached";
    tab.guestTeardownFlight = undefined;
    if (!isSameGuest) tab.guestGeneration += 1;
    tab.hasAttachedGuest = true;
    tab.attachFailure = undefined;
    tab.rebindRequested = false;
    if (cdpAttached) this.scheduleGuestCdpIdleRelease(tab);
    // The initial URL for new guests during recovery is about:blank. If pageState/restoreUrl is consumed before
    // If the logical cache is overwritten, the damaged snapshot will be downgraded to a blank page by mistake, and orphans that are missing all three types of facts cannot be recognized.
    if (residency?.residency !== "restoring" && !shouldRestoreAfterRebind) {
      tab.cachedUrl = safeStr(() => guest.getURL(), tab.cachedUrl);
      tab.cachedTitle = safeStr(() => guest.getTitle(), tab.cachedTitle);
    }
    if (options?.active === true) {
      tab.active = true;
      if (!tab.claimable) this.selectTab(tab, false);
      this.restoreNaturalViewportAfterBackground(tab);
    } else if (options?.active === false) {
      tab.active = false;
      this.residencyCoordinator.report(tab.tabId, {
        selected: false,
        visible: false,
      });
      if (this.activeTabByScope.get(scopeKey(tab.owner)) === tabId) {
        this.activeTabByScope.delete(scopeKey(tab.owner));
      }
    }
    this.log?.(
      `[browser-use] attachGuest tabId=${tabId} windowId=${tab.owner.windowId} cdp=${cdpAttached}`,
    );

    guest.once("destroyed", () => {
      const current = this.tabs.get(tabId);
      if (current?.guest === guest) {
        this.detachGuest(current);
        this.requestGuestRebind(current, "guest-destroyed");
      }
    });
    // Placed before the remaining wiring: the following setups may throw errors synchronously and skip the remaining wiring when the guest has been destroyed.
    // This is the only monitor that can close the UAF window and should not be affected by other connections.
    if (!isSameGuest) this.setupCdpCrashGuard(tab, guest);
    if (!isSameGuest) this.setupDialogTracking(tab, guest);
    if (!isSameGuest) this.setupDownloadTracking(tab, guest);
    if (!isSameGuest) this.setupActivityTracking(tab, guest);
    if (!isSameGuest) this.applyViewportOverride(tab);
    if (tab.viewportOverride) {
      // The Agent may issue the viewport event before the renderer completes automatic opening; it may be replayed after the guest attach.
      // Ensure that the newly mounted free-size UI will not miss the one-time synchronization of main → renderer.
      this.onViewportChanged?.({ ...tab.viewportOverride }, tab.owner, tab.tabId);
    }
    if (options?.active !== false && this.visibilityByScope.get(scopeKey(tab.owner)) === true) {
      // visibilityByScope means that the entire browser scope is visible, not the tab attached this time.
      // is selected. Playing back the inactive guest as visible=true will cause the renderer to
      // The old tab is activated again; similar events that are late after closing will also resurrect the tab shell. Only non-inactive attach can
      // Following scope visibility, explicit selection is still notified by selectTab/browserVisibilitySet.
      this.onVisibilityChanged?.(true, tab.owner, tab.tabId);
    }
    if (shouldRestoreAfterRebind) {
      // When guest-destroyed only replays Ready, the initial URL of the new guest is about:blank; if it is directly
      // Mark it as available, the renderer will not re-consume the applied initialUrl, and the right panel will permanently stay on a blank page.
      // The existing pageState → restoreUrl recovery logic is used here, and subsequent commands are strung together with tab-level flights.
      const recoveryFlight = this.restoreReboundGuest(tab, guest);
      this.guestRecoveryFlights.set(tab.tabId, recoveryFlight);
      const clearRecoveryFlight = () => {
        if (this.guestRecoveryFlights.get(tab.tabId) === recoveryFlight) {
          this.guestRecoveryFlights.delete(tab.tabId);
        }
      };
      void recoveryFlight.then(clearRecoveryFlight, clearRecoveryFlight);
    }
    this.resolveWaiters(tabId, guest);
    if (residency?.residency !== "restoring") {
      this.residencyCoordinator.markAttached(tabId, options?.active === true);
    }
    void this.persistShell(tab);
    return { ok: true, guestGeneration: tab.guestGeneration };
  }

  /** Free-size interaction write-back from the renderer; the sender window is bound by the IPC layer, so tabs in other windows cannot be modified. */
  async updateViewportFromRenderer(
    tabId: string,
    viewport: BrowserViewportSize | null,
    windowId: number,
    desktopZoomFactor = 1,
  ): Promise<void> {
    const tab = this.tabs.get(tabId);
    if (!tab || tab.lifecycle === "closed" || tab.owner.windowId !== windowId) {
      throw new Error(`browser tab '${tabId}' is unavailable for viewport update`);
    }
    if (viewport) {
      assertViewportOverride(viewport);
      tab.desktopZoomFactor = normalizeDesktopZoomMetricsScale(desktopZoomFactor);
      await this.setTabViewport(tab, viewport);
      return;
    }
    await this.resetTabViewport(tab);
  }

  getTabOwner(tabId: string): BrowserGuestExecutionContext | null {
    const owner = this.tabs.get(tabId)?.owner;
    return owner ? { ...owner } : null;
  }

  /** Reverse-looks the controlled tab from a guest WebContents, so webview popup events can keep the original session scope. */
  getTabOwnerByWebContentsId(
    webContentsId: number,
  ): (BrowserGuestExecutionContext & { tabId: string }) | null {
    for (const tab of this.tabs.values()) {
      if (tab.guest?.id === webContentsId && tab.lifecycle !== "closed") {
        return { ...tab.owner, tabId: tab.tabId };
      }
    }
    return null;
  }

  async reportResidency(
    payload: BrowserViewResidencyReportPayload & { windowId: number },
  ): Promise<void> {
    const tab = this.requireRendererOwnedTab(payload);
    tab.cachedUrl = payload.restoreUrl?.trim() || tab.cachedUrl;
    if (payload.title !== undefined) tab.cachedTitle = payload.title ?? "";
    if (payload.faviconUrl !== undefined) tab.cachedFaviconUrl = payload.faviconUrl;
    tab.loading = payload.loading;
    this.residencyCoordinator.report(tab.tabId, {
      selected: payload.selected,
      visible: payload.visible,
      currentTask: payload.currentTask,
      loading: payload.loading,
      audible: safeBool(() => tab.guest?.isCurrentlyAudible?.() ?? false, false),
      mediaActive: tab.mediaActive,
      operationActive: this.hasRunningRequestForTab(tab.tabId),
      captureActive: this.isTabCaptureActive(tab),
      downloadActive: this.hasPendingDownloadForTab(tab.tabId),
    });
    if (payload.selected) {
      tab.active = true;
      if (!tab.claimable) this.selectTab(tab, false);
      // The renderer front desk report is a signal that the user is actually looking at it (panel expansion/tab cutting), and has nothing to do with claimable.
      // Recovery must be triggered independently of selectTab.
      this.maybeRestoreBackgroundViewport(tab);
    } else {
      tab.active = false;
      const key = scopeKey(tab.owner);
      if (this.activeTabByScope.get(key) === tab.tabId) this.activeTabByScope.delete(key);
    }
    await this.persistShell(tab);
    await this.residencyCoordinator.whenIdle();
  }

  acknowledgeSuspend(payload: { tabId: string; generation: number; windowId: number }): void {
    const tab = this.tabs.get(payload.tabId);
    if (!tab || tab.owner.windowId !== payload.windowId) return;
    const key = suspendAckKey(payload.tabId, payload.generation);
    this.suspendAckWaiters.get(key)?.();
  }

  async closeTabFromRenderer(
    payload: BrowserViewCloseTabRequest & { windowId: number },
  ): Promise<void> {
    // Agent close has removed the logical tab from main and the BrowserViewCloseTab notification may fall
    // The non-current workspace is discarded by the renderer, and the shell remains on the UI side. At this time, the user clicks × to go here and directly throw
    // "unavailable for renderer scope", the renderer will never remove the UI unless it obtains authorization - the tab will never be closed.
    // main no longer has this logical tab. It is safe and necessary for renderer to converge its own shell: idempotent release,
    // Attach the tombstone at the same time to prevent late attach from resurrecting it. Scope verification only takes effect on tabs that are still alive.
    // Cross-window/workspace unauthorized closing of other people's tabs is still rejected.
    const existing = this.tabs.get(payload.tabId);
    if (!existing || existing.lifecycle === "closed") {
      this.closedTabIds.add(payload.tabId);
      return;
    }
    // close is the convergence intention: the anti-reconnection semantics of remoteSessionId only belong to attach (see attachGuest's
    // remote-session-mismatch). The renderer on the attach side has workspaceRemoteSessionId for this field.
    // There is no close side. Strict comparison will prevent the remote human tab from being closed forever. The renderer closing its own visible tab does not constitute
    // In case of override, the three items of window/workspace/session are still strictly verified, and cross-scope override shutdown is still rejected.
    const tab = this.requireRendererOwnedTab(payload, { skipRemoteSession: true });
    await this.closeTabDurably(tab, false);
  }

  async whenRecoveryIdle(): Promise<void> {
    await this.residencyOptions.recoveryStore?.whenIdle?.();
  }

  async ensureResidentFromRenderer(
    payload: BrowserViewCloseTabRequest & { windowId: number },
  ): Promise<void> {
    const tab = this.requireRendererOwnedTab(payload);
    const guest = await this.ensureGuest(tab, new AbortController().signal);
    if (!guest) throw new Error(`browser tab '${tab.tabId}' restore failed`);
  }

  async restoreTabs(payload: {
    windowId: number;
    workspaceKey: string;
    remoteSessionId?: string;
    sessionId?: string;
  }): Promise<BrowserViewRestoredTabShell[]> {
    const records =
      (await this.residencyOptions.recoveryStore?.listShells({
        workspaceKey: payload.workspaceKey,
        ...(payload.remoteSessionId ? { remoteSessionId: payload.remoteSessionId } : {}),
        ...(payload.sessionId ? { sessionId: payload.sessionId } : {}),
      })) ?? [];
    this.log?.(
      `[browser-use] restoreTabs windowId=${payload.windowId} workspaceKey=${payload.workspaceKey} remoteSessionId=${payload.remoteSessionId ?? "<local>"} sessionId=${payload.sessionId ?? "<all>"} records=${records.length}`,
    );
    const restored: BrowserViewRestoredTabShell[] = [];
    for (const record of records) {
      if (this.closedTabIds.has(record.tabId)) continue;
      const claimedWindowId = this.restoredTabClaims.get(record.tabId);
      if (claimedWindowId !== undefined && claimedWindowId !== payload.windowId) continue;
      this.restoredTabClaims.set(record.tabId, payload.windowId);

      let tab = this.tabs.get(record.tabId);
      if (!tab) {
        const owner: InternalExecutionContext = {
          requestId: `restore:${randomUUID()}`,
          browserId:
            record.browserId ?? (record.origin === "user" ? "unclaimed-iab" : "restored-iab"),
          browserGeneration: record.browserGeneration ?? 0,
          windowId: payload.windowId,
          workspaceKey: record.workspaceKey,
          ...(record.remoteSessionId ? { remoteSessionId: record.remoteSessionId } : {}),
          sessionId: record.sessionId,
          clientMode: "desktop-continuous",
        };
        tab = {
          tabId: record.tabId,
          owner,
          cdpAttached: false,
          guestLifecycle: "detached",
          pendingCdpCommands: 0,
          guestGeneration: 0,
          hasAttachedGuest: false,
          rebindRequested: false,
          lifecycle: record.lifecycle,
          origin: record.origin,
          claimable: record.origin === "user",
          ...(record.origin === "user" ? { userOwner: { ...owner } } : {}),
          active: false,
          ...(record.viewport ? { viewportOverride: { ...record.viewport } } : {}),
          loading: false,
          mediaActive: false,
          cachedUrl: record.restoreUrl ?? "",
          cachedTitle: record.title ?? "",
          cachedFaviconUrl: record.faviconUrl,
          openedAt: record.openedAt,
          restoredFromStore: true,
        };
        this.tabs.set(record.tabId, tab);
        this.registerTabResidency(tab, false, "suspended", record.lastSelectedAt);
      } else if (tab.owner.windowId !== payload.windowId) {
        continue;
      }
      restored.push(toRestoredShell(record, tab.owner));
    }
    return restored;
  }

  async execute(
    contextOrKey: BrowserGuestExecutionContext | string,
    command: BrowserCommand,
    signal?: AbortSignal,
  ): Promise<BrowserCommandResult> {
    const context =
      typeof contextOrKey === "string" ? normalizeLegacyContext(contextOrKey) : contextOrKey;
    this.log?.(
      `[browser-use] execute requestId=${context.requestId} browserId=${context.browserId} generation=${context.browserGeneration} windowId=${context.windowId} sessionId=${context.sessionId} method=${command.method}`,
    );

    if (this.runningRequests.has(context.requestId)) {
      // requestId is the correlation key between cancellation and lifecycle cleanup. Overwriting with the same key will make
      // The error scope is unhit, and the old finally deletes the new entry that is still executing. Repeated requests must fail before being issued.
      return this.withMeta(
        {
          ok: false,
          error: {
            code: "duplicate_request_id",
            message: `browser requestId '${context.requestId}' is already running`,
            sideEffect: "none",
          },
          elapsedMs: 0,
        },
        context,
      );
    }

    if (command.method === "cancelRequest") {
      const cancelled = this.abortRequest(command.requestId, context);
      return this.withMeta({ ok: true, value: { cancelled }, elapsedMs: 0 }, context);
    }
    if (command.method === "turnEnded") {
      this.endTurn(context, command.turnId ?? context.turnId);
      return this.withMeta({ ok: true, elapsedMs: 0 }, context);
    }
    if (command.method === "closeSession") {
      this.closeSession(context);
      return this.withMeta({ ok: true, elapsedMs: 0 }, context);
    }

    const controller = new AbortController();
    const unlink = linkAbortSignal(signal, controller);
    const running: RunningRequest = { context, controller, dispatched: false };
    this.runningRequests.set(context.requestId, running);
    try {
      return await this.executeInScope(context, command, running);
    } finally {
      unlink();
      // Cleaning must be bound to the entry identity; even if other entries mistakenly write the same key in the future, the old request cannot delete the new state.
      if (this.runningRequests.get(context.requestId) === running) {
        this.runningRequests.delete(context.requestId);
      }
      if (running.tabId) this.refreshRuntimeProtection(running.tabId);
    }
  }

  private async executeInScope(
    context: InternalExecutionContext,
    command: BrowserCommand,
    running: RunningRequest,
  ): Promise<BrowserCommandResult> {
    const startedAt = Date.now();
    if (running.controller.signal.aborted) {
      return this.cancelledResult(context, false, startedAt);
    }

    if (command.method === "list") {
      const tabs = await Promise.all(this.ownedTabs(context).map((tab) => this.summary(tab)));
      return this.withMeta({ ok: true, tabs, elapsedMs: Date.now() - startedAt }, context);
    }

    if (command.method === "listUserTabs") {
      const userTabs = this.openUserTabs(context).map((tab) => this.userTabInfo(tab));
      return this.withMeta({ ok: true, userTabs, elapsedMs: Date.now() - startedAt }, context);
    }

    if (command.method === "nameSession") {
      this.sessionNames.set(scopeKey(context), command.name);
      return this.withMeta({ ok: true, elapsedMs: Date.now() - startedAt }, context);
    }

    if (command.method === "browserVisibilityGet") {
      return this.withMeta(
        {
          ok: true,
          value: this.visibilityByScope.get(scopeKey(context)) === true,
          elapsedMs: Date.now() - startedAt,
        },
        context,
      );
    }

    if (command.method === "browserVisibilitySet") {
      const key = scopeKey(context);
      this.visibilityByScope.set(key, command.visible);
      const active = this.activeTabByScope.get(key);
      const selected = active ? this.tabs.get(active) : this.ownedTabs(context).at(-1);
      this.onVisibilityChanged?.(command.visible, context, selected?.tabId);
      return this.withMeta({ ok: true, elapsedMs: Date.now() - startedAt }, context, selected);
    }

    if (command.method === "browserViewportSet") {
      const tab = this.resolveTab(context, command.tabId);
      if (!tab) return this.unavailableTabResult(context, command.tabId, startedAt);
      const viewport = { width: command.width, height: command.height };
      await this.setTabViewport(tab, viewport);
      this.selectTab(tab, true);
      this.onViewportChanged?.(viewport, tab.owner, tab.tabId);
      return this.withMeta({ ok: true, elapsedMs: Date.now() - startedAt }, context, tab);
    }

    if (command.method === "browserViewportReset") {
      const tab = this.resolveTab(context, command.tabId);
      if (!tab) return this.unavailableTabResult(context, command.tabId, startedAt);
      await this.resetTabViewport(tab);
      this.onViewportChanged?.(null, tab.owner, tab.tabId);
      return this.withMeta({ ok: true, elapsedMs: Date.now() - startedAt }, context, tab);
    }

    if (command.method === "recordingStatus" || command.method === "recordingCancel") {
      const entry = this.recordings.get(command.recordingId);
      if (!entry || !sameScope(entry.context, context)) {
        return this.withMeta(
          {
            ok: false,
            error: {
              code: "backend_unavailable",
              message: `browser recording '${command.recordingId}' is unavailable in this context`,
              sideEffect: "none",
            },
            elapsedMs: Date.now() - startedAt,
          },
          context,
        );
      }
      if ("tabId" in command && command.tabId && command.tabId !== entry.tabId) {
        return this.withMeta(
          {
            ok: false,
            error: {
              code: "backend_unavailable",
              message: `browser recording '${command.recordingId}' does not belong to tab '${command.tabId}'`,
              sideEffect: "none",
            },
            elapsedMs: Date.now() - startedAt,
          },
          context,
        );
      }
      if (command.method === "recordingCancel" && entry.status === "running") {
        entry.controller.abort(new DOMException("recording cancelled", "AbortError"));
        this.setRecordingTerminal(entry, "cancelled");
      }
      return this.withMeta(
        {
          ok: true,
          recording: this.snapshotRecording(entry),
          elapsedMs: Date.now() - startedAt,
        },
        context,
        this.tabs.get(entry.tabId),
      );
    }

    if (command.method === "activateTab") {
      const tab = this.tabs.get(command.tabId);
      if (!tab || tab.lifecycle === "closed" || !sameScope(tab.owner, context)) {
        return this.withMeta(
          {
            ok: false,
            error: {
              code: "backend_unavailable",
              message: `browser tab '${command.tabId}' is unavailable for activation. ${TAB_CONTEXT_RECOVERY_HINT}`,
            },
            elapsedMs: Date.now() - startedAt,
          },
          context,
        );
      }
      running.tabId = tab.tabId;
      this.refreshRuntimeProtection(tab.tabId);
      const guest = await this.ensureGuest(tab, running.controller.signal);
      if (!guest || safeBool(() => guest.isDestroyed(), true)) {
        return this.withMeta(
          {
            ok: false,
            error: {
              code: "backend_unavailable",
              message: `browser tab '${command.tabId}' could not be restored for activation`,
            },
            elapsedMs: Date.now() - startedAt,
          },
          context,
          tab,
        );
      }
      // The old tabs.get only creates the Tab binding within the agent, the renderer may still display another page.
      // Activation must first atomically update the main selected state, and then notify the origin renderer; the renderer is only in this scope
      // Expand the corresponding view when you are in the foreground. The background conversation can only record the active state and cannot grab the user's current session.
      this.selectTab(tab, true);
      return this.withMeta(
        {
          ok: true,
          tab: await this.summary(tab),
          elapsedMs: Date.now() - startedAt,
        },
        context,
        tab,
      );
    }

    if (command.method === "claimTab") {
      const candidate = this.tabs.get(command.tabId);
      if (!candidate || !this.canClaimUserTab(candidate, context)) {
        return this.withMeta(
          {
            ok: false,
            error: {
              code: "backend_unavailable",
              message: `user browser tab '${command.tabId}' is unavailable or already claimed`,
            },
            elapsedMs: Date.now() - startedAt,
          },
          context,
        );
      }
      const tab = this.claimTab(candidate, context);
      return this.withMeta(
        {
          ok: true,
          tab: await this.summary(tab),
          elapsedMs: Date.now() - startedAt,
        },
        context,
        tab,
      );
    }

    if (command.method === "finalizeTabs") {
      const keep = new Map(command.keep.map((item) => [item.tabId, item.status]));
      const unknown = [...keep.keys()].filter(
        (tabId) => !this.ownedTabs(context).some((tab) => tab.tabId === tabId),
      );
      if (unknown.length > 0) {
        return this.withMeta(
          {
            ok: false,
            error: {
              code: "backend_unavailable",
              message: `cannot finalize unknown tab(s): ${unknown.join(", ")}`,
            },
            elapsedMs: Date.now() - startedAt,
          },
          context,
        );
      }
      this.finalizeTabs(context, keep);
      return this.withMeta({ ok: true, elapsedMs: Date.now() - startedAt }, context);
    }

    if (command.method === "newTab") {
      const tab = this.createTab(context);
      running.tabId = tab.tabId;
      this.refreshRuntimeProtection(tab.tabId);
      const guest = await this.ensureGuest(tab, running.controller.signal);
      if (!guest) {
        const result = this.cancelledOrUnavailable(context, running, startedAt, tab);
        // When newTab fails before ready ack, it cannot leave a provisional tab without guest; otherwise, subsequent list/attach
        // A canceled creation will be mistaken for a still-lived tab. close also sends an uninstall request to the renderer and leaves the tombstone.
        await this.closeTabDurably(tab);
        return this.withMeta(result, context, tab, "closed");
      }
      return this.withMeta(
        {
          ok: true,
          tab: await this.summary(tab),
          elapsedMs: Date.now() - startedAt,
        },
        context,
        tab,
      );
    }

    const tab = this.resolveTab(context, "tabId" in command ? command.tabId : undefined);
    if (!tab) {
      return this.withMeta(
        {
          ok: false,
          error: {
            code: "backend_unavailable",
            message:
              "tabId" in command && command.tabId
                ? `browser tab '${command.tabId}' is not visible in the current context. ${TAB_CONTEXT_RECOVERY_HINT}`
                : "browser tab is unavailable",
          },
          elapsedMs: Date.now() - startedAt,
        },
        context,
      );
    }
    running.tabId = tab.tabId;
    this.refreshRuntimeProtection(tab.tabId);

    if (command.method === "recordingStart") {
      const active = [...this.recordings.values()].find(
        (entry) => entry.tabId === tab.tabId && entry.status === "running",
      );
      if (active) {
        return this.withMeta(
          {
            ok: false,
            error: {
              code: "execution_error",
              message: `browser tab '${tab.tabId}' already has active recording '${active.id}'`,
              sideEffect: "none",
            },
            elapsedMs: Date.now() - startedAt,
          },
          context,
          tab,
        );
      }
      const entry = this.createRecordingEntry(context, tab);
      this.recordings.set(entry.id, entry);
      this.refreshRuntimeProtection(tab.tabId);
      void this.runRecording(entry, tab, command.options).catch((error: unknown) => {
        if (entry.status !== "running") return;
        if (
          entry.controller.signal.aborted &&
          entry.controller.signal.reason instanceof DOMException &&
          entry.controller.signal.reason.name === "TimeoutError"
        ) {
          this.setRecordingTerminal(entry, "failed", entry.controller.signal.reason.message);
        } else if (entry.controller.signal.aborted) {
          this.setRecordingTerminal(entry, "cancelled");
        } else {
          this.setRecordingTerminal(
            entry,
            "failed",
            error instanceof Error ? error.message : String(error),
          );
        }
      });
      return this.withMeta(
        {
          ok: true,
          recording: this.snapshotRecording(entry),
          elapsedMs: Date.now() - startedAt,
        },
        context,
        tab,
      );
    }

    if (command.method === "getDialog") {
      return this.withMeta(
        {
          ok: true,
          dialog: this.pendingDialogs.get(tab.tabId) ?? null,
          elapsedMs: Date.now() - startedAt,
        },
        context,
        tab,
      );
    }
    if (command.method === "close") {
      await this.closeTabDurably(tab);
      return this.withMeta({ ok: true, elapsedMs: Date.now() - startedAt }, context, tab, "closed");
    }
    if (command.method === "finalize") {
      tab.lifecycle = command.deliverable === false ? "active" : "deliverable";
      return this.withMeta({ ok: true, elapsedMs: Date.now() - startedAt }, context, tab);
    }
    if (command.method === "markDeliverable") {
      tab.lifecycle = "deliverable";
      return this.withMeta({ ok: true, elapsedMs: Date.now() - startedAt }, context, tab);
    }
    if (command.method === "markHandoff") {
      tab.lifecycle = "handoff";
      return this.withMeta({ ok: true, elapsedMs: Date.now() - startedAt }, context, tab);
    }
    if (command.method === "playwrightWaitForTimeout") {
      // Fixed validating tabs before waiting; the wait itself does not touch the page and does not require guest/CDP to be attached.
      // turn/session/request abort must end the timer in advance to prevent the canceled sleep from continuing to occupy the life cycle.
      const completed = await waitForDelay(command.timeoutMs, running.controller.signal);
      if (!completed) {
        return this.withMeta(this.cancelledResult(context, false, startedAt), context, tab);
      }
      return this.withMeta({ ok: true, elapsedMs: Date.now() - startedAt }, context, tab);
    }
    if (
      command.method === "playwright" &&
      (command.action.name === "fileChooserSetFiles" ||
        (command.action.name === "waitForEvent" && command.action.event === "filechooser"))
    ) {
      // The IAB backend does not support filechooser; you cannot fake success or mistake it for a normal DOM fill.
      return this.withMeta(
        {
          ok: false,
          error: {
            code: "capability_unsupported",
            message: "File uploads are not supported by iab",
          },
          elapsedMs: Date.now() - startedAt,
        },
        context,
        tab,
      );
    }
    if (command.method === "playwright" && command.action.name === "downloadPath") {
      const record = this.downloads.get(command.action.downloadId);
      if (!record || record.tabId !== tab.tabId) {
        return this.withMeta(
          {
            ok: false,
            error: {
              code: "backend_unavailable",
              message: "download is unavailable for this tab",
            },
            elapsedMs: Date.now() - startedAt,
          },
          context,
          tab,
        );
      }
      const status = await waitForCondition(
        // Playwright's download.path() waits for the download to complete before returning; the will-download stage already exists
        // savePath does not mean that the file is safe to read and cannot be resolved in advance.
        () => record.state !== "pending",
        command.action.timeoutMs ?? 30_000,
        running.controller.signal,
      );
      if (status === "cancelled") {
        return this.withMeta(this.cancelledResult(context, false, startedAt), context, tab);
      }
      if (status === "timeout") {
        return this.withMeta(
          {
            ok: false,
            error: {
              code: "timeout",
              message: "Timeout waiting for download path",
            },
            elapsedMs: Date.now() - startedAt,
          },
          context,
          tab,
        );
      }
      if (record.state !== "completed") {
        return this.withMeta(
          {
            ok: false,
            error: {
              code: "execution_error",
              message: `download ${record.state}`,
              sideEffect: "uncertain",
            },
            elapsedMs: Date.now() - startedAt,
          },
          context,
          tab,
        );
      }
      return this.withMeta(
        { ok: true, value: record.path, elapsedMs: Date.now() - startedAt },
        context,
        tab,
      );
    }

    const guest = await this.ensureGuest(tab, running.controller.signal);
    if (!guest) return this.cancelledOrUnavailable(context, running, startedAt, tab);
    if (safeBool(() => guest.isDestroyed(), false)) {
      this.detachGuest(tab);
      return this.withMeta(
        {
          ok: false,
          error: {
            code: "backend_unavailable",
            message: "browser guest destroyed",
          },
          elapsedMs: Date.now() - startedAt,
        },
        context,
        tab,
      );
    }
    if ((tab.viewportOverride || tab.backgroundViewportFallback) && guest.getZoomFactor() !== 1)
      guest.setZoomFactor(1);
    const guestGeneration = tab.guestGeneration;
    const assertCurrentGuest = (): void => {
      if (tab.guestLifecycle === "detaching") {
        throw new Error("browser guest is detaching");
      }
      if (
        tab.guest !== guest ||
        tab.guestGeneration !== guestGeneration ||
        safeBool(() => guest.isDestroyed(), true)
      ) {
        throw new Error("browser guest changed before command dispatch");
      }
    };
    const sendCdpCommand = (method: string, params?: unknown, sessionId?: string) =>
      this.sendGuestCdpCommand(tab, guest, method, params, sessionId, assertCurrentGuest);

    if (
      command.method === "playwright" &&
      command.action.name === "waitForEvent" &&
      command.action.event === "download"
    ) {
      const downloadId = await this.waitForDownload(
        tab.tabId,
        // Download events default to waiting 3s, but callers are allowed to explicitly extend this to up to 120s for real downloads.
        normalizePlaywrightTimeout(command.action.timeoutMs, 120_000),
        running.controller.signal,
      );
      if (!downloadId) {
        const result = running.controller.signal.aborted
          ? this.cancelledResult(context, false, startedAt)
          : {
              ok: false as const,
              error: {
                code: "timeout" as const,
                message: "Timeout waiting for download",
              },
              elapsedMs: Date.now() - startedAt,
            };
        return this.withMeta(result, context, tab);
      }
      return this.withMeta(
        {
          ok: true,
          value: { id: downloadId },
          elapsedMs: Date.now() - startedAt,
        },
        context,
        tab,
      );
    }

    if (command.method === "handleDialog") {
      try {
        assertCurrentGuest();
      } catch {
        return this.withMeta(
          {
            ok: false,
            error: {
              code: "backend_unavailable",
              message: "browser guest changed before command dispatch",
              sideEffect: "none",
            },
            elapsedMs: Date.now() - startedAt,
          },
          context,
          tab,
        );
      }
      running.dispatched = true;
      const execution = sendCdpCommand("Page.handleJavaScriptDialog", {
        accept: command.accept,
        ...(command.promptText !== undefined ? { promptText: command.promptText } : {}),
      })
        .then<BrowserCommandResult>(() => ({
          ok: true,
          elapsedMs: Date.now() - startedAt,
        }))
        .catch<BrowserCommandResult>((error: unknown) => ({
          ok: false,
          error: {
            code: "execution_error",
            message: error instanceof Error ? error.message : String(error),
          },
          elapsedMs: Date.now() - startedAt,
        }));
      const result = await raceBackendExecution(
        execution,
        running.controller.signal,
        command,
        startedAt,
      );
      if (result.ok) {
        this.pendingDialogs.delete(tab.tabId);
      }
      return this.withMeta(result, context, tab);
    }

    const screenshotCommand = isScreenshotCommand(command);
    const previousScreenshot = screenshotCommand
      ? this.inFlightScreenshots.get(tab.tabId)
      : undefined;
    if (previousScreenshot && this.isInFlightScreenshotAlive(previousScreenshot)) {
      const elapsedMs = Date.now() - previousScreenshot.startedAt;
      this.log?.(
        `[browser-use] screenshot rejected tabId=${tab.tabId} requestId=${context.requestId} pendingRequestId=${previousScreenshot.requestId} pendingMs=${elapsedMs}`,
      );
      return this.withMeta(
        {
          ok: false,
          error: {
            code: "timeout",
            message:
              "A previous screenshot for this browser tab is still completing after timeout. " +
              "Wait before retrying, or reopen the tab if it does not recover.",
            sideEffect: "none",
          },
          elapsedMs: Date.now() - startedAt,
        },
        context,
        tab,
      );
    }
    const abandonedCaptures = screenshotCommand
      ? (this.abandonedScreenshotCaptures.get(tab.tabId) ?? 0)
      : 0;
    if (screenshotCommand && abandonedCaptures >= MAX_ABANDONED_SCREENSHOT_CAPTURES) {
      // The unsettled underlying capture has reached the hard limit: new pending CDP commands will no longer be superimposed and will fail quickly.
      // It will prompt you to reopen the tab; after the old capture is settled, the quota will be automatically recovered and can be restored without manual intervention.
      this.log?.(
        `[browser-use] screenshot rejected tabId=${tab.tabId} requestId=${context.requestId} abandonedCaptures=${abandonedCaptures}`,
      );
      return this.withMeta(
        {
          ok: false,
          error: {
            code: "timeout",
            message:
              `${abandonedCaptures} previous screenshot captures for this browser tab are still ` +
              "stuck in the backend after timeout. Reopen the tab to recover.",
            sideEffect: "none",
          },
          elapsedMs: Date.now() - startedAt,
        },
        context,
        tab,
      );
    }
    if (previousScreenshot) {
      // When the entire capture is hiding the window and waiting for frames, the 30s watchdog will die but the underlying execution will never
      // settle, the tracker cannot be cleaned, and all subsequent screenshots of the tab will be rejected in 0ms seconds until the tab is closed (production log
      // pendingMs up to 120s). A pending screenshot of a command that has returned or been aborted is considered a dead entry,
      // Directly replaced by new requests; cleaning is idempotent with entry identity, and late settlement will not delete new requests by mistake.
      this.log?.(
        `[browser-use] screenshot superseded stale pending tabId=${tab.tabId} requestId=${context.requestId} pendingRequestId=${previousScreenshot.requestId} pendingMs=${Date.now() - previousScreenshot.startedAt}`,
      );
    }

    const execution = screenshotCommand
      ? this.executeScreenshotWithPreparedSurface(
          context,
          tab,
          guest,
          command,
          running,
          startedAt,
          assertCurrentGuest,
          sendCdpCommand,
        )
      : executeBrowserCommandOnView(
          this.toControlledView(
            guest,
            Boolean(tab.viewportOverride || tab.backgroundViewportFallback),
            undefined,
            assertCurrentGuest,
            sendCdpCommand,
          ),
          command,
          { signal: running.controller.signal },
        );
    if (!screenshotCommand) running.dispatched = true;
    if (screenshotCommand) {
      const tracked: InFlightScreenshot = {
        execution,
        requestId: context.requestId,
        startedAt: Date.now(),
      };
      this.inFlightScreenshots.set(tab.tabId, tracked);
      this.refreshRuntimeProtection(tab.tabId);
      const clearTrackedScreenshot = () => {
        if (this.inFlightScreenshots.get(tab.tabId) !== tracked) return;
        this.inFlightScreenshots.delete(tab.tabId);
        this.refreshRuntimeProtection(tab.tabId);
        this.log?.(
          `[browser-use] screenshot backend settled tabId=${tab.tabId} requestId=${context.requestId} elapsedMs=${Date.now() - tracked.startedAt}`,
        );
      };
      // Also provide fulfilled/rejected handlers to avoid unhandled derived rejections caused by just calling finally.
      void execution.then(clearTrackedScreenshot, clearTrackedScreenshot);
    }
    const result = await raceBackendExecution(
      execution,
      running.controller.signal,
      command,
      startedAt,
    );
    return this.withMeta(result, context, tab);
  }

  /**
   * The renderer's logical viewport ready only proves that the CSS coordinate system is correct; Windows negative scaling
   * The Fit preview may still only be 800×450 raster, CDP will tile it to 1280×720. main reads directly
   * The synthesized guest surface is then normalized to the logical viewport; this does not remove the renderer that triggered V8 FATAL
   * `<webview>.capturePage()` call does not change the page layout, DPR or interaction metrics.
   */
  private async executeScreenshotWithPreparedSurface(
    context: InternalExecutionContext,
    tab: ManagedTab,
    guest: GuestWebContents,
    command: BrowserCommand,
    running: RunningRequest,
    startedAt: number,
    assertCurrentGuest: () => void,
    sendCdpCommand: ControlledView["cdp"]["send"],
  ): Promise<BrowserCommandResult> {
    let lease: BrowserScreenshotSurfaceLease | undefined;
    try {
      const screenshotSurfaceCoordinator = this.screenshotSurfaceCoordinator;
      if (!screenshotSurfaceCoordinator) {
        throw new Error("browser screenshot surface coordinator is unavailable");
      }
      const viewport = await this.readTabViewport(tab);
      let result: BrowserCommandResult | undefined;

      // You cannot acquire activity first and then queue viewport mutation: when the preorder resize/CDP is stuck,
      // owner + guest will capture back-to-back outside the queue, and the longest time to burn is 35 seconds. Surface preparation must be done during this turn
      // Start after the viewport critical section to ensure that the activity only covers the real prepare + raster life cycle.
      await this.enqueueViewportMutation(tab, async () => {
        lease = await screenshotSurfaceCoordinator.prepare({
          requestId: context.requestId,
          windowId: context.windowId,
          workspaceKey: context.workspaceKey,
          sessionId: context.sessionId,
          browserId: context.browserId,
          browserGeneration: context.browserGeneration,
          tabId: tab.tabId,
          webContentsId: guest.id,
          viewport,
          // Naturally, the viewport does not have metrics installed; the renderer's temporary Fit cannot be used to expand the guest layout and trigger web page reflow.
          viewportMode:
            tab.viewportOverride || tab.backgroundViewportFallback ? "emulated" : "natural",
          signal: running.controller.signal,
        });
        if (
          running.controller.signal.aborted ||
          tab.guest !== guest ||
          guest.isDestroyed() ||
          lease.webContentsId !== guest.id
        ) {
          throw new Error("browser guest changed while preparing screenshot surface");
        }
        const invalidationError = readScreenshotSurfaceInvalidation(lease.invalidated);
        if (invalidationError) throw invalidationError;
        // Ordinary fallback also uses a temporary responsive surface, which must compensate for the host's amplified native raster.
        // Normal mode does not write back the viewport; hot zoom changes are synchronized within the same mutation and cannot just wait for idle reconnection.
        if (tab.backgroundViewportFallback) {
          const desktopZoom = guest.hostWebContents?.getZoomFactor();
          if (
            !guest.debugger.isAttached() ||
            tab.guestCdpRestoreFlight ||
            (tab.appliedViewportScale ?? 1) !== normalizeDesktopZoomMetricsScale(desktopZoom)
          ) {
            await this.sendGuestCdpCommand(
              tab,
              guest,
              "Emulation.setDeviceMetricsOverride",
              buildViewportMetricsOverride(tab.backgroundViewportFallback, desktopZoom),
            );
          }
        }
        const normalizedScreenshot = Boolean(
          tab.viewportOverride || tab.backgroundViewportFallback,
        );
        // When Windows 125% display zoom + Desktop 110%, the renderer even reports
        // surfaceScale=1, CDP will still tile smaller native raster cycles to the target size.
        // The enlarged and compensated viewport screenshot must also read the actual surface and then normalize it to CSS px.
        const captureViewportScreenshot =
          normalizedScreenshot &&
          (lease.surfaceScale < 0.999 ||
            (tab.appliedViewportScale ?? tab.desktopZoomFactor ?? 1) > 1)
            ? async (): Promise<string | undefined> => {
                if (!this.resizeScreenshotToCssPixels) {
                  throw new Error("browser screenshot CSS pixel normalizer is unavailable");
                }
                const surface = await guest.capturePage();
                const surfacePng = surface.toPNG();
                if (surfacePng.byteLength === 0) return undefined;
                return this.resizeScreenshotToCssPixels(surfacePng.toString("base64"), viewport);
              }
            : undefined;
        running.dispatched = true;
        // After the owner window is hidden (closed to the tray) the Windows compositor no longer synthesizes anything for the guest
        // Frame; the transparent bootstrap in the prepare stage is released in advance when the renderer is ready, and the entire capture
        // The frame can only be obtained after the user reopens the window (only about 140ms after tray-show in the log)
        // Completed, all remaining 30s watchdog is sentenced to death). Capture temporarily holds transparent presentation during the life cycle
        // (showInactive + opacity 0, invisible to the user) Actively request frames; at the same time, capture settlement must be racing
        // abort/bounded deadline - dangling execution will queue the viewport mutation and in-flight
        // Slots are delayed together, and mutations can never outlive the request itself.
        const capturePresentation = this.startHiddenWindowCapturePresentation(context, guest);
        try {
          // The same constraint as activity pump: after showInactive and before Viz surface is established, it is the same as turn. Reading back will throw
          // UnknownVizError. Wait for unified bounded presentation grace before initiating capture - normalization
          // guest.capturePage() of the path (background tab) is also sensitive to this.
          if (
            capturePresentation &&
            !(await waitForDelay(
              TRANSPARENT_WINDOW_PRESENTATION_GRACE_MS,
              running.controller.signal,
            ))
          ) {
            throw new Error("browser screenshot capture cancelled during presentation grace");
          }
          // Native capture does not go through sendCdpCommand and must wait for the metrics to be restored after idle detach.
          if (!guest.debugger.isAttached() || tab.guestCdpRestoreFlight) {
            await this.ensureGuestCdpAttached(tab, guest);
          }
          const captureExecution = executeBrowserCommandOnView(
            this.toControlledView(
              guest,
              normalizedScreenshot,
              captureViewportScreenshot,
              assertCurrentGuest,
              sendCdpCommand,
            ),
            command,
            { signal: running.controller.signal },
          );
          result = await this.settleScreenshotCapture(
            captureExecution,
            running.controller.signal,
            context,
            startedAt,
            tab.tabId,
            capturePresentation ? HIDDEN_WINDOW_CAPTURE_DEADLINE_MS : undefined,
          );
        } finally {
          capturePresentation?.release();
        }
        const lateInvalidationError = readScreenshotSurfaceInvalidation(lease.invalidated);
        if (lateInvalidationError) throw lateInvalidationError;
      });
      if (!result) throw new Error("browser screenshot did not produce a result");
      return result;
    } catch (error) {
      const cancelled = running.controller.signal.aborted;
      return {
        ok: false,
        error: {
          code: cancelled ? "cancelled" : "backend_unavailable",
          message: cancelled
            ? "browser screenshot surface preparation cancelled"
            : error instanceof Error
              ? error.message
              : String(error),
          sideEffect: "none",
        },
        elapsedMs: Date.now() - startedAt,
      };
    } finally {
      lease?.release();
    }
  }

  /** Create a one-time transparent presentation for the entire capture when the window is hidden; no-op when the window is visible or capabilities are not injected. */
  private startHiddenWindowCapturePresentation(
    context: InternalExecutionContext,
    guest: GuestWebContents,
  ): TransparentWindowBootstrap | undefined {
    if (!this.resolveOwnerWindow) return undefined;
    const win = this.resolveOwnerWindow(context.windowId);
    if (!win) return undefined;
    return (
      startBrowserScreenshotTransparentWindowBootstrap({
        win,
        enabled: true,
        windowId: context.windowId,
        webContentsId: guest.id,
        requestId: context.requestId,
        hideTaskbarDuringBootstrap: process.platform === "win32",
        log: this.log,
      }) || undefined
    );
  }

  /**
   * The unified exit for capture settlement: execution, request abort, and optional bounded deadline are settled on a first-come-first-served basis.
   * In scenarios such as hiding the window and waiting for frames, upstream 30s cancelRequest, etc., execution may never settle; wait for it,
   * The viewport mutation queue and in-flight slots are guaranteed to be released with the request. abort/deadline wins first
   * The underlying CDP command is still pending in Chromium and counts towards the abandonedScreenshotCaptures hard cap.
   */
  private async settleScreenshotCapture(
    execution: Promise<BrowserCommandResult>,
    signal: AbortSignal,
    context: InternalExecutionContext,
    startedAt: number,
    tabId: string,
    deadlineMs?: number,
  ): Promise<BrowserCommandResult> {
    return await new Promise<BrowserCommandResult>((resolve) => {
      let settled = false;
      const finish = (result: BrowserCommandResult): boolean => {
        if (settled) return false;
        settled = true;
        if (timer !== undefined) clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        resolve(result);
        return true;
      };
      const onAbort = () => {
        if (
          finish({
            ok: false,
            error: {
              code: "cancelled",
              message: "browser screenshot capture cancelled",
              sideEffect: "none",
            },
            elapsedMs: Date.now() - startedAt,
          })
        ) {
          this.abandonBackendCapture(tabId, execution);
        }
      };
      const timer =
        deadlineMs !== undefined
          ? setTimeout(() => {
              this.log?.(
                `[browser-use] hidden window capture deadline exceeded requestId=${context.requestId} windowId=${context.windowId} deadlineMs=${deadlineMs}`,
              );
              if (
                finish({
                  ok: false,
                  error: {
                    code: "timeout",
                    message: `browser screenshot capture timed out after ${deadlineMs}ms while the window was hidden`,
                    sideEffect: "none",
                  },
                  elapsedMs: Date.now() - startedAt,
                })
              ) {
                this.abandonBackendCapture(tabId, execution);
              }
            }, deadlineMs)
          : undefined;
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) {
        onAbort();
        return;
      }
      execution.then(finish, (error: unknown) =>
        finish({
          ok: false,
          error: {
            code: "execution_error",
            message: error instanceof Error ? error.message : String(error),
          },
          elapsedMs: Date.now() - startedAt,
        }),
      );
    });
  }

  /** Make a note of the capture that "has given up waiting but the bottom layer is still executing"; the quota will be automatically reclaimed after it is actually settled. */
  private abandonBackendCapture(tabId: string, execution: Promise<BrowserCommandResult>): void {
    this.abandonedScreenshotCaptures.set(
      tabId,
      (this.abandonedScreenshotCaptures.get(tabId) ?? 0) + 1,
    );
    execution.then(
      () => this.releaseAbandonedBackendCapture(tabId),
      () => this.releaseAbandonedBackendCapture(tabId),
    );
  }

  private releaseAbandonedBackendCapture(tabId: string): void {
    const count = this.abandonedScreenshotCaptures.get(tabId);
    if (count === undefined) return;
    if (count <= 1) this.abandonedScreenshotCaptures.delete(tabId);
    else this.abandonedScreenshotCaptures.set(tabId, count - 1);
  }

  private recordingNow(): number {
    return this.residencyOptions.recording?.now?.() ?? Date.now();
  }

  /**
   * Whether the suspended screenshot is still alive: the corresponding command is still being executed (there are unabort entries in runningRequests).
   * The entry has disappeared, indicating that the command has returned (typically 30s watchdog death) and the execution is suspended - a dead slot.
   */
  private isInFlightScreenshotAlive(tracked: InFlightScreenshot): boolean {
    const running = this.runningRequests.get(tracked.requestId);
    return Boolean(running) && !running.controller.signal.aborted;
  }

  private createRecordingEntry(
    context: InternalExecutionContext,
    tab: ManagedTab,
  ): BrowserRecordingEntry {
    const now = this.recordingNow();
    return {
      id: `iab-recording:${randomUUID()}`,
      context: { ...context },
      tabId: tab.tabId,
      controller: new AbortController(),
      status: "running",
      phase: "preparing",
      progress: 0,
      startedAt: now,
      updatedAt: now,
    };
  }

  private snapshotRecording(entry: BrowserRecordingEntry): BrowserRecordingJob {
    return {
      id: entry.id,
      status: entry.status,
      phase: entry.phase,
      progress: entry.progress,
      startedAt: entry.startedAt,
      updatedAt: entry.updatedAt,
      ...(entry.artifact ? { artifact: { ...entry.artifact } } : {}),
      ...(entry.error ? { error: entry.error } : {}),
    };
  }

  private setRecordingPhase(
    entry: BrowserRecordingEntry,
    phase: Extract<BrowserRecordingJob["phase"], "capturing" | "finalizing">,
  ): void {
    if (entry.status !== "running") return;
    entry.phase = phase;
    entry.progress = phase === "capturing" ? 0.1 : 0.9;
    entry.updatedAt = this.recordingNow();
    this.refreshRuntimeProtection(entry.tabId);
  }

  private setRecordingTerminal(
    entry: BrowserRecordingEntry,
    status: Extract<BrowserRecordingJob["status"], "completed" | "failed" | "cancelled">,
    error?: string,
  ): void {
    entry.status = status;
    entry.phase = status;
    entry.progress = status === "completed" ? 1 : entry.progress;
    entry.updatedAt = this.recordingNow();
    if (error) entry.error = error;
    else delete entry.error;
    if (!entry.cleanupTimer) {
      entry.cleanupTimer = setTimeout(() => {
        this.recordings.delete(entry.id);
        if (entry.artifact?.path) {
          void rm(entry.artifact.path, { force: true }).catch(() => undefined);
        }
      }, RECORDING_RESULT_TTL_MS);
      entry.cleanupTimer.unref?.();
    }
    this.refreshRuntimeProtection(entry.tabId);
  }

  private abortRecordings(
    predicate: (entry: BrowserRecordingEntry) => boolean,
    reason: string,
  ): void {
    for (const entry of this.recordings.values()) {
      if (entry.status !== "running" || !predicate(entry)) continue;
      entry.controller.abort(new DOMException(reason, "AbortError"));
      this.setRecordingTerminal(entry, "cancelled");
    }
  }

  private async runRecording(
    entry: BrowserRecordingEntry,
    tab: ManagedTab,
    rawOptions?: BrowserRecordingOptions,
  ): Promise<void> {
    const signal = entry.controller.signal;
    const options = rawOptions ?? {};
    const viewport = options.viewport ?? DEFAULT_AGENT_BROWSER_VIEWPORT;
    const fps = options.fps ?? 25;
    const maxDurationMs = options.maxDurationMs ?? 60_000;
    const settleMs = options.settleMs ?? 300;
    assertViewportOverride(viewport);

    const guest = await this.ensureGuest(tab, signal);
    if (!guest || guest.isDestroyed()) throw new Error("browser guest unavailable for recording");
    // Recording will temporarily override tab viewport override in exchange for 100% surface; first note the value before recording.
    const previousViewport = tab.viewportOverride ? { ...tab.viewportOverride } : undefined;
    let lease: BrowserScreenshotSurfaceLease | undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await this.setTabViewport(tab, viewport);
      // Only changing CDP metrics will not synchronize the free-size frame hosting WebView in the renderer; custom recording
      // The viewport will continue to use the old DOM bounds, and eventually either prepare will timeout, or it will become blurry when zooming in from the zoomed out surface.
      this.onViewportChanged?.(viewport, tab.owner, tab.tabId);
      const coordinator = this.screenshotSurfaceCoordinator;
      if (!coordinator) throw new Error("browser recording surface coordinator is unavailable");
      lease = await coordinator.prepare({
        requestId: `recording:${entry.id}`,
        windowId: entry.context.windowId,
        workspaceKey: entry.context.workspaceKey,
        sessionId: entry.context.sessionId,
        browserId: entry.context.browserId,
        browserGeneration: entry.context.browserGeneration,
        tabId: tab.tabId,
        webContentsId: guest.id,
        viewport,
        surfaceScaleMode: "unscaled",
        signal,
        activityTimeoutMs: maxDurationMs + 30_000,
      });
      if (!lease || lease.webContentsId !== guest.id) {
        throw new Error("browser guest changed while preparing recording surface");
      }
      const invalidationError = readScreenshotSurfaceInvalidation(lease.invalidated);
      if (invalidationError) throw invalidationError;
      const invalidateRecording = () =>
        entry.controller.abort(
          lease?.invalidated?.reason instanceof Error
            ? lease.invalidated.reason
            : new Error("browser recording surface invalidated"),
        );
      lease.invalidated?.addEventListener("abort", invalidateRecording, { once: true });
      timeout = setTimeout(
        () =>
          entry.controller.abort(new DOMException("browser recording timed out", "TimeoutError")),
        maxDurationMs,
      );
      const guestGeneration = tab.guestGeneration;
      const assertCurrentGuest = (): void => {
        if (tab.guestLifecycle === "detaching") {
          throw new Error("browser guest is detaching");
        }
        if (
          tab.guest !== guest ||
          tab.guestGeneration !== guestGeneration ||
          safeBool(() => guest.isDestroyed(), true)
        ) {
          throw new Error("browser guest changed before recording dispatch");
        }
      };
      const view = this.toControlledView(
        guest,
        true,
        undefined,
        assertCurrentGuest,
        (method, params, sessionId) =>
          this.sendGuestCdpCommand(tab, guest, method, params, sessionId, assertCurrentGuest),
      );
      if (options.showCursor !== false) await this.installRecordingCursorOverlay(guest);
      const createRecorder = this.residencyOptions.recording?.createRecorder;
      if (!createRecorder) throw new Error("browser WebM recorder is unavailable");
      entry.artifact = await recordBrowserVideo({
        targetFrame: guest.mainFrame,
        tempRoot: this.residencyOptions.recording?.tempRoot ?? tmpdir(),
        recordingId: entry.id.replace(/[^A-Za-z0-9._-]/gu, "-"),
        viewport,
        fps,
        signal,
        onPhase: (phase) => this.setRecordingPhase(entry, phase),
        onCaptureComplete: () => {
          // maxDurationMs only restricts page framing; encoding is the final stage, and a completely captured video cannot be accidentally killed.
          if (timeout) {
            clearTimeout(timeout);
            timeout = undefined;
          }
          lease?.release();
        },
        executeScenario: async () => {
          if (settleMs > 0 && !(await waitForDelay(settleMs, signal))) throw abortError();
          await this.executeRecordingActions(view, options.actions ?? [], signal, viewport);
        },
        createRecorder,
      });
      this.setRecordingTerminal(entry, "completed");
    } finally {
      if (timeout) clearTimeout(timeout);
      if (options.showCursor !== false) await this.removeRecordingCursorOverlay(guest);
      // lease.release() only recovers the instantaneous surface proportion, the tab's own viewport override will
      // Stay at the recording size, and subsequent previews and screenshots will be based on the recording viewport. The recording is temporarily borrowed and must be restored.
      await this.restoreRecordingViewport(tab, previousViewport).catch(() => undefined);
      lease?.release();
    }
  }

  /** Return the tab viewport that was temporarily rewritten during recording to the state before recording. */
  private async restoreRecordingViewport(
    tab: ManagedTab,
    previous: BrowserViewportSize | undefined,
  ): Promise<void> {
    if (tab.lifecycle === "closed") return;
    if (previous) {
      await this.setTabViewport(tab, previous);
      this.onViewportChanged?.(previous, tab.owner, tab.tabId);
      return;
    }
    await this.resetTabViewport(tab);
    this.onViewportChanged?.(null, tab.owner, tab.tabId);
  }

  private async executeRecordingActions(
    view: ControlledView,
    actions: BrowserRecordingAction[],
    signal: AbortSignal,
    viewport: BrowserViewportSize,
  ): Promise<void> {
    const pointer = { x: viewport.width / 2, y: viewport.height / 2 };
    for (const action of actions) {
      if (signal.aborted) throw abortError();
      await this.executeRecordingAction(view, action, signal, pointer);
      const delayAfterMs = "delayAfterMs" in action ? action.delayAfterMs : undefined;
      if (delayAfterMs && !(await waitForDelay(delayAfterMs, signal))) throw abortError();
    }
  }

  private async executeRecordingAction(
    view: ControlledView,
    action: BrowserRecordingAction,
    signal: AbortSignal,
    pointer: { x: number; y: number },
  ): Promise<void> {
    if (action.type === "wait") {
      if (!(await waitForDelay(action.durationMs, signal))) throw abortError();
      return;
    }
    if (action.type === "click" || action.type === "type" || action.type === "waitFor") {
      const locatorAction =
        action.type === "click"
          ? action.selector
            ? {
                name: "locator" as const,
                selector: action.selector,
                operation: action.doubleClick ? ("dblclick" as const) : ("click" as const),
                ...(action.button ? { button: action.button } : {}),
              }
            : undefined
          : action.type === "type"
            ? {
                name: "locator" as const,
                selector: action.selector,
                operation: "fill" as const,
                value: action.text,
              }
            : {
                name: "locator" as const,
                selector: action.selector,
                operation: "waitFor" as const,
                state: action.state ?? "visible",
              };
      if (locatorAction) {
        const result = await executeIabPlaywrightLocator(
          view,
          locatorAction,
          action.type === "waitFor" ? (action.timeoutMs ?? 3_000) : 3_000,
          signal,
        );
        if (result.kind === "cancelled") throw abortError();
        if (result.kind === "timeout")
          throw new Error(`recording action timed out: ${result.reason}`);
        return;
      }
      if (typeof action.x !== "number" || typeof action.y !== "number") {
        throw new Error("recording click requires selector or (x,y)");
      }
      await this.executeRecordingBrowserCommand(view, {
        method: "click",
        x: action.x,
        y: action.y,
        ...(action.button ? { button: action.button } : {}),
        ...(action.doubleClick !== undefined ? { doubleClick: action.doubleClick } : {}),
      });
      pointer.x = action.x;
      pointer.y = action.y;
      return;
    }
    if (action.type === "hover") {
      if (action.selector) {
        const point = await this.resolveRecordingSelectorPoint(view, action.selector, signal);
        await this.moveRecordingPointer(
          view,
          point.x,
          point.y,
          action.durationMs ?? 0,
          signal,
          pointer,
        );
      } else if (typeof action.x === "number" && typeof action.y === "number") {
        await this.moveRecordingPointer(
          view,
          action.x,
          action.y,
          action.durationMs ?? 0,
          signal,
          pointer,
        );
      } else {
        throw new Error("recording hover requires selector or (x,y)");
      }
      return;
    }
    if (action.type === "move") {
      await this.moveRecordingPointer(
        view,
        action.x,
        action.y,
        action.durationMs ?? 0,
        signal,
        pointer,
      );
      return;
    }
    if (action.type === "scroll") {
      await this.animateRecordingScroll(
        view,
        action.deltaX ?? 0,
        action.deltaY,
        action.durationMs ?? 0,
        signal,
      );
      return;
    }
    if (action.type === "scrollTo") {
      const current = (await view.webContents.executeJavaScript(
        "({ x: window.scrollX, y: window.scrollY })",
      )) as { x?: unknown; y?: unknown };
      const target = action.selector
        ? await this.resolveRecordingSelectorScrollTarget(view, action.selector, signal)
        : { x: action.x ?? Number(current.x ?? 0), y: action.y ?? Number(current.y ?? 0) };
      await this.animateRecordingScroll(
        view,
        target.x - Number(current.x ?? 0),
        target.y - Number(current.y ?? 0),
        action.durationMs ?? 0,
        signal,
      );
      return;
    }
    if (action.type === "wheel") {
      const times = action.times ?? 1;
      for (let index = 0; index < times; index += 1) {
        await this.executeRecordingBrowserCommand(view, {
          method: "scroll",
          x: action.deltaX ?? 0,
          y: action.deltaY,
        });
        if (action.intervalMs && !(await waitForDelay(action.intervalMs, signal)))
          throw abortError();
      }
      return;
    }
    if (action.type === "drag") {
      const steps = Math.max(1, action.path.length - 1);
      const intervalMs = Math.floor((action.durationMs ?? 0) / steps);
      await view.cdp.send("Input.dispatchMouseEvent", {
        type: "mouseMoved",
        x: action.path[0]!.x,
        y: action.path[0]!.y,
      });
      await view.cdp.send("Input.dispatchMouseEvent", {
        type: "mousePressed",
        x: action.path[0]!.x,
        y: action.path[0]!.y,
        button: "left",
        clickCount: 1,
      });
      for (const point of action.path.slice(1)) {
        await view.cdp.send("Input.dispatchMouseEvent", {
          type: "mouseMoved",
          x: point.x,
          y: point.y,
          button: "left",
          buttons: 1,
        });
        if (intervalMs > 0 && !(await waitForDelay(intervalMs, signal))) throw abortError();
      }
      const last = action.path.at(-1)!;
      await view.cdp.send("Input.dispatchMouseEvent", {
        type: "mouseReleased",
        x: last.x,
        y: last.y,
        button: "left",
        clickCount: 1,
      });
      pointer.x = last.x;
      pointer.y = last.y;
    }
  }

  private async executeRecordingBrowserCommand(
    view: ControlledView,
    command: BrowserCommand,
  ): Promise<void> {
    const result = await executeBrowserCommandOnView(view, command);
    if (!result.ok)
      throw new Error(result.error?.message ?? `recording action ${command.method} failed`);
  }

  private async resolveRecordingSelectorPoint(
    view: ControlledView,
    selector: string,
    signal: AbortSignal,
  ): Promise<{ x: number; y: number }> {
    const result = await executeIabPlaywrightLocator(
      view,
      {
        name: "locator",
        selector,
        operation: "evaluate",
        expressionKind: "function",
        expression:
          "(element) => { const rect = element.getBoundingClientRect(); return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }; }",
      },
      3_000,
      signal,
    );
    if (result.kind !== "done" || !isBrowserPointValue(result.value)) {
      throw new Error(`recording selector '${selector}' has no visible point`);
    }
    return result.value;
  }

  private async resolveRecordingSelectorScrollTarget(
    view: ControlledView,
    selector: string,
    signal: AbortSignal,
  ): Promise<{ x: number; y: number }> {
    const result = await executeIabPlaywrightLocator(
      view,
      {
        name: "locator",
        selector,
        operation: "evaluate",
        expressionKind: "function",
        expression:
          "(element) => { const rect = element.getBoundingClientRect(); return { x: window.scrollX + rect.left, y: window.scrollY + rect.top }; }",
      },
      3_000,
      signal,
    );
    if (result.kind !== "done" || !isBrowserPointValue(result.value)) {
      throw new Error(`recording selector '${selector}' has no scroll target`);
    }
    return result.value;
  }

  private async moveRecordingPointer(
    view: ControlledView,
    x: number,
    y: number,
    durationMs: number,
    signal: AbortSignal,
    pointer: { x: number; y: number },
  ): Promise<void> {
    const steps = Math.max(1, Math.min(60, Math.round(durationMs / 16)));
    const startX = pointer.x;
    const startY = pointer.y;
    for (let index = 1; index <= steps; index += 1) {
      if (signal.aborted) throw abortError();
      const progress = index / steps;
      await view.cdp.send("Input.dispatchMouseEvent", {
        type: "mouseMoved",
        x: startX + (x - startX) * progress,
        y: startY + (y - startY) * progress,
      });
      if (durationMs > 0 && index < steps && !(await waitForDelay(durationMs / steps, signal))) {
        throw abortError();
      }
    }
    pointer.x = x;
    pointer.y = y;
  }

  private async installRecordingCursorOverlay(guest: GuestWebContents): Promise<void> {
    await guest.executeJavaScript(`(() => {
      const id = "__zcode_browser_recording_cursor";
      document.getElementById(id)?.remove();
      const cursor = document.createElement("div");
      cursor.id = id;
      cursor.style.cssText = "position:fixed;left:0;top:0;width:18px;height:18px;border-radius:50%;background:#ff4d4f;border:2px solid #fff;box-shadow:0 1px 5px rgba(0,0,0,.45);pointer-events:none;z-index:2147483647;transform:translate(-50%,-50%);opacity:0;transition:opacity 80ms linear";
      document.documentElement.appendChild(cursor);
      const move = (event) => {
        cursor.style.left = event.clientX + "px";
        cursor.style.top = event.clientY + "px";
        cursor.style.opacity = "1";
      };
      const down = () => {
        cursor.style.transform = "translate(-50%,-50%) scale(.72)";
      };
      const up = () => {
        cursor.style.transform = "translate(-50%,-50%) scale(1)";
      };
      window["__zcodeBrowserRecordingCursorCleanup"]?.();
      window.addEventListener("mousemove", move, true);
      window.addEventListener("mousedown", down, true);
      window.addEventListener("mouseup", up, true);
      window["__zcodeBrowserRecordingCursorCleanup"] = () => {
        window.removeEventListener("mousemove", move, true);
        window.removeEventListener("mousedown", down, true);
        window.removeEventListener("mouseup", up, true);
        cursor.remove();
        delete window["__zcodeBrowserRecordingCursorCleanup"];
      };
    })()`);
  }

  private async removeRecordingCursorOverlay(guest: GuestWebContents): Promise<void> {
    if (guest.isDestroyed()) return;
    await guest
      .executeJavaScript('window["__zcodeBrowserRecordingCursorCleanup"]?.()')
      .catch(() => undefined);
  }

  private async animateRecordingScroll(
    view: ControlledView,
    deltaX: number,
    deltaY: number,
    durationMs: number,
    signal: AbortSignal,
  ): Promise<void> {
    const steps = Math.max(1, Math.min(60, Math.round(durationMs / 16)));
    for (let index = 0; index < steps; index += 1) {
      await this.executeRecordingBrowserCommand(view, {
        method: "scroll",
        x: deltaX / steps,
        y: deltaY / steps,
      });
      if (
        durationMs > 0 &&
        index + 1 < steps &&
        !(await waitForDelay(durationMs / steps, signal))
      ) {
        throw abortError();
      }
    }
  }

  private resolveTab(
    context: InternalExecutionContext,
    explicitTabId?: string,
  ): ManagedTab | undefined {
    if (explicitTabId) {
      const explicit = this.tabs.get(explicitTabId);
      if (!explicit || explicit.lifecycle === "closed" || !sameScope(explicit.owner, context)) {
        return undefined;
      }
      return explicit;
    }
    const key = scopeKey(context);
    const activeId = this.activeTabByScope.get(key);
    const active = activeId ? this.tabs.get(activeId) : undefined;
    if (active && active.lifecycle !== "closed" && sameScope(active.owner, context)) return active;
    const defaultId = this.defaultTabByScope.get(key);
    const existingDefault = defaultId ? this.tabs.get(defaultId) : undefined;
    if (
      existingDefault &&
      existingDefault.lifecycle !== "closed" &&
      sameScope(existingDefault.owner, context)
    ) {
      return existingDefault;
    }
    // When the background session (renderer only reports active:false) and the tab is created by explicit newTab, activeTabByScope and
    // defaultTabByScope are all empty. The most recently surviving tab of the scope must be reused here, otherwise the command without tabId will
    // Opening an empty tab out of thin air will also cause the active reported by tabs.list() to be inconsistent with the actual location.
    const recent = this.ownedTabs(context).at(-1);
    if (recent) return recent;
    return this.createTab(context, context.legacy ? context.sessionId : undefined, true);
  }

  private createTab(
    context: InternalExecutionContext,
    preferredTabId?: string,
    makeDefault = false,
  ): ManagedTab {
    const tabId = preferredTabId ?? `iab-tab:${randomUUID()}`;
    const existing = this.tabs.get(tabId);
    if (existing && existing.lifecycle !== "closed" && sameScope(existing.owner, context)) {
      return existing;
    }
    const tab: ManagedTab = {
      tabId,
      owner: { ...context },
      cdpAttached: false,
      guestLifecycle: "detached",
      pendingCdpCommands: 0,
      guestGeneration: 0,
      hasAttachedGuest: false,
      rebindRequested: false,
      lifecycle: "active",
      origin: "agent",
      claimable: false,
      active: false,
      loading: false,
      mediaActive: false,
      cachedUrl: "",
      cachedTitle: "",
      cachedFaviconUrl: null,
      openedAt: this.now(),
      // The model creation path (explicit newTab and implicit creation when there is no tab) uses the desktop free size by default.
      // The viewport belongs to the tab creation fact; claim, activate, and navigate only reuse existing tabs and cannot set the default value again.
      viewportOverride: { ...DEFAULT_AGENT_BROWSER_VIEWPORT },
    };
    this.tabs.set(tabId, tab);
    this.registerTabResidency(tab, false);
    void this.persistShell(tab);
    if (makeDefault) this.defaultTabByScope.set(scopeKey(context), tabId);
    return tab;
  }

  private async ensureGuest(
    tab: ManagedTab,
    signal: AbortSignal,
  ): Promise<GuestWebContents | null> {
    if (signal.aborted) return null;
    const suspendFlight = this.suspendFlights.get(tab.tabId);
    if (suspendFlight) {
      // The protected state can only cancel the coordinator generation and cannot immediately prove that the renderer has not been uninstalled.
      // The Browser command must wait for snapshot/ack/necessary recovery to converge, and cannot reuse old guests that are about to be destroyed.
      const settled = await waitForPromiseWithSignal(suspendFlight, signal);
      if (!settled.completed) return null;
    }
    const residency = this.residencyCoordinator.get(tab.tabId);
    if (residency?.residency === "suspended" || residency?.residency === "restoring") {
      return await this.restoreSuspendedGuest(tab, signal);
    }
    if (tab.guest && !safeBool(() => tab.guest!.isDestroyed(), true)) {
      return await this.waitForGuestRecovery(tab, tab.guest, signal);
    }
    if (tab.guest) {
      this.detachGuest(tab);
    }

    const existingFlight = this.guestAttachFlights.get(tab.tabId);
    let flight = existingFlight;
    if (!flight) {
      flight = this.runGuestAttachFlight(tab);
      this.guestAttachFlights.set(tab.tabId, flight);
      const clearFlight = () => {
        if (this.guestAttachFlights.get(tab.tabId) === flight) {
          this.guestAttachFlights.delete(tab.tabId);
        }
      };
      void flight.then(clearFlight, clearFlight);
    }
    const settled = await waitForPromiseWithSignal(flight, signal);
    if (!settled.completed || !settled.value) return null;
    return await this.waitForGuestRecovery(tab, settled.value, signal);
  }

  private async waitForGuestRecovery(
    tab: ManagedTab,
    guest: GuestWebContents,
    signal: AbortSignal,
  ): Promise<GuestWebContents | null> {
    const flight = this.guestRecoveryFlights.get(tab.tabId);
    if (!flight) return guest;
    const settled = await waitForPromiseWithSignal(flight, signal);
    return settled.completed && settled.value === guest ? guest : null;
  }

  private async runGuestAttachFlight(tab: ManagedTab): Promise<GuestWebContents | null> {
    // The new tab's first ready is still only waited for once; a bounded replay is allowed when there is a guest or a rejection has been explicitly received.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (tab.lifecycle === "closed") return null;
      // create/ready is a replayable state; a bounded replay is initiated after an event is lost or the guest crashes.
      // If destroyed/mismatch has already initiated rebinding, this request will be used to avoid repeatedly creating webviews for the same tab.
      if (!tab.rebindRequested) this.onOpenTabRequested?.(tab.tabId, tab.owner);
      // Some test/legacy renderers synchronously attach within the Ready callback; you cannot register a waiter after attach has succeeded.
      if (tab.guest && !safeBool(() => tab.guest.isDestroyed(), true)) return tab.guest;
      const guest = await this.waitForGuest(tab.tabId);
      if (guest && !safeBool(() => guest.isDestroyed(), true)) return guest;
      if (attempt === 0 && !tab.hasAttachedGuest && !tab.attachFailure) return null;
      if (attempt === 1) return null;
      this.requestGuestRebind(tab, tab.attachFailure ?? "attach-timeout");
    }
    return null;
  }

  private ownedTabs(context: InternalExecutionContext): ManagedTab[] {
    return [...this.tabs.values()].filter(
      (tab) => tab.lifecycle !== "closed" && sameScope(tab.owner, context),
    );
  }

  private canClaimUserTab(tab: ManagedTab, context: InternalExecutionContext): boolean {
    return (
      tab.origin === "user" &&
      tab.claimable &&
      tab.lifecycle !== "closed" &&
      tab.owner.windowId === context.windowId &&
      tab.owner.workspaceKey === context.workspaceKey &&
      (tab.owner.remoteSessionId ?? "") === (context.remoteSessionId ?? "") &&
      tab.owner.sessionId === context.sessionId
    );
  }

  private openUserTabs(context: InternalExecutionContext): ManagedTab[] {
    return [...this.tabs.values()]
      .filter((tab) => this.canClaimUserTab(tab, context) && this.hasDiscoverableUserPage(tab))
      .sort((left, right) => Number(right.active) - Number(left.active));
  }

  private hasDiscoverableUserPage(tab: ManagedTab): boolean {
    const url = tab.guest
      ? safeStr(() => tab.guest!.getURL(), tab.cachedUrl).trim()
      : tab.cachedUrl.trim();
    // A mounted human webview will be ready with about:blank/empty URL before first navigation.
    // This is just a UI placeholder, not a user page for the agent to claim; controlled tabs.list() is not affected by this filtering.
    return url.length > 0 && url !== "about:blank";
  }

  private claimTab(tab: ManagedTab, context: InternalExecutionContext): ManagedTab {
    if (!this.canClaimUserTab(tab, context)) return tab;
    tab.owner = { ...context };
    tab.claimable = false;
    // claim only takes over ownership and does not change the activation status; inactive
    // The human tab webview does not produce frames, and the prepare handshake of the screenshot after being claimed times out 3s (renderer ready
    // never come). claim is activation: the same selectTab(tab, true) semantics as activateTab - front desk
    // The scope expands the corresponding view. The background scope only records the activation state and does not grab the user's current session focus.
    this.selectTab(tab, true);
    this.log?.(
      `[browser-use] claim human tab tabId=${tab.tabId} windowId=${context.windowId} sessionId=${context.sessionId}`,
    );
    return tab;
  }

  private selectTab(tab: ManagedTab, notifyRenderer: boolean): void {
    const key = scopeKey(tab.owner);
    // The same browser scope can only have at most one active tab; the old attach path only sets the new tab as active.
    // The old tab.active is not cleared, causing tabs.list() to return multiple active=true at the same time.
    for (const candidate of this.tabs.values()) {
      if (!sameScope(candidate.owner, tab.owner)) continue;
      candidate.active = candidate.tabId === tab.tabId;
      this.residencyCoordinator.report(candidate.tabId, {
        selected: candidate.tabId === tab.tabId,
      });
    }
    this.activeTabByScope.set(key, tab.tabId);
    if (!notifyRenderer) return;
    this.visibilityByScope.set(key, true);
    this.onVisibilityChanged?.(true, tab.owner, tab.tabId);
    // activateTab / claim both end with selectTab(tab, true); the attach path uses notifyRenderer=false
    // And the recovery has been called by itself and will not be repeated.
    this.maybeRestoreBackgroundViewport(tab);
  }

  private releaseToUser(tab: ManagedTab): void {
    if (tab.claimable) return;
    if (!tab.userOwner) {
      tab.userOwner = {
        ...tab.owner,
        requestId: `unclaimed:${randomUUID()}`,
        // After release, it must be separated from the original controlled browser scope, otherwise tabs.list() of the same session will still
        // The user tab is treated as a controlled tab; sessionId/workspaceKey is reserved for the owner session to explicitly re-claim.
        browserId: "unclaimed-iab",
        browserGeneration: 0,
        turnId: undefined,
      };
    }
    const claimedScope = scopeKey(tab.owner);
    if (this.activeTabByScope.get(claimedScope) === tab.tabId) {
      this.activeTabByScope.delete(claimedScope);
    }
    if (this.defaultTabByScope.get(claimedScope) === tab.tabId) {
      this.defaultTabByScope.delete(claimedScope);
    }
    tab.owner = { ...tab.userOwner };
    tab.origin = "user";
    tab.claimable = true;
    tab.lifecycle = "active";
  }

  private finalizeTabs(
    context: InternalExecutionContext,
    keep: Map<string, "handoff" | "deliverable">,
  ): void {
    // Product semantics: IAB tabs are persistent within the current ZCode process by default. keep is a collection of status markers, not a whitelist cleanup;
    // Missing tabs cannot be closed as temporary pages: the user page will disappear at the turn end if the model is not explicitly closed.
    for (const tab of this.tabs.values()) {
      if (!sameScope(tab.owner, context)) continue;
      const status = keep.get(tab.tabId);
      if (status === "handoff") tab.lifecycle = status;
      else if (status === "deliverable") {
        tab.lifecycle = status;
        this.releaseToUser(tab);
      }
    }
  }

  /**
   * The only determination of active in tabs.list(). The semantics is "which tab will the command without tabId fall on", which is the same as resolveTab
   * Alignment, not "whether the UI is currently visible" - visibility has a separate browserVisibilitySet/Get channel.
   *
   * Must bring back: when the session is running in the background, the isVisible of the renderer is always false and will only be reported.
   * attachGuest({active:false}), no tab in the scope reports active, and activeTabByScope is also empty.
   * The CLI's turn-end automatic screenshot is addressed using tabs.find(t => t.active === true) and there is no fallback, so it is skipped silently.
   * The user side shows that there is no screenshot when the background session ends. Fallback to the most recently alive tab for this scope (with browserVisibilitySet
   * After being consistent with the at(-1) fallback of tabs.selected() on the CLI side), the active reported by the list is again consistent with the command landing point.
   */
  private effectiveActiveTabId(owner: InternalExecutionContext): string | undefined {
    const key = scopeKey(owner);
    const activeId = this.activeTabByScope.get(key);
    const activeTab = activeId ? this.tabs.get(activeId) : undefined;
    if (activeTab && activeTab.lifecycle !== "closed") return activeId;
    // Human tab only sets tab.active before claim and does not enter activeTabByScope; this self-reporting of active takes precedence over fallback.
    // And once hit, it will no longer go down, ensuring that there is only one active=true in the same scope.
    for (const tab of this.tabs.values()) {
      if (tab.active && tab.lifecycle !== "closed" && sameScope(tab.owner, owner)) return tab.tabId;
    }
    return this.ownedTabs(owner).at(-1)?.tabId;
  }

  private async summary(tab: ManagedTab): Promise<BrowserTabSummary> {
    // When the guest rebinding recovery has not been completed, the substitute guest may still report about:blank; each status reading point
    // The logical cache must be retained and the temporary guest URL cannot be allowed to overwrite subsequent restore facts.
    if (tab.guest && !this.guestRecoveryFlights.has(tab.tabId)) {
      tab.cachedUrl = safeStr(() => tab.guest!.getURL(), tab.cachedUrl);
      tab.cachedTitle = safeStr(() => tab.guest!.getTitle(), tab.cachedTitle);
    }
    return {
      tabId: tab.tabId,
      url: tab.cachedUrl,
      title: tab.cachedTitle,
      viewport: await this.readTabViewport(tab),
      ...(this.effectiveActiveTabId(tab.owner) === tab.tabId ? { active: true } : {}),
      ...(tab.lifecycle !== "active" ? { lifecycle: tab.lifecycle } : {}),
    };
  }

  private async readTabViewport(tab: ManagedTab): Promise<BrowserViewportSize> {
    if (tab.viewportOverride) return { ...tab.viewportOverride };
    if (tab.backgroundViewportFallback) {
      // The foreground tab should not stay in the foreground fallback size: readTabViewport's "fallback existence is a short circuit"
      // Will make residuals self-reinforcing (page pegged to background size, window resize/full screen
      // Neither follows). Even if both foreground signals (selectTab/reportResidency) are lost, the foreground tab's
      // The next viewport read must also heal itself; this time the fallback is still returned, and the recovery is completed later in the mutation queue.
      if (tab.active) {
        this.maybeRestoreBackgroundViewport(tab);
      }
      return { ...tab.backgroundViewportFallback };
    }
    if (!tab.guest || safeBool(() => tab.guest!.isDestroyed(), true)) {
      return { ...DEFAULT_BACKGROUND_BROWSER_VIEWPORT };
    }
    const value = await tab.guest.executeJavaScript(
      "({ width: window.innerWidth, height: window.innerHeight })",
    );
    if (isBrowserViewportSize(value)) {
      this.naturalViewportByWindow.set(tab.owner.windowId, { ...value });
      return value;
    }

    // The Browser pane of the background session will retain the guest but hide it via display:none for the first time
    // tabs.new() still dom-ready/attach, but only gets a 0×0 viewport. Hidden is a display state and cannot be blocked
    // Background Browser execution; temporarily reuse the latest natural size of the same window, and then clear CDP override after returning to the foreground.
    const fallback = normalizeBackgroundViewport(
      this.naturalViewportByWindow.get(tab.owner.windowId) ?? DEFAULT_BACKGROUND_BROWSER_VIEWPORT,
    );
    await this.applyBackgroundViewportFallback(tab, fallback);
    this.log?.(
      `[browser-use] applied background viewport fallback tabId=${tab.tabId} width=${fallback.width} height=${fallback.height}`,
    );
    return { ...fallback };
  }

  private userTabInfo(tab: ManagedTab): BrowserUserTabInfo {
    if (tab.guest && !this.guestRecoveryFlights.has(tab.tabId)) {
      tab.cachedUrl = safeStr(() => tab.guest!.getURL(), tab.cachedUrl);
      tab.cachedTitle = safeStr(() => tab.guest!.getTitle(), tab.cachedTitle);
    }
    return {
      id: tab.tabId,
      ...(tab.cachedUrl ? { url: tab.cachedUrl } : {}),
      ...(tab.cachedTitle ? { title: tab.cachedTitle } : {}),
    };
  }

  private withMeta(
    result: BrowserCommandResult,
    context: InternalExecutionContext,
    tab?: ManagedTab,
    lifecycleOverride?: BrowserResponseMeta["lifecycle"],
  ): BrowserCommandResult {
    const openTabs = this.ownedTabs(context);
    const currentUrl = tab
      ? sanitizeBrowserMetaUrl(
          tab.guest ? safeStr(() => tab.guest!.getURL(), tab.cachedUrl) : tab.cachedUrl,
        )
      : undefined;
    const meta: BrowserResponseMeta = {
      browserUse: true,
      backendType: "iab",
      browserId: context.browserId,
      browserGeneration: context.browserGeneration,
      openTabIds: openTabs.map((candidate) => candidate.tabId),
      ...(tab ? { tabId: tab.tabId } : {}),
      ...(currentUrl ? { currentUrl } : {}),
      ...(lifecycleOverride
        ? { lifecycle: lifecycleOverride }
        : tab
          ? { lifecycle: tab.lifecycle }
          : {}),
    };
    return { ...result, meta };
  }

  private cancelledOrUnavailable(
    context: InternalExecutionContext,
    running: RunningRequest,
    startedAt: number,
    tab: ManagedTab,
  ): BrowserCommandResult {
    if (running.controller.signal.aborted) {
      return this.withMeta(
        this.cancelledResult(context, running.dispatched, startedAt),
        context,
        tab,
      );
    }
    return this.withMeta(
      {
        ok: false,
        error: {
          code: "backend_unavailable",
          message: "browser guest not attached (webview not ready)",
        },
        elapsedMs: Date.now() - startedAt,
      },
      context,
      tab,
    );
  }

  private unavailableTabResult(
    context: InternalExecutionContext,
    tabId: string | undefined,
    startedAt: number,
  ): BrowserCommandResult {
    return this.withMeta(
      {
        ok: false,
        error: {
          code: "backend_unavailable",
          message: tabId
            ? `browser tab '${tabId}' is not visible in the current context. ${TAB_CONTEXT_RECOVERY_HINT}`
            : "browser tab is unavailable",
        },
        elapsedMs: Date.now() - startedAt,
      },
      context,
    );
  }

  private cancelledResult(
    _context: InternalExecutionContext,
    dispatched: boolean,
    startedAt: number,
  ): BrowserCommandResult {
    return {
      ok: false,
      error: {
        code: "cancelled",
        message: dispatched
          ? "browser request cancelled after backend dispatch; side effects may have occurred"
          : "browser request cancelled before backend dispatch",
        sideEffect: dispatched ? "uncertain" : "none",
      },
      elapsedMs: Date.now() - startedAt,
    };
  }

  private abortRequest(requestId: string, context: InternalExecutionContext): boolean {
    const request = this.runningRequests.get(requestId);
    // requestId is a correlation id, not an authorization credential; cancellation must also comply with the full IAB scope.
    if (!request || !sameScope(request.context, context)) return false;
    request.controller.abort(new DOMException("aborted", "AbortError"));
    return true;
  }

  endTurn(context: InternalExecutionContext, turnId?: string): void {
    this.abortRecordings(
      (entry) =>
        sameScope(entry.context, context) &&
        (turnId === undefined || entry.context.turnId === turnId),
      "turn ended",
    );
    for (const request of this.runningRequests.values()) {
      if (
        sameScope(request.context, context) &&
        (turnId === undefined || request.context.turnId === turnId)
      ) {
        request.controller.abort(new DOMException("turn ended", "AbortError"));
      }
    }
    // turn end only ends the request, not the tab. The old "keep only the last active page" policy will be used when there is a handoff
    // Automatically close subsequent new tabs so that the page survival depends on the model. Remember to write finalize JS. active/handoff tabs are now left as is;
    // Deliverable and claimed user tabs still release control according to explicit lifecycle conventions, but the view does not close.
    for (const tab of this.tabs.values()) {
      if (!sameScope(tab.owner, context)) continue;
      if (tab.lifecycle === "handoff") continue;
      if (tab.lifecycle === "deliverable" || tab.origin === "user") this.releaseToUser(tab);
    }
    // guest WebContents were destroyed while the CDP was still attached (destroyed directly,
    // The trigger path is not enumerable: React uninstalls webview / system behavior can be reached) will cause DevToolsSession to be implicitly destructed in transit
    // Notify UAF to drop the main process. When the turn ends, the agent no longer operates. At this time, it actively detachs the CDP exposure window from "tab to the entire
    // Lifecycle" is narrowed to "command in turn is in transit"; the next command is sentGuestCdpCommand lazy re-attach.
    for (const tab of this.tabs.values()) {
      if (!sameScope(tab.owner, context)) continue;
      this.releaseGuestCdpAfterIdle(tab, "turn ended");
    }
  }

  private releaseGuestCdpAfterIdle(tab: ManagedTab, reason: string): void {
    const guest = tab.guest;
    if (!guest || tab.guestLifecycle !== "attached") return;
    void (async () => {
      // Disconnect after the CDP command in transit (playwright cdp.send / viewport override / dialog processing) is completed.
      // Avoid tearing down in-use pipelines midway; timeouts share the same budget as runGuestTeardown.
      const settled = await this.waitForGuestCdpIdle(tab, DEFAULT_GUEST_CDP_TEARDOWN_TIMEOUT_MS);
      if (!settled) {
        this.warn(
          `browser guest cdp release pending timeout tabId=${tab.tabId} ` +
            `pending=${tab.pendingCdpCommands} reason=${reason}`,
        );
      }
      // During the waiting period, the tab may have been replaced/closed/entered the command period again, and this round of release will be given up at this time.
      if (this.tabs.get(tab.tabId) !== tab || tab.guest !== guest) return;
      if (tab.guestLifecycle !== "attached") return;
      if (tab.pendingCdpCommands > 0) return;
      if (safeBool(() => guest.isDestroyed(), true)) return;
      try {
        if (!guest.debugger.isAttached()) {
          tab.cdpAttached = false;
          return;
        }
        guest.debugger.detach();
        tab.cdpAttached = false;
        this.log?.(`[browser-use] cdp released after ${reason} tabId=${tab.tabId}`);
      } catch (error) {
        this.warn(`browser guest cdp release failed tabId=${tab.tabId} reason=${reason}`, error);
      }
    })();
  }

  /**
   * Command-level idle release: The timer is reset after each CDP command is completed. If cdpIdleReleaseMs is exceeded and there is no new command, it will be active.
   * detach. The guest renderer was killed by Chromium and render-process-gone was missing (a known gap in Electron,
   * According to the actual measurement, the crash window of the destroyed direct + CDP attached → main process UAF) is concentrated in the command gap within the turn.
   * The turnEnded level release is not covered; the interval of dense command flow is much smaller than the threshold and will not be accidentally interrupted.
   */
  private scheduleGuestCdpIdleRelease(tab: ManagedTab): void {
    if (tab.guestCdpIdleTimer) clearTimeout(tab.guestCdpIdleTimer);
    tab.guestCdpIdleTimer = setTimeout(() => {
      tab.guestCdpIdleTimer = undefined;
      this.releaseGuestCdpAfterIdle(tab, "cdp idle");
    }, this.cdpIdleReleaseMs);
  }

  private clearGuestCdpIdleRelease(tab: ManagedTab): void {
    if (tab.guestCdpIdleTimer) {
      clearTimeout(tab.guestCdpIdleTimer);
      tab.guestCdpIdleTimer = undefined;
    }
  }

  closeSession(context: InternalExecutionContext): void {
    this.abortRecordings((entry) => sameScope(entry.context, context), "session closed");
    for (const request of this.runningRequests.values()) {
      if (sameScope(request.context, context)) {
        request.controller.abort(new DOMException("session closed", "AbortError"));
      }
    }
    for (const tab of this.tabs.values()) {
      if (!sameScope(tab.owner, context)) continue;
      // Session is the control boundary, not the life boundary of visible tabs. The view remains retained but remains bound after release
      // The original session; can no longer be written as global unclaimed, otherwise other conversations will see and take over through user.openTabs().
      this.releaseToUser(tab);
      // Same as endTurn: CDP is released at the end of the session and eliminates the main process UAF window on any subsequent destruction path of the guest.
      this.releaseGuestCdpAfterIdle(tab, "session closed");
    }
    this.activeTabByScope.delete(scopeKey(context));
    this.defaultTabByScope.delete(scopeKey(context));
    this.sessionNames.delete(scopeKey(context));
    this.visibilityByScope.delete(scopeKey(context));
  }

  closeWindow(windowId: number): void {
    this.abortRecordings((entry) => entry.context.windowId === windowId, "window closed");
    for (const request of this.runningRequests.values()) {
      if (request.context.windowId === windowId) {
        request.controller.abort(new DOMException("window closed", "AbortError"));
      }
    }
    for (const tab of this.tabs.values()) {
      if (tab.owner.windowId !== windowId) continue;
      this.detachAndCloseGuest(tab);
      this.residencyCoordinator.remove(tab.tabId);
      this.restoredTabClaims.delete(tab.tabId);
      // closeWindow takes the fast path without going through closeTab; if the per-tab screenshot status is not cleared here,
      // Late settle callbacks pollute the count of new tabs by tabId that may be reused by the recovery process. decrement pair
      // Deleted keys are no-op, provided the entries are deleted here first.
      this.inFlightScreenshots.delete(tab.tabId);
      this.abandonedScreenshotCaptures.delete(tab.tabId);
      this.tabs.delete(tab.tabId);
    }
    this.naturalViewportByWindow.delete(windowId);
  }

  private async removeTabRecovery(tab: ManagedTab): Promise<void> {
    await this.residencyOptions.recoveryStore?.remove(tab.tabId);
  }

  private async closeTabDurably(tab: ManagedTab, notifyRenderer = true): Promise<void> {
    if (tab.lifecycle === "closed") return;
    // The old close first returns the command/notification to the renderer, then fire-and-forget deletes the recovery warehouse; then exits
    // Closed tabs are resurrected from the old shell. Complete the persistent deletion first, and if it fails, keep the current logical tab for the caller to try again.
    await this.removeTabRecovery(tab);
    this.closeTab(tab, notifyRenderer);
  }

  private closeTab(tab: ManagedTab, notifyRenderer = true): void {
    if (tab.lifecycle === "closed") return;
    this.abortRecordings((entry) => entry.tabId === tab.tabId, "tab closed");
    tab.lifecycle = "closed";
    this.closedTabIds.add(tab.tabId);
    // The tab command is no longer executable; there is no need to keep a manager reference to an old CDP capture that may never return packets.
    this.inFlightScreenshots.delete(tab.tabId);
    this.abandonedScreenshotCaptures.delete(tab.tabId);
    this.resolveWaiters(tab.tabId, null);
    this.detachAndCloseGuest(tab);
    for (const [downloadId, record] of this.downloads) {
      if (record.tabId === tab.tabId) this.downloads.delete(downloadId);
    }
    this.queuedDownloads.delete(tab.tabId);
    let waiter = this.downloadWaiters.get(tab.tabId)?.[0];
    while (waiter) {
      this.finishDownloadWaiter(tab.tabId, waiter, null);
      waiter = this.downloadWaiters.get(tab.tabId)?.[0];
    }
    const key = scopeKey(tab.owner);
    if (this.activeTabByScope.get(key) === tab.tabId) this.activeTabByScope.delete(key);
    if (this.defaultTabByScope.get(key) === tab.tabId) this.defaultTabByScope.delete(key);
    if (notifyRenderer) this.onCloseTabRequested?.(tab.tabId, tab.owner);
    this.residencyCoordinator.remove(tab.tabId);
    this.restoredTabClaims.delete(tab.tabId);
    this.tabs.delete(tab.tabId);
  }

  /**
   * Disconnect CDP immediately when guest renderer crashes/is killed.
   *
   * Crash chain (main process UAF, minidump falls on DevToolsSession::DispatchProtocolNotification,
   * vptr of client_ is 0):
   *   Chromium kills guest renderer under memory pressure
   *     → render-process-gone: WebContents are still alive and CDP is still attached
   *     → The renderer side increments webviewGeneration, React uninstalls the old <webview>
   *     → The old WebContents are destroyed only now, api::Debugger performs implicit destruction
   *     → DevToolsSession still holds client_ and dispatches notifications in progress → UAF → The main process crashes → The entire app exits
   *
   * Actual measurement (Electron 41.0.3 / forcefullyCrashRenderer, controlled experiment with millisecond timestamp):
   *   - when render-process-gone isDestroyed()=false, isCrashed()=true, isAttached()=true,
   *     detach() succeeds and then isAttached()=false;
   *   - When destroyed, isCrashed()/isAttached() all throws "Object has been destroyed",
   *     It is no longer possible to detach there - so destroyed cannot repair this UAF;
   *   - If <webview> is not uninstalled after the crash, WebContents will stay in the crashed state indefinitely (10s destroyed has not yet arrived);
   *     Once the renderer unloads the <webview>, destroyed arrives in ~5ms. That is, the destruction timing is determined by renderer.
   *     The safe window for native detach only exists before WebContents are destroyed.
   * main's render-process-gone is the first guard; renderer's explicit detach ACK before rebuilding is the second barrier.
   * Used to cover the scene that the main event has not reached. Both do not change the destruction timing, but only ensure that the CDP has been disconnected at the time of destruction.
   */
  private setupCdpCrashGuard(tab: ManagedTab, guest: GuestWebContents): void {
    tab.crashGuardCleanup?.();
    if (!guest.on || !guest.removeListener) return;
    const tabId = tab.tabId;
    const onRenderProcessGone = (...args: unknown[]): void => {
      const reason = safeStr(
        () => String((args[1] as { reason?: string } | undefined)?.reason ?? "unknown"),
        "unknown",
      );
      const guestId = safeStr(() => String(guest.id), "?");
      // Not checking tab.guest === guest: Disconnecting the CDP of a replaced guest is also correct and necessary.
      // And missing it is equivalent to leaving the UAF window open.
      try {
        if (this.tabs.get(tabId)?.guest === guest) tab.guestLifecycle = "detaching";
        if (!guest.debugger.isAttached()) return;
        guest.debugger.detach();
        this.log?.(
          `[browser-use] cdp detached on render-process-gone tabId=${tabId} ` +
            `guestId=${guestId} reason=${reason}`,
        );
      } catch (error) {
        // Failure here means that the UAF window failed to close and must leave a trace to correlate with subsequent crashes.
        this.warn(
          `browser guest cdp detach on render-process-gone failed tabId=${tabId} ` +
            `guestId=${guestId} reason=${reason}`,
          error,
        );
      } finally {
        if (this.tabs.get(tabId)?.guest === guest) tab.cdpAttached = false;
      }
    };
    guest.on("render-process-gone", onRenderProcessGone);
    tab.crashGuardCleanup = () => {
      guest.removeListener?.("render-process-gone", onRenderProcessGone);
    };
  }

  private setupDialogTracking(tab: ManagedTab, guest: GuestWebContents): void {
    const tabId = tab.tabId;
    void this.sendGuestCdpCommand(tab, guest, "Page.enable").catch((error: unknown) => {
      this.log?.(`[browser-use] Page.enable failed tabId=${tabId}: ${String(error)}`);
    });
    const onMessage = (_event: unknown, method: string, params: unknown): void => {
      const current = this.tabs.get(tabId);
      if (!current || current.guest !== guest || current.lifecycle === "closed") return;
      if (method === "Page.javascriptDialogOpening") {
        // Management: The time when the dialog event reaches main is used to distinguish "event black hole" from "dialog has been detachd"
        // Clean up" two causes of getDialog=null.
        this.log?.(`[browser-use] dialog opening event received tabId=${tabId}`);
        const data = (params ?? {}) as {
          type?: string;
          message?: string;
          defaultPrompt?: string;
        };
        const dialog: BrowserDialog = {
          type: normalizeDialogType(data.type),
          message: typeof data.message === "string" ? data.message : "",
          ...(typeof data.defaultPrompt === "string" ? { defaultPrompt: data.defaultPrompt } : {}),
        };
        this.pendingDialogs.set(tabId, dialog);
      } else if (method === "Page.javascriptDialogClosed") {
        this.pendingDialogs.delete(tabId);
      }
    };
    guest.debugger.on("message", onMessage);
    tab.cdpMessageCleanup = () => {
      guest.debugger.removeListener("message", onMessage);
    };
  }

  private applyViewportOverride(tab: ManagedTab): void {
    const viewport = tab.viewportOverride;
    if (!viewport) return;
    void this.setTabViewport(tab, viewport).catch((error: unknown) => {
      this.log?.(`[browser-use] viewport apply failed tabId=${tab.tabId}: ${String(error)}`);
    });
  }

  private async setTabViewport(tab: ManagedTab, viewport: BrowserViewportSize): Promise<void> {
    assertViewportOverride(viewport);
    if (tab.lifecycle === "closed") return;
    tab.backgroundViewportFallback = undefined;
    tab.viewportOverride = { ...viewport };
    if (!tab.guest) return;
    const guest = tab.guest;
    await this.enqueueViewportMutation(tab, async () => {
      if (tab.guest !== guest || tab.lifecycle === "closed") return;
      await this.sendGuestCdpCommand(
        tab,
        guest,
        "Emulation.setDeviceMetricsOverride",
        buildViewportMetricsOverride(viewport, tab.desktopZoomFactor),
      );
    });
  }

  private async resetTabViewport(tab: ManagedTab): Promise<void> {
    if (tab.lifecycle === "closed") return;
    tab.viewportOverride = undefined;
    tab.desktopZoomFactor = undefined;
    tab.backgroundViewportFallback = undefined;
    if (!tab.guest) return;
    const guest = tab.guest;
    await this.enqueueViewportMutation(tab, async () => {
      if (tab.guest !== guest || tab.lifecycle === "closed") return;
      await this.sendGuestCdpCommand(tab, guest, "Emulation.clearDeviceMetricsOverride");
    });
  }

  private async applyBackgroundViewportFallback(
    tab: ManagedTab,
    viewport: BrowserViewportSize,
  ): Promise<void> {
    const guest = tab.guest;
    if (!guest || tab.lifecycle === "closed") {
      throw new Error(`browser tab '${tab.tabId}' has no readable viewport`);
    }
    const fallback = { ...viewport };
    tab.backgroundViewportFallback = fallback;
    try {
      await this.enqueueViewportMutation(tab, async () => {
        if (
          tab.guest !== guest ||
          tab.lifecycle === "closed" ||
          tab.backgroundViewportFallback !== fallback ||
          tab.viewportOverride
        ) {
          return;
        }
        await this.sendGuestCdpCommand(
          tab,
          guest,
          "Emulation.setDeviceMetricsOverride",
          buildViewportMetricsOverride(fallback, guest.hostWebContents?.getZoomFactor()),
        );
      });
    } catch (error) {
      if (tab.backgroundViewportFallback === fallback) {
        tab.backgroundViewportFallback = undefined;
      }
      throw error;
    }
  }

  /**
   * Unified closing of the foreground activation path: the background fallback viewport cannot remain after the tab returns to the foreground.
   * Clearing only when attachGuest({active:true}) is not enough: foreground switching while guest is alive
   * (activateTab / claim / renderer residency reporting) will not reattach, and the page will be permanently nailed to
   * Backstage dimensions. restoreNaturalViewportAfterBackground comes with idempotent guards and serial mutation queues.
   * It is safe to fire multiple foreground signals repeatedly.
   */
  private maybeRestoreBackgroundViewport(tab: ManagedTab): void {
    if (tab.lifecycle === "closed" || !tab.backgroundViewportFallback) return;
    this.restoreNaturalViewportAfterBackground(tab);
  }

  private restoreNaturalViewportAfterBackground(tab: ManagedTab): void {
    const fallback = tab.backgroundViewportFallback;
    const guest = tab.guest;
    if (!fallback || tab.viewportOverride || !guest) return;
    void this.enqueueViewportMutation(tab, async () => {
      if (
        tab.guest !== guest ||
        tab.lifecycle === "closed" ||
        tab.backgroundViewportFallback !== fallback ||
        tab.viewportOverride
      ) {
        return;
      }
      await this.sendGuestCdpCommand(tab, guest, "Emulation.clearDeviceMetricsOverride");
      if (tab.backgroundViewportFallback !== fallback || tab.viewportOverride) return;
      const value = await guest.executeJavaScript(
        "({ width: window.innerWidth, height: window.innerHeight })",
      );
      if (tab.backgroundViewportFallback !== fallback || tab.viewportOverride) return;
      if (isBrowserViewportSize(value)) {
        this.naturalViewportByWindow.set(tab.owner.windowId, { ...value });
        tab.backgroundViewportFallback = undefined;
        return;
      }
      // When active=true is reached but Chromium has not yet completed visible layout, remain transient; next time
      // Renderer visible attach or viewport reading can still be resumed and cannot return to 0×0 temporarily.
      await this.sendGuestCdpCommand(
        tab,
        guest,
        "Emulation.setDeviceMetricsOverride",
        buildViewportMetricsOverride(fallback, guest.hostWebContents?.getZoomFactor()),
      );
    }).catch((error: unknown) => {
      this.log?.(
        `[browser-use] background viewport restore failed tabId=${tab.tabId}: ${String(error)}`,
      );
    });
  }

  private enqueueViewportMutation(tab: ManagedTab, mutation: () => Promise<void>): Promise<void> {
    const previous = tab.viewportMutation ?? Promise.resolve();
    const current = previous
      .catch(() => undefined)
      .then(async () => {
        // Based on this, CDP recovery directly replays in the current critical section to avoid waiting for itself after entering the queue twice.
        tab.insideViewportMutation = true;
        try {
          await mutation();
        } finally {
          tab.insideViewportMutation = false;
        }
      });
    tab.viewportMutation = current;
    current.then(
      () => {
        if (tab.viewportMutation === current) tab.viewportMutation = undefined;
      },
      () => {
        if (tab.viewportMutation === current) tab.viewportMutation = undefined;
      },
    );
    return current;
  }

  private setupDownloadTracking(tab: ManagedTab, guest: GuestWebContents): void {
    tab.downloadCleanup?.();
    if (!guest.session) return;
    const listener = (_event: unknown, item: GuestDownloadItem, contents: GuestWebContents) => {
      if (contents !== guest || tab.guest !== guest || tab.lifecycle === "closed") return;
      const downloadId = `iab-download:${randomUUID()}`;
      const record: DownloadRecord = {
        tabId: tab.tabId,
        path: safeStr(() => item.getSavePath(), "") || null,
        state: "pending",
      };
      this.downloads.set(downloadId, record);
      this.refreshRuntimeProtection(tab.tabId);
      item.once("done", (_event, state) => {
        record.path = safeStr(() => item.getSavePath(), "") || record.path;
        record.state =
          state === "completed" ? "completed" : state === "cancelled" ? "cancelled" : "interrupted";
        this.refreshRuntimeProtection(tab.tabId);
      });
      const waiters = this.downloadWaiters.get(tab.tabId);
      const waiter = waiters?.shift();
      if (waiter) {
        this.finishDownloadWaiter(tab.tabId, waiter, downloadId);
      } else {
        const queued = this.queuedDownloads.get(tab.tabId) ?? [];
        queued.push(downloadId);
        this.queuedDownloads.set(tab.tabId, queued);
      }
    };
    guest.session.on("will-download", listener);
    tab.downloadCleanup = () => guest.session?.removeListener("will-download", listener);
  }

  private waitForDownload(
    tabId: string,
    timeoutMs: number,
    signal: AbortSignal,
  ): Promise<string | null> {
    const queued = this.queuedDownloads.get(tabId);
    const existing = queued?.shift();
    if (existing) return Promise.resolve(existing);
    if (signal.aborted) return Promise.resolve(null);
    return new Promise((resolve) => {
      const waiter = {} as DownloadWaiter;
      waiter.resolve = resolve;
      waiter.signal = signal;
      waiter.timer = setTimeout(() => this.finishDownloadWaiter(tabId, waiter, null), timeoutMs);
      waiter.onAbort = () => this.finishDownloadWaiter(tabId, waiter, null);
      signal.addEventListener("abort", waiter.onAbort, { once: true });
      const waiters = this.downloadWaiters.get(tabId) ?? [];
      waiters.push(waiter);
      this.downloadWaiters.set(tabId, waiters);
    });
  }

  private finishDownloadWaiter(
    tabId: string,
    waiter: DownloadWaiter,
    downloadId: string | null,
  ): void {
    clearTimeout(waiter.timer);
    waiter.signal.removeEventListener("abort", waiter.onAbort);
    const waiters = this.downloadWaiters.get(tabId);
    if (waiters) {
      const index = waiters.indexOf(waiter);
      if (index >= 0) waiters.splice(index, 1);
      if (waiters.length === 0) this.downloadWaiters.delete(tabId);
    }
    waiter.resolve(downloadId);
  }

  /**
   * CDP session state recovery attach: idle/turn is called when entering the command period again after the release.
   * Return the waitable flight - Page.enable and viewport override. Business commands are not allowed to be dispatched until the replay is completed.
   *
   * Page field enable and Emulation.setDeviceMetricsOverride are both per-session.
   * It has been cleared by Chromium when detach;
   * Naked attach("1.3") results in a clean session—dialog event black hole (getDialog constant null, evaluate
   * When encountering JS dialog, the timeout is 62s (measured in real time), and the viewport simulation and manager cache are bifurcated. and fire-and-forget
   * There is no waiting barrier for replay: business commands (screenshot/evaluate) may be executed before recovery is completed, replaying the first command scenario
   * Invalid. The recovery command is sent via raw (do not use ensure to avoid self-waiting); the viewport replays the existing serial queue.
   * Direct replay when recovery is triggered in the queue to avoid deadlock between the second queue entry and the current flight waiting for each other.
   */
  private async ensureGuestCdpAttached(tab: ManagedTab, guest: GuestWebContents): Promise<void> {
    if (!tab.guestCdpRestoreFlight) {
      const flight = this.runGuestCdpSessionRestore(tab, guest).finally(() => {
        if (tab.guestCdpRestoreFlight === flight) tab.guestCdpRestoreFlight = undefined;
      });
      tab.guestCdpRestoreFlight = flight;
    }
    await tab.guestCdpRestoreFlight;
  }

  private async runGuestCdpSessionRestore(tab: ManagedTab, guest: GuestWebContents): Promise<void> {
    if (!safeBool(() => guest.debugger.isAttached(), false)) {
      guest.debugger.attach("1.3");
      tab.cdpAttached = safeBool(() => guest.debugger.isAttached(), false);
      if (!tab.cdpAttached) {
        throw new Error(`browser guest cdp restore attach failed tabId=${tab.tabId}`);
      }
    }
    // Recovery failure must be thrown up: the barrier contract is "Page.enable and viewport status are ready.
    // Allow business command dispatch". Swallowing the exception will cause subsequent commands to see attached and skip recovery - Page.enable
    // Loss extends the dialog event black hole to the entire attach period, and the "replayed" log misleads troubleshooting. Throw exception
    // Rollback to detached first: the session is unavailable in the middle, and will not be rebuilt until the next command after restoring the released state.
    // Restore flight (otherwise attached=true will cause lazy attach to skip restoration, and the failure will be permanently fixed).
    try {
      await this.sendGuestCdpCommandRaw(tab, guest, "Page.enable");
    } catch (error) {
      this.warn(`browser guest Page.enable replay failed tabId=${tab.tabId}`, error);
      this.rollbackGuestCdpRestore(tab, guest);
      throw error;
    }
    const viewport = tab.viewportOverride ?? tab.backgroundViewportFallback;
    if (viewport) {
      try {
        const replayViewport = async () => {
          if (tab.guest !== guest || tab.lifecycle === "closed") return;
          await this.sendGuestCdpCommandRaw(
            tab,
            guest,
            "Emulation.setDeviceMetricsOverride",
            buildViewportMetricsOverride(
              viewport,
              tab.viewportOverride ? tab.desktopZoomFactor : guest.hostWebContents?.getZoomFactor(),
            ),
          );
        };
        // Screenshots also occupy the viewport queue, but do not reset metrics. If you re-attach the queue
        // It will always be skipped as equivalent recovery, and the first image will read the host's natural size after scaling.
        // Replay directly when already in the critical section; joining the queue again and waiting will cause a deadlock.
        if (tab.insideViewportMutation) await replayViewport();
        else await this.enqueueViewportMutation(tab, replayViewport);
      } catch (error) {
        this.warn(`browser guest viewport replay failed tabId=${tab.tabId}`, error);
        this.rollbackGuestCdpRestore(tab, guest);
        throw error;
      }
    }
    this.log?.(`[browser-use] cdp session state replayed tabId=${tab.tabId} pageEnable=1`);
  }

  /** When recovery fails, restore the session in the middle to the released state; the failure of rollback itself must not cover up the original error. */
  private rollbackGuestCdpRestore(tab: ManagedTab, guest: GuestWebContents): void {
    try {
      if (guest.debugger.isAttached()) guest.debugger.detach();
    } catch {
      // The session may have been destroyed; the cdpAttached reset still needs to be completed.
    }
    tab.cdpAttached = false;
  }

  /** Dedicated sending of recovery commands: only pending counting and issuance, ensure is not triggered (avoiding self-waiting deadlock). */
  private async sendGuestCdpCommandRaw(
    tab: ManagedTab,
    guest: GuestWebContents,
    method: string,
    params?: unknown,
    sessionId?: string,
  ): Promise<unknown> {
    tab.pendingCdpCommands += 1;
    try {
      const result = await guest.debugger.sendCommand(method, params, sessionId);
      if (!sessionId && tab.guest === guest) {
        if (method === "Emulation.setDeviceMetricsOverride") {
          tab.appliedViewportScale = normalizeDesktopZoomMetricsScale(
            (params as { scale?: number }).scale,
          );
          // The renderer's normalization callback may be overridden by Electron's subsequent page zoom propagation.
          // Fixed viewport setting and CDP reconnection both having to resume guest zoom on the same execution boundary.
          if (guest.getZoomFactor() !== 1) guest.setZoomFactor(1);
        } else if (method === "Emulation.clearDeviceMetricsOverride") {
          tab.appliedViewportScale = undefined;
        }
      }
      return result;
    } finally {
      tab.pendingCdpCommands = Math.max(0, tab.pendingCdpCommands - 1);
      this.scheduleGuestCdpIdleRelease(tab);
    }
  }

  private async sendGuestCdpCommand(
    tab: ManagedTab,
    guest: GuestWebContents,
    method: string,
    params?: unknown,
    sessionId?: string,
    assertCurrentGuest?: () => void,
  ): Promise<unknown> {
    assertCurrentGuest?.();
    if (tab.guest !== guest || tab.guestLifecycle !== "attached") {
      throw new Error("browser guest is detaching");
    }
    // CDP has been actively released after the turnEnded/closeSession/command is idle (anti-guest
    // Main process UAF at the time of destruction), the command path is here to re-attach and await session replay completion (explicit
    // Serial barrier: Page.enable / viewport override is processed by Chromium before this command).
    if (!safeBool(() => guest.debugger.isAttached(), false) || tab.guestCdpRestoreFlight) {
      await this.ensureGuestCdpAttached(tab, guest);
    }
    // Native raster's metrics scale also affects CDP mouse input. Tools, locator
    // And screenshots are still expressed in CSS px, and the boundary compensation position and scroll wheel distance are sent to the only guest to avoid repeated conversions by each API.
    const scale = tab.appliedViewportScale ?? 1;
    if (!sessionId && method === "Input.dispatchMouseEvent" && scale !== 1 && params) {
      const event = { ...(params as Record<string, unknown>) };
      for (const key of ["x", "y", "deltaX", "deltaY"]) {
        if (typeof event[key] === "number") event[key] *= scale;
      }
      params = event;
    }
    return this.sendGuestCdpCommandRaw(tab, guest, method, params, sessionId);
  }

  private toControlledView(
    guest: GuestWebContents,
    normalizeScreenshotToCssPixels = false,
    captureViewportScreenshot: ControlledView["captureViewportScreenshot"] | undefined,
    assertCurrentGuest: () => void,
    sendCdpCommand: ControlledView["cdp"]["send"],
  ): ControlledView {
    const assertCurrent = () => assertCurrentGuest();
    return {
      webContents: {
        loadURL: (url) => {
          assertCurrent();
          return guest.loadURL(url);
        },
        getURL: () => {
          assertCurrent();
          return guest.getURL();
        },
        getTitle: () => {
          assertCurrent();
          return guest.getTitle();
        },
        canGoBack: () => {
          assertCurrent();
          return guest.navigationHistory.canGoBack();
        },
        canGoForward: () => {
          assertCurrent();
          return guest.navigationHistory.canGoForward();
        },
        goBack: () => {
          assertCurrent();
          return guest.navigationHistory.goBack();
        },
        goForward: () => {
          assertCurrent();
          return guest.navigationHistory.goForward();
        },
        reload: () => {
          assertCurrent();
          return guest.reload();
        },
        executeJavaScript: (script) => {
          assertCurrent();
          return guest.executeJavaScript(script, true);
        },
      },
      cdp: {
        send: (method, params, sessionId) => {
          try {
            assertCurrent();
            return sendCdpCommand(method, params, sessionId);
          } catch (error) {
            // CDP consumer will call .catch directly on the abort/terminate path; lifecycle guard must
            // Returns a rejected Promise and cannot throw synchronously to destroy the cleanup link.
            return Promise.reject(error);
          }
        },
      },
      captureViewportScreenshot,
      normalizeScreenshotToCssPixels,
      resizeScreenshotToCssPixels: this.resizeScreenshotToCssPixels,
    };
  }

  private registerTabResidency(
    tab: ManagedTab,
    visible: boolean,
    residency: BrowserTabResidencyRecord["residency"] = visible
      ? "live-visible"
      : "live-background",
    lastSelectedAt: number | null = null,
  ): void {
    this.residencyCoordinator.upsert({
      tabId: tab.tabId,
      windowId: tab.owner.windowId,
      sessionId: tab.owner.sessionId,
      residency,
      guestAttached: Boolean(tab.guest && !safeBool(() => tab.guest!.isDestroyed(), true)),
      openedAt: tab.openedAt,
      lastActivityAt: tab.openedAt,
      lastSelectedAt,
      preferred: visible,
      currentTask: false,
      selected: visible,
      visible,
      operationActive: false,
      captureActive: false,
      audible: false,
      mediaActive: false,
      loading: false,
      downloadActive: false,
    });
  }

  private async closeTabForLimit(record: BrowserTabResidencyRecord): Promise<boolean> {
    const tab = this.tabs.get(record.tabId);
    if (!tab || tab.lifecycle === "closed") return true;
    try {
      // The old quantity gate only destroys WebContents and leaves suspended logical tabs,
      // So the tab bar goes above 32. Durable close must be reused, press "Restore data → guest → renderer tab shell"
      // The order is completely closed to prevent the closed tab from being resurrected in the current UI or the next startup.
      await this.closeTabDurably(tab);
      this.log?.(
        `[browser-use] closed tabId=${tab.tabId} reason=tab-limit windowId=${tab.owner.windowId}`,
      );
      return true;
    } catch (error) {
      this.warn(`browser tab limit close failed tabId=${tab.tabId}`, error);
      return false;
    }
  }

  private async restoreSuspendedGuest(
    tab: ManagedTab,
    signal: AbortSignal,
  ): Promise<GuestWebContents | null> {
    if (signal.aborted) return null;
    let flight = this.restoreFlights.get(tab.tabId);
    if (!flight) {
      // The old single-flight directly uses the AbortSignal of the first caller; the cancellation of the first command
      // Poison all concurrent callers and leave the coordinator in restoring. flight is owned by the tab lifecycle instead.
      flight = this.runRestoreSuspendedGuest(tab, new AbortController().signal).finally(() => {
        if (this.restoreFlights.get(tab.tabId) === flight) this.restoreFlights.delete(tab.tabId);
      });
      this.restoreFlights.set(tab.tabId, flight);
    }
    const result = await waitForPromiseWithSignal(flight, signal);
    return result.completed ? result.value : null;
  }

  private async runRestoreSuspendedGuest(
    tab: ManagedTab,
    signal: AbortSignal,
  ): Promise<GuestWebContents | null> {
    const before = this.residencyCoordinator.get(tab.tabId);
    const transition = this.residencyCoordinator.markRestoring(tab.tabId);
    if (!transition) return null;
    if (before?.residency === "suspended") {
      const payload: BrowserViewResidencyTransitionPayload = {
        tabId: tab.tabId,
        workspaceKey: tab.owner.workspaceKey,
        remoteSessionId: tab.owner.remoteSessionId,
        sessionId: tab.owner.sessionId,
        browserId: tab.owner.browserId,
        browserGeneration: tab.owner.browserGeneration,
        generation: transition.generation,
        residency: "restoring",
      };
      if (this.residencyOptions.onRestoreTabRequested) {
        this.residencyOptions.onRestoreTabRequested(payload);
      } else {
        this.onOpenTabRequested?.(tab.tabId, tab.owner);
      }
    }

    const guest = await this.waitForGuest(tab.tabId, signal);
    if (!guest) {
      const failed = this.residencyCoordinator.failRestore(tab.tabId, transition.generation);
      if (failed) {
        // Notify the renderer to return to the lightweight shell; the new generation also makes this round late attach fail closed.
        this.residencyOptions.onSuspendTabRequested?.({
          tabId: tab.tabId,
          workspaceKey: tab.owner.workspaceKey,
          remoteSessionId: tab.owner.remoteSessionId,
          sessionId: tab.owner.sessionId,
          browserId: tab.owner.browserId,
          browserGeneration: tab.owner.browserGeneration,
          generation: failed.generation,
          residency: "suspended",
        });
      }
      return null;
    }
    const restored = await this.restoreGuestState(tab, guest);
    if (!restored && tab.restoredFromStore && !tab.cachedUrl) {
      // Only when all three types of recovery facts after forced restore mount are missing, the orphans will be cleared; ordinary page-state will be eliminated.
      // The restoreUrl will still be retained and this branch must not be entered to form a restore/close loop.
      await this.removeTabRecovery(tab);
      this.residencyOptions.onRecoveryOrphanCloseRequested?.({
        tabId: tab.tabId,
        reason: "recovery-orphan",
      });
      this.closeTab(tab, false);
      return null;
    }
    if (!restored) {
      // You cannot just deal with "recovery of all missing facts": if you still submit live when both history and URL fail,
      // bootstrap/about:blank is therefore permanently treated as a success page. Failure must destroy the current guest and return to a retryable shell.
      const failed = this.residencyCoordinator.failRestore(tab.tabId, transition.generation);
      this.detachAndCloseGuest(tab);
      if (failed) {
        this.residencyOptions.onSuspendTabRequested?.({
          tabId: tab.tabId,
          workspaceKey: tab.owner.workspaceKey,
          remoteSessionId: tab.owner.remoteSessionId,
          sessionId: tab.owner.sessionId,
          browserId: tab.owner.browserId,
          browserGeneration: tab.owner.browserGeneration,
          generation: failed.generation,
          residency: "suspended",
        });
      }
      return null;
    }
    if (!this.residencyCoordinator.completeRestore(tab.tabId, transition.generation)) return null;
    const completed = this.residencyCoordinator.get(tab.tabId);
    if (completed) {
      // The renderer originally only received the starting point of restoration. There was no final state after success, and the restoring shell was retained permanently.
      this.residencyOptions.onResidencyChanged?.({
        tabId: tab.tabId,
        workspaceKey: tab.owner.workspaceKey,
        remoteSessionId: tab.owner.remoteSessionId,
        sessionId: tab.owner.sessionId,
        browserId: tab.owner.browserId,
        browserGeneration: tab.owner.browserGeneration,
        generation: completed.generation,
        residency: completed.residency === "live-visible" ? "live-visible" : "live-background",
      });
    }
    tab.restoredFromStore = false;
    await this.persistShell(tab);
    return guest;
  }

  private async restoreGuestState(tab: ManagedTab, guest: GuestWebContents): Promise<boolean> {
    const pageState = await this.residencyOptions.recoveryStore?.getPageState(tab.tabId);
    if (pageState && pageState.entries.length > 0) {
      const activePageState = pageState.entries[pageState.activeIndex];
      if (tab.cachedUrl && activePageState?.url !== tab.cachedUrl) {
        // pageState is only refreshed when the budget is suspended; navigation updates the shell when resumed, leaving the old snapshot behind.
        // The cold start must be based on the current URL of the logical shell, and B cannot be rolled back to A in the snapshot.
        this.warn(
          `browser tab stale page-state ignored tabId=${tab.tabId} shellUrl=${tab.cachedUrl} pageStateUrl=${activePageState?.url ?? "missing"}`,
        );
        await this.residencyOptions.recoveryStore?.removePageState(tab.tabId);
      } else {
        const acceptRestoredPageState = () => {
          const active = pageState.entries[pageState.activeIndex];
          tab.cachedUrl = active?.url ?? tab.cachedUrl;
          tab.cachedTitle = active?.title ?? tab.cachedTitle;
          return true;
        };
        try {
          this.log?.(
            `[browser-use] restore page-state start tabId=${tab.tabId} index=${pageState.activeIndex} entries=${JSON.stringify(pageState.entries.map((entry) => entry.url))}`,
          );
          await guest.navigationHistory.restore({
            entries: pageState.entries.map((entry) => ({ ...entry })),
            index: pageState.activeIndex,
          });
          this.log?.(
            `[browser-use] restore page-state complete tabId=${tab.tabId} url=${safeStr(() => guest.getURL(), "")} index=${safeStr(() => String(guest.navigationHistory.getActiveIndex()), "unknown")} entries=${safeStr(() => JSON.stringify(guest.navigationHistory.getAllEntries().map((entry) => entry.url)), "unknown")}`,
          );
          return acceptRestoredPageState();
        } catch (error) {
          const restoreAppliedDespiteAbort =
            String(error).includes("ERR_ABORTED") &&
            safeBool(() => {
              const actualEntries = guest.navigationHistory.getAllEntries();
              return (
                guest.navigationHistory.getActiveIndex() === pageState.activeIndex &&
                actualEntries.length === pageState.entries.length &&
                actualEntries.every((entry, index) => entry.url === pageState.entries[index]?.url)
              );
            }, false);
          if (restoreAppliedDespiteAbort) {
            // Electron 41 will still report the default about:blank being canceled with ERR_ABORTED after the complete history has been written.
            // The actual navigationHistory shall prevail to avoid accidentally deleting the valid pageState and initiating the second URL navigation.
            return acceptRestoredPageState();
          }
          this.warn(`browser tab page-state restore failed tabId=${tab.tabId}`, error);
          await this.residencyOptions.recoveryStore?.removePageState(tab.tabId);
        }
      }
    }
    if (!tab.cachedUrl) return false;
    try {
      await guest.loadURL(tab.cachedUrl);
      return true;
    } catch (error) {
      this.warn(`browser tab URL restore failed tabId=${tab.tabId}`, error);
      return false;
    }
  }

  private async restoreReboundGuest(
    tab: ManagedTab,
    guest: GuestWebContents,
  ): Promise<GuestWebContents | null> {
    if (tab.lifecycle === "closed" || tab.guest !== guest) return null;
    const restored = await this.restoreGuestState(tab, guest);
    if (!restored || tab.lifecycle === "closed" || tab.guest !== guest) {
      if (tab.lifecycle !== "closed" && tab.guest === guest) {
        this.warn(`browser tab guest rebind restore failed tabId=${tab.tabId}`);
      }
      return null;
    }
    this.log?.(
      `[browser-use] guest rebind restore complete tabId=${tab.tabId} url=${tab.cachedUrl}`,
    );
    await this.persistShell(tab);
    return guest;
  }

  private async persistRecoverySnapshot(tab: ManagedTab, guest: GuestWebContents): Promise<void> {
    tab.cachedUrl = safeStr(() => guest.getURL(), tab.cachedUrl);
    tab.cachedTitle = safeStr(() => guest.getTitle(), tab.cachedTitle);
    await this.persistShell(tab);
    try {
      const entries = guest.navigationHistory.getAllEntries().map((entry) => ({ ...entry }));
      if (entries.length === 0) return;
      const pageState: BrowserTabPageStateRecord = {
        schemaVersion: 1,
        tabId: tab.tabId,
        entries,
        activeIndex: guest.navigationHistory.getActiveIndex(),
        updatedAt: this.now(),
      };
      await this.residencyOptions.recoveryStore?.upsertPageState(pageState);
    } catch (error) {
      // Snapshot failure cannot permanently breach the resource budget; the shell's restoreUrl has been saved first.
      this.warn(`browser tab page-state snapshot failed tabId=${tab.tabId}`, error);
    }
  }

  private async persistShell(tab: ManagedTab): Promise<void> {
    const store = this.residencyOptions.recoveryStore;
    if (!store || tab.lifecycle === "closed") return;
    const residency = this.residencyCoordinator.get(tab.tabId);
    const record: BrowserTabShellRecord = {
      schemaVersion: 1,
      tabId: tab.tabId,
      windowBindingId: null,
      workspaceKey: tab.owner.workspaceKey,
      ...(tab.owner.remoteSessionId ? { remoteSessionId: tab.owner.remoteSessionId } : {}),
      sessionId: tab.owner.sessionId,
      browserId: tab.owner.browserId,
      browserGeneration: tab.owner.browserGeneration,
      origin: tab.origin,
      lifecycle: tab.lifecycle,
      restoreUrl: tab.cachedUrl || null,
      title: tab.cachedTitle || null,
      faviconUrl: tab.cachedFaviconUrl,
      viewport: tab.viewportOverride ? { ...tab.viewportOverride } : null,
      openedAt: tab.openedAt,
      lastSelectedAt: residency?.lastSelectedAt ?? null,
      updatedAt: this.now(),
    };
    try {
      await store.upsert(record);
    } catch (error) {
      this.warn(`browser tab shell persist failed tabId=${tab.tabId}`, error);
    }
  }

  private requireRendererOwnedTab(
    payload: BrowserViewCloseTabRequest & { windowId: number },
    options?: { skipRemoteSession?: boolean },
  ): ManagedTab;
  private requireRendererOwnedTab(
    payload: BrowserViewResidencyReportPayload & { windowId: number },
    options?: { skipRemoteSession?: boolean },
  ): ManagedTab;
  private requireRendererOwnedTab(
    payload:
      | (BrowserViewCloseTabRequest & { windowId: number })
      | (BrowserViewResidencyReportPayload & { windowId: number }),
    options?: { skipRemoteSession?: boolean },
  ): ManagedTab {
    const tab = this.tabs.get(payload.tabId);
    if (
      !tab ||
      tab.lifecycle === "closed" ||
      tab.owner.windowId !== payload.windowId ||
      tab.owner.workspaceKey !== payload.workspaceKey ||
      tab.owner.sessionId !== payload.sessionId ||
      (!options?.skipRemoteSession &&
        (tab.owner.remoteSessionId ?? "") !== (payload.remoteSessionId ?? ""))
    ) {
      throw new Error(`browser tab '${payload.tabId}' is unavailable for renderer scope`);
    }
    return tab;
  }

  private setupActivityTracking(tab: ManagedTab, guest: GuestWebContents): void {
    tab.activityCleanup?.();
    if (!guest.on || !guest.removeListener) return;
    const onLoadingStarted = () => {
      if (tab.guest !== guest) return;
      tab.loading = true;
      this.refreshRuntimeProtection(tab.tabId);
    };
    const onLoadingStopped = () => {
      if (tab.guest !== guest) return;
      tab.loading = false;
      if (!this.guestRecoveryFlights.has(tab.tabId)) {
        tab.cachedUrl = safeStr(() => guest.getURL(), tab.cachedUrl);
        tab.cachedTitle = safeStr(() => guest.getTitle(), tab.cachedTitle);
      }
      this.refreshRuntimeProtection(tab.tabId);
      void this.persistShell(tab);
    };
    const onAudioChanged = () => this.refreshRuntimeProtection(tab.tabId);
    const onMediaStarted = () => {
      if (tab.guest !== guest) return;
      tab.mediaActive = true;
      this.refreshRuntimeProtection(tab.tabId);
    };
    const onMediaPaused = () => {
      if (tab.guest !== guest) return;
      tab.mediaActive = false;
      this.refreshRuntimeProtection(tab.tabId);
    };
    guest.on("did-start-loading", onLoadingStarted);
    guest.on("did-stop-loading", onLoadingStopped);
    guest.on("audio-state-changed", onAudioChanged);
    guest.on("media-started-playing", onMediaStarted);
    guest.on("media-paused", onMediaPaused);
    tab.activityCleanup = () => {
      guest.removeListener?.("did-start-loading", onLoadingStarted);
      guest.removeListener?.("did-stop-loading", onLoadingStopped);
      guest.removeListener?.("audio-state-changed", onAudioChanged);
      guest.removeListener?.("media-started-playing", onMediaStarted);
      guest.removeListener?.("media-paused", onMediaPaused);
    };
  }

  private refreshRuntimeProtection(tabId: string): void {
    const tab = this.tabs.get(tabId);
    if (!tab) return;
    this.residencyCoordinator.report(tabId, {
      loading: tab.loading,
      operationActive: this.hasRunningRequestForTab(tabId),
      captureActive: this.isTabCaptureActive(tab),
      audible: safeBool(() => tab.guest?.isCurrentlyAudible?.() ?? false, false),
      mediaActive: tab.mediaActive,
      downloadActive: this.hasPendingDownloadForTab(tabId),
    });
  }

  private hasRunningRequestForTab(tabId: string): boolean {
    return [...this.runningRequests.values()].some((request) => request.tabId === tabId);
  }

  private isTabCaptureActive(tab: ManagedTab): boolean {
    return (
      this.inFlightScreenshots.has(tab.tabId) ||
      [...this.recordings.values()].some(
        (entry) => entry.tabId === tab.tabId && entry.status === "running",
      ) ||
      safeBool(() => tab.guest?.isBeingCaptured?.() ?? false, false)
    );
  }

  private hasPendingDownloadForTab(tabId: string): boolean {
    return [...this.downloads.values()].some(
      (record) => record.tabId === tabId && record.state === "pending",
    );
  }

  private detachAndCloseGuest(tab: ManagedTab): void {
    const guest = tab.guest;
    // Close first will cause the destroyed event and subsequent listener cleanup to fall on the destroyed object.
    // Electron will continue to print "Object has been destroyed". First dismantle CDP/session/listener, then close the saved
    // The WebContents reference not only releases the real renderer, but also does not change the life cycle of the logical tab.
    this.detachGuest(tab);
    this.closeGuestWebContents(tab, guest);
  }

  private rejectGuestAttach(
    tab: ManagedTab,
    guest: GuestWebContents,
    reason: BrowserGuestAttachRejectReason,
  ): BrowserGuestAttachResult {
    // The scope/session does not match. In the past, it only returned. The renderer did not know the reason for rejection. WaitForGuest
    // You can only wait for the timeout to expire; at the same time, rejected incoming guests are not cleaned up uniformly, and orphan WebContents may be left.
    const recoveryRequested = this.requestGuestRebind(tab, reason);
    if (tab.guest !== guest) this.closeGuestWebContents(tab, guest);
    return { ok: false, reason, recoveryRequested };
  }

  private requestGuestRebind(tab: ManagedTab, reason: GuestRecoveryReason): boolean {
    tab.attachFailure = reason;
    if (tab.lifecycle === "closed" || tab.rebindRequested || !this.onOpenTabRequested) return false;
    tab.rebindRequested = true;
    this.log?.(`[browser-use] request guest rebind tabId=${tab.tabId} reason=${reason}`);
    this.onOpenTabRequested?.(tab.tabId, tab.owner);
    return true;
  }

  private closeGuestWebContents(tab: ManagedTab, guest = tab.guest): void {
    if (!guest || safeBool(() => guest.isDestroyed(), true)) return;
    try {
      guest.close({ waitForBeforeUnload: false });
    } catch (error) {
      this.warn(`browser guest close failed tabId=${tab.tabId}`, error);
    }
  }

  private now(): number {
    return this.residencyOptions.now?.() ?? Date.now();
  }

  private warn(message: string, error?: unknown): void {
    const suffix =
      error === undefined ? "" : ` error=${error instanceof Error ? error.message : String(error)}`;
    this.residencyOptions.warn?.(`${message}${suffix}`);
    this.log?.(`[browser-use] ${message}${suffix}`);
  }

  detach(key: string): void {
    const tab = this.tabs.get(key);
    if (tab) this.detachGuest(tab);
  }

  /**
   * Before the renderer replaces `<webview>` under a new React key, close the old guest's native CDP path.
   *
   * Electron's `render-process-gone` does not always reach the main-process WebContents listener first; if the
   * renderer unmounts the node directly, by the time `destroyed` arrives debugger.detach() can no longer be
   * called, and the DevToolsSession may still dispatch an in-flight notification to the already-destroyed
   * client, triggering a main-process UAF. This turns the DOM teardown into a second stage that runs after the
   * main-process ACK, and double-checks the sender window plus the current guest id so that a late event from
   * the old generation cannot cut the CDP of the new guest that just took over the tab.
   */
  async detachGuestBeforeReplacement(
    tabId: string,
    webContentsId: number,
    windowId: number,
  ): Promise<boolean> {
    const tab = this.tabs.get(tabId);
    if (!tab) return true;
    if (tab.owner.windowId !== windowId) {
      this.log?.(
        `[browser-use] detachGuestBeforeReplacement rejected tabId=${tabId} ` +
          `guestId=${webContentsId} reason=window-mismatch`,
      );
      return false;
    }

    const guest = tab.guest;
    if (!guest) return true;
    const guestIdMatches = safeBool(() => guest.id === webContentsId, false);
    if (!guestIdMatches) {
      this.log?.(
        `[browser-use] detachGuestBeforeReplacement rejected tabId=${tabId} ` +
          `guestId=${webContentsId} reason=guest-mismatch`,
      );
      return false;
    }
    if (safeBool(() => guest.isDestroyed(), true)) {
      // There is no safety window for native detach after destroyed; generation replacement is only allowed if the CDP has been previously confirmed to be disconnected.
      if (tab.cdpAttached) {
        this.log?.(
          `[browser-use] detachGuestBeforeReplacement rejected tabId=${tabId} ` +
            `guestId=${webContentsId} reason=destroyed-with-cdp`,
        );
        return false;
      }
      this.detachGuest(tab);
      return true;
    }

    return this.beginGuestTeardown(tab, guest, "renderer replacement");
  }

  private beginGuestTeardown(
    tab: ManagedTab,
    guest: GuestWebContents,
    reason: string,
  ): Promise<boolean> {
    const existing = tab.guestTeardownFlight;
    if (existing) return existing;
    const flight = this.runGuestTeardown(tab, guest, reason);
    tab.guestTeardownFlight = flight;
    const clearFlight = () => {
      if (tab.guestTeardownFlight === flight) tab.guestTeardownFlight = undefined;
    };
    void flight.then(clearFlight, clearFlight);
    return flight;
  }

  private async runGuestTeardown(
    tab: ManagedTab,
    guest: GuestWebContents,
    reason: string,
  ): Promise<boolean> {
    if (tab.guest !== guest) return !tab.cdpAttached;
    tab.guestLifecycle = "detaching";

    // First stop new request/recording from entering CDP; requests that have been issued are still handled by pendingCdpCommands
    // Count guard until the true Promise settles. In this way, outer layer cancellation will not misjudge the native command as completed.
    for (const request of this.runningRequests.values()) {
      if (request.tabId !== tab.tabId) continue;
      request.controller.abort(new DOMException(`browser guest ${reason}`, "AbortError"));
    }
    this.abortRecordings((entry) => entry.tabId === tab.tabId, `browser guest ${reason}`);

    const pendingAtStart = tab.pendingCdpCommands;
    const settled = await this.waitForGuestCdpIdle(tab, DEFAULT_GUEST_CDP_TEARDOWN_TIMEOUT_MS);
    if (!settled) {
      this.warn(
        `browser guest teardown cdp pending timeout tabId=${tab.tabId} ` +
          `pending=${tab.pendingCdpCommands} started=${pendingAtStart} reason=${reason}`,
      );
    }

    // The destroyed event may arrive first during the waiting period; at this time, detachGuest has completed the JS side closing, but the native
    // detach is only considered safe if cdpAttached=false.
    if (tab.guest !== guest) return !tab.cdpAttached;
    if (safeBool(() => guest.isDestroyed(), true)) {
      if (tab.cdpAttached) {
        this.log?.(
          `[browser-use] guest teardown rejected on destroyed guest tabId=${tab.tabId} ` +
            `guestId=${safeStr(() => String(guest.id), "?")}`,
        );
        return false;
      }
      this.detachGuest(tab);
      return true;
    }

    try {
      if (guest.debugger.isAttached()) guest.debugger.detach();
      if (guest.debugger.isAttached()) {
        this.warn(
          `browser guest replacement cdp detach not confirmed tabId=${tab.tabId} ` +
            `guestId=${safeStr(() => String(guest.id), "?")}`,
        );
        return false;
      }
    } catch (error) {
      // fail closed: The old node is retained when detach fails, and known native UAF windows cannot be reopened with "Continue Rebuilding".
      this.warn(
        `browser guest replacement cdp detach failed tabId=${tab.tabId} ` +
          `guestId=${safeStr(() => String(guest.id), "?")}`,
        error,
      );
      if (tab.guest === guest && !safeBool(() => guest.isDestroyed(), true)) {
        tab.guestLifecycle = "attached";
      }
      return false;
    }

    this.log?.(
      `[browser-use] cdp detached before guest replacement tabId=${tab.tabId} ` +
        `guestId=${safeStr(() => String(guest.id), "?")}`,
    );
    tab.cdpAttached = false;
    tab.guestLifecycle = "detached";
    this.detachGuest(tab);
    return true;
  }

  private async waitForGuestCdpIdle(tab: ManagedTab, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (tab.pendingCdpCommands > 0 && Date.now() < deadline) {
      await new Promise<void>((resolve) =>
        setTimeout(resolve, Math.min(10, deadline - Date.now())),
      );
    }
    return tab.pendingCdpCommands === 0;
  }

  /** Memory diagnostics counters; read-only sizes. */
  collectMemoryDiagnostics(): Record<string, number> {
    return { tabs: this.tabs.size, closedTabIds: this.closedTabIds.size };
  }

  private detachGuest(tab: ManagedTab): void {
    const guest = tab.guest;
    const guestDestroyed = guest ? safeBool(() => guest.isDestroyed(), true) : true;
    if (guest && !this.guestRecoveryFlights.has(tab.tabId)) {
      tab.cachedUrl = safeStr(() => guest.getURL(), tab.cachedUrl);
      tab.cachedTitle = safeStr(() => guest.getTitle(), tab.cachedTitle);
    }
    this.pendingDialogs.delete(tab.tabId);
    try {
      // Electron will destroy the guest first when the renderer unloads <webview>; at this time, the listener has been released with the object.
      // Calling session.removeListener again will only generate meaningless "Object has been destroyed" logs.
      if (!guestDestroyed) tab.downloadCleanup?.();
    } catch (error) {
      // After the guest renderer is killed by Chromium, the removeListener of the old session will also throw
      // "Object has been destroyed"; cleanup failure does not prevent CDP rebinding of the substitute guest.
      this.log?.(
        `[browser-use] detachGuest download cleanup failed tabId=${tab.tabId} error=${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    } finally {
      tab.downloadCleanup = undefined;
    }
    try {
      if (!guestDestroyed) tab.activityCleanup?.();
    } catch {
      // The listener cleanup may fail when the guest has been destroyed; the residency status still needs to be closed.
    } finally {
      tab.activityCleanup = undefined;
      tab.loading = false;
      tab.mediaActive = false;
    }
    // The logout of the crash guard cannot be subject to guestDestroyed: removeListener is a pure JS side operation.
    // The guest reference here is often still alive in the generation change scenario. If it is omitted, the monitoring will accumulate from generation to generation.
    try {
      tab.crashGuardCleanup?.();
    } catch {
      // When the guest has been destroyed, removeListener may throw "Object has been destroyed", which does not affect the closing.
    } finally {
      tab.crashGuardCleanup = undefined;
    }
    // JS layer listener cleanup: The old "message" listener should not continue to hang after the guest is replaced/destroyed. This step is similar to the native side
    // CDP disconnection has nothing to do with it (DevToolsSession dispatch does not check JS monitoring), it is purely to prevent monitoring from accumulating with guest generations.
    const cdpWasAttached = tab.cdpAttached;
    try {
      tab.cdpMessageCleanup?.();
    } catch (error) {
      this.log?.(
        `[browser-use] detachGuest cdp message cleanup failed tabId=${tab.tabId} error=${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    } finally {
      tab.cdpMessageCleanup = undefined;
    }
    if (guest) {
      const guestId = safeStr(() => String(guest.id), "?");
      if (guestDestroyed) {
        // The guest is destroyed before detach (destroyed callback/renderer uninstalls webview). At this time detach()
        // Required and meaningless: native DevToolsAgentHost has been closed along with WebContents, and the main process can only be passive
        // Accept this result. And the crash scene (DevToolsSession::DispatchProtocolNotification in client_
        // vptr=0) is right behind "CDP uses implicit destruction without active detach", so this path must leave traces——
        // Otherwise, you won’t be able to see that it happened in the log, and you can’t match the crash with the specific tab life cycle.
        if (cdpWasAttached) {
          this.log?.(
            `[browser-use] detachGuest cdp still attached on destroyed guest ` +
              `tabId=${tab.tabId} guestId=${guestId}`,
          );
        }
      } else {
        try {
          if (guest.debugger.isAttached()) guest.debugger.detach();
        } catch (error) {
          // This cannot be swallowed silently: detach failure and success are indistinguishable in the log - and "should be able to actively detach"
          // but failed" is exactly the signal that needs to be associated with a crash.
          this.warn(`browser guest cdp detach failed tabId=${tab.tabId} guestId=${guestId}`, error);
        }
      }
    }
    this.clearGuestCdpIdleRelease(tab);
    tab.guest = undefined;
    tab.cdpAttached = false;
    tab.guestLifecycle = guestDestroyed ? "destroyed" : "detached";
    tab.backgroundViewportFallback = undefined;
    // The magnification belongs to the CDP session of the old guest, and the natural viewport after the upgrade will not replay metrics.
    tab.appliedViewportScale = undefined;
    tab.viewportMutation = undefined;
    this.residencyCoordinator.markDetached(tab.tabId);
    this.refreshRuntimeProtection(tab.tabId);
  }

  hasGuest(key: string): boolean {
    const tab = this.tabs.get(key);
    return Boolean(tab?.guest && tab.lifecycle !== "closed");
  }

  disposeAll(): void {
    for (const request of this.runningRequests.values()) {
      request.controller.abort(new DOMException("browser manager disposed", "AbortError"));
    }
    for (const tab of this.tabs.values()) this.closeTab(tab, false);
    for (const key of this.waiters.keys()) this.resolveWaiters(key, null);
    this.tabs.clear();
    this.closedTabIds.clear();
    this.activeTabByScope.clear();
    this.defaultTabByScope.clear();
    this.sessionNames.clear();
    this.naturalViewportByWindow.clear();
    for (const [tabId, waiters] of this.downloadWaiters) {
      let waiter = waiters[0];
      while (waiter) {
        this.finishDownloadWaiter(tabId, waiter, null);
        waiter = waiters[0];
      }
    }
    this.downloads.clear();
    this.queuedDownloads.clear();
    this.inFlightScreenshots.clear();
    this.abandonedScreenshotCaptures.clear();
    for (const entry of this.recordings.values()) {
      entry.controller.abort(new DOMException("browser manager disposed", "AbortError"));
      if (entry.cleanupTimer) clearTimeout(entry.cleanupTimer);
      if (entry.artifact?.path)
        void rm(entry.artifact.path, { force: true }).catch(() => undefined);
    }
    this.recordings.clear();
    this.residencyCoordinator.dispose();
    this.restoredTabClaims.clear();
    for (const resolve of this.suspendAckWaiters.values()) resolve();
    this.suspendAckWaiters.clear();
    this.suspendFlights.clear();
    this.restoreFlights.clear();
    this.guestRecoveryFlights.clear();
    this.guestAttachFlights.clear();
  }

  private waitForGuest(tabId: string, signal?: AbortSignal): Promise<GuestWebContents | null> {
    if (signal?.aborted) return Promise.resolve(null);
    return new Promise<GuestWebContents | null>((resolve) => {
      const waiter: PendingWaiter = {
        resolve,
        timer: setTimeout(() => {
          this.removeWaiter(tabId, waiter);
          this.log?.(`[browser-use] waitForGuest timeout tabId=${tabId}`);
          resolve(null);
        }, this.attachTimeoutMs),
        signal,
      };
      waiter.onAbort = () => {
        this.removeWaiter(tabId, waiter);
        resolve(null);
      };
      signal?.addEventListener("abort", waiter.onAbort, { once: true });
      const list = this.waiters.get(tabId) ?? [];
      list.push(waiter);
      this.waiters.set(tabId, list);
    });
  }

  private removeWaiter(tabId: string, waiter: PendingWaiter): void {
    clearTimeout(waiter.timer);
    if (waiter.onAbort) waiter.signal?.removeEventListener("abort", waiter.onAbort);
    const list = this.waiters.get(tabId);
    if (!list) return;
    const index = list.indexOf(waiter);
    if (index >= 0) list.splice(index, 1);
    if (list.length === 0) this.waiters.delete(tabId);
  }

  private resolveWaiters(tabId: string, guest: GuestWebContents | null): void {
    const list = this.waiters.get(tabId);
    if (!list) return;
    this.waiters.delete(tabId);
    for (const waiter of list) {
      clearTimeout(waiter.timer);
      if (waiter.onAbort) waiter.signal?.removeEventListener("abort", waiter.onAbort);
      waiter.resolve(guest);
    }
  }
}

function linkAbortSignal(signal: AbortSignal | undefined, controller: AbortController): () => void {
  if (!signal) return () => undefined;
  const abort = () => controller.abort(signal.reason);
  if (signal.aborted) abort();
  else signal.addEventListener("abort", abort, { once: true });
  return () => signal.removeEventListener("abort", abort);
}

function waitForPromiseWithSignal<T>(
  promise: Promise<T>,
  signal: AbortSignal,
): Promise<{ completed: true; value: T } | { completed: false }> {
  if (signal.aborted) return Promise.resolve({ completed: false });
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    const onAbort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({ completed: false });
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve({ completed: true, value });
      },
      (error: unknown) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

function waitForDelay(timeoutMs: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false);
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (completed: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      resolve(completed);
    };
    const timer = setTimeout(() => finish(true), timeoutMs);
    const onAbort = () => finish(false);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

async function waitForCondition(
  predicate: () => boolean,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<"matched" | "timeout" | "cancelled"> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (signal.aborted) return "cancelled";
    if (predicate()) return "matched";
    const remaining = deadline - Date.now();
    if (remaining <= 0) return "timeout";
    if (!(await waitForDelay(Math.min(50, remaining), signal))) return "cancelled";
  }
}

function readScreenshotSurfaceInvalidation(signal: AbortSignal | undefined): Error | undefined {
  if (!signal?.aborted) return undefined;
  if (signal.reason instanceof Error) return signal.reason;
  return new Error("browser screenshot activity was invalidated");
}

async function raceBackendExecution(
  execution: Promise<BrowserCommandResult>,
  signal: AbortSignal,
  command: BrowserCommand,
  startedAt: number,
): Promise<BrowserCommandResult> {
  if (signal.aborted) {
    return {
      ok: false,
      error: {
        code: "cancelled",
        message: "browser request cancelled after backend dispatch; side effects may have occurred",
        sideEffect: isSideEffecting(command) ? "uncertain" : "none",
      },
      elapsedMs: Date.now() - startedAt,
    };
  }
  return await new Promise((resolve) => {
    let settled = false;
    const finish = (result: BrowserCommandResult) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      resolve(result);
    };
    const onAbort = () =>
      finish({
        ok: false,
        error: {
          code: "cancelled",
          message: isSideEffecting(command)
            ? "browser request cancelled after backend dispatch; side effects may have occurred"
            : "browser request cancelled",
          sideEffect: isSideEffecting(command) ? "uncertain" : "none",
        },
        elapsedMs: Date.now() - startedAt,
      });
    signal.addEventListener("abort", onAbort, { once: true });
    execution.then(finish, (error: unknown) =>
      finish({
        ok: false,
        error: {
          code: "execution_error",
          message: error instanceof Error ? error.message : String(error),
        },
        elapsedMs: Date.now() - startedAt,
      }),
    );
  });
}

function isBrowserViewportSize(value: unknown): value is BrowserViewportSize {
  if (!value || typeof value !== "object") return false;
  const viewport = value as Record<string, unknown>;
  return (
    Number.isInteger(viewport.width) &&
    Number(viewport.width) > 0 &&
    Number.isInteger(viewport.height) &&
    Number(viewport.height) > 0
  );
}

function isBrowserPointValue(value: unknown): value is { x: number; y: number } {
  if (!value || typeof value !== "object") return false;
  const point = value as Record<string, unknown>;
  return typeof point.x === "number" && typeof point.y === "number";
}

function abortError(): DOMException {
  return new DOMException("Browser recording cancelled", "AbortError");
}

function normalizeBackgroundViewport(viewport: BrowserViewportSize): BrowserViewportSize {
  return {
    width: Math.min(
      BROWSER_VIEWPORT_LIMITS.maxWidth,
      Math.max(BROWSER_VIEWPORT_LIMITS.minWidth, viewport.width),
    ),
    height: Math.min(
      BROWSER_VIEWPORT_LIMITS.maxHeight,
      Math.max(BROWSER_VIEWPORT_LIMITS.minHeight, viewport.height),
    ),
  };
}

function isScreenshotCommand(command: BrowserCommand): boolean {
  return (
    command.method === "screenshot" ||
    (command.method === "playwright" && command.action.name === "elementScreenshot")
  );
}

function assertViewportOverride(viewport: BrowserViewportSize): void {
  if (
    !Number.isInteger(viewport.width) ||
    viewport.width < BROWSER_VIEWPORT_LIMITS.minWidth ||
    viewport.width > BROWSER_VIEWPORT_LIMITS.maxWidth ||
    !Number.isInteger(viewport.height) ||
    viewport.height < BROWSER_VIEWPORT_LIMITS.minHeight ||
    viewport.height > BROWSER_VIEWPORT_LIMITS.maxHeight
  ) {
    throw new Error("browser viewport is outside the supported free-size range");
  }
}

function safeStr(fn: () => string, fallback: string): string {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

function safeBool(fn: () => boolean, fallback: boolean): boolean {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

function normalizeDialogType(type: string | undefined): BrowserDialog["type"] {
  switch (type) {
    case "alert":
    case "confirm":
    case "prompt":
    case "beforeunload":
      return type;
    default:
      return "alert";
  }
}

/** Browser response meta will enter the model trace and debug log; only origin/path will be retained, and credential/query/hash will never be carried. */
function sanitizeBrowserMetaUrl(value: string): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    const sanitized = url.toString();
    return url.pathname === "/" ? sanitized.slice(0, -1) : sanitized;
  } catch {
    // Legal opaque URLs such as about:blank can also be parsed by the URL; the internal strings of the page that cannot be parsed should not enter the meta.
    return undefined;
  }
}
