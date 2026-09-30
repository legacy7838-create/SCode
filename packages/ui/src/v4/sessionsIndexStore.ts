/* eslint-disable max-lines -- the index projection, the applied base, and the recovery flight must
 * all be adjudicated by the same atomic store.
 */
// The renderer read-only store of sessions-index topic:
// The snapshot frame is fully replaced; the delta frame is only applied when the interval is connected (frame.fromSeq === watermark).
// No guessing or caching compensation for broken files - re-subscription is left to the server to decide whether to resume or complete the download (same strategy as ConversationProjectionStore).
import {
  isDeterministicContentFault,
  PROTOCOL_V4_LIMITS,
  SUBSCRIPTION_CONTENT_REJECTED,
  type SessionSummary,
  type SessionsIndexTopicFrame,
  type TopicFrameDeliveryKind,
} from "@zcode/shared/zcode-protocol-v4";
import { isZCodeFileLockTimeoutError } from "@zcode/shared";
import { ZCODE_AGENT_RUNTIME_UNAVAILABLE_CODE } from "@zcode/services";
import { logger } from "@/logger.js";
import type { SessionsIndexTransport } from "@/v4/agentSessionsIndexTransport.js";

interface SessionsIndexState {
  /** workspaceId → known; null = no snapshot yet. */
  workspaceId: string | null;
  logEpoch: string | null;
  /** The frame range watermark (= the toSeq of the most recent frame). */
  seq: number;
  /** Conversation summaries, indexed by sessionId (conflated). */
  sessions: Map<string, SessionSummary>;
}

const EMPTY_SESSIONS_INDEX_STATE: SessionsIndexState = {
  workspaceId: null,
  logEpoch: null,
  seq: 0,
  sessions: new Map(),
};

export type SessionsIndexStoreStatus = "idle" | "dormant" | "connecting" | "live" | "error";

const RUNTIME_RESTART_RECONNECT_BASE_DELAY_MS = 100;
const RUNTIME_RESTART_RECONNECT_MAX_DELAY_MS = 5_000;
const RUNTIME_RESTART_BURST_RESET_MS = 30_000;
const TRANSIENT_SUBSCRIBE_RETRY_DELAYS_MS = [250, 1_000, 3_000] as const;
const ERROR_RECOVERY_RETRY_DELAYS_MS = [5_000, 15_000, 60_000] as const;

function isTransientSubscribeError(error: unknown): boolean {
  if (isZCodeFileLockTimeoutError(error)) {
    return true;
  }
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? String((error as { code?: unknown }).code ?? "")
      : "";
  const message = error instanceof Error ? error.message : String(error);
  if (["EBUSY", "EMFILE", "ENFILE"].includes(code)) {
    return true;
  }
  if (code === "EEXIST" && message.includes("config.json.lock")) {
    return true;
  }
  return /\b(?:EBUSY|EMFILE|ENFILE)\b/.test(message) || message.includes("config.json.lock");
}

function isRuntimeUnavailableError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === ZCODE_AGENT_RUNTIME_UNAVAILABLE_CODE
  );
}

async function unsubscribeIgnoringFailure(
  transport: SessionsIndexTransport,
  subscriptionId: string,
): Promise<void> {
  try {
    await transport.unsubscribe(subscriptionId);
  } catch (error) {
    // After the service proxy is replaced, the old store cleanup will still hit the disconnected RPC.
    // Cleanup failure cannot become unhandled rejection, nor can it affect the new generation of registry entries.
    logger.warn(
      `[v4-sessions-index] unsubscribe ${subscriptionId} failed (ignored): ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

interface ApplySessionsIndexResult {
  state: SessionsIndexState;
  /**
   * true = the frame range has a gap (fromSeq does not join the watermark); callers should
   * resubscribe.
   */
  gap: boolean;
}

/**
 * Pure apply: a snapshot replaces everything wholesale; deltas upsert/remove item by item only when
 * they join.
 */
export function applySessionsIndexFrame(
  current: SessionsIndexState,
  frame: SessionsIndexTopicFrame,
): ApplySessionsIndexResult {
  if (frame.payload.kind === "snapshot") {
    const snapshot = frame.payload.snapshot;
    const sessions = new Map<string, SessionSummary>();
    for (const session of snapshot.sessions) {
      sessions.set(session.sessionId, session);
    }
    return {
      gap: false,
      state: {
        workspaceId: snapshot.workspaceId,
        logEpoch: snapshot.logEpoch,
        seq: frame.toSeq,
        sessions,
      },
    };
  }
  if (frame.toSeq <= current.seq) {
    return { state: current, gap: false };
  }
  // deltas: The intervals must be connected (fromSeq === current water level), otherwise the file will be broken.
  if (frame.fromSeq !== current.seq) {
    return { state: current, gap: true };
  }
  const sessions = new Map(current.sessions);
  for (const delta of frame.payload.deltas) {
    if (delta.op === "session.upserted") {
      sessions.set(delta.session.sessionId, delta.session);
    } else {
      sessions.delete(delta.sessionId);
    }
  }
  return {
    gap: false,
    state: { ...current, seq: frame.toSeq, sessions },
  };
}

/**
 * A read-only store compatible with useSyncExternalStore: subscribe + getState return stable
 * references. The state body and the pure applyFrame can be unit tested independently; the
 * transport binding (connect/handleFrame/close) owns the subscription lifecycle and resubscribing
 * after a gap.
 */
export class SessionsIndexStore {
  private state: SessionsIndexState = EMPTY_SESSIONS_INDEX_STATE;
  private readonly listeners = new Set<() => void>();
  /**
   * A cached ordered list (getSessions returns a stable reference, so a new array never triggers a
   * re-render).
   */
  private cachedList: SessionSummary[] | null = null;
  // Transport binding (optional: not required for pure applyFrame single testing).
  private transport: SessionsIndexTransport | null = null;
  private frameUnsub: (() => void) | null = null;
  private faultUnsub: (() => void) | null = null;
  private restartUnsub: (() => void) | null = null;
  private lifecycleUnsub: (() => void) | null = null;
  private subscriptionId: string | null = null;
  private awaitingInitial: { subscriptionId: string; mode: "snapshot" | "resume" } | null = null;
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
     * This flight was started for a deterministic content failure: the terminal state is
     * contentRejected, and it no longer resubscribes with unbounded backoff.
     */
    contentFault: boolean;
  } | null = null;
  private status: SessionsIndexStoreStatus = "idle";
  private generation = 0;
  private closed = false;
  private runtimeRestartReconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private runtimeRestartBurstCount = 0;
  private lastRuntimeRestartAt = 0;
  private subscribeRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private errorRecoveryRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private errorRecoveryRetryAttempt = 0;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getState = (): SessionsIndexState => this.state;

  getStatus(): SessionsIndexStoreStatus {
    return this.status;
  }

  /**
   * Bind the transport and start the subscription: register the frame listener + subscribe
   * (watermark invariant: only pass a base when we truly hold consistent state). A gapped frame →
   * drop the base and resubscribe (triggered by handleFrame). After close, connect can run again
   * (React effect unmount/remount — StrictMode's double invoke — revives through the same path).
   */
  async connect(
    transport: SessionsIndexTransport,
    options: {
      forceSnapshot?: boolean;
      initialOverflowRetry?: boolean;
      subscribeRetryAttempt?: number;
      errorRecoveryRetryAttempt?: number;
    } = {},
  ): Promise<void> {
    if (this.runtimeRestartReconnectTimer) {
      clearTimeout(this.runtimeRestartReconnectTimer);
      this.runtimeRestartReconnectTimer = null;
    }
    this.clearSubscribeRetry();
    if (options.errorRecoveryRetryAttempt === undefined) {
      this.clearErrorRecoveryRetry();
      this.errorRecoveryRetryAttempt = 0;
    }
    this.closed = false;
    this.transport = transport;
    if (!this.frameUnsub) {
      this.frameUnsub = transport.onFrame((frame, context) => this.handleFrame(frame, context));
      this.faultUnsub = transport.onAssemblyFault((fault) => {
        if (fault.subscriptionId === this.subscriptionId) {
          this.handleAssemblyFault(fault.subscriptionId, fault.deliveryKind, fault.reasonCode);
        }
      });
      if (transport.onRuntimeLifecycle) {
        this.lifecycleUnsub = transport.onRuntimeLifecycle((state) => {
          if (state === "available") this.handleRuntimeAvailable();
          else this.handleRuntimeUnavailable();
        });
      } else {
        this.restartUnsub = transport.onRuntimeRestart(() => this.handleRuntimeRestart());
      }
    }
    const generation = ++this.generation;
    this.discardRecovery();
    this.status = "connecting";
    this.emit();
    const base =
      options.forceSnapshot || this.state.logEpoch === null
        ? undefined
        : { logEpoch: this.state.logEpoch, seq: this.state.seq };
    try {
      const result = await transport.subscribe(base ? { base } : {});
      if (generation !== this.generation || this.closed) {
        void unsubscribeIgnoringFailure(transport, result.ack.subscriptionId);
        return;
      }
      // Same reason as conversationProjectionStore.connect (online notOwned stuck):
      // Old subscriptions within the await window of subscribe ACK may still create same-sub recovery, while the host scope is
      // Old ownership has been silently evicted when new ACK remember(). If the replacement is successful, the old recovery will be discarded to avoid
      // Late failure will mark live's new subscription as an error.
      this.discardRecovery();
      this.subscriptionId = result.ack.subscriptionId;
      this.status = "live";
      this.clearErrorRecoveryRetry();
      this.errorRecoveryRetryAttempt = 0;
      this.subscriptionHasAppliedBase = Boolean(
        base && result.ack.mode === "resume" && result.ack.logEpoch === base.logEpoch,
      );
      this.awaitingInitial = {
        subscriptionId: result.ack.subscriptionId,
        mode: result.ack.mode,
      };
      // initial only arrives via notification; bind the generation first, then activate to release the early frame before ACK.
      transport.activate(result.ack.subscriptionId);
      this.emit();
    } catch (error) {
      if (generation !== this.generation || this.closed) return;
      this.awaitingInitial = null;
      this.subscriptionHasAppliedBase = false;
      if (isRuntimeUnavailableError(error)) {
        // Passive list subscriptions for restored workspaces treated missing runtimes as ordinary failures and
        // Back off and retry, and finally getClient starts the CLI in batches. dormant waits for lifecycle without timer.
        this.handleRuntimeUnavailable();
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      if (
        message.includes("fault.subscription.initialFrameStagingOverflow") &&
        !options.initialOverflowRetry
      ) {
        await this.connect(transport, {
          forceSnapshot: true,
          initialOverflowRetry: true,
          ...(options.errorRecoveryRetryAttempt !== undefined
            ? { errorRecoveryRetryAttempt: options.errorRecoveryRetryAttempt }
            : {}),
        });
        return;
      }
      const retryAttempt = options.subscribeRetryAttempt ?? 0;
      const retryDelay = TRANSIENT_SUBSCRIBE_RETRY_DELAYS_MS[retryAttempt];
      if (isTransientSubscribeError(error) && retryDelay !== undefined) {
        // The configuration lock of the provider registry may briefly conflict when the host is cold started. If you put
        // The first subscribe failure is permanently fixed as an error, and the aggregation layer immediately publishes an empty list and displays "No conversation yet".
        // Transient file lock errors remain hydrating and resubscribed with bounded backoff; existing snapshots are also retained.
        this.status = "connecting";
        logger.warn(
          `[v4-sessions-index] transient subscribe failure, retrying in ${retryDelay}ms: ${message}`,
        );
        this.subscribeRetryTimer = setTimeout(() => {
          this.subscribeRetryTimer = null;
          if (this.closed || generation !== this.generation) return;
          void this.connect(transport, {
            ...(options.forceSnapshot ? { forceSnapshot: true } : {}),
            subscribeRetryAttempt: retryAttempt + 1,
            ...(options.errorRecoveryRetryAttempt !== undefined
              ? { errorRecoveryRetryAttempt: options.errorRecoveryRetryAttempt }
              : {}),
          });
        }, retryDelay);
        this.emit();
        return;
      }
      this.failAndScheduleRecovery(`subscribe:${message}`);
    }
  }

  /**
   * Replace the transport in place when the remote RPC proxy rotates.
   *
   * First detach the old transport's local listeners synchronously, then force a snapshot from the
   * new transport; the remote unsubscribe is best-effort only and must not block the new proxy from
   * taking over. The server unsubscribes precisely by subscriptionId, so a late cleanup will not
   * delete the new generation. Concurrent rotations are invalidated by the store generation, and
   * the store identity and the last projection stay unchanged.
   */
  async replaceTransport(transport: SessionsIndexTransport): Promise<void> {
    if (!this.closed && this.transport === transport) return;

    const generation = ++this.generation;
    const previous = this.detachTransport();
    this.status = "connecting";
    this.emit();

    if (previous.transport && previous.subscriptionId) {
      // The old RPC may never settle after proxy handoff; waiting for it will allow the new transport to
      // Stopped permanently at connecting. Complete the local detach first, then accurately unsubscribe from the remote end and end it asynchronously.
      void unsubscribeIgnoringFailure(previous.transport, previous.subscriptionId);
    }
    if (generation !== this.generation || this.closed) return;

    await this.connect(transport, { forceSnapshot: true });
  }

  /** Frame routing entry point (initial / online notification). Gap → resubscribe. */
  handleFrame(
    frame: SessionsIndexTopicFrame,
    delivery?: { deliveryKind: TopicFrameDeliveryKind },
  ): void {
    if (this.closed) return;
    // Intergenerational gate: Workspace-level fan-out will also send frames from other subscribers of the same topic here.
    // (The host-side task-index syncer uses an independent connectionId to residently subscribe to sessions-index).
    // If you do not filter by your own subscriptionId, other people's (fromSeq, toSeq] windows will be regarded as broken, triggering a re-subscription storm.
    // own initial when subscriptionId is not in place yet bounded by transport staging; activate after binding
    // Only then released. Other old generation/foreign frames continue to be discarded here.
    if (this.subscriptionId === null || frame.subscriptionId !== this.subscriptionId) {
      return;
    }
    const awaitingInitial =
      this.awaitingInitial?.subscriptionId === frame.subscriptionId ? this.awaitingInitial : null;
    const deliveryKind = delivery?.deliveryKind ?? "online";
    const initial = deliveryKind === "initial" ? awaitingInitial : null;
    if (initial || (deliveryKind === "recovery" && awaitingInitial)) {
      this.awaitingInitial = null;
    }
    if (deliveryKind === "online" && this.recovery && frame.payload.kind === "snapshot") {
      const gap = this.applyFrame(frame);
      if (!gap) this.subscriptionHasAppliedBase = true;
      return;
    }
    if (deliveryKind === "online" && this.recovery) {
      if (frame.toSeq > this.state.seq) {
        this.recovery.postRecoveryGapPending ||= this.recovery.validFrameSeen;
      }
      return;
    }
    if (frame.payload.kind === "deltas" && !this.subscriptionHasAppliedBase) {
      this.requestRecovery(deliveryKind === "recovery");
      return;
    }
    const gap = this.applyFrame(frame);
    if (gap && this.transport) {
      logger.warn(
        `[v4-sessions-index] frame gap fromSeq=${frame.fromSeq} local=${this.state.seq}, resubscribing`,
      );
      if (initial) void this.connect(this.transport, { forceSnapshot: true });
      else this.requestRecovery(deliveryKind === "recovery");
      return;
    }
    this.subscriptionHasAppliedBase = true;
    if (deliveryKind === "recovery") this.markRecoveryFrameSeen();
  }

  private handleAssemblyFault(
    subscriptionId: string,
    deliveryKind?: TopicFrameDeliveryKind,
    reasonCode?: string,
  ): void {
    if (subscriptionId !== this.subscriptionId) return;
    if (
      this.awaitingInitial?.subscriptionId === subscriptionId &&
      (deliveryKind === "initial" || deliveryKind === "recovery" || deliveryKind === undefined)
    ) {
      this.awaitingInitial = null;
    }
    // Content deterministic failure will not enter the transient ladder (04-sync closure rule 11): resume will only resubmit the same batch of rejected content.
    // Jumps directly to the only mandatory snapshot that may produce different bytes; it stops if it is rejected by content. fail of this store
    // closed clears the projection and resubscribes with bounded backoff - a deterministic failure is a resubscription loop that never converges.
    if (isDeterministicContentFault(reasonCode)) {
      this.requestRecovery(true, { contentFault: true });
      return;
    }
    if (deliveryKind === "online" && this.recovery) {
      this.recovery.postRecoveryGapPending ||= this.recovery.validFrameSeen;
      return;
    }
    this.requestRecovery(
      deliveryKind === "recovery" || (deliveryKind === undefined && this.recovery !== null),
    );
  }

  private requestRecovery(recoveryEvent = false, options: { contentFault?: boolean } = {}): void {
    const transport = this.transport;
    const subscriptionId = this.subscriptionId;
    if (this.closed || !transport || !subscriptionId) return;
    const contentFault = options.contentFault === true;
    const existing = this.recovery;
    if (existing) {
      // Once there is a content failure in this flight, the final state will be content failure: subsequent transient faults should not whitewash it.
      if (contentFault) existing.contentFault = true;
      if (!recoveryEvent) return;
      if (existing.forceSnapshot) {
        this.failRecovery("fault.subscription.recoveryFailed");
        return;
      }
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
      ackMode: null as "snapshot" | "resume" | null,
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
    recovery: NonNullable<SessionsIndexStore["recovery"]>,
    forceSnapshot: boolean,
  ): void {
    const transport = this.transport;
    if (!transport) return;
    this.clearRecoveryDeadline(recovery);
    const effectiveForceSnapshot = forceSnapshot || !this.subscriptionHasAppliedBase;
    recovery.requestInFlight = true;
    recovery.ackReceived = false;
    recovery.ackMode = null;
    recovery.validFrameSeen = false;
    recovery.upgradePending = false;
    recovery.forceSnapshot = effectiveForceSnapshot;
    recovery.postRecoveryGapPending = false;
    void transport
      .resync({
        subscriptionId: recovery.subscriptionId,
        base:
          !this.subscriptionHasAppliedBase || this.state.logEpoch === null
            ? null
            : { logEpoch: this.state.logEpoch, seq: this.state.seq },
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
        logger.warn(`[v4-sessions-index] resync failed: ${message}`);
        if (isRuntimeUnavailableError(error)) {
          this.handleRuntimeUnavailable();
          return;
        }
        if (message.includes("fault.subscription.notOwned") && this.transport) {
          // Same reason as conversationProjectionStore.issueRecovery (online event):
          // notOwned is a deterministic failure of ownership status divergence rather than a transient failure. Stopping at error will cause
          // The session list is permanently stuck. With the current water level fresh subscribe is determined by the server resume/snapshot,
          // Complete self-healing. Only special judgment is given for notOwned to avoid transient errors causing reconnection storms.
          void this.connect(this.transport);
          return;
        }
        this.failAndScheduleRecovery(`resync:${message}`);
      });
  }

  private markRecoveryFrameSeen(): void {
    const recovery = this.recovery;
    if (!recovery) return;
    recovery.validFrameSeen = true;
    this.settleRecovery(recovery);
  }

  private settleRecovery(recovery: NonNullable<SessionsIndexStore["recovery"]>): void {
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
      if (recovery.postRecoveryGapPending) this.issueRecovery(recovery, false);
      else this.recovery = null;
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

  private clearRecoveryDeadline(recovery: NonNullable<SessionsIndexStore["recovery"]>): void {
    if (!recovery.frameDeadline) return;
    clearTimeout(recovery.frameDeadline);
    recovery.frameDeadline = null;
  }

  private discardRecovery(): void {
    if (this.recovery) this.clearRecoveryDeadline(this.recovery);
    this.recovery = null;
  }

  private clearSubscribeRetry(): void {
    if (!this.subscribeRetryTimer) return;
    clearTimeout(this.subscribeRetryTimer);
    this.subscribeRetryTimer = null;
  }

  private clearErrorRecoveryRetry(): void {
    if (!this.errorRecoveryRetryTimer) return;
    clearTimeout(this.errorRecoveryRetryTimer);
    this.errorRecoveryRetryTimer = null;
  }

  /**
   * Deterministic content failure: the terminal code is distinguished from a transport failure, and
   * **no backoff resubscription is scheduled** — resubscribing would fetch the very same unreadable
   * content, so this store's backoff would degenerate into a never-converging loop (clear the
   * projection → resubscribe → rejected again → …). Self-healing still has paths: a runtime
   * rotation, a fresh connect, or a user reconnect all resubscribe; only that loop is gone.
   *
   * `contentEligible: false` is for **timeout** terminal states: a deadline that never saw a
   * recovery frame is a transport symptom, so it must not be relabelled as contentRejected, and it
   * must not cancel that still-meaningful retry either.
   */
  private failRecovery(reasonCode: string, options: { contentEligible?: boolean } = {}): void {
    // contentFault must be read before discardRecovery.
    const contentFault = this.recovery?.contentFault === true && options.contentEligible !== false;
    this.failAndScheduleRecovery(contentFault ? SUBSCRIPTION_CONTENT_REJECTED : reasonCode, {
      scheduleRetry: !contentFault,
    });
  }

  /**
   * When recovery/subscribe fails, revoke the live proof of the old projection and re-fetch the
   * authoritative snapshot with bounded backoff. The error stays externally observable; the retry
   * only runs while the transport/runtime still belongs to the current generation.
   *
   * `scheduleRetry: false` is only for deterministic failures: when a retry is bound to produce the
   * same result, it should not be scheduled.
   */
  private failAndScheduleRecovery(
    reasonCode: string,
    options: { scheduleRetry?: boolean } = {},
  ): void {
    const transport = this.transport;
    const previousSubscriptionId = this.subscriptionId;
    this.discardRecovery();
    this.subscriptionId = null;
    this.awaitingInitial = null;
    this.subscriptionHasAppliedBase = false;
    this.state = EMPTY_SESSIONS_INDEX_STATE;
    this.cachedList = null;
    this.status = "error";
    logger.warn(`[v4-sessions-index] recovery fail-closed: ${reasonCode}`);
    if (transport && previousSubscriptionId) {
      void unsubscribeIgnoringFailure(transport, previousSubscriptionId);
    }
    this.clearErrorRecoveryRetry();
    if (transport && !this.closed && options.scheduleRetry !== false) {
      const attempt = this.errorRecoveryRetryAttempt;
      const delayMs =
        ERROR_RECOVERY_RETRY_DELAYS_MS[
          Math.min(attempt, ERROR_RECOVERY_RETRY_DELAYS_MS.length - 1)
        ];
      const nextAttempt = Math.min(attempt + 1, ERROR_RECOVERY_RETRY_DELAYS_MS.length - 1);
      const generation = this.generation;
      this.errorRecoveryRetryAttempt = nextAttempt;
      this.errorRecoveryRetryTimer = setTimeout(() => {
        this.errorRecoveryRetryTimer = null;
        if (this.closed || this.transport !== transport || this.generation !== generation) {
          return;
        }
        void this.connect(transport, {
          forceSnapshot: true,
          errorRecoveryRetryAttempt: nextAttempt,
        });
      }, delayMs);
    }
    this.emit();
  }

  private handleRuntimeRestart(): void {
    if (this.closed || !this.transport) return;
    const transport = this.transport;
    const now = Date.now();
    if (now - this.lastRuntimeRestartAt >= RUNTIME_RESTART_BURST_RESET_MS) {
      this.runtimeRestartBurstCount = 0;
    }
    this.lastRuntimeRestartAt = now;
    const delayMs =
      this.runtimeRestartBurstCount === 0
        ? 0
        : Math.min(
            RUNTIME_RESTART_RECONNECT_BASE_DELAY_MS *
              2 ** Math.min(this.runtimeRestartBurstCount - 1, 16),
            RUNTIME_RESTART_RECONNECT_MAX_DELAY_MS,
          );
    this.runtimeRestartBurstCount += 1;
    this.generation += 1;
    this.clearErrorRecoveryRetry();
    this.errorRecoveryRetryAttempt = 0;
    this.subscriptionId = null;
    this.awaitingInitial = null;
    this.discardRecovery();
    this.subscriptionHasAppliedBase = false;
    if (this.status !== "connecting") {
      this.status = "connecting";
      this.emit();
    }
    if (this.runtimeRestartReconnectTimer) {
      clearTimeout(this.runtimeRestartReconnectTimer);
    }
    // runtimeRestarted cannot connect immediately every time it arrives. If the upstream publishes abnormally and continuously
    // restart, subscribe will trigger the startup of more runtimes in reverse, forming an unlimited reconnection storm. here will burst
    // Merge into one fresh subscribe, and back off exponentially according to the number of consecutive times; after 30 seconds of stabilization, the first hop will be restored and the connection will be reconnected immediately.
    this.runtimeRestartReconnectTimer = setTimeout(() => {
      this.runtimeRestartReconnectTimer = null;
      if (this.closed || this.transport !== transport) return;
      void this.connect(transport, { forceSnapshot: true });
    }, delayMs);
  }

  private handleRuntimeAvailable(): void {
    if (this.closed || !this.transport) return;
    this.handleRuntimeRestart();
  }

  private handleRuntimeUnavailable(): void {
    if (this.closed) return;
    this.generation += 1;
    this.subscriptionId = null;
    this.awaitingInitial = null;
    this.discardRecovery();
    this.subscriptionHasAppliedBase = false;
    this.clearSubscribeRetry();
    this.clearErrorRecoveryRetry();
    this.errorRecoveryRetryAttempt = 0;
    if (this.runtimeRestartReconnectTimer) {
      clearTimeout(this.runtimeRestartReconnectTimer);
      this.runtimeRestartReconnectTimer = null;
    }
    // When the runtime no longer exists, the running/attention of the old summary loses the live proof; the persistent task line is
    // tasks-index reserved, sessions-index projection must be cleared to avoid orphan spinners.
    this.state = EMPTY_SESSIONS_INDEX_STATE;
    this.cachedList = null;
    this.status = "dormant";
    this.emit();
  }

  /** Release the subscription and the listeners (component unmount / workspace switch). */
  close(): void {
    this.closed = true;
    this.generation += 1;
    this.status = "idle";
    const previous = this.detachTransport();
    if (previous.subscriptionId && previous.transport) {
      void unsubscribeIgnoringFailure(previous.transport, previous.subscriptionId);
    }
  }

  private detachTransport(): {
    transport: SessionsIndexTransport | null;
    subscriptionId: string | null;
  } {
    const previous = {
      transport: this.transport,
      subscriptionId: this.subscriptionId,
    };
    if (this.runtimeRestartReconnectTimer) {
      clearTimeout(this.runtimeRestartReconnectTimer);
      this.runtimeRestartReconnectTimer = null;
    }
    this.runtimeRestartBurstCount = 0;
    this.lastRuntimeRestartAt = 0;
    this.clearSubscribeRetry();
    this.clearErrorRecoveryRetry();
    this.errorRecoveryRetryAttempt = 0;
    this.frameUnsub?.();
    this.frameUnsub = null;
    this.faultUnsub?.();
    this.faultUnsub = null;
    this.restartUnsub?.();
    this.restartUnsub = null;
    this.lifecycleUnsub?.();
    this.lifecycleUnsub = null;
    this.transport = null;
    this.subscriptionId = null;
    this.awaitingInitial = null;
    this.discardRecovery();
    this.subscriptionHasAppliedBase = false;
    return previous;
  }

  /** Apply one frame; returns true on a gap (the caller resubscribes). */
  applyFrame(frame: SessionsIndexTopicFrame): boolean {
    const { state, gap } = applySessionsIndexFrame(this.state, frame);
    if (gap) return true;
    if (state !== this.state) {
      this.state = state;
      this.cachedList = null;
      this.emit();
    }
    return false;
  }

  /** Cleared on a gap / reconnect, waiting for a new snapshot. */
  reset(): void {
    this.discardRecovery();
    this.subscriptionHasAppliedBase = false;
    this.state = EMPTY_SESSIONS_INDEX_STATE;
    this.cachedList = null;
    this.emit();
  }

  /**
   * The conversation list (ordered by lastActivityAt descending by default; grouping / pinning
   * belongs to a higher layer).
   */
  getSessions(): SessionSummary[] {
    if (this.cachedList === null) {
      this.cachedList = [...this.state.sessions.values()].sort(
        (a, b) => b.lastActivityAt - a.lastActivityAt,
      );
    }
    return this.cachedList;
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}
