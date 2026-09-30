import type { IDisposable } from "@zcode/rpc";
import { ZCODE_AGENT_RUNTIME_UNAVAILABLE_CODE, type IZCodeAgentService } from "@zcode/services";
import {
  PROTOCOL_V4_LIMITS,
  sessionsIndexTopic,
  sessionsIndexTopicFrameSchema,
  TopicWireFrameAssembler,
  type SessionsIndexTopicFrame,
  type SessionsIndexTopicWireCandidate,
  type SessionSummary,
} from "@zcode/shared/zcode-protocol-v4";

const SUBSCRIBER_SCOPE = "window-controller";
const MAX_STAGED_WIRES = 1_024;
const MAX_STAGED_BYTES = 32 * 1024 * 1024;

type SessionsIndexAgentService = Pick<
  IZCodeAgentService,
  | "subscribeSessionsIndexV4"
  | "resyncSessionsIndexV4"
  | "unsubscribeSessionsIndexV4"
  | "onDynamicSessionsIndexFrame"
  | "onAgentRuntimeRestarted"
> &
  Partial<Pick<IZCodeAgentService, "onAgentRuntimeLifecycle">>;

export interface WindowHostSessionsIndexObserver {
  start(): Promise<void>;
  dispose(): void;
}

function isRuntimeUnavailableError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === ZCODE_AGENT_RUNTIME_UNAVAILABLE_CODE
  );
}

function encodedBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

/**
 * Passive sessions-index observer for the Window Host. It only ever uses existing-only mode and
 * stays dormant while the runtime is missing; before the ACK it buffers a bounded amount on the
 * physical wire, so an initial snapshot that arrives ahead of the RPC response is not lost.
 */
export function createWindowHostSessionsIndexObserver(options: {
  agentService: SessionsIndexAgentService;
  target: { workspacePath: string; workspaceIdentity?: string };
  onSessionsChange: (sessions: SessionSummary[]) => void;
  onError?: (error: unknown) => void;
}): WindowHostSessionsIndexObserver {
  const workspace = {
    workspacePath: options.target.workspacePath,
    ...(options.target.workspaceIdentity
      ? { workspaceIdentity: options.target.workspaceIdentity }
      : {}),
  };
  const workspaceKey = options.target.workspaceIdentity?.trim() || options.target.workspacePath;
  const topic = sessionsIndexTopic(workspaceKey);
  const summaries = new Map<string, SessionSummary>();
  const assembler = new TopicWireFrameAssembler(sessionsIndexTopicFrameSchema);
  let activeSubscriptionId: string | null = null;
  let cursor: { logEpoch: string; seq: number } | null = null;
  let disposed = false;
  let generation = 0;
  let startPromise: Promise<void> | null = null;
  let restartAfterPending = false;
  let dormant = false;
  let recovering = false;
  let stagedWires: SessionsIndexTopicWireCandidate[] = [];
  let stagedBytes = 0;
  let stagingOverflowed = false;
  let assemblyTimer: ReturnType<typeof setTimeout> | null = null;
  let recoveryTimer: ReturnType<typeof setTimeout> | null = null;

  const publish = (): void => {
    options.onSessionsChange(Array.from(summaries.values()));
  };

  const clearAssemblyTimer = (): void => {
    if (assemblyTimer) clearTimeout(assemblyTimer);
    assemblyTimer = null;
  };

  const clearRecoveryTimer = (): void => {
    if (recoveryTimer) clearTimeout(recoveryTimer);
    recoveryTimer = null;
  };

  const scheduleAssemblyExpiry = (): void => {
    clearAssemblyTimer();
    const nextExpiryAt = assembler.nextExpiryAt;
    if (nextExpiryAt === null) return;
    assemblyTimer = setTimeout(
      () => {
        assemblyTimer = null;
        const faults = assembler.expire(Date.now()).filter((event) => event.kind === "fault");
        if (faults.length > 0) requestRecovery();
        scheduleAssemblyExpiry();
      },
      Math.max(0, nextExpiryAt - Date.now()),
    );
    assemblyTimer.unref?.();
  };

  const applyFrame = (frame: SessionsIndexTopicFrame): void => {
    if (frame.payload.kind === "snapshot") {
      summaries.clear();
      for (const session of frame.payload.snapshot.sessions) {
        summaries.set(session.sessionId, session);
      }
      cursor = { logEpoch: frame.payload.snapshot.logEpoch, seq: frame.toSeq };
      recovering = false;
      clearRecoveryTimer();
      publish();
      return;
    }
    if (!cursor || frame.fromSeq !== cursor.seq) {
      requestRecovery();
      return;
    }
    for (const delta of frame.payload.deltas) {
      if (delta.op === "session.upserted") summaries.set(delta.session.sessionId, delta.session);
      else summaries.delete(delta.sessionId);
    }
    cursor = { ...cursor, seq: frame.toSeq };
    publish();
  };

  const acceptOwnedWire = (wire: SessionsIndexTopicWireCandidate): void => {
    if (
      !activeSubscriptionId ||
      wire.topic !== topic ||
      wire.subscriptionId !== activeSubscriptionId
    ) {
      return;
    }
    const events = assembler.accept(wire);
    let faulted = false;
    for (const event of events) {
      if (event.kind === "fault") faulted = true;
      else applyFrame(event.frame);
    }
    if (faulted) requestRecovery();
    scheduleAssemblyExpiry();
  };

  const stageOrAcceptWire = (wire: SessionsIndexTopicWireCandidate): void => {
    if (disposed || wire.topic !== topic) return;
    if (activeSubscriptionId) {
      acceptOwnedWire(wire);
      return;
    }
    if (stagingOverflowed) return;
    const bytes = encodedBytes(wire);
    if (
      bytes > MAX_STAGED_BYTES ||
      stagedWires.length + 1 > MAX_STAGED_WIRES ||
      stagedBytes + bytes > MAX_STAGED_BYTES
    ) {
      // The initial frame can be earlier than subscribe ACK; truncating the header will leave a frame that can pass type verification but is missing fragments.
      // snapshot. When crossing the boundary, the entire batch must be invalidated. After ACK, the subscription is canceled and waits for the next runtime lifecycle.
      stagedWires = [];
      stagedBytes = 0;
      stagingOverflowed = true;
      return;
    }
    stagedWires.push(wire);
    stagedBytes += bytes;
  };

  function requestRecovery(): void {
    const subscriptionId = activeSubscriptionId;
    if (disposed || recovering || !subscriptionId) return;
    recovering = true;
    assembler.abort(topic, subscriptionId);
    void options.agentService
      .resyncSessionsIndexV4({
        ...workspace,
        subscriptionId,
        base: cursor,
        forceSnapshot: true,
        runtimePolicy: "existing-only",
      })
      .then(() => {
        if (disposed || activeSubscriptionId !== subscriptionId || !recovering) return;
        clearRecoveryTimer();
        recoveryTimer = setTimeout(() => {
          recoveryTimer = null;
          if (!disposed && activeSubscriptionId === subscriptionId && recovering) {
            resubscribeAfterRecovery();
          }
        }, PROTOCOL_V4_LIMITS.logicalFrameAssemblyTimeoutMs);
        recoveryTimer.unref?.();
      })
      .catch((error) => {
        recovering = false;
        if (!isRuntimeUnavailableError(error)) {
          options.onError?.(error);
          resubscribeAfterRecovery();
        }
      });
  }

  function resubscribeAfterRecovery(): void {
    const previousSubscriptionId = activeSubscriptionId;
    generation += 1;
    activeSubscriptionId = null;
    cursor = null;
    recovering = false;
    stagedWires = [];
    stagedBytes = 0;
    stagingOverflowed = false;
    assembler.clear();
    clearAssemblyTimer();
    clearRecoveryTimer();
    if (previousSubscriptionId) {
      void options.agentService
        .unsubscribeSessionsIndexV4({
          ...workspace,
          subscriptionId: previousSubscriptionId,
          runtimePolicy: "existing-only",
        })
        .catch(() => {});
    }
    if (startPromise) restartAfterPending = true;
    else void start();
  }

  const frameSubscription =
    options.agentService.onDynamicSessionsIndexFrame(workspace)(stageOrAcceptWire);

  const invalidateRuntime = (): void => {
    generation += 1;
    activeSubscriptionId = null;
    cursor = null;
    recovering = false;
    stagedWires = [];
    stagedBytes = 0;
    stagingOverflowed = false;
    assembler.clear();
    clearAssemblyTimer();
    clearRecoveryTimer();
    summaries.clear();
    publish();
  };

  let lifecycleSubscription: IDisposable | undefined;
  let restartSubscription: IDisposable | undefined;
  if (options.agentService.onAgentRuntimeLifecycle) {
    lifecycleSubscription = options.agentService.onAgentRuntimeLifecycle((event) => {
      if (event.workspaceKey !== workspaceKey) return;
      if (event.state === "unavailable") {
        dormant = true;
        invalidateRuntime();
        return;
      }
      const wasDormant = dormant;
      dormant = false;
      if (startPromise) {
        // The same existing-only subscribe may publish available before ACK; this is not the old runtime
        // Replacement. Only unavailable pending needs to be resubscribed after the current request is closed.
        if (wasDormant) restartAfterPending = true;
      } else if (!activeSubscriptionId) void start();
    });
  } else {
    restartSubscription = options.agentService.onAgentRuntimeRestarted((event) => {
      if (event.workspaceKey !== workspaceKey) return;
      invalidateRuntime();
      if (startPromise) restartAfterPending = true;
      else void start();
    });
  }

  async function start(): Promise<void> {
    if (disposed || dormant || activeSubscriptionId) return;
    if (startPromise) return startPromise;
    const subscribeGeneration = generation;
    stagedWires = [];
    stagedBytes = 0;
    stagingOverflowed = false;
    // First write pending ownership into startPromise, and then enter subscribe; Agent may be in RPC Promise
    // The runtime available is released synchronously before returning, and the lifecycle callback cannot be recursively entered into the second start.
    const pending = Promise.resolve().then(async () => {
      try {
        const result = await options.agentService.subscribeSessionsIndexV4({
          ...workspace,
          visibility: "background",
          subscriberScope: SUBSCRIBER_SCOPE,
          runtimePolicy: "existing-only",
        });
        if (disposed || subscribeGeneration !== generation || stagingOverflowed) {
          void options.agentService
            .unsubscribeSessionsIndexV4({
              ...workspace,
              subscriptionId: result.ack.subscriptionId,
              runtimePolicy: "existing-only",
            })
            .catch(() => {});
          if (stagingOverflowed) {
            options.onError?.(new Error("fault.subscription.initialFrameStagingOverflow"));
          }
          return;
        }
        activeSubscriptionId = result.ack.subscriptionId;
        const initialWires = stagedWires;
        stagedWires = [];
        stagedBytes = 0;
        for (const wire of initialWires) acceptOwnedWire(wire);
      } catch (error) {
        if (!disposed && isRuntimeUnavailableError(error)) {
          // New Hosts with lifecycle will wait until available before subscribing to avoid repeatedly calling dormant RPC for each list query.
          dormant = Boolean(options.agentService.onAgentRuntimeLifecycle);
        } else if (!disposed) {
          options.onError?.(error);
        }
      }
    });
    startPromise = pending;
    try {
      await pending;
    } finally {
      if (startPromise === pending) startPromise = null;
      if (restartAfterPending && !disposed && !activeSubscriptionId) {
        restartAfterPending = false;
        void start();
      }
    }
  }

  return {
    start,
    dispose() {
      if (disposed) return;
      disposed = true;
      generation += 1;
      const subscriptionId = activeSubscriptionId;
      activeSubscriptionId = null;
      frameSubscription.dispose();
      lifecycleSubscription?.dispose();
      restartSubscription?.dispose();
      clearAssemblyTimer();
      clearRecoveryTimer();
      assembler.clear();
      stagedWires = [];
      if (subscriptionId) {
        void options.agentService
          .unsubscribeSessionsIndexV4({
            ...workspace,
            subscriptionId,
            runtimePolicy: "existing-only",
          })
          .catch(() => {});
      }
    },
  };
}
