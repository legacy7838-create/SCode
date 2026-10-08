/* eslint-disable max-lines -- IAB owner registry、ready/abort lifecycle 与 guest CDP 状态必须在同一状态机内原子维护，拆散会重新引入跨 scope 竞态。 */
import { randomUUID } from "node:crypto";
import { webContents, type WebFrameMain } from "electron";
import {
  BROWSER_VIEWPORT_LIMITS,
  type BrowserGuestAttachRejectReason,
  type BrowserGuestAttachResult,
  type BrowserViewCloseTabRequest,
  type BrowserViewResidencyReportPayload,
  type BrowserViewResidencyTransitionPayload,
  type BrowserViewRestoredTabShell,
  type BrowserViewportSize,
} from "@zcode/shared";
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
  clientMode: "desktop-continuous" | "web-remote-replayable";
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
  /** guest replacement generation；命令 dispatch 前用来拒绝 stale guest。 */
  guestGeneration: number;
  /** 曾经成功绑定过 guest；用于区分新建 tab 的首次等待与已有 tab 的自愈。 */
  hasAttachedGuest: boolean;
  attachFailure?: GuestRecoveryReason;
  rebindRequested: boolean;
  cdpAttached: boolean;
  /** guest 的 native CDP 生命周期；DOM 销毁前必须先经过 detaching。 */
  guestLifecycle: GuestBindingLifecycle;
  /** 尚未 settle 的 debugger.sendCommand 数量，teardown 会等待其归零或超时。 */
  pendingCdpCommands: number;
  /** 命令流空闲释放的计时器；每次 CDP 命令完成后重置，detachGuest 时清除。 */
  guestCdpIdleTimer?: ReturnType<typeof setTimeout>;
  /** re-attach 会话态恢复 flight；业务命令必须 await 它完成才能派发（串行屏障）。 */
  guestCdpRestoreFlight?: Promise<void>;
  /** 当前已持有 viewport 临界区；CDP 重连直接重放，不能再次入队等待自己。 */
  insideViewportMutation?: boolean;
  /** 同一 guest 的 replacement teardown 只允许一个 flight，重复 ACK 共享结果。 */
  guestTeardownFlight?: Promise<boolean>;
  lifecycle: TabLifecycle;
  origin: "agent" | "user";
  /** human IAB tab 在同 window/workspace 首次操作前可被任一 session 发现。 */
  claimable: boolean;
  /** claimed user tab finalize/closeSession 时恢复为用户 tab，不能像 agent tab 一样关闭。 */
  userOwner?: InternalExecutionContext;
  active: boolean;
  /** Agent/UI 设置的单 tab CSS viewport；undefined 表示跟随宿主自然尺寸。 */
  viewportOverride?: BrowserViewportSize;
  /** Desktop page zoom 放大时专用于校正 guest native raster；不改变 CSS viewport。 */
  desktopZoomFactor?: number;
  /** 已成功下发给 Chromium 的倍率；输入不得使用尚在 viewport 队列中的目标倍率。 */
  appliedViewportScale?: number;
  /** pane 隐藏为 0×0 时仅供后台执行使用；重新前台可见后必须清除。 */
  backgroundViewportFallback?: BrowserViewportSize;
  /** 串行化 transient clear 与显式 set/reset，保证最后一次用户/Agent 设置胜出。 */
  viewportMutation?: Promise<void>;
  downloadCleanup?: () => void;
  activityCleanup?: () => void;
  /**
   * 注销 debugger 的 "message" 监听。guest 换代后旧监听不该继续挂着：它每次事件都要查表
   * 再靠 current.guest !== guest 兜底丢弃，属于纯泄漏。注意这只是 JS 层清理，native 侧的
   * CDP 通路要靠 debugger.detach() 才真正断开。
   */
  cdpMessageCleanup?: () => void;
  /**
   * 注销 render-process-gone 监听。该监听负责在 guest renderer 被杀、WebContents 尚存的
   * 窗口里主动断开 CDP —— 这是唯一能避免 api::Debugger 走隐式析构的时机。
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
// 透明 presentation 已就位时整幅 capture 的硬上限；正常应在数百 ms 内完成。
const HIDDEN_WINDOW_CAPTURE_DEADLINE_MS = 5_000;
// 单个 tab 上"已放弃等待但底层 CDP capture 仍未结算"的硬上限。CDP 截图没有单请求
// 取消 API，重试会在 Chromium 内遗留 pending command；compositor 持续不可用时
// 不设上限会无限叠加（帧恢复时它们会同时排空，但 pendingCdpCommands 不归零、
// detach 走超时路径）。达到上限后同 tab 截图快速失败并提示重开 tab，旧 capture
// 真实落定后名额自动回收。
const MAX_ABANDONED_SCREENSHOT_CAPTURES = 3;
/** teardown 等待 CDP 在途命令收敛的上限；超时后仍会尝试 native detach。 */
const DEFAULT_GUEST_CDP_TEARDOWN_TIMEOUT_MS = 1_000;
// CDP 命令流空闲释放阈值：覆盖实测崩溃窗口（turn 内命令间隙 0.4~9s）的同时，
// 不打断 agent 密集操作流（命令间隔通常远小于该值）。
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
    // CDP 默认会让 DPR=1 的页面指标同时接管 visible size，Retina 上因此只分配
    // 1x native surface，虽然 DOM bounds 正确，网页却只覆盖 frame 左上角。visible surface
    // 应继续由 Electron <webview> 的实际 bounds 管理，CDP 只负责 CSS viewport 与截图 DPR。
    deviceScaleFactor: 1,
    mobile: false,
    dontSetVisibleSize: true,
    // Desktop page zoom > 1 时，Electron 的 guest target 截图本身已只有
    // frame 的 1 / zoom 内容，外层 CSS transform 无法补齐 native raster。CDP scale
    // 只在放大档位校正可见面；缩小保持默认 1，避免再次缩小内容。
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

/**
 * IAB guest registry。生产路径严格按 BrowserGuestExecutionContext 隔离；string 入参只保留给
 * 旧 renderer/单测兼容，不能由新调用方使用。
 */
function safeNumber(read: () => number | undefined): number | undefined {
  try {
    const value = read();
    return typeof value === "number" ? value : undefined;
  } catch {
    // guest 已销毁时访问 id 会抛错；资源管理器只需跳过该 tab。
    return undefined;
  }
}

export class BrowserGuestManager {
  private readonly tabs = new Map<string, ManagedTab>();

  /** 资源管理器：当前仍活着的浏览器 guest webContents id，用于把其 renderer 归到内置插件 browser-use */
  listGuestWebContentsIds(): number[] {
    const ids: number[] = [];
    for (const tab of this.tabs.values()) {
      if (tab.lifecycle === "closed" || !tab.guest) continue;
      const id = safeNumber(() => tab.guest?.id);
      if (id !== undefined) ids.push(id);
    }
    return ids;
  }
  /** close 后只保留 opaque id tombstone，拒绝迟到的 renderer attach，不保留 owner/guest。 */
  private readonly closedTabIds = new Set<string>();
  private readonly activeTabByScope = new Map<string, string>();
  private readonly defaultTabByScope = new Map<string, string>();
  private readonly waiters = new Map<string, PendingWaiter[]>();
  private readonly downloads = new Map<string, DownloadRecord>();
  private readonly queuedDownloads = new Map<string, string[]>();
  private readonly downloadWaiters = new Map<string, DownloadWaiter[]>();
  private readonly visibilityByScope = new Map<string, boolean>();
  private readonly naturalViewportByWindow = new Map<number, BrowserViewportSize>();
  private readonly residencyCoordinator: BrowserTabResidencyCoordinator;
  private readonly suspendAckWaiters = new Map<string, () => void>();
  private readonly suspendFlights = new Map<string, Promise<void>>();
  private readonly restoreFlights = new Map<string, Promise<GuestWebContents | null>>();
  /** guest 被销毁后重绑时，替代 guest 必须先完成原页面恢复再接收新的 browser 命令。 */
  private readonly guestRecoveryFlights = new Map<string, Promise<GuestWebContents | null>>();
  /** 同一 tab 的 attach/rebind 只允许一个 flight，避免并发命令各自重建 webview。 */
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
    private readonly residencyOptions: BrowserGuestManagerResidencyOptions = {},
    // CDP 命令流空闲多久后主动释放（detach）。guest renderer 被
    // Chromium 杀且 render-process-gone 未送达 main 时，destroyed 直达 + CDP attached 即
    // 主进程 UAF；命令间隙是实测崩溃窗口，命令级 idle 释放将其收窄。
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
      // fromId 接受进程内任意 WebContents id；若 renderer 误传主窗口 id，后续
      // CDP/Runtime 输入会直接操作 ZCode composer。IAB 只允许真实 <webview> guest fail closed。
      this.log?.(
        `[browser-use] attachGuest rejected tabId=${tabId} id=${webContentsId} reason=not-webview type=${guest.getType()}`,
      );
      return { ok: false, reason: "not-webview", recoveryRequested: false };
    }

    if (this.closedTabIds.has(tabId)) {
      this.log?.(`[browser-use] attachGuest rejected tabId=${tabId} reason=closed`);
      return { ok: false, reason: "closed", recoveryRequested: false };
    }
    // 兼容旧 renderer：未经历 create request 的 key 只进入 legacy scope。
    if (!tab) {
      const owner = options?.workspaceKey
        ? {
            requestId: `unclaimed:${randomUUID()}`,
            browserId: "unclaimed-iab",
            browserGeneration: 0,
            windowId: options.windowId ?? 0,
            workspaceKey: options.workspaceKey,
            // human tab 原来只按 workspace 登记为全局 unclaimed，任意新对话都能
            // 从 user.openTabs() 枚举并接管。ownerTaskId 现在随 attach 冻结；旧 renderer
            // 未传 sessionId 时保留不可认领哨兵，宁可隐藏也不能跨对话泄漏。
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
      // renderer 的迟到 dom-ready 不能用另一个对话的 ownership 复用既有 tabId。
      // window/workspace 相同也必须拒绝，避免 guest 被跨对话替换后绕过 openTabs 隔离。
      this.log?.(`[browser-use] attachGuest rejected tabId=${tabId} reason=session-mismatch`);
      return this.rejectGuestAttach(tab, guest, "session-mismatch");
    }
    if ((tab.owner.remoteSessionId ?? "") !== (options?.remoteSessionId ?? "")) {
      // remote owner 过去只在 renderer 主动提供 remoteSessionId 时校验，缺失值会
      // fail-open；远程重连后的旧 tab 因而可能被新 runtime attach。
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
      // 恢复 timeout 已回滚后，旧 generation 的迟到 guest 原来仍会绕过 restoring
      // 校验并重新占用 tab。suspended/pending 只允许当前旧 guest 重复上报，不接受新 attach。
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
      // 恢复态 src 使用不会提交 document 的延迟 protocol；scope/generation 校验通过后
      // 终止 provisional request，确保 restoreGuestState 创建唯一首次有效导航。
      try {
        guest.stop();
      } catch (error) {
        this.warn(`browser tab provisional navigation stop failed tabId=${tabId}`, error);
      }
    }
    if (tab.guest && !isSameGuest) this.detachGuest(tab);
    if (!isSameGuest) this.guestRecoveryFlights.delete(tab.tabId);

    // detachGuest 会从仍存活的旧 guest 读取最后 URL；恢复判定必须放在它之后，避免 renderer
    // 尚未来得及上报 residency 时，把刚刚发生过的导航误判成没有可恢复事实。
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
    // 恢复期新 guest 的初始 URL 是 about:blank。若在 pageState/restoreUrl 消费前
    // 覆盖 logical cache，损坏快照会错误降级到空白页，三类事实全缺失的 orphan 也无法识别。
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
    // 放在其余接线之前：后面几个 setup 在 guest 已销毁时可能同步抛错并跳过剩余接线，
    // 而这是唯一能关闭 UAF 窗口的监听，不该被别的接线牵连。
    if (!isSameGuest) this.setupCdpCrashGuard(tab, guest);
    if (!isSameGuest) this.setupDownloadTracking(tab, guest);
    if (!isSameGuest) this.setupActivityTracking(tab, guest);
    if (!isSameGuest) this.applyViewportOverride(tab);
    if (tab.viewportOverride) {
      // Agent 可能在 renderer 完成自动打开前就发出 viewport 事件；guest attach 后重放一次，
      // 保证刚挂载的自由尺寸 UI 不会漏掉 main → renderer 的一次性同步。
      this.onViewportChanged?.({ ...tab.viewportOverride }, tab.owner, tab.tabId);
    }
    if (options?.active !== false && this.visibilityByScope.get(scopeKey(tab.owner)) === true) {
      // visibilityByScope 表示整个 browser scope 可见，不表示本次 attach 的 tab
      // 被选中。把 inactive guest 也回放为 visible=true 会让 renderer 在用户切换后
      // 又激活旧 tab；关闭后迟到的同类事件还会复活 tab shell。只有非 inactive attach 才能
      // 沿用 scope 可见性，显式选中仍由 selectTab/browserVisibilitySet 通知。
      this.onVisibilityChanged?.(true, tab.owner, tab.tabId);
    }
    if (shouldRestoreAfterRebind) {
      // guest-destroyed 只重放 Ready 时，新 guest 的初始 URL 是 about:blank；若直接
      // 将它标记为可用，renderer 又不会重新消费已应用过的 initialUrl，右侧面板就永久停在空白页。
      // 这里沿用已有 pageState → restoreUrl 恢复逻辑，并以 tab 级 flight 串住后续命令。
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

  /** Renderer 自由尺寸交互回写；发送方窗口由 IPC 层绑定，不能跨窗口修改其它 tab。 */
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

  /** 根据 guest WebContents 反查受控 tab，供 webview popup 事件保留原始 session scope。 */
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
      // renderer 前台上报是用户真实在看的信号（面板展开/切 tab），与 claimable 无关，
      // 必须独立于 selectTab 触发恢复。
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
    // Agent close 已把 logical tab 从 main 删除，而 BrowserViewCloseTab 通知可能落在
    // 非当前 workspace 被 renderer 丢弃，UI 侧仍留着壳。此时用户点 × 走到这里，直接抛
    // "unavailable for renderer scope"，renderer 拿不到授权就永不移除 UI —— tab 永远关不掉。
    // main 已经没有这个 logical tab，renderer 想收敛自己的壳是安全且必要的：幂等放行，
    // 同时补上 tombstone，阻止迟到 attach 把它复活。scope 校验只对仍存活的 tab 生效，
    // 跨 window/workspace 越权关闭他人 tab 仍然被拒绝。
    const existing = this.tabs.get(payload.tabId);
    if (!existing || existing.lifecycle === "closed") {
      this.closedTabIds.add(payload.tabId);
      return;
    }
    // close 是收敛意图：remoteSessionId 的防重连语义只属于 attach（见 attachGuest 的
    // remote-session-mismatch）。attach 侧 renderer 对该字段有 workspaceRemoteSessionId 兜底、
    // close 侧没有，严格比对会让远程 human tab 永远关不掉。renderer 关闭自己看得见的 tab 不构成
    // 越权，window/workspace/session 三项仍严格校验，跨作用域越权关闭照旧拒绝。
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

  private async ensureGuest(
    tab: ManagedTab,
    signal: AbortSignal,
  ): Promise<GuestWebContents | null> {
    if (signal.aborted) return null;
    const suspendFlight = this.suspendFlights.get(tab.tabId);
    if (suspendFlight) {
      // 保护状态只能取消 coordinator generation，不能立刻证明 renderer 未卸载。
      // Browser command 必须等待 snapshot/ack/必要恢复收敛，不能复用即将销毁的旧 guest。
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
    // 新 tab 的首次 ready 仍只等待一次；已有 guest 或已明确收到拒绝时允许一次有界重放。
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (tab.lifecycle === "closed") return null;
      // create/ready 是可重放状态；事件丢失或 guest 崩溃后发起一次有界重放。
      // 如果 destroyed/mismatch 已经发起过重绑，沿用该请求，避免同一 tab 重复创建 webview。
      if (!tab.rebindRequested) this.onOpenTabRequested?.(tab.tabId, tab.owner);
      // 某些测试/旧 renderer 会在 Ready 回调内同步 attach；不能在 attach 已成功后再注册 waiter。
      if (tab.guest && !safeBool(() => tab.guest.isDestroyed(), true)) return tab.guest;
      const guest = await this.waitForGuest(tab.tabId);
      if (guest && !safeBool(() => guest.isDestroyed(), true)) return guest;
      if (attempt === 0 && !tab.hasAttachedGuest && !tab.attachFailure) return null;
      if (attempt === 1) return null;
      this.requestGuestRebind(tab, tab.attachFailure ?? "attach-timeout");
    }
    return null;
  }

  private selectTab(tab: ManagedTab, notifyRenderer: boolean): void {
    const key = scopeKey(tab.owner);
    // 同一 browser scope 最多只能有一个 active tab；旧 attach 路径只把新 tab 设为 active，
    // 没有清掉旧 tab.active，导致 tabs.list() 可能同时返回多个 active=true。
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
    // activateTab / claim 都以 selectTab(tab, true) 收口；attach 路径走 notifyRenderer=false
    // 且已自行调用恢复，不会重复。
    this.maybeRestoreBackgroundViewport(tab);
  }

  private releaseGuestCdpAfterIdle(tab: ManagedTab, reason: string): void {
    const guest = tab.guest;
    if (!guest || tab.guestLifecycle !== "attached") return;
    void (async () => {
      // 在途 CDP 命令（playwright cdp.send / viewport override / dialog 处理）结束后再断开，
      // 避免中途拆掉正在使用的管线；超时兜底与 runGuestTeardown 共用同一预算。
      const settled = await this.waitForGuestCdpIdle(tab, DEFAULT_GUEST_CDP_TEARDOWN_TIMEOUT_MS);
      if (!settled) {
        this.warn(
          `browser guest cdp release pending timeout tabId=${tab.tabId} ` +
            `pending=${tab.pendingCdpCommands} reason=${reason}`,
        );
      }
      // 等待期间 tab 可能已换代/关闭/再次进入命令期，此时放弃本轮释放。
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
   * 命令级空闲释放：每次 CDP 命令完成后重置计时，超过 cdpIdleReleaseMs 无新命令即主动
   * detach。guest renderer 被 Chromium 杀且 render-process-gone 丢失（Electron 已知缺口，
   * 实测 destroyed 直达 + CDP attached → 主进程 UAF）的崩溃窗口集中在 turn 内命令间隙，
   * turnEnded 级释放覆盖不到；密集命令流间隔远小于阈值，不会被误打断。
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

  closeWindow(windowId: number): void {
    for (const tab of this.tabs.values()) {
      if (tab.owner.windowId !== windowId) continue;
      this.detachAndCloseGuest(tab);
      this.residencyCoordinator.remove(tab.tabId);
      this.restoredTabClaims.delete(tab.tabId);
      this.tabs.delete(tab.tabId);
    }
    this.naturalViewportByWindow.delete(windowId);
  }

  private async removeTabRecovery(tab: ManagedTab): Promise<void> {
    await this.residencyOptions.recoveryStore?.remove(tab.tabId);
  }

  private async closeTabDurably(tab: ManagedTab, notifyRenderer = true): Promise<void> {
    if (tab.lifecycle === "closed") return;
    // 旧 close 先回命令/通知 renderer，再 fire-and-forget 删除恢复仓库；紧接着退出时
    // 已关闭 tab 会从旧 shell 复活。先完成持久删除，失败时保留当前 logical tab 供调用方重试。
    await this.removeTabRecovery(tab);
    this.closeTab(tab, notifyRenderer);
  }

  private closeTab(tab: ManagedTab, notifyRenderer = true): void {
    if (tab.lifecycle === "closed") return;
    tab.lifecycle = "closed";
    this.closedTabIds.add(tab.tabId);
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
   * guest renderer 崩溃/被杀时立即断开 CDP。
   *
   * 崩溃链条（主进程 UAF，minidump 落在 DevToolsSession::DispatchProtocolNotification，
   * client_ 的 vptr 为 0）：
   *   Chromium 在内存压力下杀掉 guest renderer
   *     → render-process-gone：WebContents 仍存活，CDP 仍 attached
   *     → renderer 侧递增 webviewGeneration，React 卸载旧 <webview>
   *     → 旧 WebContents 此刻才销毁，api::Debugger 走隐式析构
   *     → DevToolsSession 仍持 client_ 派发在途通知 → UAF → 主进程崩溃 → 整个 app 退出
   *
   * 实测（Electron 41.0.3 / forcefullyCrashRenderer，带毫秒时间戳的对照实验）：
   *   - render-process-gone 时 isDestroyed()=false、isCrashed()=true、isAttached()=true，
   *     detach() 成功且随后 isAttached()=false；
   *   - destroyed 时 isCrashed()/isAttached() 全抛 "Object has been destroyed"，
   *     那里已经不可能 detach —— 所以 destroyed 兜底修不了这个 UAF；
   *   - 崩溃后若不卸载 <webview>，WebContents 无限期停在 crashed 态（10s destroyed 未到）；
   *     一旦 renderer 卸载 <webview>，destroyed 在 ~5ms 内到达。即销毁时机由 renderer 决定，
   *     native detach 的安全窗口只存在于 WebContents 销毁之前。
   * main 的 render-process-gone 是第一道守卫；renderer 重建前的显式 detach ACK 是第二道屏障，
   * 用来覆盖 main 事件未到达的现场。两者都不改变销毁时机，只保证销毁时 CDP 已经断开。
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
      // 不校验 tab.guest === guest：断开一个已换代 guest 的 CDP 同样正确且必要，
      // 而漏掉它就等于把 UAF 窗口留着。
      try {
        if (this.tabs.get(tabId)?.guest === guest) tab.guestLifecycle = "detaching";
        if (!guest.debugger.isAttached()) return;
        guest.debugger.detach();
        this.log?.(
          `[browser-use] cdp detached on render-process-gone tabId=${tabId} ` +
            `guestId=${guestId} reason=${reason}`,
        );
      } catch (error) {
        // 这里失败意味着 UAF 窗口没能关上，必须留痕以便与后续崩溃关联。
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
   * 前台激活路径的统一收口：后台 fallback viewport 不能在 tab 回到前台后残留。
   * 仅在 attachGuest({active:true}) 时清除是不够的：guest 存活期间的前台切换
   * （activateTab / claim / renderer residency 上报）不会重新 attach，页面就永久钉死在
   * 后台尺寸。restoreNaturalViewportAfterBackground 自带幂等守卫与串行 mutation 队列，
   * 多个前台信号重复触发是安全的。
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
      // active=true 已到达但 Chromium 尚未完成可见布局时，继续保留 transient；下一次
      // renderer 可见 attach 或 viewport 读取仍可恢复，不能短暂退回 0×0。
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
        // CDP 恢复据此在当前临界区直接重放，避免二次入队后等待自己。
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
   * CDP session 态恢复式 attach：idle/turn 结束释放后再次进入命令期时调用，
   * 返回可等待的 flight——Page.enable 与 viewport override 重放完成后业务命令才允许派发。
   *
   * Page 域 enable 与 Emulation.setDeviceMetricsOverride 都是 per-session 的，
   * detach 时已被 Chromium 清空；
   * 裸 attach("1.3") 得到的是干净 session——dialog 事件黑洞（getDialog 恒 null、evaluate
   * 遇 JS dialog 挂到超时实测 62s）、viewport 仿真与 manager 缓存分叉。且 fire-and-forget
   * 重放没有等待屏障：业务命令（截图/evaluate）可能在恢复完成前执行，重放在首命令场景
   * 失效。恢复命令经 raw 发送（不走 ensure，避免自等待）；viewport 重放走既有串行队列，
   * 队列内触发恢复时直接重放，避免二次入队与当前 flight 互相等待死锁。
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
    // 恢复失败必须上抛：屏障契约是「Page.enable 与 viewport 状态就绪后才
    // 允许业务命令派发」。吞掉异常会让后续命令见 attached 即跳过恢复——Page.enable
    // 丢失把 dialog 事件黑洞延长到整个 attach 期，且 "replayed" 日志误导排障。异常上抛
    // 前先 rollback 到 detached：半途 session 不可用，还原释放态后下一次命令才会重建
    // 恢复 flight（否则 attached=true 会让 lazy attach 跳过恢复，失败被永久固化）。
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
        // 截图也占用 viewport 队列，但并不重设 metrics。若把队列内 re-attach
        // 一律当作等效恢复而跳过，首张图会读到宿主缩放后的自然尺寸。
        // 已在临界区时直接重放；再次入队并等待自己会死锁。
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

  /** 恢复失败时把半途 session 还原为释放态；rollback 自身的失败不得掩盖原始错误。 */
  private rollbackGuestCdpRestore(tab: ManagedTab, guest: GuestWebContents): void {
    try {
      if (guest.debugger.isAttached()) guest.debugger.detach();
    } catch {
      // session 可能已销毁；cdpAttached 复位仍需完成。
    }
    tab.cdpAttached = false;
  }

  /** 恢复命令专用发送：只做 pending 计数与下发，不触发 ensure（避免自等待死锁）。 */
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
          // renderer 的归一化回调可能被 Electron 后续 page zoom 传播覆盖。
          // 固定 viewport 的设置和 CDP 重连都必须在同一执行边界恢复 guest zoom。
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
    // turnEnded/closeSession/命令空闲后 CDP 已主动释放（防 guest
    // 销毁时的主进程 UAF），命令路径在此恢复式 re-attach 并 await 会话态重放完成（显式
    // 串行屏障：Page.enable / viewport override 先于本命令被 Chromium 处理）。
    if (!safeBool(() => guest.debugger.isAttached(), false) || tab.guestCdpRestoreFlight) {
      await this.ensureGuestCdpAttached(tab, guest);
    }
    // native raster 的 metrics scale 同时影响 CDP 鼠标输入。工具、locator
    // 和截图仍以 CSS px 表达，在唯一 guest 发送边界补偿位置和滚轮距离，避免各 API 重复换算。
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
      // 旧的数量门禁只销毁 WebContents 并保留 suspended logical tab，
      // 因此标签栏会突破 32。必须复用 durable close，按“恢复数据 → guest → renderer tab 壳”
      // 的顺序完整关闭，避免已关闭 tab 在当前 UI 或下次启动时复活。
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
      // 旧 single-flight 直接采用首个 caller 的 AbortSignal；首个 command 取消会
      // 毒化所有并发 caller，并把 coordinator 留在 restoring。flight 改由 tab 生命周期拥有。
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
        // 通知 renderer 回到轻量 shell；新 generation 同时让本轮迟到 attach fail closed。
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
      // 仅 forced restore mount 后三类恢复事实全部缺失才清理孤儿；普通 page-state 淘汰
      // 仍会保留 restoreUrl，不得进入这个分支形成 restore/close 循环。
      await this.removeTabRecovery(tab);
      this.residencyOptions.onRecoveryOrphanCloseRequested?.({
        tabId: tab.tabId,
        reason: "recovery-orphan",
      });
      this.closeTab(tab, false);
      return null;
    }
    if (!restored) {
      // 不能只处理“恢复事实全缺失”：history 与 URL 都失败时仍提交 live 的话，
      // bootstrap/about:blank 因而被永久当成成功页面。失败必须销毁本轮 guest 并回到可重试 shell。
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
      // renderer 原来只收到 restoring 起点，成功后没有终态，会永久保留 restoring shell。
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
        // pageState 只在预算挂起时刷新；恢复后导航会更新 shell，却留下旧快照。
        // 冷启动必须以 logical shell 的当前 URL 为准，不能把 B 回滚成快照里的 A。
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
            // Electron 41 会在完整历史已写入后，仍以 ERR_ABORTED 报告默认 about:blank 被取消。
            // 以实际 navigationHistory 为准，避免误删有效 pageState 并发起第二次 URL 导航。
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
      // 快照失败不能让资源预算永久突破；shell 的 restoreUrl 已先保存。
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

  private hasRunningRequestForTab(_tabId: string): boolean {
    return false;
  }

  private isTabCaptureActive(tab: ManagedTab): boolean {
    // agent CDP 截图已移除，仅保留 guest 原生捕获态供 residency 判定。
    return safeBool(() => tab.guest?.isBeingCaptured?.() ?? false, false);
  }

  private hasPendingDownloadForTab(tabId: string): boolean {
    return [...this.downloads.values()].some(
      (record) => record.tabId === tabId && record.state === "pending",
    );
  }

  private detachAndCloseGuest(tab: ManagedTab): void {
    const guest = tab.guest;
    // 先 close 会让 destroyed 事件与后续 listener cleanup 都落在已销毁对象上，
    // Electron 会持续打印 "Object has been destroyed"。先拆 CDP/session/listener，再关闭保存的
    // WebContents 引用，既释放真实 renderer，也不会改变 logical tab 的生命周期。
    this.detachGuest(tab);
    this.closeGuestWebContents(tab, guest);
  }

  private rejectGuestAttach(
    tab: ManagedTab,
    guest: GuestWebContents,
    reason: BrowserGuestAttachRejectReason,
  ): BrowserGuestAttachResult {
    // scope/session 不匹配过去只 return，renderer 不知道拒绝原因，waitForGuest
    // 只能等满 timeout；同时被拒绝的 incoming guest 没有统一清理，可能留下 orphan WebContents。
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
   * renderer 即将用 React key 替换 `<webview>` 时，先关闭旧 guest 的 native CDP 通路。
   *
   * Electron 的 `render-process-gone` 并非每次都会先到达 main 的 WebContents
   * 监听；renderer 若直接卸载节点，`destroyed` 才到达时已无法调用 debugger.detach()，
   * DevToolsSession 仍可能向已析构 client 派发在途通知并触发主进程 UAF。这里把 DOM 销毁
   * 变成 main ACK 之后的第二阶段，并用 sender window + 当前 guest id 双重校验，避免迟到
   * 的旧代事件断开刚接管 tab 的新 guest。
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
      // destroyed 后 native detach 已经没有安全窗口；只有先前确认过 CDP 已断开才允许换代。
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

    // 已经下发的 CDP 命令仍由 pendingCdpCommands 计数保护，直到真实 Promise settle。

    const pendingAtStart = tab.pendingCdpCommands;
    const settled = await this.waitForGuestCdpIdle(tab, DEFAULT_GUEST_CDP_TEARDOWN_TIMEOUT_MS);
    if (!settled) {
      this.warn(
        `browser guest teardown cdp pending timeout tabId=${tab.tabId} ` +
          `pending=${tab.pendingCdpCommands} started=${pendingAtStart} reason=${reason}`,
      );
    }

    // destroyed 事件可能在等待期间先到达；此时 detachGuest 已经完成了 JS 侧收口，但 native
    // detach 只有在 cdpAttached=false 时才可认为安全。
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
      // fail closed：detach 失败时保留旧节点，不能用“继续重建”重新打开已知的 native UAF 窗口。
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

  /** 内存诊断计数器；只读 size。 */
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
    try {
      // Electron 会在 renderer 卸载 <webview> 时先销毁 guest；此时 listener 已随对象释放，
      // 再调用 session.removeListener 只会产生无意义的 "Object has been destroyed" 日志。
      if (!guestDestroyed) tab.downloadCleanup?.();
    } catch (error) {
      // guest renderer 被 Chromium 杀死后，旧 session 的 removeListener 也会抛
      // "Object has been destroyed"；清理失败不能阻断替代 guest 的 CDP 重新绑定。
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
      // guest 已销毁时 listener cleanup 可能失败；residency 状态仍需继续收口。
    } finally {
      tab.activityCleanup = undefined;
      tab.loading = false;
      tab.mediaActive = false;
    }
    // 崩溃守卫的注销不能受 guestDestroyed 约束：removeListener 是纯 JS 侧操作，
    // 而这里的 guest 引用在换代场景下往往还活着，漏掉就会让监听随代际累积。
    try {
      tab.crashGuardCleanup?.();
    } catch {
      // guest 已销毁时 removeListener 可能抛 "Object has been destroyed"，不影响收口。
    } finally {
      tab.crashGuardCleanup = undefined;
    }
    // JS 层监听清理：guest 换代/销毁后旧 "message" 监听不该继续挂着。这一步与 native 侧的
    // CDP 断开无关（DevToolsSession 派发不查 JS 监听），纯粹是防止监听随 guest 代际累积。
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
        // guest 先于 detach 被销毁（destroyed 回调 / renderer 卸载 webview）。此时 detach()
        // 必抛且无意义：native DevToolsAgentHost 已随 WebContents 一起收口，主进程只能被动
        // 接受这个结果。而崩溃现场（DevToolsSession::DispatchProtocolNotification 里 client_
        // vptr=0）正落在「CDP 未经主动 detach 就走隐式析构」之后，所以这条路径必须留痕 ——
        // 否则日志里完全看不到它发生过，无法把崩溃与具体 tab 生命周期对上。
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
          // 这里不能静默吞掉：detach 失败与成功在日志上无法区分 —— 而「本该能主动 detach
          // 却失败了」正是需要与崩溃关联的信号。
          this.warn(`browser guest cdp detach failed tabId=${tab.tabId} guestId=${guestId}`, error);
        }
      }
    }
    this.clearGuestCdpIdleRelease(tab);
    tab.guest = undefined;
    tab.cdpAttached = false;
    tab.guestLifecycle = guestDestroyed ? "destroyed" : "detached";
    tab.backgroundViewportFallback = undefined;
    // 倍率属于旧 guest 的 CDP session，换代后的自然 viewport 不会重放 metrics。
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
    for (const tab of this.tabs.values()) this.closeTab(tab, false);
    for (const key of this.waiters.keys()) this.resolveWaiters(key, null);
    this.tabs.clear();
    this.closedTabIds.clear();
    this.activeTabByScope.clear();
    this.defaultTabByScope.clear();
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
    // about:blank 等合法 opaque URL 也可由 URL 解析；无法解析的页面内部串不应进入 meta。
    return undefined;
  }
}
