/* eslint-disable max-lines -- Main's complete thin forwarding contract centralizes the request and port association. */
import { randomUUID } from "node:crypto";
import { BrowserWindow, MessageChannelMain } from "electron";
import type { MessagePortMain, UtilityProcess as ElectronUtilityProcess } from "electron";
import {
  buildRemoteWorkspaceIdentity,
  buildRemoteEnvironmentKey,
  buildSshRemoteHostKey,
  HostMessageTypes,
  HostResponseTypes,
  hostResponseMessageSchema,
  InternalChannels,
  PlatformChannels,
  resolveWorkspaceKey,
  type RemoteTarget,
  type ProviderProvisioningTrigger,
  type WindowHostRemoteWorkspaceDescriptor,
} from "@zcode/shared";
import type {
  RemoteConnectionStats,
  RemoteDisconnectReason,
  RemoteGaugeTransition,
} from "./desktopRemoteUsageArmsTelemetry.js";
import type { RemoteAssetDirs } from "./desktopRuntimeEnv.js";
import { ProviderProvisioningEnvironmentCoordinator } from "./providerProvisioningEnvironmentCoordinator.js";

interface RemoteWorkspaceSessionContext {
  workspacePath: string;
  workspaceIdentity?: string;
}

interface PendingConnect {
  requestId: string;
  webContentsId: number;
  win: BrowserWindow;
  remoteUsageTelemetryEligible: boolean;
  resolve: (sessionId: string) => void;
  reject: (error: Error) => void;
}

interface RemoteAttachmentRoute {
  webContentsId: number;
  // Main only retains the request/session association and desensitization descriptor required for port forwarding; the connection/task fact belongs to the Host.
  descriptor: WindowHostRemoteWorkspaceDescriptor;
  rendererAttachmentId?: string;
  pendingRendererAttachment?: {
    attachmentId: string;
    previousAttachmentId?: string;
    reason: string;
    timeout: NodeJS.Timeout;
    resolve: () => void;
    reject: (error: Error) => void;
  };
  attachmentState: "attachable" | "closed";
  connectedAtMonotonicMs: number;
  connectFinalized: boolean;
  remoteUsageTelemetryEligible: boolean;
  providerProvisioningDispose?: () => void;
}

interface PendingProviderProvisioningExecution {
  readonly child: ElectronUtilityProcess;
  readonly trigger: ProviderProvisioningTrigger;
  readonly startedAtMonotonicMs: number;
  readonly resolve: () => void;
  readonly reject: (error: Error) => void;
}

function normalizeServerRemoteUrlForComparison(url: string): string {
  try {
    const parsed = new URL(url.trim());
    if (parsed.protocol === "ws:") parsed.protocol = "http:";
    if (parsed.protocol === "wss:") parsed.protocol = "https:";
    parsed.hash = "";
    parsed.search = "";
    const normalizedPath = parsed.pathname.replace(/\/+$/g, "");
    parsed.pathname = normalizedPath.endsWith("/ws")
      ? normalizedPath.slice(0, -"/ws".length) || "/"
      : normalizedPath || "/";
    return parsed.toString().replace(/\/$/g, "");
  } catch {
    return url.trim().replace(/\/+$/g, "");
  }
}

function isSameRemoteTarget(left: RemoteTarget, right: RemoteTarget): boolean {
  if (left.kind !== right.kind) return false;
  switch (left.kind) {
    case "ssh":
      return (
        right.kind === "ssh" &&
        left.host.trim().toLowerCase() === right.host.trim().toLowerCase() &&
        (left.port ?? 22) === (right.port ?? 22) &&
        left.username.trim() === right.username.trim() &&
        (left.privateKeyPath ?? "") === (right.privateKeyPath ?? "")
      );
    case "wsl":
      return (
        right.kind === "wsl" &&
        (left.distro?.trim() || "default") === (right.distro?.trim() || "default") &&
        (left.user?.trim() ?? "") === (right.user?.trim() ?? "")
      );
    case "server":
      return (
        right.kind === "server" &&
        normalizeServerRemoteUrlForComparison(left.url) ===
          normalizeServerRemoteUrlForComparison(right.url)
      );
  }
}

function buildRemoteTargetTelemetryKey(target: RemoteTarget): string {
  switch (target.kind) {
    case "ssh":
      return `ssh:${buildSshRemoteHostKey(target)}`;
    case "wsl":
      return `wsl:${target.distro?.trim() || "default"}\0${target.user?.trim() ?? ""}`;
    case "server":
      return `server:${normalizeServerRemoteUrlForComparison(target.url)}`;
  }
}

function closeMessagePort(port: MessagePortMain | undefined): void {
  if (!port) return;
  try {
    port.close();
  } catch {
    // Failure to close the MessagePort does not affect the close/dispose idempotent closure of the attachment in the Host.
  }
}

export function createRemoteWorkspaceSessionManager(options: {
  logger: {
    info: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
  };
  windowHostProcessMap: Map<number, ElectronUtilityProcess>;
  resolveRemoteAssetDirs: () => RemoteAssetDirs;
  resolveWslTarget?: (
    target: Extract<RemoteTarget, { kind: "wsl" }>,
  ) => Promise<Extract<RemoteTarget, { kind: "wsl" }>>;
  createMessageChannel?: () => { port1: MessagePortMain; port2: MessagePortMain };
  rendererAttachmentReadyTimeoutMs?: number;
  reportRemoteConnectionStateChanged?: (params: {
    rendererId: number;
    remoteKind: RemoteTarget["kind"];
    transition: Exclude<RemoteGaugeTransition, "none">;
  }) => void;
  reportRemoteDisconnect?: (params: {
    rendererId: number;
    remoteKind: RemoteTarget["kind"];
    disconnectReason: RemoteDisconnectReason;
    durationMs: number;
  }) => void;
  monotonicNowMs?: () => number;
  providerProvisioningCoordinator?: ProviderProvisioningEnvironmentCoordinator;
}) {
  const pendingByRequestKey = new Map<string, PendingConnect>();
  const routesBySessionId = new Map<string, RemoteAttachmentRoute>();
  const listenedHosts = new WeakSet<ElectronUtilityProcess>();
  const reconnectsByWorkspaceKey = new Map<string, Promise<string>>();
  const pendingProviderProvisioningExecutions = new Map<
    string,
    PendingProviderProvisioningExecution
  >();
  const providerProvisioningCoordinator =
    options.providerProvisioningCoordinator ?? new ProviderProvisioningEnvironmentCoordinator();
  let appShutdownStarted = false;
  const monotonicNowMs = options.monotonicNowMs ?? (() => performance.now());

  function requestKey(webContentsId: number, requestId: string): string {
    return `${webContentsId}\0${requestId}`;
  }

  function getWindowHost(win: BrowserWindow): ElectronUtilityProcess {
    const child = options.windowHostProcessMap.get(win.webContents.id);
    if (!child || child.pid == null) {
      throw new Error(`window Local Host not found, windowId=${win.webContents.id}`);
    }
    ensureHostListener(child, win.webContents.id);
    return child;
  }

  function createMessageChannel() {
    return options.createMessageChannel?.() ?? new MessageChannelMain();
  }

  function emitConnectionLog(
    win: BrowserWindow,
    payload: {
      requestId?: string;
      sessionId?: string;
      level: "info" | "warn" | "error";
      message: string;
    },
  ): void {
    if (win.isDestroyed() || win.webContents.isDestroyed()) return;
    win.webContents.send(PlatformChannels.RemoteConnectionLog, {
      label: `window-host-${win.webContents.id}`,
      requestId: payload.requestId,
      sessionId: payload.sessionId,
      level: payload.level,
      source: "window-host-controller",
      message: payload.message,
      // The revamp once gave full ISO times directly to the connection log UI, and long stamps would squeeze flex log columns and wrap.
      // The existing compact clock display contract is restored here, and the Host's requestId routing and original log content remain unchanged.
      timestamp: new Date().toLocaleTimeString(undefined, {
        hour12: false,
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      }),
    });
  }

  function detachServicePort(
    child: ElectronUtilityProcess,
    attachmentId: string,
    reason: string,
  ): void {
    try {
      child.postMessage({
        type: HostMessageTypes.DetachServicePort,
        attachmentId,
      });
    } catch (error) {
      // The recycling of candidate ports is idempotent cleanup, and the ready promise cannot be suspended again because the Host has exited.
      options.logger.warn("[window-host-remote] detach renderer attachment failed", {
        attachmentId,
        reason,
        error,
      });
    }
  }

  async function attachRendererPort(
    win: BrowserWindow,
    route: RemoteAttachmentRoute,
    reason: string,
  ): Promise<void> {
    if (win.isDestroyed() || win.webContents.isDestroyed()) {
      throw new Error("the window is closed, cannot attach a remote workspace");
    }
    const child = getWindowHost(win);
    const descriptor = route.descriptor;
    if (!descriptor.workspacePath || !descriptor.workspaceIdentity) {
      throw new Error(
        `the remote descriptor is missing the workspace scope, sessionId=${descriptor.remoteSessionId}`,
      );
    }
    const { port1, port2 } = createMessageChannel();
    const attachmentId = randomUUID();
    const previousAttachmentId = route.rendererAttachmentId;
    const superseded = route.pendingRendererAttachment;
    if (superseded) {
      clearTimeout(superseded.timeout);
      route.pendingRendererAttachment = undefined;
      detachServicePort(child, superseded.attachmentId, "superseded");
      superseded.reject(
        new Error(
          `the renderer attachment was superseded, sessionId=${descriptor.remoteSessionId}`,
        ),
      );
    }

    return new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        const pending = route.pendingRendererAttachment;
        if (!pending || pending.attachmentId !== attachmentId) return;
        route.pendingRendererAttachment = undefined;
        detachServicePort(child, attachmentId, "ready-timeout");
        const error = new Error(
          `renderer attachment ready timed out, sessionId=${descriptor.remoteSessionId}`,
        );
        options.logger.warn("[window-host-remote] renderer attachment ready timeout", {
          sessionId: descriptor.remoteSessionId,
          attachmentId,
          reason,
        });
        reject(error);
      }, options.rendererAttachmentReadyTimeoutMs ?? 15_000);
      timeout.unref?.();
      route.pendingRendererAttachment = {
        attachmentId,
        previousAttachmentId,
        reason,
        timeout,
        resolve,
        reject,
      };

      try {
        child.postMessage(
          {
            type: HostMessageTypes.AttachServicePort,
            requestId: randomUUID(),
            attachmentId,
            clientMode: "desktop-continuous",
            scope: {
              kind: "remote",
              remoteSessionId: descriptor.remoteSessionId,
              workspacePath: descriptor.workspacePath,
              workspaceIdentity: descriptor.workspaceIdentity,
            },
          },
          [port2],
        );
        win.webContents.postMessage(
          InternalChannels.ScopedServicePort,
          {
            attachmentId,
            sessionId: descriptor.remoteSessionId,
            target: descriptor.target,
          },
          [port1],
        );
      } catch (error) {
        clearTimeout(timeout);
        route.pendingRendererAttachment = undefined;
        detachServicePort(child, attachmentId, "delivery-failed");
        closeMessagePort(port1);
        closeMessagePort(port2);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  function confirmRendererAttachmentReady(
    webContentsId: number,
    payload: { sessionId: string; attachmentId: string },
  ): void {
    const route = routesBySessionId.get(payload.sessionId);
    const pending = route?.pendingRendererAttachment;
    if (
      !route ||
      route.webContentsId !== webContentsId ||
      !pending ||
      pending.attachmentId !== payload.attachmentId
    ) {
      options.logger.warn("[window-host-remote] ignore stale renderer attachment ready", {
        webContentsId,
        sessionId: payload.sessionId,
        attachmentId: payload.attachmentId,
      });
      return;
    }

    clearTimeout(pending.timeout);
    route.pendingRendererAttachment = undefined;
    const child = options.windowHostProcessMap.get(route.webContentsId);
    if (!child || child.pid == null) {
      pending.reject(new Error(`the window Local Host has exited, sessionId=${payload.sessionId}`));
      return;
    }
    route.rendererAttachmentId = pending.attachmentId;
    if (pending.previousAttachmentId) {
      // Host generation bind will fail-closed and will expire immediately A; Main still needs to wait for renderer to register B
      // Then improve route and do idempotent cleanup. There is no generation replacement in reload, so the available old ports will not be removed in advance.
      detachServicePort(child, pending.previousAttachmentId, "candidate-promoted");
    }
    options.logger.info(
      `[window-host-remote] renderer attachment ready, sessionId=${payload.sessionId}, reason=${pending.reason}`,
    );
    if (!route.connectFinalized) {
      route.connectFinalized = true;
      if (route.remoteUsageTelemetryEligible) {
        try {
          options.reportRemoteConnectionStateChanged?.({
            rendererId: route.webContentsId,
            remoteKind: route.descriptor.target.kind,
            transition: "connected",
          });
        } catch (error) {
          options.logger.warn("[remote-usage-arms] connected reporter failed", { error });
        }
      }
    }
    pending.resolve();
  }

  function handleConnected(
    child: ElectronUtilityProcess,
    webContentsId: number,
    requestId: string,
    descriptor: WindowHostRemoteWorkspaceDescriptor,
  ): void {
    const key = requestKey(webContentsId, requestId);
    const pending = pendingByRequestKey.get(key);
    if (!pending) {
      child.postMessage({
        type: HostMessageTypes.DisposeRemoteWorkspaceSession,
        requestId: randomUUID(),
        remoteSessionId: descriptor.remoteSessionId,
      });
      return;
    }
    pendingByRequestKey.delete(key);
    const route: RemoteAttachmentRoute = {
      webContentsId,
      descriptor,
      attachmentState: "attachable",
      connectedAtMonotonicMs: monotonicNowMs(),
      connectFinalized: false,
      remoteUsageTelemetryEligible: pending.remoteUsageTelemetryEligible,
    };
    routesBySessionId.set(descriptor.remoteSessionId, route);
    const environmentKey = buildRemoteEnvironmentKey(descriptor.target);
    const registration = providerProvisioningCoordinator.register(
      environmentKey,
      descriptor.remoteSessionId,
      (trigger) =>
        executeProviderProvisioning(child, descriptor.remoteSessionId, environmentKey, trigger),
    );
    route.providerProvisioningDispose = registration.dispose;
    void registration.initialSync
      .then(() => attachRendererPort(pending.win, route, "connect"))
      .then(() => {
        emitConnectionLog(pending.win, {
          requestId,
          sessionId: descriptor.remoteSessionId,
          level: "info",
          message: `remote ${descriptor.target.kind} workspace connected`,
        });
        pending.resolve(descriptor.remoteSessionId);
      })
      .catch((error: unknown) => {
        route.providerProvisioningDispose?.();
        routesBySessionId.delete(descriptor.remoteSessionId);
        child.postMessage({
          type: HostMessageTypes.DisposeRemoteWorkspaceSession,
          requestId: randomUUID(),
          remoteSessionId: descriptor.remoteSessionId,
        });
        pending.reject(error instanceof Error ? error : new Error(String(error)));
      });
  }

  function executeProviderProvisioning(
    child: ElectronUtilityProcess,
    remoteSessionId: string,
    environmentKey: string,
    trigger: ProviderProvisioningTrigger,
  ): Promise<void> {
    const requestId = randomUUID();
    return new Promise<void>((resolve, reject) => {
      pendingProviderProvisioningExecutions.set(requestId, {
        child,
        trigger,
        startedAtMonotonicMs: monotonicNowMs(),
        resolve,
        reject,
      });
      try {
        child.postMessage({
          type: HostMessageTypes.ProviderProvisioningExecute,
          requestId,
          environmentKey,
          remoteSessionId,
          trigger,
        });
      } catch (error) {
        pendingProviderProvisioningExecutions.delete(requestId);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  function detachRouteAttachments(
    route: RemoteAttachmentRoute,
    reason: string,
    error: Error,
  ): void {
    const child = options.windowHostProcessMap.get(route.webContentsId);
    if (route.pendingRendererAttachment) {
      const pending = route.pendingRendererAttachment;
      clearTimeout(pending.timeout);
      route.pendingRendererAttachment = undefined;
      if (child) detachServicePort(child, pending.attachmentId, reason);
      pending.reject(error);
    }
    if (route.rendererAttachmentId) {
      if (child) detachServicePort(child, route.rendererAttachmentId, reason);
      route.rendererAttachmentId = undefined;
    }
  }

  function retireActiveRoute(
    route: RemoteAttachmentRoute,
    reason: RemoteDisconnectReason,
    mutate: () => void,
  ): void {
    const wasActive =
      route.remoteUsageTelemetryEligible &&
      route.attachmentState === "attachable" &&
      route.connectFinalized;
    mutate();
    if (!wasActive) return;

    const common = {
      rendererId: route.webContentsId,
      remoteKind: route.descriptor.target.kind,
    };
    try {
      options.reportRemoteConnectionStateChanged?.({ ...common, transition: reason });
    } catch (error) {
      // Telemetry is a bypass of the connection life cycle, and the route exit status cannot be rolled back due to reporter exceptions.
      options.logger.warn("[remote-usage-arms] disconnect gauge reporter failed", { error });
    }
    try {
      options.reportRemoteDisconnect?.({
        ...common,
        disconnectReason: reason,
        durationMs: Math.max(0, Math.round(monotonicNowMs() - route.connectedAtMonotonicMs)),
      });
    } catch (error) {
      options.logger.warn("[remote-usage-arms] disconnect reporter failed", { error });
    }
  }

  function handleClosed(
    webContentsId: number,
    event: {
      remoteSessionId: string;
      reason: "connection-closed" | "disposed" | "connect-cancelled";
      exitCode?: number | null;
      signal?: string | null;
      error?: string;
    },
  ): void {
    const route = routesBySessionId.get(event.remoteSessionId);
    if (!route || route.webContentsId !== webContentsId) return;
    if (event.reason !== "connection-closed") {
      route.providerProvisioningDispose?.();
      retireActiveRoute(route, "disposed", () => {
        routesBySessionId.delete(event.remoteSessionId);
      });
      detachRouteAttachments(
        route,
        "session-released",
        new Error(`remote workspace was released, sessionId=${event.remoteSessionId}`),
      );
      return;
    }
    retireActiveRoute(route, "connection-closed", () => {
      route.attachmentState = "closed";
    });
    route.providerProvisioningDispose?.();
    // When the connection is disconnected, only the route is marked as closed, and the exposed desktop attachment remains in the window Host;
    // After the sessionId is replaced, Main will delete the route, causing the old ChannelServer to permanently lose its recycling entry.
    detachRouteAttachments(
      route,
      "session-connection-closed",
      new Error(`remote workspace was closed, sessionId=${event.remoteSessionId}`),
    );
    const win = BrowserWindow.getAllWindows().find(
      (candidate) => candidate.webContents.id === webContentsId,
    );
    if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) {
      win.webContents.send(PlatformChannels.RemoteSessionClosed, {
        sessionId: event.remoteSessionId,
        reason: "host-exit" as const,
        exitCode: event.exitCode ?? null,
        signal: event.signal ?? null,
      });
      emitConnectionLog(win, {
        sessionId: event.remoteSessionId,
        level: "warn",
        message: event.error || "the remote workspace connection was disconnected",
      });
    }
  }

  function ensureHostListener(child: ElectronUtilityProcess, webContentsId: number): void {
    if (listenedHosts.has(child)) return;
    listenedHosts.add(child);
    child.on("message", (message: unknown) => {
      const parsed = hostResponseMessageSchema.safeParse(message);
      if (!parsed.success) return;
      if (parsed.data.type === HostResponseTypes.RemoteWorkspaceConnectionLog) {
        const pending = pendingByRequestKey.get(requestKey(webContentsId, parsed.data.requestId));
        if (!pending) return;
        // Multiple remote connections share the window Host, and log ownership cannot be guessed from the process label/stdout;
        // The Host has brought the connection requestId, and the Main only forwards the request to the corresponding initiating window.
        emitConnectionLog(pending.win, {
          requestId: parsed.data.requestId,
          level: parsed.data.level,
          message: parsed.data.message,
        });
        return;
      }
      if (parsed.data.type === HostResponseTypes.ProviderProvisioningSourceChanged) {
        void providerProvisioningCoordinator.requestAll(parsed.data.trigger);
        return;
      }
      if (parsed.data.type === HostResponseTypes.ProviderProvisioningExecutionResult) {
        const pending = pendingProviderProvisioningExecutions.get(parsed.data.requestId);
        if (!pending || pending.child !== child) return;
        pendingProviderProvisioningExecutions.delete(parsed.data.requestId);
        const logContext = {
          environmentKey: parsed.data.environmentKey,
          trigger: pending.trigger,
          status: parsed.data.status,
          durationMs: Math.max(0, monotonicNowMs() - pending.startedAtMonotonicMs),
        };
        if (parsed.data.status !== "applied" && parsed.data.status !== "already-applied") {
          if (pending.trigger === "environment-online") {
            pending.reject(
              new Error(`Provider Provisioning first sync failed (${parsed.data.status})`),
            );
            return;
          }
          // Target errors may originate from any remote implementation and carry request materials; only positionable state facts are recorded during the transition period,
          // Do not copy free text that cannot be proven to be desensitized to prevent Provisioning logs from becoming an entry point for credential leakage.
          options.logger.warn("[provider-provisioning] Environment sync did not apply", logContext);
        } else {
          options.logger.info("[provider-provisioning] Environment sync completed", logContext);
        }
        pending.resolve();
        return;
      }
      if (parsed.data.type === HostResponseTypes.RemoteWorkspaceConnected) {
        handleConnected(child, webContentsId, parsed.data.requestId, parsed.data.descriptor);
        return;
      }
      if (parsed.data.type === HostResponseTypes.RemoteWorkspaceConnectFailed) {
        const key = requestKey(webContentsId, parsed.data.requestId);
        const pending = pendingByRequestKey.get(key);
        if (!pending) return;
        pendingByRequestKey.delete(key);
        emitConnectionLog(pending.win, {
          requestId: parsed.data.requestId,
          level: "error",
          message: parsed.data.error,
        });
        pending.reject(new Error(parsed.data.error));
        return;
      }
      if (parsed.data.type === HostResponseTypes.RemoteWorkspaceClosed) {
        handleClosed(webContentsId, parsed.data);
      }
    });
    child.once("exit", () => {
      const error = new Error("the window Local Host has exited");
      for (const [requestId, pendingExecution] of pendingProviderProvisioningExecutions) {
        if (pendingExecution.child !== child) continue;
        pendingProviderProvisioningExecutions.delete(requestId);
        pendingExecution.reject(error);
      }
      for (const [key, pending] of Array.from(pendingByRequestKey)) {
        if (pending.webContentsId === webContentsId) {
          pendingByRequestKey.delete(key);
          pending.reject(error);
        }
      }
      for (const [sessionId, route] of Array.from(routesBySessionId)) {
        if (route.webContentsId !== webContentsId) continue;
        route.providerProvisioningDispose?.();
        retireActiveRoute(route, "host-exit", () => {
          routesBySessionId.delete(sessionId);
        });
        if (route.pendingRendererAttachment) {
          clearTimeout(route.pendingRendererAttachment.timeout);
          route.pendingRendererAttachment.reject(error);
        }
      }
    });
  }

  async function createRemoteWorkspaceSession(
    win: BrowserWindow,
    target: RemoteTarget,
    requestId?: string,
    context?: RemoteWorkspaceSessionContext,
    lifecycle?: { remoteUsageTelemetryEligible?: boolean },
  ): Promise<string> {
    if (appShutdownStarted) {
      throw new Error("the app is quitting, cannot create a remote workspace connection");
    }
    const child = getWindowHost(win);
    const resolvedTarget =
      target.kind === "wsl" && options.resolveWslTarget
        ? await options.resolveWslTarget(target)
        : target;
    if (appShutdownStarted) {
      // WSL identity resolves across await, during which the exit barrier may have cleared the Main request association and started recycling the Host.
      // The life cycle must be revalidated after recovery, and late requests must not be registered after a shutdown barrier.
      throw new Error("the app is quitting, cannot create a remote workspace connection");
    }
    if (win.isDestroyed() || win.webContents.isDestroyed()) {
      throw new Error("the window is closed, cannot create a remote workspace connection");
    }
    const resolvedRequestId = requestId ?? randomUUID();
    const key = requestKey(win.webContents.id, resolvedRequestId);
    if (pendingByRequestKey.has(key)) {
      throw new Error(`duplicate remote connection requestId, requestId=${resolvedRequestId}`);
    }
    emitConnectionLog(win, {
      requestId: resolvedRequestId,
      level: "info",
      message: `connecting to the ${resolvedTarget.kind} workspace via the window Host`,
    });
    return new Promise<string>((resolve, reject) => {
      pendingByRequestKey.set(key, {
        requestId: resolvedRequestId,
        webContentsId: win.webContents.id,
        win,
        remoteUsageTelemetryEligible: lifecycle?.remoteUsageTelemetryEligible ?? false,
        resolve,
        reject,
      });
      child.postMessage({
        type: HostMessageTypes.ConnectRemoteWorkspace,
        requestId: resolvedRequestId,
        target: resolvedTarget,
        remoteAssets: options.resolveRemoteAssetDirs(),
        ...(context?.workspacePath ? { workspacePath: context.workspacePath } : {}),
        ...(context?.workspaceIdentity ? { workspaceIdentity: context.workspaceIdentity } : {}),
      });
    });
  }

  async function bindRemoteWorkspaceSessionContext(
    sessionId: string,
    context: RemoteWorkspaceSessionContext,
    expectedWebContentsId?: number,
  ): Promise<void> {
    const route = routesBySessionId.get(sessionId);
    if (!route) {
      if (expectedWebContentsId != null) {
        throw new Error(`remote workspace session not found, sessionId=${sessionId}`);
      }
      return;
    }
    if (expectedWebContentsId != null && route.webContentsId !== expectedWebContentsId) {
      throw new Error(
        `the remote workspace session does not belong to the current window, sessionId=${sessionId}`,
      );
    }
    const workspaceIdentity =
      context.workspaceIdentity?.trim() ||
      buildRemoteWorkspaceIdentity(context.workspacePath, route.descriptor.target);
    const child = options.windowHostProcessMap.get(route.webContentsId);
    const win = BrowserWindow.getAllWindows().find(
      (candidate) => candidate.webContents.id === route.webContentsId,
    );
    if (!child || !win) {
      throw new Error(
        `the window Host owning the remote workspace was not found, sessionId=${sessionId}`,
      );
    }
    child.postMessage({
      type: HostMessageTypes.BindRemoteWorkspaceContext,
      requestId: randomUUID(),
      remoteSessionId: sessionId,
      workspacePath: context.workspacePath,
      workspaceIdentity,
    });
    route.descriptor = {
      ...route.descriptor,
      workspacePath: context.workspacePath,
      workspaceIdentity,
      generation: route.descriptor.generation + 1,
    };
    // Bind is processed before Attach on the same parentPort; IPC only returns after the renderer registers the new port.
    await attachRendererPort(win, route, "workspace-context-bound");
  }

  function reattachRemoteWorkspaceSessionsForWindow(win: BrowserWindow, reason: string): void {
    for (const route of routesBySessionId.values()) {
      if (route.webContentsId === win.webContents.id && route.attachmentState === "attachable") {
        void attachRendererPort(win, route, reason).catch((error: unknown) => {
          options.logger.warn("[window-host-remote] renderer reattach failed", {
            sessionId: route.descriptor.remoteSessionId,
            reason,
            error,
          });
        });
      }
    }
  }

  function getRemoteConnectionStats(): RemoteConnectionStats {
    const activeRoutes = Array.from(routesBySessionId.values()).filter(
      (route) =>
        route.remoteUsageTelemetryEligible &&
        route.attachmentState === "attachable" &&
        route.connectFinalized,
    );
    return {
      activeSessionCount: activeRoutes.length,
      activeTargetCount: new Set(
        activeRoutes.map((route) => buildRemoteTargetTelemetryKey(route.descriptor.target)),
      ).size,
    };
  }

  function disposeRemoteWorkspaceSession(sessionId: string, _reason?: string): void {
    const route = routesBySessionId.get(sessionId);
    if (!route) return;
    retireActiveRoute(route, "disposed", () => {
      routesBySessionId.delete(sessionId);
    });
    route.providerProvisioningDispose?.();
    const child = options.windowHostProcessMap.get(route.webContentsId);
    if (route.pendingRendererAttachment) {
      const pending = route.pendingRendererAttachment;
      clearTimeout(pending.timeout);
      route.pendingRendererAttachment = undefined;
      if (child) detachServicePort(child, pending.attachmentId, "session-disposed");
      pending.reject(new Error(`remote workspace session was released, sessionId=${sessionId}`));
    }
    if (!child) return;
    if (route.rendererAttachmentId) {
      child.postMessage({
        type: HostMessageTypes.DetachServicePort,
        attachmentId: route.rendererAttachmentId,
      });
    }
    child.postMessage({
      type: HostMessageTypes.DisposeRemoteWorkspaceSession,
      requestId: randomUUID(),
      remoteSessionId: sessionId,
    });
  }

  function disposeRemoteWorkspaceSessionsForWindow(webContentsId: number): void {
    for (const [sessionId, route] of Array.from(routesBySessionId)) {
      if (route.webContentsId !== webContentsId) continue;
      retireActiveRoute(route, "window-closed", () => {
        routesBySessionId.delete(sessionId);
      });
      route.providerProvisioningDispose?.();
      if (route.pendingRendererAttachment) {
        clearTimeout(route.pendingRendererAttachment.timeout);
        route.pendingRendererAttachment.reject(
          new Error("the window is closed, the attachment was cancelled"),
        );
      }
    }
    for (const [key, pending] of Array.from(pendingByRequestKey)) {
      if (pending.webContentsId !== webContentsId) continue;
      pendingByRequestKey.delete(key);
      pending.reject(new Error("the window is closed, the remote connection was cancelled"));
    }
  }

  function cancelPendingRemoteWorkspaceSessionsForWindow(
    webContentsId: number,
    _reason: string,
    requestId?: string,
  ): void {
    const child = options.windowHostProcessMap.get(webContentsId);
    if (!child) return;
    for (const pending of pendingByRequestKey.values()) {
      if (
        pending.webContentsId === webContentsId &&
        (!requestId || pending.requestId === requestId)
      ) {
        child.postMessage({
          type: HostMessageTypes.CancelRemoteWorkspaceConnect,
          requestId: pending.requestId,
        });
      }
    }
  }

  function hasRemoteWorkspaceSessionForTarget(
    win: BrowserWindow,
    target: RemoteTarget,
    context?: RemoteWorkspaceSessionContext,
  ): boolean {
    const workspaceKey = context ? resolveWorkspaceKey(context) : undefined;
    return Array.from(routesBySessionId.values()).some(
      (route) =>
        route.webContentsId === win.webContents.id &&
        route.attachmentState === "attachable" &&
        isSameRemoteTarget(route.descriptor.target, target) &&
        (!workspaceKey ||
          resolveWorkspaceKey({
            workspacePath: route.descriptor.workspacePath ?? "",
            workspaceIdentity: route.descriptor.workspaceIdentity,
          }) === workspaceKey),
    );
  }

  function attachRemoteWorkspaceSessionHost(params: {
    windowId: number;
    remoteSessionId: string;
    workspacePath: string;
    workspaceIdentity: string;
    workspaceKey: string;
    clientMode: "web-remote-replayable";
  }): {
    process: ElectronUtilityProcess;
    port: MessagePortMain;
    remoteKind: RemoteTarget["kind"];
  } {
    const route = routesBySessionId.get(params.remoteSessionId);
    if (!route) {
      throw Object.assign(
        new Error(`remote workspace session not found, sessionId=${params.remoteSessionId}`),
        {
          code: "REMOTE_SESSION_MISSING" as const,
        },
      );
    }
    if (route.attachmentState !== "attachable") {
      throw Object.assign(new Error("the remote workspace source is currently offline"), {
        code: "REMOTE_SESSION_OFFLINE" as const,
      });
    }
    const win = BrowserWindow.fromId(params.windowId);
    if (!win || win.webContents.id !== route.webContentsId) {
      throw Object.assign(
        new Error("the remote workspace session does not belong to the current window"),
        {
          code: "REMOTE_SESSION_WINDOW_MISMATCH" as const,
        },
      );
    }
    const descriptor = route.descriptor;
    if (
      descriptor.workspacePath !== params.workspacePath ||
      descriptor.workspaceIdentity !== params.workspaceIdentity ||
      params.workspaceKey !== params.workspaceIdentity
    ) {
      throw Object.assign(
        new Error("the remote workspaceKey does not match the logical session."),
        {
          code: "REMOTE_WORKSPACE_IDENTITY_MISMATCH" as const,
        },
      );
    }
    const process = getWindowHost(win);
    const { port1, port2 } = createMessageChannel();
    process.postMessage(
      {
        type: HostMessageTypes.AttachServicePort,
        requestId: randomUUID(),
        attachmentId: randomUUID(),
        clientMode: params.clientMode,
        scope: {
          kind: "remote",
          remoteSessionId: params.remoteSessionId,
          workspacePath: params.workspacePath,
          workspaceIdentity: params.workspaceIdentity,
        },
      },
      [port2],
    );
    return { process, port: port1, remoteKind: descriptor.target.kind };
  }

  function reconnectBotRemoteWorkspaceSession(
    win: BrowserWindow,
    params: {
      target: RemoteTarget;
      workspacePath: string;
      workspaceIdentity: string;
      requestId?: string;
    },
  ): Promise<string> {
    const existing = Array.from(routesBySessionId.entries()).find(([, route]) => {
      return (
        route.webContentsId === win.webContents.id &&
        route.attachmentState === "attachable" &&
        route.descriptor.workspacePath === params.workspacePath &&
        route.descriptor.workspaceIdentity === params.workspaceIdentity &&
        isSameRemoteTarget(route.descriptor.target, params.target)
      );
    });
    if (existing) return Promise.resolve(existing[0]);
    const key = `${win.webContents.id}\0${params.workspaceIdentity}`;
    const pending = reconnectsByWorkspaceKey.get(key);
    if (pending) return pending;
    const reconnect = createRemoteWorkspaceSession(win, params.target, params.requestId, params);
    reconnectsByWorkspaceKey.set(key, reconnect);
    void reconnect.finally(() => {
      if (reconnectsByWorkspaceKey.get(key) === reconnect) reconnectsByWorkspaceKey.delete(key);
    });
    return reconnect;
  }

  async function createBotRemoteWorkspaceRuntimePort(
    win: BrowserWindow,
    params: { target: RemoteTarget; workspacePath: string; workspaceIdentity: string },
    _requestId?: string,
  ): Promise<MessagePortMain> {
    const routeEntry = Array.from(routesBySessionId.entries()).find(([, route]) => {
      return (
        route.webContentsId === win.webContents.id &&
        route.attachmentState === "attachable" &&
        route.descriptor.workspacePath === params.workspacePath &&
        route.descriptor.workspaceIdentity === params.workspaceIdentity &&
        isSameRemoteTarget(route.descriptor.target, params.target)
      );
    });
    if (!routeEntry) {
      throw new Error("no remote logical session available for Bot attachment was found");
    }
    return attachRemoteWorkspaceSessionHost({
      windowId: win.id,
      remoteSessionId: routeEntry[0],
      workspacePath: params.workspacePath,
      workspaceIdentity: params.workspaceIdentity,
      workspaceKey: params.workspaceIdentity,
      clientMode: "web-remote-replayable",
    }).port;
  }

  return {
    createRemoteWorkspaceSession,
    attachRemoteWorkspaceSessionHost,
    reconnectBotRemoteWorkspaceSession,
    bindRemoteWorkspaceSessionContext,
    confirmRendererAttachmentReady,
    reattachRemoteWorkspaceSessionsForWindow,
    hasRemoteWorkspaceSessionForTarget,
    createBotRemoteWorkspaceRuntimePort,
    getRemoteConnectionStats,
    disposeRemoteWorkspaceSession,
    disposeRemoteWorkspaceSessionsForWindow,
    disposeAllAndWaitForAppShutdown: async (_reason: string) => {
      appShutdownStarted = true;
      const error = new Error("the app is quitting, the remote connection was cancelled");
      for (const pending of pendingByRequestKey.values()) pending.reject(error);
      pendingByRequestKey.clear();
      for (const [sessionId, route] of Array.from(routesBySessionId)) {
        retireActiveRoute(route, "app-shutdown", () => {
          routesBySessionId.delete(sessionId);
        });
        route.providerProvisioningDispose?.();
        if (!route.pendingRendererAttachment) continue;
        clearTimeout(route.pendingRendererAttachment.timeout);
        route.pendingRendererAttachment.reject(error);
      }
      routesBySessionId.clear();
    },
    cancelPendingRemoteWorkspaceSessionsForWindow,
    handleWorkspaceRunningTaskCountChanged: () => {
      // The Running-task fact is now held by the window Host registry/ControllerProjection; Main no longer maintains the WSL pool.
    },
  };
}
