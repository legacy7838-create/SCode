/* eslint-disable max-lines -- Remote connections, OAuth callbacks, telemetry and notification IPC all share window-level context; registering them in one place avoids cross-file state drift. */
import { app, BrowserWindow, ipcMain, shell } from "electron";
import armsRum from "@arms/rum-electron";
import {
  armsCustomEventPayloadSchema,
  buildRemoteWorkspaceConnectResultTelemetry,
  classifyRemoteUsageError,
  formatZodError,
  normalizeUnknownError,
  InternalChannels,
  isTrustedCodingPlanWebviewOrigin,
  resolveZaiBusinessBaseUrl,
  PlatformChannels,
  remoteTargetSchema,
  rendererTelemetryEventPayloadSchema,
  type ArmsRumEnv,
  type RemoteTarget,
  type TelemetryEventPayload,
} from "@zcode/shared";
import { dispatchTaskNotification } from "./desktopNotifications.js";
import {
  clearOAuthRoutesForWindow,
  deliverPendingDeepLink,
  parseOAuthStateRegistration,
  registerOAuthState,
} from "./desktopOAuthDeepLink.js";
import {
  dispatchFinalArmsCustomEvent,
  enableSharedFinalArmsCustomEventE2EController,
} from "./desktopArmsCustomEvent.js";
import {
  configureRemoteUsageArmsTelemetry,
  reportRemoteConnectResultToArms,
  type RemoteConnectionStats,
} from "./desktopRemoteUsageArmsTelemetry.js";
import { openPathInDefaultApp } from "./desktopMainIpcHelpers.js";

function isAllowedExternalOpenUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" || url.protocol === "file:";
  } catch {
    return false;
  }
}

interface OpenExternalRequest {
  sourceUrl?: string;
  url: string;
}

function parseOpenExternalRequest(payload: unknown): OpenExternalRequest | null {
  if (typeof payload === "string") {
    return { url: payload };
  }
  if (!payload || typeof payload !== "object") {
    return null;
  }
  const record = payload as Record<string, unknown>;
  if (typeof record.url !== "string") {
    return null;
  }
  return {
    sourceUrl: typeof record.sourceUrl === "string" ? record.sourceUrl : undefined,
    url: record.url,
  };
}

function isPaypalHostname(hostname: string): boolean {
  return hostname === "paypal.com" || hostname.endsWith(".paypal.com");
}

function isCodingPlanPaypalNavigationUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:") return false;
    if (isPaypalHostname(parsed.hostname)) return true;
    return (
      ["https://api.z.ai", resolveZaiBusinessBaseUrl()].includes(parsed.origin) &&
      parsed.pathname.startsWith("/api/pay/paypal/")
    );
  } catch {
    return false;
  }
}

function isCodingPlanWebviewUrl(src: string | undefined): boolean {
  if (!src) return false;
  try {
    const url = new URL(src);
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    if (
      !isTrustedCodingPlanWebviewOrigin(url.origin, {
        e2eStoreBridgeEnabled: process.env.VITE_ZCODE_E2E_STORE_BRIDGE === "1",
      })
    ) {
      return false;
    }
    if (!url.pathname.includes("coding-plan")) return false;
    return url.searchParams.get("embedded") === "app";
  } catch {
    return false;
  }
}

function isCodingPlanPaymentCallbackUrl(src: string | undefined): boolean {
  if (!src) return false;
  try {
    const url = new URL(src);
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    if (
      !isTrustedCodingPlanWebviewOrigin(url.origin, {
        e2eStoreBridgeEnabled: process.env.VITE_ZCODE_E2E_STORE_BRIDGE === "1",
      })
    ) {
      return false;
    }
    if (!url.pathname.endsWith("/coding-plan/payment/callback")) return false;
    const returnTo = url.searchParams.get("returnTo");
    if (!returnTo) return false;
    const target = new URL(returnTo, url.origin);
    return target.origin === url.origin && isCodingPlanWebviewUrl(target.toString());
  } catch {
    return false;
  }
}

function isAllowedCodingPlanEmbeddedNavigationUrl(url: string): boolean {
  return (
    isCodingPlanWebviewUrl(url) ||
    isCodingPlanPaypalNavigationUrl(url) ||
    isCodingPlanPaymentCallbackUrl(url)
  );
}

function shouldKeepCodingPlanOpenExternalInWebview(currentUrl: string, targetUrl: string): boolean {
  return (
    (isCodingPlanWebviewUrl(currentUrl) || isCodingPlanPaypalNavigationUrl(currentUrl)) &&
    isAllowedCodingPlanEmbeddedNavigationUrl(targetUrl)
  );
}

export function registerRemoteIpcHandlers(options: {
  logger: {
    info: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
  };
  appTelemetryRuntime: {
    onRendererReady(payload: { hasPendingOAuthCallback: boolean; rendererId: number }): void;
    syncRendererContext(payload: { rendererId: number; context: unknown }): void;
    onOAuthCallbackHandled(payload: { rendererId: number }): void;
  };
  /** Extra side effects to run once the OAuth callback has been handled (e.g. refreshing the ARMS user.id); the existing runtime flow is unaffected */
  onOAuthCallbackHandledSideEffect?: () => void;
  appTelemetryCore: {
    reportEvent(payload: unknown): Promise<void>;
  };
  reportRemoteUsageEvent: (rendererId: number, event: TelemetryEventPayload) => void;
  armsCustomContext: {
    deviceMid: string;
    platform: NodeJS.Platform;
    appVersion: string;
    armsEnv: ArmsRumEnv;
  };
  /** Enabled only behind a double gate: `VITE_ZCODE_E2E_STORE_BRIDGE` + the test runner. */
  finalArmsCustomEventE2EEnabled?: boolean;
  createRemoteWorkspaceSession: (
    win: BrowserWindow,
    target: RemoteTarget,
    requestId?: string,
    context?: { workspacePath: string; workspaceIdentity?: string },
    lifecycle?: { remoteUsageTelemetryEligible?: boolean },
  ) => Promise<string>;
  getRemoteConnectionStats: () => RemoteConnectionStats;
  disposeRemoteWorkspaceSession: (
    sessionId: string,
    reason: string,
    signalGracePeriodMs?: number,
  ) => void;
  cancelPendingRemoteWorkspaceSessionsForWindow: (
    wcId: number,
    reason: string,
    requestId?: string,
  ) => void;
  bindRemoteWorkspaceSessionContext: (
    sessionId: string,
    context: { workspacePath: string; workspaceIdentity?: string },
    expectedWebContentsId?: number,
  ) => Promise<void>;
  confirmRendererAttachmentReady: (
    webContentsId: number,
    payload: { sessionId: string; attachmentId: string },
  ) => void;
  listAvailableWSLDistros: () => Promise<unknown[]>;
  listSSHConfigAliases: () => Promise<unknown[]>;
}) {
  function reportRemoteUsageEvent(rendererId: number, event: TelemetryEventPayload): void {
    try {
      options.reportRemoteUsageEvent(rendererId, event);
    } catch (error) {
      // The hidden point is the bypass capability, which cannot turn a successful remote connection into a business failure.
      options.logger.warn("[remote-usage-telemetry] dispatch failed", {
        elementName: event.elementName,
        error,
      });
    }
  }

  const finalArmsCustomEventE2E = options.finalArmsCustomEventE2EEnabled
    ? enableSharedFinalArmsCustomEventE2EController()
    : null;

  configureRemoteUsageArmsTelemetry({
    armsCustomContext: options.armsCustomContext,
    getRemoteConnectionStats: options.getRemoteConnectionStats,
    sendCustom: (payload) =>
      armsRum.sendCustom(payload as Parameters<typeof armsRum.sendCustom>[0]),
    e2eController: finalArmsCustomEventE2E,
    logger: options.logger,
  });

  function reportRemoteConnectResultToArmsSafely(
    params: Parameters<typeof reportRemoteConnectResultToArms>[0],
  ): void {
    try {
      reportRemoteConnectResultToArms(params);
    } catch (error) {
      options.logger.warn("[remote-usage-arms] connect result reporter failed", { error });
    }
  }

  ipcMain.on(InternalChannels.ScopedServicePortReady, (event, rawPayload: unknown) => {
    if (!rawPayload || typeof rawPayload !== "object") return;
    const payload = rawPayload as { sessionId?: unknown; attachmentId?: unknown };
    const sessionId = typeof payload.sessionId === "string" ? payload.sessionId.trim() : "";
    const attachmentId =
      typeof payload.attachmentId === "string" ? payload.attachmentId.trim() : "";
    if (!sessionId || !attachmentId) return;
    options.confirmRendererAttachmentReady(event.sender.id, { sessionId, attachmentId });
  });
  if (finalArmsCustomEventE2E) {
    ipcMain.handle(PlatformChannels.ReadFinalArmsCustomEventsE2E, () =>
      finalArmsCustomEventE2E.read(),
    );
    ipcMain.handle(PlatformChannels.ClearFinalArmsCustomEventsE2E, () => {
      finalArmsCustomEventE2E.clear();
    });
    ipcMain.handle(
      PlatformChannels.ConfigureFinalArmsCustomEventsE2E,
      (_event, request: unknown) => {
        finalArmsCustomEventE2E.configure(
          request as Parameters<typeof finalArmsCustomEventE2E.configure>[0],
        );
      },
    );
  }

  ipcMain.on(PlatformChannels.OAuthRegisterState, (event, payload: unknown) => {
    const registration = parseOAuthStateRegistration(payload);
    if (!registration) {
      options.logger.warn("[oauth-register-state] invalid payload", payload);
      return;
    }

    registerOAuthState(event.sender.id, registration);
  });

  ipcMain.on(PlatformChannels.OpenExternal, (event, payload: unknown) => {
    const request = parseOpenExternalRequest(payload);
    if (!request) {
      options.logger.warn("[open-external] blocked unsupported request", payload);
      return;
    }
    const { url } = request;
    if (!isAllowedExternalOpenUrl(url)) {
      options.logger.warn("[open-external] blocked unsupported url", url);
      return;
    }
    const sender = event.sender;
    const senderUrl = typeof sender?.getURL === "function" ? sender.getURL() : "";
    const senderFrameUrl =
      typeof event.senderFrame?.url === "string" ? event.senderFrame.url : undefined;
    const sourceUrl = senderFrameUrl ?? request.sourceUrl ?? senderUrl;
    if (
      typeof sender?.loadURL === "function" &&
      shouldKeepCodingPlanOpenExternalInWebview(sourceUrl, url)
    ) {
      // The openExternal of the official website embedded bridge will bypass the webview navigation guard;
      // The trusted callback after PayPal authorization is completed still needs to return to the current webview and cannot launch the system default browser.
      void sender.loadURL(url).catch((error: unknown) => {
        options.logger.warn("[open-external] failed to load coding-plan callback in webview", {
          error: error instanceof Error ? error.message : String(error),
          url,
        });
      });
      return;
    }
    void Promise.resolve(shell.openExternal(url)).catch((error: unknown) => {
      options.logger.warn("[open-external] failed to open the external URL", {
        url,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  });

  ipcMain.handle(PlatformChannels.OpenExternalFile, async (_event, rawPath: string) =>
    openPathInDefaultApp(rawPath, options.logger),
  );

  ipcMain.on(PlatformChannels.RendererReady, (event) => {
    const hasPendingOAuthCallback = deliverPendingDeepLink(event.sender);
    options.appTelemetryRuntime.onRendererReady({
      hasPendingOAuthCallback,
      rendererId: event.sender.id,
    });
  });

  ipcMain.on(PlatformChannels.SyncTelemetryContext, (event, context) => {
    options.appTelemetryRuntime.syncRendererContext({
      rendererId: event.sender.id,
      context,
    });
  });

  ipcMain.handle(PlatformChannels.ReportTelemetryEvent, async (_event, payload: unknown) => {
    const result = rendererTelemetryEventPayloadSchema.safeParse(payload);
    if (!result.success) {
      options.logger.warn(
        "[report-telemetry-event] invalid payload:",
        formatZodError(result.error),
      );
      return;
    }

    await options.appTelemetryCore.reportEvent(result.data);
  });

  ipcMain.handle(PlatformChannels.ReportArmsCustomEvent, async (event, payload: unknown) => {
    const result = armsCustomEventPayloadSchema.safeParse(payload);
    if (!result.success) {
      options.logger.warn(
        "[report-arms-custom-event] invalid payload:",
        formatZodError(result.error),
      );
      return;
    }

    try {
      dispatchFinalArmsCustomEvent({
        payload: result.data,
        context: {
          ...options.armsCustomContext,
          rendererId: event.sender.id,
        },
        e2eController: finalArmsCustomEventE2E,
        // FinalArmsCustomEventPayload is a narrowed subset of the SDK RumCustomEvent; additional SDK requirements
        // BaseObject index signature, but undeclared fields will not be dynamically appended here.
        sendCustom: (payload) =>
          armsRum.sendCustom(payload as Parameters<typeof armsRum.sendCustom>[0]),
      });
    } catch (error) {
      options.logger.warn(
        "[report-arms-custom-event] sendCustom failed:",
        normalizeUnknownError(error).message,
      );
    }
  });

  ipcMain.on(PlatformChannels.OAuthCallbackHandled, (event) => {
    options.appTelemetryRuntime.onOAuthCallbackHandled({ rendererId: event.sender.id });
    options.onOAuthCallbackHandledSideEffect?.();
  });

  ipcMain.on(PlatformChannels.ShowTaskNotification, (event, payload: unknown) => {
    dispatchTaskNotification({ event, payload, logger: options.logger });
  });
  ipcMain.handle(PlatformChannels.ShowTaskNotification, (event, payload: unknown) =>
    dispatchTaskNotification({ event, payload, logger: options.logger }),
  );

  app.on("browser-window-created", (_, win) => {
    const windowWebContentsId = win.webContents.id;
    win.on("closed", () => {
      // webContents may have been released by Electron during the closed phase of BrowserWindow.
      // Previously, reading win.webContents.id directly here would turn the normal window closing process into an uncaught exception in the main process.
      // Cache the ID in advance and then clean it up to avoid accessing destroyed objects.
      clearOAuthRoutesForWindow(windowWebContentsId);
    });
  });

  ipcMain.handle(PlatformChannels.ConnectRemote, async (event, rawPayload: unknown) => {
    const wrappedPayload: {
      target: unknown;
      requestId?: unknown;
      workspacePath?: unknown;
      workspaceIdentity?: unknown;
      connectTrigger?: unknown;
    } =
      rawPayload && typeof rawPayload === "object" && "target" in rawPayload
        ? (rawPayload as {
            target: unknown;
            requestId?: unknown;
            workspacePath?: unknown;
            workspaceIdentity?: unknown;
            connectTrigger?: unknown;
          })
        : { target: rawPayload, requestId: undefined };
    const result = remoteTargetSchema.safeParse(wrappedPayload.target);
    if (!result.success) {
      const error = `Invalid connect-remote payload: ${formatZodError(result.error)}`;
      options.logger.warn("[connect-remote]", error);
      return { success: false, error };
    }
    const requestId =
      typeof wrappedPayload.requestId === "string" && wrappedPayload.requestId.trim().length > 0
        ? wrappedPayload.requestId.trim()
        : undefined;
    const workspacePath =
      typeof wrappedPayload.workspacePath === "string" &&
      wrappedPayload.workspacePath.trim().length > 0
        ? wrappedPayload.workspacePath
        : undefined;
    const workspaceIdentity =
      typeof wrappedPayload.workspaceIdentity === "string" &&
      wrappedPayload.workspaceIdentity.trim().length > 0
        ? wrappedPayload.workspaceIdentity
        : undefined;
    const connectTriggerValue = wrappedPayload.connectTrigger;
    const connectTrigger =
      connectTriggerValue === "reconnect" || connectTriggerValue === "restore"
        ? connectTriggerValue
        : "new";

    try {
      const win = BrowserWindow.fromWebContents(event.sender);
      if (!win) {
        throw new Error("the current window was not found, cannot create a remote session");
      }

      const sessionId = await options.createRemoteWorkspaceSession(
        win,
        result.data,
        requestId,
        workspacePath ? { workspacePath, workspaceIdentity } : undefined,
        { remoteUsageTelemetryEligible: true },
      );
      reportRemoteUsageEvent(
        event.sender.id,
        buildRemoteWorkspaceConnectResultTelemetry({
          result: "success",
          remoteKind: result.data.kind,
          connectTrigger,
        }),
      );
      reportRemoteConnectResultToArmsSafely({
        rendererId: event.sender.id,
        result: "success",
        remoteKind: result.data.kind,
        connectTrigger,
      });
      return { success: true, sessionId };
    } catch (error) {
      const normalizedError = normalizeUnknownError(error);
      const errorCategory = classifyRemoteUsageError(error);
      // Before here, the Error object was directly handed over to the logger, and it would be compressed into `{}` by JSON.stringify when placed.
      // Change to explicitly expand message/code/stack to ensure that the real context can be seen in the main process log when remote connection establishment fails.
      options.logger.error("[connect-remote] caught error:", {
        message: normalizedError.message,
        code: normalizedError.code,
        stack: error instanceof Error ? error.stack : undefined,
      });
      reportRemoteUsageEvent(
        event.sender.id,
        buildRemoteWorkspaceConnectResultTelemetry({
          result: "failure",
          remoteKind: result.data.kind,
          connectTrigger,
          errorCategory,
        }),
      );
      reportRemoteConnectResultToArmsSafely({
        rendererId: event.sender.id,
        result: "failure",
        remoteKind: result.data.kind,
        connectTrigger,
        errorCategory,
      });
      return { success: false, error: normalizedError.message };
    }
  });

  ipcMain.handle(
    PlatformChannels.CancelPendingRemoteConnection,
    async (event, rawPayload: unknown) => {
      const payload =
        rawPayload && typeof rawPayload === "object" ? (rawPayload as { requestId?: unknown }) : {};
      const requestId =
        typeof payload.requestId === "string" && payload.requestId.trim().length > 0
          ? payload.requestId.trim()
          : undefined;
      // There is no sessionId before the connection is established, and the renderer cannot accurately notify main to cancel the ongoing connection.
      // Now, priority is given to accurately canceling the connection initiated by the current pop-up window by requestId to avoid accidentally damaging other concurrent connections in the same window.
      // If the requestId is missing, it will fall back to window-based cancellation, which is compatible with the old caller.
      options.cancelPendingRemoteWorkspaceSessionsForWindow(
        event.sender.id,
        `cancel-pending-remote-connection:${event.sender.id}`,
        requestId,
      );
    },
  );

  ipcMain.handle(
    PlatformChannels.BindRemoteWorkspaceSessionContext,
    async (event, rawPayload: unknown) => {
      if (!rawPayload || typeof rawPayload !== "object") {
        throw new Error("invalid remote workspace context payload");
      }
      const payload = rawPayload as {
        remoteSessionId?: unknown;
        workspacePath?: unknown;
        workspaceIdentity?: unknown;
      };
      const remoteSessionId =
        typeof payload.remoteSessionId === "string" ? payload.remoteSessionId.trim() : "";
      const workspacePath = typeof payload.workspacePath === "string" ? payload.workspacePath : "";
      const workspaceIdentity =
        typeof payload.workspaceIdentity === "string" ? payload.workspaceIdentity.trim() : "";
      if (!remoteSessionId || !workspacePath.trim()) {
        throw new Error("remote workspace context is missing sessionId or workspacePath");
      }
      await options.bindRemoteWorkspaceSessionContext(
        remoteSessionId,
        {
          workspacePath,
          ...(workspaceIdentity ? { workspaceIdentity } : {}),
        },
        event.sender.id,
      );
    },
  );

  ipcMain.handle(PlatformChannels.DisposeRemoteSession, async (_event, sessionId: string) => {
    options.disposeRemoteWorkspaceSession(sessionId, `dispose-remote-session:${sessionId}`, 150);
  });

  ipcMain.handle(PlatformChannels.ListWSLDistros, async () => {
    try {
      return await options.listAvailableWSLDistros();
    } catch (error) {
      options.logger.warn("[list-wsl-distros] detect failed:", error);
      return [];
    }
  });

  ipcMain.handle(PlatformChannels.ListSSHConfigAliases, async () => {
    try {
      return await options.listSSHConfigAliases();
    } catch (error) {
      const normalizedError = normalizeUnknownError(error);
      // If the Error object is directly placed on disk, it will be serialized into `{}`. When SSH config parsing fails, the specific pattern cannot be located.
      // Explicitly expand the error field to preserve compatible behavior of the UI returning an empty list while allowing the root cause to be visible in the log.
      options.logger.warn("[list-ssh-config-aliases] detect failed:", {
        message: normalizedError.message,
        code: normalizedError.code,
        name: error instanceof Error ? error.name : undefined,
        stack: error instanceof Error ? error.stack : undefined,
      });
      return [];
    }
  });
}
