/* eslint-disable max-lines -- the isomorphic connection ownership lifecycle of the three V4 topics is centralized in a single facade. */
// V4 connection-scoped service facade: Each RPC attachment holds subscription independently
// ownership; the base service still only forwards CLI facts and does not replicate business state in host/main/relay.
import { Emitter, Event as RpcEvent, type Event, type IDisposable } from "@zcode/rpc";
import {
  V4_WIRE_PROTOCOL_VERSION,
  clientHelloSchema,
  clientSupportsWorkflowRunDeltas,
  conversationTopic,
  sessionsIndexTopic,
  workspaceConfigTopic,
  type ConversationTopicWireCandidate,
  type HelloMessage,
  type SessionsIndexTopicWireCandidate,
  type V4ConnectionFlowState,
  type WorkspaceConfigTopicWireCandidate,
} from "@zcode/shared/zcode-protocol-v4";
import type {
  IZCodeAgentService,
  ZCodeAgentConversationResyncParams,
  ZCodeAgentConversationUnsubscribeParams,
  ZCodeAgentRuntimePolicy,
  ZCodeAgentWorkspaceTarget,
} from "./zcodeAgent.js";

export type ZCodeAgentV4ClientMode = "desktop-continuous" | "web-remote-replayable";

export interface ZCodeAgentV4ConnectionContext {
  connectionId: string;
  clientMode: ZCodeAgentV4ClientMode;
  role?: "terminal-client" | "trusted-host-relay";
  /**
   * This connection's clientHello declared that it understands `workflowRun.*` key-level deltas.
   * Same family as `clientMode`: this facade writes it from the handshake facts and always
   * strips the same-named field from subscription params — whether a client understands deltas is
   * a fact about the **connection**, not a per-subscription preference. Absence = treat as an old consumer.
   */
  workflowRunDeltas?: boolean;
}

const TRUSTED_CONNECTION_FIELD = "__zcodeTrustedV4Connection";
const TRUSTED_UNSUBSCRIBE_ROUTE_FIELD = "__zcodeTrustedV4UnsubscribeRoute";

type TrustedConnectionCarrier = {
  [TRUSTED_CONNECTION_FIELD]?: ZCodeAgentV4ConnectionContext;
};

interface TrustedZCodeAgentV4UnsubscribeRoute {
  topic: string;
  connectionId: string;
}

type TrustedUnsubscribeRouteCarrier = {
  [TRUSTED_UNSUBSCRIBE_ROUTE_FIELD]?: TrustedZCodeAgentV4UnsubscribeRoute;
};

export function readTrustedZCodeAgentV4UnsubscribeRoute(
  value: unknown,
): TrustedZCodeAgentV4UnsubscribeRoute | null {
  if (typeof value !== "object" || value === null) return null;
  const route = (value as TrustedUnsubscribeRouteCarrier)[TRUSTED_UNSUBSCRIBE_ROUTE_FIELD];
  if (!route || typeof route.topic !== "string" || typeof route.connectionId !== "string") {
    return null;
  }
  return route;
}

/**
 * This field is only passed between the host facade and the base/remote service proxy; the facade
 * overwrites the same-named field in every UI-supplied param, so renderer/mobile cannot forge a
 * trusted connection mode.
 */
export function readTrustedZCodeAgentV4Connection(
  value: unknown,
): ZCodeAgentV4ConnectionContext | null {
  if (typeof value !== "object" || value === null) return null;
  const context = (value as TrustedConnectionCarrier)[TRUSTED_CONNECTION_FIELD];
  if (!context || typeof context.connectionId !== "string") return null;
  if (
    context.clientMode !== "desktop-continuous" &&
    context.clientMode !== "web-remote-replayable"
  ) {
    return null;
  }
  return {
    connectionId: context.connectionId,
    clientMode: context.clientMode,
    // Only true is recognized: absent and false are both "old consumers", and whether the key is present or not is the criterion of the downstream reader.
    ...(context.workflowRunDeltas === true ? { workflowRunDeltas: true } : {}),
  };
}

function withTrustedConnection<T extends object>(
  value: T,
  context: ZCodeAgentV4ConnectionContext,
): T {
  const forwarded: Record<string, unknown> = {
    ...(value as unknown as Record<string, unknown>),
  };
  // When a shared service is exposed on multiple RPC ports, the caller can pass the profile, and all
  // The port shares the workspace fan-out. The facade must first clear all forgeable fields before writing the host true value.
  delete forwarded[TRUSTED_CONNECTION_FIELD];
  delete forwarded["connectionId"];
  delete forwarded["clientMode"];
  delete forwarded["deliveryProfile"];
  delete forwarded["subscriberScope"];
  // Trusted bits of the same family as clientMode: subscribe on the UI side cannot choose incremental encoding by itself.
  delete forwarded["workflowRunDeltas"];
  forwarded[TRUSTED_CONNECTION_FIELD] = context;
  return forwarded as T;
}

function withTrustedUnsubscribeRoute<T extends object>(
  value: T,
  route: TrustedZCodeAgentV4UnsubscribeRoute,
): T {
  const forwarded = {
    ...(value as unknown as Record<string, unknown>),
  };
  delete forwarded[TRUSTED_UNSUBSCRIBE_ROUTE_FIELD];
  forwarded[TRUSTED_UNSUBSCRIBE_ROUTE_FIELD] = route;
  return forwarded as T;
}

function workspaceKey(target: ZCodeAgentWorkspaceTarget): string {
  return target.workspaceIdentity?.trim() || target.workspacePath;
}

function workspaceTarget(target: ZCodeAgentWorkspaceTarget): ZCodeAgentWorkspaceTarget {
  return {
    workspacePath: target.workspacePath,
    ...(target.workspaceIdentity ? { workspaceIdentity: target.workspaceIdentity } : {}),
  };
}

type SubscriptionKind = "conversation" | "sessions-index" | "workspace-config";

interface OwnedSubscription {
  kind: SubscriptionKind;
  ownershipKey: string;
  subscriptionId: string;
  topic: string;
  connectionId: string;
  clientMode: ZCodeAgentV4ClientMode;
  target: ZCodeAgentWorkspaceTarget;
}

interface ConnectionFlowRoute {
  key: string;
  target: ZCodeAgentWorkspaceTarget;
  connection: ZCodeAgentV4ConnectionContext;
}

type RoutedTopicFrame =
  | ConversationTopicWireCandidate
  | SessionsIndexTopicWireCandidate
  | WorkspaceConfigTopicWireCandidate;

interface PendingOwnership {
  kind: SubscriptionKind;
  target: ZCodeAgentWorkspaceTarget;
  topic: string;
  frames: RoutedTopicFrame[];
  stagedBytes: number;
  overflowReason: string | null;
  runtimeGeneration: number;
  invalidatedByRuntimeRestart: boolean;
}

interface RoutedFrameEvent {
  emitter: Emitter<RoutedTopicFrame>;
  upstream: IDisposable;
}

// The ACK window only covers control plane race conditions and does not replace subscriber buffer/resync. Here according to the number of frames and
// JSON byte double quota temporary storage prevents abnormal peers from occupying host memory indefinitely during subscribe pending.
const MAX_PENDING_OWNERSHIP_FRAMES = 1_024;
const MAX_PENDING_OWNERSHIP_BYTES = 32 * 1024 * 1024;
const MAX_DOWNSTREAM_CONNECTION_ID_LENGTH = 256;

function assertConnectionId(connectionId: string): void {
  if (
    connectionId.trim().length === 0 ||
    connectionId.length > MAX_DOWNSTREAM_CONNECTION_ID_LENGTH
  ) {
    throw new Error("fault.connection.invalidConnectionId");
  }
}

function namespaceRelayConnectionId(
  upstreamConnectionId: string,
  downstreamConnectionId: string,
): string {
  // The length prefix eliminates `a/b + c` and `a + b/c` delimiter collisions; connectionId only
  // opaque route key does not require business layer analysis.
  return `relay:${upstreamConnectionId.length}:${upstreamConnectionId}${downstreamConnectionId.length}:${downstreamConnectionId}`;
}

function frameBytes(frame: RoutedTopicFrame): number {
  return new TextEncoder().encode(JSON.stringify(frame)).byteLength;
}

function deliveryProfileFor(clientMode: ZCodeAgentV4ClientMode): HelloMessage["deliveryProfile"] {
  return clientMode === "desktop-continuous" ? "continuous" : "replayable";
}

function createHello(context: ZCodeAgentV4ConnectionContext): HelloMessage {
  const continuous = context.clientMode === "desktop-continuous";
  return {
    kind: "hello",
    protocolVersion: V4_WIRE_PROTOCOL_VERSION,
    connectionId: context.connectionId,
    clientMode: context.clientMode,
    deliveryProfile: deliveryProfileFor(context.clientMode),
    serverTime: Date.now(),
    capabilities: {
      nativeDialogs: continuous,
      localTerminal: continuous,
      binaryFrames: false,
      compression: "none",
      workspaceHookReview: true,
      independentPlanState: true,
      // This Host will forward the key-level increment of `workflowRun.*`; the client can only return the statement in clientHello after seeing it.
      // (That capability is .strict(), which in turn will make the old Host unable to handle it).
      workflowRunDeltas: true,
    },
    auth: {},
  };
}

export interface ZCodeAgentConnectionScope {
  readonly service: IZCodeAgentService;
  /** MessagePort/transport sideband only; not a UI-facing RPC. */
  setTransportFlowState(state: V4ConnectionFlowState): Promise<void>;
  dispose(): Promise<void>;
}

/** Establishes a trusted V4 facade for a single host/server RPC attachment. */
export function createZCodeAgentConnectionScope(
  base: IZCodeAgentService,
  context: ZCodeAgentV4ConnectionContext,
): ZCodeAgentConnectionScope {
  assertConnectionId(context.connectionId);
  const role = context.role ?? "terminal-client";
  const owned = new Map<string, OwnedSubscription>();
  const routeKeyByOwnership = new Map<string, string>();
  const pendingByOwnership = new Map<string, Set<PendingOwnership>>();
  const routedFrameEvents = new Map<string, RoutedFrameEvent>();
  const runtimeGenerationByWorkspaceKey = new Map<string, number>();
  let disposed = false;
  // The trusted relay has completed the identity in the outer transport (stdio / Node-only WS role header)
  // selection; the terminal UI must still go hello → clientHello.
  let handshakeComplete = role === "trusted-host-relay";
  let helloIssued = role === "trusted-host-relay";
  let boundClientId: string | null = null;
  /** The delta declaration from clientHello; a trusted relay has no clientHello of its own and only relays the downstream one. */
  let clientWorkflowRunDeltas = false;
  let commandQueryWorkspaceKey: string | null = null;
  let currentTransportFlowState: V4ConnectionFlowState = "drained";
  let flowClosed = false;
  let flowUpdateChain = Promise.resolve();
  const forwardedFlowStateByRoute = new Map<string, V4ConnectionFlowState>();
  /** Workspace routes the attachment has touched are kept until port dispose, so a trusted close is possible even with no subscription. */
  const attachmentFlowRoutes = new Map<string, ConnectionFlowRoute>();

  const forwardedConnection = (params: unknown): ZCodeAgentV4ConnectionContext => {
    const downstream = readTrustedZCodeAgentV4Connection(params);
    if (role === "trusted-host-relay" && downstream) {
      assertConnectionId(downstream.connectionId);
      return {
        connectionId: namespaceRelayConnectionId(context.connectionId, downstream.connectionId),
        clientMode: downstream.clientMode,
        // The incremental bit belongs to the **downstream side**: relay itself does not consume frames, but only brings the statement of downstream clientHello.
        ...(downstream.workflowRunDeltas === true ? { workflowRunDeltas: true } : {}),
      };
    }
    return {
      connectionId: context.connectionId,
      clientMode: context.clientMode,
      ...(clientWorkflowRunDeltas ? { workflowRunDeltas: true } : {}),
    };
  };

  const assertOpen = () => {
    if (disposed) throw new Error("fault.connection.closed");
  };
  const assertReady = () => {
    assertOpen();
    if (!handshakeComplete) throw new Error("fault.connection.handshakeRequired");
  };
  const routeKey = (
    kind: SubscriptionKind,
    target: ZCodeAgentWorkspaceTarget,
    topic: string,
    subscriptionId: string,
    connectionId: string,
  ) => `${kind}\0${workspaceKey(target)}\0${topic}\0${subscriptionId}\0${connectionId}`;
  const ownershipKey = (kind: SubscriptionKind, target: ZCodeAgentWorkspaceTarget, topic: string) =>
    `${kind}\0${workspaceKey(target)}\0${topic}`;
  const routedEventKey = (kind: SubscriptionKind, target: ZCodeAgentWorkspaceTarget) =>
    `${kind}\0${workspaceKey(target)}`;
  const flowRouteKey = (target: ZCodeAgentWorkspaceTarget, connectionId: string) =>
    `${workspaceKey(target)}\0${connectionId}`;
  const flowRouteForEntry = (entry: OwnedSubscription): ConnectionFlowRoute => ({
    key: flowRouteKey(entry.target, entry.connectionId),
    target: entry.target,
    connection: {
      connectionId: entry.connectionId,
      clientMode: entry.clientMode,
    } satisfies ZCodeAgentV4ConnectionContext,
  });
  const currentFlowRoutes = () => {
    const routes = new Map<string, ConnectionFlowRoute>(attachmentFlowRoutes);
    for (const entry of owned.values()) {
      const route = flowRouteForEntry(entry);
      routes.set(route.key, route);
    }
    return routes;
  };
  const forwardFlowRoute = async (
    route: ConnectionFlowRoute,
    state: V4ConnectionFlowState,
  ): Promise<void> => {
    if (forwardedFlowStateByRoute.get(route.key) === state) return;
    await base.setConnectionFlowStateV4(
      withTrustedConnection(
        {
          ...workspaceTarget(route.target),
          state,
        },
        route.connection,
      ),
    );
    forwardedFlowStateByRoute.set(route.key, state);
  };
  const applyTransportFlowState = async (state: V4ConnectionFlowState): Promise<void> => {
    if (flowClosed && state !== "closed") return;
    currentTransportFlowState = state;
    if (state === "closed") flowClosed = true;
    for (const route of currentFlowRoutes().values()) {
      await forwardFlowRoute(route, state);
    }
  };
  const enqueueTransportFlowState = (state: V4ConnectionFlowState): Promise<void> => {
    if (disposed || (flowClosed && state !== "closed")) return Promise.resolve();
    const update = flowUpdateChain.then(() => applyTransportFlowState(state));
    // Fast SAT→DRN and close must maintain the submission order; a single RPC failure cannot interrupt subsequent
    // close cleans up, but the caller will still receive the rejection of the update.
    flowUpdateChain = update.catch(() => {});
    return update;
  };
  const syncCurrentFlowForEntry = async (entry: OwnedSubscription): Promise<void> => {
    if (currentTransportFlowState !== "saturated") return;
    await forwardFlowRoute(flowRouteForEntry(entry), "saturated");
  };
  const closeUnusedFlowRoute = async (entry: OwnedSubscription): Promise<void> => {
    const route = flowRouteForEntry(entry);
    if (currentFlowRoutes().has(route.key)) return;
    if (forwardedFlowStateByRoute.has(route.key)) {
      await forwardFlowRoute(route, "closed");
      forwardedFlowStateByRoute.delete(route.key);
    }
  };
  const remember = (subscriptionId: string, entry: OwnedSubscription): void => {
    const key = routeKey(entry.kind, entry.target, entry.topic, subscriptionId, entry.connectionId);
    const previous = routeKeyByOwnership.get(entry.ownershipKey);
    if (previous) owned.delete(previous);
    routeKeyByOwnership.set(entry.ownershipKey, key);
    owned.set(key, entry);
  };
  const findBySubscription = (
    kind: SubscriptionKind,
    target: ZCodeAgentWorkspaceTarget,
    subscriptionId: string,
    expectedRoute: TrustedZCodeAgentV4UnsubscribeRoute | null,
  ): OwnedSubscription | null => {
    const expectedWorkspaceKey = workspaceKey(target);
    const matches = [...owned.values()].filter(
      (entry) =>
        entry.kind === kind &&
        entry.subscriptionId === subscriptionId &&
        workspaceKey(entry.target) === expectedWorkspaceKey &&
        (!expectedRoute ||
          (entry.topic === expectedRoute.topic &&
            entry.connectionId === expectedRoute.connectionId)),
    );
    // The terminal UI only passes the subId; if it collides in the same method/workspace, it would rather reject the guess.
    // Trusted relay uses the topic/connection written by the downstream facade to accurately hit.
    return matches.length === 1 ? matches[0]! : null;
  };
  const ownsFrame = (
    kind: SubscriptionKind,
    target: ZCodeAgentWorkspaceTarget,
    frame: { subscriptionId: string; topic: string },
  ) => {
    const expectedWorkspaceKey = workspaceKey(target);
    return [...owned.values()].some(
      (entry) =>
        entry.kind === kind &&
        entry.subscriptionId === frame.subscriptionId &&
        entry.topic === frame.topic &&
        workspaceKey(entry.target) === expectedWorkspaceKey,
    );
  };
  const forwardedUnsubscribeRoute = (
    params: unknown,
  ): TrustedZCodeAgentV4UnsubscribeRoute | null => {
    if (role !== "trusted-host-relay") return null;
    const downstream = readTrustedZCodeAgentV4UnsubscribeRoute(params);
    if (!downstream) return null;
    assertConnectionId(downstream.connectionId);
    return {
      topic: downstream.topic,
      connectionId: namespaceRelayConnectionId(context.connectionId, downstream.connectionId),
    };
  };
  const beginPendingOwnership = (
    kind: SubscriptionKind,
    target: ZCodeAgentWorkspaceTarget,
    topic: string,
  ): PendingOwnership => {
    const pending: PendingOwnership = {
      kind,
      target: workspaceTarget(target),
      topic,
      frames: [],
      stagedBytes: 0,
      overflowReason: null,
      runtimeGeneration: runtimeGenerationByWorkspaceKey.get(workspaceKey(target)) ?? 0,
      invalidatedByRuntimeRestart: false,
    };
    const key = ownershipKey(kind, target, topic);
    const group = pendingByOwnership.get(key) ?? new Set<PendingOwnership>();
    group.add(pending);
    pendingByOwnership.set(key, group);
    return pending;
  };
  const removePendingOwnership = (pending: PendingOwnership): void => {
    const key = ownershipKey(pending.kind, pending.target, pending.topic);
    const group = pendingByOwnership.get(key);
    group?.delete(pending);
    if (group?.size === 0) pendingByOwnership.delete(key);
  };
  const discardPendingOwnership = (pending: PendingOwnership): void => {
    removePendingOwnership(pending);
    pending.frames.length = 0;
    pending.stagedBytes = 0;
    pending.overflowReason = null;
  };
  const stageFrame = (pending: PendingOwnership, frame: RoutedTopicFrame): void => {
    if (pending.overflowReason || pending.invalidatedByRuntimeRestart) return;
    const bytes = frameBytes(frame);
    if (
      pending.frames.length + 1 > MAX_PENDING_OWNERSHIP_FRAMES ||
      pending.stagedBytes + bytes > MAX_PENDING_OWNERSHIP_BYTES
    ) {
      // When the old ACK staging exceeds the shift limit, the oldest frame will be
      // The logical frame becomes permanently missing. Overflow must empty the entire batch and fail explicitly.
      pending.frames.length = 0;
      pending.stagedBytes = 0;
      pending.overflowReason = "fault.subscription.initialFrameStagingOverflow";
      return;
    }
    pending.frames.push(frame);
    pending.stagedBytes += bytes;
  };
  const routeIncomingFrame = (
    kind: SubscriptionKind,
    target: ZCodeAgentWorkspaceTarget,
    frame: RoutedTopicFrame,
    emitter: Emitter<RoutedTopicFrame>,
  ): void => {
    if (ownsFrame(kind, target, frame)) {
      emitter.fire(frame);
      return;
    }
    const group = pendingByOwnership.get(ownershipKey(kind, target, frame.topic));
    if (!group) return;
    for (const pending of group) stageFrame(pending, frame);
  };
  const routedEvent = <T extends RoutedTopicFrame>(
    kind: SubscriptionKind,
    target: ZCodeAgentWorkspaceTarget,
    source: Event<T>,
  ): Event<T> => {
    const key = routedEventKey(kind, target);
    let route = routedFrameEvents.get(key);
    if (!route) {
      const emitter = new Emitter<RoutedTopicFrame>();
      route = {
        emitter,
        upstream: source((frame) => routeIncomingFrame(kind, target, frame, emitter)),
      };
      routedFrameEvents.set(key, route);
    }
    return route.emitter.event as Event<T>;
  };
  const forget = (entry: OwnedSubscription): void => {
    const key = routeKey(
      entry.kind,
      entry.target,
      entry.topic,
      entry.subscriptionId,
      entry.connectionId,
    );
    owned.delete(key);
    if (routeKeyByOwnership.get(entry.ownershipKey) === key) {
      routeKeyByOwnership.delete(entry.ownershipKey);
    }
  };
  const unsubscribeBase = (
    entry: OwnedSubscription,
    runtimePolicy?: ZCodeAgentRuntimePolicy,
  ): Promise<void> => {
    const params: ZCodeAgentConversationUnsubscribeParams = {
      ...entry.target,
      subscriptionId: entry.subscriptionId,
      ...(runtimePolicy ? { runtimePolicy } : {}),
    };
    const forwarded = withTrustedUnsubscribeRoute(params, {
      topic: entry.topic,
      connectionId: entry.connectionId,
    });
    switch (entry.kind) {
      case "conversation":
        return base.unsubscribeConversationV4(forwarded);
      case "sessions-index":
        return base.unsubscribeSessionsIndexV4(forwarded);
      case "workspace-config":
        return base.unsubscribeWorkspaceConfigV4(forwarded);
    }
  };
  const unsubscribeOwnedEntry = async (
    entry: OwnedSubscription,
    runtimePolicy?: ZCodeAgentRuntimePolicy,
  ): Promise<void> => {
    forget(entry);
    try {
      // Trusted relay verifies flow control with owned route. The last subscription
      // It must be closed first and then unsubscribe; the reverse order will cause the upstream to forget the owner first, and the paused connection will be left after closed is rejected.
      await closeUnusedFlowRoute(entry);
    } finally {
      await unsubscribeBase(entry, runtimePolicy);
    }
  };
  const resyncBase = (entry: OwnedSubscription, params: ZCodeAgentConversationResyncParams) => {
    const forwarded = withTrustedUnsubscribeRoute(params, {
      topic: entry.topic,
      connectionId: entry.connectionId,
    });
    switch (entry.kind) {
      case "conversation":
        return base.resyncConversationV4(forwarded);
      case "sessions-index":
        return base.resyncSessionsIndexV4(forwarded);
      case "workspace-config":
        return base.resyncWorkspaceConfigV4(forwarded);
    }
  };
  const resyncOwned = (kind: SubscriptionKind, params: ZCodeAgentConversationResyncParams) => {
    assertReady();
    const entry = findBySubscription(
      kind,
      params,
      params.subscriptionId,
      forwardedUnsubscribeRoute(params),
    );
    if (!entry) return Promise.reject(new Error("fault.subscription.notOwned"));
    return resyncBase(entry, params);
  };
  const rememberAfterSubscribe = async (
    subscriptionId: string,
    entry: Omit<OwnedSubscription, "subscriptionId">,
    pending: PendingOwnership,
  ): Promise<void> => {
    removePendingOwnership(pending);
    const complete = { ...entry, subscriptionId };
    if (
      pending.invalidatedByRuntimeRestart ||
      pending.runtimeGeneration !==
        (runtimeGenerationByWorkspaceKey.get(workspaceKey(entry.target)) ?? 0)
    ) {
      // Late ACKs from the old runtime may reuse the same subId as the new runtime.
      // Only the local owner is lost here, and the subscription with the same name must not be unsubscribed to the new runtime.
      discardPendingOwnership(pending);
      throw new Error("fault.subscription.runtimeRestarted");
    }
    if (disposed) {
      // port close and subscribe ACK can be concurrent; late ACK cannot be processed after the facade has been closed.
      // To re-register the owner, you must reverse unsubscribe immediately.
      discardPendingOwnership(pending);
      await unsubscribeBase(complete).catch(() => {});
      throw new Error("fault.connection.closed");
    }
    if (pending.overflowReason) {
      const reason = pending.overflowReason;
      discardPendingOwnership(pending);
      await unsubscribeBase(complete).catch(() => {});
      throw new Error(reason);
    }
    remember(subscriptionId, complete);
    try {
      // When the current transport is saturated, subscribing to ACK makes the trusted downstream route a reality;
      // The SAT must be reissued here and cannot wait for the next high-water edge.
      await syncCurrentFlowForEntry(complete);
    } catch (error) {
      forget(complete);
      await unsubscribeBase(complete).catch(() => {});
      throw error;
    }
    const route = routedFrameEvents.get(routedEventKey(entry.kind, entry.target));
    if (!route) return;
    // CLI notification may arrive at the host before the RPC subscribe response. old implementation
    // The owner is not registered until await returns, and the early frame will be permanently discarded; the same topic cannot be double-ended pending.
    // Guess the owner. After ACK, only the frame corresponding to ACK subscriptionId is released, retaining the original arrival order.
    for (const frame of pending.frames) {
      if (frame.subscriptionId === subscriptionId && ownsFrame(entry.kind, entry.target, frame)) {
        route.emitter.fire(frame);
      }
    }
    pending.frames.length = 0;
    pending.stagedBytes = 0;
  };

  const invalidateWorkspaceRuntime = (invalidatedWorkspaceKey: string, generation: number) => {
    runtimeGenerationByWorkspaceKey.set(invalidatedWorkspaceKey, generation);
    // All subscriptions in the runtime have disappeared; the local owner directly forgets and does not clean up the new runtime.
    for (const entry of owned.values()) {
      if (workspaceKey(entry.target) === invalidatedWorkspaceKey) forget(entry);
    }
    for (const key of forwardedFlowStateByRoute.keys()) {
      if (key.startsWith(`${invalidatedWorkspaceKey}\0`)) {
        forwardedFlowStateByRoute.delete(key);
      }
    }
    const invalidatedPending = [...pendingByOwnership.values()]
      .flatMap((group) => [...group])
      .filter((pending) => workspaceKey(pending.target) === invalidatedWorkspaceKey);
    for (const pending of invalidatedPending) {
      pending.invalidatedByRuntimeRestart = true;
      // Removed from the routing group to prevent the old ACK from continuing to be backlogged for each frame of the new runtime when it never arrives;
      // The pending object is still held by the original Promise continuation and can reject late ACK according to generation.
      removePendingOwnership(pending);
      pending.frames.length = 0;
      pending.stagedBytes = 0;
    }
  };

  const hasRuntimeLifecycle = Boolean(base.onAgentRuntimeLifecycle);
  const runtimeLifecycleDisposable = base.onAgentRuntimeLifecycle?.((event) => {
    if (event.state === "available") {
      // The first cold start subscribe will first register pending, and then publish it at the same start.
      // available(gen1), and finally received ACK. available is not the expiration boundary of old ownership;
      // If the generation is advanced here, the legal ACK of the current runtime will be misjudged as restart.
      // The real update must first release unavailable, and the lower branch will clean up the old owner/pending.
      return;
    }
    // If the attachment facade only listens to restart, the old owner will be retained when the runtime exits but is not restarted.
    // Subsequent UI cleanup will rebuild the unsubscribe parameter and mistakenly access the startup client; therefore, unavailable directly invalidates the local owner.
    invalidateWorkspaceRuntime(event.workspaceKey, event.runtimeIdentity.generation);
  });
  const runtimeRestartDisposable = hasRuntimeLifecycle
    ? undefined
    : base.onAgentRuntimeRestarted?.(({ workspaceKey: restarted }) => {
        const nextGeneration = (runtimeGenerationByWorkspaceKey.get(restarted) ?? 0) + 1;
        invalidateWorkspaceRuntime(restarted, nextGeneration);
      });

  const overrides: Partial<IZCodeAgentService> = {
    async helloConversationV4() {
      assertOpen();
      helloIssued = true;
      return createHello(context);
    },
    async initializeConversationV4(clientHello) {
      assertOpen();
      if (!helloIssued) throw new Error("fault.connection.helloRequired");
      const parsed = clientHelloSchema.parse(clientHello);
      if (boundClientId !== null && boundClientId !== parsed.clientId) {
        throw new Error("fault.connection.clientChanged");
      }
      boundClientId = parsed.clientId;
      clientWorkflowRunDeltas = clientSupportsWorkflowRunDeltas(parsed);
      handshakeComplete = true;
    },
    async setConnectionFlowStateV4(params) {
      assertOpen();
      if (role !== "trusted-host-relay") {
        throw new Error("fault.connection.flowControlForbidden");
      }
      const downstream = readTrustedZCodeAgentV4Connection(params);
      if (!downstream) throw new Error("fault.connection.flowControlUntrusted");
      const forwarded = forwardedConnection(params);
      const ownsRoute =
        attachmentFlowRoutes.has(flowRouteKey(params, forwarded.connectionId)) ||
        [...owned.values()].some(
          (entry) =>
            workspaceKey(entry.target) === workspaceKey(params) &&
            entry.connectionId === forwarded.connectionId,
        );
      if (!ownsRoute) throw new Error("fault.subscription.notOwned");
      await base.setConnectionFlowStateV4(withTrustedConnection(params, forwarded));
    },
    async sendConversationCommandV4(params) {
      assertOpen();
      if (role === "terminal-client") {
        assertReady();
        if (params.envelope.clientId !== boundClientId) {
          // The old facade does not cover the command entry, and the call without handshake and the forged clientId will both
          // Directly to the CLI; silent overrides would break command idempotence, so inconsistencies are explicitly rejected.
          throw new Error("fault.command.clientMismatch");
        }
      }
      // command used to only check envelope.clientId, but it was not injected like subscriptions and attachments.
      // The true value of host causes mobile to forge the top-level clientMode, and the relay downstream identity is lost in the command link.
      // The envelope is still transparently transmitted as it is; the trusted connection context is only passed to the base service through the host's internal carrier.
      return base.sendConversationCommandV4(
        withTrustedConnection(params, forwardedConnection(params)),
      );
    },
    async queryConversationCommandsV4(params) {
      assertReady();
      // Pure clock detection does not query any commands and cannot preempt/change the workspace binding of business queries.
      if (params.clock)
        return base.queryConversationCommandsV4(
          withTrustedConnection(params, forwardedConnection(params)),
        );
      const requestedWorkspaceKey = workspaceKey(params);
      if (commandQueryWorkspaceKey !== null && commandQueryWorkspaceKey !== requestedWorkspaceKey) {
        throw new Error("fault.command.queryForeignWorkspace");
      }
      commandQueryWorkspaceKey = requestedWorkspaceKey;
      return base.queryConversationCommandsV4(
        withTrustedConnection(params, forwardedConnection(params)),
      );
    },
    async backgroundBashOutputV4(params) {
      assertReady();
      return base.backgroundBashOutputV4(
        withTrustedConnection(params, forwardedConnection(params)),
      );
    },
    async conversationRowsRangeV4(params) {
      assertReady();
      return base.conversationRowsRangeV4(
        withTrustedConnection(params, forwardedConnection(params)),
      );
    },
    async attachmentBeginV4(params) {
      assertReady();
      const forwarded = forwardedConnection(params);
      const result = await base.attachmentBeginV4(withTrustedConnection(params, forwarded));
      if (result.state === "staging") {
        if (disposed || flowClosed) {
          // begin ACK may occur later than port close. If you register route again at this time, closed will have missed it.
          // The CLI will leave a half-upload that can only wait for the TTL; first use the same trusted identity abort, and then reject the late result.
          await base.attachmentAbortV4(withTrustedConnection(params, forwarded)).catch(() => {});
          throw new Error("fault.connection.closed");
        }
        const route: ConnectionFlowRoute = {
          key: flowRouteKey(params, forwarded.connectionId),
          target: workspaceTarget(params),
          connection: forwarded,
        };
        attachmentFlowRoutes.set(route.key, route);
        if (currentTransportFlowState === "saturated") {
          try {
            await forwardFlowRoute(route, "saturated");
          } catch (error) {
            attachmentFlowRoutes.delete(route.key);
            await base.attachmentAbortV4(withTrustedConnection(params, forwarded)).catch(() => {});
            throw error;
          }
        }
      }
      return result;
    },
    async attachmentReadV4(params) {
      assertReady();
      return base.attachmentReadV4(withTrustedConnection(params, forwardedConnection(params)));
    },
    async conversationAttachmentReadV4(params) {
      assertReady();
      return base.conversationAttachmentReadV4(
        withTrustedConnection(params, forwardedConnection(params)),
      );
    },
    async conversationAttachmentStatV4(params) {
      assertReady();
      return base.conversationAttachmentStatV4(
        withTrustedConnection(params, forwardedConnection(params)),
      );
    },
    async attachmentPreviewSourceV4(params) {
      assertReady();
      return base.attachmentPreviewSourceV4(
        withTrustedConnection(params, forwardedConnection(params)),
      );
    },
    async attachmentChunkV4(params) {
      assertReady();
      return base.attachmentChunkV4(withTrustedConnection(params, forwardedConnection(params)));
    },
    async attachmentCommitV4(params) {
      assertReady();
      const forwarded = forwardedConnection(params);
      return base.attachmentCommitV4(withTrustedConnection(params, forwarded));
    },
    async attachmentAbortV4(params) {
      assertReady();
      const forwarded = forwardedConnection(params);
      await base.attachmentAbortV4(withTrustedConnection(params, forwarded));
    },
    async subscribeConversationV4(params) {
      assertReady();
      const forwarded = forwardedConnection(params);
      const topic = conversationTopic(params.sessionId);
      const pending = beginPendingOwnership("conversation", params, topic);
      try {
        const result = await base.subscribeConversationV4(withTrustedConnection(params, forwarded));
        await rememberAfterSubscribe(
          result.ack.subscriptionId,
          {
            kind: "conversation",
            ownershipKey: `conversation\0${workspaceKey(params)}\0${topic}\0${forwarded.connectionId}`,
            topic,
            connectionId: forwarded.connectionId,
            clientMode: forwarded.clientMode,
            target: workspaceTarget(params),
          },
          pending,
        );
        return result;
      } catch (error) {
        discardPendingOwnership(pending);
        throw error;
      }
    },
    async unsubscribeConversationV4(params) {
      const entry = findBySubscription(
        "conversation",
        params,
        params.subscriptionId,
        forwardedUnsubscribeRoute(params),
      );
      if (!entry) return;
      await unsubscribeOwnedEntry(entry, params.runtimePolicy);
    },
    async resyncConversationV4(params) {
      return resyncOwned("conversation", params);
    },
    onDynamicConversationFrame(params) {
      return routedEvent<ConversationTopicWireCandidate>(
        "conversation",
        params,
        base.onDynamicConversationFrame(params),
      );
    },
    onDynamicLocalTtftFacts(params) {
      assertOpen();
      if (
        role !== "terminal-client" ||
        context.clientMode !== "desktop-continuous" ||
        params.workspaceIdentity?.trim() ||
        params.remoteSessionId
      )
        return RpcEvent.None;
      return base.onDynamicLocalTtftFacts(workspaceTarget(params));
    },
    onDynamicConversationTelemetryFact(params) {
      assertOpen();
      // Trusted clientMode comes from host attachment; Web/mobile/relay can read authoritative dialogue,
      // Nor can the shared workspace emitter be used to install the production telemetry reporter.
      const downstream = readTrustedZCodeAgentV4Connection(params);
      const relayDesktopDownstream =
        role === "trusted-host-relay" && downstream?.clientMode === "desktop-continuous";
      if (
        context.clientMode !== "desktop-continuous" ||
        (role !== "terminal-client" && !relayDesktopDownstream)
      ) {
        return RpcEvent.None;
      }
      // The renderer's workspace supervisor will be mounted before V4 hello/initialize.
      // Telemetry emitter itself does not initiate protocol requests, allowing trusted desktops to monitor in advance to avoid dynamic
      // Event throws an error before handshake and causes the host channel to exit; live fact will still only be generated after ingest.
      // The remote workspace will also pass through the trusted host relay; the existing trusted carrier will be used here.
      // Downstream clientMode/namespace connectionId, the relay itself remains rejected even if it has no trusted downstream.
      return base.onDynamicConversationTelemetryFact(
        withTrustedConnection(workspaceTarget(params), forwardedConnection(params)),
      );
    },
    onDynamicCuaPermissionObservation() {
      assertOpen();
      // Permission pop-ups are a side effect of the local desktop; mobile replay attachments can only consume resumable conversation facts.
      if (role !== "terminal-client" || context.clientMode !== "desktop-continuous") {
        return RpcEvent.None;
      }
      return base.onDynamicCuaPermissionObservation();
    },
    onDynamicProcessResourceSample() {
      assertOpen();
      // CLI resource samples are only for remote Desktop Host relay to return main; renderer/mobile attachment
      // The event is not consumed and cannot be introduced into the continuous/replayable message surface.
      if (role !== "trusted-host-relay") {
        return RpcEvent.None;
      }
      return base.onDynamicProcessResourceSample();
    },
    onDynamicToolExecResource() {
      // The completion fact has nothing to do with session delivery and is prohibited from entering continuous/replayable attachments.
      if (disposed || role !== "trusted-host-relay") return RpcEvent.None;
      return base.onDynamicToolExecResource();
    },
    onDynamicMcpResourceSamples() {
      // Resource facts do not belong to the session stream, and neither desktop continuous nor mobile replayable attachments can be subscribed.
      if (disposed || role !== "trusted-host-relay") return RpcEvent.None;
      return base.onDynamicMcpResourceSamples();
    },
    onDynamicMcpTelemetry() {
      assertOpen();
      // MCP telemetry and CLI resource samples share the trusted Host relay boundary and do not enter the renderer/mobile session link.
      if (role !== "trusted-host-relay") {
        return RpcEvent.None;
      }
      return base.onDynamicMcpTelemetry();
    },
    async subscribeSessionsIndexV4(params) {
      assertReady();
      const forwarded = forwardedConnection(params);
      const topic = sessionsIndexTopic(workspaceKey(params));
      const pending = beginPendingOwnership("sessions-index", params, topic);
      try {
        const result = await base.subscribeSessionsIndexV4(
          withTrustedConnection(params, forwarded),
        );
        await rememberAfterSubscribe(
          result.ack.subscriptionId,
          {
            kind: "sessions-index",
            ownershipKey: `sessions-index\0${topic}\0${forwarded.connectionId}`,
            topic,
            connectionId: forwarded.connectionId,
            clientMode: forwarded.clientMode,
            target: workspaceTarget(params),
          },
          pending,
        );
        return result;
      } catch (error) {
        discardPendingOwnership(pending);
        throw error;
      }
    },
    async unsubscribeSessionsIndexV4(params) {
      const entry = findBySubscription(
        "sessions-index",
        params,
        params.subscriptionId,
        forwardedUnsubscribeRoute(params),
      );
      if (!entry) return;
      await unsubscribeOwnedEntry(entry, params.runtimePolicy);
    },
    async resyncSessionsIndexV4(params) {
      return resyncOwned("sessions-index", params);
    },
    onDynamicSessionsIndexFrame(params) {
      return routedEvent<SessionsIndexTopicWireCandidate>(
        "sessions-index",
        params,
        base.onDynamicSessionsIndexFrame(params),
      );
    },
    async subscribeWorkspaceConfigV4(params) {
      assertReady();
      const forwarded = forwardedConnection(params);
      const topic = workspaceConfigTopic(workspaceKey(params));
      const pending = beginPendingOwnership("workspace-config", params, topic);
      try {
        const result = await base.subscribeWorkspaceConfigV4(
          withTrustedConnection(params, forwarded),
        );
        await rememberAfterSubscribe(
          result.ack.subscriptionId,
          {
            kind: "workspace-config",
            ownershipKey: `workspace-config\0${topic}\0${forwarded.connectionId}`,
            topic,
            connectionId: forwarded.connectionId,
            clientMode: forwarded.clientMode,
            target: workspaceTarget(params),
          },
          pending,
        );
        return result;
      } catch (error) {
        discardPendingOwnership(pending);
        throw error;
      }
    },
    async unsubscribeWorkspaceConfigV4(params) {
      const entry = findBySubscription(
        "workspace-config",
        params,
        params.subscriptionId,
        forwardedUnsubscribeRoute(params),
      );
      if (!entry) return;
      await unsubscribeOwnedEntry(entry, params.runtimePolicy);
    },
    async resyncWorkspaceConfigV4(params) {
      return resyncOwned("workspace-config", params);
    },
    onDynamicWorkspaceConfigFrame(params) {
      return routedEvent<WorkspaceConfigTopicWireCandidate>(
        "workspace-config",
        params,
        base.onDynamicWorkspaceConfigFrame(params),
      );
    },
  };

  const service = new Proxy(base, {
    get(target, property, receiver) {
      const override = Reflect.get(overrides, property, receiver);
      if (override !== undefined) return override;
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });

  return {
    service,
    setTransportFlowState(state) {
      return enqueueTransportFlowState(state);
    },
    async dispose() {
      if (disposed) return;
      // close must be queued after the enqueued SAT/DRN; owned cleanup continues even if the control RPC fails.
      await enqueueTransportFlowState("closed").catch(() => {});
      if (disposed) return;
      disposed = true;
      handshakeComplete = false;
      helloIssued = false;
      boundClientId = null;
      clientWorkflowRunDeltas = false;
      const entries = Array.from(owned.values());
      owned.clear();
      routeKeyByOwnership.clear();
      for (const group of pendingByOwnership.values()) {
        for (const pending of group) {
          pending.frames.length = 0;
          pending.stagedBytes = 0;
          pending.overflowReason = null;
        }
      }
      pendingByOwnership.clear();
      for (const route of routedFrameEvents.values()) {
        route.upstream.dispose();
        route.emitter.dispose();
      }
      routedFrameEvents.clear();
      runtimeLifecycleDisposable?.dispose();
      runtimeRestartDisposable?.dispose();
      runtimeGenerationByWorkspaceKey.clear();
      attachmentFlowRoutes.clear();
      forwardedFlowStateByRoute.clear();
      await Promise.allSettled(entries.map((entry) => unsubscribeBase(entry)));
    },
  };
}
