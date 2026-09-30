import { DatabaseStartupAdmission } from "./databaseStartupAdmission.js";
import { initializeDesktopLocalTtft } from "./localTtftBootstrap.js";
import { createRoot } from "react-dom/client";
import { useEffect } from "react";
import {
  AppErrorBoundary,
  Root,
  GlobalDatabaseStartupLoading,
  UpdateStatusWindowRoot,
  ZCodeIntlProvider,
  registerBaseWorkspaceServices,
  registerRemoteWorkspaceSession,
  createRemoteWorkspaceDisconnectedError,
  playTaskNotificationSound,
  setStreamClientId,
  setReactErrorArmsReporter,
} from "@zcode/ui";
import "@zcode/ui/styles.css";
import { connectViaMessagePort, createMessagePortServiceConnection } from "@zcode/client";
import {
  InternalChannels,
  databaseStartupStateSchema,
  type DatabaseStartupControl,
  collectTelemetryRendererContext,
  parseLaunchMarks,
  LAUNCH_MARKS_QUERY_KEY,
  type LaunchMarks,
} from "@zcode/shared";
import type { IServiceAccessor } from "@zcode/services";
import { syncAppTelemetryContext } from "../appTelemetryBridge.js";
import { createDesktopPlatform } from "./desktopPlatform.js";
import { startPerformanceTimelineCleanup } from "./performanceTimelineCleanup.js";
import { initializeDesktopUserActionTrace } from "./userActionTraceBootstrap.js";
import { buildRemoteWorkspaceSessionServices } from "./remoteWorkspaceSessionServices.js";
import {
  notifyRemoteWorkspaceServicePortReady,
  parseRemoteWorkspaceServicePortMessage,
  type RemoteWorkspaceServicePortRegistration,
} from "./remoteWorkspaceServicePortBridge.js";

type DesktopRendererImportMetaEnv = {
  VITE_ZCODE_E2E_STORE_BRIDGE?: string;
};

startPerformanceTimelineCleanup();

// T4: renderer bundle starts executing. Also parse T0-T3 injected by main from the loadURL query.
const rendererStartedAt = Date.now();
const launchMarks: LaunchMarks | null = parseLaunchMarks(
  new URLSearchParams(window.location.search).get(LAUNCH_MARKS_QUERY_KEY),
);
(
  window as Window & {
    __ZCODE_RENDERER_START__?: number;
    __ZCODE_LAUNCH_MARKS__?: LaunchMarks | null;
  }
).__ZCODE_RENDERER_START__ = rendererStartedAt;
(window as Window & { __ZCODE_LAUNCH_MARKS__?: LaunchMarks | null }).__ZCODE_LAUNCH_MARKS__ =
  launchMarks;
registerE2EStoreBridgesIfEnabled();

function registerE2EStoreBridgesIfEnabled() {
  const env = ((import.meta as ImportMeta & { env?: DesktopRendererImportMetaEnv }).env ??
    {}) as DesktopRendererImportMetaEnv;
  if (env.VITE_ZCODE_E2E_STORE_BRIDGE !== "1") {
    return;
  }

  void import("@zcode/ui/e2e-store-bridge").then(({ registerE2EStoreBridges }) => {
    registerE2EStoreBridges();
  });
}

// Initialize theme: default Zai dark, later taken over by the useTheme hook
{
  const saved = localStorage.getItem("zcode-theme") || "zai-dark";
  const resolved =
    saved === "system"
      ? window.matchMedia("(prefers-color-scheme: dark)").matches
        ? "dark"
        : "light"
      : saved === "dark" || saved === "zai-dark"
        ? "dark"
        : "light";
  const appliedTheme =
    saved === "system"
      ? resolved === "dark"
        ? "zai-dark"
        : "zai-light"
      : saved === "dark"
        ? "zai-dark"
        : saved === "light"
          ? "zai-light"
          : saved;
  if (resolved === "dark") document.documentElement.classList.add("dark");
  document.documentElement.classList.toggle("theme-zai-light", appliedTheme === "zai-light");
  document.documentElement.classList.toggle("theme-zai-dark", appliedTheme === "zai-dark");
}

const isMacDesktop = navigator.userAgent.includes("Mac");
const isWindowsDesktop = navigator.userAgent.includes("Windows");
const isLinuxDesktop = !isMacDesktop && !isWindowsDesktop;
// macOS hidden native titlebar still participates in mouse drag hit-testing; deep overlays need a platform marker to avoid its height.
document.documentElement.classList.toggle("platform-mac-desktop", isMacDesktop);
// Windows native titleBarOverlay shares the top-right corner with the renderer; deep
// overlays that cannot access Root's isWindowsDesktop prop would place the close button
// inside the native window controls hit area. The root node platform marker only describes
// Desktop chrome and will not cause regular Windows Web to misuse the titlebar safe area.
document.documentElement.classList.toggle("platform-windows-desktop", isWindowsDesktop);
// Linux window titlebars are self-drawn by the renderer; if an in-app Dialog overlay
// covers the entire webContents, it also intercepts the titlebar click area. Tag the
// desktop Linux root node with a platform marker so UI overlays can avoid the titlebar
// only on Linux.
document.documentElement.classList.toggle("platform-linux-desktop", isLinuxDesktop);
const isLocalDevelopmentRuntime =
  (globalThis as typeof globalThis & { __ZCODE_LOCAL_DEVELOPMENT_RUNTIME__?: boolean })
    .__ZCODE_LOCAL_DEVELOPMENT_RUNTIME__ === true;

function readBooleanFlag(name: string, defaultValue: boolean): boolean {
  const value = new URLSearchParams(window.location.search).get(name);
  if (value == null) return defaultValue;
  return value !== "false" && value !== "0";
}

function readStringFlag(name: string): string | undefined {
  const value = new URLSearchParams(window.location.search).get(name);
  return value == null || value.trim() === "" ? undefined : value;
}

const restoreSession = readBooleanFlag("restoreSession", true);
const supportsSettings = readBooleanFlag("supportsSettings", true);
const initialWorkspaceAbsPath = readStringFlag("initialWorkspacePath");
const initialWorkspacePurpose = readStringFlag("initialWorkspacePurpose");
const unavailableWorkspacePath = readStringFlag("unavailableWorkspacePath");
const windowKind = readStringFlag("windowKind");
let baseServicesForRemoteSessions: IServiceAccessor | null = null;
const pendingRemoteWorkspaceServicePorts: RemoteWorkspaceServicePortRegistration[] = [];

const desktopPlatform = createDesktopPlatform({ isLocalDevelopmentRuntime });
initializeDesktopLocalTtft(desktopPlatform);
initializeDesktopUserActionTrace({
  platform: desktopPlatform,
  isLocalDevelopmentRuntime,
});

/**
 * Wait for preload to forward the MessagePort via window.postMessage.
 *
 * MessagePort cannot go through contextBridge (it loses native methods),
 * so preload uses window.postMessage + transfer to pass the port as-is to the renderer.
 * The port for local windows comes from utilityProcess, and remote windows are the same;
 * the renderer does not need to distinguish.
 */
// Previously an anonymous function was used to register addEventListener("message"),
// which would register repeatedly on reload/HMR, causing multiple createRoot calls
// mounting on the same DOM node. Use a flag to prevent duplicate initialization.
let appInitialized = false;
const databaseStartupAdmission = new DatabaseStartupAdmission();
const appRoot =
  windowKind === "update-status" ? null : createRoot(document.getElementById("root")!);
const sendStartupControl = (control: DatabaseStartupControl) =>
  window.postMessage({ type: InternalChannels.DatabaseStartupControl, control }, "*");
function renderDatabaseStartup(): void {
  appRoot?.render(
    <AppErrorBoundary isDesktop isMacDesktop={isMacDesktop} isWindowsDesktop={isWindowsDesktop}>
      <ZCodeIntlProvider>
        <StartupReadyNotifier />
        <GlobalDatabaseStartupLoading
          state={databaseStartupAdmission.state}
          onRetry={() => {
            if (databaseStartupAdmission.state)
              sendStartupControl({
                action: "retry",
                attemptId: databaseStartupAdmission.state.attemptId,
              });
          }}
          onCopy={(details) => navigator.clipboard.writeText(details)}
          onExit={() => sendStartupControl({ action: "exit" })}
        />
      </ZCodeIntlProvider>
    </AppErrorBoundary>,
  );
}
function enterAppIfPrepared(): void {
  if (appInitialized) return;
  const port = databaseStartupAdmission.takeReadyPort();
  if (port) initializeBusinessRoot(port);
}
const firstStartupStateTimer =
  windowKind === "update-status"
    ? undefined
    : setTimeout(() => {
        if (databaseStartupAdmission.state) return;
        const now = Date.now();
        databaseStartupAdmission.state = {
          schemaVersion: 1,
          startupId: "unavailable",
          attemptId: "startup-channel-unavailable",
          sequence: 0,
          startedAt: rendererStartedAt,
          updatedAt: now,
          phase: "failed",
          errorCode: "startup_status_timeout",
          disk: [],
        };
        renderDatabaseStartup();
      }, 30_000);

function registerRemoteWorkspaceServicePort(params: RemoteWorkspaceServicePortRegistration) {
  if (!baseServicesForRemoteSessions) {
    return;
  }

  const remoteConnection = createMessagePortServiceConnection(params.port);
  const remoteServices = remoteConnection.services;
  const services = buildRemoteWorkspaceSessionServices(
    baseServicesForRemoteSessions,
    remoteServices,
  );
  registerRemoteWorkspaceSession({
    sessionId: params.sessionId,
    target: params.target,
    services,
    dispose: (reason) =>
      remoteConnection.dispose(reason ?? createRemoteWorkspaceDisconnectedError()),
  });
  // canonical workspace bind rotates the remote-scoped port.
  // Only after the store has registered new services can ready be confirmed; callers
  // returning from the bind IPC can then re-read and use the new-generation services.
  notifyRemoteWorkspaceServicePortReady(params);
}

function flushPendingRemoteWorkspaceServicePorts(): void {
  if (!baseServicesForRemoteSessions || pendingRemoteWorkspaceServicePorts.length === 0) {
    return;
  }

  const pending = pendingRemoteWorkspaceServicePorts.splice(0);
  for (const entry of pending) {
    registerRemoteWorkspaceServicePort(entry);
  }
}

function StartupReadyNotifier() {
  useEffect(() => {
    // T5: React first commit. Used for startup phase timing to calculate the react_commit segment.
    (window as Window & { __ZCODE_REACT_COMMIT_AT__?: number }).__ZCODE_REACT_COMMIT_AT__ =
      Date.now();
    // When the HTML startup shell's pop animation ends, the React first frame may not have
    // committed yet; removing the shell directly would reveal a blank screen. After React
    // commits, notify index.html here, and the startup shell then uniformly decides when to
    // exit based on both the animation and React ready conditions.
    window.dispatchEvent(new Event("zcode-react-startup-ready"));
  }, []);

  return null;
}

function handleServicePortMessage(event: MessageEvent): void {
  if (event.source === window && event.data?.type === InternalChannels.DatabaseStartupState) {
    const result = databaseStartupStateSchema.safeParse(event.data.state);
    if (!result.success || appInitialized) return;
    const next = result.data;
    if (!databaseStartupAdmission.acceptState(next)) return;
    if (firstStartupStateTimer) clearTimeout(firstStartupStateTimer);
    renderDatabaseStartup();
    enterAppIfPrepared();
    return;
  }

  if (event.data === InternalChannels.TaskNotificationSound) {
    void playTaskNotificationSound();
    return;
  }

  const remoteWorkspacePort = parseRemoteWorkspaceServicePortMessage(event);
  if (remoteWorkspacePort) {
    if (!baseServicesForRemoteSessions) {
      // On renderer reload, main may deliver the remote port before the local ServicePort.
      // The early-arriving remote port must not be dropped, otherwise the SSH host remains
      // alive but the UI enters a disconnected proxy state.
      pendingRemoteWorkspaceServicePorts.push(remoteWorkspacePort);
      return;
    }

    registerRemoteWorkspaceServicePort(remoteWorkspacePort);
    return;
  }

  if (
    event.source !== window ||
    event.data?.type !== InternalChannels.ServicePort ||
    appInitialized
  )
    return;
  const port = event.ports[0];
  if (!port) return;
  databaseStartupAdmission.acceptPort({ databaseStartupId: event.data.databaseStartupId }, port);
  enterAppIfPrepared();
}

function initializeBusinessRoot(port: MessagePort): void {
  appInitialized = true;
  const services = connectViaMessagePort(port);
  baseServicesForRemoteSessions = services;
  registerBaseWorkspaceServices(services);
  flushPendingRemoteWorkspaceServicePorts();

  syncAppTelemetryContext({
    bridge: {
      syncTelemetryContext: (context) => window.zcode.syncTelemetryContext(context),
    },
    createRendererContext: collectTelemetryRendererContext,
  });

  // Initialize a stable device ID to ensure all hooks use the correct value before first render
  setStreamClientId(desktopPlatform.getDeviceId());

  // Exceptions caught by the React error boundary do not bubble to window.onerror, so the
  // RUM Browser SDK does not receive them by default. The reporter must be injected before
  // createRoot: the root-level AppErrorBoundary's job is to catch Root's own render crash;
  // if injection relied on Root's effect, the report would be lost when Root crashes on its
  // first frame.
  setReactErrorArmsReporter(desktopPlatform);

  appRoot?.render(
    <AppErrorBoundary isDesktop isMacDesktop={isMacDesktop} isWindowsDesktop={isWindowsDesktop}>
      <ZCodeIntlProvider>
        <StartupReadyNotifier />
        <Root
          services={services}
          platform={desktopPlatform}
          isDesktop
          assistantCodeCommentCardsEnabled
          isMacDesktop={isMacDesktop}
          isWindowsDesktop={isWindowsDesktop}
          restoreSession={restoreSession}
          supportsSettings={supportsSettings}
          initialWorkspaceAbsPath={initialWorkspaceAbsPath}
          initialWorkspacePurpose={
            initialWorkspacePurpose === "conversation" ? "conversation" : "project"
          }
          unavailableWorkspacePath={unavailableWorkspacePath}
        />
      </ZCodeIntlProvider>
    </AppErrorBoundary>,
  );
}

window.addEventListener("message", handleServicePortMessage);
if (windowKind !== "update-status") {
  renderDatabaseStartup();
  sendStartupControl({ action: "snapshot" });
}

if (windowKind === "update-status") {
  createRoot(document.getElementById("root")!).render(
    <AppErrorBoundary isDesktop isMacDesktop={isMacDesktop} isWindowsDesktop={isWindowsDesktop}>
      <StartupReadyNotifier />
      <UpdateStatusWindowRoot platform={desktopPlatform} onRequestClose={() => window.close()} />
    </AppErrorBoundary>,
  );
}
