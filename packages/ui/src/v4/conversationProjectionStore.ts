/* eslint-disable max-lines -- projection/base/recovery/optimistic must share one atomic store state
 * machine; splitting them would reintroduce cross-object races.
 */
// Per-session projection store (read-only projection store).
// The only writer is the subscriber push; the UI is read-only. Clients obey three rules:
//   1. snapshot → overall replacement, never merge;
//   2. The delta frame is only applied when the interval is connected (frame.fromSeq === snapshot.seq), and there is no guessing or caching compensation when there is a break;
//   3. The base and the state live and die together - the state is not polluted when the file is interrupted, resubscribe with the current water level, and the server determines resume/snapshot.
// This store does not generate any conversation facts except optimistic overlay (shown by the pending command).
import {
  applyConversationDeltas,
  isDeterministicContentFault,
  parseConversationTopic,
  PROTOCOL_V4_LIMITS,
  SUBSCRIPTION_CONTENT_REJECTED,
  type ConversationRow,
  type ConversationSnapshot,
  type ConversationOpenTiming,
  type ConversationTopicFrame,
  type SessionModelTransition,
  type ToolCallRow,
  type TopicFrameDeliveryKind,
} from "@zcode/shared/zcode-protocol-v4";
import { logger } from "@/logger.js";
import type { ConversationTurnNavigatorHydrationResult } from "@/v4/conversationTurnNavigatorHelpers.js";
import type { ConversationTransport } from "@/v4/transport.js";
import { uiMemoryDiagnosticsRegistry } from "@/lib/memoryDiagnostics.js";

/**
 * Backoff pacing after a subscribe is interrupted by a runtime generation change.
 *
 * A cold CUA Helper becoming ready runs recycleUntilStable → disposeWorkspace to reclaim the agent
 * runtime, and in-flight subscribes are interrupted by rejectAll. If this transient failure were
 * frozen into status="error", a lazily started agent might never be brought back up after the
 * dispose, so onRuntimeRestart would never arrive and the panel would depend on the user manually
 * clicking "Reconnect". subscribeConversationV4 goes through start-if-needed, so resubscribing by
 * itself brings the runtime up; that is why this does bounded backoff following the established
 * pattern of sessionsIndexStore.
 */
const RUNTIME_RECYCLE_RETRY_DELAYS_MS = [250, 1_000, 3_000] as const;

/**
 * The grace period for waiting on the authoritative input projection after an accepted ACK.
 *
 * The ACK for core admission does not wait for the TurnStarted/QueueItem/userInput projection;
 * under normal conditions the two paths differ by only one renderer/network round-trip. Setting the
 * window to 2s covers normal desktop/mobile latency while still self-healing quickly from a
 * half-open channel where “the CLI keeps working but the subscription is completely silent”. Timing
 * out only restores the subscription; it does not replay the command.
 */
const ACCEPTED_INPUT_PROJECTION_GRACE_MS = 2_000;
const ACCEPTED_INPUT_COMMAND_TYPES = new Set(["sendText"]);

/**
 * The lastError shown to the user once the backoff is exhausted (generation-change paths have no
 * underlying error object to reference).
 */
const RUNTIME_RECYCLED_ERROR =
  "The ZCode agent runtime was recycled and reconnection did not succeed";

function monotonicNow(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

function roundedDuration(startedAt: number, endedAt: number): number {
  return Math.max(0, Math.round(endedAt - startedAt));
}

/**
 * Whether this is a transient subscribe failure caused by a runtime generation change / reclaim.
 *
 * All three messages come from the same reclaim: when the transport closes,
 * ZCodeProtocolClient.rejectAll interrupts in-flight requests (transport closed); reusing an
 * already reclaimed client exits early in assertNotDisposed (client disposed); and there is a
 * fail-fast while the runtime has not been brought back up yet (runtime is not running).
 */
function isRuntimeRecycleError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    // Cold subscription may start a new runtime by itself; restart requires bounded re-subscription after the ACK in transit expires, and cannot stop at error.
    message.includes("fault.subscription.runtimeRestarted") ||
    message.includes("ZCode agent transport closed") ||
    message.includes("ZCode Protocol client disposed") ||
    message.includes("ZCode Protocol client is disposed") ||
    message.includes("ZCode Agent runtime is not running")
  );
}

function hasAcceptedInputProjection(
  snapshot: ConversationSnapshot | null,
  commandId: string,
): boolean {
  if (!snapshot) return false;
  if (snapshot.queue.items.some((item) => item.sourceCommandId === commandId)) return true;
  return snapshot.rows.window.some(
    (row) =>
      row.kind === "userInput" && row.origin === "realUser" && row.sourceCommandId === commandId,
  );
}

export type ConversationStoreStatus =
  // The subscribe is in progress (first connection or re-subscription after interruption).
  | "connecting"
  // Subscribed and frames are continuous.
  | "live"
  // Subscribe failed, waiting for retry().
  | "error"
  // Released (after SessionDataLayer unsubscribes) and no longer accepts any operations.
  | "closed";

/**
 * An optimistic overlay entry: the command has gone upstream but the server has not yet confirmed
 * it in the projection.
 */
export interface OptimisticCommand {
  commandId: string;
  type: string;
  issuedAt: number;
}

export interface ConversationStoreState {
  status: ConversationStoreStatus;
  snapshot: ConversationSnapshot | null;
  subscriptionId: string | null;
  lastError: string | null;
  /**
   * Low-frequency Host/CLI timing for the first conversation subscribe; not part of the snapshot's
   * facts.
   */
  openTiming?: ConversationOpenTiming;
  /**
   * The renderer's first-frame timing; notified together with the snapshot so the UI never reads a
   * half-updated diagnostics state.
   */
  rendererTiming?: SessionOpenRendererTiming;
  optimisticCommands: readonly OptimisticCommand[];
  /** The in-flight marker for loadOlder (prevents re-entrancy from automatic prefetch). */
  loadingOlder: boolean;
  /** The terminal-state plan catalog returned by the CLI's complete valid projection. */
  sessionPlans: readonly ToolCallRow[];
  /**
   * Only used to trigger the read-only plan-catalog query; not part of the conversation protocol's
   * facts.
   */
  planDirectoryRevision: number;
  plansLoading: boolean;
  /**
   * The invalidation generation of the question-navigation catalog (turn navigator). The
   * not-enough-queries terminal state used to be judged valid by logEpoch alone, but "whether there
   * are already ≥2 navigable queries" is a derived condition that changes with each delta, and
   * logEpoch denotes the log generation rather than content quiescence. This revision is
   * incremented when real-user queries are added or removed (row.appended/row.upserted hitting a
   * realUser userInput, or row.removed truncating a branch) and when the snapshot is replaced
   * wholesale, so that the terminal-state cache is invalidated.
   */
  turnNavigatorDirectoryRevision: number;
}

export interface SessionOpenRendererTiming {
  rendererPrepareMs?: number;
  initialFrameTransportMs?: number;
  rendererSnapshotApplyMs?: number;
  snapshotAppliedAt?: number;
}

const INITIAL_STATE: ConversationStoreState = {
  status: "connecting",
  snapshot: null,
  subscriptionId: null,
  lastError: null,
  rendererTiming: undefined,
  optimisticCommands: [],
  loadingOlder: false,
  sessionPlans: [],
  planDirectoryRevision: 0,
  plansLoading: false,
  turnNavigatorDirectoryRevision: 0,
};

const TERMINAL_PLAN_STATUSES: ReadonlySet<ToolCallRow["status"]> = new Set([
  "success",
  "error",
  "cancelled",
]);

function shouldInvalidatePlanDirectory(frame: ConversationTopicFrame): boolean {
  if (frame.payload.kind === "snapshot") return true;
  return frame.payload.deltas.some((delta) => {
    if (delta.op === "row.removed") return true;
    if (delta.op !== "row.appended" && delta.op !== "row.upserted") return false;
    const row = delta.row;
    return (
      row.kind === "toolCall" &&
      row.toolName === "ExitPlanMode" &&
      TERMINAL_PLAN_STATUSES.has(row.status)
    );
  });
}

/**
 * Whether the question-navigation catalog needs invalidation. The not-enough-queries terminal state
 * used to be judged by logEpoch alone, which meant that appending a real-user query within the same
 * epoch would hit the cache forever. The decision rules:
 * - the snapshot is replaced wholesale → true (entirely new state, the terminal state is void);
 * - row.removed → true (a rewind / branch truncation changes the set of navigable queries);
 * - row.appended/row.upserted hits a realUser userInput → true (a user question added or changed);
 * - any other delta (streaming assistant text, tool, reasoning) → false, no re-probing.
 */
function shouldInvalidateTurnNavigatorDirectory(frame: ConversationTopicFrame): boolean {
  if (frame.payload.kind === "snapshot") return true;
  return frame.payload.deltas.some((delta) => {
    if (delta.op === "row.removed") return true;
    if (delta.op !== "row.appended" && delta.op !== "row.upserted") return false;
    const row = delta.row;
    return row.kind === "userInput" && row.origin === "realUser";
  });
}

function logSubagentProjectionTransition(
  topic: string,
  previous: ConversationSnapshot | null,
  next: ConversationSnapshot,
  delivery: "snapshot" | "deltas",
): void {
  const previousIds = previous?.subagents?.running.map((item) => item.childSessionId) ?? [];
  const nextIds = next.subagents?.running.map((item) => item.childSessionId) ?? [];
  if (
    previousIds.length === nextIds.length &&
    previousIds.every((childSessionId, index) => childSessionId === nextIds[index])
  ) {
    return;
  }
  // The root cause of the interaction bug lies in the subscription snapshot handover, not in the React DOM; only when the Agent run set changes
  // Recording lightweight identities and water levels enables local reproducibility to differentiate between legitimate final states and late snapshot overrides.
  logger.info("[v4-store] running subagent projection changed", {
    delivery,
    nextBackgroundWorkIds: next.backgroundWorks
      .filter((work) => work.kind === "subagent" && work.status === "running")
      .map((work) => work.childSessionId ?? work.workId),
    nextIds,
    nextSeq: next.seq,
    previousIds,
    previousSeq: previous?.seq ?? null,
    topic,
  });
}

/**
 * Whether earlier history can still be pulled ⇔ the window's first row is not the first row of the
 * total order (decided by firstRowId). A pure function shared by the store and the components; a
 * missing snapshot, an empty window, or an unknown firstRowId all yield false.
 */
export function hasOlderRows(snapshot: ConversationSnapshot | null): boolean {
  if (!snapshot) return false;
  const first = snapshot.rows.window[0];
  if (!first || snapshot.rows.firstRowId === null) return false;
  return first.rowId > snapshot.rows.firstRowId;
}

/**
 * Whether the cold snapshot's tail window is cut in the middle of a turn. turnHeader is the
 * authoritative start of a complete turn; the first row is allowed to be a lightBoundary, so the
 * first row's kind alone cannot decide it — the first turn in the current window must be checked
 * for an existing header.
 */
export function shouldAutoLoadIncompleteLeadingTurn(
  snapshot: ConversationSnapshot | null,
  loadingOlder: boolean,
): boolean {
  if (loadingOlder || !hasOlderRows(snapshot) || !snapshot) return false;
  const leadingTurnId = snapshot.rows.window[0]?.turnId;
  if (!leadingTurnId) return false;
  return !snapshot.rows.window.some(
    (row) => row.turnId === leadingTurnId && row.kind === "turnHeader",
  );
}

/**
 * Merging a rows/range result into the local window (merge contract): keyed by rowId, taking only
 * the rows before the window's first row, deduped and prepended; the ordering key is rowId
 * ascending (a total-order guarantee). Returning null means there are no rows to merge (the window
 * is unchanged and the caller keeps the same reference).
 */
function mergeOlderRows(
  window: readonly ConversationRow[],
  fetched: readonly ConversationRow[],
): ConversationRow[] | null {
  const firstRowId = window[0]?.rowId ?? Number.POSITIVE_INFINITY;
  const older = fetched.filter((row) => row.rowId < firstRowId);
  if (older.length === 0) return null;
  return [...older, ...window];
}

/**
 * The external store (useSyncExternalStore-compatible: subscribe + getState return stable
 * references). Its lifecycle is managed by SessionDataLayer (reference counting + keep-warm);
 * components do not construct it directly.
 */
// Memory diagnostic counter: counts the sum of the number of surviving stores and the number of rows.window rows,
// Memory growth for observation window data. Added during construction and removed during close().
const liveProjectionStores = new Set<ConversationProjectionStore>();
uiMemoryDiagnosticsRegistry.register("projection", () => {
  let rows = 0;
  for (const store of liveProjectionStores) {
    rows += store.countProjectionRows();
  }
  return { stores: liveProjectionStores.size, rows };
});

export class ConversationProjectionStore {
  private state: ConversationStoreState = INITIAL_STATE;
  private readonly listeners = new Set<() => void>();
  private readonly modelTransitionListeners = new Set<
    (transition: SessionModelTransition) => void
  >();
  private observedModelTransitionEventId: string | null = null;
  // Subscription generation: Concurrent connect only recognizes the latest generation, and the expired result will be unsubscribed immediately to prevent the server from hanging.
  private generation = 0;
  // When the first subscription has not received ACK, runtime available is just a normal completion signal of the current startup process;
  // Record the number in transit to avoid life cycle notifications to start connect again and create a subscription replacement race for the same topic.
  private connectInFlight = 0;
  /**
   * The subscribe ACK mode is persisted up to the first logical frame of that generation; it cannot
   * rely on the synchronous activate stack alone, because the notification may arrive
   * asynchronously after the ACK promise resolves.
   */
  private awaitingInitial: { subscriptionId: string; mode: "snapshot" | "resume" } | null = null;
  /**
   * Whether the current subscription's watermark has already been proven valid by an old applied
   * base or by this generation's logical frame.
   */
  private subscriptionHasAppliedBase = false;
  private recovery: {
    subscriptionId: string;
    requestInFlight: boolean;
    ackReceived: boolean;
    validFrameSeen: boolean;
    upgradePending: boolean;
    ackMode: "snapshot" | "resume" | null;
    forceSnapshot: boolean;
    postRecoveryGapPending: boolean;
    frameDeadline: ReturnType<typeof setTimeout> | null;
    /**
     * This flight was started for a determinate content failure: the terminal state is
     * contentRejected, kept out of the transient statistics.
     */
    contentFault: boolean;
  } | null = null;
  private readonly offAssemblyFault: () => void;
  private readonly offRuntimeRestart: (() => void) | null = null;
  private readonly offRuntimeLifecycle: (() => void) | null = null;
  private runtimeRecycleRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private runtimeRecycleRetryAttempt = 0;
  private sessionOpenRendererTiming: SessionOpenRendererTiming = {};
  private initialSubscribeAckAt: number | null = null;
  private planQueryInFlight = false;
  private planQueryPending = false;
  /**
   * The projection-confirmation watchdog for accepted input; it carries no command and produces no
   * local facts.
   */
  private readonly acceptedInputProjectionTimers = new Map<string, ReturnType<typeof setTimeout>>();
  // hydrated/not-enough-queries final cache. In the past, only
  // The logEpoch judgment is valid, and the real-user query is still hit permanently after appending it in the same epoch. Add now
  // directoryRevision——Addition and deletion of real-user query will increment the revision, causing the final state to be invalid and re-detected.
  private turnNavigatorHydrationTerminal:
    | (Extract<
        ConversationTurnNavigatorHydrationResult,
        { status: "hydrated" | "not-enough-queries" }
      > & { directoryRevision: number })
    | null = null;
  private closed = false;

  constructor(
    readonly topic: string,
    private readonly transport: ConversationTransport,
  ) {
    liveProjectionStores.add(this);
    this.offAssemblyFault = transport.onAssemblyFault((fault) => {
      if (fault.topic === this.topic) {
        this.handleAssemblyFault(fault.subscriptionId, fault.deliveryKind, fault.reasonCode);
      }
    });
    // Runtime replacement (CLI process replacement) takes priority according to the agreement of sessionsIndexStore lifecycle: dispose
    // There is only unavailable observable on the spot, and onRuntimeRestart has to wait for the new process to spawn - it may never arrive under lazy start.
    if (transport.onRuntimeLifecycle) {
      this.offRuntimeLifecycle = transport.onRuntimeLifecycle((state) => {
        if (state === "available") this.handleRuntimeAvailable();
        else this.handleRuntimeUnavailable();
      });
      // Proxy handoff is not a runtime replacement, only the restart channel carries this semantic——
      // ReplaceableConversationTransport.replace() only broadcasts runtimeRestartListeners and does not send any
      // lifecycle events. If the restart channel is completely abandoned due to "choose one of two", the proxy of the remote workspace will be replaced.
      // No one will receive it: replace() has best-effort unsubscribed from the old proxy, but the store stops at live + old
      // subscriptionId, the frame stream is silently interrupted and does not heal itself.
      // Only recognize transportReplaced so that the two do not overlap: the underlying runtime restart is passed through bindRuntimeRestartListener
      // When forwarding, listener() is called (reason is undefined), which has been taken over by available in lifecycle.
      this.offRuntimeRestart = transport.onRuntimeRestart((reason) => {
        if (reason !== "transportReplaced") return;
        this.handleRuntimeRestart(reason);
      });
    } else {
      this.offRuntimeRestart = transport.onRuntimeRestart((reason) =>
        this.handleRuntimeRestart(reason),
      );
    }
  }

  getState(): ConversationStoreState {
    return this.state;
  }

  getSessionOpenRendererTiming(): SessionOpenRendererTiming {
    return { ...this.sessionOpenRendererTiming };
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onOnlineModelTransition(listener: (transition: SessionModelTransition) => void): () => void {
    this.modelTransitionListeners.add(listener);
    return () => this.modelTransitionListeners.delete(listener);
  }

  private setState(patch: Partial<ConversationStoreState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }

  /**
   * Starts or resends a subscription. The base is taken from the current snapshot watermark
   * (watermark invariant: it is only carried when the consistent state of that moment is genuinely
   * held); forceSnapshot is the fallback for when a resume's continuation frames still have gaps,
   * where losing the base requires a full fetch.
   */
  async connect(
    options: {
      forceSnapshot?: boolean;
      initialOverflowRetry?: boolean;
      rendererPrepareStartedAt?: number;
    } = {},
  ): Promise<void> {
    if (this.closed) return;
    const generation = ++this.generation;
    this.discardRecovery();
    const snapshot = options.forceSnapshot ? null : this.state.snapshot;
    const connectStartedAt = options.rendererPrepareStartedAt ?? monotonicNow();
    const subscribeStartedAt = monotonicNow();
    logger.lifecycle.info("v4 conversation store connect started", {
      event: "v4.conversation.store.connect.started",
      generation,
      hasBase: Boolean(snapshot),
      module: "ui.v4.conversation_projection_store",
      status: "started",
      topic: this.topic,
    });
    this.sessionOpenRendererTiming = {
      rendererPrepareMs: roundedDuration(connectStartedAt, subscribeStartedAt),
    };
    this.initialSubscribeAckAt = null;
    this.connectInFlight += 1;
    this.setState({ status: "connecting", rendererTiming: this.sessionOpenRendererTiming });
    try {
      const result = await this.transport.subscribe({
        topic: this.topic,
        base: snapshot ? { logEpoch: snapshot.logEpoch, seq: snapshot.seq } : undefined,
      });
      if (generation !== this.generation || this.closed) {
        // Expired generation: This subscription has no one to consume, please unsubscribe immediately.
        logger.lifecycle.warn("v4 conversation store connect ACK became stale", {
          event: "v4.conversation.store.connect.stale_ack",
          generation,
          currentGeneration: this.generation,
          module: "ui.v4.conversation_projection_store",
          status: "failed",
          subscriptionId: result.ack.subscriptionId,
          topic: this.topic,
        });
        void this.transport.unsubscribe(result.ack.subscriptionId);
        return;
      }
      // The root cause of online fault.subscription.notOwned stuck: connect() only when initiated
      // discardRecovery, old subscriptions within the await window of subscribe ACK may still create same-sub recovery;
      // The host scope has silently evicted the old subscription according to the ownershipKey when the new ACK remember() is recovered.
      // The in-transit resync is destined to be rejected by notOwned . If the generation change is successful, the old recovery - the initial of the new subscription will be discarded.
      // The entire projection will be replaced atomically, and the old recovery stream will be meaningless; otherwise its late failure will mark live's new subscription as an error.
      this.discardRecovery();
      this.runtimeRecycleRetryAttempt = 0;
      this.initialSubscribeAckAt = monotonicNow();
      this.setState({
        status: "live",
        subscriptionId: result.ack.subscriptionId,
        lastError: null,
        openTiming: result.ack.openTiming,
      });
      this.subscriptionHasAppliedBase = Boolean(
        snapshot && result.ack.mode === "resume" && result.ack.logEpoch === snapshot.logEpoch,
      );
      // The public result is already ACK-only; initial and online use unified notification.
      // The subscriptionId must be entered into the store before activate can synchronously release the own initial temporarily stored in the same read.
      this.awaitingInitial = {
        subscriptionId: result.ack.subscriptionId,
        mode: result.ack.mode,
      };
      this.transport.activate(result.ack.subscriptionId);
      logger.lifecycle.info("v4 conversation store connect completed", {
        durationMs: roundedDuration(subscribeStartedAt, monotonicNow()),
        event: "v4.conversation.store.connect.completed",
        generation,
        logEpoch: result.ack.logEpoch,
        mode: result.ack.mode,
        module: "ui.v4.conversation_projection_store",
        status: "completed",
        subscriptionId: result.ack.subscriptionId,
        topic: this.topic,
      });
    } catch (error) {
      if (generation !== this.generation || this.closed) return;
      const message = error instanceof Error ? error.message : String(error);
      this.awaitingInitial = null;
      this.subscriptionHasAppliedBase = false;
      if (
        message.includes("fault.subscription.initialFrameStagingOverflow") &&
        !options.initialOverflowRetry
      ) {
        // The physical batch before ACK is incomplete, and the active same-sub does not exist yet; it can only be fresh
        // subscribe forces snapshot. Automatically at most once to avoid retry storms caused by abnormal peers.
        await this.connect({ forceSnapshot: true, initialOverflowRetry: true });
        return;
      }
      if (this.scheduleRuntimeRecycleRetry(error, generation)) {
        logger.lifecycle.warn("v4 conversation store connect retry scheduled", {
          durationMs: roundedDuration(subscribeStartedAt, monotonicNow()),
          errorMessage: message,
          event: "v4.conversation.store.connect.retry_scheduled",
          generation,
          module: "ui.v4.conversation_projection_store",
          status: "retrying",
          topic: this.topic,
        });
        logger.warn(
          `[v4-store] subscribe ${this.topic} interrupted by a runtime generation change, backing off and reconnecting: ${message}`,
        );
        return;
      }
      logger.lifecycle.warn("v4 conversation store connect failed", {
        durationMs: roundedDuration(subscribeStartedAt, monotonicNow()),
        errorMessage: message,
        event: "v4.conversation.store.connect.failed",
        generation,
        module: "ui.v4.conversation_projection_store",
        status: "failed",
        topic: this.topic,
      });
      logger.warn(`[v4-store] subscribe ${this.topic} failed: ${message}`);
      this.setState({ status: "error", lastError: message });
    } finally {
      this.connectInFlight -= 1;
    }
  }

  private clearRuntimeRecycleRetry(): void {
    if (this.runtimeRecycleRetryTimer === null) return;
    clearTimeout(this.runtimeRecycleRetryTimer);
    this.runtimeRecycleRetryTimer = null;
  }

  /**
   * A subscribe failure caused by a runtime generation change: stay connecting and reconnect with
   * bounded backoff. Returning true means this failure has been taken over and the caller should
   * not record an error.
   */
  private scheduleRuntimeRecycleRetry(error: unknown, generation: number): boolean {
    if (!isRuntimeRecycleError(error)) return false;
    return this.scheduleRuntimeRecycleReconnect(generation);
  }

  /**
   * Reconnect with bounded backoff. Resubscribing goes through start-if-needed
   * (zcodeAgentService.subscribeConversationV4), which by itself brings a lazily started runtime up
   * — the only self-healing path when available is never reached. Returning true means it has been
   * taken over and the caller should not record an error.
   */
  private scheduleRuntimeRecycleReconnect(generation: number): boolean {
    if (this.closed) return false;
    const delayMs = RUNTIME_RECYCLE_RETRY_DELAYS_MS[this.runtimeRecycleRetryAttempt];
    if (delayMs === undefined) return false;
    this.runtimeRecycleRetryAttempt += 1;
    this.clearRuntimeRecycleRetry();
    // Keep the old snapshot: the projection is not contaminated during generation replacement, and will be replaced atomically if the reconnection is successful.
    this.setState({ status: "connecting" });
    this.runtimeRecycleRetryTimer = setTimeout(() => {
      this.runtimeRecycleRetryTimer = null;
      if (this.closed || generation !== this.generation) return;
      void this.connect();
    }, delayMs);
    return true;
  }

  /**
   * At the moment of workspace-dispose: the old runtime is already dead and the new one does not
   * exist yet, so resubscribing is impossible.
   */
  private handleRuntimeUnavailable(): void {
    if (this.closed) return;
    this.clearRuntimeRecycleRetry();
    this.discardRecovery();
    this.awaitingInitial = null;
    this.subscriptionHasAppliedBase = false;
    this.generation += 1;
    // The old subscriptionId belongs to the dead runtime and cannot be unsubscribed (the owner on the host side has expired).
    this.setState({ status: "connecting", subscriptionId: null });
    // You can't just dormant and wait for available: the agent is started lazily, and the signal will never arrive if no one pulls it up after dispose.
    // The panel will spin permanently. Backing off and reconnecting itself will start the runtime; if available comes first, the count will be reset and the connection will be reconnected immediately.
    if (this.scheduleRuntimeRecycleReconnect(this.generation)) return;
    // The backoff quota is exhausted (runtime is repeatedly recycled): error must be dropped to expose the "reconnection" entrance.
    // Otherwise, connecting without timer means permanent circles without even manual retries.
    this.setState({ status: "error", lastError: RUNTIME_RECYCLED_ERROR });
  }

  /**
   * New runtime ready: synonymous with onRuntimeRestart; resubscribes carrying the original
   * watermark.
   */
  private handleRuntimeAvailable(): void {
    if (this.closed) return;
    this.clearRuntimeRecycleRetry();
    this.runtimeRecycleRetryAttempt = 0;
    if (this.connectInFlight > 0) {
      // Cold start spawn will subscribe ACK for the first time
      // Broadcast available before returning. If you connect again here immediately, the server will press the same connection/topic
      // Replace the old subscription; the old ACK is immediately unsubscribed by the local generation protection, there is a race condition in the first frame handover, and the panel may never have a snapshot.
      // The currently in-transit connect has been responsible for completing this startup, and there is no need to repeat the subscription.
      return;
    }
    this.handleRuntimeRestart("runtimeRestart");
  }

  /**
   * The manual retry entry point after a subscription failure (where the pane-level "Reconnect"
   * button lands).
   */
  retry(): Promise<void> {
    this.clearRuntimeRecycleRetry();
    this.runtimeRecycleRetryAttempt = 0;
    return this.connect();
  }

  /**
   * A row command/query's epoch/entity authority became invalid; the existing same-sub recovery is
   * reused to converge.
   */
  recoverFromStaleAuthority(): void {
    this.requestRecovery();
  }

  /** The SessionDataLayer frame routing entry point. */
  handleFrame(
    frame: ConversationTopicFrame,
    delivery?: { deliveryKind: TopicFrameDeliveryKind },
  ): void {
    if (this.closed) return;
    // Intergenerational protection: late frames from old subscriptions are discarded directly.
    if (frame.subscriptionId !== this.state.subscriptionId) return;
    const awaitingInitial =
      this.awaitingInitial?.subscriptionId === frame.subscriptionId ? this.awaitingInitial : null;
    const deliveryKind = delivery?.deliveryKind ?? "online";
    const frameReceivedAt = monotonicNow();
    // RPC timings cannot prove frame usage. Only initial marked by publisher is consumed
    // awaitingInitial; recovery must first clear this status to avoid recovery gap being misjudged as
    // original subscribe gap and replace with new subId. Late online duplicates may not consume any gates.
    const initial = deliveryKind === "initial" ? awaitingInitial : null;
    if (initial || (deliveryKind === "recovery" && awaitingInitial)) {
      this.awaitingInitial = null;
    }
    if (deliveryKind === "online" && this.recovery && frame.payload.kind === "snapshot") {
      // The online overflow snapshot itself is a complete authoritative state and can establish an applied base; but it does not pretend to be
      // Recovery delivery, flight is still waiting for its own recovery frame/ACK to close.
      this.applyFrame(frame, { subscribeMode: null, recovery: false, online: true });
      return;
    }
    if (deliveryKind === "online" && this.recovery) {
      // Online after recovery reservation may arrive with ACK at the same time as read; after recovery
      // After the logical frame has been applied and you see non-duplicate online, you must start the successor flight again when the ACK is closed.
      if (frame.toSeq > (this.state.snapshot?.seq ?? 0)) {
        this.recovery.postRecoveryGapPending ||= this.recovery.validFrameSeen;
      }
      return;
    }
    if (frame.payload.kind === "deltas" && !this.subscriptionHasAppliedBase) {
      // ACK (snapshot) does not constitute applied base; even if the initial value is lost, the value fromSeq will be exactly
      // For the old projection, the new epoch delta cannot be restored to the old state.
      this.requestRecovery(deliveryKind === "recovery");
      return;
    }
    this.applyFrame(frame, {
      subscribeMode: initial?.mode ?? null,
      recovery: deliveryKind === "recovery",
      online: deliveryKind === "online",
      frameReceivedAt,
    });
  }

  private applyFrame(
    frame: ConversationTopicFrame,
    context: {
      subscribeMode: "snapshot" | "resume" | null;
      recovery: boolean;
      online: boolean;
      frameReceivedAt?: number;
    },
  ): void {
    if (frame.payload.kind === "snapshot") {
      const hadAppliedBase = this.subscriptionHasAppliedBase;
      logSubagentProjectionTransition(
        this.topic,
        this.state.snapshot,
        frame.payload.snapshot,
        "snapshot",
      );
      // Rule 1: Replace the whole thing, throw away the one in hand and replace it with a new one.
      this.setState({
        snapshot: frame.payload.snapshot,
        planDirectoryRevision: this.state.planDirectoryRevision + 1,
        // After the snapshot is replaced as a whole, the real-user query set may have changed, and the final state cache must be invalidated.
        turnNavigatorDirectoryRevision: this.state.turnNavigatorDirectoryRevision + 1,
      });
      this.subscriptionHasAppliedBase = true;
      this.reconcileOptimistic(frame.payload.snapshot);
      this.reconcileAcceptedInputProjection(frame.payload.snapshot);
      // When initial is lost, the publisher allows a complete online snapshot to create the first
      // applied base; the persistent transition in it may be earlier than this subscription and cannot be considered as a new event.
      // In the first frame, only the observation baseline is seeded, and the pane is notified only in subsequent online transitions.
      this.observeModelTransition(frame.payload.snapshot, context.online && hadAppliedBase);
      if (context.subscribeMode !== null && context.frameReceivedAt !== undefined) {
        const snapshotAppliedAt = monotonicNow();
        this.sessionOpenRendererTiming = {
          ...this.sessionOpenRendererTiming,
          ...(this.initialSubscribeAckAt === null
            ? {}
            : {
                initialFrameTransportMs: roundedDuration(
                  this.initialSubscribeAckAt,
                  context.frameReceivedAt,
                ),
              }),
          rendererSnapshotApplyMs: roundedDuration(context.frameReceivedAt, snapshotAppliedAt),
          snapshotAppliedAt,
        };
        this.setState({ rendererTiming: this.sessionOpenRendererTiming });
      }
      if (context.recovery) this.markRecoveryFrameSeen();
      return;
    }
    const current = this.state.snapshot;
    // Rule 2a: Late/duplicate logical frames are always silently discarded. If it is aligned after ACK
    // recovery `(N,N]`, then only flight will be closed and apply will not be repeated.
    if (current && frame.toSeq <= current.seq) {
      if (context.recovery) this.markRecoveryFrameSeen();
      return;
    }
    if (!current || frame.fromSeq !== current.seq) {
      // Rule 2: Don’t guess during breaks. The state itself is still a consistent projection of the moment seq=current.seq (it was not touched this frame),
      // Therefore, base is still legal - re-subscribe and let the server decide whether to continue the transmission or the full amount; if the interruption occurs in the subscribe
      // On the resume resume frame (the server has ruled once but still not connected), the base is lost to force the snapshot to prevent loops.
      logger.warn(
        `[v4-store] ${this.topic} frame gap fromSeq=${frame.fromSeq} local=${current?.seq ?? "none"}, resubscribing`,
      );
      if (context.subscribeMode !== null) {
        // The resume initial of fresh subscribe is still out of stock, and the replacement subscription is forced to take a snapshot; active
        // The subscription's online/recovery gap remains same-sub.
        void this.connect({ forceSnapshot: true });
      } else {
        this.requestRecovery(context.recovery);
      }
      return;
    }
    const applied = applyConversationDeltas(current, frame.payload.deltas);
    // seq is the snapshot alignment water level, and the delta frame is advanced to the right endpoint of the frame after application.
    const next = { ...applied, seq: frame.toSeq };
    logSubagentProjectionTransition(this.topic, current, next, "deltas");
    const removedFromRowId = frame.payload.deltas.reduce<number | null>(
      (earliest, delta) =>
        delta.op === "row.removed"
          ? Math.min(earliest ?? delta.fromRowId, delta.fromRowId)
          : earliest,
      null,
    );
    this.setState({
      snapshot: next,
      // row.removed has given the authoritative pruning boundary and can simultaneously delete the old branch plan in the cache directory;
      // The full query continues to be responsible for patching back earlier plans that are outside the wire tail but still belong to the current branch.
      ...(removedFromRowId === null
        ? {}
        : {
            sessionPlans: this.state.sessionPlans.filter((row) => row.rowId < removedFromRowId),
          }),
      ...(shouldInvalidatePlanDirectory(frame)
        ? { planDirectoryRevision: this.state.planDirectoryRevision + 1 }
        : {}),
      // real-user query addition and deletion (row.appended/row.upserted hits realUser userInput,
      // or row.removed to truncate the branch) increment the navigation directory revision, invalidating the final state cache to allow reprobing.
      ...(shouldInvalidateTurnNavigatorDirectory(frame)
        ? {
            turnNavigatorDirectoryRevision: this.state.turnNavigatorDirectoryRevision + 1,
          }
        : {}),
    });
    this.subscriptionHasAppliedBase = true;
    this.reconcileOptimistic(next);
    this.reconcileAcceptedInputProjection(next);
    this.observeModelTransition(next, context.online);
    if (context.recovery) this.markRecoveryFrameSeen();
  }

  private observeModelTransition(snapshot: ConversationSnapshot, online: boolean): void {
    const transition = snapshot.modelTransition;
    const eventId = transition?.eventId ?? null;
    if (eventId === this.observedModelTransitionEventId) return;
    // The persistent transition will be replayed with the initial/recovery snapshot; if the ID is only remembered during the toast,
    // Subsequent normal online snapshots will mistake the old fallback for the new event. All legal frames update the observation baseline,
    // Only the first live online transition is notified to the current client.
    this.observedModelTransitionEventId = eventId;
    if (!online || !transition) return;
    for (const listener of this.modelTransitionListeners) listener(transition);
  }

  /**
   * physical assembly fault: the old projection stays visible and recovery runs single-flight on
   * the active sub.
   */
  handleAssemblyFault(
    subscriptionId: string,
    deliveryKind?: TopicFrameDeliveryKind,
    reasonCode?: string,
  ): void {
    if (this.closed || subscriptionId !== this.state.subscriptionId) return;
    if (
      this.awaitingInitial?.subscriptionId === subscriptionId &&
      (deliveryKind === "initial" || deliveryKind === "recovery" || deliveryKind === undefined)
    ) {
      this.awaitingInitial = null;
    }
    // Content deterministic failure will not enter the transient ladder (04-sync closure rule 11): resume will only invest the same batch of delta again,
    // It will inevitably be rejected again; deliveryKind will not change the conclusion - I cannot understand this content. The only thing that might produce different bytes is
    // Force snapshot, so jump directly to it and stop if it is rejected by the content, so as not to burn the subscription on retries that will inevitably fail.
    if (isDeterministicContentFault(reasonCode)) {
      this.requestRecovery(true, { contentFault: true });
      return;
    }
    // Missing/fake deliveryKind will arrive with undefined typed fault; if recovery is already on the way,
    // It must fail closed/upgrade, and bad recovery cannot be treated as a normal burst and wait forever.
    const recoveryFault =
      deliveryKind === "recovery" || (deliveryKind === undefined && this.recovery !== null);
    if (deliveryKind === "online" && this.recovery) {
      this.recovery.postRecoveryGapPending ||= this.recovery.validFrameSeen;
      return;
    }
    this.requestRecovery(recoveryFault);
  }

  private requestRecovery(recoveryEvent = false, options: { contentFault?: boolean } = {}): void {
    if (this.closed) return;
    const subscriptionId = this.state.subscriptionId;
    if (!subscriptionId) {
      void this.connect({ forceSnapshot: true });
      return;
    }
    const contentFault = options.contentFault === true;
    const existing = this.recovery;
    if (existing) {
      // Once a content failure occurs in this flight, the final state is content failure: subsequent transient faults should not whitewash it.
      if (contentFault) existing.contentFault = true;
      if (!recoveryEvent) return;
      if (existing.forceSnapshot) {
        this.failRecovery("fault.subscription.recoveryFailed");
        return;
      }
      // recovery logical/fault can precede ACK Promise continuation; remember upgrade intent,
      // Force snapshot immediately after ACK=resume. Normal burst gap does not set this flag.
      if (existing.requestInFlight || !existing.ackReceived) {
        existing.upgradePending = true;
        return;
      }
      if (existing.ackMode === "resume") this.issueRecovery(existing, true);
      else this.failRecovery("fault.subscription.recoveryFailed");
      return;
    }
    const recovery = {
      subscriptionId,
      requestInFlight: false,
      ackReceived: false,
      validFrameSeen: false,
      upgradePending: false,
      ackMode: null,
      forceSnapshot: false,
      postRecoveryGapPending: false,
      frameDeadline: null,
      contentFault,
    };
    this.recovery = recovery;
    // If the content fails, skip the resume file and directly force the snapshot; if the transient fails, try the resume first according to the original step.
    this.issueRecovery(recovery, contentFault);
  }

  private issueRecovery(
    recovery: NonNullable<ConversationProjectionStore["recovery"]>,
    forceSnapshot: boolean,
  ): void {
    this.clearRecoveryDeadline(recovery);
    const snapshot = this.state.snapshot;
    const effectiveForceSnapshot = forceSnapshot || !this.subscriptionHasAppliedBase;
    recovery.requestInFlight = true;
    recovery.ackReceived = false;
    recovery.ackMode = null;
    recovery.upgradePending = false;
    recovery.validFrameSeen = false;
    recovery.forceSnapshot = effectiveForceSnapshot;
    recovery.postRecoveryGapPending = false;
    void this.transport
      .resync({
        subscriptionId: recovery.subscriptionId,
        base:
          this.subscriptionHasAppliedBase && snapshot
            ? { logEpoch: snapshot.logEpoch, seq: snapshot.seq }
            : null,
        ...(effectiveForceSnapshot ? { forceSnapshot: true } : {}),
      })
      .then((result) => {
        if (this.closed || this.recovery !== recovery) return;
        if (result.ack.subscriptionId !== recovery.subscriptionId) {
          throw new Error("fault.subscription.resyncGenerationMismatch");
        }
        recovery.requestInFlight = false;
        recovery.ackReceived = true;
        recovery.ackMode = result.ack.mode;
        this.settleRecovery(recovery);
      })
      .catch((error) => {
        if (this.closed || this.recovery !== recovery) return;
        this.clearRecoveryDeadline(recovery);
        this.recovery = null;
        const message = error instanceof Error ? error.message : String(error);
        logger.warn(`[v4-store] resync ${this.topic} failed: ${message}`);
        if (message.includes("fault.subscription.notOwned")) {
          // Online event: notOwned means that a certain layer no longer recognizes this subscription
          // ownership (scope replacement, silent expulsion, misaligned unsubscribe and other status differences), is a deterministic failure
          // It is not a transient failure; manual reconnection such as stopping at error will cause the session to be permanently stuck. The local snapshot is still consistent
          // Projection, with the current water level fresh subscribe is determined by the server resume/snapshot (04-sync rule 3),
          // Complete self-healing. Only special judgment is given for notOwned to avoid transient errors causing reconnection storms.
          void this.connect();
          return;
        }
        this.setState({ status: "error", lastError: message });
      });
  }

  private markRecoveryFrameSeen(): void {
    const recovery = this.recovery;
    if (!recovery) return;
    recovery.validFrameSeen = true;
    this.settleRecovery(recovery);
  }

  private settleRecovery(recovery: NonNullable<ConversationProjectionStore["recovery"]>): void {
    if (this.recovery !== recovery || !recovery.ackReceived || recovery.requestInFlight) return;
    if (recovery.upgradePending) {
      this.clearRecoveryDeadline(recovery);
      if (!recovery.forceSnapshot && recovery.ackMode === "resume") {
        this.issueRecovery(recovery, true);
      } else {
        this.failRecovery("fault.subscription.recoveryFailed");
      }
      return;
    }
    if (recovery.validFrameSeen) {
      this.clearRecoveryDeadline(recovery);
      if (recovery.postRecoveryGapPending) {
        this.issueRecovery(recovery, false);
      } else {
        this.recovery = null;
      }
      return;
    }
    if (recovery.frameDeadline) return;
    recovery.frameDeadline = setTimeout(() => {
      recovery.frameDeadline = null;
      if (this.closed || this.recovery !== recovery || recovery.validFrameSeen) return;
      if (!recovery.forceSnapshot) this.issueRecovery(recovery, true);
      else
        this.failRecovery("fault.subscription.recoveryFrameTimedOut", { contentEligible: false });
    }, PROTOCOL_V4_LIMITS.logicalFrameAssemblyTimeoutMs);
  }

  private clearRecoveryDeadline(
    recovery: NonNullable<ConversationProjectionStore["recovery"]>,
  ): void {
    if (!recovery.frameDeadline) return;
    clearTimeout(recovery.frameDeadline);
    recovery.frameDeadline = null;
  }

  private discardRecovery(): void {
    if (this.recovery) this.clearRecoveryDeadline(this.recovery);
    this.recovery = null;
  }

  /**
   * `contentEligible: false` is for **timeout** terminal states: a deadline that never saw a
   * recovery frame is a transport symptom, so even when this flight started out as a content
   * failure it must not be relabelled as contentRejected — that would also cancel a retry that is
   * still meaningful.
   */
  private failRecovery(reasonCode: string, options: { contentEligible?: boolean } = {}): void {
    if (!this.recovery) return;
    // Content deterministic failures must be distinguishable from transmission failures: reconnections will not improve the former, and telemetry should not be aggregated once when aggregating by code
    // Version mismatch is read as network jitter (see wire-fault.ts for reasonCode vocabulary).
    const contentFault = this.recovery.contentFault && options.contentEligible !== false;
    const code = contentFault ? SUBSCRIPTION_CONTENT_REJECTED : reasonCode;
    this.discardRecovery();
    logger.warn(`[v4-store] ${this.topic} recovery fail-closed: ${code}`);
    this.setState({ status: "error", lastError: code });
  }

  private handleRuntimeRestart(reason?: "runtimeRestart" | "transportReplaced"): void {
    if (this.closed) return;
    // The transport has expired the old ownership/assembler first; the old transport/runtime subId must no longer be unsubscribed.
    // Directly fresh subscribe, retaining the old snapshot until the new snapshot is atomically replaced.
    this.generation += 1;
    this.discardRecovery();
    this.awaitingInitial = null;
    this.subscriptionHasAppliedBase = false;
    this.setState({ status: "connecting", subscriptionId: null });
    // Proxy handoff is not equal to CLI runtime restart; forcing snapshot will remove the user's loaded
    // Replace older rows back with tail window. handoff retains the consistent projection water level, which is determined by the server
    // logEpoch/seq rules resume or snapshot; real runtime restart remains full subscribe.
    if (reason === "transportReplaced") void this.connect();
    else void this.connect({ forceSnapshot: true });
  }

  /**
   * loadOlder: uses the window's first row as a cursor to pull one window of history rows upwards
   * and prepend them.
   * - Single-flight: repeated calls while in flight are a no-op (loadingOlder guards re-entrancy);
   * - Stale-read protection: a result whose atLogEpoch differs from the current snapshot's epoch is
   *   discarded wholesale (across a CLI restart);
   * - Merging is keyed by rowId: it is naturally consistent with the subscription stream's
   *   row.upserted/removed, and delta frames that arrive in flight are unaffected (they only touch
   *   rows at or after the window's first row).
   */
  async loadOlder(limit: number = PROTOCOL_V4_LIMITS.snapshotTailWindowRows): Promise<void> {
    if (this.closed || this.state.loadingOlder) return;
    const snapshot = this.state.snapshot;
    if (!hasOlderRows(snapshot) || !snapshot) return;
    const sessionId = parseConversationTopic(this.topic);
    if (!sessionId) return;
    const beforeRowId = snapshot.rows.window[0]?.rowId;
    if (beforeRowId === undefined) return;
    this.setState({ loadingOlder: true });
    try {
      const result = await this.transport.rowsRange({
        sessionId,
        beforeRowId,
        limit,
      });
      if (this.closed) return;
      const current = this.state.snapshot;
      if (!current || result.atLogEpoch !== current.logEpoch) {
        logger.warn(
          `[v4-store] ${this.topic} rows/range log epoch mismatch (${result.atLogEpoch}), discarding the whole result`,
        );
        return;
      }
      // The cursor becomes invalid while in transit (row.removed truncates/snapshot resync replaces the whole) → the result is invalidated,
      // Prevent historical rows that have been removed from the authoritative side from being resurrected; press the new window to pull them again next time it is triggered.
      if (current.rows.window[0]?.rowId !== beforeRowId) return;
      const window = mergeOlderRows(current.rows.window, result.rows);
      if (window === null) return;
      this.setState({
        snapshot: { ...current, rows: { ...current.rows, window } },
      });
    } catch (error) {
      // query is read-only and can be resent: it will not enter the error state if it fails, leaving it to be retried next time it is triggered.
      logger.warn(
        `[v4-store] rowsRange ${this.topic} failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      if (!this.closed) this.setState({ loadingOlder: false });
    }
  }

  /**
   * The complete question catalog: follows the existing rows/range cursor to fill in the currently
   * valid branch in one pass.
   *
   * Question navigation used to scan the renderer's tail window directly, so a 1000-turn session
   * only showed the few dozen turns that had been loaded. Here the pages are read up to the
   * protocol limit, but the snapshot is swapped only once after every page has succeeded, so that
   * the timeline render units and both virtualizers are not rebuilt every 200 rows.
   */
  async loadAllOlder(): Promise<ConversationTurnNavigatorHydrationResult> {
    const stale = (logEpoch = this.state.snapshot?.logEpoch ?? "unknown") => ({
      status: "stale" as const,
      logEpoch,
    });
    if (this.closed || this.state.loadingOlder) return stale();
    const snapshot = this.state.snapshot;
    if (!snapshot) return stale();
    // The final state must match both logEpoch and directoryRevision. logEpoch represents log generation,
    // It does not mean that the content is static - real-user query additions and deletions will increment the revision, invalidating the final state and allowing re-exploration.
    const directoryRevision = this.state.turnNavigatorDirectoryRevision;
    if (
      this.turnNavigatorHydrationTerminal?.logEpoch === snapshot.logEpoch &&
      this.turnNavigatorHydrationTerminal.directoryRevision === directoryRevision
    ) {
      return this.turnNavigatorHydrationTerminal;
    }
    if (!hasOlderRows(snapshot)) return stale(snapshot.logEpoch);
    const sessionId = parseConversationTopic(this.topic);
    const initialBeforeRowId = snapshot.rows.window[0]?.rowId;
    if (!sessionId || initialBeforeRowId === undefined) return stale(snapshot.logEpoch);

    const initialLogEpoch = snapshot.logEpoch;
    const preserveIncompleteLeadingTurn = shouldAutoLoadIncompleteLeadingTurn(snapshot, false);
    const pages: ConversationRow[][] = [];
    let beforeRowId = initialBeforeRowId;
    let committed = false;
    this.setState({ loadingOlder: true });
    logger.debug("[v4-store] full question directory: starting to backfill historical rows", {
      beforeRowId,
      loadedRows: snapshot.rows.window.length,
      sessionId,
      totalRows: snapshot.rows.totalCount,
    });

    try {
      while (true) {
        const result = await this.transport.rowsRange({
          sessionId,
          beforeRowId,
          limit: PROTOCOL_V4_LIMITS.rowsRangeMaxLimit,
        });
        if (this.closed) return stale(initialLogEpoch);
        const current = this.state.snapshot;
        if (
          !current ||
          result.atLogEpoch !== initialLogEpoch ||
          current.logEpoch !== initialLogEpoch ||
          current.rows.window[0]?.rowId !== initialBeforeRowId
        ) {
          logger.warn(
            "[v4-store] full question directory: projection cursor invalidated during backfill, discarding the whole batch",
            {
              currentBeforeRowId: current?.rows.window[0]?.rowId,
              expectedBeforeRowId: initialBeforeRowId,
              resultLogEpoch: result.atLogEpoch,
              sessionId,
            },
          );
          return stale(initialLogEpoch);
        }

        const older = result.rows.filter((row) => row.rowId < beforeRowId);
        const nextBeforeRowId = older[0]?.rowId;
        if (nextBeforeRowId === undefined || nextBeforeRowId >= beforeRowId) {
          logger.warn(
            "[v4-store] full question directory: rows/range did not advance the cursor, stopping the backfill",
            {
              beforeRowId,
              hasMore: result.hasMore,
              sessionId,
            },
          );
          return { status: "retryable-failure", logEpoch: initialLogEpoch };
        }
        pages.push(older);
        beforeRowId = nextBeforeRowId;
        if (!result.hasMore) break;
      }

      const current = this.state.snapshot;
      if (
        !current ||
        current.logEpoch !== initialLogEpoch ||
        current.rows.window[0]?.rowId !== initialBeforeRowId
      ) {
        return stale(initialLogEpoch);
      }
      const olderRows = [...pages].reverse().flat();
      const realUserQueryCount = [...olderRows, ...current.rows.window].reduce(
        (count, row) => (row.kind === "userInput" && row.origin === "realUser" ? count + 1 : count),
        0,
      );
      if (realUserQueryCount < 2) {
        if (preserveIncompleteLeadingTurn) {
          const window = mergeOlderRows(current.rows.window, olderRows);
          if (window === null) return stale(initialLogEpoch);
          committed = true;
          this.setState({
            loadingOlder: false,
            snapshot: { ...current, rows: { ...current.rows, window } },
          });
          // The navigator has obtained the authoritative rows needed to complete the first round and must submit them before hiding the rail.
          logger.debug(
            "[v4-store] full question directory: fewer than two queries, keeping the rows hydrated for the leading turn",
            {
              loadedRows: window.length,
              pages: pages.length,
              sessionId,
            },
          );
        }
        // The wire snapshot only retains the last 60 rows, and the 0/1 query in the tail cannot be proved.
        // The complete branch is also a single query. The wide screen must detect the starting point of the branch; after confirming that there are less than two branches, the detection page will not be merged.
        // Avoid persisting the full history of the renderer projection for a rail that won't be displayed.
        logger.debug(
          "[v4-store] full question directory: still fewer than two queries after probing",
          {
            pages: pages.length,
            preservedIncompleteLeadingTurn: preserveIncompleteLeadingTurn,
            realUserQueryCount,
            sessionId,
          },
        );
        const result = {
          status: "not-enough-queries" as const,
          logEpoch: initialLogEpoch,
          directoryRevision,
        };
        this.turnNavigatorHydrationTerminal = result;
        return result;
      }
      const window = mergeOlderRows(current.rows.window, olderRows);
      if (window === null) return stale(initialLogEpoch);
      committed = true;
      this.setState({
        loadingOlder: false,
        snapshot: { ...current, rows: { ...current.rows, window } },
      });
      logger.debug("[v4-store] full question directory: historical rows backfill complete", {
        loadedRows: window.length,
        pages: pages.length,
        sessionId,
      });
      const result = {
        status: "hydrated" as const,
        logEpoch: initialLogEpoch,
        directoryRevision,
      };
      this.turnNavigatorHydrationTerminal = result;
      return result;
    } catch (error) {
      logger.warn(
        `[v4-store] full question directory rowsRange ${this.topic} failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return { status: "retryable-failure", logEpoch: initialLogEpoch };
    } finally {
      if (!this.closed && !committed) this.setState({ loadingOlder: false });
    }
  }

  /**
   * Coalesces concurrent plan-catalog queries by the local invalidation revision. An old plan may
   * predate the snapshot tail; at the same time a row.removed from a concurrent edit/retry
   * instantly expires an in-flight query, so it must be validated on both revision and epoch — an
   * old branch's plan must never be written back into the UI.
   */
  async refreshPlans(): Promise<void> {
    if (this.closed) return;
    if (this.planQueryInFlight) {
      this.planQueryPending = true;
      return;
    }
    const snapshot = this.state.snapshot;
    const sessionId = parseConversationTopic(this.topic);
    if (!snapshot || !sessionId) return;
    const requestedGeneration = this.generation;
    const requestedRevision = this.state.planDirectoryRevision;
    this.planQueryInFlight = true;
    this.setState({ plansLoading: true });
    try {
      const result = await this.transport.plans({ sessionId });
      if (this.closed) return;
      if (this.generation !== requestedGeneration) return;
      const current = this.state.snapshot;
      if (!current || current.logEpoch !== result.atLogEpoch) {
        return;
      }
      if (this.state.planDirectoryRevision !== requestedRevision) {
        this.planQueryPending = true;
        return;
      }
      this.setState({ sessionPlans: result.plans });
    } catch (error) {
      if (!this.closed) {
        logger.warn(
          `[v4-store] plans ${this.topic} failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    } finally {
      this.planQueryInFlight = false;
      if (!this.closed) this.setState({ plansLoading: false });
      if (this.planQueryPending && !this.closed) {
        this.planQueryPending = false;
        void this.refreshPlans();
      }
    }
  }

  /** Registers the overlay before the command goes upstream (for pending/stopping display). */
  markCommandPending(command: OptimisticCommand): void {
    if (this.closed) return;
    this.setState({
      optimisticCommands: [...this.state.optimisticCommands, command],
    });
  }

  /**
   * After an accepted/duplicate ACK, registers the input command that "must be visible in the
   * authoritative projection".
   *
   * The command RPC and the conversation topic are two independent paths, and a gap can only be
   * discovered by receiving a later delta: if the topic goes completely silent after the ACK, the
   * CLI keeps working but the UI never gets the user row. No message is fabricated here — the
   * existing same-sub recovery is reused after a bounded window, and as soon as a queue/user row
   * shows up in the authoritative projection the watchdog closes immediately.
   */
  expectAcceptedInputProjection(commandId: string): void {
    if (this.closed || this.acceptedInputProjectionTimers.has(commandId)) return;
    const command = this.state.optimisticCommands.find((item) => item.commandId === commandId);
    if (!command || !ACCEPTED_INPUT_COMMAND_TYPES.has(command.type)) return;
    if (hasAcceptedInputProjection(this.state.snapshot, commandId)) {
      this.settleCommand(commandId);
      return;
    }
    const timer = setTimeout(() => {
      this.acceptedInputProjectionTimers.delete(commandId);
      if (
        this.closed ||
        !this.state.optimisticCommands.some((item) => item.commandId === commandId)
      ) {
        return;
      }
      if (hasAcceptedInputProjection(this.state.snapshot, commandId)) {
        this.settleCommand(commandId);
        return;
      }
      logger.warn("[v4-store] accepted input projection silent, trigger same-sub recovery", {
        commandId,
        topic: this.topic,
      });
      this.requestRecovery();
    }, ACCEPTED_INPUT_PROJECTION_GRACE_MS);
    this.acceptedInputProjectionTimers.set(commandId, timer);
  }

  private clearAcceptedInputProjectionWatch(commandId: string): void {
    const timer = this.acceptedInputProjectionTimers.get(commandId);
    if (timer !== undefined) clearTimeout(timer);
    this.acceptedInputProjectionTimers.delete(commandId);
  }

  /** Removes the overlay when the command is locally settled by a rejection/failure. */
  settleCommand(commandId: string): void {
    this.clearAcceptedInputProjectionWatch(commandId);
    const remaining = this.state.optimisticCommands.filter(
      (command) => command.commandId !== commandId,
    );
    if (remaining.length !== this.state.optimisticCommands.length) {
      this.setState({ optimisticCommands: remaining });
    }
  }

  // If the server-side projection appears with the same commandId (pendingCommands / userInput.sourceCommandId anchor), it means that the authoritative side has taken over the display, and the overlay entry has exited.
  private reconcileOptimistic(snapshot: ConversationSnapshot): void {
    if (this.state.optimisticCommands.length === 0) return;
    const acknowledged = new Set<string>(
      snapshot.pendingCommands.map((command) => command.commandId),
    );
    const inputProjectionIds = new Set<string>();
    for (const item of snapshot.queue.items) {
      inputProjectionIds.add(item.sourceCommandId);
    }
    for (const row of snapshot.rows.window) {
      if (row.kind === "userInput" && row.sourceCommandId) {
        acknowledged.add(row.sourceCommandId);
        if (row.origin === "realUser") inputProjectionIds.add(row.sourceCommandId);
      }
    }
    const remaining = this.state.optimisticCommands.filter((command) =>
      ACCEPTED_INPUT_COMMAND_TYPES.has(command.type)
        ? !inputProjectionIds.has(command.commandId)
        : !acknowledged.has(command.commandId),
    );
    if (remaining.length !== this.state.optimisticCommands.length) {
      this.setState({ optimisticCommands: remaining });
    }
  }

  private reconcileAcceptedInputProjection(snapshot: ConversationSnapshot): void {
    for (const commandId of this.acceptedInputProjectionTimers.keys()) {
      if (!hasAcceptedInputProjection(snapshot, commandId)) continue;
      this.clearAcceptedInputProjectionWatch(commandId);
      this.settleCommand(commandId);
    }
  }

  /** In-memory diagnostics: the current row count of rows.window; read-only. */
  countProjectionRows(): number {
    return this.state.snapshot?.rows.window.length ?? 0;
  }

  /** Unsubscribes and finalizes this store (called only by SessionDataLayer). */
  async close(): Promise<void> {
    if (this.closed) return;
    liveProjectionStores.delete(this);
    const closeStartedAt = monotonicNow();
    logger.lifecycle.info("v4 conversation store close started", {
      event: "v4.conversation.store.close.started",
      generation: this.generation,
      module: "ui.v4.conversation_projection_store",
      status: "started",
      subscriptionId: this.state.subscriptionId,
      topic: this.topic,
    });
    this.closed = true;
    this.offAssemblyFault();
    this.offRuntimeRestart?.();
    this.offRuntimeLifecycle?.();
    this.clearRuntimeRecycleRetry();
    for (const timer of this.acceptedInputProjectionTimers.values()) clearTimeout(timer);
    this.acceptedInputProjectionTimers.clear();
    this.modelTransitionListeners.clear();
    this.discardRecovery();
    this.awaitingInitial = null;
    this.subscriptionHasAppliedBase = false;
    this.generation++;
    const { subscriptionId } = this.state;
    this.setState({ status: "closed", subscriptionId: null });
    if (subscriptionId) {
      try {
        await this.transport.unsubscribe(subscriptionId);
      } catch (error) {
        logger.lifecycle.warn("v4 conversation store close unsubscribe failed", {
          durationMs: roundedDuration(closeStartedAt, monotonicNow()),
          errorMessage: error instanceof Error ? error.message : String(error),
          event: "v4.conversation.store.close.unsubscribe_failed",
          module: "ui.v4.conversation_projection_store",
          status: "failed",
          subscriptionId,
          topic: this.topic,
        });
        logger.warn(`[v4-store] unsubscribe ${this.topic} failed (ignored): ${String(error)}`);
      }
    }
    logger.lifecycle.info("v4 conversation store close completed", {
      durationMs: roundedDuration(closeStartedAt, monotonicNow()),
      event: "v4.conversation.store.close.completed",
      module: "ui.v4.conversation_projection_store",
      status: "completed",
      topic: this.topic,
    });
  }
}
