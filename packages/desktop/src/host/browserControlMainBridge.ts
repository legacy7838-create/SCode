import { randomUUID } from "node:crypto";
import { HostResponseTypes } from "@zcode/shared";
import type {
  BrowserBackendDescriptor,
  BrowserClientMode,
  BrowserCommand,
  BrowserCommandResult,
  BrowserRecordingArtifact,
} from "@zcode/shared";

/**
 * host↔main browser execution bridge. The host side sends a command to main via parentPort (executed by WebContentsView+CDP).
 * Correlate the return results by requestId. Imitate the pending map mode of createFullFeedbackLogArchiveViaMain.
 *
 * Designed to be injectable postMessage + no global dependencies, easy to single test (fake parentPort).
 */

interface BrowserExecuteRequestMessage {
  type: typeof HostResponseTypes.BrowserExecuteRequest;
  requestId: string;
  browserId: string;
  browserGeneration: number;
  sessionId: string;
  turnId?: string;
  workspaceKey: string;
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  clientMode: BrowserClientMode;
  sessionContext: "live" | "cached";
  command: BrowserCommand;
}

interface BrowserExecuteResultMessage {
  requestId: string;
  result: BrowserCommandResult;
}

interface PendingEntry {
  resolve: (result: BrowserCommandResult) => void;
  timer: ReturnType<typeof setTimeout>;
  method: BrowserCommand["method"];
  startedAt: number;
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  outputPath?: string;
}

/**
 * host→main browser subcommand budget. The outer node_repl MCP tool defaults to 60s; 30s is reserved here for JS
 * Margins are left for finishing, image normalization and structured error return, and two deadlines cannot be allowed to compete at the same time.
 */
const DEFAULT_TIMEOUT_MS = 30_000;

function mayHaveSideEffects(command: BrowserCommand): boolean {
  if (command.method === "playwright" && command.action.name === "locator") {
    return [
      "click",
      "dblclick",
      "downloadMedia",
      "fill",
      "press",
      "selectOption",
      "setChecked",
    ].includes(command.action.operation);
  }
  return [
    "navigate",
    "back",
    "forward",
    "reload",
    "click",
    "fill",
    "type",
    "press",
    "cuaKeypress",
    "scroll",
    "cuaScroll",
    "domCuaScroll",
    "hover",
    "select",
    "check",
    "drag",
    "cuaDrag",
    "recordingStart",
    "recordingCancel",
    "handleDialog",
    "close",
    "finalize",
    "newTab",
  ].includes(command.method);
}

interface BrowserControlMainBridge {
  list(): Promise<BrowserBackendDescriptor[]>;
  execute(input: {
    requestId?: string;
    browserId?: string;
    browserGeneration?: number;
    sessionId: string;
    turnId?: string;
    workspaceKey?: string;
    workspacePath?: string;
    workspaceIdentity?: string;
    remoteSessionId?: string;
    clientMode?: BrowserClientMode;
    sessionContext?: "live" | "cached";
    command: BrowserCommand;
  }): Promise<BrowserCommandResult>;
  /** Main is called by host message dispatch when returning results. */
  handleResult(message: BrowserExecuteResultMessage): Promise<void>;
  dispose(): void;
}

export function createBrowserControlMainBridge(deps: {
  postToMain: (message: BrowserExecuteRequestMessage) => void;
  timeoutMs?: number;
  materializeRecording?(input: {
    artifact: BrowserRecordingArtifact;
    localPath: string;
    outputPath: string;
    workspacePath: string;
    workspaceIdentity?: string;
    remoteSessionId?: string;
  }): Promise<BrowserRecordingArtifact>;
}): BrowserControlMainBridge {
  const pending = new Map<string, PendingEntry>();
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const browserId = `iab:${randomUUID()}`;
  const browserGeneration = Date.now();
  const deletePendingIfCurrent = (requestId: string, entry: PendingEntry): boolean => {
    if (pending.get(requestId) !== entry) return false;
    pending.delete(requestId);
    return true;
  };
  const descriptor: BrowserBackendDescriptor = {
    id: browserId,
    generation: browserGeneration,
    type: "iab",
    name: "ZCode In-app Browser",
    capabilities: {
      // The capability collection only lists optional capabilities; tabs/cua/screenshot/dialog is the core API.
      // Cannot be disguised as capability. viewport is Playwright-like Tab core API; browser capability
      // Currently only visibility is retained, pageAssets/cdp is not implemented and is not exposed.
      browser: [
        {
          id: "visibility",
          description:
            "Use to show or hide the browser to the user, and to determine the browser's current visibility. Keep browser work in the background unless the user asks to see it or live viewing is useful. When the browser should be visible, call set(true).",
        },
      ],
      tab: [],
    },
    apiSupportOverrides: {
      "BrowserUser.claimTab": true,
      "Tabs.finalize": true,
      "Tab.markDeliverable": true,
      "Tab.markHandoff": true,
      "BrowserRecordingAPI.start": true,
      "BrowserRecordingAPI.status": true,
      "BrowserRecordingAPI.cancel": true,
    },
    metadata: {
      provider: "zcode-desktop-iab",
    },
  };

  return {
    async list(): Promise<BrowserBackendDescriptor[]> {
      return [descriptor];
    },

    async execute({
      requestId: inputRequestId,
      browserId: requestedBrowserId,
      browserGeneration: requestedBrowserGeneration,
      sessionId,
      turnId,
      workspaceKey = sessionId,
      workspacePath = workspaceKey,
      workspaceIdentity,
      remoteSessionId,
      clientMode = "desktop-continuous",
      sessionContext = "live",
      command,
    }): Promise<BrowserCommandResult> {
      if (requestedBrowserId && requestedBrowserId !== browserId) {
        return {
          ok: false,
          error: {
            code: "backend_unavailable",
            message: `browser backend '${requestedBrowserId}' is no longer available`,
          },
          elapsedMs: 0,
        };
      }
      if (
        requestedBrowserGeneration !== undefined &&
        requestedBrowserGeneration !== browserGeneration
      ) {
        return {
          ok: false,
          error: {
            code: "backend_unavailable",
            message: `browser backend '${browserId}' generation ${requestedBrowserGeneration} is stale`,
          },
          elapsedMs: 0,
        };
      }
      const requestId = inputRequestId ?? randomUUID();
      if (pending.has(requestId)) {
        // requestId is the correlation key between the result and Promise. Overwrite the same key entry
        // The old result will be handed over to the new Promise and the old timer/finally will delete the new request. Must fail before transport.
        return {
          ok: false,
          error: {
            code: "duplicate_request_id",
            message: `browser requestId '${requestId}' is already running`,
            sideEffect: "none",
          },
          elapsedMs: 0,
        };
      }
      const startedAt = Date.now();
      // The transport budget for a fixed wait is the request duration plus 2 seconds, covering the wait itself and the transport overhead.
      // Otherwise, waitForTimeout(>=30s) will be mistakenly timed out by the host bridge before the timer completes normally.
      const requestTimeoutMs =
        command.method === "playwrightWaitForTimeout"
          ? command.timeoutMs + 2_000
          : command.method === "playwright"
            ? ("timeoutMs" in command.action
                ? (command.action.timeoutMs ?? timeoutMs)
                : timeoutMs) + 2_000
            : timeoutMs;
      return await new Promise<BrowserCommandResult>((resolve) => {
        let entry: PendingEntry;
        const timer = setTimeout(() => {
          // Only the current entry is allowed to settle its own life cycle; it prevents future new paths from being re-introduced after overwriting with the same key.
          // Old timer deletes or cancels later registered requests.
          if (!deletePendingIfCurrent(requestId, entry)) return;
          // In the past, the host only ended local waiting. The actions in main/backend would still continue to be executed, but the caller had
          // timeout received. Now use the same scope to send reverse cancel; when it cannot be proven whether the action has been sent,
          // It must be marked uncertain according to the operation result contract and cannot be falsely reported as a timeout without side effects.
          const cancelRequestId = randomUUID();
          try {
            deps.postToMain({
              type: HostResponseTypes.BrowserExecuteRequest,
              requestId: cancelRequestId,
              browserId,
              browserGeneration,
              sessionId,
              turnId,
              workspaceKey,
              workspacePath,
              workspaceIdentity,
              remoteSessionId,
              clientMode,
              sessionContext,
              command: { method: "cancelRequest", requestId },
            });
          } catch {
            // The original request has timed out; canceling the transport failure will not overwrite the more useful timeout results.
          }
          resolve({
            ok: false,
            error: {
              code: "timeout",
              message: `browser command ${command.method} timed out (${requestTimeoutMs}ms)`,
              sideEffect: mayHaveSideEffects(command) ? "uncertain" : "none",
            },
            elapsedMs: Date.now() - startedAt,
          });
        }, requestTimeoutMs);
        entry = {
          resolve,
          timer,
          method: command.method,
          startedAt,
          workspacePath,
          ...(workspaceIdentity ? { workspaceIdentity } : {}),
          ...(remoteSessionId ? { remoteSessionId } : {}),
          ...(command.method === "recordingStatus" && command.outputPath
            ? { outputPath: command.outputPath }
            : {}),
        };
        pending.set(requestId, entry);
        try {
          deps.postToMain({
            type: HostResponseTypes.BrowserExecuteRequest,
            requestId,
            browserId,
            browserGeneration,
            sessionId,
            turnId,
            workspaceKey,
            workspacePath,
            workspaceIdentity,
            remoteSessionId,
            clientMode,
            sessionContext,
            command,
          });
        } catch (error) {
          clearTimeout(timer);
          deletePendingIfCurrent(requestId, entry);
          resolve({
            ok: false,
            error: {
              code: "backend_unavailable",
              message: error instanceof Error ? error.message : String(error),
            },
            elapsedMs: Date.now() - startedAt,
          });
        }
      });
    },

    async handleResult(message): Promise<void> {
      const entry = pending.get(message.requestId);
      if (!entry) {
        // Late results (timed out for cleanup) - ignored.
        return;
      }
      clearTimeout(entry.timer);
      if (!deletePendingIfCurrent(message.requestId, entry)) return;
      const artifact = message.result.recording?.artifact;
      if (
        message.result.ok &&
        message.result.recording?.status === "completed" &&
        artifact &&
        entry.outputPath
      ) {
        if (!deps.materializeRecording) {
          entry.resolve({
            ok: false,
            error: {
              code: "backend_unavailable",
              message: "browser recording artifact materialization is unavailable",
              sideEffect: "none",
            },
            elapsedMs: Date.now() - entry.startedAt,
          });
          return;
        }
        try {
          const materialized = await deps.materializeRecording({
            artifact,
            localPath: artifact.path,
            outputPath: entry.outputPath,
            workspacePath: entry.workspacePath,
            ...(entry.workspaceIdentity ? { workspaceIdentity: entry.workspaceIdentity } : {}),
            ...(entry.remoteSessionId ? { remoteSessionId: entry.remoteSessionId } : {}),
          });
          entry.resolve({
            ...message.result,
            recording: { ...message.result.recording, artifact: materialized },
          });
        } catch (error) {
          entry.resolve({
            ok: false,
            error: {
              code: "execution_error",
              message: error instanceof Error ? error.message : String(error),
              sideEffect: "none",
            },
            elapsedMs: Date.now() - entry.startedAt,
          });
        }
        return;
      }
      if (message.result.recording?.status === "completed" && artifact && !entry.outputPath) {
        const { artifact: _mainTemporaryArtifact, ...recording } = message.result.recording;
        entry.resolve({
          ...message.result,
          recording,
        });
        return;
      }
      entry.resolve(message.result);
    },

    dispose(): void {
      for (const [requestId, entry] of pending) {
        if (!deletePendingIfCurrent(requestId, entry)) continue;
        clearTimeout(entry.timer);
        // Directly clearing the map will leave all await calls permanently hanging. bridge shutdown required
        // Ending the promise and making it clear whether the backend has been executed is undecidable.
        entry.resolve({
          ok: false,
          error: {
            code: "backend_unavailable",
            message: "browser bridge disposed while command was pending",
            sideEffect: "uncertain",
          },
          elapsedMs: Date.now() - entry.startedAt,
        });
      }
    },
  };
}
