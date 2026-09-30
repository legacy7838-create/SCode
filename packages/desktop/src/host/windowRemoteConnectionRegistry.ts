/* eslint-disable max-lines -- All transport lifecycles share one registry state machine and must evolve atomically. */
import {
  buildSshRemoteHostKey,
  stripRemoteTargetSecrets,
  type RemoteTarget,
  type WindowHostAttachmentScope,
  type WindowHostRemoteWorkspaceDescriptor,
} from "@zcode/shared";

interface WindowRemoteAssetDirs {
  mockCdnDir?: string;
  remoteCdnBaseUrl?: string;
  remoteCdnBaseUrls?: string[];
  remoteCacheDir?: string;
}

export interface WindowRemoteConnectionCloseEvent {
  exitCode: number | null;
  signal: string | null;
  error?: string;
}

export interface WindowRemoteConnectionHandle<TServices, TCapabilities = never> {
  services: TServices;
  capabilities?: TCapabilities;
  dispose(): void | Promise<void>;
  onDidClose?(listener: (event: WindowRemoteConnectionCloseEvent) => void): { dispose(): void };
}

interface WindowRemoteConnectionConnectRequest {
  target: RemoteTarget;
  remoteAssets: WindowRemoteAssetDirs;
  signal: AbortSignal;
}

type WindowRemoteConnectionState = "connecting" | "online" | "closing" | "failed" | "disconnected";

interface WindowRemoteLogicalSessionSnapshot {
  remoteSessionId: string;
  requestId: string;
  target: RemoteTarget;
  workspacePath?: string;
  workspaceIdentity?: string;
  generation: number;
  state: WindowRemoteConnectionState;
  sourceAvailability: "online" | "offline";
}

class WindowRemoteConnectCancelledError extends Error {
  constructor() {
    super("Remote connection was cancelled");
    this.name = "WindowRemoteConnectCancelledError";
  }
}

class WindowRemoteConnectionUnavailableError extends Error {
  constructor(remoteSessionId: string) {
    super(`Remote connection is currently unavailable, remoteSessionId=${remoteSessionId}`);
    this.name = "WindowRemoteConnectionUnavailableError";
  }
}

interface ConnectionEntry<TServices, TCapabilities> {
  key: string;
  target: RemoteTarget;
  state: WindowRemoteConnectionState;
  abortController: AbortController;
  sessions: Set<string>;
  ready: Promise<WindowRemoteConnectionHandle<TServices, TCapabilities>>;
  handle?: WindowRemoteConnectionHandle<TServices, TCapabilities>;
  closeSubscription?: { dispose(): void };
  disposePromise?: Promise<void>;
  disposed: boolean;
  idleTimer?: ReturnType<typeof setTimeout>;
  idleReason: string;
  workspaceKeys: Set<string>;
  runningTaskCountByWorkspaceKey: Map<string, number>;
  workspaceRuntimeByKey: Map<string, WorkspaceRuntimeState>;
}

interface RemoteWorkspaceContext {
  workspacePath: string;
  workspaceIdentity?: string;
}

interface WorkspaceRuntimeState {
  context: RemoteWorkspaceContext;
  generation: number;
  pendingReleaseGeneration?: number;
  releaseInFlight?: Promise<void>;
}

interface LogicalSession<TServices, TCapabilities> {
  remoteSessionId: string;
  requestId: string;
  target: RemoteTarget;
  workspacePath?: string;
  workspaceIdentity?: string;
  generation: number;
  state: WindowRemoteConnectionState;
  sourceAvailability: "online" | "offline";
  entry: ConnectionEntry<TServices, TCapabilities>;
  workspaceKey?: string;
  workspaceGeneration?: number;
  workspaceReady: Promise<void>;
  workspaceReadyState: "pending" | "ready" | "failed";
  cancelled: boolean;
  rejectCancellation: (error: WindowRemoteConnectCancelledError) => void;
  cancellation: Promise<never>;
}

function normalizeWslSegment(value: string | undefined): string {
  return value?.trim() || "<default>";
}

function buildConnectionKey(target: RemoteTarget): string {
  switch (target.kind) {
    case "ssh":
      return `ssh:${buildSshRemoteHostKey(target)}`;
    case "wsl":
      return `wsl:${normalizeWslSegment(target.distro)}\0${normalizeWslSegment(target.user)}`;
  }
}

function toSessionSnapshot<TServices, TCapabilities>(
  session: LogicalSession<TServices, TCapabilities>,
): WindowRemoteLogicalSessionSnapshot {
  return {
    remoteSessionId: session.remoteSessionId,
    requestId: session.requestId,
    target: stripRemoteTargetSecrets(session.target),
    ...(session.workspacePath ? { workspacePath: session.workspacePath } : {}),
    ...(session.workspaceIdentity ? { workspaceIdentity: session.workspaceIdentity } : {}),
    generation: session.generation,
    state: session.state,
    sourceAvailability: session.sourceAvailability,
  };
}

export function createWindowRemoteConnectionRegistry<TServices, TCapabilities = never>(options: {
  connect: (
    request: WindowRemoteConnectionConnectRequest,
  ) => Promise<WindowRemoteConnectionHandle<TServices, TCapabilities>>;
  createId: () => string;
  onSessionClosed?: (event: WindowRemoteConnectionCloseEvent & { remoteSessionId: string }) => void;
  releaseWorkspace?: (services: TServices, context: RemoteWorkspaceContext) => Promise<void>;
  onWorkspaceReleaseError?: (context: RemoteWorkspaceContext, error: unknown) => void;
  wslIdleTtlMs?: number;
}) {
  const entriesByKey = new Map<string, ConnectionEntry<TServices, TCapabilities>>();
  const sessionsById = new Map<string, LogicalSession<TServices, TCapabilities>>();
  const pendingSessionsByRequestId = new Map<string, LogicalSession<TServices, TCapabilities>>();
  let disposed = false;
  let disposePromise: Promise<void> | null = null;
  const wslIdleTtlMs = options.wslIdleTtlMs ?? 60_000;

  function clearIdleTimer(entry: ConnectionEntry<TServices, TCapabilities>): void {
    if (!entry.idleTimer) {
      return;
    }
    clearTimeout(entry.idleTimer);
    entry.idleTimer = undefined;
  }

  function hasRunningTasks(entry: ConnectionEntry<TServices, TCapabilities>): boolean {
    return Array.from(entry.runningTaskCountByWorkspaceKey.values()).some((count) => count > 0);
  }

  function sessionOwnsWorkspace(
    session: LogicalSession<TServices, TCapabilities>,
    entry: ConnectionEntry<TServices, TCapabilities>,
    workspaceKey: string,
  ): boolean {
    return (
      !session.cancelled &&
      session.entry === entry &&
      session.workspaceKey === workspaceKey &&
      sessionsById.get(session.remoteSessionId) === session
    );
  }

  function hasOtherWorkspaceOwner(
    entry: ConnectionEntry<TServices, TCapabilities>,
    workspaceKey: string,
    excludedRemoteSessionId: string,
  ): boolean {
    return Array.from(sessionsById.values()).some(
      (candidate) =>
        candidate.remoteSessionId !== excludedRemoteSessionId &&
        sessionOwnsWorkspace(candidate, entry, workspaceKey),
    );
  }

  function startWorkspaceRelease(
    entry: ConnectionEntry<TServices, TCapabilities>,
    workspaceKey: string,
    state: WorkspaceRuntimeState,
    generation: number,
  ): Promise<void> | undefined {
    if (
      entry.target.kind !== "wsl" ||
      state.generation !== generation ||
      state.releaseInFlight ||
      !entry.handle ||
      entry.state !== "online" ||
      !options.releaseWorkspace
    ) {
      return state.releaseInFlight;
    }
    state.pendingReleaseGeneration = undefined;
    const release = options
      .releaseWorkspace(entry.handle.services, state.context)
      .catch((error) => {
        options.onWorkspaceReleaseError?.(state.context, error);
        throw error;
      })
      .finally(() => {
        if (state.releaseInFlight === release) {
          state.releaseInFlight = undefined;
        }
        if (
          state.generation === generation &&
          !state.pendingReleaseGeneration &&
          !Array.from(sessionsById.values()).some((candidate) =>
            sessionOwnsWorkspace(candidate, entry, workspaceKey),
          )
        ) {
          entry.workspaceRuntimeByKey.delete(workspaceKey);
        }
      });
    // release is triggered by the dispose/running-task event; failure is logged by a structured callback, while rejecting is retained
    // Promise is given to the next generation acquire of the same workspace, making it fail-closed rather than stepping on unfinished cleanup.
    void release.catch(() => undefined);
    state.releaseInFlight = release;
    return release;
  }

  function requestWorkspaceRelease(params: {
    entry: ConnectionEntry<TServices, TCapabilities>;
    remoteSessionId: string;
    workspaceKey?: string;
    workspaceGeneration?: number;
  }): Promise<void> | undefined {
    const { entry, workspaceKey, workspaceGeneration } = params;
    if (entry.target.kind !== "wsl" || !workspaceKey || !workspaceGeneration) {
      return undefined;
    }
    if (hasOtherWorkspaceOwner(entry, workspaceKey, params.remoteSessionId)) {
      return undefined;
    }
    const state = entry.workspaceRuntimeByKey.get(workspaceKey);
    if (!state || state.generation !== workspaceGeneration) {
      return undefined;
    }
    if ((entry.runningTaskCountByWorkspaceKey.get(workspaceKey) ?? 0) > 0) {
      state.pendingReleaseGeneration = workspaceGeneration;
      return undefined;
    }
    return startWorkspaceRelease(entry, workspaceKey, state, workspaceGeneration);
  }

  function prepareWorkspaceRuntime(
    session: LogicalSession<TServices, TCapabilities>,
  ): Promise<void> {
    if (session.entry.target.kind !== "wsl" || !session.workspacePath || !session.workspaceKey) {
      session.workspaceReadyState = "ready";
      session.workspaceReady = Promise.resolve();
      return session.workspaceReady;
    }
    const workspaceKey = session.workspaceKey;
    const entry = session.entry;
    const existing = entry.workspaceRuntimeByKey.get(workspaceKey);
    const hasOtherOwner = hasOtherWorkspaceOwner(entry, workspaceKey, session.remoteSessionId);
    const state =
      existing ??
      ({
        context: {
          workspacePath: session.workspacePath,
          ...(session.workspaceIdentity ? { workspaceIdentity: session.workspaceIdentity } : {}),
        },
        generation: 0,
      } satisfies WorkspaceRuntimeState);
    entry.workspaceRuntimeByKey.set(workspaceKey, state);
    state.context = {
      workspacePath: session.workspacePath,
      ...(session.workspaceIdentity ? { workspaceIdentity: session.workspaceIdentity } : {}),
    };
    if (!hasOtherOwner) {
      state.generation += 1;
      // While the previous generation release is still waiting for a running task, the new logical owner has re-held it.
      // workspace; old releases that have not yet been started must be invalidated, and the runtime cannot be accidentally refreshed after the task is reset to zero.
    }
    state.pendingReleaseGeneration = undefined;
    session.workspaceGeneration = state.generation;
    session.workspaceReadyState = "pending";
    const releaseToWait = state.releaseInFlight;
    const ready = (releaseToWait ?? Promise.resolve())
      .then(() => {
        if (
          sessionsById.get(session.remoteSessionId) !== session ||
          session.cancelled ||
          entry.workspaceRuntimeByKey.get(workspaceKey)?.generation !== session.workspaceGeneration
        ) {
          throw new WindowRemoteConnectCancelledError();
        }
        session.workspaceReadyState = "ready";
      })
      .catch((error) => {
        session.workspaceReadyState = "failed";
        throw error;
      });
    session.workspaceReady = ready;
    return ready;
  }

  function scheduleWslIdleDispose(
    entry: ConnectionEntry<TServices, TCapabilities>,
    reason: string,
  ): void {
    clearIdleTimer(entry);
    entry.idleReason = reason;
    if (
      entry.target.kind !== "wsl" ||
      entry.disposed ||
      entry.sessions.size > 0 ||
      hasRunningTasks(entry)
    ) {
      return;
    }
    entry.idleTimer = setTimeout(() => {
      entry.idleTimer = undefined;
      if (
        entriesByKey.get(entry.key) !== entry ||
        entry.disposed ||
        entry.sessions.size > 0 ||
        hasRunningTasks(entry)
      ) {
        return;
      }
      void disposeEntry(entry);
    }, wslIdleTtlMs);
  }

  async function disposeEntry(entry: ConnectionEntry<TServices, TCapabilities>): Promise<void> {
    if (entry.disposePromise) {
      return entry.disposePromise;
    }
    entry.disposed = true;
    clearIdleTimer(entry);
    entry.state = "closing";
    entry.abortController.abort();
    entry.closeSubscription?.dispose();
    entry.closeSubscription = undefined;
    if (entriesByKey.get(entry.key) === entry) {
      entriesByKey.delete(entry.key);
    }
    entry.disposePromise = Promise.resolve(entry.handle?.dispose()).then(() => undefined);
    return entry.disposePromise;
  }

  function handleConnectionClosed(
    entry: ConnectionEntry<TServices, TCapabilities>,
    event: WindowRemoteConnectionCloseEvent,
  ): void {
    if (entry.disposed || entry.state === "closing") {
      return;
    }
    entry.state = "disconnected";
    clearIdleTimer(entry);
    if (entriesByKey.get(entry.key) === entry) {
      entriesByKey.delete(entry.key);
    }
    for (const remoteSessionId of entry.sessions) {
      const session = sessionsById.get(remoteSessionId);
      if (!session) {
        continue;
      }
      session.state = "disconnected";
      session.sourceAvailability = "offline";
      options.onSessionClosed?.({ remoteSessionId, ...event });
    }
  }

  function createEntry(params: {
    key: string;
    target: RemoteTarget;
    remoteAssets: WindowRemoteAssetDirs;
  }): ConnectionEntry<TServices, TCapabilities> {
    const abortController = new AbortController();
    const entry: ConnectionEntry<TServices, TCapabilities> = {
      key: params.key,
      target: params.target,
      state: "connecting" as const,
      abortController,
      sessions: new Set<string>(),
      ready: Promise.resolve(undefined as never),
      disposed: false,
      idleReason: "wsl-host-idle",
      workspaceKeys: new Set(),
      runningTaskCountByWorkspaceKey: new Map(),
      workspaceRuntimeByKey: new Map(),
    };
    entry.ready = options
      .connect({
        target: params.target,
        remoteAssets: params.remoteAssets,
        signal: abortController.signal,
      })
      .then(async (handle) => {
        entry.handle = handle;
        if (entry.disposed || entry.sessions.size === 0) {
          // The underlying SSH/WSL connector may not break authentication or deployment.
          // After the last logical owner is canceled, the late success result must be released immediately, and the old connection cannot be resurrected.
          await disposeEntry(entry);
          return handle;
        }
        entry.state = "online";
        entry.closeSubscription = handle.onDidClose?.((event) => {
          handleConnectionClosed(entry, event);
        });
        for (const remoteSessionId of entry.sessions) {
          const session = sessionsById.get(remoteSessionId);
          if (!session || session.cancelled) {
            continue;
          }
          session.state = "online";
          session.sourceAvailability = "online";
        }
        return handle;
      })
      .catch((error) => {
        entry.state = "failed";
        if (entriesByKey.get(entry.key) === entry) {
          entriesByKey.delete(entry.key);
        }
        for (const remoteSessionId of Array.from(entry.sessions)) {
          const session = sessionsById.get(remoteSessionId);
          if (!session) {
            continue;
          }
          session.state = "failed";
          session.sourceAvailability = "offline";
          sessionsById.delete(remoteSessionId);
          pendingSessionsByRequestId.delete(session.requestId);
        }
        entry.sessions.clear();
        throw error;
      });
    entriesByKey.set(entry.key, entry);
    return entry;
  }

  function resolveEntry(params: {
    key: string;
    target: RemoteTarget;
    remoteAssets: WindowRemoteAssetDirs;
  }): ConnectionEntry<TServices, TCapabilities> {
    const existing = entriesByKey.get(params.key);
    if (
      existing &&
      !existing.disposed &&
      !existing.abortController.signal.aborted &&
      (existing.state === "connecting" || existing.state === "online")
    ) {
      clearIdleTimer(existing);
      return existing;
    }
    return createEntry(params);
  }

  async function connect(params: {
    requestId: string;
    target: RemoteTarget;
    remoteAssets: WindowRemoteAssetDirs;
    workspacePath?: string;
    workspaceIdentity?: string;
  }): Promise<WindowHostRemoteWorkspaceDescriptor> {
    if (disposed) {
      throw new Error("the remote connection registry of the window host has been disposed");
    }
    if (pendingSessionsByRequestId.has(params.requestId)) {
      throw new Error(`duplicate remote connection requestId, requestId=${params.requestId}`);
    }

    const remoteSessionId = options.createId();
    const key = buildConnectionKey(params.target);
    const entry = resolveEntry({
      key,
      target: params.target,
      remoteAssets: params.remoteAssets,
    });
    let rejectCancellation!: (error: WindowRemoteConnectCancelledError) => void;
    const cancellation = new Promise<never>((_resolve, reject) => {
      rejectCancellation = reject;
    });
    const session: LogicalSession<TServices, TCapabilities> = {
      remoteSessionId,
      requestId: params.requestId,
      target: params.target,
      ...(params.workspacePath ? { workspacePath: params.workspacePath } : {}),
      ...(params.workspaceIdentity ? { workspaceIdentity: params.workspaceIdentity } : {}),
      generation: 1,
      state: entry.state === "online" ? "online" : "connecting",
      sourceAvailability: entry.state === "online" ? "online" : "offline",
      entry,
      workspaceReady: Promise.resolve(),
      workspaceReadyState: "pending",
      cancelled: false,
      rejectCancellation,
      cancellation,
    };
    entry.sessions.add(remoteSessionId);
    const initialWorkspaceKey = params.workspaceIdentity?.trim() || params.workspacePath;
    if (initialWorkspaceKey) {
      entry.workspaceKeys.add(initialWorkspaceKey);
      session.workspaceKey = initialWorkspaceKey;
    }
    sessionsById.set(remoteSessionId, session);
    pendingSessionsByRequestId.set(params.requestId, session);

    try {
      await Promise.race([entry.ready, cancellation]);
      await Promise.race([prepareWorkspaceRuntime(session), cancellation]);
      if (session.cancelled || !sessionsById.has(remoteSessionId)) {
        throw new WindowRemoteConnectCancelledError();
      }
      session.state = "online";
      session.sourceAvailability = "online";
      return {
        remoteSessionId,
        target: stripRemoteTargetSecrets(params.target),
        ...(session.workspacePath ? { workspacePath: session.workspacePath } : {}),
        ...(session.workspaceIdentity ? { workspaceIdentity: session.workspaceIdentity } : {}),
        generation: session.generation,
      };
    } catch (error) {
      if (sessionsById.get(remoteSessionId) === session) {
        sessionsById.delete(remoteSessionId);
        entry.sessions.delete(remoteSessionId);
        session.state = "failed";
        session.sourceAvailability = "offline";
      }
      throw error;
    } finally {
      if (pendingSessionsByRequestId.get(params.requestId) === session) {
        pendingSessionsByRequestId.delete(params.requestId);
      }
    }
  }

  function cancelConnect(requestId: string): void {
    const session = pendingSessionsByRequestId.get(requestId);
    if (!session || session.cancelled) {
      return;
    }
    session.cancelled = true;
    pendingSessionsByRequestId.delete(requestId);
    sessionsById.delete(session.remoteSessionId);
    session.entry.sessions.delete(session.remoteSessionId);
    const workspaceRelease = requestWorkspaceRelease({
      entry: session.entry,
      remoteSessionId: session.remoteSessionId,
      workspaceKey: session.workspaceKey,
      workspaceGeneration: session.workspaceGeneration,
    });
    void workspaceRelease?.catch(() => undefined);
    session.rejectCancellation(new WindowRemoteConnectCancelledError());
    if (session.entry.sessions.size === 0) {
      if (session.entry.target.kind === "ssh" && session.entry.state === "connecting") {
        // After the last waiter is canceled, the old entry still remains in the multiplexing table as connecting; reconnecting will occur immediately.
        // Continue to wait for aborted readiness and use the last credentials. First retire the old entry according to the object identity,
        // Retriggers the underlying cancellation; the late old completion cannot delete or resurrect a new connection with the same key.
        if (entriesByKey.get(session.entry.key) === session.entry) {
          entriesByKey.delete(session.entry.key);
        }
        session.entry.state = "closing";
        session.entry.abortController.abort();
      } else if (session.entry.target.kind === "wsl" && session.entry.state === "online") {
        scheduleWslIdleDispose(session.entry, "cancelled-logical-connect");
      } else if (session.entry.target.kind === "ssh" && session.entry.state === "online") {
        // ready SSH connection is a window cache; canceling a logical attach should not cause subsequent workspace
        // The multiplexed connections are destroyed together and released when the real window Host shuts down.
        clearIdleTimer(session.entry);
      } else if (session.entry.handle) {
        void disposeEntry(session.entry);
      }
    }
  }

  function bindWorkspaceContext(params: {
    remoteSessionId: string;
    workspacePath: string;
    workspaceIdentity: string;
  }): Promise<void> {
    const session = sessionsById.get(params.remoteSessionId);
    if (!session) {
      throw new Error(
        `remote logical session not found, remoteSessionId=${params.remoteSessionId}`,
      );
    }
    const previousOwnership = {
      entry: session.entry,
      remoteSessionId: session.remoteSessionId,
      workspaceKey: session.workspaceKey,
      workspaceGeneration: session.workspaceGeneration,
    };
    session.workspacePath = params.workspacePath;
    session.workspaceIdentity = params.workspaceIdentity;
    session.generation += 1;
    session.workspaceKey = params.workspaceIdentity.trim() || params.workspacePath;
    session.entry.workspaceKeys.add(session.workspaceKey);
    const ready = prepareWorkspaceRuntime(session);
    if (previousOwnership.workspaceKey !== session.workspaceKey) {
      const release = requestWorkspaceRelease(previousOwnership);
      void release?.catch(() => undefined);
    }
    return ready;
  }

  function resolveScopedHandle(
    scope: WindowHostAttachmentScope,
  ): WindowRemoteConnectionHandle<TServices, TCapabilities> {
    if (scope.kind !== "remote") {
      throw new Error("the remote connection registry cannot resolve a local attachment scope");
    }
    const session = sessionsById.get(scope.remoteSessionId);
    if (!session) {
      throw new WindowRemoteConnectionUnavailableError(scope.remoteSessionId);
    }
    if (
      session.workspacePath !== scope.workspacePath ||
      session.workspaceIdentity !== scope.workspaceIdentity
    ) {
      throw new Error(
        `remote attachment scope does not match the logical session, remoteSessionId=${scope.remoteSessionId}`,
      );
    }
    if (
      session.state !== "online" ||
      session.sourceAvailability !== "online" ||
      session.workspaceReadyState !== "ready" ||
      !session.entry.handle
    ) {
      throw new WindowRemoteConnectionUnavailableError(scope.remoteSessionId);
    }
    return session.entry.handle;
  }

  function resolveScopedServices(scope: WindowHostAttachmentScope): TServices {
    return resolveScopedHandle(scope).services;
  }

  function resolveScopedCapabilities(scope: WindowHostAttachmentScope): TCapabilities | undefined {
    return resolveScopedHandle(scope).capabilities;
  }

  async function disposeSession(remoteSessionId: string): Promise<void> {
    const session = sessionsById.get(remoteSessionId);
    if (!session) {
      return;
    }
    sessionsById.delete(remoteSessionId);
    pendingSessionsByRequestId.delete(session.requestId);
    session.entry.sessions.delete(remoteSessionId);
    const workspaceRelease = requestWorkspaceRelease({
      entry: session.entry,
      remoteSessionId,
      workspaceKey: session.workspaceKey,
      workspaceGeneration: session.workspaceGeneration,
    });
    if (session.entry.sessions.size === 0) {
      if (session.entry.target.kind === "wsl" && session.entry.state === "online") {
        scheduleWslIdleDispose(session.entry, "last-logical-session-disposed");
      } else if (session.entry.target.kind === "ssh" && session.entry.state === "online") {
        // Only migrate the owner of the SSH pool: ready connection and continue to maintain the window-scoped cache.
        // Clearing the logical session does not mean the connection is exited; the real window is released uniformly when the host shuts down.
        clearIdleTimer(session.entry);
      } else {
        await disposeEntry(session.entry);
      }
    }
    await workspaceRelease?.catch(() => undefined);
  }

  return {
    connect,
    cancelConnect,
    bindWorkspaceContext,
    resolveScopedServices,
    resolveScopedCapabilities,
    getSession(remoteSessionId: string): WindowRemoteLogicalSessionSnapshot | null {
      const session = sessionsById.get(remoteSessionId);
      return session ? toSessionSnapshot(session) : null;
    },
    listSessions(): WindowRemoteLogicalSessionSnapshot[] {
      return Array.from(sessionsById.values(), toSessionSnapshot);
    },
    findSessionForWorkspace(params: {
      workspacePath: string;
      workspaceIdentity?: string;
    }): WindowRemoteLogicalSessionSnapshot | null {
      const matches = Array.from(sessionsById.values()).filter(
        (session) =>
          session.workspacePath === params.workspacePath &&
          session.workspaceIdentity === params.workspaceIdentity,
      );
      const onlineMatches = matches.filter(
        (session) => session.state === "online" && session.sourceAvailability === "online",
      );
      if (onlineMatches.length > 1 || (onlineMatches.length === 0 && matches.length > 1)) {
        throw new Error(
          `remote workspace scope matched multiple logical sessions, workspacePath=${params.workspacePath}`,
        );
      }
      const match = onlineMatches[0] ?? matches[0];
      return match ? toSessionSnapshot(match) : null;
    },
    getStats(): { connectionCount: number; logicalSessionCount: number } {
      return {
        connectionCount: entriesByKey.size,
        logicalSessionCount: sessionsById.size,
      };
    },
    setWorkspaceRunningTaskCount(params: {
      workspacePath: string;
      workspaceIdentity?: string;
      runningTaskCount: number;
    }): void {
      const workspaceKey = params.workspaceIdentity?.trim() || params.workspacePath;
      for (const entry of entriesByKey.values()) {
        if (entry.target.kind !== "wsl" || !entry.workspaceKeys.has(workspaceKey)) {
          continue;
        }
        if (params.runningTaskCount > 0) {
          entry.runningTaskCountByWorkspaceKey.set(workspaceKey, params.runningTaskCount);
          clearIdleTimer(entry);
        } else {
          entry.runningTaskCountByWorkspaceKey.delete(workspaceKey);
          const state = entry.workspaceRuntimeByKey.get(workspaceKey);
          if (state?.pendingReleaseGeneration) {
            void startWorkspaceRelease(
              entry,
              workspaceKey,
              state,
              state.pendingReleaseGeneration,
            )?.catch(() => undefined);
          }
          scheduleWslIdleDispose(entry, entry.idleReason);
        }
      }
    },
    async waitForScopedServices(scope: WindowHostAttachmentScope): Promise<TServices> {
      if (scope.kind !== "remote") {
        throw new Error("the remote connection registry cannot resolve a local attachment scope");
      }
      const session = sessionsById.get(scope.remoteSessionId);
      if (!session) {
        throw new WindowRemoteConnectionUnavailableError(scope.remoteSessionId);
      }
      await session.workspaceReady;
      return resolveScopedServices(scope);
    },
    disposeSession,
    async dispose(): Promise<void> {
      if (disposePromise) {
        return disposePromise;
      }
      disposed = true;
      for (const requestId of Array.from(pendingSessionsByRequestId.keys())) {
        cancelConnect(requestId);
      }
      const entries = new Set(Array.from(sessionsById.values(), (session) => session.entry));
      for (const entry of entriesByKey.values()) {
        entries.add(entry);
      }
      sessionsById.clear();
      pendingSessionsByRequestId.clear();
      disposePromise = Promise.all(Array.from(entries, disposeEntry)).then(() => undefined);
      return disposePromise;
    },
  };
}
