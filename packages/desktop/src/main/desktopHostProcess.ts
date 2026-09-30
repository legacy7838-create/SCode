import { ingestToolExecResource } from "./desktopResourceTelemetry.js";
import { ingestMcpResourceSamples } from "./processResourceMcpTelemetrySource.js";
/* eslint-disable max-lines -- host process handles the main↔host life cycle, logs, and ZCode Agent in a unified manner, and maintains cross-process message closing before splitting. */
import { bindDatabaseStartupRelay } from "./databaseStartupRelay.js";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  app,
  BrowserWindow,
  MessageChannelMain,
  utilityProcess as electronUtilityProcess,
} from "electron";
import type { MessagePortMain, UtilityProcess as ElectronUtilityProcess } from "electron";
import {
  type HostAgentProcessErrorResponse,
  type HostAgentProcessExceptionResponse,
  type HostAgentProcessExitedResponse,
  type HostAgentProcessReadyResponse,
  type HostAgentProcessSpawnedResponse,
  type HostCuaOperationStateResponse,
  type HostMcpTelemetryResponse,
  type HostSessionCreateTelemetryResponse,
  type TaskRealtimeHostDeliveryKind,
  formatZCodeHostProcessName,
  HostMessageTypes,
  HostResponseTypes,
  hostResponseMessageSchema,
  InternalChannels,
  LAUNCH_MARKS_QUERY_KEY,
  RUNTIME_ZCODE_DEBUG,
  serializeLaunchMarks,
  type RemoteTarget,
  type WorkspacePurpose,
  ZCODE_DESKTOP_CONTEXT_PROMPT_ENABLED_ENV,
} from "@zcode/shared";
import { getMainLaunchPartialMarks } from "./desktopLaunchMarks.js";
import { BroadcastHub } from "./broadcastHub.js";
import type { TaskRealtimeBus } from "./taskRealtimeBus.js";
import { createHostLogRelay } from "./hostLogRelay.js";
import {
  registerHostAgentProcess,
  registerHostProcess,
  unregisterHostAgentProcess,
  unregisterHostProcess,
} from "./resourceManagerWindow.js";
import { resolveHostResourceUsageResult } from "./resourceManagerHostSampling.js";
import {
  buildHostProcessEnv,
  hostModulePath,
  resolveBundledGlmBinaryPath,
} from "./desktopRuntimeEnv.js";
import { ingestHostNetworkObservations } from "./desktopNetworkTelemetry.js";
import { ingestCliResourceSample } from "./processResourceCliSource.js";
import { ingestHostSelfResourceSample } from "./processResourceSelfHeapSource.js";
import { createFeedbackLogArchiveFromExportLogs } from "./exportLogs.js";
import { buildHostE2ECoverageEnv } from "./e2eCoverage.js";

export interface WindowBootstrapOptions {
  restoreSession?: boolean;
  supportsSettings?: boolean;
  initialWorkspacePath?: string;
  initialWorkspacePurpose?: WorkspacePurpose;
  unavailableWorkspacePath?: string;
  windowKind?: "main" | "update-status";
  locale?: string;
}

export interface HostInitMessage {
  type: typeof HostMessageTypes.InitLocal;
  hostId?: string;
  databaseStartupId?: string;
  deliveryKind?: TaskRealtimeHostDeliveryKind;
  deviceMid?: string;
  feedbackApiBase?: string;
  workspacePath?: string;
  workspaceIdentity?: string;
  agentWarmupTargets?: Array<{
    workspacePath: string;
    workspaceIdentity?: string;
  }>;
  agentSpawnFallbackCwd?: string;
  /** Main parsed ZCode Built-in Provider Config path; Host/Services is not aware of Electron installation layout. */
  zcodeBuiltinProviderConfigFilePath: string;
  /** Main The native runtime environment that is asynchronously collected and filtered in advance; only allowed to be passed to InitLocal. */
  runtimeProcessEnvPatch?: Record<string, string>;
}

interface SpawnHostProcessOptions {
  internalChannel?: typeof InternalChannels.ServicePort | typeof InternalChannels.ScopedServicePort;
  internalPayload?: unknown;
  registerBroadcast?: boolean;
  taskRealtime?: {
    workspaceKeys: Iterable<string>;
    deliveryKind?: TaskRealtimeHostDeliveryKind;
    onHostId?: (hostId: string) => void;
  };
  onPortReady?: (port: MessagePortMain) => void;
  /** The shared SSH/WSL Host does not create a special first workspace RPC port when initializing. */
  attachInitialServicePort?: boolean;
}

const exitedHostProcesses = new WeakSet<ElectronUtilityProcess>();
const disposingHostProcesses = new Set<ElectronUtilityProcess>();

export function listDisposingHostProcesses(): ElectronUtilityProcess[] {
  return Array.from(disposingHostProcesses);
}

export function loadWindow(
  win: BrowserWindow,
  page: "index" | "login" = "index",
  bootstrap?: WindowBootstrapOptions,
): Promise<void> {
  const query = Object.fromEntries(
    Object.entries({
      restoreSession:
        bootstrap?.restoreSession == null ? undefined : String(bootstrap.restoreSession),
      supportsSettings:
        bootstrap?.supportsSettings == null ? undefined : String(bootstrap.supportsSettings),
      initialWorkspacePath: bootstrap?.initialWorkspacePath,
      initialWorkspacePurpose: bootstrap?.initialWorkspacePurpose,
      unavailableWorkspacePath: bootstrap?.unavailableWorkspacePath,
      windowKind: bootstrap?.windowKind,
      locale: bootstrap?.locale,
    }).filter((entry): entry is [string, string] => entry[1] != null),
  );

  if (page === "index") {
    const partial = getMainLaunchPartialMarks();
    query[LAUNCH_MARKS_QUERY_KEY] = serializeLaunchMarks({
      ...partial,
      loadUrl: Date.now(), // T3
    });
  }

  // The production package cannot trust the development server address in the inherited environment, otherwise it will be hijacked by the native development session as a blank page.
  if (!app.isPackaged && process.env["ELECTRON_RENDERER_URL"]) {
    const base = process.env["ELECTRON_RENDERER_URL"];
    const url = new URL(page === "login" ? `${base}/login.html` : base);
    for (const [key, value] of Object.entries(query)) {
      url.searchParams.set(key, value);
    }
    return win.loadURL(url.toString());
  } else {
    return win.loadFile(join(import.meta.dirname, `../renderer/${page}.html`), {
      query,
    });
  }
}

export function spawnHostProcess(
  win: BrowserWindow,
  label: string,
  initMessage: HostInitMessage,
  dependencies: {
    hostProcessLocalEnv: Record<string, string>;
    /** The Main process has completed the server-side grayscale decision; the Host only consumes this snapshot and does not request or bucket it by itself. */
    desktopContextPromptEnabled?: () => boolean;
    logger: {
      info: (...args: unknown[]) => void;
      warn: (...args: unknown[]) => void;
    };
    broadcastHub: BroadcastHub;
    taskRealtimeBus?: TaskRealtimeBus;
    windowHostProcessMap: Map<number, ElectronUtilityProcess>;
    hostRunningTaskCountMap: Map<ElectronUtilityProcess, number>;
    onWorkspaceRunningTaskCountChanged?: (
      child: ElectronUtilityProcess,
      event: {
        workspacePath: string;
        workspaceIdentity?: string;
        runningTaskCount: number;
      },
    ) => void;
    onAgentProcessExited?: (event: HostAgentProcessExitedResponse) => void;
    onAgentProcessError?: (event: HostAgentProcessErrorResponse) => void;
    onAgentProcessException?: (event: HostAgentProcessExceptionResponse) => void;
    onAgentProcessReady?: (event: HostAgentProcessReadyResponse) => void;
    onAgentProcessSpawned?: (event: HostAgentProcessSpawnedResponse) => void;
    onMcpTelemetry?: (event: HostMcpTelemetryResponse) => void;
    onSessionCreateTelemetry?: (event: HostSessionCreateTelemetryResponse) => void;
    onCuaOperationStateChanged?: (
      source: ElectronUtilityProcess,
      event: HostCuaOperationStateResponse,
    ) => void;
    onCuaOperationStateSourceExited?: (source: ElectronUtilityProcess) => void;
    handleBotRemoteWorkspaceReconnectRequest?: (params: {
      win: BrowserWindow;
      requestId: string;
      workspacePath: string;
      workspaceIdentity: string;
      target: RemoteTarget;
    }) => Promise<{ ok: boolean; sessionId?: string; error?: string }>;
    handleBotRemoteWorkspaceConnectionStatusRequest?: (params: {
      win: BrowserWindow;
      requestId: string;
      workspacePath: string;
      workspaceIdentity: string;
      target: RemoteTarget;
    }) => Promise<{ ok: boolean; connected?: boolean; error?: string }>;
    handleBotRemoteWorkspaceRuntimePortRequest?: (params: {
      win: BrowserWindow;
      requestId: string;
      workspacePath: string;
      workspaceIdentity: string;
      target: RemoteTarget;
    }) => Promise<{ ok: boolean; port?: MessagePortMain; error?: string }>;
    /** host → main: Scheduled task dispatch results are transferred to the cron scheduler settlement scheduling state machine. */
    onCronRunResult?: (result: {
      runId: string;
      ok: boolean;
      taskId?: string;
      sessionId?: string;
      error?: string;
      failureKind?: "transient" | "permanent";
    }) => void;
    /** host → main: Task dispatch results in idle time are transferred to the scheduler for settlement (independent of cron). */
    onOffPeakRunResult?: (result: {
      offPeakTaskId: string;
      ok: boolean;
      conversationId?: string;
      sessionId?: string;
      error?: string;
      failureKind?: "transient" | "permanent";
    }) => void;
    /** After manual run in the host is dropped, main is requested to wake up the scheduler immediately. */
    onCronSchedulerWakeRequested?: (automationId: string) => void;
    /** When the host is idle, the task turns schedulable and requests main to wake up the scheduler immediately. */
    onOffPeakSchedulerWakeRequested?: (offPeakTaskId?: string) => void;
    // browser-use:main executes a command with WebContentsView+CDP. Implementation is injected by the host; default is backend_unavailable.
    handleBrowserExecuteRequest?: (params: {
      win: BrowserWindow;
      requestId: string;
      browserId?: string;
      browserGeneration?: number;
      sessionId: string;
      turnId?: string;
      workspaceKey?: string;
      workspacePath?: string;
      workspaceIdentity?: string;
      remoteSessionId?: string;
      clientMode?: "desktop-continuous" | "web-remote-replayable";
      sessionContext?: "live" | "cached";
      command: unknown;
    }) => Promise<{ ok: boolean; [k: string]: unknown }>;
    /** After the Host has completed the attachment authorization, the Main will add the local video realpath to the precise protocol authorization set. */
    authorizeLocalMediaPreviewPath?: (path: string) => Promise<string>;
  },
  options?: SpawnHostProcessOptions,
): ElectronUtilityProcess {
  const hostId = randomUUID();
  const glmBinaryPath = resolveBundledGlmBinaryPath();
  const execArgv = [
    ...(RUNTIME_ZCODE_DEBUG ? [`--inspect-brk=${RUNTIME_ZCODE_DEBUG}`] : []),
    "--no-warnings",
  ];
  const child = electronUtilityProcess.fork(hostModulePath, [], {
    serviceName: formatZCodeHostProcessName(label),
    execArgv,
    env: {
      ...buildHostProcessEnv(dependencies.hostProcessLocalEnv),
      ...buildHostE2ECoverageEnv(),
      ZCODE_PROCESS_LABEL: label,
      // macOS-only: the Computer Use Helper launcher runs inside this forked host utilityProcess, whose
      // code-signing identity is a nested Electron helper (NOT dev.zcode.app). Publish THIS (main
      // Electron) process's pid — which IS dev.zcode.app — so helperLauncher passes it as
      // `--launcher-pid` and the Helper's signature/peer verification succeeds instead of
      // health-timing out. Env-name mirror of services' LAUNCHER_PID_ENV. Not set on
      // Windows/Linux (CUA is macOS-only; nothing reads it there) to keep the host env pristine.
      ...(process.platform === "darwin" ? { ZCODE_CUA_LAUNCHER_PID: String(process.pid) } : {}),
      ...(dependencies.desktopContextPromptEnabled
        ? {
            [ZCODE_DESKTOP_CONTEXT_PROMPT_ENABLED_ENV]: dependencies.desktopContextPromptEnabled()
              ? "1"
              : "0",
          }
        : {}),
    },
  });

  dependencies.logger.info(
    `[spawnHostProcess] forked host process for (${label}), pid=${child.pid}`,
  );
  dependencies.logger.info(`[spawnHostProcess] host module path: ${hostModulePath}`);
  dependencies.logger.info(`[spawnHostProcess] glm binary path: ${glmBinaryPath ?? "<not found>"}`);
  dependencies.logger.info(
    `[spawnHostProcess] BIGMODEL_OAUTH_APP_SECRET source: ${process.env.BIGMODEL_OAUTH_APP_SECRET ? "process" : dependencies.hostProcessLocalEnv.BIGMODEL_OAUTH_APP_SECRET ? "dotenv" : "fallback"}`,
  );

  // The remote connection shares the window Host with the local service, and the process-level stdout has no request identity.
  // The connection progress is reported by HostResponseTypes.RemoteWorkspaceConnectionLog by requestId.
  const hostLogRelay = createHostLogRelay(
    label,
    dependencies.logger as Parameters<typeof createHostLogRelay>[1],
  );

  child.stderr?.on("data", (data: Buffer) => {
    hostLogRelay.onStderr(data.toString());
  });
  child.stdout?.on("data", (data: Buffer) => {
    hostLogRelay.onStdout(data.toString());
  });

  const databaseStartupRelay = bindDatabaseStartupRelay(win, child, hostId);
  child.on("message", (message: unknown) => {
    const result = hostResponseMessageSchema.safeParse(message);
    if (!result.success) {
      return;
    }

    if (result.data.type === HostResponseTypes.DatabaseStartupState) {
      databaseStartupRelay.receive(result.data.state);
      return;
    }

    if (result.data.type === HostResponseTypes.Log) {
      hostLogRelay.onStructuredLog(result.data);
      return;
    }

    if (result.data.type === HostResponseTypes.NetworkTelemetryBatch) {
      ingestHostNetworkObservations(result.data.observations);
      return;
    }

    // CLI self-collected 60-second sample: lanes played by services are classified into cli_chat / cli_aux roles.
    if (result.data.type === HostResponseTypes.AgentResourceSample) {
      ingestCliResourceSample(
        result.data.sample,
        result.data.runtimeSurface,
        result.data.environmentKey,
      );
      return;
    }

    // A 60-second sample collected by Host: main only takes heap as the heap dimension of the host role event.
    if (result.data.type === HostResponseTypes.HostResourceSample) {
      ingestHostSelfResourceSample(result.data.sample);
      return;
    }

    if (result.data.type === HostResponseTypes.ResourceUsageSnapshotResult) {
      resolveHostResourceUsageResult(label, result.data);
      return;
    }

    if (result.data.type === HostResponseTypes.ToolExecResource) {
      ingestToolExecResource(result.data.sample, result.data.runtimeSurface);
      return;
    }

    if (result.data.type === HostResponseTypes.McpResourceSamples) {
      ingestMcpResourceSamples(
        result.data.samples,
        result.data.runtimeSurface,
        result.data.environmentKey,
      );
      return;
    }

    if (result.data.type === HostResponseTypes.McpTelemetry) {
      dependencies.onMcpTelemetry?.(result.data);
      return;
    }

    if (result.data.type === HostResponseTypes.SessionCreateTelemetry) {
      dependencies.onSessionCreateTelemetry?.(result.data);
      return;
    }

    if (result.data.type === HostResponseTypes.LocalMediaPreviewPathAuthorizeRequest) {
      const request = result.data;
      const authorize = dependencies.authorizeLocalMediaPreviewPath;
      if (!authorize) {
        child.postMessage({
          type: HostMessageTypes.LocalMediaPreviewPathAuthorizeResult,
          requestId: request.requestId,
          ok: false,
          error: "Local media preview path authorization is unavailable.",
        });
        return;
      }
      void authorize(request.path)
        .then((path) => {
          child.postMessage({
            type: HostMessageTypes.LocalMediaPreviewPathAuthorizeResult,
            requestId: request.requestId,
            ok: true,
            path,
          });
        })
        .catch((error) => {
          child.postMessage({
            type: HostMessageTypes.LocalMediaPreviewPathAuthorizeResult,
            requestId: request.requestId,
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          });
        });
      return;
    }

    if (result.data.type === HostResponseTypes.CuaOperationState) {
      // Main only projects the turn status that has been determined by the Host, and does not repeatedly parse the session/tool ​​business events here.
      dependencies.onCuaOperationStateChanged?.(child, result.data);
      return;
    }

    if (result.data.type === HostResponseTypes.FeedbackLogArchiveRequest) {
      const request = result.data;
      void createFeedbackLogArchiveFromExportLogs(request.sourceDir)
        .then((archive) => {
          child.postMessage({
            type: HostMessageTypes.FeedbackLogArchiveResult,
            requestId: request.requestId,
            ok: true,
            path: archive.path,
            size: archive.size,
          });
        })
        .catch((error) => {
          child.postMessage({
            type: HostMessageTypes.FeedbackLogArchiveResult,
            requestId: request.requestId,
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          });
        });
      return;
    }

    if (result.data.type === HostResponseTypes.BrowserExecuteRequest) {
      // browser-use: main executes the command with WebContentsView+CDP (handleBrowserExecuteRequest).
      // The default implementation returns backend_unavailable to ensure that the channel is open but not blocked.
      const requestId = result.data.requestId;
      const handler = dependencies.handleBrowserExecuteRequest;
      const fallback = {
        ok: false as const,
        error: {
          code: "backend_unavailable",
          message: "browser executor not ready",
        },
        elapsedMs: 0,
      };
      void (
        handler
          ? handler({
              win,
              requestId,
              browserId: result.data.browserId,
              browserGeneration: result.data.browserGeneration,
              sessionId: result.data.sessionId,
              turnId: result.data.turnId,
              workspaceKey: result.data.workspaceKey,
              workspacePath: result.data.workspacePath,
              workspaceIdentity: result.data.workspaceIdentity,
              remoteSessionId: result.data.remoteSessionId,
              clientMode: result.data.clientMode,
              sessionContext: result.data.sessionContext,
              command: result.data.command,
            }).catch((error: unknown) => ({
              ok: false as const,
              error: {
                code: "execution_error",
                message: error instanceof Error ? error.message : String(error),
              },
              elapsedMs: 0,
            }))
          : Promise.resolve(fallback)
      ).then((commandResult) => {
        child.postMessage({
          type: HostMessageTypes.BrowserExecuteResult,
          requestId,
          result: commandResult,
        });
      });
      return;
    }

    if (result.data.type === HostResponseTypes.AgentProcessSpawned) {
      registerHostAgentProcess(label, {
        pid: result.data.pid,
        provider: result.data.provider,
        workspacePath: result.data.workspacePath,
        command: result.data.command,
        args: result.data.args,
        startedAt: result.data.startedAt,
      });
      dependencies.onAgentProcessSpawned?.(result.data);
      return;
    }

    if (result.data.type === HostResponseTypes.AgentProcessReady) {
      dependencies.onAgentProcessReady?.(result.data);
      return;
    }

    if (result.data.type === HostResponseTypes.AgentProcessExited) {
      unregisterHostAgentProcess(label, result.data.pid);
      dependencies.onAgentProcessExited?.(result.data);
      return;
    }

    if (result.data.type === HostResponseTypes.AgentProcessError) {
      dependencies.onAgentProcessError?.(result.data);
      return;
    }

    if (result.data.type === HostResponseTypes.AgentProcessException) {
      dependencies.onAgentProcessException?.(result.data);
      return;
    }

    if (result.data.type === HostResponseTypes.CronRunResult) {
      dependencies.onCronRunResult?.({
        runId: result.data.runId,
        ok: result.data.ok,
        taskId: result.data.taskId,
        sessionId: result.data.sessionId,
        error: result.data.error,
        failureKind: result.data.failureKind,
      });
      return;
    }

    if (result.data.type === HostResponseTypes.OffPeakRunResult) {
      dependencies.onOffPeakRunResult?.({
        offPeakTaskId: result.data.offPeakTaskId,
        ok: result.data.ok,
        conversationId: result.data.conversationId,
        sessionId: result.data.sessionId,
        error: result.data.error,
        failureKind: result.data.failureKind,
      });
      return;
    }

    if (result.data.type === HostResponseTypes.CronSchedulerWakeRequest) {
      dependencies.onCronSchedulerWakeRequested?.(result.data.automationId);
      return;
    }

    if (result.data.type === HostResponseTypes.OffPeakSchedulerWakeRequest) {
      dependencies.onOffPeakSchedulerWakeRequested?.(result.data.offPeakTaskId);
      return;
    }

    if (result.data.type === HostResponseTypes.AgentRunningTaskCountChanged) {
      if (result.data.runningTaskCount > 0) {
        dependencies.hostRunningTaskCountMap.set(child, result.data.runningTaskCount);
      } else {
        dependencies.hostRunningTaskCountMap.delete(child);
      }
      dependencies.logger.info(
        `[app-quit] host running agent sessions updated (${label}) count=${result.data.runningTaskCount}`,
      );
      return;
    }

    if (result.data.type === HostResponseTypes.WorkspaceRunningTaskCountChanged) {
      dependencies.onWorkspaceRunningTaskCountChanged?.(child, {
        workspacePath: result.data.workspacePath,
        workspaceIdentity: result.data.workspaceIdentity,
        runningTaskCount: result.data.runningTaskCount,
      });
      return;
    }


    if (result.data.type === HostResponseTypes.BotRemoteWorkspaceReconnectRequest) {
      const request = result.data;
      const handler = dependencies.handleBotRemoteWorkspaceReconnectRequest;
      if (!handler) {
        child.postMessage({
          type: HostMessageTypes.BotRemoteWorkspaceReconnectResult,
          requestId: request.requestId,
          ok: false,
          // Bugfix: /reconnect requires the main side bridge, and returns a clear reason when the handler is missing to avoid continuing to display a general inaccessibility.
          error: "The Bot remote workspace reconnect handler was not injected.",
        });
        return;
      }

      void handler({
        win,
        requestId: request.requestId,
        workspacePath: request.workspacePath,
        workspaceIdentity: request.workspaceIdentity,
        target: request.target,
      })
        .then((reconnectResult) => {
          child.postMessage({
            type: HostMessageTypes.BotRemoteWorkspaceReconnectResult,
            requestId: request.requestId,
            ok: reconnectResult?.ok === true,
            sessionId: reconnectResult?.sessionId,
            error: reconnectResult?.error,
          });
        })
        .catch((error) => {
          child.postMessage({
            type: HostMessageTypes.BotRemoteWorkspaceReconnectResult,
            requestId: request.requestId,
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          });
        });
      return;
    }

    if (result.data.type === HostResponseTypes.BotRemoteWorkspaceConnectionStatusRequest) {
      const request = result.data;
      const handler = dependencies.handleBotRemoteWorkspaceConnectionStatusRequest;
      if (!handler) {
        child.postMessage({
          type: HostMessageTypes.BotRemoteWorkspaceConnectionStatusResult,
          requestId: request.requestId,
          ok: false,
          error: "The Bot remote workspace connection status handler was not injected.",
        });
        return;
      }

      void handler({
        win,
        requestId: request.requestId,
        workspacePath: request.workspacePath,
        workspaceIdentity: request.workspaceIdentity,
        target: request.target,
      })
        .then((statusResult) => {
          child.postMessage({
            type: HostMessageTypes.BotRemoteWorkspaceConnectionStatusResult,
            requestId: request.requestId,
            ok: statusResult?.ok === true,
            connected: statusResult?.connected,
            error: statusResult?.error,
          });
        })
        .catch((error) => {
          child.postMessage({
            type: HostMessageTypes.BotRemoteWorkspaceConnectionStatusResult,
            requestId: request.requestId,
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          });
        });
      return;
    }

    if (result.data.type === HostResponseTypes.BotRemoteWorkspaceRuntimePortRequest) {
      const request = result.data;
      const handler = dependencies.handleBotRemoteWorkspaceRuntimePortRequest;
      if (!handler) {
        child.postMessage({
          type: HostMessageTypes.BotRemoteWorkspaceRuntimePort,
          requestId: request.requestId,
          ok: false,
          // Bugfix: Remote Bot cannot fall back to the local ZCode Agent when the runtime bridge is missing.
          // Otherwise, the tasks of the remote workspace will be written locally and the error model will be triggered.
          error: "The Bot remote workspace runtime handler was not injected.",
        });
        return;
      }

      void handler({
        win,
        requestId: request.requestId,
        workspacePath: request.workspacePath,
        workspaceIdentity: request.workspaceIdentity,
        target: request.target,
      })
        .then((runtimeResult) => {
          if (runtimeResult.ok && runtimeResult.port) {
            child.postMessage(
              {
                type: HostMessageTypes.BotRemoteWorkspaceRuntimePort,
                requestId: request.requestId,
                ok: true,
              },
              [runtimeResult.port],
            );
            return;
          }
          child.postMessage({
            type: HostMessageTypes.BotRemoteWorkspaceRuntimePort,
            requestId: request.requestId,
            ok: false,
            error: runtimeResult.error ?? "unknown",
          });
        })
        .catch((error) => {
          child.postMessage({
            type: HostMessageTypes.BotRemoteWorkspaceRuntimePort,
            requestId: request.requestId,
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          });
        });
      return;
    }
  });

  const shouldAttachRealtimeHost = options?.taskRealtime != null;
  const hostInitMessage: HostInitMessage = shouldAttachRealtimeHost
    ? {
        ...initMessage,
        databaseStartupId: databaseStartupRelay.startupId,
        hostId,
        deliveryKind: options?.taskRealtime?.deliveryKind,
      }
    : { ...initMessage, databaseStartupId: databaseStartupRelay.startupId };

  if (options?.attachInitialServicePort === false) {
    child.postMessage(hostInitMessage);
  } else {
    const { port1, port2 } = new MessageChannelMain();
    child.postMessage(hostInitMessage, [port2]);

    if (options?.onPortReady) {
      options.onPortReady(port1);
    } else {
      win.webContents.postMessage(
        options?.internalChannel ?? InternalChannels.ServicePort,
        options?.internalChannel === InternalChannels.ScopedServicePort
          ? (options.internalPayload ?? null)
          : { databaseStartupId: databaseStartupRelay.startupId },
        [port1],
      );
    }
  }

  const windowId = win.webContents.id;
  const shouldRegisterBroadcast = options?.registerBroadcast ?? true;
  if (shouldRegisterBroadcast) {
    dependencies.broadcastHub.register(windowId, child);
  }

  if (shouldAttachRealtimeHost && dependencies.taskRealtimeBus && options?.taskRealtime) {
    dependencies.taskRealtimeBus.registerHost({
      hostId,
      windowId: win.id,
      child,
      workspaceKeys: options.taskRealtime.workspaceKeys,
      deliveryKind: options.taskRealtime.deliveryKind,
    });
    options.taskRealtime.onHostId?.(hostId);
  }

  registerHostProcess(label, child);

  child.on("exit", (code) => {
    exitedHostProcesses.add(child);
    // Host exit is a fail-hidden authority boundary; you cannot rely on the host that is about to exit to reissue inactive.
    dependencies.onCuaOperationStateSourceExited?.(child);
    hostLogRelay.flushRawLogs();
    dependencies.logger.info(`[spawnHostProcess] host process (${label}) exited with code ${code}`);
    dependencies.hostRunningTaskCountMap.delete(child);
    if (shouldRegisterBroadcast) {
      dependencies.broadcastHub.unregister(windowId);
    }
    unregisterHostProcess(label);
    for (const [wcId, process] of dependencies.windowHostProcessMap) {
      if (process === child) {
        dependencies.windowHostProcessMap.delete(wcId);
        break;
      }
    }
  });

  return child;
}

export function disposeHostProcess(
  child: ElectronUtilityProcess,
  label: string,
  disposingHostProcessTimers: WeakMap<ElectronUtilityProcess, ReturnType<typeof setTimeout>>,
  logger: {
    info: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
  },
  forceKillDelayMs = 300,
) {
  if (disposingHostProcessTimers.has(child)) {
    return;
  }
  disposingHostProcesses.add(child);

  logger.info(
    `[disposeHostProcess] disposing host process (${label}), pid=${child.pid ?? "unknown"}`,
  );

  try {
    child.postMessage({ type: HostMessageTypes.Dispose });
  } catch (error) {
    logger.warn(`[disposeHostProcess] failed to post dispose to (${label}):`, error);
  }

  // After receiving the Dispose, the host needs to wait for the SIGTERM/SIGKILL completion of the agent process tree.
  // If main still kills the host in 150/300ms, the host will exit first, and the zcode-cli/app-server child process may be taken over by init and become an orphan.
  const effectiveForceKillDelayMs = Math.max(forceKillDelayMs, 3_500);
  const killTimer = setTimeout(() => {
    disposingHostProcessTimers.delete(child);
    try {
      child.kill();
    } catch (error) {
      logger.warn(`[disposeHostProcess] failed to kill host process (${label}):`, error);
    }
  }, effectiveForceKillDelayMs);

  disposingHostProcessTimers.set(child, killTimer);
  child.once("exit", () => {
    exitedHostProcesses.add(child);
    disposingHostProcesses.delete(child);
    clearTimeout(killTimer);
    disposingHostProcessTimers.delete(child);
  });
}
export function disposeHostProcessAndWait(
  child: ElectronUtilityProcess,
  label: string,
  disposingHostProcessTimers: WeakMap<ElectronUtilityProcess, ReturnType<typeof setTimeout>>,
  logger: {
    info: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
  },
  options: {
    forceKillDelayMs?: number;
    waitTimeoutMs?: number;
  } = {},
): Promise<void> {
  // Electron UtilityProcess is not a Node ChildProcess and does not have an exitCode field.
  // Right-click the Dock to exit before-quit -> disposeHostProcessAndWait; the old judgment is to dispose the running host
  // The undefined exitCode is treated as "exited". Here, the exit event is recorded instead to avoid missing Dispose when exiting for the first time.
  if (exitedHostProcesses.has(child)) {
    return Promise.resolve();
  }

  const waitTimeoutMs = Math.max(options.waitTimeoutMs ?? 0, 0);

  return new Promise((resolve) => {
    let settled = false;
    let waitTimeout: ReturnType<typeof setTimeout> | null = null;

    const settle = () => {
      if (settled) {
        return;
      }
      settled = true;
      if (waitTimeout) {
        clearTimeout(waitTimeout);
        waitTimeout = null;
      }
      resolve();
    };

    child.once("exit", () => {
      exitedHostProcesses.add(child);
      settle();
    });

    if (waitTimeoutMs > 0) {
      waitTimeout = setTimeout(() => {
        logger.warn(
          `[disposeHostProcessAndWait] host process exit wait timed out (${label}), pid=${child.pid ?? "unknown"}`,
        );
        settle();
      }, waitTimeoutMs);
      waitTimeout.unref?.();
    }

    disposeHostProcess(child, label, disposingHostProcessTimers, logger, options.forceKillDelayMs);
  });
}
