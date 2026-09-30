/* eslint-disable max-lines -- The Host entry point centrally orchestrates local/remote service wiring, and this exit guard has to bridge host reporting in the same place. */
/* eslint-disable max-lines -- The host process entry point centrally owns local/remote initialization and resource reclamation; after the realtime bridge lands it stays consolidated in one file for now. */
/**
 * Host Process entry point —— each window gets its own dedicated host process
 *
 * The renderer of a given window and phones both attach to this Host:
 *   Renderer / Mobile ←MessagePort→ Window Host
 *                                      ├─ local services
 *                                      └─ remote connection registry
 *
 * Startup flow:
 * 1. The main process creates this process via Electron `utilityProcess.fork()`
 * 2. The main process sends init-local exactly once to initialize the window Host
 * 3. Every later remote connect / scoped attachment is handled by that same Host
 */
import { createHostDatabaseStartup } from "./hostDatabaseStartup.js";
import { installNativeRpcBytesPort } from "@zcode/rpc/native";
import { randomUUID } from "node:crypto";
// Node host: CRC32 is the one byte primitive where Rust wins (28x-73x, invariant 10), so bind the
// Node port at startup. Throws loudly if the binary is missing — no JS fallback.
installNativeRpcBytesPort();
import {
  MessagePortProtocol,
  ChannelServer,
  type IDisposable,
  type IChannelServer,
  LoggingChannelServer,
  NetworkTelemetryChannelServer,
} from "@zcode/rpc";
import { registerHostNetworkTelemetry, stopHostNetworkTelemetry } from "./hostNetworkTelemetry.js";
import { registerHostServiceResourceTelemetry } from "./hostServiceResourceTelemetry.js";
import { resolveResourceTelemetryEnvironmentKey } from "./hostResourceTelemetryEnvironment.js";
import { reportHostSessionCreate } from "./hostSessionCreateTelemetry.js";
import { createBrowserControlMainBridge } from "./browserControlMainBridge.js";
import { materializeBrowserRecordingArtifact } from "./browserRecordingArtifactMaterializer.js";
import {
  ServiceCollection,
  IBotsService,
  IFileService,
  IClientConfigService,
  IMediaPreviewService,
  IOffPeakTaskService,
  IModelSelectionService,
  ISettingService,
  IWindowControllerService,
  IConversationShareService,
  IZCodeAgentService,
  IZCodeTaskService,
  IZCodeSessionService,
  ICuaPipSessionService,
  createZCodeAgentConnectionScope,
  type ZCodeAgentV4ClientMode,
  collectServiceMemoryDiagnostics,
} from "@zcode/services";
import {
  createLocalServices,
  getOffPeakRequestAuthBuilder,
  disposeServiceResources,
  disposeServiceResourcesAndWait,
  AutomationRepo,
  OffPeakTaskRepo,
  OffPeakTaskService,
  createServiceLogger,
  buildTaskChangeSummary,
  createHostApiNetworkTransport,
  createSettingServiceWithMigrations,
  OffPeakModelUnavailableError,
  OffPeakPermanentDispatchError,
  type HostApiNetworkTransport,
  type OffPeakRequestAuthBuilder,
} from "@zcode/services/node";
import { createHostResourceUsageResponder } from "./hostResourceUsage.js";
import {
  assertBoundSessionDispatchable,
  resolveOffPeakDispatchKind,
} from "./offPeakDispatchPlan.js";
import {
  HostMessageTypes,
  HostResponseTypes,
  ZCODE_VERSION,
  formatLogPrefix,
  formatZCodeHostProcessName,
  formatZodError,
  buildRemoteWorkspaceIdentity,
  buildRemoteEnvironmentKey,
  isOffPeakTicketExpiredError,
  isRemoteWorkspaceIdentity,
  resolveWorkspaceKey,
  formatModelPickerValue,
  type ZCodePromptAttachment,
  type ZCodeStreamEvent,
  type ZCodeTaskMeta,
  type TaskStreamMirrorableEvent,
  type TraceId,
  type ZCodeTaskMode,
  type WindowHostAttachmentScope,
  type ZCodeAutomation,
  type ZCodeAutomationRun,
  type ZCodeAutomationRunOutcome,
  type ModelSelection,
} from "@zcode/shared";
import {
  parseHostIncomingMessageEvent,
  rejectUnavailableAttachedServicePort,
} from "./hostMessagePortGuard.js";
// Delayed loading of remote backend related modules: ssh2's CJS dependency chain (asn1, etc.) has a broken path after asar packaging.
// Static import will cause the host process in local mode to also crash.
// Change to dynamic import, which is only loaded in remote mode.
import type {
  ConnectOptions,
  DeployLockMode,
  IRemoteBackend,
  RemoteRuntimeNetworkOptions,
  RemoteAssetNetworkPort,
  RemoteConnection,
} from "@zcode/server/remote";
import type { RemoteTarget } from "@zcode/shared";
import { wrapElectronPort } from "./electronPort.js";
import { createTaskRealtimeBridgeForHostInit } from "./taskRealtimeBridge.js";
import { resolveRpcLogLevel } from "./rpcLogLevel.js";
import { createHostWorkspaceTaskTracker } from "./hostWorkspaceTaskTracker.js";
import {
  createRemoteMediaPreviewProxy,
  type RemoteMediaPreviewProxy,
} from "./remoteMediaPreviewProxy.js";
import { watchCronRunBotDelivery } from "./cronBotDelivery.js";
import { createHostRemoteWorkspaceProxyState } from "./hostRemoteWorkspaceProxyState.js";
import { createRemoteWorkspaceServiceCollection } from "./remoteWorkspaceServiceCollection.js";
import { getRemoteProviderProvisioningExecutor } from "./remoteProviderProvisioningService.js";
import { createRemotePromptAttachmentTransferService } from "./promptAttachmentTransferService.js";
import { shouldReportHostConsoleError, stringifyHostLogArg } from "./hostLog.js";
import { flushHostE2ECoverage } from "./e2eCoverage.js";
import { runHostShutdownPhases, type HostShutdownResult } from "./hostShutdownPhases.js";
import { initializeHostApiNetworkTransportOwner } from "./hostInitialization.js";
import { createHostUncaughtExceptionHandler } from "./hostUncaughtExceptionGuard.js";
import {
  recordCronRunOutcomeBestEffort,
  startManualClaimHeartbeat,
  settleCronRunTerminalOutcome,
  settleManualDispatchFailureBestEffort,
} from "./cronRunLifecycle.js";
import {
  createRemotePromptAttachmentSessionService,
  createRemotePromptAttachmentTaskService,
  materializeRemotePromptAttachments,
} from "./remotePromptAttachments.js";
import { createWindowHostAttachmentRegistry } from "./windowHostAttachmentRegistry.js";
import { scopeConversationShareServiceForAttachment } from "./conversationShareAttachmentService.js";
import {
  createWindowRemoteConnectionRegistry,
  type WindowRemoteConnectionCloseEvent,
  type WindowRemoteConnectionHandle,
} from "./windowRemoteConnectionRegistry.js";
import { createWindowHostControllerRuntime } from "./windowHostControllerService.js";
import { resolveAutomationSubmissionModelSelection } from "./automationModelSelection.js";
import { createRemoteConnectionProgressContext } from "@zcode/server/remote/remoteConnectionProgressContext.js";
import { startHostSelfResourceTelemetry } from "./hostSelfResourceTelemetry.js";
type RemoteBackendHostConnection = RemoteConnection & {
  backend: IRemoteBackend;
};
type HostRemoteConnection = RemoteBackendHostConnection;
interface HostRemoteConnectionCapabilities {
  browserRecordingUploader?: Pick<IRemoteBackend, "upload">;
  remoteMediaPreviewFactory?: (
    scope: Extract<WindowHostAttachmentScope, { kind: "remote" }>,
  ) => RemoteMediaPreviewProxy;
}

let activeRemoteMediaRequests = 0;
const hostRemoteMediaRequestLimiter = {
  tryAcquire: () => {
    if (activeRemoteMediaRequests >= 4) return false;
    activeRemoteMediaRequests += 1;
    return true;
  },
  release: () => {
    activeRemoteMediaRequests = Math.max(0, activeRemoteMediaRequests - 1);
  },
  getState: () => ({ active: activeRemoteMediaRequests, limit: 4 }),
};
const remoteMediaRangePreviewEnabled =
  process.env["ZCODE_REMOTE_MEDIA_RANGE_PREVIEW_ENABLED"] !== "0";

type RemoteAssetDirs = Pick<
  ConnectOptions,
  "mockCdnDir" | "remoteCdnBaseUrl" | "remoteCdnBaseUrls" | "remoteCacheDir"
>;

const { parentPort } = process;

// Process retrieval experience optimization: when the host is pulled up by utilityProcess, the shell is still Electron Helper.
// Here, a stable zcode-* title is added based on the window label passed in from main to facilitate filtering of the system process list.
process.title = formatZCodeHostProcessName(process.env["ZCODE_PROCESS_LABEL"]);

type HostLogLevel = "info" | "warn" | "error";

interface PendingFeedbackLogArchiveRequest {
  resolve: (archive: { path: string; size: number }) => void;
  reject: (error: Error) => void;
  onProgress?: (event: { processedBytes: number; totalBytes: number }) => void;
}

interface PendingLocalMediaPreviewPathAuthorization {
  resolve: (path: string) => void;
  reject: (error: Error) => void;
}

const pendingFeedbackLogArchiveRequests = new Map<string, PendingFeedbackLogArchiveRequest>();
let nextFeedbackLogArchiveRequestSeq = 0;
const pendingLocalMediaPreviewPathAuthorizations = new Map<
  string,
  PendingLocalMediaPreviewPathAuthorization
>();

function authorizeLocalMediaPreviewPath(path: string): Promise<string> {
  if (!parentPort) {
    return Promise.reject(new Error("parentPort unavailable"));
  }
  const requestId = randomUUID();
  return new Promise<string>((resolve, reject) => {
    pendingLocalMediaPreviewPathAuthorizations.set(requestId, { resolve, reject });
    try {
      parentPort.postMessage({
        type: HostResponseTypes.LocalMediaPreviewPathAuthorizeRequest,
        requestId,
        path,
      });
    } catch (error) {
      pendingLocalMediaPreviewPathAuthorizations.delete(requestId);
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

// browser-use host↔main bridge: transfer the agent's browser command to main (WebContentsView+CDP) via parentPort.
// When parentPort is empty (should not occur in the host process) postToMain throws an error, and the bridge itself returns backend_unavailable.
const browserControlMainBridge = createBrowserControlMainBridge({
  postToMain: (message) => {
    if (!parentPort) {
      throw new Error("parentPort unavailable");
    }
    parentPort.postMessage(message);
  },
  materializeRecording: (input) => {
    let remoteBackend: Pick<IRemoteBackend, "upload"> | undefined;
    if (input.remoteSessionId) {
      const workspaceIdentity = input.workspaceIdentity;
      if (!workspaceIdentity?.trim()) {
        throw new Error("remote Browser recording materialization requires workspaceIdentity");
      }
      // After the reconstruction of Window Host, the same process can hold multiple remote connections at the same time. The old process level
      // remoteConnection will string the session. The uploader must be fetched from the registry's authoritative entry with the full scope.
      remoteBackend = windowRemoteConnectionRegistry.resolveScopedCapabilities({
        kind: "remote",
        remoteSessionId: input.remoteSessionId,
        workspacePath: input.workspacePath,
        workspaceIdentity,
      })?.browserRecordingUploader;
    }
    return materializeBrowserRecordingArtifact({
      ...input,
      ...(remoteBackend ? { remoteBackend } : {}),
    });
  },
});

function reportHostLog(level: HostLogLevel, args: unknown[]): void {
  if (!parentPort) {
    return;
  }

  try {
    parentPort.postMessage({
      type: HostResponseTypes.Log,
      level,
      source: "host",
      message: args.map((arg) => stringifyHostLogArg(arg)).join(" "),
    });
  } catch {
    // Log reporting failure should not affect the main host process.
  }
}

const rawConsole = {
  log: console.log.bind(console),
  warn: console.warn.bind(console),
  error: console.error.bind(console),
};

const remoteConnectionProgressContext = createRemoteConnectionProgressContext({
  emit: ({ requestId, level, args }) => {
    if (!parentPort) {
      return;
    }
    try {
      parentPort.postMessage({
        type: HostResponseTypes.RemoteWorkspaceConnectionLog,
        requestId,
        level,
        message: args.map((arg) => stringifyHostLogArg(arg)).join(" "),
      });
    } catch {
      // Failure to report connection progress should not interrupt the actual SSH/WSL connection process.
    }
  },
});

function writeHostLog(level: HostLogLevel, ...args: unknown[]): void {
  const prefix = formatLogPrefix("zcode-host", process.pid);
  const consoleFn =
    level === "error" ? rawConsole.error : level === "warn" ? rawConsole.warn : rawConsole.log;
  consoleFn(prefix, ...args);
  reportHostLog(level, [prefix, ...args]);
}

function createFullFeedbackLogArchiveViaMain(
  sourceDir: string,
  options?: {
    onProgress?: (event: { processedBytes: number; totalBytes: number }) => void;
  },
): Promise<{ path: string; size: number }> {
  const requestId = `feedback-log-archive-${Date.now()}-${nextFeedbackLogArchiveRequestSeq++}`;
  options?.onProgress?.({ processedBytes: 0, totalBytes: 0 });

  return new Promise((resolve, reject) => {
    pendingFeedbackLogArchiveRequests.set(requestId, {
      resolve,
      reject,
      onProgress: options?.onProgress,
    });
    // Problem feedback: In the past, the full fallback of compactLogArchive was used in the host service.
    // The collection scope is inconsistent with the "export log", and the zcode-cli log, rollout/debug, and export link desensitization are missing.
    // Here, the complete log packaging is entrusted to the export log origin logic of the main process, and the host only uses the zip path to continue uploading.
    try {
      parentPort.postMessage({
        type: HostResponseTypes.FeedbackLogArchiveRequest,
        requestId,
        sourceDir,
      });
    } catch (error) {
      pendingFeedbackLogArchiveRequests.delete(requestId);
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

const logger = {
  info: (...args: unknown[]) => writeHostLog("info", ...args),
  warn: (...args: unknown[]) => writeHostLog("warn", ...args),
  error: (...args: unknown[]) => writeHostLog("error", ...args),
};

const cronAutomationRepo = new AutomationRepo();
const cronRunSubscriptions = new Map<string, { dispose(): void }>();

// ---- Off-peak task dispatch: independent link parallel to cron (tables/messages/constants are not reused with each other)----
const offPeakTaskRepo = new OffPeakTaskRepo();
const offPeakRunSubscriptions = new Map<string, { dispose(): void }>();
/**
 * Prompt word for continuation (implementation of "realization timing"): 3h time box expiration/resume the same after the app restarts and resumes
 * Session renewal. Rather than resending the original prompt (which would cause the model to do it all over again), it instructs you to continue unfinished work.
 */
const OFF_PEAK_RESUME_PROMPT =
  "Continue the previous task from where it left off. The run was interrupted " +
  "(app restart or execution window expired). Do not start over; review what has " +
  "already been done and complete the remaining work.";

// ---- off-peak runtime assembly (server client + in-process mock gateway + orchestration service, host domain owner) ----
// ⚠ Multi-window = multiple hosts will each run a sync poll (the batch interface is idempotent, writes the same data to the same database, and repetition only consumes more requests);
// The mock gateway shares ticket state with a fixed port singleton. If multi-window polling magnifies the cost, add cross-host selection.
interface OffPeakRuntime {
  service: OffPeakTaskService;
  /** When dispatching, request-by-request authentication is performed according to this ticket structure; static model facts are provided by CLI Built-in Config. */
  buildRequestAuth: OffPeakRequestAuthBuilder;
  validateSelection: (selection: {
    providerId: string;
    modelId: string;
    options?: { reasoningLevel?: string };
  }) => Promise<boolean>;
}
let offPeakRuntime: OffPeakRuntime | null = null;

async function ensureOffPeakRuntime(): Promise<OffPeakRuntime | null> {
  if (offPeakRuntime) return offPeakRuntime;
  const services = activeServices;
  if (!services) return null;
  const service = services.getOptional(IOffPeakTaskService);
  const buildRequestAuth = getOffPeakRequestAuthBuilder(services);
  if (!service || !buildRequestAuth) {
    logger.warn("off-peak runtime unavailable: missing host services");
    return null;
  }
  offPeakRuntime = {
    service: service as OffPeakTaskService,
    buildRequestAuth,
    validateSelection: (selection) =>
      (service as OffPeakTaskService).validateDispatchModelSelection(selection),
  };
  logger.info("off-peak runtime ready (service from local collection)");
  return offPeakRuntime;
}

function disposeOffPeakRuntime(): void {
  if (!offPeakRuntime) return;
  offPeakRuntime = null;
}

interface OffPeakRunDispatchRequest {
  offPeakTaskId: string;
  prompt: string;
  permissionMode: string;
  modelSelection: ModelSelection;
  conversationId?: string;
  sessionId?: string;
  serverTicketId?: string;
  workspacePath: string;
  workspaceIdentity?: string;
}

function offPeakRunSubscriptionKey(taskId: string, traceId: TraceId): string {
  return `${taskId}\u0000${traceId}`;
}

function disposeOffPeakRunSubscription(key: string): void {
  const disposable = offPeakRunSubscriptions.get(key);
  if (!disposable) return;
  offPeakRunSubscriptions.delete(key);
  disposable.dispose();
}

/** Final state backfill files_changed: reuse existing task diff summary (the tool writes disk-type statistics, Bash changes are not included, accepted). */
async function resolveOffPeakFilesChanged(params: {
  zcodeTaskService: IZCodeTaskService;
  taskId: string;
  workspacePath: string;
  workspaceIdentity?: string;
}): Promise<number | undefined> {
  try {
    const snapshot = await params.zcodeTaskService.getTaskSnapshot({
      taskId: params.taskId,
      workspacePath: params.workspacePath,
      ...(params.workspaceIdentity ? { workspaceIdentity: params.workspaceIdentity } : {}),
    });
    const fileChanges = snapshot?.fileChanges;
    if (!fileChanges) return undefined;
    // Empty summaries (no files changed) are counted as 0 - "0 files changed" is true for completion notifications.
    return buildTaskChangeSummary(fileChanges)?.fileCount ?? 0;
  } catch (error) {
    logger.warn(
      "off-peak files_changed summary failed (does not block terminal state persistence):",
      error,
    );
    return undefined;
  }
}

/** loop final state → off_peak_tasks final state: succeeded→completed, stopped→cancelled (user manually stops), the rest→failed. */
async function finalizeOffPeakRun(params: {
  zcodeTaskService: IZCodeTaskService;
  offPeakTaskId: string;
  taskId: string;
  workspacePath: string;
  workspaceIdentity?: string;
  outcome: ZCodeAutomationRunOutcome;
  error?: string;
}): Promise<void> {
  // Automatic continuation: ticket expiration (active 3h expiration/ready invalid ticket) is not a failure——
  // Retrieve the same task_id number and return it to queued, wait for the next ready, and then resume the same session to continue running.
  if (params.outcome === "failed" && isOffPeakTicketExpiredError(params.error)) {
    const runtime = await ensureOffPeakRuntime();
    if (runtime) {
      await runtime.service.handleTicketExpiredDuringRun(params.offPeakTaskId);
      logger.info(
        `off-peak segment expired, requeued for continuation task=${params.offPeakTaskId}`,
      );
      return;
    }
    // When the runtime is unavailable (the service is missing), the database will be dropped as a normal failure to avoid the task being stuck in running.
  }
  const status =
    params.outcome === "succeeded"
      ? ("completed" as const)
      : params.outcome === "stopped"
        ? ("cancelled" as const)
        : ("failed" as const);
  const filesChanged = await resolveOffPeakFilesChanged(params);
  const updated = await offPeakTaskRepo.markTerminal(params.offPeakTaskId, {
    status,
    endedAt: Date.now(),
    ...(params.error ? { failureReason: params.error } : {}),
    ...(filesChanged !== undefined ? { filesChanged } : {}),
  });
  if (!updated) {
    // The final state is irreversible: the task has been canceled/deleted by the user in advance, and the late write-back is discarded (idempotent).
    logger.info(
      `off-peak terminal writeback dropped (already terminal) task=${params.offPeakTaskId}`,
    );
    return;
  }
  logger.info(
    `off-peak run finished task=${params.offPeakTaskId} status=${status} filesChanged=${filesChanged ?? "n/a"}`,
  );
  // When the background is completed, it will be set to unread and cleared by the navigation link when the task is opened (same as cron).
  void params.zcodeTaskService.setTaskUnread({
    taskId: params.taskId,
    workspacePath: params.workspacePath,
    ...(params.workspaceIdentity ? { workspaceIdentity: params.workspaceIdentity } : {}),
    unread: true,
  });
}

function trackOffPeakRunOutcome(params: {
  zcodeTaskService: IZCodeTaskService;
  offPeakTaskId: string;
  taskId: string;
  traceId: TraceId;
  workspacePath: string;
  workspaceIdentity?: string;
}): void {
  const key = offPeakRunSubscriptionKey(params.taskId, params.traceId);
  disposeOffPeakRunSubscription(key);
  const disposable = params.zcodeTaskService.onDynamicTaskTerminalOutcome(params.taskId)(
    (result) => {
      if (result.inputId !== params.traceId) return;
      disposeOffPeakRunSubscription(key);
      void finalizeOffPeakRun({
        zcodeTaskService: params.zcodeTaskService,
        offPeakTaskId: params.offPeakTaskId,
        taskId: params.taskId,
        workspacePath: params.workspacePath,
        ...(params.workspaceIdentity ? { workspaceIdentity: params.workspaceIdentity } : {}),
        outcome: result.outcome,
        ...(result.error ? { error: result.error } : {}),
      }).catch((error) => logger.warn("off-peak terminal state write back failed:", error));
    },
  );
  offPeakRunSubscriptions.set(key, disposable);
}

/**
 * Submit an idle task dispatch to the V4 task service of the current host.
 * First run (without conversationId) createTask creates a new exclusive session; resume/interruption resume
 * The same conversation is continued with the continuation prompt word. During idle time, complete Selection/Authentication is only injected into this execution.
 */
async function dispatchOffPeakRun(request: OffPeakRunDispatchRequest): Promise<{
  conversationId: string;
  sessionId: string;
}> {
  const zcodeTaskService = activeServices?.getOptional(IZCodeTaskService);
  if (!zcodeTaskService) {
    throw new Error("ZCode task service is not initialized.");
  }
  const runtime = await ensureOffPeakRuntime();
  if (!runtime) {
    throw new Error("off-peak runtime is not available");
  }
  if (!request.serverTicketId) {
    // schedulable must have taken the number; no ticket distribution means the snapshot is out of order, press transient receipt and wait for the next round (polling will replenish the ticket).
    throw new Error("off-peak dispatch without server ticket");
  }
  // The idle plan uses a normal Selection; the single execution constraint ensures that it does not write to the Session Selection.
  const idleSelection = request.modelSelection;
  if (!(await runtime.validateSelection(idleSelection))) {
    throw new OffPeakModelUnavailableError("idlePlan");
  }
  const requestAuth = await runtime.buildRequestAuth(request.serverTicketId);
  // The initial dispatch and the resume dispatch of the reused session need to be distinguishable in the round fact; this field only describes
  // The current automatic turn scheduling phase does not change the stable task ID, independent message ID, or manual message semantics.
  const dispatchKind = resolveOffPeakDispatchKind(request);
  const offPeakRunType = dispatchKind === "resume" ? "resume" : "init";
  let trackedKey: string | null = null;
  try {
    let taskId: string;
    let traceId: TraceId;
    let promptContent = request.prompt;
    if (dispatchKind === "bound-first-run") {
      // Binding first run: Tasks created within a session are executed in the session in which they were created (aligned with the targetTaskId path of dispatchCronRun).
      // Detect first and then write the configuration: it is bound to the user's work session. When busy, the transient is directly handed over to the scheduler for backoff.
      // You cannot setMode first and then be rejected by session/send with -32010 (that will quietly change the permission mode of the user session).
      taskId = request.sessionId!;
      traceId = `${request.offPeakTaskId}:bound:${randomUUID()}` as TraceId;
      const workspaceScope = {
        workspacePath: request.workspacePath,
        workspaceIdentity: request.workspaceIdentity,
      };
      const [deletedIds, tasks] = await Promise.all([
        zcodeTaskService.listDeletedTaskIds(workspaceScope),
        zcodeTaskService.listTasks(workspaceScope),
      ]);
      assertBoundSessionDispatchable({
        sessionId: taskId,
        deleted: deletedIds.includes(taskId),
        running: tasks.find((task) => task.taskId === taskId)?.status === "running",
      });
      await zcodeTaskService.resumeTask({
        ...workspaceScope,
        taskId,
        // The binding session is stamped with the ownership mark for the first time, and the sidebar is classified into the idle group (the mechanism is the same as cron targetTaskId).
        offPeakTaskId: request.offPeakTaskId,
      });
      await zcodeTaskService.setConfigOption({
        taskId,
        traceId,
        configId: "mode",
        value: request.permissionMode,
      });
    } else if (dispatchKind === "resume") {
      // Continuation segment: resume the same session (cold recovery hydration history; resume must be done before sending).
      taskId = request.conversationId!;
      // Reason: offPeakTaskId is only used for cross-talk association; each automatic round must generate an independent message identity.
      // Task IDs cannot be reused, nor can they rely on the same millisecond timestamp to avoid collisions.
      traceId = `${request.offPeakTaskId}:resume:${randomUUID()}` as TraceId;
      promptContent = OFF_PEAK_RESUME_PROMPT;
      await zcodeTaskService.resumeTask({
        taskId,
        workspacePath: request.workspacePath,
        workspaceIdentity: request.workspaceIdentity,
        // Pre-administration session rewrites the ownership mark when the session is continued (double insurance in addition to bootstrap backfilling).
        offPeakTaskId: request.offPeakTaskId,
      });
      // The permission mode is issued with distribution (explicitly set after resume, idempotent).
      await zcodeTaskService.setConfigOption({
        taskId,
        traceId,
        configId: "mode",
        value: request.permissionMode,
      });
      // The gear is part of the idle Selection and is only injected in sendPrompt; writing the gear alone will pollute the user session.
    } else {
      const task = await zcodeTaskService.createTask({
        workspacePath: request.workspacePath,
        workspaceIdentity: request.workspaceIdentity,
        // Empty Sessions follow normal initialization; idle Selection is only injected in the execution below.
        // Writing here will cause ordinary messages after the idle round to continue to use the ticketless hidden provider.
        mode: request.permissionMode as ZCodeTaskMode,
        // The idle task is continuously dispatched by createTask + sendPrompt without interface; the empty session must be the first one
        // V4 admission is persisted first, otherwise the session_input foreign key will be written before the session master record.
        deferPersistenceUntilFirstPrompt: true,
        // A permanent ownership mark is stamped upon creation (moon icon/subsequent system grouping only looks at this mark and no longer checks the store).
        offPeakTaskId: request.offPeakTaskId,
      });
      taskId = task.taskId;
      traceId = task.traceId;
    }
    trackedKey = offPeakRunSubscriptionKey(taskId, traceId);
    trackOffPeakRunOutcome({
      zcodeTaskService,
      offPeakTaskId: request.offPeakTaskId,
      taskId,
      traceId,
      workspacePath: request.workspacePath,
      ...(request.workspaceIdentity ? { workspaceIdentity: request.workspaceIdentity } : {}),
    });
    await zcodeTaskService.sendPrompt({
      taskId,
      traceId,
      content: promptContent,
      clientMode: "desktop-continuous",
      // Bug reason: Automatic turn when idle. Previously, only idle plan was injected. There was no restriction on the tool surface. Models could be created in the background.
      // Persistent scheduled tasks. First run and continuation run converge here, explicitly hiding CronCreate and not forging cron automation ownership.
      // The idle wheel also hides OffPeakCreate, and OffPeakList is read-only and reserved.
      toolDenylist: ["CronCreate", "OffPeakCreate"],
      modelSelection: idleSelection,
      modelExecution: {
        // Execution credentials only serve the main Turn when idle; no automatic Memory requests are derived after completion.
        memoryExtraction: "skip",
        selectionScope: "execution",
        requestAuth,
        subagents: {
          foregroundModel: "submission",
          background: "deny",
        },
      },
      offPeakTaskId: request.offPeakTaskId,
      offPeakRunType,
    });
    // Only init is actually created; the binding first run and cross-ticket continuation are just subsequent inputs of the original Session.
    if (dispatchKind === "init") {
      reportHostSessionCreate(parentPort, {
        sessionId: taskId,
        messageId: traceId,
        source: "automation_idle",
        workspaceIdentity: request.workspaceIdentity,
      });
    }
    return { conversationId: taskId, sessionId: taskId };
  } catch (error) {
    if (trackedKey) disposeOffPeakRunSubscription(trackedKey);
    throw error;
  }
}

interface CronRunDispatchRequest {
  automationId: string;
  runId: string;
  prompt: string;
  targetTaskId?: string;
  modelSelection?: ModelSelection;
  mode?: ZCodeTaskMode;
  workspacePath: string;
  workspaceIdentity?: string;
}

function resolveAutomationTargetServices(request: {
  workspacePath: string;
  workspaceIdentity?: string;
}): ServiceCollection {
  const remoteSession = windowRemoteConnectionRegistry.findSessionForWorkspace(request);
  if (remoteSession) {
    if (!remoteSession.workspaceIdentity) {
      throw new Error("Automation target remote host is missing workspaceIdentity");
    }
    return windowRemoteConnectionRegistry.resolveScopedServices({
      kind: "remote",
      remoteSessionId: remoteSession.remoteSessionId,
      workspacePath: request.workspacePath,
      workspaceIdentity: remoteSession.workspaceIdentity,
    });
  }
  // When remote Automation cannot find the target logical session, the old distribution will silently fall to the Local Host.
  // Thus using the local model is preferred with the Registry. Remote identities can only fail, not across Environment fallbacks.
  if (request.workspaceIdentity && isRemoteWorkspaceIdentity(request.workspaceIdentity)) {
    throw new Error("Automation target remote host is currently unavailable");
  }
  if (!activeServices) {
    throw new Error("Local Host services are not initialized.");
  }
  return activeServices;
}

function cronRunSubscriptionKey(taskId: string, traceId: TraceId): string {
  return `${taskId}\u0000${traceId}`;
}

function parseCronRunScheduledAt(runId: string, automationId: string): number | null {
  const prefix = `${automationId}:`;
  if (!runId.startsWith(prefix)) return null;
  const value = Number(runId.slice(prefix.length).split(":")[0]);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

function markCronRunOutcome(params: {
  runId: string;
  automationId: string;
  workspaceKey: string;
  scheduledAt: number | null;
  trigger: "schedule" | "manual";
  outcome: ZCodeAutomationRunOutcome;
  error?: string;
}): void {
  void recordCronRunOutcomeBestEffort({
    ...params,
    repo: cronAutomationRepo,
    logWarn: (message, error) => logger.warn(message, error),
  });
}

function disposeCronRunSubscription(key: string): void {
  const disposable = cronRunSubscriptions.get(key);
  if (!disposable) return;
  cronRunSubscriptions.delete(key);
  disposable.dispose();
}

async function applyCronRunConfigToExistingTask(params: {
  zcodeTaskService: IZCodeTaskService;
  taskId: string;
  traceId: TraceId;
  modelSelection?: ModelSelection;
  mode?: string;
}): Promise<void> {
  let thoughtAppliedWithModel = false;
  let modeAppliedWithModel = false;
  if (params.modelSelection) {
    await params.zcodeTaskService.setAutomationSessionConfig({
      taskId: params.taskId,
      traceId: params.traceId,
      modelSelection: params.modelSelection,
      thoughtLevel: params.modelSelection.options?.reasoningLevel,
      mode: params.mode?.trim() as ZCodeTaskMode | undefined,
    });
    thoughtAppliedWithModel = true;
    modeAppliedWithModel = true;
  }
  if (!modeAppliedWithModel && params.mode?.trim()) {
    await params.zcodeTaskService.setConfigOption({
      taskId: params.taskId,
      traceId: params.traceId,
      configId: "mode",
      value: params.mode.trim(),
    });
  }
  if (!thoughtAppliedWithModel && params.modelSelection?.options?.reasoningLevel) {
    await params.zcodeTaskService.setConfigOption({
      taskId: params.taskId,
      traceId: params.traceId,
      configId: "thought_level",
      value: params.modelSelection.options.reasoningLevel,
    });
  }
}

function trackCronRunOutcome(params: {
  zcodeTaskService: IZCodeTaskService;
  taskId: string;
  traceId: TraceId;
  workspacePath: string;
  workspaceIdentity?: string;
  runId: string;
  automationId: string;
  workspaceKey: string;
  scheduledAt: number | null;
  trigger: "schedule" | "manual";
}): void {
  const key = cronRunSubscriptionKey(params.taskId, params.traceId);
  disposeCronRunSubscription(key);
  markCronRunOutcome({ ...params, outcome: "running" });
  const disposable = params.zcodeTaskService.onDynamicTaskTerminalOutcome(params.taskId)(
    (result) => {
      if (result.inputId !== params.traceId) return;
      void settleCronRunTerminalOutcome({
        ...params,
        outcome: result.outcome,
        error: result.error,
        repo: cronAutomationRepo,
        logWarn: (message, error) => logger.warn(message, error),
      });
      // After the scheduled task is completed in the background, it will be set as unread, and will be cleared by the navigation link when the task is actually opened.
      void params.zcodeTaskService.setTaskUnread({
        taskId: params.taskId,
        workspacePath: params.workspacePath,
        ...(params.workspaceIdentity ? { workspaceIdentity: params.workspaceIdentity } : {}),
        unread: true,
      });
      disposeCronRunSubscription(key);
    },
  );
  const claimHeartbeat =
    params.trigger === "manual"
      ? startManualClaimHeartbeat({
          ...params,
          repo: cronAutomationRepo,
          logWarn: (message, error) => logger.warn(message, error),
        })
      : null;
  cronRunSubscriptions.set(key, {
    dispose() {
      claimHeartbeat?.dispose();
      disposable.dispose();
    },
  });
}

/**
 * Submit a cron/manual run directly to the V4 task service of the current host.
 * In-session automation may be bound to an inactive session and must be restored before applying saved run parameters.
 */
async function dispatchCronRun(request: CronRunDispatchRequest): Promise<{
  taskId: string;
  sessionId: string;
}> {
  const targetServices = resolveAutomationTargetServices(request);
  const zcodeTaskService = targetServices.getOptional(IZCodeTaskService);
  if (!zcodeTaskService) {
    throw new Error("ZCode task service is not initialized.");
  }
  const modelSelectionService = targetServices.getOptional(IModelSelectionService);
  if (!modelSelectionService) {
    throw new Error("Target host Model Selection service is not initialized.");
  }
  // Long-term configuration is the original intention; first dispatch is fixed after target Host resolution. Existing run must be reused directly.
  // Historical execution selections cannot be reinterpreted due to account changes or failure to read the Registry this time.
  const existingRun = await cronAutomationRepo.getRun(request.runId);
  const resolvedSubmissionModelSelection = await resolveAutomationSubmissionModelSelection({
    selection: request.modelSelection,
    fixedSelection: existingRun?.modelSelection,
    modelSelectionService,
    // Repo has been imported offline before being read; Agent/account services are no longer bypassed for migration.
    // New values ​​that have not been migrated or are corrupted are still explicitly rejected by this portal and cannot be treated as following the Workspace.
    readSelection: () =>
      cronAutomationRepo.getModelSelectionForDispatch(
        request.automationId,
        resolveWorkspaceKey(request),
      ),
  });
  const submissionModelSelection = await cronAutomationRepo.fixRunModelSelection(
    request.runId,
    resolvedSubmissionModelSelection,
  );
  let trackedKey: string | null = null;
  const workspaceKey = resolveWorkspaceKey(request);
  const trigger = request.runId.includes(":manual:") ? "manual" : "schedule";
  const scheduledAt = parseCronRunScheduledAt(request.runId, request.automationId);
  try {
    const task = request.targetTaskId
      ? { taskId: request.targetTaskId }
      : await zcodeTaskService.createTask({
          workspacePath: request.workspacePath,
          workspaceIdentity: request.workspaceIdentity,
          model: formatModelPickerValue(submissionModelSelection),
          mode: request.mode,
          thoughtLevel: submissionModelSelection.options?.reasoningLevel,
          automationId: request.automationId,
        });
    // When the session is not bound, the session trace of createTask cannot be used as the first prompt trace:
    // CLI cannot restore manual/schedule admission from inputId.
    // Creating a session trace and executing the runId are two identities; the prompts of both distribution paths must use the runId uniformly.
    const promptTraceId = request.runId as TraceId;
    if (request.targetTaskId) {
      // Binding sessions are usually not active after the app restarts or switches workspaces; the old implementation directly
      // setConfig/sendPrompt will immediately report that Session is not active, which looks like "Run Now" is not triggered.
      await zcodeTaskService.resumeTask({
        taskId: task.taskId,
        workspacePath: request.workspacePath,
        workspaceIdentity: request.workspaceIdentity,
        model: formatModelPickerValue(submissionModelSelection),
        thoughtLevel: submissionModelSelection.options?.reasoningLevel,
        automationId: request.automationId,
      });
      await applyCronRunConfigToExistingTask({
        zcodeTaskService,
        taskId: task.taskId,
        traceId: promptTraceId,
        modelSelection: submissionModelSelection,
        mode: request.mode,
      });
    }
    const botsService = targetServices.getOptional(IBotsService);
    if (botsService) {
      try {
        await watchCronRunBotDelivery({
          automationId: request.automationId,
          workspaceKey,
          workspacePath: request.workspacePath,
          ...(request.workspaceIdentity ? { workspaceIdentity: request.workspaceIdentity } : {}),
          taskId: task.taskId,
          repo: cronAutomationRepo,
          botsService,
        });
      } catch (error) {
        // Bot pushback is a best-effort auxiliary channel; configuration/credential/subscription failure cannot block automation dispatch and settlement.
        logger.warn(
          `automation Bot delivery subscription failed automation=${request.automationId} provider=unknown`,
          error,
        );
      }
    }
    trackedKey = cronRunSubscriptionKey(task.taskId, promptTraceId);
    trackCronRunOutcome({
      zcodeTaskService,
      taskId: task.taskId,
      traceId: promptTraceId,
      workspacePath: request.workspacePath,
      workspaceIdentity: request.workspaceIdentity,
      runId: request.runId,
      automationId: request.automationId,
      workspaceKey,
      scheduledAt,
      trigger,
    });
    await zcodeTaskService.sendPrompt({
      taskId: task.taskId,
      traceId: promptTraceId,
      content: request.prompt,
      clientMode: "desktop-continuous",
      automationId: request.automationId,
    });
    // The scheduled task created by prompt has targetTaskId, and appending the original session cannot be counted as session_create.
    if (!request.targetTaskId) {
      reportHostSessionCreate(parentPort, {
        sessionId: task.taskId,
        messageId: promptTraceId,
        source: "automation_scheduled",
        workspaceIdentity: request.workspaceIdentity,
      });
    }
    return { taskId: task.taskId, sessionId: task.taskId };
  } catch (error) {
    if (trackedKey) disposeCronRunSubscription(trackedKey);
    markCronRunOutcome({
      runId: request.runId,
      automationId: request.automationId,
      workspaceKey,
      scheduledAt,
      trigger,
      outcome: "failed",
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

async function dispatchManualAutomationRun(params: {
  automation: ZCodeAutomation;
  run: ZCodeAutomationRun;
}): Promise<void> {
  logger.info(
    `direct manual automation dispatch started automation=${params.automation.automationId} runId=${params.run.runId}`,
  );
  let result: Awaited<ReturnType<typeof dispatchCronRun>>;
  try {
    result = await dispatchCronRun({
      automationId: params.automation.automationId,
      runId: params.run.runId,
      prompt: params.automation.prompt,
      targetTaskId: params.automation.targetTaskId,
      modelSelection: params.run.modelSelection ?? params.automation.modelSelection,
      mode: params.automation.mode,
      workspacePath: params.automation.workspacePath,
      workspaceIdentity: params.automation.workspaceIdentity,
    });
  } catch (error) {
    logger.warn(
      `direct manual automation dispatch failed automation=${params.automation.automationId} runId=${params.run.runId}:`,
      error,
    );
    await settleManualDispatchFailureBestEffort({
      repo: cronAutomationRepo,
      automationId: params.automation.automationId,
      runId: params.run.runId,
      workspaceKey: params.automation.workspaceKey,
      scheduledAt: params.run.scheduledAt ?? null,
      trigger: "manual",
      dispatchError: error,
      logWarn: (message, releaseError) => logger.warn(message, releaseError),
    });
    throw error;
  }

  try {
    await cronAutomationRepo.markManualRunDispatched({
      runId: params.run.runId,
      sessionId: result.sessionId,
      dispatchedAt: Date.now(),
    });
  } catch (error) {
    // The prompt has been accepted/queued, and failure to write back the ledger and cumulative number of times cannot be disguised as a distribution failure and release the lock in advance;
    // The real final state is still closed by trackCronRunOutcome to avoid repeated queuing of the same automation.
    logger.warn(
      `failed to write back manual automation dispatched state and run count automation=${params.automation.automationId} runId=${params.run.runId}`,
      error,
    );
  }
  // sendPrompt ACK may only indicate entering the busy queue; manual claim must be retained until the corresponding turn final state.
  logger.info(
    `direct manual automation dispatch accepted automation=${params.automation.automationId} runId=${params.run.runId} taskId=${result.taskId}`,
  );
}

// Node warning is not a remote connection failure. It is changed to a structured warn to prevent the default stderr from being mistakenly dyed into error.
process.on("warning", (warning) => logger.warn(`${warning.name}: ${warning.message}`));

registerHostNetworkTelemetry(parentPort);
// 60-second sampling of the Host process itself: reading two outlets at a time - writing to local after gating
// `[memory]` line, the same reading is converted into HostResourceSample and sent to main as the heap source via parentPort.
// Services counters are self-registered by each service factory.
const hostSelfResourceTelemetry = startHostSelfResourceTelemetry({
  logger,
  collectCounters: collectServiceMemoryDiagnostics,
  postMessage: parentPort ? (message) => parentPort.postMessage(message) : undefined,
});

const runtimeProcessLifecycleReporter = {
  onSpawn(event) {
    if (!parentPort) {
      return;
    }

    parentPort.postMessage({
      type: HostResponseTypes.AgentProcessSpawned,
      ...event,
    });
  },
  onReady(event) {
    if (!parentPort) {
      return;
    }

    parentPort.postMessage({
      type: HostResponseTypes.AgentProcessReady,
      ...event,
    });
  },
  onExit(event) {
    if (!parentPort) {
      return;
    }

    parentPort.postMessage({
      type: HostResponseTypes.AgentProcessExited,
      ...event,
      signal: event.signal ?? null,
    });
  },
  onError(event) {
    if (!parentPort) {
      return;
    }

    parentPort.postMessage({
      type: HostResponseTypes.AgentProcessError,
      ...event,
    });
  },
  onException(event) {
    parentPort?.postMessage({ type: HostResponseTypes.AgentProcessException, ...event });
  },
} satisfies NonNullable<Parameters<typeof createLocalServices>[0]>["processLifecycleReporter"];

const runtimeTaskReporter = {
  onRunningTaskCountChanged(event) {
    if (!parentPort) {
      return;
    }

    parentPort.postMessage({
      type: HostResponseTypes.AgentRunningTaskCountChanged,
      runningTaskCount: event.runningTaskCount,
    });
  },
} satisfies NonNullable<Parameters<typeof createLocalServices>[0]>["taskRuntimeReporter"];

const cuaOperationStateReporter = {
  onStateChanged(event) {
    if (!parentPort) {
      return;
    }
    parentPort.postMessage({
      type: HostResponseTypes.CuaOperationState,
      ...event,
    });
  },
} satisfies NonNullable<Parameters<typeof createLocalServices>[0]>["cuaOperationStateReporter"];

let untrackedPromptRpcCount = 0;
function reportHostRunningTaskCount(): void {
  runtimeTaskReporter.onRunningTaskCountChanged({
    runningTaskCount: workspaceTaskTracker.getTotalRunningTaskCount() + untrackedPromptRpcCount,
  });
}

const workspaceTaskTracker = createHostWorkspaceTaskTracker((event) => {
  parentPort?.postMessage({
    type: HostResponseTypes.WorkspaceRunningTaskCountChanged,
    ...event,
  });
  windowRemoteConnectionRegistry.setWorkspaceRunningTaskCount(event);
  reportHostRunningTaskCount();
});

function isZCodeTaskMeta(value: unknown): value is ZCodeTaskMeta {
  return (
    typeof value === "object" &&
    value !== null &&
    "taskId" in value &&
    "workspacePath" in value &&
    "traceId" in value &&
    typeof (value as { taskId?: unknown }).taskId === "string" &&
    typeof (value as { workspacePath?: unknown }).workspacePath === "string" &&
    typeof (value as { traceId?: unknown }).traceId === "string"
  );
}

function isRemoteMirrorableStreamEvent(
  event: ZCodeStreamEvent,
): event is TaskStreamMirrorableEvent {
  return event.type !== "task_stream_mirror_batch" && event.type !== "task_snapshot_updated";
}

function createReportingRemoteZCodeTaskService<T extends object>(
  service: T,
  options?: {
    reportRunningPromptCount?: boolean;
    taskRealtimePort?: ReturnType<typeof createTaskRealtimeBridgeForHostInit>;
    materializePromptAttachments?: (params: {
      taskId: string;
      traceId: TraceId;
      content: string;
      attachments?: ZCodePromptAttachment[];
    }) => Promise<{ content: string; attachments?: ZCodePromptAttachment[] }>;
  },
): T {
  const workspaceProxyState = createHostRemoteWorkspaceProxyState();

  function forwardSessionMessageRequest(request: unknown): void {
    parentPort?.postMessage({
      type: HostResponseTypes.SessionMessageSendRequested,
      request,
    });
  }

  function subscribeSessionMessageRequests(target: T, meta: ZCodeTaskMeta): void {
    const onDynamicWorkspaceEvent = Reflect.get(target, "onDynamicWorkspaceEvent");
    if (typeof onDynamicWorkspaceEvent !== "function") {
      return;
    }
    const subscribe = onDynamicWorkspaceEvent.call(target, {
      workspacePath: meta.workspacePath,
      ...(meta.workspaceIdentity ? { workspaceIdentity: meta.workspaceIdentity } : {}),
    });
    if (typeof subscribe !== "function") {
      return;
    }
    workspaceProxyState.ensureWorkspaceSubscription(meta, () =>
      subscribe((event: unknown) => {
        if (
          typeof event === "object" &&
          event !== null &&
          (event as { type?: unknown }).type === "workspace_session_message_send_requested"
        ) {
          forwardSessionMessageRequest((event as { request?: unknown }).request);
        }
      }),
    );
  }

  function rememberTaskMeta(result: unknown): void {
    if (isZCodeTaskMeta(result)) {
      workspaceProxyState.rememberTaskMeta(result);
      subscribeSessionMessageRequests(service, result);
      parentPort?.postMessage({
        type: HostResponseTypes.SessionRouteAnnounce,
        route: {
          sessionId: result.taskId,
        },
      });
    }
  }

  function rememberTaskMetasFromResult(result: unknown): void {
    if (Array.isArray(result)) {
      for (const item of result) {
        rememberTaskMetasFromResult(item);
      }
      return;
    }
    rememberTaskMeta(result);
    if (typeof result !== "object" || result === null) {
      return;
    }
    const items = (result as { items?: unknown }).items;
    if (Array.isArray(items)) {
      for (const item of items) {
        rememberTaskMeta(item);
      }
    }
    const snapshot = (result as { snapshot?: unknown }).snapshot;
    if (typeof snapshot === "object" && snapshot !== null) {
      rememberTaskMeta((snapshot as { meta?: unknown }).meta);
    }
    rememberTaskMeta((result as { meta?: unknown }).meta);
  }

  async function prepareRemotePromptParams(params: {
    taskId: string;
    traceId: TraceId;
    content: string;
    attachments?: ZCodePromptAttachment[];
  }): Promise<{
    taskId: string;
    traceId: TraceId;
    content: string;
    attachments?: ZCodePromptAttachment[];
  }> {
    if (!options?.materializePromptAttachments) {
      return params;
    }
    return {
      ...params,
      ...(await options.materializePromptAttachments(params)),
    };
  }

  async function mirrorRemotePrompt(
    target: T,
    sendPrompt: (...args: unknown[]) => Promise<unknown>,
    params: {
      taskId: string;
      traceId: TraceId;
      content: string;
      attachments?: ZCodePromptAttachment[];
    },
  ): Promise<unknown> {
    const taskRealtimePort = options?.taskRealtimePort;
    const meta = workspaceProxyState.getTaskMeta(params.taskId);
    if (!taskRealtimePort || !meta) {
      return sendPrompt.call(target, params);
    }

    const mirrorTarget = {
      workspacePath: meta.workspacePath,
      workspaceIdentity: meta.workspaceIdentity,
      workspaceKey: resolveWorkspaceKey(meta),
      taskId: params.taskId,
      runId: params.traceId,
      traceId: params.traceId,
    };
    const leaseResult = await taskRealtimePort
      .acquireTaskRunLease(mirrorTarget)
      .catch((error: unknown) => {
        logger.warn("Bot remote runtime realtime lease failed:", error);
        return null;
      });
    if (!leaseResult?.acquired) {
      return sendPrompt.call(target, params);
    }

    taskRealtimePort.publishStreamOp(mirrorTarget, {
      kind: "user_message",
      messageId: `user-${params.traceId}`,
      content: params.content,
      attachments: params.attachments,
      timestamp: Date.now(),
    });

    // The write path (send/stop/interaction receipt) has converged to the v4 command plane; this image is a **read path**——
    // taskRealtimePort → mobile relay → mobile terminal
    // The entire consumption chain vocabulary of zcodeSessionStore is ZCodeStreamEvent. Evaluation conclusions of the two options:
    // a) relay directly forwards v4 frames and consumes v4 store on the mobile phone (correct answer): relay stream-op needs to be redone
    //    Protocol + mobile store;
    // b) Frame → ZCodeStreamEvent thin mapping: equivalent to replica adapter mapSessionEvent,
    //    Denied.
    // Conclusion: This image keeps the legacy source intact.
    const dynamicStreamEvent = Reflect.get(target, "onDynamicStreamEvent");
    const streamDisposable =
      typeof dynamicStreamEvent === "function"
        ? dynamicStreamEvent.call(
            target,
            params.taskId,
          )((event: ZCodeStreamEvent) => {
            if (isRemoteMirrorableStreamEvent(event)) {
              taskRealtimePort.publishStreamOp(mirrorTarget, {
                kind: "stream_event",
                event,
              });
            }
          })
        : null;

    try {
      return await sendPrompt.call(target, params);
    } finally {
      // The remote zcode-server does not have a desktop realtime port; it is controlled by the
      // The remote facade takes over the lease and stream mirror to ensure that the UI can continue to receive remote session streams.
      streamDisposable?.dispose();
      taskRealtimePort.releaseTaskRunLease(mirrorTarget);
    }
  }

  function finishWorkspaceTask(taskId: string, meta: ZCodeTaskMeta): void {
    workspaceProxyState.disposeTaskReadySubscription(taskId);
    workspaceTaskTracker.finish(taskId, meta);
  }

  function beginWorkspaceTask(target: T, taskId: string, meta: ZCodeTaskMeta): boolean {
    const started = workspaceTaskTracker.begin(taskId, meta);
    if (!started) {
      return false;
    }
    const onDynamicTaskReady = Reflect.get(target, "onDynamicTaskReady");
    if (typeof onDynamicTaskReady !== "function") {
      workspaceTaskTracker.finish(taskId, meta);
      throw new Error("remote ZCode task service does not expose onDynamicTaskReady");
    }
    const subscribe = onDynamicTaskReady.call(target, taskId);
    if (typeof subscribe !== "function") {
      workspaceTaskTracker.finish(taskId, meta);
      throw new Error("remote ZCode task ready event is not subscribable");
    }
    workspaceProxyState.trackTaskReady(
      taskId,
      meta,
      (listener) => subscribe(listener),
      () => finishWorkspaceTask(taskId, meta),
    );
    return true;
  }

  // The ZCode Agent manager of the remote workspace runs on the remote server, and the desktop main cannot be directly seen.
  // `handles` status. sendPrompt Promise is just a remote ACK, and you must wait for the task ready to allow the workspace to be recycled.
  return new Proxy(service, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if ((property === "createTask" || property === "resumeTask") && typeof value === "function") {
        return async (...args: unknown[]) => {
          const result = await value.apply(target, args);
          rememberTaskMeta(result);
          return result;
        };
      }
      if (
        (property === "listTasks" ||
          property === "listPinnedTasks" ||
          property === "listTaskList" ||
          property === "listArchivedTasks" ||
          property === "getTaskMeta" ||
          property === "getTaskSnapshot" ||
          property === "getTaskSnapshotWithEtag") &&
        typeof value === "function"
      ) {
        return async (...args: unknown[]) => {
          const result = await value.apply(target, args);
          rememberTaskMetasFromResult(result);
          return result;
        };
      }
      if (property === "releaseWorkspacePreparation" && typeof value === "function") {
        return async (...args: unknown[]) => {
          const result = await value.apply(target, args);
          const context = args[0];
          if (
            typeof context === "object" &&
            context !== null &&
            typeof (context as { workspacePath?: unknown }).workspacePath === "string"
          ) {
            const workspaceContext = context as {
              workspacePath: string;
              workspaceIdentity?: string;
            };
            // The pooled Host does not exit with the tab; after the runtime is successfully released, the Host proxy layer reference must be released simultaneously.
            // Otherwise, task meta and dynamic event listeners will grow monotonically throughout the application life cycle.
            workspaceProxyState.clearWorkspace(workspaceContext);
            workspaceTaskTracker.clearWorkspace(workspaceContext);
          }
          return result;
        };
      }
      const shouldWrapSendPrompt =
        options?.reportRunningPromptCount !== false ||
        Boolean(options?.taskRealtimePort) ||
        Boolean(options?.materializePromptAttachments);
      if (property !== "sendPrompt" || typeof value !== "function" || !shouldWrapSendPrompt) {
        return value;
      }

      return async (...args: unknown[]) => {
        let trackedTask: { taskId: string; meta: ZCodeTaskMeta; started: boolean } | undefined;
        let tracksOnlyRpcLifetime = false;
        try {
          const params = args[0];
          if (
            typeof params === "object" &&
            params !== null &&
            typeof (params as { taskId?: unknown }).taskId === "string" &&
            typeof (params as { traceId?: unknown }).traceId === "string" &&
            typeof (params as { content?: unknown }).content === "string"
          ) {
            const promptParams = params as {
              taskId: string;
              traceId: TraceId;
              content: string;
              attachments?: ZCodePromptAttachment[];
            };
            const taskMeta = workspaceProxyState.getTaskMeta(promptParams.taskId) as
              | ZCodeTaskMeta
              | undefined;
            if (taskMeta) {
              trackedTask = {
                taskId: promptParams.taskId,
                meta: taskMeta,
                started: beginWorkspaceTask(target, promptParams.taskId, taskMeta),
              };
            } else if (options?.reportRunningPromptCount !== false) {
              // Unable to safely forge workspace identity when task meta is missing; only Host exit diagnostics during ACK retained,
              // Do not allow this fallback to participate in the release decision of the workspace runtime.
              tracksOnlyRpcLifetime = true;
              untrackedPromptRpcCount += 1;
              reportHostRunningTaskCount();
            }
            const preparedParams = await prepareRemotePromptParams(promptParams);
            return await mirrorRemotePrompt(
              target,
              value.bind(target) as (...promptArgs: unknown[]) => Promise<unknown>,
              preparedParams,
            );
          }
          if (options?.reportRunningPromptCount !== false) {
            tracksOnlyRpcLifetime = true;
            untrackedPromptRpcCount += 1;
            reportHostRunningTaskCount();
          }
          return await value.apply(target, args);
        } catch (error) {
          if (trackedTask?.started) {
            finishWorkspaceTask(trackedTask.taskId, trackedTask.meta);
          }
          throw error;
        } finally {
          if (tracksOnlyRpcLifetime) {
            untrackedPromptRpcCount = Math.max(0, untrackedPromptRpcCount - 1);
            reportHostRunningTaskCount();
          }
        }
      };
    },
  });
}

function warmUpZCodeAgent(
  services: ServiceCollection,
  context: { workspacePath?: string; workspaceIdentity?: string },
  reason: string,
): void {
  if (!context.workspacePath) {
    return;
  }
  const workspacePath = context.workspacePath;
  const workspaceIdentity = context.workspaceIdentity;
  const zcodeSessionService = services.getOptional(IZCodeSessionService);
  if (!zcodeSessionService) {
    return;
  }
  void zcodeSessionService
    .initializeWorkspace({
      workspacePath,
      ...(workspaceIdentity ? { workspaceIdentity } : {}),
    })
    .then((result) => {
      if (!result.available) {
        if (result.reasonCode === "provider_not_ready") {
          logger.info(
            `ZCode agent warmup waiting for provider/model (${reason}) workspace=${workspacePath}`,
          );
          return;
        }
        logger.warn(
          `ZCode agent warmup unavailable (${reason}) workspace=${workspacePath} reason=${result.reason ?? "unknown"}`,
        );
        return;
      }
      // Model candidates and preferences are already provided by the target Host ModelSelectionView; workspace
      // Presentation only leaves mode and slash commands. Preheating cannot be created additionally for reading presentations
      // Agent App, otherwise its MCP close will occupy the protocol channel and block the real Session initialization.
      logger.info(
        `ZCode agent warmup ready (${reason}) workspace=${workspacePath} transport=${result.transportKind ?? "unknown"}`,
      );
    })
    .catch((error) => {
      logger.warn(`ZCode agent warmup failed (${reason}) workspace=${workspacePath}:`, error);
    });
}

// Background output polling still requires an independent debug logger, and the factory import cannot be lost when other log callers are removed.
const rpcDebugLogger = createServiceLogger("rpc");

function logRpc(message: string, ...args: unknown[]): void {
  const level = resolveRpcLogLevel(message, ...args);
  if (level === "debug") {
    rpcDebugLogger.debug(undefined, message, ...args);
    return;
  }
  logger[level](message, ...args);
}

function formatRemoteTargetForLog(target: RemoteTarget): string {
  switch (target.kind) {
    case "ssh":
      return `ssh:${target.username}@${target.host}:${target.port ?? 22}`;
    case "wsl": {
      const user = target.user?.trim();
      const distro = target.distro ?? "default";
      return user ? `wsl:${distro}:${user}` : `wsl:${distro}`;
    }
  }
}

console.log = (...args: unknown[]) => {
  rawConsole.log(...args);
  reportHostLog("info", args);
  remoteConnectionProgressContext.report("info", args);
};

console.warn = (...args: unknown[]) => {
  rawConsole.warn(...args);
  reportHostLog("warn", args);
  remoteConnectionProgressContext.report("warn", args);
};

console.error = (...args: unknown[]) => {
  rawConsole.error(...args);
  // Electron will send the Node warning to console.error first, and the process warning listener will then
  // Structured record warn; if you continue to report here, an error and a warn will be left for the same warning.
  if (!shouldReportHostConsoleError(args)) {
    return;
  }
  reportHostLog("error", args);
  remoteConnectionProgressContext.report("error", args);
};

/** A collection of registered services on the current host, used to uniformly recycle local resources when the process exits */
let databaseStartup: ReturnType<typeof createHostDatabaseStartup> | undefined;
const pendingStartupAttachments = new Map<string, () => void>();
let activeServices: ServiceCollection | null = null;
let activeHostApiNetworkTransport: HostApiNetworkTransport | null = null;
/** Resource telemetry subscriptions for local host services; subscriptions for remote connections are held by their respective connection handles. */
let activeLocalResourceTelemetry: IDisposable | null = null;
// Resource manager sampling is only performed once when requested by main, and Host does not maintain any periodic timers.
const hostResourceUsageResponder = createHostResourceUsageResponder({
  getAgentService: () => activeServices?.getOptional(IZCodeAgentService),
  postMessage: (message) => parentPort?.postMessage(message),
});
let activeSessionRealtimePort: ReturnType<typeof createTaskRealtimeBridgeForHostInit> = null;
let hasDisposedHostResources = false;
let disposeHostResourcesInFlight: Promise<HostShutdownResult> | null = null;

function requireActiveHostApiNetworkTransport(): HostApiNetworkTransport {
  if (!activeHostApiNetworkTransport) {
    // Bug reason: If the remote asset rolls back to global fetch before the Host network policy is ready, the explicit proxy on the settings page will be bypassed.
    throw new Error("Window Host network transport is not initialized");
  }
  return activeHostApiNetworkTransport;
}

async function resolveDesktopRemoteRuntimeNetwork(
  target: RemoteTarget,
): Promise<RemoteRuntimeNetworkOptions | undefined> {
  if (target.kind !== "wsl") {
    return undefined;
  }
  const settingService = activeServices?.getOptional(ISettingService);
  if (!settingService) {
    return undefined;
  }
  try {
    const settings = await settingService.get();
    return {
      authoritative: true,
      httpProxy: settings.httpProxy,
      noProxy: settings.httpProxyNoProxy,
    };
  } catch {
    // Set the original remote connection behavior to be retained when the read fails to prevent network enhancement from directly blocking the WSL workspace.
    return undefined;
  }
}

async function disposeHostRemoteConnection(connection: HostRemoteConnection): Promise<void> {
  await connection.disposeAndWait({ timeoutMs: 5_000 });
}

async function createWindowRemoteConnectionHandle(params: {
  target: RemoteTarget;
  remoteAssets: RemoteAssetDirs;
  signal: AbortSignal;
}): Promise<WindowRemoteConnectionHandle<ServiceCollection, HostRemoteConnectionCapabilities>> {
  if (!activeServices) throw new Error("Local Host services are not initialized.");
  const clientConfigService = activeServices.get(IClientConfigService);
  if (params.signal.aborted) {
    throw new Error("Remote connection was cancelled");
  }
  const closeListeners = new Set<(event: WindowRemoteConnectionCloseEvent) => void>();
  const notifyClose = (event: WindowRemoteConnectionCloseEvent) => {
    for (const listener of closeListeners) {
      listener(event);
    }
  };
  const connection = await setupRemoteConnection(
    params.target,
    params.remoteAssets,
    { fetch: requireActiveHostApiNetworkTransport().fetch },
    await resolveDesktopRemoteRuntimeNetwork(params.target),
    (exitCode) => notifyClose({ exitCode, signal: null }),
    params.target.kind === "ssh" ? "caller-serialized" : "remote",
    params.target.kind === "ssh" ? params.signal : undefined,
  );

  if (params.signal.aborted) {
    await disposeHostRemoteConnection(connection);
    throw new Error("Remote connection was cancelled");
  }

  const backendConnection = connection;
  const materializePromptAttachments = async (request: {
    taskId: string;
    traceId: TraceId | string;
    content: string;
    attachments?: ZCodePromptAttachment[];
  }) => {
    const result = await materializeRemotePromptAttachments(request, {
      backend: backendConnection.backend,
    });
    return { content: result.content, attachments: result.attachments };
  };
  const promptAttachmentTransferService = createRemotePromptAttachmentTransferService(
    backendConnection.backend,
    {
      onJanitorError: (error: unknown) =>
        logger.warn("remote prompt attachment janitor failed", error),
    },
  );
  const services = createRemoteWorkspaceServiceCollection({
    clientConfigService,
    connectionServices: backendConnection.services,
    sourceServices: activeServices ?? undefined,
    parentPort,
    createRemotePromptAttachmentSessionService: (service) =>
      createRemotePromptAttachmentSessionService(service, {
        materializePromptAttachments,
      }),
    createRemotePromptAttachmentTaskService: (service) =>
      createRemotePromptAttachmentTaskService(service, {
        materializePromptAttachments,
      }),
    createReportingRemoteZCodeTaskService: (service) =>
      createReportingRemoteZCodeTaskService(service, {
        taskRealtimePort: activeSessionRealtimePort ?? undefined,
      }),
    promptAttachmentTransferService,
    runtimePreferencesBridge: {
      onError: (error: unknown) => logger.warn("remote runtime preferences bridge failed", error),
    },
  });

  let disposed = false;
  // The CLI and MCP samples of the remote workspace follow the same path as the local one: remote zcode-server → local Host → main.
  // The subscription life is equal to the life of this remote service: it is held by the connection handle and the registry releases the entry
  // (WSL idle recycling, last logical session closing, session cleaning after disconnection) is closed together with dispose.
  const resourceTelemetry = registerHostServiceResourceTelemetry({
    services,
    postMessage: (message) => parentPort?.postMessage(message),
    runtimeSurface: "remote",
    environmentKey: resolveResourceTelemetryEnvironmentKey(params.target),
    onError: (error) => logger.warn("remote resource telemetry subscription failed", error),
  });
  const remoteMediaPreviewFactory = !remoteMediaRangePreviewEnabled
    ? undefined
    : (scope: Extract<WindowHostAttachmentScope, { kind: "remote" }>) =>
        createRemoteMediaPreviewProxy({
          fileService: services.get(IFileService),
          logger: {
            debug: (message, metadata) => {
              if (process.env.NODE_ENV !== "production") logger.info(message, metadata);
            },
            warn: (message, metadata) => logger.warn(message, metadata),
          },
          scope,
          requestLimiter: hostRemoteMediaRequestLimiter,
        });
  return {
    services,
    capabilities:
      "backend" in connection
        ? {
            browserRecordingUploader: connection.backend,
            ...(remoteMediaPreviewFactory ? { remoteMediaPreviewFactory } : {}),
          }
        : {},
    onDidClose(listener) {
      closeListeners.add(listener);
      return { dispose: () => closeListeners.delete(listener) };
    },
    async dispose() {
      if (disposed) {
        return;
      }
      disposed = true;
      closeListeners.clear();
      resourceTelemetry.dispose();
      await disposeServiceResourcesAndWait(services);
      await disposeHostRemoteConnection(connection);
    },
  };
}

const windowRemoteConnectionRegistry = createWindowRemoteConnectionRegistry<
  ServiceCollection,
  HostRemoteConnectionCapabilities
>({
  connect: (request) => createWindowRemoteConnectionHandle(request),
  createId: randomUUID,
  releaseWorkspace: async (services, context) => {
    await services.get(IZCodeTaskService).releaseWorkspacePreparation({
      workspacePath: context.workspacePath,
      ...(context.workspaceIdentity ? { workspaceIdentity: context.workspaceIdentity } : {}),
      provider: "glm",
    });
    logger.info(
      `released WSL workspace runtime, workspaceKey=${context.workspaceIdentity?.trim() || context.workspacePath}`,
    );
  },
  onWorkspaceReleaseError: (context, error) => {
    logger.warn(
      `failed to release WSL workspace runtime, workspaceKey=${context.workspaceIdentity?.trim() || context.workspacePath}`,
      error,
    );
  },
  onSessionClosed: (event) => {
    // attachment still holds old services/subscriptions when the logical session is offline; subsequent sessionId
    // Upgrading only releases the transport, and these ports cannot be retrieved according to the old ID. Host uniformly closes all clientModes at the source of failure.
    windowHostAttachmentRegistry.detachRemoteSessionAttachments(event.remoteSessionId);
    const session = windowRemoteConnectionRegistry.getSession(event.remoteSessionId);
    if (session?.workspacePath && session.workspaceIdentity) {
      windowHostControllerRuntime.disconnectSource({
        kind: "remote",
        remoteSessionId: event.remoteSessionId,
        workspacePath: session.workspacePath,
        workspaceIdentity: session.workspaceIdentity,
      });
    }
    parentPort?.postMessage({
      type: HostResponseTypes.RemoteWorkspaceClosed,
      remoteSessionId: event.remoteSessionId,
      reason: "connection-closed",
      exitCode: event.exitCode,
      signal: event.signal,
      ...(event.error ? { error: event.error } : {}),
    });
    logWindowHostTopology("remote-connection-closed");
  },
});

const windowHostControllerRuntime = createWindowHostControllerRuntime({
  createId: randomUUID,
  onSourceError: (scope, operation, error) => {
    logger.warn(
      `window Controller source ${operation} failed, scope=${scope.kind}, workspaceKey=${scope.workspaceIdentity?.trim() || scope.workspacePath}`,
      error,
    );
  },
  resolveSource: (scope) => {
    const remoteSession = windowRemoteConnectionRegistry.findSessionForWorkspace(scope);
    if (remoteSession?.workspacePath && remoteSession.workspaceIdentity) {
      const controllerScope = {
        kind: "remote" as const,
        remoteSessionId: remoteSession.remoteSessionId,
        workspacePath: remoteSession.workspacePath,
        workspaceIdentity: remoteSession.workspaceIdentity,
      };
      if (remoteSession.sourceAvailability !== "online") {
        return { scope: controllerScope, sourceAvailability: "offline" as const };
      }
      const services = windowRemoteConnectionRegistry.resolveScopedServices(controllerScope);
      return {
        scope: controllerScope,
        taskService: services.get(IZCodeTaskService),
        agentService: services.getOptional(IZCodeAgentService),
        sourceAvailability: "online" as const,
      };
    }
    // The remote history scope must not fall back to the local tasks-index when it is not connected or has been removed.
    if (scope.workspaceIdentity && isRemoteWorkspaceIdentity(scope.workspaceIdentity)) {
      return null;
    }
    const taskService = activeServices?.getOptional(IZCodeTaskService);
    if (!taskService) {
      return null;
    }
    return {
      scope: {
        kind: "local" as const,
        workspacePath: scope.workspacePath,
        ...(scope.workspaceIdentity ? { workspaceIdentity: scope.workspaceIdentity } : {}),
      },
      taskService,
      agentService: activeServices?.getOptional(IZCodeAgentService),
      sourceAvailability: "online" as const,
    };
  },
});

function wireLocalResourceTelemetry(services: ServiceCollection): void {
  activeLocalResourceTelemetry?.dispose();
  activeLocalResourceTelemetry = registerHostServiceResourceTelemetry({
    services,
    postMessage: (message) => parentPort?.postMessage(message),
    runtimeSurface: "local",
    onError: (error) => logger.warn("local resource telemetry subscription failed", error),
  });
}

function disposeLocalResourceTelemetry(): void {
  try {
    activeLocalResourceTelemetry?.dispose();
  } catch {
    // Resource telemetry release failure cannot block the Host's existing shutdown barrier.
  } finally {
    activeLocalResourceTelemetry = null;
  }
}

type ExposedServicePortHandle = {
  server: IChannelServer & { ready(): void };
  dispose(): void;
};

function createControllerRoutedTaskService(
  base: IZCodeTaskService,
  attachmentScope: WindowHostAttachmentScope,
): IZCodeTaskService {
  const route = async (
    params: {
      taskId: string;
      workspacePath: string;
      workspaceIdentity?: string;
    },
    mutation:
      | { kind: "pin"; pinned: boolean }
      | { kind: "archive"; archived: boolean }
      | { kind: "delete" }
      | { kind: "mark-read"; expectedUnreadAt?: number }
      | { kind: "mark-unread" },
  ) =>
    windowHostControllerRuntime.service.mutateTask({
      address: await windowHostControllerRuntime.resolveTaskAddress({
        taskId: params.taskId,
        workspacePath: params.workspacePath,
        ...(params.workspaceIdentity ? { workspaceIdentity: params.workspaceIdentity } : {}),
        attachmentScope,
      }),
      mutation,
    });

  return new Proxy(base, {
    get(target, property, receiver) {
      if (property === "setTaskPinned") {
        return async (params: Parameters<IZCodeTaskService["setTaskPinned"]>[0]) => {
          const meta = await route(params, { kind: "pin", pinned: params.pinned });
          if (!meta) throw new Error("task projection missing after pin mutation");
          return meta;
        };
      }
      if (property === "archiveTask" || property === "unarchiveTask") {
        return async (
          params:
            | Parameters<IZCodeTaskService["archiveTask"]>[0]
            | Parameters<IZCodeTaskService["unarchiveTask"]>[0],
        ) => {
          const meta = await route(params, {
            kind: "archive",
            archived: property === "archiveTask",
          });
          if (!meta) throw new Error("task projection missing after archive mutation");
          return meta;
        };
      }
      if (property === "deleteTask") {
        return async (params: Parameters<IZCodeTaskService["deleteTask"]>[0]) => {
          await route(params, { kind: "delete" });
        };
      }
      if (property === "deleteArchivedTasks") {
        return async (params: Parameters<IZCodeTaskService["deleteArchivedTasks"]>[0]) => {
          if (params.taskIds.length === 0) {
            return { deletedTaskIds: [], skippedTaskIds: [], failedTaskIds: [] };
          }
          return windowHostControllerRuntime.service.deleteArchivedTasks({
            address: await windowHostControllerRuntime.resolveTaskAddress({
              workspacePath: params.workspacePath,
              workspaceIdentity: params.workspaceIdentity,
              taskId: params.taskIds[0]!,
              attachmentScope,
              allowMissingTask: true,
            }),
            taskIds: params.taskIds,
          });
        };
      }
      if (property === "deleteArchivedTask") {
        return async (params: Parameters<IZCodeTaskService["deleteArchivedTask"]>[0]) =>
          windowHostControllerRuntime.service.deleteArchivedTask({
            address: await windowHostControllerRuntime.resolveTaskAddress({
              ...params,
              attachmentScope,
              allowMissingTask: true,
            }),
          });
      }
      if (property === "setTaskUnread") {
        return async (params: Parameters<IZCodeTaskService["setTaskUnread"]>[0]) => {
          const meta = await route(
            params,
            params.unread
              ? { kind: "mark-unread" }
              : {
                  kind: "mark-read",
                  ...(params.expectedUnreadAt != null
                    ? { expectedUnreadAt: params.expectedUnreadAt }
                    : {}),
                },
          );
          if (!meta) throw new Error("task projection missing after unread mutation");
          return meta;
        };
      }
      const value = Reflect.get(target, property, receiver) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

function exposeServicesOnMessagePort(
  port: Electron.MessagePortMain,
  services: ServiceCollection,
  deferInit: boolean,
  clientMode: ZCodeAgentV4ClientMode = "desktop-continuous",
  attachmentScope: WindowHostAttachmentScope = { kind: "local" },
  capabilities?: HostRemoteConnectionCapabilities,
): ExposedServicePortHandle {
  const wrappedPort = wrapElectronPort(port);
  const protocol = new MessagePortProtocol(wrappedPort);
  // Remote mode delays sending Initialize: it takes time to establish a remote connection. If Initialize is sent during construction,
  // The renderer will immediately send a request but the channel has not yet been registered, resulting in an "Unknown channel" timeout error.
  // The attach mode reuses a ready service and a new RPC MessagePort must be initialized immediately.
  logger.info(`creating ChannelServer (deferInit=${deferInit})`);
  const rawServer = new ChannelServer(protocol, "host", 1000, deferInit);
  const loggedServer = new LoggingChannelServer(rawServer, logRpc);
  const server = new NetworkTelemetryChannelServer(loggedServer);
  const agentService = services.getOptional(IZCodeAgentService);
  const connectionScope = agentService
    ? createZCodeAgentConnectionScope(agentService, {
        connectionId: `host-rpc-${randomUUID()}`,
        clientMode,
      })
    : undefined;
  services.register(IWindowControllerService, windowHostControllerRuntime.service);
  const controllerAttachment = windowHostControllerRuntime.createAttachmentService();
  const overrides = new Map<string, unknown>([
    [IWindowControllerService.channelName, controllerAttachment],
  ]);
  // The remote media must select the data side according to the clientMode of the attachment: the desktop uses the Host loopback Range, and the mobile phone remains inline.
  const remoteMediaPreviewProxy =
    attachmentScope.kind === "remote" && clientMode === "desktop-continuous"
      ? capabilities?.remoteMediaPreviewFactory?.(attachmentScope)
      : undefined;
  if (remoteMediaPreviewProxy) {
    overrides.set(IMediaPreviewService.channelName, remoteMediaPreviewProxy.service);
  }
  const taskService = services.getOptional(IZCodeTaskService);
  if (taskService) {
    overrides.set(
      IZCodeTaskService.channelName,
      createControllerRoutedTaskService(taskService, attachmentScope),
    );
  }
  if (connectionScope) {
    overrides.set(IZCodeAgentService.channelName, connectionScope.service);
  }
  const conversationShareService = services.getOptional(IConversationShareService);
  if (conversationShareService) {
    // If the Share service continues to hold the raw Agent, it will bypass the trusted carrier that the current MessagePort has shaken.
    // rowsRange will reject as connection untrusted. The same attachment connection scope must be reused.
    overrides.set(
      IConversationShareService.channelName,
      scopeConversationShareServiceForAttachment(
        conversationShareService,
        clientMode,
        connectionScope?.service,
      ),
    );
  }
  services.exposeOnChannelServer(server, overrides);
  let disposed = false;
  let flowUpdateChain = Promise.resolve();
  const forwardFlowState = (state: "saturated" | "drained" | "closed") => {
    if (!connectionScope) return Promise.resolve();
    const update = flowUpdateChain.then(() => connectionScope.setTransportFlowState(state));
    flowUpdateChain = update.catch((error) => {
      logger.warn("failed to forward attachment connection flow state", {
        state,
        message: error instanceof Error ? error.message : String(error),
      });
    });
    return update;
  };
  const flowStateDisposable = protocol.onFlowState((state) => {
    if (disposed) return;
    // MessagePort sideband has been separated from Uint8Array at the protocol layer; here only the owning scope
    // For edge serial connections to the CLI, the connectionId cannot be specified by the control object.
    void forwardFlowState(state).catch(() => {});
  });
  const handle: ExposedServicePortHandle = {
    server,
    dispose() {
      if (disposed) return;
      disposed = true;
      flowStateDisposable.dispose();
      controllerAttachment.dispose();
      void remoteMediaPreviewProxy?.dispose().catch((error: unknown) => {
        logger.warn("failed to dispose remote media preview proxy", error);
      });
      // close ranks after all received SAT/DRN; scope.dispose itself will be idempotent again to ensure closed,
      // But never let a late saturated CLI pause state be resurrected after a close.
      void forwardFlowState("closed")
        .catch(() => {})
        .then(() => connectionScope?.dispose());
      rawServer.dispose();
      protocol.disconnect();
    },
  };
  port.once("close", () => handle.dispose());
  logger.info(`service connection ready mode=${clientMode}`);
  return handle;
}

const windowHostAttachmentRegistry = createWindowHostAttachmentRegistry<
  ServiceCollection,
  Electron.MessagePortMain,
  HostRemoteConnectionCapabilities
>({
  resolveScope: (scope: WindowHostAttachmentScope) => {
    if (scope.kind === "local") {
      if (!activeServices) {
        throw new Error("local services are not initialized");
      }
      return { services: activeServices, generation: 1 };
    }
    const session = windowRemoteConnectionRegistry.getSession(scope.remoteSessionId);
    if (!session) {
      throw new Error(`remote logical session not found, remoteSessionId=${scope.remoteSessionId}`);
    }
    return {
      services: windowRemoteConnectionRegistry.resolveScopedServices(scope),
      generation: session.generation,
      capabilities: windowRemoteConnectionRegistry.resolveScopedCapabilities(scope),
    };
  },
  expose: ({ port, services, clientMode, scope, capabilities }) =>
    exposeServicesOnMessagePort(port, services, false, clientMode, scope, capabilities),
});

function logWindowHostTopology(reason: string): void {
  const stats = windowRemoteConnectionRegistry.getStats();
  logger.info(
    `window Host topology, reason=${reason}, pid=${process.pid}, connections=${stats.connectionCount}, logicalSessions=${stats.logicalSessionCount}, attachments=${windowHostAttachmentRegistry.size()}`,
  );
}

function disposeAttachedServicePorts(): void {
  windowHostAttachmentRegistry.dispose();
}

async function disposeHostResources(reason: string): Promise<HostShutdownResult> {
  databaseStartup?.dispose();
  pendingStartupAttachments.clear();
  if (hasDisposedHostResources) {
    return (
      (await disposeHostResourcesInFlight) ?? {
        exitCode: 0,
        failedPhases: [],
        timedOutPhases: [],
      }
    );
  }
  hasDisposedHostResources = true;

  disposeHostResourcesInFlight = (async () => {
    logger.info(`disposing host resources, reason=${reason}`);

    stopHostNetworkTelemetry();
    hostSelfResourceTelemetry.stop();
    disposeLocalResourceTelemetry();
    disposeAttachedServicePorts();
    windowHostControllerRuntime.dispose();
    for (const key of Array.from(cronRunSubscriptions.keys())) {
      disposeCronRunSubscription(key);
    }
    cronAutomationRepo.close();
    for (const key of Array.from(offPeakRunSubscriptions.keys())) {
      disposeOffPeakRunSubscription(key);
    }
    disposeOffPeakRuntime();
    offPeakTaskRepo.close();

    if (activeSessionRealtimePort) {
      activeSessionRealtimePort.dispose();
      activeSessionRealtimePort = null;
    }

    const servicesToDispose = activeServices;
    activeServices = null;
    // Registry is the only owner of all remote connections; failure to release cannot block the local service from continuing to close.
    const shutdownResult = await runHostShutdownPhases(
      [
        {
          name: "remote-registry-dispose",
          run: () => windowRemoteConnectionRegistry.dispose(),
          timeoutMs: 6_000,
        },
        ...(servicesToDispose
          ? [
              {
                name: "service-dispose",
                run: () => disposeServiceResourcesAndWait(servicesToDispose),
                timeoutMs: 3_500,
              },
            ]
          : []),
      ],
      {
        phaseTimeoutMs: 5_000,
        log: (message, details) => logger.warn(message, details),
      },
    );
    if (shutdownResult.exitCode !== 0) {
      logger.warn("host resource cleanup completed with errors", {
        failedPhases: shutdownResult.failedPhases,
        reason,
        timedOutPhases: shutdownResult.timedOutPhases,
      });
    }
    activeHostApiNetworkTransport = null;
    return shutdownResult;
  })();

  const shutdownResult = await disposeHostResourcesInFlight;
  flushHostE2ECoverage((error) => {
    logger.warn("[e2e-coverage] host coverage flush failed", error);
  });
  return shutdownResult;
}

function disposeHostResourcesBestEffort(reason: string): void {
  if (hasDisposedHostResources) {
    return;
  }
  hasDisposedHostResources = true;

  logger.info(`disposing host resources, reason=${reason}`);
  stopHostNetworkTelemetry();
  disposeLocalResourceTelemetry();
  disposeAttachedServicePorts();
  windowHostControllerRuntime.dispose();
  for (const key of Array.from(cronRunSubscriptions.keys())) {
    disposeCronRunSubscription(key);
  }
  cronAutomationRepo.close();
  for (const key of Array.from(offPeakRunSubscriptions.keys())) {
    disposeOffPeakRunSubscription(key);
  }
  disposeOffPeakRuntime();
  offPeakTaskRepo.close();
  void windowRemoteConnectionRegistry.dispose();

  if (activeServices) {
    try {
      disposeServiceResources(activeServices);
    } catch (error) {
      logger.error("failed to dispose local services:", error);
    } finally {
      activeServices = null;
      activeHostApiNetworkTransport = null;
    }
  }

  if (activeSessionRealtimePort) {
    activeSessionRealtimePort.dispose();
    activeSessionRealtimePort = null;
  }
}

process.once("SIGTERM", () => {
  void disposeHostResources("SIGTERM").then(
    (result) => process.exit(result.exitCode),
    () => process.exit(1),
  );
});

process.once("SIGINT", () => {
  void disposeHostResources("SIGINT").then(
    (result) => process.exit(result.exitCode),
    () => process.exit(1),
  );
});

process.once("disconnect", () => {
  // No one will send Dispose after the parent IPC disappears; you must exit explicitly after the bounded cleanup is completed to avoid Host persistence.
  void disposeHostResources("disconnect").finally(() => process.exit(1));
});

process.once("exit", () => {
  disposeHostResourcesBestEffort("exit");
});

let handlingFatalUncaughtException = false;
process.on(
  "uncaughtException",
  createHostUncaughtExceptionHandler({
    onRecovered: (error, origin) => {
      const memoryUsage = process.memoryUsage();
      logger.warn("contained host allocation failure from native TLS callback", {
        arrayBuffers: memoryUsage.arrayBuffers,
        external: memoryUsage.external,
        heapUsed: memoryUsage.heapUsed,
        message: error.message,
        origin,
        rss: memoryUsage.rss,
      });
    },
    onFatal: (error, origin) => {
      if (handlingFatalUncaughtException) {
        process.exit(1);
      }
      handlingFatalUncaughtException = true;
      logger.error(`uncaughtException origin=${origin}:`, error);
      void disposeHostResources(`uncaughtException:${origin}`).finally(() => process.exit(1));
    },
  }),
);

parentPort.on("message", async (e: Electron.MessageEvent) => {
  const result = parseHostIncomingMessageEvent(e);
  if (!result.success) {
    logger.error("invalid parentPort message:", formatZodError(result.error));
    return;
  }

  const msg = result.data;
  const port = e.ports[0];
  if (msg.type === HostMessageTypes.DatabaseStartupControl) {
    if (msg.control.action === "snapshot") databaseStartup?.coordinator.publish();
    else if (msg.control.action === "retry")
      void databaseStartup?.coordinator.retry(msg.control.attemptId);
    return;
  }

  if (msg.type === HostMessageTypes.CuaPipFocusChanged) {
    const service = activeServices?.getOptional(ICuaPipSessionService);
    if (service) {
      void service.publishFocus(msg.event);
    } else {
      // When the service cannot be obtained, it was silently discarded in the past, and focus-changed disappeared from the link.
      // (dev actually measured 0 items, and official package included 92 items in the same period). Only by adding this can "main not be sent" be combined with
      // "Host received but the service was not registered" separately.
      logger.warn("[cua-pip-session] focus event dropped: service unavailable");
    }
    return;
  }

  if (msg.type === HostMessageTypes.ResourceUsageSnapshotRequest) {
    void hostResourceUsageResponder.handleRequest(msg);
    return;
  }
  if (msg.type === HostMessageTypes.ResourceUsageSnapshotCancel) {
    hostResourceUsageResponder.cancelRequest(msg.requestId);
    return;
  }

  if (msg.type === HostMessageTypes.FeedbackLogArchiveResult) {
    const pending = pendingFeedbackLogArchiveRequests.get(msg.requestId);
    if (!pending) {
      return;
    }
    pendingFeedbackLogArchiveRequests.delete(msg.requestId);
    if (msg.ok && msg.path && typeof msg.size === "number") {
      pending.onProgress?.({ processedBytes: msg.size, totalBytes: msg.size });
      pending.resolve({ path: msg.path, size: msg.size });
      return;
    }
    pending.reject(new Error(msg.error ?? "failed to create feedback log archive"));
    return;
  }

  if (msg.type === HostMessageTypes.LocalMediaPreviewPathAuthorizeResult) {
    const pending = pendingLocalMediaPreviewPathAuthorizations.get(msg.requestId);
    if (!pending) return;
    pendingLocalMediaPreviewPathAuthorizations.delete(msg.requestId);
    if (msg.ok && msg.path) {
      logger.info("local media preview path authorization OK");
      pending.resolve(msg.path);
    } else {
      pending.reject(new Error(msg.error ?? "failed to authorize local video preview path"));
    }
    return;
  }

  if (msg.type === HostMessageTypes.CronRun) {
    if (databaseStartup?.coordinator.snapshot.phase !== "ready") {
      parentPort.postMessage({
        type: HostResponseTypes.CronRunResult,
        runId: msg.runId,
        ok: false,
        error: "Local database startup is not ready",
        failureKind: "transient",
      });
      return;
    }
    void (async () => {
      try {
        const dispatchResult = await dispatchCronRun({
          ...msg,
          mode: msg.mode as ZCodeTaskMode | undefined,
        });
        parentPort.postMessage({
          type: HostResponseTypes.CronRunResult,
          runId: msg.runId,
          ok: true,
          ...dispatchResult,
        });
      } catch (error) {
        parentPort.postMessage({
          type: HostResponseTypes.CronRunResult,
          runId: msg.runId,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
          failureKind: "transient",
        });
      }
    })();
    return;
  }

  if (msg.type === HostMessageTypes.OffPeakRun) {
    if (databaseStartup?.coordinator.snapshot.phase !== "ready") {
      parentPort.postMessage({
        type: HostResponseTypes.OffPeakRunResult,
        offPeakTaskId: msg.offPeakTaskId,
        ok: false,
        error: "Local database startup is not ready",
        failureKind: "transient",
      });
      return;
    }
    void (async () => {
      try {
        const dispatchResult = await dispatchOffPeakRun(msg);
        parentPort.postMessage({
          type: HostResponseTypes.OffPeakRunResult,
          offPeakTaskId: msg.offPeakTaskId,
          ok: true,
          ...dispatchResult,
        });
      } catch (error) {
        parentPort.postMessage({
          type: HostResponseTypes.OffPeakRunResult,
          offPeakTaskId: msg.offPeakTaskId,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
          // Deterministic model/credential configuration error retry will not self-heal; hand it to scheduler to fail.
          // Unknown and life cycle errors still maintain the original backoff semantics as transient.
          failureKind: error instanceof OffPeakPermanentDispatchError ? "permanent" : "transient",
        });
      }
    })();
    return;
  }

  if (msg.type === HostMessageTypes.BrowserExecuteResult) {
    // After main's WebContentsView+CDP executes the browser command, it is associated back to bridge's pending by requestId.
    void browserControlMainBridge.handleResult({
      requestId: msg.requestId,
      result: msg.result,
    });
    return;
  }

  if (msg.type === HostMessageTypes.Dispose) {
    // Main process notification cleanup (when the window is closed/app exits)
    // Here, you must wait for the unified resource cleanup to be completed (including asynchronous write-back), and then let the process exit; there is still a forced kill timer on the main side.
    const result = await disposeHostResources("parent dispose");
    process.exit(result.exitCode);
    return;
  }

  if (msg.type === HostMessageTypes.Broadcast) {
    return;
  }

  if (msg.type === HostMessageTypes.SessionMessageDeliver) {
    const zcodeTaskService = activeServices?.getOptional(IZCodeTaskService);
    if (!zcodeTaskService) {
      parentPort.postMessage({
        type: HostResponseTypes.SessionMessageDeliverResult,
        result: {
          error: "ZCode task service is not initialized.",
          messageId: msg.request.messageId,
          requestId: msg.request.requestId,
          sessionId: msg.request.fromSessionId,
          status: "failed",
        },
      });
      return;
    }

    void zcodeTaskService
      .deliverSessionMessage(msg.request)
      .then((deliveryResult) => {
        parentPort.postMessage({
          type: HostResponseTypes.SessionMessageDeliverResult,
          result: deliveryResult,
        });
      })
      .catch((error) => {
        parentPort.postMessage({
          type: HostResponseTypes.SessionMessageDeliverResult,
          result: {
            error: error instanceof Error ? error.message : String(error),
            messageId: msg.request.messageId,
            requestId: msg.request.requestId,
            sessionId: msg.request.fromSessionId,
            status: "failed",
          },
        });
      });
    return;
  }

  if (msg.type === HostMessageTypes.SessionMessageDeliveryResult) {
    const zcodeTaskService = activeServices?.getOptional(IZCodeTaskService);
    if (!zcodeTaskService) {
      logger.warn("session message delivery result received before ZCode task service initialized");
      return;
    }
    void zcodeTaskService.sendSessionMessageDeliveryResult(msg.result).catch((error) => {
      logger.warn("failed to forward session message delivery result:", error);
    });
    return;
  }

  if (msg.type === HostMessageTypes.ProviderProvisioningExecute) {
    const session = windowRemoteConnectionRegistry.getSession(msg.remoteSessionId);
    if (
      !session ||
      !session.workspaceIdentity ||
      buildRemoteEnvironmentKey(session.target) !== msg.environmentKey
    ) {
      parentPort.postMessage({
        type: HostResponseTypes.ProviderProvisioningExecutionResult,
        requestId: msg.requestId,
        environmentKey: msg.environmentKey,
        status: "failed",
        error: "Remote Environment registration is no longer valid",
      });
      return;
    }
    const scope = {
      kind: "remote",
      remoteSessionId: session.remoteSessionId,
      workspacePath: session.workspacePath ?? "/",
      workspaceIdentity: session.workspaceIdentity,
    } as const;
    void Promise.resolve()
      .then(() =>
        (() => {
          const provisioningService = getRemoteProviderProvisioningExecutor(
            windowRemoteConnectionRegistry.resolveScopedServices(scope),
          );
          if (!provisioningService) {
            throw new Error("Remote Environment does not support Provider Provisioning");
          }
          return provisioningService.syncLocalToRemote();
        })(),
      )
      .then((result) => {
        parentPort.postMessage({
          type: HostResponseTypes.ProviderProvisioningExecutionResult,
          requestId: msg.requestId,
          environmentKey: msg.environmentKey,
          status: result.status,
          ...(result.errorMessage ? { error: result.errorMessage } : {}),
        });
      })
      .catch((error: unknown) => {
        parentPort.postMessage({
          type: HostResponseTypes.ProviderProvisioningExecutionResult,
          requestId: msg.requestId,
          environmentKey: msg.environmentKey,
          status: "failed",
          error: error instanceof Error ? error.message : String(error),
        });
      });
    return;
  }

  if (msg.type === HostMessageTypes.ConnectRemoteWorkspace) {
    const workspacePath = msg.workspacePath ?? "/";
    const workspaceIdentity =
      msg.workspaceIdentity ?? buildRemoteWorkspaceIdentity(workspacePath, msg.target);
    logger.info(
      `connecting window-scoped remote source, requestId=${msg.requestId}, target=${formatRemoteTargetForLog(msg.target)}`,
    );
    void remoteConnectionProgressContext
      .run(msg.requestId, () =>
        windowRemoteConnectionRegistry.connect({
          requestId: msg.requestId,
          target: msg.target,
          remoteAssets: msg.remoteAssets,
          workspacePath,
          workspaceIdentity,
        }),
      )
      .then(async (descriptor) => {
        const replacedOfflineSessions = windowRemoteConnectionRegistry
          .listSessions()
          .filter(
            (session) =>
              session.remoteSessionId !== descriptor.remoteSessionId &&
              session.state === "disconnected" &&
              session.workspacePath === descriptor.workspacePath &&
              session.workspaceIdentity === descriptor.workspaceIdentity,
          );
        for (const replaced of replacedOfflineSessions) {
          if (replaced.workspacePath && replaced.workspaceIdentity) {
            const previousScope = {
              kind: "remote",
              remoteSessionId: replaced.remoteSessionId,
              workspacePath: replaced.workspacePath,
              workspaceIdentity: replaced.workspaceIdentity,
            } as const;
            const nextScope = {
              kind: "remote",
              remoteSessionId: descriptor.remoteSessionId,
              workspacePath: replaced.workspacePath,
              workspaceIdentity: replaced.workspaceIdentity,
            } as const;
            try {
              const services = windowRemoteConnectionRegistry.resolveScopedServices(nextScope);
              await windowHostControllerRuntime.replaceDisconnectedSource(previousScope, {
                scope: nextScope,
                taskService: services.get(IZCodeTaskService),
                sourceAvailability: "online",
              });
            } catch (error) {
              // When the source is connected but the task-index is temporarily unreadable, the transport cannot be rolled back, nor can the previous generation be deleted.
              // Offline trusted projection. The Controller will retain pending replacement, and it will be replaced atomically after subsequent queries succeed.
              logger.warn("failed to atomically replace disconnected Controller source", error);
            }
          }
          windowHostAttachmentRegistry.detachRemoteSessionAttachments(replaced.remoteSessionId);
          await windowRemoteConnectionRegistry.disposeSession(replaced.remoteSessionId);
          // After reconnection and replacement, the old remoteSessionId is no longer attachable; the port request association of Main is cleared synchronously.
          // But do not falsely report a new transport failure to the Renderer.
          parentPort.postMessage({
            type: HostResponseTypes.RemoteWorkspaceClosed,
            remoteSessionId: replaced.remoteSessionId,
            reason: "disposed",
          });
        }
        parentPort.postMessage({
          type: HostResponseTypes.RemoteWorkspaceConnected,
          requestId: msg.requestId,
          descriptor,
        });
        logWindowHostTopology("remote-connected");
      })
      .catch((error) => {
        parentPort.postMessage({
          type: HostResponseTypes.RemoteWorkspaceConnectFailed,
          requestId: msg.requestId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    return;
  }

  if (msg.type === HostMessageTypes.CancelRemoteWorkspaceConnect) {
    windowRemoteConnectionRegistry.cancelConnect(msg.requestId);
    return;
  }

  if (msg.type === HostMessageTypes.BindRemoteWorkspaceContext) {
    const previous = windowRemoteConnectionRegistry.getSession(msg.remoteSessionId);
    let workspaceReady: Promise<void>;
    try {
      workspaceReady = windowRemoteConnectionRegistry.bindWorkspaceContext({
        remoteSessionId: msg.remoteSessionId,
        workspacePath: msg.workspacePath,
        workspaceIdentity: msg.workspaceIdentity,
      });
    } catch (error) {
      logger.warn(
        `failed to bind remote workspace context, remoteSessionId=${msg.remoteSessionId}`,
        error,
      );
      return;
    }
    const current = windowRemoteConnectionRegistry.getSession(msg.remoteSessionId);
    if (current) {
      // After the scope generation is replaced, the old Renderer/mobile phone attachment must not continue to hold the remote IO facade.
      windowHostAttachmentRegistry.detachStaleRemoteSessionAttachments(
        msg.remoteSessionId,
        current.generation,
      );
    }
    void workspaceReady.catch((error) => {
      logger.warn(
        `failed to prepare bound remote workspace, remoteSessionId=${msg.remoteSessionId}`,
        error,
      );
    });
    if (previous?.workspacePath && previous.workspaceIdentity) {
      windowHostControllerRuntime.removeSource({
        kind: "remote",
        remoteSessionId: msg.remoteSessionId,
        workspacePath: previous.workspacePath,
        workspaceIdentity: previous.workspaceIdentity,
      });
    }
    logger.info(
      `bound remote workspace context, remoteSessionId=${msg.remoteSessionId}, workspacePath=${msg.workspacePath}`,
    );
    return;
  }

  if (msg.type === HostMessageTypes.DisposeRemoteWorkspaceSession) {
    const disposedSession = windowRemoteConnectionRegistry.getSession(msg.remoteSessionId);
    windowHostAttachmentRegistry.detachRemoteSessionAttachments(msg.remoteSessionId);
    void windowRemoteConnectionRegistry
      .disposeSession(msg.remoteSessionId)
      .then(() => {
        if (disposedSession?.workspacePath && disposedSession.workspaceIdentity) {
          windowHostControllerRuntime.removeSource({
            kind: "remote",
            remoteSessionId: msg.remoteSessionId,
            workspacePath: disposedSession.workspacePath,
            workspaceIdentity: disposedSession.workspaceIdentity,
          });
        }
        parentPort.postMessage({
          type: HostResponseTypes.RemoteWorkspaceClosed,
          remoteSessionId: msg.remoteSessionId,
          reason: "disposed",
        });
        logWindowHostTopology("remote-session-disposed");
      })
      .catch((error) => {
        logger.warn(
          `failed to dispose remote logical session, remoteSessionId=${msg.remoteSessionId}`,
          error,
        );
      });
    return;
  }

  if (
    msg.type === HostMessageTypes.BotRemoteWorkspaceReconnectResult ||
    msg.type === HostMessageTypes.BotRemoteWorkspaceConnectionStatusResult ||
    msg.type === HostMessageTypes.BotRemoteWorkspaceRuntimePort
  ) {
    // Bugfix: Bot bridge also monitors parentPort, and the runtime MessagePort returned by main is given to Bot as
    // Used by remote RPC clients. The host entry must skip these control messages to avoid accidentally registering the same port as a ChannelServer.
    return;
  }

  if (msg.type === HostMessageTypes.AttachServicePort) {
    if (!port) {
      logger.error("attach-service-port message missing MessagePort");
      return;
    }
    if (msg.scope.kind === "local" && databaseStartup?.coordinator.snapshot.phase !== "ready") {
      // Refresh/mobile attachment reuses the same Host, waits for existing preparations, and does not start the second executor.
      pendingStartupAttachments.set(msg.attachmentId, () => {
        windowHostAttachmentRegistry.attach({ ...msg, port });
      });
      port.once("close", () => pendingStartupAttachments.delete(msg.attachmentId));
      return;
    }
    try {
      if (msg.scope.kind === "remote") {
        // Bind shares parentPort with Attach, but the previous generation workspace release of WSL may still be on the way.
        // Hold the transferred port and wait for the generation barrier in the Host to prevent the new attachment from stepping on the old runtime cleanup.
        await windowRemoteConnectionRegistry.waitForScopedServices(msg.scope);
      }
      windowHostAttachmentRegistry.attach({
        requestId: msg.requestId,
        attachmentId: msg.attachmentId,
        clientMode: msg.clientMode,
        scope: msg.scope,
        port,
      });
      logger.info(
        `attached scoped service port, attachmentId=${msg.attachmentId}, scope=${msg.scope.kind}, clientMode=${msg.clientMode}`,
      );
      logWindowHostTopology("attachment-added");
    } catch (error) {
      // If the port across logical sessions or old identities continues to be exposed, remote requests will be routed to the wrong source.
      // If scope verification fails, the transferred port must be closed and clearly recorded, and rollback to active local services is prohibited.
      rejectUnavailableAttachedServicePort(port, false);
      logger.warn(`failed to attach scoped service port, attachmentId=${msg.attachmentId}`, error);
    }
    return;
  }

  if (msg.type === HostMessageTypes.DetachServicePort) {
    pendingStartupAttachments.delete(msg.attachmentId);
    windowHostAttachmentRegistry.detach(msg.attachmentId);
    logger.info(`detached service port, attachmentId=${msg.attachmentId}`);
    logWindowHostTopology("attachment-removed");
    return;
  }

  if (!port) {
    return;
  }

  if (msg.type === HostMessageTypes.InitLocal) {
    if (!port) {
      logger.error("init-local message missing MessagePort");
      return;
    }
    if (databaseStartup) {
      port.close();
      databaseStartup.coordinator.publish();
      return;
    }
    let basePortClosed = false;
    port.once("close", () => {
      basePortClosed = true;
    });
    databaseStartup = createHostDatabaseStartup({
      startupId: msg.databaseStartupId,
      cwd: msg.agentSpawnFallbackCwd ?? process.cwd(),
      workingDirectories:
        msg.agentWarmupTargets?.map((target) => target.workspacePath) ??
        (msg.workspacePath ? [msg.workspacePath] : []),
      env: msg.runtimeProcessEnvPatch,
      publish: (state) => {
        parentPort?.postMessage({ type: HostResponseTypes.DatabaseStartupState, state });
        if (state.phase === "ready") {
          for (const attach of pendingStartupAttachments.values()) {
            try {
              attach();
            } catch (error) {
              logger.warn("startup attachment failed", error);
            }
          }
          pendingStartupAttachments.clear();
        }
      },
      onFailure: (error) =>
        logger.error(
          `local database startup failed attempt=${databaseStartup?.coordinator.snapshot.attemptId}`,
          error,
        ),
      initializeServices: async () => {
        logger.info("initializing local services");
        activeSessionRealtimePort = createTaskRealtimeBridgeForHostInit(msg, parentPort);
        // The old Team replacement organization must share the same Setting instance and write queue as the network agent read.
        // Injecting only service will skip the default assembly branch, resulting in unorganized upgrade users never being able to restore connectivity.
        const { service: settingService, prepareLegacyAccountConnections } =
          createSettingServiceWithMigrations();
        const hostApiNetworkTransport = createHostApiNetworkTransport(async () => {
          const settings = await settingService.get();
          return {
            httpProxy: settings.httpProxy,
            noProxy: settings.httpProxyNoProxy,
            caCertPath: settings.httpProxyCaCertPath,
          };
        });
        const services = await initializeHostApiNetworkTransportOwner({
          transport: hostApiNetworkTransport,
          log: (message, details) => logger.warn(message, details),
          establishOwner: () => {
            const initializedServices = createLocalServices({
              parentPort,
              settingService,
              prepareLegacyAccountConnections,
              hostApiNetworkTransport,
              authorizeLocalMediaPreviewPath,
              runtimeProcessEnvPatch: msg.runtimeProcessEnvPatch,
              agentRuntimeContext: {
                getDeviceMid: () => msg.deviceMid,
                runtimeSurface: "desktop_local_host",
              },
              serviceAuthorityMode: "desktop-local",
              zcodeAgentSpawnFallbackCwd: msg.agentSpawnFallbackCwd,
              zcodeBuiltinProviderConfigFilePath: msg.zcodeBuiltinProviderConfigFilePath,
              processLifecycleReporter: runtimeProcessLifecycleReporter,
              taskRuntimeReporter: runtimeTaskReporter,
              feedback: {
                getDeviceMid: () => msg.deviceMid,
                apiBaseUrl: msg.feedbackApiBase,
                createFullLogArchive: createFullFeedbackLogArchiveViaMain,
              },
              forwardSessionMessageSendRequested: (request) => {
                parentPort?.postMessage({
                  type: HostResponseTypes.SessionMessageSendRequested,
                  request,
                });
              },
              onAutomationManualRunRequested: dispatchManualAutomationRun,
              onOffPeakSchedulerWakeRequested: () => {
                parentPort?.postMessage({ type: HostResponseTypes.OffPeakSchedulerWakeRequest });
              },
              onProviderProvisioningSourceChanged: (trigger) => {
                parentPort?.postMessage({
                  type: HostResponseTypes.ProviderProvisioningSourceChanged,
                  trigger,
                });
              },
              // browser-use: agent's interaction/browserExecute is transferred to this executor via zcodeAgentService.
              // Then go to main's WebContentsView+CDP via parentPort for execution.
              browserControlExecutor: browserControlMainBridge,
              // The prompt at the top of CUA belongs to the physical Windows desktop projection; neither non-Windows nor remote authorities are allowed to report it.
              cuaOperationStateReporter:
                process.platform === "win32" ? cuaOperationStateReporter : undefined,
            });
            activeServices = initializedServices;
            activeHostApiNetworkTransport = hostApiNetworkTransport;
            return initializedServices;
          },
        });
        const zcodeTaskService = services.getOptional(IZCodeTaskService);
        if (zcodeTaskService) {
          const reportingZCodeTaskService = createReportingRemoteZCodeTaskService(
            zcodeTaskService,
            {
              reportRunningPromptCount: false,
            },
          );
          services.register(IZCodeTaskService, reportingZCodeTaskService);
        }
        wireLocalResourceTelemetry(services);
        hasDisposedHostResources = false;
        disposeHostResourcesInFlight = null;
        const agentWarmupTargets =
          msg.agentWarmupTargets && msg.agentWarmupTargets.length > 0
            ? msg.agentWarmupTargets
            : msg.workspacePath
              ? [
                  {
                    workspacePath: msg.workspacePath,
                    ...(msg.workspaceIdentity ? { workspaceIdentity: msg.workspaceIdentity } : {}),
                  },
                ]
              : [];
        // Main has limited startup preheating to 3 in order of recent use; Host must explicitly consume this
        // The fixed list cannot be expanded implicitly by subsequent task-list observers, nor can it be scanned and filled due to a single failure.
        agentWarmupTargets.forEach((target, index) => {
          warmUpZCodeAgent(
            services,
            target,
            `local host init (${index + 1}/${agentWarmupTargets.length})`,
          );
        });
        logger.info("exposing services on ChannelServer...");
        if (!basePortClosed)
          windowHostAttachmentRegistry.attach({
            requestId: `init-local-${randomUUID()}`,
            attachmentId: `base-${randomUUID()}`,
            clientMode: "desktop-continuous",
            scope: { kind: "local" },
            port,
          });
        logWindowHostTopology("base-attachment-ready");
        logger.info("local services ready, all channels registered");
      },
    });
    await databaseStartup.coordinator.start();
  }
});

async function setupRemoteConnection(
  target: RemoteTarget,
  remoteAssets: RemoteAssetDirs,
  remoteAssetNetwork: RemoteAssetNetworkPort,
  remoteRuntimeNetwork: RemoteRuntimeNetworkOptions | undefined,
  onDidRemoteClose: (exitCode: number) => void,
  deployLockMode: DeployLockMode = "remote",
  signal?: AbortSignal,
): Promise<HostRemoteConnection> {
  // Lazy loading of remote backend to avoid crash in local mode due to ssh2 dependency chain entering asar
  const { createRemoteBackend, connectRemote, pickRemoteRuntimeEnv } =
    await import("@zcode/server/remote");
  const backend = await createRemoteBackend(target);
  const connection = await connectRemote(backend, {
    ...remoteAssets,
    remoteAssetNetwork,
    remoteRuntimeNetwork,
    signal,
    // The SSH remote server is started separately by the host process and cannot rely on the environment inheritance of the desktop main.
    // Here, the compile-time version is explicitly transmitted transparently to avoid missing the import and generating a naked ZCODE_VERSION reference, which will cause a direct ReferenceError during SSH initialization.
    appVersion: ZCODE_VERSION,
    // The remote zcode-server/agent is an independent process and cannot inherit the test/production endpoint selection in the host.
    // Here, only the public environment variables allowed by the server-side whitelist are transparently transmitted to avoid bringing credentials/tokens to the remote machine.
    remoteRuntimeEnv: pickRemoteRuntimeEnv(process.env),
    assetInstallMode: target.kind === "ssh" ? target.assetInstallMode : undefined,
    // SSH is serially reused by the window-level registry, and the remaining transports still retain the remote connector's own lock.
    deployLockMode,
    onDidRemoteClose: ({ code }) => {
      onDidRemoteClose(code);
    },
  });
  return { ...connection, backend };
}
