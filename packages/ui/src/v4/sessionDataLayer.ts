// SessionDataLayer (pure data layer).
// Map<topic, SessionStore>; it knows nothing of "display"; lifecycle = reference counting:
// a pane holds a reference → subscribe; the count reaches zero → delayed unsubscribe (keep-warm, to damp drag/pane-switch jitter).
// One instance corresponds to one host connection; cross-workspace split panes are handled at the shell layer with a
// Map<workspaceKey, SessionDataLayer>; this layer is workspace-unaware.
import { ConversationProjectionStore } from "@/v4/conversationProjectionStore.js";
import { shouldExposeE2EStoreBridge } from "@/lib/e2eStoreBridge.js";
import type { SessionOpenKind } from "@/lib/sessionOpenArmsTelemetry.js";
import { conversationTopic, type ConversationTransport } from "@/v4/transport.js";
import { logger } from "@/logger.js";
import type { CommandsQueryParams, CommandsQueryResult } from "@zcode/shared/zcode-protocol-v4";

/** The lease a pane holds; release is idempotent. */
export interface SessionLease {
  readonly sessionId: string;
  readonly store: ConversationProjectionStore;
  /**
   * Decided by the data layer against the projection's lifecycle, so the snapshot is not still
   * empty on the pane's first render.
   */
  readonly openKind: SessionOpenKind;
  /** The start of the Renderer monotonic clock for a pane acquire. */
  readonly startedAt: number;
  release(): void;
}

interface SessionDataLayerOptions {
  transport: ConversationTransport;
  /** Delayed unsubscribe window (ms) after the refcount reaches zero, 30s by default. */
  keepWarmMs?: number;
}

const SESSION_DATA_LAYER_KEEP_WARM_MS = 30_000;
const E2E_SESSION_DATA_LAYER_KEEP_WARM_MS = 1_000;

function resolveSessionDataLayerKeepWarmMs(
  e2eStoreBridgeEnabled = shouldExposeE2EStoreBridge(),
): number {
  return e2eStoreBridgeEnabled
    ? E2E_SESSION_DATA_LAYER_KEEP_WARM_MS
    : SESSION_DATA_LAYER_KEEP_WARM_MS;
}

interface SessionEntry {
  store: ConversationProjectionStore;
  refCount: number;
  keepWarmTimer: ReturnType<typeof setTimeout> | null;
}

function monotonicNow(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

export class SessionDataLayer {
  private readonly transport: ConversationTransport;
  private readonly keepWarmMs: number;
  private readonly entries = new Map<string, SessionEntry>();
  private readonly offFrame: () => void;
  private disposed = false;

  constructor(options: SessionDataLayerOptions) {
    this.transport = options.transport;
    this.keepWarmMs = options.keepWarmMs ?? resolveSessionDataLayerKeepWarmMs();
    // Connection-level single monitoring: fan in to each store by topic (it is this connection that is shared between panes).
    this.offFrame = this.transport.onFrame((frame, context) => {
      this.entries.get(frame.topic)?.store.handleFrame(frame, context);
    });
  }

  /**
   * Gets the projection store for a session. The first reference triggers the subscribe (opening a
   * new pane is one subscribe, on the same path as a refresh or a new device); repeat acquires
   * share the same store (readonly; several panes for one session = several views).
   */
  acquire(sessionId: string): SessionLease {
    if (this.disposed) {
      throw new Error("SessionDataLayer is disposed and can no longer acquire");
    }
    const topic = conversationTopic(sessionId);
    const startedAt = monotonicNow();
    let entry = this.entries.get(topic);
    let openKind: SessionOpenKind;
    if (entry) {
      openKind = entry.keepWarmTimer !== null ? "keep_warm" : "warm";
      entry.refCount++;
      if (entry.keepWarmTimer !== null) {
        clearTimeout(entry.keepWarmTimer);
        entry.keepWarmTimer = null;
      }
    } else {
      const store = new ConversationProjectionStore(topic, this.transport);
      entry = { store, refCount: 1, keepWarmTimer: null };
      this.entries.set(topic, entry);
      openKind = "cold";
      // Subscription failure falls in store.state (status=error + retry()) and is not thrown here.
      void store.connect({ rendererPrepareStartedAt: startedAt });
    }
    logger.lifecycle.info("v4 session data lease acquired", {
      event: "v4.session_data.acquire",
      keepWarm: entry.keepWarmTimer !== null,
      module: "ui.v4.session_data_layer",
      openKind,
      refCount: entry.refCount,
      sessionId,
      status: "completed",
      topic,
    });

    let released = false;
    return {
      sessionId,
      store: entry.store,
      openKind,
      startedAt,
      release: () => {
        if (released) return;
        released = true;
        this.releaseEntry(topic);
      },
    };
  }

  /**
   * Number of currently active sessions (including the keep-warm ones), an observation point for
   * tests and debugging.
   */
  get size(): number {
    return this.entries.size;
  }

  /**
   * Read-only reconciliation entry point for the renderer pending-command registry; it still reuses
   * this layer's single host connection.
   */
  queryCommands(params: CommandsQueryParams): Promise<CommandsQueryResult> {
    return this.transport.queryCommands(params);
  }

  private releaseEntry(topic: string): void {
    const entry = this.entries.get(topic);
    if (!entry) return;
    entry.refCount--;
    if (entry.refCount > 0 || this.disposed) {
      logger.lifecycle.info("v4 session data lease released", {
        event: "v4.session_data.release",
        module: "ui.v4.session_data_layer",
        refCount: entry.refCount,
        status: "completed",
        topic,
      });
      return;
    }
    // Closing a pane ≠ stopping the session: this only unsubscribes the view; the session keeps running in the CLI.
    entry.keepWarmTimer = setTimeout(() => {
      this.entries.delete(topic);
      logger.lifecycle.info("v4 session data keep-warm expired", {
        event: "v4.session_data.keep_warm_expired",
        module: "ui.v4.session_data_layer",
        refCount: 0,
        status: "completed",
        topic,
      });
      void entry.store.close();
    }, this.keepWarmMs);
    logger.lifecycle.info("v4 session data lease released", {
      event: "v4.session_data.release",
      keepWarmMs: this.keepWarmMs,
      module: "ui.v4.session_data_layer",
      refCount: 0,
      status: "keep_warm",
      topic,
    });
  }

  /** Clearing everything on connection teardown (window/workspace unmount). */
  dispose(): void {
    if (this.disposed) return;
    logger.lifecycle.info("v4 session data layer dispose started", {
      entryCount: this.entries.size,
      event: "v4.session_data.dispose.started",
      module: "ui.v4.session_data_layer",
      status: "started",
    });
    this.disposed = true;
    this.offFrame();
    for (const entry of this.entries.values()) {
      if (entry.keepWarmTimer !== null) {
        clearTimeout(entry.keepWarmTimer);
      }
      void entry.store.close();
    }
    this.entries.clear();
    logger.lifecycle.info("v4 session data layer dispose completed", {
      event: "v4.session_data.dispose.completed",
      module: "ui.v4.session_data_layer",
      status: "completed",
    });
  }
}
