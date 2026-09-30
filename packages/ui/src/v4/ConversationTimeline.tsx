/* oxlint-disable eslint(max-lines) -- ConversationTimeline centrally hosts virtual scrolling,
 * scroll anchoring, and loadOlder plus find highlight coordination; scattering them would make the
 * same scroll state travel across files.
 */
import {
  Component,
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type TouchEvent as ReactTouchEvent,
  type WheelEvent as ReactWheelEvent,
} from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ArrowDownIcon } from "lucide-react";
import { TID_V4_TIMELINE, TID_V4_TIMELINE_BOTTOM } from "@zcode/shared";
import type {
  ApiRetryState,
  AttachmentRef,
  CommandAck,
  ConversationRow,
  ConversationRowTarget,
  QueueItem,
  SessionPhase,
} from "@zcode/shared/zcode-protocol-v4";
import { cn } from "@/components/lib/utils.js";
import { runUserAction } from "@/lib/userActionTelemetry.js";
import { Button } from "@/components/ui/button.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import { ConversationTurnGroup } from "@/v4/ConversationTurnGroup.js";
import { ConversationPendingGuideList } from "@/v4/ConversationPendingGuideList.js";
import type { AssistantFeedbackHandler } from "@/v4/ConversationRowView.js";
import { ConversationTurnNavigator } from "@/v4/ConversationTurnNavigator.js";
import { syncConversationShareSelectionPanelLayout } from "@/v4/conversationShareSelectionPanelLayout.js";
import type { ConversationRowRenderContext } from "@/v4/conversationRowContext.js";
import { splitConversationTimelineLiveTail } from "@/v4/conversationTimelineLiveTail.js";
import {
  getConversationContentWidthClassName,
  getConversationStatusPanelOffsetClassName,
} from "@/v4/conversationLayout.js";
import {
  buildConversationTurnRenderUnits,
  type ConversationTurnRenderUnit,
} from "@/v4/conversationTurnRenderUnits.js";
import {
  resolveConversationTurnNavigatorActiveQueryRowId,
  resolveConversationTurnNavigatorHydrationRetryDelayMs,
  shouldHydrateConversationTurnNavigatorDirectory,
  type ConversationTurnNavigatorHydrationResult,
  type ConversationTurnNavigatorQueryPosition,
  type ConversationTurnNavigatorVirtualItem,
} from "@/v4/conversationTurnNavigatorHelpers.js";
import {
  DEFAULT_ROW_HEIGHT_ESTIMATE_PX,
  TimelineRowHeightCache,
} from "@/v4/timelineRowHeightCache.js";
import {
  readChatSessionScrollMemoryState,
  resolveChatSessionScrollRestoreTop,
  saveChatSessionScrollMemoryState,
  type ChatSessionScrollMemoryState,
} from "@/lib/chatSessionScrollMemory.js";
import type {
  ChatSearchResultHighlightRequest,
  ConversationFindMatchState,
} from "@/v4/legacyChatViewTypes.js";
import {
  anchorActionAfterContentChange,
  historyPrefetchTriggerPx,
  initialFollowing,
  isAtBottom,
  prependScrollAdjustment,
  prependVirtualAnchorAdjustment,
  reconcileFollowingForContentAnchor,
  resolveFollowingAfterScroll,
  shouldAdjustVirtualizerForItemSizeChange,
  shouldShowBackToBottom,
  shouldTriggerLoadOlder,
  timelineKeyboardScrollIntent,
  timelineTouchScrollIntent,
  timelineWheelScrollIntent,
  type PrependVirtualAnchor,
  type TimelineUserScrollIntent,
} from "@/v4/timelineScrollAnchor.js";
import { useConversationTimelineFind } from "@/v4/useConversationTimelineFind.js";
import { ConversationSelectionTooltip } from "@/v4/ConversationSelectionTooltip.js";
import type { ConversationSelectionReference } from "@/lib/conversationSelectionReference.js";

// `pendingGuides = []` in the memo component parameter will create a new reference on each call,
// Lets rendering without passing this property bypass stable reference boundaries; sharing a read-only empty array keeps the default value constant.
const EMPTY_PENDING_GUIDES: readonly QueueItem[] = [];

const ROW_OVERSCAN = 8;
const RUNNING_WORK_DURATION_TICK_MS = 1000;
const COMPOSER_MESSAGE_MASK_FADE_PX = 24;
const COMPOSER_MESSAGE_MASK_TRANSPARENT_HEIGHT_PX = 96;
const USER_SCROLL_INTENT_TTL_MS = 1200;
const LAYOUT_SCROLL_GUARD_MS = 250;
const CONTENT_WIDTH_RESIZE_SETTLE_MS = 120;
const SCROLL_MEMORY_RESTORE_TOLERANCE_PX = 1;

function scheduleMicrotask(callback: () => void): void {
  // Some WebView/minimum DOM runtimes do not have window.queueMicrotask; scheduling capabilities should start from
  // globalThis injection, and retain the Promise microtask downgrade to avoid rolling recovery from being directly interrupted in the commit phase.
  if (typeof globalThis.queueMicrotask === "function") {
    globalThis.queueMicrotask(callback);
    return;
  }
  void Promise.resolve().then(callback);
}

function isEditableScrollTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.isContentEditable ||
    target.tagName === "INPUT" ||
    target.tagName === "TEXTAREA" ||
    target.tagName === "SELECT"
  );
}

// When the v4 timeline rewrote the scroll control, the accessible name was mistakenly made into visible text, deviating from the old version
// The circular down arrow style; here, the icon button is concentrated to avoid visual differences between the two positioning branches again.
function ConversationBackToBottomButton({
  className,
  label,
  onClick,
}: {
  className: string;
  label: string;
  onClick: () => void;
}) {
  return (
    <Button
      aria-label={label}
      title={label}
      type="button"
      size="icon"
      variant="outline"
      className={cn("rounded-full bg-card hover:bg-card-selected", className)}
      data-testid={TID_V4_TIMELINE_BOTTOM}
      onClick={() =>
        runUserAction({
          input: { featureId: "conversation.navigation", action: "jump_bottom", trigger: "button" },
          operation: onClick,
          completed: { resultSource: "local_commit" },
          failureStage: "timeline_scroll",
        })
      }
    >
      <ArrowDownIcon className="size-4" />
    </Button>
  );
}

interface ConversationScrollMemoryScopeSnapshot {
  key: string;
  state: ChatSessionScrollMemoryState;
}

type PendingScrollMemoryRestoreWait = "rows" | "content";

interface PendingScrollMemoryRestore extends ConversationScrollMemoryScopeSnapshot {
  rowWindowKey: string;
  waitFor: PendingScrollMemoryRestoreWait;
}

function resolvePendingScrollMemoryRestoreWait(
  state: ChatSessionScrollMemoryState | null,
  element: Pick<HTMLElement, "clientHeight" | "scrollHeight"> | null,
  hasRows: boolean,
): PendingScrollMemoryRestoreWait | null {
  if (!state || state.wasPinnedToBottom !== false) return null;
  if (!hasRows || !element) return "rows";

  const restoredTop = resolveChatSessionScrollRestoreTop(state, element);
  return restoredTop + SCROLL_MEMORY_RESTORE_TOLERANCE_PX < state.scrollTop ? "content" : null;
}

function canReleasePendingScrollMemoryRestore(
  pendingRestore: PendingScrollMemoryRestore,
  element: Pick<HTMLElement, "clientHeight" | "scrollHeight"> | null,
  rowCount: number,
  hasOlderRows: boolean,
  rowWindowKey: string,
): boolean {
  if (!element) return false;
  if (pendingRestore.waitFor === "rows" && rowCount === 0) return false;
  const restoredTop = resolveChatSessionScrollRestoreTop(pendingRestore.state, element);
  const targetIsRepresentable =
    restoredTop + SCROLL_MEMORY_RESTORE_TOLERANCE_PX >= pendingRestore.state.scrollTop;
  if (targetIsRepresentable || element.scrollHeight >= pendingRestore.state.scrollHeight) {
    return true;
  }
  // The first frame rows of the new lease may still have a truncated tail window; as long as earlier history can be pulled, the original
  // Restore the intention and avoid using the temporarily clamped scrollTop as the final reading anchor point.
  return rowCount > 0 && !hasOlderRows && pendingRestore.rowWindowKey !== rowWindowKey;
}

interface ConversationScrollMemoryScopeCaptureProps {
  scopeKey: string | null;
  capture: (previousKey: string | null) => ConversationScrollMemoryScopeSnapshot | null;
  commit: (snapshot: ConversationScrollMemoryScopeSnapshot | null) => void;
}

/**
 * React's before-mutation snapshot: by scope cleanup time an ordinary layout effect has already
 * seen the new DOM.
 */
class ConversationScrollMemoryScopeCapture extends Component<
  ConversationScrollMemoryScopeCaptureProps,
  unknown,
  ConversationScrollMemoryScopeSnapshot | null
> {
  getSnapshotBeforeUpdate(
    previousProps: ConversationScrollMemoryScopeCaptureProps,
  ): ConversationScrollMemoryScopeSnapshot | null {
    if (previousProps.scopeKey === this.props.scopeKey) return null;
    return this.props.capture(previousProps.scopeKey);
  }

  componentDidUpdate(
    _previousProps: ConversationScrollMemoryScopeCaptureProps,
    _previousState: unknown,
    snapshot: ConversationScrollMemoryScopeSnapshot | null,
  ): void {
    this.props.commit(snapshot);
  }

  render(): null {
    return null;
  }
}

/**
 * A vertical port of tanstack's default measurement: prefer the ResizeObserver entry (which does
 * not trigger a synchronous layout).
 */
function measureRowHeight(element: Element, entry: ResizeObserverEntry | undefined): number {
  const boxSize = entry?.borderBoxSize?.[0];
  if (boxSize) {
    return Math.round(boxSize.blockSize);
  }
  return Math.round(element.getBoundingClientRect().height);
}

function getUnitHeightCacheKey(unit: ConversationTurnRenderUnit | undefined): string | undefined {
  return unit?.key;
}

interface ConversationTimelineProps {
  rows: readonly ConversationRow[];
  /**
   * A guide waiting in the CLI-authoritative queue for model-step injection; it only changes where
   * the renderer places it.
   */
  pendingGuides?: readonly QueueItem[];
  /**
   * runtime memory state, handed only to the current live turn and never entering the historical
   * virtual list.
   */
  apiRetry?: ApiRetryState | null;
  /**
   * The projected total-order row count (rows.totalCount; after the window truncates it exceeds
   * rows.length and is used only for scrollbar estimation/diagnostics).
   */
  totalCount: number;
  /**
   * The session identity key (sessionId ?? "draft"). On a switch, scroll anchoring and the
   * measurement cache are reset — rowId repeats across sessions, so the measurement cache is
   * forbidden from mixing numbers between sessions.
   */
  sessionKey: string;
  /**
   * The renderer-local scroll memory key; null for drafts, which take part in neither saving nor
   * restoring.
   */
  scrollMemoryKey?: string | null;
  /**
   * The row render context (theme/codePreviewSettings/workspacePath); the host guarantees a stable
   * reference.
   */
  rowContext: ConversationRowRenderContext;
  onFork?: (target: ConversationRowTarget) => void;
  onRetry?: (target: ConversationRowTarget) => void;
  onFeedbackChange?: AssistantFeedbackHandler;
  onEdit?: (
    target: ConversationRowTarget,
    newText: string,
    attachments?: readonly AttachmentRef[],
    workspaceMode?: "preserve" | "rewind",
  ) => Promise<CommandAck | boolean | void> | CommandAck | boolean | void;
  /**
   * Earlier history is still available to load (the window's first row > the total order's first
   * row).
   */
  canLoadOlder?: boolean;
  /** loadOlder is in flight, suppressing duplicate triggers. */
  loadingOlder?: boolean;
  /** Fetch one earlier window of history (auto-prefetched when nearing the top). */
  onLoadOlder?: () => Promise<void> | void;
  /**
   * After the wide-screen question outline mounts, fill in the entire history of the currently
   * valid branch in one go.
   */
  onLoadAllOlder?: () => Promise<ConversationTurnNavigatorHydrationResult>;
  /**
   * The generation that invalidates the question navigation outline (store
   * turnNavigatorDirectoryRevision). After real-user queries are added or removed, the terminal
   * state must be invalidated and re-probed; the component hydration key appends this revision, so
   * interception does not persist forever within the same logEpoch.
   */
  turnNavigatorDirectoryRevision?: number;
  /**
   * Aligned with the old ChatView: the composer dock belongs to the same scroll viewport and is
   * sticky to the bottom of the scroll container.
   */
  bottomDock?: ReactNode;
  /**
   * The shared parent container holding the share selection panel; used to write the dock's real
   * position into the same coordinate system.
   */
  selectionPanelLayoutContainerRef?: { current: HTMLElement | null };
  /**
   * Lock background scrolling.
   *
   * The share selection panel only isolates the body text's pointer events with a scrim, while the
   * scroll container is still overflow-y-auto, so dragging the native scrollbar and the PageUp/Down
   * keys can still change scrollTop, and the checked target drifts below the panel.
   */
  backgroundScrollLocked?: boolean;
  /**
   * Optional content when rows is empty; a real empty session passes nothing, the draft state
   * passes the greeting.
   */
  emptyState?: ReactNode;
  /**
   * Persistent content inside the scroll container, above the message layer (the read-only block
   * imported from sharing + a divider).
   *
   * It has to be inside the container rather than a fixed banner, so that it scrolls together with
   * the live conversation; it must also render when rows is empty, which is why it falls outside
   * the emptyState branch.
   */
  headerSlot?: ReactNode;
  /**
   * In the draft state, emptyState is centered as a whole together with the same bottomDock,
   * without remounting the composer.
   */
  centerEmptyStateWithDock?: boolean;
  /**
   * Narrow-screen / coarse-pointer viewports keep the compact centered layout and do not reuse the
   * desktop draft safe spacing.
   */
  compactEmptyStateWithDock?: boolean;
  /**
   * The layout mode the right-hand status panel imposes on the message column; auto is decided by
   * the conversation container query.
   */
  summaryPanelLayout?: "none" | "auto" | "inline";
  conversationFindQuery?: string;
  conversationFindActiveIndex?: number;
  conversationFindNavigationRequestId?: number;
  onConversationFindMatchStateChange?: (state: ConversationFindMatchState) => void;
  searchResultHighlightRequest?: ChatSearchResultHighlightRequest | null;
  onSearchResultHighlightDone?: (requestId: number) => void;
  sessionPhase?: SessionPhase;
  /**
   * A one-shot "scroll to bottom" action the host can call; it holds no conversation or
   * cross-renderer state.
   */
  scrollToBottomActionRef?: { current: (() => void) | null };
  /**
   * A one-shot query locating action the host can call; it does not change the share panel's view.
   */
  scrollToQueryActionRef?: {
    current: ((target: { unitIndex: number; rowId: number }) => void) | null;
  };
  selectionActions?: {
    enabled: boolean;
    sideActionDisabled?: boolean;
    onAddToCurrentTask: (reference: ConversationSelectionReference) => void;
    onAskInSideChat: (reference: ConversationSelectionReference) => void;
  };
  /**
   * The selection state of this round during the share selection phase; passed in only by the
   * desktop share timeline.
   */
  shareSelection?: {
    eligibleRowIds: ReadonlySet<number>;
    selectedRowIds: ReadonlySet<number>;
    onToggle: (rowId: number) => void;
  };
  /**
   * When the share selection flow exists, the left rail is owned exclusively by the share panel or
   * the reopen button.
   */
  hideTurnNavigator?: boolean;
}

/**
 * The virtual scrolling timeline: dynamic measurement (ResizeObserver-driven remeasure) + bottom
 * anchoring + "back to bottom". The scroll position / follow state / measurement cache are all
 * per-component-instance state — multiple panes (same session or different sessions) are
 * independent and never interfere; the shared data subscription is handled through the
 * sessionDataLayer lease.
 *
 * React performance: rows change at high frequency (streaming delta), so all scroll-related
 * callbacks read the latest values through refs and keep stable references; the follow state lives
 * in a ref (per-frame changes do not trigger a render) and only the visibility of "back to bottom"
 * goes through state.
 */
function ConversationTimelineImpl({
  rows,
  pendingGuides = EMPTY_PENDING_GUIDES,
  apiRetry = null,
  totalCount,
  sessionKey,
  scrollMemoryKey = null,
  rowContext,
  onFork,
  onRetry,
  onFeedbackChange,
  onEdit,
  canLoadOlder = false,
  loadingOlder = false,
  onLoadOlder,
  onLoadAllOlder,
  turnNavigatorDirectoryRevision = 0,
  bottomDock,
  selectionPanelLayoutContainerRef,
  backgroundScrollLocked = false,
  emptyState,
  headerSlot,
  centerEmptyStateWithDock = false,
  compactEmptyStateWithDock = false,
  summaryPanelLayout = "none",
  conversationFindQuery = "",
  conversationFindActiveIndex = -1,
  conversationFindNavigationRequestId = 0,
  onConversationFindMatchStateChange,
  searchResultHighlightRequest,
  onSearchResultHighlightDone,
  sessionPhase,
  scrollToBottomActionRef,
  scrollToQueryActionRef,
  selectionActions,
  shareSelection,
  hideTurnNavigator = false,
}: ConversationTimelineProps) {
  const { intl } = useZCodeIntl();
  const scrollRef = useRef<HTMLDivElement>(null);
  const headerSlotRef = useRef<HTMLDivElement>(null);
  // The headerSlot height participates in the virtual window conversion (scrollMargin) and must be followed in real time as the content and width change.
  // Otherwise, after the read-only block is loaded or the window is widened and the line breaks, the virtual lines will be overall misaligned.
  //
  // The dependency must be "whether there is a slot" rather than headerSlot itself: the latter is ReactNode, and the host passes inline JSX.
  // Each render is a new object, causing the ResizeObserver to be rebuilt every frame during streaming output.
  const hasHeaderSlot = Boolean(headerSlot);
  const [headerSlotHeight, setHeaderSlotHeight] = useState(0);
  useEffect(() => {
    const element = headerSlotRef.current;
    if (!element) {
      setHeaderSlotHeight(0);
      return;
    }
    const sync = () => {
      const next = element.getBoundingClientRect().height;
      setHeaderSlotHeight((current) => (Math.abs(current - next) < 0.5 ? current : next));
    };
    sync();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(sync);
    observer.observe(element);
    return () => observer.disconnect();
  }, [hasHeaderSlot]);
  const [liveNowMs, setLiveNowMs] = useState(() => Date.now());
  const renderUnits = useMemo(
    () =>
      buildConversationTurnRenderUnits(rows, {
        nowMs: liveNowMs,
        sessionPhase,
      }),
    [liveNowMs, rows, sessionPhase],
  );
  const { virtualizedUnits, liveUnit, liveUnitIndex } = useMemo(
    () => splitConversationTimelineLiveTail(renderUnits),
    [renderUnits],
  );
  const hasRunningUnit = useMemo(() => renderUnits.some((unit) => unit.isRunning), [renderUnits]);
  const turnNavigatorQueryRowIds = useMemo(
    () =>
      new Set(
        renderUnits.flatMap((unit) =>
          unit.visibleUserInputs.filter((row) => row.origin === "realUser").map((row) => row.rowId),
        ),
      ),
    [renderUnits],
  );
  const turnNavigatorQueryRowIdsRef = useRef(turnNavigatorQueryRowIds);
  turnNavigatorQueryRowIdsRef.current = turnNavigatorQueryRowIds;
  const centeredEmptyLayout = centerEmptyStateWithDock && renderUnits.length === 0;
  const responsiveCenteredEmptyLayout = centeredEmptyLayout && !compactEmptyStateWithDock;
  // High-frequency values ​​are read through ref for stable callbacks (not dependent on arrays).
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  const unitsRef = useRef(renderUnits);
  unitsRef.current = renderUnits;
  const virtualizedUnitsRef = useRef(virtualizedUnits);
  virtualizedUnitsRef.current = virtualizedUnits;
  const liveTailRef = useRef<HTMLDivElement>(null);
  const messageLayerRef = useRef<HTMLDivElement>(null);
  const virtualHistoryRef = useRef<HTMLDivElement>(null);
  const stableContentWidthRef = useRef<number | null>(null);
  const contentWidthResizeActiveRef = useRef(false);
  const contentWidthResizeSettleTimerRef = useRef<number | null>(null);
  const isContentWidthChanging = useCallback(() => {
    const currentContentWidth = virtualHistoryRef.current?.clientWidth ?? null;
    const stableContentWidth = stableContentWidthRef.current;
    return (
      contentWidthResizeActiveRef.current ||
      (currentContentWidth !== null &&
        stableContentWidth !== null &&
        currentContentWidth !== stableContentWidth)
    );
  }, []);
  // The relevant value of loadOlder is read through ref, keeping handleScroll as a stable reference.
  const loadOlderRef = useRef({ canLoadOlder, loadingOlder, onLoadOlder });
  loadOlderRef.current = { canLoadOlder, loadingOlder, onLoadOlder };
  const followingRef = useRef(initialFollowing());
  const programmaticScrollFrameRef = useRef<number | null>(null);
  const userScrollIntentRef = useRef<{
    intent: TimelineUserScrollIntent;
    observedAt: number;
  }>({ intent: "none", observedAt: 0 });
  const touchClientYRef = useRef<number | null>(null);
  const scrollbarPointerIdRef = useRef<number | null>(null);
  const layoutScrollGuardUntilRef = useRef(0);
  const userAdjustedScrollSinceRestoreRef = useRef(false);
  const suppressVirtualizerAdjustmentDuringRestoreRef = useRef(false);
  const latestScrollMemoryStateRef = useRef<{
    key: string;
    state: ChatSessionScrollMemoryState;
  } | null>(null);
  const pendingDetachedScrollRestoreRef = useRef<PendingScrollMemoryRestore | null>(null);
  // The scrollTop of the component "Accounted" - the scroll event reads the value or the component itself
  // The readback value after programmatic writing (bottom/prepend translation). The bottom effect is used to reconcile it without observing the scrolling.
  // (Scrolling has occurred and the scroll event has not been dispatched) to prevent expiration. Following=true drags the user/test's scroll back to the bottom.
  const lastObservedScrollTopRef = useRef(0);
  // prepend anchors the baseline (the first line/total height of the previous commit), see the reconciliation effect below.
  const prependAnchorRef = useRef<{
    firstRowId: number | null;
    totalSize: number;
  }>({ firstRowId: null, totalSize: 0 });
  const pendingPrependVirtualAnchorRef = useRef<PrependVirtualAnchor | null>(null);
  const heightCacheRef = useRef<TimelineRowHeightCache | null>(null);
  if (heightCacheRef.current === null) {
    heightCacheRef.current = new TimelineRowHeightCache();
  }
  const [backToBottomVisible, setBackToBottomVisible] = useState(false);
  const [turnNavigatorViewport, setTurnNavigatorViewport] = useState({
    scrollOffsetPx: 0,
    viewportHeightPx: 0,
    activeQueryRowId: undefined as number | undefined,
  });
  const [turnNavigatorContainerWidthPx, setTurnNavigatorContainerWidthPx] = useState(0);
  const turnNavigatorJumpFrameRef = useRef<number | null>(null);
  const turnNavigatorHydrationAttemptRef = useRef<{
    attemptCount: number;
    key: string | null;
    retryTimer: number | null;
    status: "idle" | "in-flight" | "waiting" | "terminal";
  }>({ attemptCount: 0, key: null, retryTimer: null, status: "idle" });
  const [turnNavigatorHydrationRetryRevision, setTurnNavigatorHydrationRetryRevision] = useState(0);
  const timelineRootRef = useRef<HTMLDivElement>(null);
  const composerDockRef = useRef<HTMLDivElement>(null);
  const shareSelectionPanelLayoutRef = useRef<{
    centerYPx: number;
    maxHeightPx: number;
  } | null>(null);
  // When the right status panel is fully expanded inline, the middle message column and input dock must use the same offset;
  // Otherwise the panels will cover the text instead of being laid out side by side.
  const summaryPanelInlineOffsetClassName =
    getConversationStatusPanelOffsetClassName(summaryPanelLayout);
  const contentWidthClassName = getConversationContentWidthClassName({
    centeredEmptyLayout,
    statusPanelLayout: summaryPanelLayout,
  });

  const syncShareSelectionPanelLayout = useCallback(() => {
    if (!backgroundScrollLocked) return;
    const container = selectionPanelLayoutContainerRef?.current;
    const dock = composerDockRef.current;
    if (!container || !dock) return;

    // The selection panel is a sibling node of SessionPane, and CSS variables cannot be written in Timeline.
    // itself, otherwise the panel cannot get the real boundary of the dock; it is uniformly written to the shared parent container for use by both.
    const layout = syncConversationShareSelectionPanelLayout(container, dock);
    const previous = shareSelectionPanelLayoutRef.current;
    if (previous?.centerYPx === layout.centerYPx && previous.maxHeightPx === layout.maxHeightPx) {
      return;
    }
    shareSelectionPanelLayoutRef.current = layout;
  }, [backgroundScrollLocked, selectionPanelLayoutContainerRef]);

  useLayoutEffect(() => {
    if (!backgroundScrollLocked) return;
    const container = selectionPanelLayoutContainerRef?.current;
    const dock = composerDockRef.current;
    if (!container || !dock) return;

    syncShareSelectionPanelLayout();
    let resizeObserver: ResizeObserver | null = null;
    if (typeof ResizeObserver !== "undefined") {
      resizeObserver = new ResizeObserver(syncShareSelectionPanelLayout);
      resizeObserver.observe(container);
      resizeObserver.observe(timelineRootRef.current ?? container);
      if (scrollRef.current) resizeObserver.observe(scrollRef.current);
      resizeObserver.observe(dock);
    }

    // ResizeObserver may call back later than the window size change in some Electron flex layouts.
    // Therefore, window resize always triggers a geometry synchronization to ensure that the panel expands/shrinks with the window.
    window.addEventListener("resize", syncShareSelectionPanelLayout);
    return () => {
      window.removeEventListener("resize", syncShareSelectionPanelLayout);
      resizeObserver?.disconnect();
    };
  }, [backgroundScrollLocked, selectionPanelLayoutContainerRef, syncShareSelectionPanelLayout]);

  useEffect(() => {
    if (!hasRunningUnit) {
      return;
    }

    // The status copy of the running assistant work should display "Working for N seconds" and advance with time;
    // The completion time is fixed by the protocol fact, and the builder will refuse to use this UI clock for the completed round.
    setLiveNowMs(Date.now());
    const timer = window.setInterval(() => {
      setLiveNowMs(Date.now());
    }, RUNNING_WORK_DURATION_TICK_MS);

    return () => window.clearInterval(timer);
  }, [hasRunningUnit]);

  useLayoutEffect(() => {
    const element = timelineRootRef.current;
    if (!element) return;

    // After the rail was changed to be hidden by CSS container query, the complete history supplement lost the same width.
    // Qualification boundaries, mobile phone remote control and narrow split screen will also request all rows. Only read-only paging qualifications are synchronized here;
    // The visibility, placement, and transition of rails are still entirely determined by CSS and do not restore composer geometry measurements.
    const commitWidth = (width: number) => {
      const normalizedWidth = Math.max(0, Math.round(width));
      setTurnNavigatorContainerWidthPx((current) =>
        current === normalizedWidth ? current : normalizedWidth,
      );
    };
    const readWidth = () => commitWidth(element.clientWidth);
    readWidth();

    if (typeof ResizeObserver !== "undefined") {
      const observer = new ResizeObserver((entries) => {
        const entry = entries[0];
        const borderBox = entry?.borderBoxSize?.[0];
        commitWidth(borderBox?.inlineSize ?? entry?.contentRect.width ?? element.clientWidth);
      });
      observer.observe(element);
      return () => observer.disconnect();
    }

    window.addEventListener("resize", readWidth);
    return () => window.removeEventListener("resize", readWidth);
  }, []);

  useEffect(() => {
    if (
      !shouldHydrateConversationTurnNavigatorDirectory({
        canLoadOlder,
        containerWidthPx: turnNavigatorContainerWidthPx,
        hasLoadHandler: Boolean(onLoadAllOlder),
        loadingOlder,
      })
    ) {
      return;
    }
    // The terminal key must be synchronized with store turnNavigatorDirectoryRevision.
    // When using sessionKey + logEpoch only, real-user query will not change epoch when adding or deleting it.
    // The component layer terminal is permanently intercepted, and the store cannot be re-detected even if the cache is invalidated.
    const hydrationKey = `${sessionKey}:${rowContext.logEpoch ?? "unknown"}:${turnNavigatorDirectoryRevision}`;
    const attempt = turnNavigatorHydrationAttemptRef.current;
    if (attempt.key !== hydrationKey) {
      if (attempt.retryTimer !== null) window.clearTimeout(attempt.retryTimer);
      Object.assign(attempt, {
        attemptCount: 0,
        key: hydrationKey,
        retryTimer: null,
        status: "idle" as const,
      });
    }
    if (attempt.status !== "idle" || !onLoadAllOlder) return;
    attempt.status = "in-flight";
    logger.debug("[v4-turn-navigator] toc request hydrating full history", {
      attempt: attempt.attemptCount + 1,
      loadedRows: rows.length,
      sessionKey,
      totalRows: totalCount,
    });
    void onLoadAllOlder().then((result) => {
      if (attempt.key !== hydrationKey) return;
      if (result.status === "hydrated" || result.status === "not-enough-queries") {
        attempt.status = "terminal";
        return;
      }
      if (result.status === "stale") {
        attempt.status = "idle";
        return;
      }
      attempt.attemptCount += 1;
      const retryDelayMs = resolveConversationTurnNavigatorHydrationRetryDelayMs(
        attempt.attemptCount,
      );
      if (retryDelayMs === null) {
        attempt.status = "terminal";
        return;
      }
      attempt.status = "waiting";
      attempt.retryTimer = window.setTimeout(() => {
        if (attempt.key !== hydrationKey) return;
        attempt.retryTimer = null;
        attempt.status = "idle";
        setTurnNavigatorHydrationRetryRevision((revision) => revision + 1);
      }, retryDelayMs);
    });
  }, [
    canLoadOlder,
    loadingOlder,
    onLoadAllOlder,
    rowContext.logEpoch,
    rows,
    sessionKey,
    totalCount,
    turnNavigatorContainerWidthPx,
    turnNavigatorDirectoryRevision,
    turnNavigatorHydrationRetryRevision,
  ]);

  useEffect(
    () => () => {
      const timer = turnNavigatorHydrationAttemptRef.current.retryTimer;
      if (timer !== null) window.clearTimeout(timer);
    },
    [],
  );

  const getScrollElement = useCallback(() => scrollRef.current, []);
  const getItemKey = useCallback(
    (index: number) => virtualizedUnitsRef.current[index]?.key ?? index,
    [],
  );
  // Altimeter caching: Use the last real measurement instead of a fixed estimate when unloading and remounting (or even rebuilding the virtualizer).
  const estimateSize = useCallback(
    (index: number) =>
      heightCacheRef.current?.estimate(
        getUnitHeightCacheKey(virtualizedUnitsRef.current[index]),
        DEFAULT_ROW_HEIGHT_ESTIMATE_PX,
      ) ?? DEFAULT_ROW_HEIGHT_ESTIMATE_PX,
    [],
  );
  // Dynamic height measurement: The virtualizer attaches ResizeObserver to the elements in the window, and the streaming line height is called back here;
  // At the same time, the real height is written to the stable turnId cache.
  const measureElement = useCallback((element: Element, entry: ResizeObserverEntry | undefined) => {
    const height = measureRowHeight(element, entry);
    const indexAttr = element.getAttribute("data-index");
    const unit = indexAttr === null ? undefined : virtualizedUnitsRef.current[Number(indexAttr)];
    const cacheKey = getUnitHeightCacheKey(unit);
    if (cacheKey !== undefined) {
      heightCacheRef.current?.set(cacheKey, height);
    }
    return height;
  }, []);

  const virtualizer = useVirtualizer({
    count: virtualizedUnits.length,
    getScrollElement,
    estimateSize,
    overscan: ROW_OVERSCAN,
    getItemKey,
    measureElement,
    // headerSlot (shares the imported read-only block) and the virtual list are in the same scroll container,
    // And the height is impressive. Without telling this offset, the virtual window will directly index the item according to scrollTop.
    // The entire rendering window is offset by a header height, and the area the user scrolls to will be blank.
    scrollMargin: headerSlotHeight,
  });
  virtualizer.shouldAdjustScrollPositionOnItemSizeChange = (item) => {
    return shouldAdjustVirtualizerForItemSizeChange({
      suppressAdjustment: suppressVirtualizerAdjustmentDuringRestoreRef.current,
      following: followingRef.current,
      contentWidthChanging: isContentWidthChanging(),
      itemEnd: item.end,
      scrollTop: scrollRef.current?.scrollTop ?? 0,
    });
  };
  const virtualRows = virtualizer.getVirtualItems();
  const totalSize = virtualizer.getTotalSize();
  const turnNavigatorVirtualItems: ConversationTurnNavigatorVirtualItem[] = useMemo(() => {
    const historyItems = virtualRows.map((row) => ({
      index: row.index,
      size: row.size,
      start: row.start,
    }));
    if (liveUnitIndex === null) return historyItems;
    return [
      ...historyItems,
      {
        index: liveUnitIndex,
        start: totalSize,
        // Live tail does not participate in virtualizer height measurement; covering the remaining scroll area can be used by the directory to determine the current round.
        size: Number.MAX_SAFE_INTEGER - totalSize,
      },
    ];
  }, [liveUnitIndex, totalSize, virtualRows]);
  const mountedRowsKey = useMemo(
    () =>
      [
        ...virtualRows.map((row) => String(row.key)),
        ...(liveUnit === null ? [] : [String(liveUnit.key)]),
      ].join(":"),
    [liveUnit, virtualRows],
  );

  const markProgrammaticScroll = useCallback(() => {
    if (programmaticScrollFrameRef.current !== null) {
      window.cancelAnimationFrame(programmaticScrollFrameRef.current);
    }
    programmaticScrollFrameRef.current = window.requestAnimationFrame(() => {
      programmaticScrollFrameRef.current = null;
    });
  }, []);

  const commitFollowing = useCallback((following: boolean) => {
    if (followingRef.current === following) return;
    followingRef.current = following;
    setBackToBottomVisible(shouldShowBackToBottom(following, unitsRef.current.length));
  }, []);

  const clearUserScrollIntent = useCallback(() => {
    userScrollIntentRef.current = { intent: "none", observedAt: 0 };
    touchClientYRef.current = null;
    scrollbarPointerIdRef.current = null;
  }, []);

  const getActiveUserScrollIntent = useCallback((): TimelineUserScrollIntent => {
    const current = userScrollIntentRef.current;
    const interactionActive =
      touchClientYRef.current !== null || scrollbarPointerIdRef.current !== null;
    if (interactionActive) {
      return current.intent === "none" ? "unknown" : current.intent;
    }
    return Date.now() - current.observedAt <= USER_SCROLL_INTENT_TTL_MS ? current.intent : "none";
  }, []);

  const markLayoutScrollGuard = useCallback(() => {
    layoutScrollGuardUntilRef.current = Date.now() + LAYOUT_SCROLL_GUARD_MS;
  }, []);

  const markUserScrollIntent = useCallback(
    (intent: TimelineUserScrollIntent) => {
      if (intent === "none") return;
      userScrollIntentRef.current = { intent, observedAt: Date.now() };
      const element = scrollRef.current;
      // running -> terminal will migrate live tail, collapse work history and trigger in the same frame
      // virtualizer height measurement. To scroll upward, the scrolling right must be taken away before the scroll event, otherwise the final state
      // The layout effect will take the expired following=true and drag the user to the bottom again.
      if (intent === "awayFromBottom" && element && element.scrollHeight > element.clientHeight) {
        commitFollowing(false);
      }
    },
    [commitFollowing],
  );

  const handleWheelCapture = useCallback(
    (event: ReactWheelEvent<HTMLDivElement>) => {
      markUserScrollIntent(timelineWheelScrollIntent(event.deltaY));
    },
    [markUserScrollIntent],
  );

  const handleTouchStartCapture = useCallback((event: ReactTouchEvent<HTMLDivElement>) => {
    touchClientYRef.current = event.touches[0]?.clientY ?? null;
  }, []);

  const handleTouchMoveCapture = useCallback(
    (event: ReactTouchEvent<HTMLDivElement>) => {
      const nextClientY = event.touches[0]?.clientY;
      const previousClientY = touchClientYRef.current;
      if (nextClientY === undefined || previousClientY === null) return;
      markUserScrollIntent(timelineTouchScrollIntent(previousClientY, nextClientY));
      touchClientYRef.current = nextClientY;
    },
    [markUserScrollIntent],
  );

  const handleTouchEndCapture = useCallback(() => {
    touchClientYRef.current = null;
  }, []);

  const handleKeyDownCapture = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      markUserScrollIntent(
        timelineKeyboardScrollIntent({
          key: event.key,
          shiftKey: event.shiftKey,
          editableTarget: isEditableScrollTarget(event.target),
        }),
      );
    },
    [markUserScrollIntent],
  );

  const handlePointerDownCapture = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      // Content area clicks (esp. sent by composer) are not scroll intent; only scrollbar/whitespace hits
      // The unknown direction is registered only when the scroll container itself is located, and is then determined by the actual scroll landing point.
      if (event.target !== event.currentTarget) return;
      scrollbarPointerIdRef.current = event.pointerId;
      markUserScrollIntent("unknown");
    },
    [markUserScrollIntent],
  );

  const handlePointerEndCapture = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (scrollbarPointerIdRef.current === event.pointerId) {
      scrollbarPointerIdRef.current = null;
    }
  }, []);

  const syncMessageLayerMask = useCallback((element: HTMLDivElement) => {
    const messageLayer = messageLayerRef.current;
    if (!messageLayer) return;

    if (
      isAtBottom({
        scrollTop: element.scrollTop,
        viewportHeight: element.clientHeight,
        contentHeight: element.scrollHeight,
      })
    ) {
      // When sticking to the bottom, the message is already at the end of the normal document flow and will not go through sticky composer;
      // Continuing to leave the mask on will pointlessly fade out the last message, and the mask is only needed for off-bottom scrolling.
      messageLayer.style.maskImage = "none";
      messageLayer.style.webkitMaskImage = "none";
      return;
    }

    const viewportHeight = element.clientHeight;
    const transparentStart = Math.max(
      0,
      viewportHeight - COMPOSER_MESSAGE_MASK_TRANSPARENT_HEIGHT_PX,
    );
    const opaqueEnd = Math.max(0, transparentStart - COMPOSER_MESSAGE_MASK_FADE_PX);
    const viewportTopInLayer = Math.max(0, element.scrollTop - messageLayer.offsetTop);
    const maskImage = `linear-gradient(to bottom, black 0, black ${opaqueEnd}px, transparent ${transparentStart}px, transparent 100%)`;

    // The transparent padding of the dock can retain the split-screen focus ring, but the message will show through the blank space;
    // The mask must be aligned with the scroll viewport and only clip the message layer, not the sticky composer and buttons.
    messageLayer.style.maskImage = maskImage;
    messageLayer.style.webkitMaskImage = maskImage;
    messageLayer.style.maskPosition = `0 ${viewportTopInLayer}px`;
    messageLayer.style.webkitMaskPosition = `0 ${viewportTopInLayer}px`;
    messageLayer.style.maskSize = `100% ${viewportHeight}px`;
    messageLayer.style.webkitMaskSize = `100% ${viewportHeight}px`;
  }, []);

  const syncTurnNavigatorViewport = useCallback(
    (element: HTMLDivElement) => {
      syncMessageLayerMask(element);
      const viewportRect = element.getBoundingClientRect();
      const queryPositions: ConversationTurnNavigatorQueryPosition[] = [];
      for (const rowElement of element.querySelectorAll<HTMLElement>("[data-row-id]")) {
        const rowId = Number(rowElement.dataset.rowId);
        if (!Number.isSafeInteger(rowId) || !turnNavigatorQueryRowIdsRef.current.has(rowId)) {
          continue;
        }
        const rowRect = rowElement.getBoundingClientRect();
        const start = element.scrollTop + rowRect.top - viewportRect.top;
        queryPositions.push({ rowId, start, end: start + rowRect.height });
      }
      const nextViewport = {
        scrollOffsetPx: element.scrollTop,
        viewportHeightPx: element.clientHeight,
        // Turn-level active can only hit the first query with the same turn. Mounted from here
        // The stable row anchor deduces the current query; when the virtual turn has not been mounted, the component will fall back to unit.
        activeQueryRowId: resolveConversationTurnNavigatorActiveQueryRowId({
          positions: queryPositions,
          scrollOffsetPx: element.scrollTop,
          viewportHeightPx: element.clientHeight,
        }),
      };
      setTurnNavigatorViewport((current) =>
        current.scrollOffsetPx === nextViewport.scrollOffsetPx &&
        current.viewportHeightPx === nextViewport.viewportHeightPx &&
        current.activeQueryRowId === nextViewport.activeQueryRowId
          ? current
          : nextViewport,
      );
    },
    [syncMessageLayerMask],
  );

  useLayoutEffect(() => {
    const scrollElement = scrollRef.current;
    const messageLayer = messageLayerRef.current;
    if (!scrollElement || !messageLayer) return;

    const sync = () => syncMessageLayerMask(scrollElement);
    sync();
    if (typeof ResizeObserver !== "undefined") {
      const observer = new ResizeObserver(sync);
      observer.observe(scrollElement);
      observer.observe(messageLayer);
      return () => observer.disconnect();
    }

    window.addEventListener("resize", sync);
    return () => window.removeEventListener("resize", sync);
  }, [syncMessageLayerMask, renderUnits.length === 0]);

  const buildCurrentScrollMemoryState = useCallback(
    (element: HTMLDivElement): ChatSessionScrollMemoryState => {
      const metrics = {
        scrollTop: element.scrollTop,
        viewportHeight: element.clientHeight,
        contentHeight: element.scrollHeight,
      };
      const wasPinnedToBottom = reconcileFollowingForContentAnchor({
        following: followingRef.current,
        metrics,
        lastObservedScrollTop: lastObservedScrollTopRef.current,
      });
      return {
        scrollTop: element.scrollTop,
        scrollHeight: element.scrollHeight,
        clientHeight: element.clientHeight,
        wasPinnedToBottom,
        updatedAt: Date.now(),
      };
    },
    [],
  );

  const cacheCurrentScrollMemoryState = useCallback(
    (element: HTMLDivElement): ChatSessionScrollMemoryState => {
      const state = buildCurrentScrollMemoryState(element);
      if (scrollMemoryKey) {
        latestScrollMemoryStateRef.current = { key: scrollMemoryKey, state };
      }
      return state;
    },
    [buildCurrentScrollMemoryState, scrollMemoryKey],
  );

  const notifyScrollObserversAfterCommit = useCallback((element: HTMLDivElement) => {
    scheduleMicrotask(() => {
      if (scrollRef.current !== element) return;
      element.dispatchEvent(new Event("scroll"));
    });
  }, []);

  const captureScrollMemoryBeforeScopeMutation = useCallback(
    (previousKey: string | null): ConversationScrollMemoryScopeSnapshot | null => {
      const pendingRestore = pendingDetachedScrollRestoreRef.current;
      if (pendingRestore?.key === previousKey) {
        // When the session data has not yet arrived, the DOM can only read the clamped scrollTop=0; switch at this time
        // The task cannot overwrite the original memory with an empty timeline, and must retain the detached recovery intention that has not yet been implemented.
        return pendingRestore;
      }
      const element = scrollRef.current;
      if (!previousKey || !element) return null;
      return {
        key: previousKey,
        state: buildCurrentScrollMemoryState(element),
      };
    },
    [buildCurrentScrollMemoryState],
  );

  const commitCapturedScrollMemory = useCallback(
    (snapshot: ConversationScrollMemoryScopeSnapshot | null) => {
      if (!snapshot) return;
      latestScrollMemoryStateRef.current = snapshot;
      saveChatSessionScrollMemoryState(snapshot.key, snapshot.state);
    },
    [],
  );

  // The bottom must be instant (scrollTop assignment): the smooth intermediate frame will be misinterpreted as "off the bottom" by scroll judgment.
  const scrollToBottom = useCallback(() => {
    const element = scrollRef.current;
    if (!element) return;
    markProgrammaticScroll();
    // Safe centering of drafts allows content to overflow downwards at low heights; if real conversation bottoming is used,
    // The top safety margin will roll away. Drafts always show the top, real sessions continue to show the bottom.
    element.scrollTop = responsiveCenteredEmptyLayout ? 0 : element.scrollHeight;
    // Read back the clamped landing point and record it (the browser will clamp the assignment to the maximum scrollable distance).
    lastObservedScrollTopRef.current = element.scrollTop;
    syncTurnNavigatorViewport(element);
    userAdjustedScrollSinceRestoreRef.current = false;
    cacheCurrentScrollMemoryState(element);
    notifyScrollObserversAfterCommit(element);
  }, [
    cacheCurrentScrollMemoryState,
    responsiveCenteredEmptyLayout,
    markProgrammaticScroll,
    notifyScrollObserversAfterCommit,
    syncTurnNavigatorViewport,
  ]);

  useLayoutEffect(() => {
    const contentColumn = virtualHistoryRef.current;
    if (!contentColumn || typeof ResizeObserver === "undefined") return;

    stableContentWidthRef.current = contentColumn.clientWidth;
    const observer = new ResizeObserver(() => {
      const nextWidth = contentColumn.clientWidth;
      if (nextWidth === stableContentWidthRef.current) return;

      // Width changes will cause the virtual rows to be re-measured in batches; either row-by-row compensation or batch-by-batch tracing will result.
      // Continuously rewrite scrollTop. Both are paused during resize, and only executed once for final bottoming after stabilization.
      contentWidthResizeActiveRef.current = true;
      if (contentWidthResizeSettleTimerRef.current !== null) {
        window.clearTimeout(contentWidthResizeSettleTimerRef.current);
      }
      contentWidthResizeSettleTimerRef.current = window.setTimeout(() => {
        stableContentWidthRef.current = contentColumn.clientWidth;
        contentWidthResizeActiveRef.current = false;
        contentWidthResizeSettleTimerRef.current = null;
        if (followingRef.current) {
          scrollToBottom();
        }
      }, CONTENT_WIDTH_RESIZE_SETTLE_MS);
    });
    observer.observe(contentColumn);

    return () => {
      observer.disconnect();
      if (contentWidthResizeSettleTimerRef.current !== null) {
        window.clearTimeout(contentWidthResizeSettleTimerRef.current);
        contentWidthResizeSettleTimerRef.current = null;
      }
      contentWidthResizeActiveRef.current = false;
    };
  }, [renderUnits.length === 0, scrollToBottom]);

  useLayoutEffect(() => {
    const element = liveTailRef.current;
    const cacheKey = getUnitHeightCacheKey(liveUnit ?? undefined);
    if (!element || cacheKey === undefined) return;

    const cacheHeight = (entry?: ResizeObserverEntry) => {
      const height = measureRowHeight(element, entry);
      heightCacheRef.current?.set(cacheKey, height);
      return height;
    };
    let observedHeight = cacheHeight();
    if (typeof ResizeObserver === "undefined") return;

    // The parent layout effect of the projection revision may be earlier than the final height of the Markdown subtree;
    // The old observer only caches the height. The text will push the loading slot down first, and then the scrollTop will be added in subsequent commits.
    // ResizeObserver gets the real height before drawing, and only absorbs the bottom synchronously when it still has the following scrolling rights;
    // If the user has scrolled up (including the scroll event that has not yet been recorded), it will only be cached and the reading position will not be regained.
    const observer = new ResizeObserver((entries) => {
      const nextHeight = cacheHeight(entries[0]);
      if (nextHeight === observedHeight) return;
      observedHeight = nextHeight;

      const scrollElement = scrollRef.current;
      if (!scrollElement) return;
      markLayoutScrollGuard();
      const following = reconcileFollowingForContentAnchor({
        following: followingRef.current,
        metrics: {
          scrollTop: scrollElement.scrollTop,
          viewportHeight: scrollElement.clientHeight,
          contentHeight: scrollElement.scrollHeight,
        },
        lastObservedScrollTop: lastObservedScrollTopRef.current,
        userScrollIntent: getActiveUserScrollIntent(),
      });
      commitFollowing(following);
      if (anchorActionAfterContentChange(following, isContentWidthChanging()) === "stickToBottom") {
        scrollToBottom();
      }
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [
    commitFollowing,
    getActiveUserScrollIntent,
    isContentWidthChanging,
    liveUnit?.key,
    markLayoutScrollGuard,
    scrollToBottom,
  ]);

  const saveCurrentScrollMemory = useCallback(() => {
    const key = scrollMemoryKey;
    const element = scrollRef.current;
    if (!key) return;
    const pendingRestore = pendingDetachedScrollRestoreRef.current;
    const cached = latestScrollMemoryStateRef.current;
    const cachedState = cached?.key === key ? cached.state : null;
    const state =
      pendingRestore?.key === key
        ? pendingRestore.state
        : element
          ? cacheCurrentScrollMemoryState(element)
          : cachedState;
    if (state) saveChatSessionScrollMemoryState(key, state);
  }, [cacheCurrentScrollMemoryState, scrollMemoryKey]);

  const restoreScrollMemory = useCallback(
    (state: ChatSessionScrollMemoryState) => {
      const element = scrollRef.current;
      if (!element) return;
      clearUserScrollIntent();
      markProgrammaticScroll();
      element.scrollTop = resolveChatSessionScrollRestoreTop(state, element);
      lastObservedScrollTopRef.current = element.scrollTop;
      followingRef.current = false;
      setBackToBottomVisible(shouldShowBackToBottom(false, unitsRef.current.length));
      syncTurnNavigatorViewport(element);
      userAdjustedScrollSinceRestoreRef.current = false;
      cacheCurrentScrollMemoryState(element);
    },
    [
      cacheCurrentScrollMemoryState,
      clearUserScrollIntent,
      markProgrammaticScroll,
      syncTurnNavigatorViewport,
    ],
  );

  const handleScroll = useCallback(() => {
    const element = scrollRef.current;
    if (!element) return;
    const programmaticScroll =
      programmaticScrollFrameRef.current !== null &&
      Math.abs(element.scrollTop - lastObservedScrollTopRef.current) < 1;
    const userScrollIntent = getActiveUserScrollIntent();
    // User input takes priority; if other scrolls fall within the content/height measurement guard, they will be considered layout compensation, and those outside the guard will be considered as layout compensation.
    // Uncategorized events continue to be handled as real user scrolling, compatible with native scroll bars and assistive technologies.
    const scrollSource =
      userScrollIntent !== "none"
        ? "user"
        : programmaticScroll
          ? "programmatic"
          : Date.now() <= layoutScrollGuardUntilRef.current
            ? "layout"
            : "user";
    // Virtualizer's native offset observer will be credited before React onScroll; you can confirm it here
    // The restored true scrollTop has been seen. User scrolling should also end the protection window immediately and return scrolling rights to the user.
    if (scrollSource !== "layout") {
      suppressVirtualizerAdjustmentDuringRestoreRef.current = false;
    }
    lastObservedScrollTopRef.current = element.scrollTop;
    syncTurnNavigatorViewport(element);
    const following = resolveFollowingAfterScroll({
      following: followingRef.current,
      source: scrollSource,
      metrics: {
        scrollTop: element.scrollTop,
        viewportHeight: element.clientHeight,
        contentHeight: element.scrollHeight,
      },
    });
    commitFollowing(following);
    if (scrollSource === "user") {
      pendingDetachedScrollRestoreRef.current = null;
      userAdjustedScrollSinceRestoreRef.current = true;
      saveCurrentScrollMemory();
    }
    // When the page is added only at the top edge of 64px, the user will hit the window boundary first and then see the content jump in; two
    // Viewport prefetching allows the renderer shared by desktop and mobile web to complete page filling before the user reaches the boundary.
    const loadOlder = loadOlderRef.current;
    const triggerPx = historyPrefetchTriggerPx(element.clientHeight);
    if (
      shouldTriggerLoadOlder({
        scrollTop: element.scrollTop,
        canLoadOlder: loadOlder.canLoadOlder,
        loadingOlder: loadOlder.loadingOlder,
        triggerPx,
      })
    ) {
      // After the forward insertion exceeds the viewport + overscan, the old visible turn will be unloaded, and the DOM cannot be used as a cross-over
      // Commit anchor point; here saves the measurement starting point maintained by the virtualizer according to the stable turn key.
      const anchorMeasurement = virtualizer.getVirtualItemForOffset(element.scrollTop);
      const anchorUnit = anchorMeasurement
        ? virtualizedUnitsRef.current[anchorMeasurement.index]
        : undefined;
      pendingPrependVirtualAnchorRef.current =
        anchorMeasurement && anchorUnit?.key === anchorMeasurement.key
          ? {
              key: anchorUnit.key,
              offsetTop: anchorMeasurement.start - element.scrollTop,
              start: anchorMeasurement.start,
            }
          : null;
      logger.debug("[v4-timeline] near the top of the history window, prefetching older rows", {
        scrollTop: element.scrollTop,
        triggerPx,
      });
      loadOlder.onLoadOlder?.();
    }
  }, [
    commitFollowing,
    getActiveUserScrollIntent,
    saveCurrentScrollMemory,
    syncTurnNavigatorViewport,
    virtualizer,
  ]);

  const handleBackToBottom = useCallback(() => {
    pendingDetachedScrollRestoreRef.current = null;
    clearUserScrollIntent();
    commitFollowing(true);
    scrollToBottom();
    // scrollToBottom only updates the ref within the component; if the user clicks and immediately switches to the task, the scope
    // The cleanup/scroll event may not have run yet, and the old Map will bring the next recovery back to the middle or even the top.
    saveCurrentScrollMemory();
  }, [clearUserScrollIntent, commitFollowing, saveCurrentScrollMemory, scrollToBottom]);

  useLayoutEffect(() => {
    if (!scrollToBottomActionRef) return;
    scrollToBottomActionRef.current = handleBackToBottom;
    return () => {
      // Only clean up the actions registered by this instance to prevent the old cleanup from overwriting the new timeline when cutting pane.
      if (scrollToBottomActionRef.current === handleBackToBottom) {
        scrollToBottomActionRef.current = null;
      }
    };
  }, [handleBackToBottom, scrollToBottomActionRef]);

  const scrollToQuery = useCallback(
    (target: { unitIndex: number; rowId: number }, behavior: ScrollBehavior = "auto") => {
      clearUserScrollIntent();
      commitFollowing(false);
      if (turnNavigatorJumpFrameRef.current !== null) {
        window.cancelAnimationFrame(turnNavigatorJumpFrameRef.current);
        turnNavigatorJumpFrameRef.current = null;
      }

      const scrollMountedQuery = (element: HTMLDivElement): boolean => {
        const rowElement = element.querySelector<HTMLElement>(`[data-row-id="${target.rowId}"]`);
        if (!rowElement) return false;
        const targetTop =
          element.scrollTop +
          rowElement.getBoundingClientRect().top -
          element.getBoundingClientRect().top;
        if (behavior === "auto") {
          element.scrollTop = targetTop;
        } else {
          element.scrollTo({ top: targetTop, behavior });
        }
        lastObservedScrollTopRef.current = element.scrollTop;
        syncTurnNavigatorViewport(element);
        logger.debug("[v4-turn-navigator] navigating to user query", {
          behavior,
          rowId: target.rowId,
          unitIndex: target.unitIndex,
        });
        return true;
      };

      const element = scrollRef.current;
      if (!element || scrollMountedQuery(element)) return;

      // product turn is the smallest mounting unit of the virtual list, and steward query is the anchor point within the unit. When the target is not mounted
      // First, mount the corresponding turn without animation, and then scroll to the row exactly according to the user's motion preference. You cannot return to the beginning of the turn.
      if (target.unitIndex === liveUnitIndex) {
        const liveTail = liveTailRef.current;
        if (liveTail) {
          element.scrollTop =
            element.scrollTop +
            liveTail.getBoundingClientRect().top -
            element.getBoundingClientRect().top;
        }
      } else {
        virtualizer.scrollToIndex(target.unitIndex, {
          align: "start",
          behavior: "auto",
        });
      }

      let remainingAttempts = 12;
      const alignMountedQuery = () => {
        turnNavigatorJumpFrameRef.current = null;
        const currentElement = scrollRef.current;
        if (currentElement && scrollMountedQuery(currentElement)) return;
        remainingAttempts -= 1;
        if (remainingAttempts <= 0) {
          logger.warn("[v4-turn-navigator] timed out waiting for the query anchor to mount", {
            rowId: target.rowId,
            unitIndex: target.unitIndex,
          });
          return;
        }
        turnNavigatorJumpFrameRef.current = window.requestAnimationFrame(alignMountedQuery);
      };
      turnNavigatorJumpFrameRef.current = window.requestAnimationFrame(alignMountedQuery);
    },
    [clearUserScrollIntent, commitFollowing, liveUnitIndex, syncTurnNavigatorViewport, virtualizer],
  );

  useLayoutEffect(() => {
    if (!scrollToQueryActionRef) return;
    const action = (target: { unitIndex: number; rowId: number }) => {
      scrollToQuery(target);
    };
    scrollToQueryActionRef.current = action;
    return () => {
      if (scrollToQueryActionRef.current === action) {
        scrollToQueryActionRef.current = null;
      }
    };
  }, [scrollToQuery, scrollToQueryActionRef]);

  useEffect(
    () => () => {
      if (turnNavigatorJumpFrameRef.current !== null) {
        window.cancelAnimationFrame(turnNavigatorJumpFrameRef.current);
        turnNavigatorJumpFrameRef.current = null;
      }
    },
    [sessionKey],
  );

  const scrollToUnit = useCallback(
    (unitIndex: number, behavior: ScrollBehavior = "auto") => {
      clearUserScrollIntent();
      commitFollowing(false);
      if (unitIndex === liveUnitIndex) {
        const element = scrollRef.current;
        const liveTail = liveTailRef.current;
        if (!element || !liveTail) return;
        const targetTop =
          element.scrollTop +
          liveTail.getBoundingClientRect().top -
          element.getBoundingClientRect().top;
        if (behavior === "auto") {
          element.scrollTop = targetTop;
        } else {
          element.scrollTo({ top: targetTop, behavior });
        }
        lastObservedScrollTopRef.current = element.scrollTop;
        syncTurnNavigatorViewport(element);
        return;
      }
      virtualizer.scrollToIndex(unitIndex, { align: "start", behavior });
    },
    [clearUserScrollIntent, commitFollowing, liveUnitIndex, syncTurnNavigatorViewport, virtualizer],
  );

  useConversationTimelineFind({
    rootRef: scrollRef,
    renderUnits,
    rows,
    mountedRowsKey,
    canLoadOlder,
    loadingOlder,
    onLoadOlder,
    sessionPhase,
    conversationFindQuery,
    conversationFindActiveIndex,
    conversationFindNavigationRequestId,
    onConversationFindMatchStateChange,
    searchResultHighlightRequest,
    onSearchResultHighlightDone,
    scrollToUnit,
  });

  const saveCurrentScrollMemoryRef = useRef(saveCurrentScrollMemory);
  saveCurrentScrollMemoryRef.current = saveCurrentScrollMemory;

  useLayoutEffect(() => {
    return () => {
      // When it is actually uninstalled, the DOM is still there; when the scope is updated, the old DOM is read by before-mutation capture.
      saveCurrentScrollMemoryRef.current();
    };
  }, []);

  const rowCount = renderUnits.length;
  const rowWindowKey = `${rows.length}:${rows[0]?.rowId ?? "none"}:${rows[rows.length - 1]?.rowId ?? "none"}`;
  const pendingGuideKey = pendingGuides.map((item) => item.queueItemId).join(":");

  // After V4 migration deletes the old ChatView scroll hook, the sessionKey effect is still fixed to scroll to the bottom.
  // As a result, the remaining renderer-local memory module is completely disconnected. Here, after clearing the height measurement and re-measure, press scope
  // Restore; the first layout is immediately written to prevent flickering, and the asynchronous height measurement is corrected in the next frame, but the scrolling rights must be given to the user.
  useLayoutEffect(() => {
    clearUserScrollIntent();
    heightCacheRef.current?.clear();
    // The prepend anchor baseline is reset together: rowId can be repeated across sessions, and comparison with the first row of the old session is prohibited.
    prependAnchorRef.current = { firstRowId: null, totalSize: 0 };
    pendingPrependVirtualAnchorRef.current = null;
    // By default, draft will leave the old virtualizer.scrollOffset; before resuming writing and dispatching scroll events,
    // If the height measurement continues to be calibrated according to the old offset, the newly restored historical position will be pushed back to the draft landing point.
    suppressVirtualizerAdjustmentDuringRestoreRef.current = true;
    virtualizer.measure();
    userAdjustedScrollSinceRestoreRef.current = false;

    const restoredState = readChatSessionScrollMemoryState(scrollMemoryKey);
    const pendingRestoreWait = resolvePendingScrollMemoryRestoreWait(
      restoredState,
      scrollRef.current,
      unitsRef.current.length > 0,
    );
    pendingDetachedScrollRestoreRef.current =
      scrollMemoryKey && restoredState && pendingRestoreWait
        ? {
            key: scrollMemoryKey,
            rowWindowKey,
            state: restoredState,
            waitFor: pendingRestoreWait,
          }
        : null;
    const restore = () => {
      if (!restoredState || restoredState.wasPinnedToBottom === true) {
        suppressVirtualizerAdjustmentDuringRestoreRef.current = false;
        followingRef.current = initialFollowing();
        setBackToBottomVisible(false);
        scrollToBottom();
        return;
      }
      restoreScrollMemory(restoredState);
    };

    restore();
    let releaseGuardFrame: number | null = null;
    const correctionFrame = window.requestAnimationFrame(() => {
      if (!userAdjustedScrollSinceRestoreRef.current) {
        restore();
      }
      releaseGuardFrame = window.requestAnimationFrame(() => {
        suppressVirtualizerAdjustmentDuringRestoreRef.current = false;
      });
    });
    return () => {
      window.cancelAnimationFrame(correctionFrame);
      if (releaseGuardFrame !== null) {
        window.cancelAnimationFrame(releaseGuardFrame);
      }
      suppressVirtualizerAdjustmentDuringRestoreRef.current = false;
    };
  }, [
    clearUserScrollIntent,
    restoreScrollMemory,
    scrollMemoryKey,
    scrollToBottom,
    sessionKey,
    virtualizer,
  ]);

  useLayoutEffect(() => {
    const pendingRestore = pendingDetachedScrollRestoreRef.current;
    if (rowCount === 0 || !pendingRestore || pendingRestore.key !== scrollMemoryKey) {
      return;
    }

    // session scope is often completed before rows subscription; only after scope commit and next frame
    // Restoration will clamp the history scrollTop to 0. After the first batch of content arrives, it lands again and waits for another frame to correct the altimetry.
    suppressVirtualizerAdjustmentDuringRestoreRef.current = true;
    restoreScrollMemory(pendingRestore.state);
    let releaseGuardFrame: number | null = null;
    const correctionFrame = window.requestAnimationFrame(() => {
      if (
        pendingDetachedScrollRestoreRef.current === pendingRestore &&
        !userAdjustedScrollSinceRestoreRef.current
      ) {
        restoreScrollMemory(pendingRestore.state);
      }
      releaseGuardFrame = window.requestAnimationFrame(() => {
        if (
          pendingDetachedScrollRestoreRef.current === pendingRestore &&
          canReleasePendingScrollMemoryRestore(
            pendingRestore,
            scrollRef.current,
            rowCount,
            canLoadOlder || totalCount > rows.length,
            rowWindowKey,
          )
        ) {
          pendingDetachedScrollRestoreRef.current = null;
        }
        suppressVirtualizerAdjustmentDuringRestoreRef.current = false;
      });
    });

    return () => {
      window.cancelAnimationFrame(correctionFrame);
      if (releaseGuardFrame !== null) {
        window.cancelAnimationFrame(releaseGuardFrame);
      }
      suppressVirtualizerAdjustmentDuringRestoreRef.current = false;
    };
  }, [
    canLoadOlder,
    restoreScrollMemory,
    rowCount,
    rowWindowKey,
    scrollMemoryKey,
    totalCount,
    totalSize,
  ]);

  // prepend anchor: loadOlder translates the scrollTop when inserting historical lines, and the reading position does not jump.
  // There is a turn key=turnId and the measurement cache is not invalid → forward insertion only increases the total height by delta, scrollTop += delta
  // That is, the anchor point is restored (completed before drawing, no flickering); this effect is declared after the session switch effect, on the switch commit
  // Reset the baseline first and then reconcile to prevent cross-session rowId from being misjudged as forward insertion.
  useLayoutEffect(() => {
    const prev = prependAnchorRef.current;
    const nextFirstRowId = rowsRef.current[0]?.rowId ?? null;
    const nextTotalSize = virtualizer.getTotalSize();
    const pendingRestore = pendingDetachedScrollRestoreRef.current;
    const pendingRestoreOwnsAnchor = pendingRestore?.key === scrollMemoryKey;
    const didPrepend =
      prev.firstRowId !== null && nextFirstRowId !== null && nextFirstRowId < prev.firstRowId;
    let viewportAdjustment: number | null = null;
    if (didPrepend && !pendingRestoreOwnsAnchor && scrollRef.current) {
      const previousVirtualAnchor = pendingPrependVirtualAnchorRef.current;
      const nextAnchorMeasurement = previousVirtualAnchor
        ? virtualizer.measurementsCache.find(
            (measurement) => measurement.key === previousVirtualAnchor.key,
          )
        : undefined;
      if (previousVirtualAnchor && nextAnchorMeasurement) {
        viewportAdjustment = prependVirtualAnchorAdjustment(
          previousVirtualAnchor,
          {
            key: previousVirtualAnchor.key,
            offsetTop: previousVirtualAnchor.offsetTop,
            start: nextAnchorMeasurement.start,
          },
          scrollRef.current.scrollTop,
        );
      }
    }
    if (didPrepend) pendingPrependVirtualAnchorRef.current = null;
    const adjustment = pendingRestoreOwnsAnchor
      ? null
      : (viewportAdjustment ??
        prependScrollAdjustment({
          prevFirstRowId: prev.firstRowId,
          nextFirstRowId,
          prevTotalSize: prev.totalSize,
          nextTotalSize,
        }));
    if (adjustment !== null && scrollRef.current) {
      const element = scrollRef.current;
      markLayoutScrollGuard();
      element.scrollTop += adjustment;
      // Programmed translation is also recorded in the account to avoid misinterpretation as "unobserved scroll" by the reconciliation below.
      lastObservedScrollTopRef.current = element.scrollTop;
      syncTurnNavigatorViewport(element);
      cacheCurrentScrollMemoryState(element);
      // When inserting thousands of rows at a time, the measurement cache and scrollTop will be in the same commit
      // Update, Chromium may merge the native scroll notification, and the virtualizer will still mount the first screen according to the old offset.
      // This results in "the scroll bar is at the bottom, but the text is blank." After committing, a read-only notification will be reissued according to the final placement point; if the same frame exists
      // For user wheel/pointer intent, handleScroll will still be identified as user first and the scrolling right will not be taken back.
      notifyScrollObserversAfterCommit(element);
    }
    // The off-bottom memory to be restored has the coordinate system of the current commit; prepend cannot be allowed to change the temporary clamp value again.
    // Pan. Restoring the effect will replay the original position at the final content height on the next frame of the same commit.
    prependAnchorRef.current = {
      firstRowId: nextFirstRowId,
      totalSize: nextTotalSize,
    };
  });

  // Bottom anchoring: When the content changes (new line / streaming delta / dynamic height correction → totalSize changes),
  // Follow the middle and stick to the bottom, and release the following to maintain the reading position. useLayoutEffect completes the bottom layer before drawing to avoid flickering.
  // The terminal will also migrate the live tail, automatically collapse the history and
  // Trigger virtualizer multi-stage height measurement; these scrollTop fallbacks belong to the layout and must be kept following.
  // If a user scrolls up in the same frame, the capture handler will first register awayFromBottom, and this effect must give way.
  useLayoutEffect(() => {
    const element = scrollRef.current;
    markLayoutScrollGuard();
    if (element) {
      const following = reconcileFollowingForContentAnchor({
        following: followingRef.current,
        metrics: {
          scrollTop: element.scrollTop,
          viewportHeight: element.clientHeight,
          contentHeight: element.scrollHeight,
        },
        lastObservedScrollTop: lastObservedScrollTopRef.current,
        userScrollIntent: getActiveUserScrollIntent(),
      });
      commitFollowing(following);
    }
    if (
      anchorActionAfterContentChange(followingRef.current, isContentWidthChanging()) ===
      "stickToBottom"
    ) {
      scrollToBottom();
    }
  }, [
    getActiveUserScrollIntent,
    isContentWidthChanging,
    markLayoutScrollGuard,
    commitFollowing,
    headerSlotHeight,
    pendingGuideKey,
    rowCount,
    rows,
    scrollToBottom,
    totalSize,
  ]);

  useLayoutEffect(() => {
    if (scrollRef.current) {
      syncTurnNavigatorViewport(scrollRef.current);
    }
  }, [pendingGuideKey, rowCount, syncTurnNavigatorViewport, totalSize]);

  // Row clearing (such as editUserQuery large-scale rewind): reset to follow and collapse buttons,
  // The anchoring effect on the walking surface that reappears later is attached to the bottom.
  useEffect(() => {
    if (rowCount === 0) {
      if (pendingDetachedScrollRestoreRef.current?.key === scrollMemoryKey) {
        return;
      }
      followingRef.current = initialFollowing();
      if (backToBottomVisible) {
        setBackToBottomVisible(false);
      }
    }
  }, [rowCount, backToBottomVisible, scrollMemoryKey]);

  useEffect(() => {
    return () => {
      if (programmaticScrollFrameRef.current !== null) {
        window.cancelAnimationFrame(programmaticScrollFrameRef.current);
        programmaticScrollFrameRef.current = null;
      }
    };
  }, []);

  // The raw projection row and the render unit merged by turn are not the same unit of measurement;
  // Separate exposure allows recovery/pagination verification to no longer mistake visible units for persistent rows.
  return (
    <div ref={timelineRootRef} className="relative flex min-h-0 flex-1 flex-col">
      {selectionActions ? (
        <ConversationSelectionTooltip
          rootRef={scrollRef}
          rows={rows}
          sourceSessionId={sessionKey}
          enabled={selectionActions.enabled}
          sideActionDisabled={selectionActions.sideActionDisabled}
          onAddToCurrentTask={selectionActions.onAddToCurrentTask}
          onAskInSideChat={selectionActions.onAskInSideChat}
        />
      ) : null}
      <ConversationScrollMemoryScopeCapture
        scopeKey={scrollMemoryKey}
        capture={captureScrollMemoryBeforeScopeMutation}
        commit={commitCapturedScrollMemory}
      />
      {/* Whether the share selection panel is expanded or collapsed, the left rail is owned
          exclusively by the share panel or the reopen button, and the turn navigation must be
          hidden to stop two absolutely positioned controls from covering each other. It is restored
          automatically after leaving share selection.
          */}
      {hideTurnNavigator ? null : (
        <ConversationTurnNavigator
          renderUnits={renderUnits}
          isHydratingDirectory={loadingOlder}
          scrollOffsetPx={virtualizer.scrollOffset ?? turnNavigatorViewport.scrollOffsetPx}
          viewportHeightPx={
            virtualizer.scrollRect?.height ?? turnNavigatorViewport.viewportHeightPx
          }
          virtualItems={turnNavigatorVirtualItems}
          activeQueryRowId={turnNavigatorViewport.activeQueryRowId}
          onJumpToQuery={scrollToQuery}
        />
      )}
      <div
        ref={scrollRef}
        data-testid={TID_V4_TIMELINE}
        data-v4-timeline-scroll="true"
        data-v4-timeline-scroll-locked={backgroundScrollLocked ? "true" : "false"}
        data-markdown-table-layout-root="true"
        data-row-count={rows.length}
        data-window-row-count={rows.length}
        data-render-unit-count={renderUnits.length}
        data-total-row-count={totalCount}
        data-following={backToBottomVisible ? "false" : "true"}
        data-loading-older={loadingOlder ? "true" : "false"}
        onKeyDownCapture={handleKeyDownCapture}
        onPointerCancelCapture={handlePointerEndCapture}
        onPointerDownCapture={handlePointerDownCapture}
        onPointerUpCapture={handlePointerEndCapture}
        onScroll={handleScroll}
        onTouchCancelCapture={handleTouchEndCapture}
        onTouchEndCapture={handleTouchEndCapture}
        onTouchMoveCapture={handleTouchMoveCapture}
        onTouchStartCapture={handleTouchStartCapture}
        onWheelCapture={handleWheelCapture}
        className={cn(
          // Native scroll bars that appear dynamically based on content height narrow the session viewport, resulting in messages that are inconsistent with the composer
          // Horizontal jump; stable reserve gutter, so that the width of the scroll area shared by the desktop and mobile web remains unchanged.
          // Only declaring overflow-y-auto will cause the browser to calculate the horizontal axis as auto, and wide content will
          // The entire Conversation supports horizontal scrolling; tables and code blocks should be scrolled by their respective inner containers.
          "min-h-0 flex-1 overflow-x-hidden overflow-y-auto [scrollbar-gutter:stable] [--markdown-table-layout-left-inset:16px] [--markdown-table-layout-right-inset:16px] max-md:[--markdown-table-layout-left-inset:8px] max-md:[--markdown-table-layout-right-inset:8px]",
          // Change the share selection panel to overflow-hidden when expanded: scrollTop and scrollbar-gutter remain unchanged.
          // However, the native scroll bar, wheel and keyboard page turning can no longer move the background, and the checked target will not float away.
          backgroundScrollLocked && "!overflow-y-hidden",
          // Conversation turn map covers 48px on the left side of timeline; table enhances scrolling if still pressed
          // If the normal 16px margin is borrowed, 32px will fall below the turn map, and the complete occupation must be included in the left border.
          turnNavigatorQueryRowIds.size >= 2 &&
            "@min-[864px]/conversation:[--markdown-table-layout-left-inset:48px]",
        )}
      >
        <div
          className={cn(
            // Fixed height breakpoints will make the greeting and composer group jump when the window crosses the threshold.
            // The top margin expands and contracts according to the height of the viewport, and the position of the input box is no longer affected by the height of the recommendation list below;
            // When there is insufficient space, the top can be shrunk to the bottom line, and the bottom can continue to be naturally arranged with the content.
            responsiveCenteredEmptyLayout
              ? // Dynamically modifying the lower limit of the native window will feed back the content line wrapping to the window drag, causing damping;
                // The container retains an inherent minimum height, and the outer timeline uniformly accepts overflow content under the limited height.
                "flex min-h-full flex-col items-center px-4 before:block before:min-h-[52px] before:w-full before:shrink before:basis-[29dvh] before:content-[''] after:block after:min-h-4 after:w-full after:flex-1 after:content-['']"
              : centeredEmptyLayout
                ? "flex min-h-full flex-col items-center justify-center gap-4 px-4"
                : "flex min-h-full flex-col",
          )}
          // When the session is switched to draft, the content height drops sharply, and Chrome will
          // Sticky composer selects as native scroll anchor and overrides layout/RAF recovery values after switching back.
          // V4 already takes care of prepend, absorb, and remember anchors; consistent with other virtual lists, anchor candidates should be disabled from the content subtree.
          style={{ overflowAnchor: "none" }}
        >
          {renderUnits.length === 0 && !headerSlot ? (
            <div
              className={cn(
                centeredEmptyLayout
                  ? "flex w-full max-w-2xl shrink-0 items-center justify-center"
                  : "min-h-0 flex-1",
                !centeredEmptyLayout && summaryPanelInlineOffsetClassName,
              )}
            >
              {emptyState}
            </div>
          ) : (
            <div
              ref={messageLayerRef}
              data-v4-timeline-message-layer="true"
              className="relative w-full flex-1 [mask-repeat:no-repeat] [-webkit-mask-repeat:no-repeat]"
            >
              {/*
               * headerSlot must land inside the masked message layer and carry the same width class
               * as the live message column: placed outside the message layer it would both be wider
               * than the body and show through from under the sticky composer.
               */}
              {headerSlot ? (
                <div
                  ref={headerSlotRef}
                  data-v4-timeline-header-slot="true"
                  data-v4-timeline-content-column="true"
                  className={cn(
                    "relative mx-auto w-full shrink-0",
                    contentWidthClassName,
                    summaryPanelInlineOffsetClassName,
                  )}
                >
                  {headerSlot}
                </div>
              ) : null}
              <div
                ref={virtualHistoryRef}
                data-v4-timeline-virtual-history="true"
                data-v4-timeline-content-column="true"
                className={cn(
                  // Default (< 1280px) transition width/max-width/transform, let w-full ↔ max-w-4xl
                  // Smooth mid-width switching; panel yield triggered by ≥1280px (max-w-6xl + 168px left shift)
                  // Use @min-[1280px] to downgrade to only transition transform to avoid large-scale jumps and superimposed displacement jitter.
                  "relative mx-auto w-full shrink-0 transition-[width,max-width,transform] duration-150 ease-out @min-[1280px]/conversation:transition-[transform]",
                  contentWidthClassName,
                  summaryPanelInlineOffsetClassName,
                )}
                style={{ height: totalSize }}
              >
                {virtualRows.map((virtualRow) => {
                  const unit = virtualizedUnits[virtualRow.index];
                  if (!unit) return null;
                  return (
                    <div
                      key={`${virtualRow.key}:${rowContext.logEpoch ?? ""}`}
                      ref={virtualizer.measureElement}
                      data-index={virtualRow.index}
                      data-v4-turn-unit="true"
                      data-turn-id={unit.turnId}
                      // The children of virtual history are positioned absolutely, and the parent padding will not shrink.
                      // Their containing block; body responsive padding must fall within the turn wrapper itself.
                      className="absolute left-0 top-0 w-full"
                      style={{ transform: `translateY(${virtualRow.start - headerSlotHeight}px)` }}
                    >
                      <ConversationTurnGroup
                        unit={unit}
                        apiRetry={null}
                        context={rowContext}
                        onFork={onFork}
                        onRetry={onRetry}
                        onFeedbackChange={onFeedbackChange}
                        onEdit={onEdit}
                        shareSelection={shareSelection}
                      />
                    </div>
                  );
                })}
              </div>
              {liveUnit !== null && liveUnitIndex !== null ? (
                <div
                  key={`${liveUnit.key}:${rowContext.logEpoch ?? ""}`}
                  ref={liveTailRef}
                  data-index={liveUnitIndex}
                  data-v4-running-live-tail="true"
                  data-v4-turn-unit="true"
                  data-turn-id={liveUnit.turnId}
                  data-v4-timeline-content-column="true"
                  className={cn(
                    // ≥1280px When the panel gives way, it is downgraded to only transition transform to avoid large-scale jumps and superimposed displacement jitter.
                    "relative mx-auto w-full shrink-0 transition-[width,max-width,transform] duration-150 ease-out @min-[1280px]/conversation:transition-[transform]",
                    contentWidthClassName,
                    summaryPanelInlineOffsetClassName,
                  )}
                >
                  <ConversationTurnGroup
                    unit={liveUnit}
                    apiRetry={apiRetry}
                    context={rowContext}
                    onFork={onFork}
                    onRetry={onRetry}
                    onFeedbackChange={onFeedbackChange}
                    onEdit={onEdit}
                    shareSelection={shareSelection}
                  />
                </div>
              ) : null}
              {pendingGuides.length > 0 ? (
                <div
                  data-v4-timeline-content-column="true"
                  className={cn(
                    "relative mx-auto w-full shrink-0",
                    contentWidthClassName,
                    summaryPanelInlineOffsetClassName,
                  )}
                >
                  <ConversationPendingGuideList
                    context={rowContext}
                    items={pendingGuides}
                    turnId={
                      liveUnit?.turnId ??
                      rows.at(-1)?.productTurnId ??
                      rows.at(-1)?.turnId ??
                      "pending-guide"
                    }
                  />
                </div>
              ) : null}
            </div>
          )}
          {bottomDock ? (
            <div
              ref={composerDockRef}
              data-v4-composer-dock="true"
              className={cn(
                // The sticky dock is a full-width transparent layer on the z-20 that used to cover the z-10 rail
                // The button in the blank space to the left of composer. The shell does not receive events and only allows the actual content column to be restored.
                "pointer-events-none z-20 flex w-full justify-center",
                responsiveCenteredEmptyLayout
                  ? "mt-3 shrink-0"
                  : centeredEmptyLayout
                    ? "shrink-0"
                    : "sticky bottom-0",
              )}
            >
              <div
                data-v4-composer-dock-content="true"
                className={cn(
                  // Same as virtual history/live tail, restore width transition to avoid hard jumps.
                  // ≥1280px When the panel gives way, it is downgraded to only transition transform to avoid large-scale jumps and superimposed displacement jitter.
                  "pointer-events-auto relative z-10 w-full shrink-0 transition-[width,max-width,transform] duration-150 ease-out @min-[1280px]/conversation:transition-[transform]",
                  contentWidthClassName,
                  !centeredEmptyLayout && "px-4 pb-4",
                  !centeredEmptyLayout && summaryPanelInlineOffsetClassName,
                )}
              >
                <div data-v4-back-to-bottom-anchor="composer-dock" className="relative">
                  {backToBottomVisible ? (
                    <ConversationBackToBottomButton
                      // In split screen, composer belongs to the sticky dock in the scrolling viewport; if the button is hung on
                      // The outer absolute bottom of the timeline will fall below the input relative to the entire pane.
                      //
                      // Circle buttons adopt their own centered positioning; `pointer-events-auto` remains:
                      // It is the only assertable contract that can be reached at the click of a button.
                      className="pointer-events-auto absolute bottom-full left-1/2 z-30 mb-2 -translate-x-1/2 shadow-sm"
                      label={intl.formatMessage({ id: "chat.scrollToBottom" })}
                      onClick={handleBackToBottom}
                    />
                  ) : null}
                  {bottomDock}
                </div>
              </div>
            </div>
          ) : null}
        </div>
      </div>
      {backToBottomVisible && !bottomDock ? (
        <ConversationBackToBottomButton
          className="absolute bottom-3 left-1/2 -translate-x-1/2 shadow-sm"
          label={intl.formatMessage({ id: "chat.scrollToBottom" })}
          onClick={handleBackToBottom}
        />
      ) : null}
    </div>
  );
}

export const ConversationTimeline = memo(ConversationTimelineImpl);
