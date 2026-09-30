/* oxlint-disable eslint(max-lines) -- Creation, reuse, reclamation, and the first-frame
 * ModelSelection of a draft prewarm must share one owner state machine; splitting it across files
 * would make the StrictMode / transport-generation-change cleanup ordering harder to audit.
 */
// Draft v4 draft session warm-up.
//
// Background: When there is no session registered in the draft state, the configuration interface is forced to use the workspace-default old RPC.
// It returns buildWorkspaceState to build a complete app every time (140-798ms/time); the first launch must also be on-site
// createSession. The v4 protocol originally retains the phase=draft session entity ("pane binds draft"
// session, the server already has a session entity") - This module creates one in the background when pane is not bound to a session
// draft session as a preheating carrier: configure write v4 CAS command directly to the session, first sendText multiplexing,
// Clean if not used. Pure memory will not be dropped to the disk, and will disappear when the CLI is restarted; gateway isDraftSession filtering guarantee
// It doesn't leak into the sessions-index sidebar as "new tasks".
//
// Structure: The life cycle converges to the pure controller startDraftSessionPrewarm (single testable, no React dependency),
// useDraftSessionPrewarm only exposes effect wiring with owner-scoped binding.
import { useEffect, useLayoutEffect, useMemo, useState } from "react";
import type { CommandAck, CommandType, SessionConfigState } from "@zcode/shared/zcode-protocol-v4";
import { logger } from "@/logger.js";

type DispatchCommand = (
  type: CommandType,
  payload: Record<string, unknown>,
  targetSessionId: string | null,
) => Promise<CommandAck>;

interface DraftPrewarmController {
  /**
   * The first admission command has been sent and its ACK has not settled; dispose must not delete
   * a session whose result is unknown.
   */
  markPromotionPending(): void;
  /** Marked after a successful first send (dispose no longer deletes a promoted session). */
  markPromoted(): void;
  /**
   * Marked after the session is invalidated (subscription error / sendText rejected) (dispose sends
   * no deleteSession — the session most likely no longer exists).
   */
  markDiscarded(): void;
  /**
   * The end of the lifecycle (effect cleanup / switching workspace / binding a real session):
   * created and neither promoted nor invalidated → reclaim with deleteSession; creation still in
   * flight → delete in place once the ack arrives.
   */
  dispose(): void;
}

/**
 * The pure prewarm lifecycle controller: create → hand onReady upward → dispose decides the
 * cleanup.
 */
function startDraftSessionPrewarm(params: {
  workspaceKey: string;
  dispatchCommand: DispatchCommand;
  onReady: (sessionId: string) => void;
  /**
   * The single-flight owner waits for the non-cancellable createSession to settle; it is called
   * exactly once, whether it succeeds or fails.
   */
  onSettled?: () => void;
  /**
   * The prewarmed session's initial config (the global "last selection", resolved synchronously),
   * so that the projection's first frame is already global and does not flash.
   */
  resolveInitialConfig?: () => Partial<SessionConfigState> | undefined;
}): DraftPrewarmController {
  const { workspaceKey, dispatchCommand, onReady, onSettled, resolveInitialConfig } = params;
  let disposed = false;
  let promotionState: "draft" | "pending" | "promoted" | "discarded" = "draft";
  let createdSessionId: string | null = null;

  const deleteCreatedSession = (sessionId: string) => {
    void dispatchCommand("deleteSession", {}, sessionId)
      .then((ack) => {
        if (ack.status !== "accepted" && ack.status !== "noop") {
          logger.warn("[v4-draft-prewarm] prewarm session cleanup rejected", {
            sessionId,
            status: ack.status,
            reasonCode: ack.reasonCode ?? null,
          });
        }
      })
      .catch(() => {
        // Cleanup failures are harmless: the memory session disappears when the CLI exits.
      });
  };

  const createPayload = () => {
    const createPayload: Record<string, unknown> = { workspaceId: workspaceKey };
    const initialConfig = resolveInitialConfig?.();
    if (initialConfig && Object.keys(initialConfig).length > 0) {
      // The global model is used in the first frame of the warm-up session (CLI merged with createSession.config), and the workspace is not flashed by default.
      createPayload.config = initialConfig;
    }
    return createPayload;
  };
  const dispatchCreateSession = () => {
    const createSessionPayload = createPayload();
    if (disposed) {
      return Promise.resolve(null);
    }
    return dispatchCommand("createSession", createSessionPayload, null);
  };
  const createSessionAck = dispatchCreateSession();
  void createSessionAck
    .then((ack) => {
      if (!ack) {
        return;
      }
      if (ack.status !== "accepted" || ack.result?.type !== "createSession") {
        logger.warn("[v4-draft-prewarm] createSession rejected, falling back to no-prewarm path", {
          status: ack.status,
          reasonCode: ack.reasonCode ?? null,
          workspaceKey,
        });
        return;
      }
      createdSessionId = ack.result.sessionId;
      if (disposed) {
        // Creation cannot be canceled when switching away extremely fast: ACK is deleted in place upon arrival to avoid leftover memory sessions.
        deleteCreatedSession(createdSessionId);
        return;
      }
      logger.info("[v4-draft-prewarm] draft session prewarm ready", {
        sessionId: createdSessionId,
        workspaceKey,
      });
      onReady(createdSessionId);
    })
    .catch((error) => {
      logger.warn("[v4-draft-prewarm] createSession failed, falling back to no-prewarm path", {
        error: error instanceof Error ? error.message : String(error),
        workspaceKey,
      });
    })
    .finally(() => {
      onSettled?.();
    });

  return {
    markPromotionPending() {
      if (promotionState === "draft") {
        promotionState = "pending";
      }
    },
    markPromoted() {
      promotionState = "promoted";
    },
    markDiscarded() {
      if (promotionState !== "promoted") {
        promotionState = "discarded";
      }
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      // Agent can be admitted first during MCP initialization, while renderer is still waiting for ACK;
      // At this time, if owner cleanup is deleted according to ordinary draft, the already running execution adapter will be closed.
      // Only drafts that have never started promotion can be safely and automatically recycled. Pending must wait for the original command to close.
      if (createdSessionId && promotionState === "draft") {
        deleteCreatedSession(createdSessionId);
      }
    },
  };
}

interface DraftSessionPrewarm {
  /** The prewarm binding that is ready for the current workspace/transport generation. */
  binding: DraftPrewarmBinding | null;
}

interface DraftPrewarmBinding {
  workspaceKey: string;
  sessionId: string;
  /**
   * Claims the lifecycle synchronously before the first admission command is sent; false means the
   * binding is no longer the current owner.
   */
  beginPromotion(): boolean;
  /**
   * Marked after a successful first send (stops the cleanup path from deleteSession-ing a promoted
   * session).
   */
  promote(): void;
  /**
   * Dropped after a subscription error / a rejected sendText; only the controller that created this
   * binding is affected.
   */
  discard(): void;
}

interface DraftPrewarmSubscriber {
  invalidationVersion: number;
  onBinding: (binding: DraftPrewarmBinding | null) => void;
}

interface DraftPrewarmCurrent {
  invalidationVersion: number;
  controller: DraftPrewarmController;
  binding: DraftPrewarmBinding | null;
  settled: boolean;
  retiring: boolean;
  /** Which backoff retry of this generation produced it; 0 means the first send. */
  retryAttempt: number;
}

/**
 * The backoff retry cadence after createSession fails.
 *
 * CUA Helper becoming ready triggers workspace-dispose reclamation, and an in-flight createSession
 * is interrupted with client disposed; warning only once would permanently "fall back to the
 * no-prewarm path", and from then on the draft state never gets a sessionId, so a pasted image
 * stays stuck at waitingSession (0% progress). Reclamation is transient and a retry a little later
 * succeeds, so this does bounded backoff instead of giving up.
 */
const PREWARM_RETRY_DELAYS_MS = [500, 1000, 2000];

/**
 * The prewarm coordinator for one logical draft pane.
 *
 * createSession cannot be bound directly to a React effect instance. Effect cleanup cannot cancel a
 * protocol request that has already been sent, yet a new effect immediately sends another
 * createSession; the Agent's global FIFO is therefore filled up by several slow creations of the
 * same draft. The coordinator keeps the owner across a synchronous remount and blocks the next
 * generation of creations from queueing before the old creation's ACK arrives.
 */
class DraftSessionPrewarmCoordinator {
  private readonly subscribers = new Map<symbol, DraftPrewarmSubscriber>();
  private current: DraftPrewarmCurrent | null = null;
  private blockedInvalidationVersion: number | null = null;
  private cleanupTimer: ReturnType<typeof setTimeout> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private dispatchCommand: DispatchCommand;
  private resolveInitialConfig: (() => Partial<SessionConfigState> | undefined) | undefined;

  constructor(
    private readonly workspaceKey: string,
    dispatchCommand: DispatchCommand,
    resolveInitialConfig: (() => Partial<SessionConfigState> | undefined) | undefined,
    private readonly onEmpty: () => void,
  ) {
    this.dispatchCommand = dispatchCommand;
    this.resolveInitialConfig = resolveInitialConfig;
  }

  update(
    dispatchCommand: DispatchCommand,
    resolveInitialConfig: (() => Partial<SessionConfigState> | undefined) | undefined,
  ): void {
    this.dispatchCommand = dispatchCommand;
    this.resolveInitialConfig = resolveInitialConfig;
  }

  acquire(params: {
    invalidationVersion: number;
    onBinding: (binding: DraftPrewarmBinding | null) => void;
  }): () => void {
    if (this.cleanupTimer !== null) {
      clearTimeout(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    const token = Symbol("draft-prewarm-subscriber");
    this.subscribers.set(token, params);
    this.reconcile();
    this.emitBindingTo(params);

    return () => {
      if (!this.subscribers.delete(token) || this.subscribers.size > 0) {
        return;
      }
      // React StrictMode and synchronous rehang with the same key will cleanup first and then re-execute the effect. Delay until next task confirmation
      // Whether to really leave, avoid the "create → cleanup delete → create" protocol churn.
      this.cleanupTimer = setTimeout(() => {
        this.cleanupTimer = null;
        if (this.subscribers.size > 0) {
          return;
        }
        this.retireCurrent();
        if (!this.current) {
          this.onEmpty();
        }
      }, 0);
    };
  }

  private requestedInvalidationVersion(): number | null {
    let latest: number | null = null;
    for (const subscriber of this.subscribers.values()) {
      latest =
        latest === null
          ? subscriber.invalidationVersion
          : Math.max(latest, subscriber.invalidationVersion);
    }
    return latest;
  }

  private reconcile(): void {
    const requestedVersion = this.requestedInvalidationVersion();
    if (requestedVersion === null) {
      return;
    }
    if (
      this.blockedInvalidationVersion !== null &&
      this.blockedInvalidationVersion !== requestedVersion
    ) {
      this.blockedInvalidationVersion = null;
    }
    if (this.current) {
      if (!this.current.retiring && this.current.invalidationVersion === requestedVersion) {
        return;
      }
      this.retireCurrent();
      // CreateSession cannot be canceled when it has been issued; onSettled will delete first after ACK, and then only start the latest generation.
      if (this.current) {
        return;
      }
    }
    if (this.blockedInvalidationVersion === requestedVersion) {
      return;
    }
    this.startCurrent(requestedVersion);
  }

  private clearRetryTimer(): void {
    if (this.retryTimer === null) return;
    clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }

  /**
   * createSession settles without a binding = failure (rejected or threw). A client disposed caused
   * by reclamation is transient, so one creation is rescheduled per the backoff; once that is used
   * up the existing "fall back to the no-prewarm path" behaviour is kept.
   */
  private scheduleRetryAfterFailure(failed: DraftPrewarmCurrent): void {
    const delay = PREWARM_RETRY_DELAYS_MS[failed.retryAttempt];
    if (delay === undefined) return;
    this.clearRetryTimer();
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (this.current !== failed || failed.retiring || failed.binding !== null) return;
      if (this.subscribers.size === 0) return;
      const requestedVersion = this.requestedInvalidationVersion();
      if (requestedVersion === null || this.blockedInvalidationVersion === requestedVersion) return;
      // Release the failed generation so that the next generation can pass the single flying gate of reconcile.
      this.current = null;
      this.startCurrent(requestedVersion, failed.retryAttempt + 1);
    }, delay);
  }

  private startCurrent(invalidationVersion: number, retryAttempt = 0): void {
    let current!: DraftPrewarmCurrent;
    const controller = startDraftSessionPrewarm({
      workspaceKey: this.workspaceKey,
      dispatchCommand: (type, payload, targetSessionId) =>
        this.dispatchCommand(type, payload, targetSessionId),
      resolveInitialConfig: () => this.resolveInitialConfig?.(),
      onReady: (sessionId) => {
        if (this.current !== current || current.retiring) {
          return;
        }
        let binding!: DraftPrewarmBinding;
        binding = {
          workspaceKey: this.workspaceKey,
          sessionId,
          beginPromotion: () => {
            if (this.current !== current || current.binding !== binding) {
              return false;
            }
            current.controller.markPromotionPending();
            return true;
          },
          promote: () => {
            if (this.current !== current || current.binding !== binding) {
              return;
            }
            current.controller.markPromoted();
          },
          discard: () => {
            if (this.current !== current || current.binding !== binding) {
              return;
            }
            current.controller.markDiscarded();
            current.binding = null;
            this.blockedInvalidationVersion = current.invalidationVersion;
            this.emitBindings();
          },
        };
        current.binding = binding;
        this.emitBindings();
      },
      onSettled: () => {
        current.settled = true;
        if (this.current !== current || !current.retiring) {
          // Binding = createSession failed without being retired; transient recycling can back off and retry.
          if (this.current === current && !current.retiring && current.binding === null) {
            this.scheduleRetryAfterFailure(current);
          }
          return;
        }
        this.current = null;
        if (this.subscribers.size > 0) {
          this.reconcile();
        } else {
          this.onEmpty();
        }
      },
    });
    current = {
      invalidationVersion,
      controller,
      binding: null,
      settled: false,
      retiring: false,
      retryAttempt,
    };
    this.current = current;
  }

  private retireCurrent(): void {
    const current = this.current;
    if (!current || current.retiring) {
      return;
    }
    this.clearRetryTimer();
    current.retiring = true;
    current.binding = null;
    current.controller.dispose();
    this.emitBindings();
    if (current.settled) {
      this.current = null;
    }
  }

  private emitBindings(): void {
    for (const subscriber of this.subscribers.values()) {
      this.emitBindingTo(subscriber);
    }
  }

  private emitBindingTo(subscriber: DraftPrewarmSubscriber): void {
    const current = this.current;
    subscriber.onBinding(
      current && !current.retiring && current.invalidationVersion === subscriber.invalidationVersion
        ? current.binding
        : null,
    );
  }
}

const draftPrewarmCoordinatorsByTransport = new Map<
  unknown,
  Map<string, DraftSessionPrewarmCoordinator>
>();

function logicalDraftOwnerKey(workspaceKey: string, paneId: string): string {
  return JSON.stringify([workspaceKey, paneId]);
}

function getDraftSessionPrewarmCoordinator(params: {
  workspaceKey: string;
  paneId: string;
  transportIdentity: unknown;
  dispatchCommand: DispatchCommand;
  resolveInitialConfig: (() => Partial<SessionConfigState> | undefined) | undefined;
}): DraftSessionPrewarmCoordinator {
  let transportCoordinators = draftPrewarmCoordinatorsByTransport.get(params.transportIdentity);
  if (!transportCoordinators) {
    transportCoordinators = new Map();
    draftPrewarmCoordinatorsByTransport.set(params.transportIdentity, transportCoordinators);
  }
  const ownerKey = logicalDraftOwnerKey(params.workspaceKey, params.paneId);
  let coordinator = transportCoordinators.get(ownerKey);
  if (!coordinator) {
    coordinator = new DraftSessionPrewarmCoordinator(
      params.workspaceKey,
      params.dispatchCommand,
      params.resolveInitialConfig,
      () => {
        if (transportCoordinators?.get(ownerKey) !== coordinator) {
          return;
        }
        transportCoordinators.delete(ownerKey);
        if (transportCoordinators.size === 0) {
          draftPrewarmCoordinatorsByTransport.delete(params.transportIdentity);
        }
      },
    );
    transportCoordinators.set(ownerKey, coordinator);
  }
  return coordinator;
}

export function useDraftSessionPrewarm(params: {
  /** Enabled while the pane has no session bound (sessionId===null). */
  enabled: boolean;
  workspaceKey: string;
  /**
   * The logical pane identity inside the same workspace; it must stay stable across a synchronous
   * remount.
   */
  paneId: string;
  /**
   * Incremented when external capabilities change; used only to reclaim and rebuild draft prewarm
   * sessions that have not been promoted.
   */
  invalidationVersion?: number;
  /**
   * The transport identity of the conversation provider; it stays unchanged across lease changes
   * within the same workspace.
   */
  transportIdentity: unknown;
  dispatchCommand: DispatchCommand;
  /**
   * The prewarmed session's initial config (the global "last selection", resolved synchronously),
   * so that the projection's first frame is already global and does not flash.
   */
  resolveInitialConfig?: () => Partial<SessionConfigState> | undefined;
}): DraftSessionPrewarm {
  const {
    enabled,
    workspaceKey,
    paneId,
    transportIdentity,
    invalidationVersion = 0,
    dispatchCommand,
    resolveInitialConfig,
  } = params;
  // workspace/pane/transport jointly define the logical owner: the same owner can reuse single-flight and transport
  // A new coordinator will still be generated during generation change to ensure that the cleanup of old sessions will not accidentally use the new transport.
  const owner = useMemo(
    () => ({ workspaceKey, paneId, transportIdentity }),
    [paneId, transportIdentity, workspaceKey],
  );
  const coordinator = useMemo(
    () =>
      getDraftSessionPrewarmCoordinator({
        workspaceKey,
        paneId,
        transportIdentity,
        dispatchCommand,
        resolveInitialConfig,
      }),
    [owner],
  );
  useLayoutEffect(() => {
    coordinator.update(dispatchCommand, resolveInitialConfig);
  }, [coordinator, dispatchCommand, resolveInitialConfig]);
  const generation = useMemo(() => ({ owner }), [enabled, invalidationVersion, owner]);
  const [ready, setReady] = useState<{
    generation: typeof generation;
    binding: DraftPrewarmBinding;
  } | null>(null);

  useEffect(() => {
    if (!enabled) return;
    return coordinator.acquire({
      invalidationVersion,
      onBinding: (binding) => {
        setReady((current) => {
          if (!binding) {
            return current?.generation === generation ? null : current;
          }
          return { generation, binding };
        });
      },
    });
  }, [coordinator, enabled, generation, invalidationVersion]);

  return { binding: ready?.generation === generation ? ready.binding : null };
}
