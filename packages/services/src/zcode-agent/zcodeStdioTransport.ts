import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { Emitter } from "@zcode/rpc";
import type { ZCodeProtocolMessage } from "@zcode/shared";
import { zcodeProtocolMessageSchema } from "@zcode/shared";
import { createServiceLogger } from "#src/logger/serviceLogger.js";
import type {
  ZCodeProtocolTransport,
  ZCodeProtocolTransportClosedEvent,
} from "./zcodeProtocolTransport.js";
import {
  captureProcessGroupSnapshot,
  captureExitedRootDescendantsSnapshotAsync,
  captureProcessTreeSnapshotAsync,
  terminateProcessTree,
  terminateProcessTreeAndWait,
} from "#src/process/processTreeTerminator.js";
import type { ProcessTreeSnapshot } from "#src/process/processTreeTerminator.js";
import { AgentStderrCollector, EXIT_STDERR_DRAIN_MS } from "./agentStderrCollector.js";

interface ZCodeStdioTransportOptions {
  onStderrLine?: (line: string) => void;
  ownedProcessGroupId?: number;
  ownedProcessStartedAtMs?: number;
}

const STDIO_EOF_EXIT_WAIT_MS = 1_800;
const DISPOSE_STDERR_DRAIN_MS = 3_250;
const E2E_COVERAGE_STDIO_EOF_EXIT_WAIT_MS = 5_000;
const PROCESS_TREE_FORCE_AFTER_MS = 2_000;
const PROCESS_TREE_WINDOWS_TASKKILL_TIMEOUT_MS = 1_000;
const PROCESS_TREE_WINDOWS_EXIT_OBSERVATION_GRACE_MS = 250;
const processTreeLogger = createServiceLogger("zcode-agent-process-tree");

export class ZCodeStdioTransport implements ZCodeProtocolTransport {
  readonly kind = "stdio" as const;

  private readonly messageEmitter = new Emitter<ZCodeProtocolMessage>();
  private readonly closeEmitter = new Emitter<ZCodeProtocolTransportClosedEvent>();
  private readonly stderrCollector: AgentStderrCollector;
  private readonly stdoutDecoder = new StringDecoder("utf8");
  private stdoutBuffer = "";
  private stdoutFlushed = false;
  private readersDisposed = false;
  private disposed = false;
  private closed = false;
  private disposeAndWaitPromise: Promise<void> | undefined;
  private cleanupProcessTreeSnapshot: ProcessTreeSnapshot | undefined;
  private cleanupAttemptCount = 0;
  private childExitedAtMs: number | undefined;

  readonly onMessage = this.messageEmitter.event;
  readonly onClose = this.closeEmitter.event;

  constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    private readonly options?: ZCodeStdioTransportOptions,
  ) {
    this.stderrCollector = new AgentStderrCollector(child.stderr, options?.onStderrLine);

    // ZCode Protocol stdio frame boundary only recognizes LF. Node readline will convert U+2028/U+2029
    // Treated as line breaks, model text containing such characters will break the legal JSON string into half frames.
    child.stdout.on("data", this.handleStdoutData);
    child.stdout.once("end", this.handleStdoutEnd);
    child.stdout.once("close", this.handleStdoutEnd);
    child.stdin.on("error", (error) => this.handleStreamError("stdin", error));
    child.stdout.on("error", (error) => this.handleStreamError("stdout", error));
    child.once("exit", (code, signal) => {
      this.childExitedAtMs = Date.now();
      this.fireClose({ code, signal });
      this.disposeReaders();
      void this.waitForStderrDrain();
    });
    child.once("error", (error) => {
      this.fireClose({ reason: error.message });
      this.disposeReaders();
      void this.waitForStderrDrain();
    });
  }

  async send(message: ZCodeProtocolMessage): Promise<void> {
    if (this.disposed || this.closed || this.child.killed || !this.child.stdin.writable) {
      throw new Error("ZCode agent stdio transport is closed");
    }
    const frame = `${JSON.stringify(message)}\n`;
    await new Promise<void>((resolve, reject) => {
      this.child.stdin.write(frame, (error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.disposeLocalResources();
    void this.stderrCollector.waitForDrain(DISPOSE_STDERR_DRAIN_MS);
    if (!this.hasChildExited()) {
      // The agent wrapper under Windows and POSIX may continue to pull up the runtime/MCP child process.
      // Killing only the parent process will leave descendant processes or lock the workspace cwd for a short time.
      const ownedProcessGroupId = this.options?.ownedProcessGroupId;
      terminateProcessTree(this.child, ownedProcessGroupId ? { ownedProcessGroupId } : {});
    }
  }

  disposeAndWait(): Promise<void> {
    if (!this.disposeAndWaitPromise) {
      const inFlight = this.disposeAndWaitOnce().finally(() => {
        if (this.disposeAndWaitPromise === inFlight) {
          this.disposeAndWaitPromise = undefined;
        }
      });
      this.disposeAndWaitPromise = inFlight;
    }
    return this.disposeAndWaitPromise;
  }

  waitForStderrDrain(): Promise<void> {
    return this.stderrCollector.waitForDrain();
  }

  private async disposeAndWaitOnce(): Promise<void> {
    if (!this.disposed) {
      this.disposed = true;
      this.disposeLocalResources();
    }
    // stdin EOF may cause the CLI root process to exit first, while the detached MCP continues to run.
    // Tree members must be saved before issuing EOF, otherwise they cannot be retrieved by PPID after the root exits and the descendants are taken over by the system.
    this.cleanupAttemptCount += 1;
    const cleanupStartedAtMs = Date.now();
    const forceBudgetMs = this.cleanupAttemptCount > 1 ? 0 : PROCESS_TREE_FORCE_AFTER_MS;
    // Only deducting forceAfterMs cannot constrain slow CIM; waiter will restart after force bottoms out at 0.
    // Get taskkill + exit grace. Windows must fix the same absolute deadline from the cleanup starting point,
    // And through snapshot, EOF and waiter, it can stably fall within the Host 3.5s service phase.
    const windowsCleanupDeadlineAtMs =
      process.platform === "win32"
        ? cleanupStartedAtMs +
          forceBudgetMs +
          PROCESS_TREE_WINDOWS_TASKKILL_TIMEOUT_MS +
          PROCESS_TREE_WINDOWS_EXIT_OBSERVATION_GRACE_MS
        : undefined;
    this.cleanupProcessTreeSnapshot ??= await this.captureCleanupSnapshot(
      windowsCleanupDeadlineAtMs,
    );
    const processTreeSnapshot = this.cleanupProcessTreeSnapshot;
    if (!this.hasChildExited()) {
      // The normal exit boundary for app-server --stdio is stdin EOF. direct taskkill
      // The process tree not only skips the shutdown of the agent itself, but also allows the host to wait for the forced kill window.
      // Here, the protocol entry is first requested to end naturally; if there is no response for a short period of time, then the process tree is entered, and it is still guaranteed that no child processes remain.
      this.requestStdioClose();
      // The coverage CLI bundle is uncompressed and comes with a complete source map, and the startup/finishing is significantly slower than the release package.
      // The additional write disk grace will continue to be retained under coverage; the 1500ms exit deadline of the CLI will be covered by the ordinary window.
      const configuredEofWaitMs =
        process.env.ZCODE_E2E_COVERAGE === "1"
          ? E2E_COVERAGE_STDIO_EOF_EXIT_WAIT_MS
          : STDIO_EOF_EXIT_WAIT_MS;
      const remainingCleanupMs =
        windowsCleanupDeadlineAtMs === undefined
          ? configuredEofWaitMs
          : Math.max(windowsCleanupDeadlineAtMs - Date.now(), 0);
      await this.waitForChildExit(Math.min(configuredEofWaitMs, remainingCleanupMs));
    }
    // When the app is closed, the host must wait for the SIGTERM/SIGKILL of the process tree to finish running;
    // Even if the root child has exited within the EOF window, descendants are reclaimed using the pre-saved snapshot.
    const terminationResult = await terminateProcessTreeAndWait(this.child, {
      ...(this.options?.ownedProcessGroupId
        ? { ownedProcessGroupId: this.options.ownedProcessGroupId }
        : {}),
      ...(this.options?.ownedProcessStartedAtMs
        ? {
            ownedProcessStartedAtMs: this.options.ownedProcessStartedAtMs,
            ownedProcessExitedAtMs: this.childExitedAtMs ?? Date.now(),
          }
        : {}),
      ...(processTreeSnapshot ? { snapshot: processTreeSnapshot } : {}),
      log: processTreeLogger,
      // The absolute deadline of Windows wait-based cleanup is force margin + taskkill upper limit + exit grace.
      // Control the upper limit of the command to 1s so that the complete cleanup still falls within 3.5s of the Host service phase.
      windowsTaskkillTimeoutMs: PROCESS_TREE_WINDOWS_TASKKILL_TIMEOUT_MS,
      ...(windowsCleanupDeadlineAtMs === undefined ? {} : { windowsCleanupDeadlineAtMs }),
      // If the previous cleanup report remains, the final retry of app quit cannot wait for completion.
      // graceful window; enter force directly to ensure that it still falls within the exit budget given by main to Host.
      forceAfterMs: Math.max(forceBudgetMs - (Date.now() - cleanupStartedAtMs), 0),
    });
    // After Windows taskkill has confirmed that the OS process has exited, Node's ChildProcess exit event
    // It may still be delivered one round later. waiter has checked PID survival and identity access control at the same time. If the lagging one is used again here,
    // Adding the root PID to exitCode/signalCode will falsely report successful recycling as residual and trigger invalid retries.
    const remainingPids = terminationResult.remainingPids;
    await this.stderrCollector.waitForDrain(
      windowsCleanupDeadlineAtMs === undefined
        ? undefined
        : Math.max(0, Math.min(EXIT_STDERR_DRAIN_MS, windowsCleanupDeadlineAtMs - Date.now())),
    );
    if (remainingPids.length > 0) {
      // Just write warning and treat cleanup as successful, which will cause the manager to release ownership immediately.
      // app quit cannot process the residue again. Here the residual is promoted to failure and the snapshot is retained for eventual retry.
      throw new Error(
        `runtime process tree cleanup incomplete; remaining pid=${[...new Set(remainingPids)].join(",")}`,
      );
    }
  }

  private readonly handleStdoutData = (chunk: Buffer | string): void => {
    if (this.closed) {
      return;
    }
    this.stdoutBuffer += typeof chunk === "string" ? chunk : this.stdoutDecoder.write(chunk);
    this.drainStdoutFrames();
  };

  private readonly handleStdoutEnd = (): void => {
    if (this.stdoutFlushed) {
      return;
    }
    this.stdoutFlushed = true;
    this.stdoutBuffer += this.stdoutDecoder.end();
    const trailing = this.stdoutBuffer;
    this.stdoutBuffer = "";
    if (trailing.length > 0 && !this.closed) {
      this.handleStdoutFrame(trailing);
    }
    this.fireClose({ reason: "stdout_closed" });
  };

  private drainStdoutFrames(): void {
    let newlineIndex = this.stdoutBuffer.indexOf("\n");
    while (newlineIndex >= 0) {
      const frame = this.stdoutBuffer.slice(0, newlineIndex);
      this.stdoutBuffer = this.stdoutBuffer.slice(newlineIndex + 1);
      this.handleStdoutFrame(frame);
      if (this.closed) {
        return;
      }
      newlineIndex = this.stdoutBuffer.indexOf("\n");
    }
  }

  private handleStdoutFrame(frame: string): void {
    const line = frame.endsWith("\r") ? frame.slice(0, -1) : frame;
    if (line.trim().length === 0) {
      return;
    }
    try {
      const parsed = zcodeProtocolMessageSchema.parse(JSON.parse(line));
      // Protocol frame distribution has synchronously queried the system process table, and telemetry/streaming peaks will be blocked.
      // Host event loop and leave the subagent panel with no output. During runtime, the data plane only does parsing and forwarding;
      // Full process tree queries remain strictly within dispose cleanup boundaries.
      this.messageEmitter.fire(parsed);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.fireClose({ reason: `protocol_parse_error: ${reason}` });
    }
  }

  private handleStreamError(stream: "stdin" | "stdout", error: Error): void {
    // After the remote WSL/SSH agent backs off for seconds, the host may still be writing unfinished protocol requests.
    // Node's stdin write callback will reject, but the underlying Socket will also trigger an additional error event; if there is no long-term monitoring,
    // zcode-server will crash directly due to unhandled EPIPE, and the UI can only see that the remote connection is disconnected rather than that the protocol request fails.
    // Here, the stream error is regarded as the transport being closed, preventing subsequent writes to the failed agent.
    this.fireClose({ reason: `${stream}_error: ${error.message}` });
  }

  private fireClose(event: ZCodeProtocolTransportClosedEvent): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.closeEmitter.fire(event);
  }

  private disposeReaders(): void {
    if (this.readersDisposed) {
      return;
    }
    this.readersDisposed = true;
    this.child.stdout.off("data", this.handleStdoutData);
    this.child.stdout.off("end", this.handleStdoutEnd);
    this.child.stdout.off("close", this.handleStdoutEnd);
    this.child.stdout.resume();
  }

  private disposeLocalResources(): void {
    this.disposeReaders();
    this.messageEmitter.dispose();
    this.closeEmitter.dispose();
  }

  private requestStdioClose(): void {
    if (this.child.stdin.destroyed || !this.child.stdin.writable) {
      return;
    }
    try {
      this.child.stdin.once("error", () => undefined);
      this.child.stdin.end();
    } catch {
      // The agent may exit exactly during disposeAndWait, and the EOF request fails when stdin is half closed;
      // Failure should not interrupt subsequent processes, otherwise closing the path may leave runtime residue.
    }
  }

  private waitForChildExit(timeoutMs: number): Promise<void> {
    if (this.hasChildExited()) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const settle = () => {
        if (settled) {
          return;
        }
        settled = true;
        if (timer) {
          clearTimeout(timer);
          timer = undefined;
        }
        this.child.off?.("exit", settle);
        resolve();
      };
      this.child.once("exit", settle);
      timer = setTimeout(settle, timeoutMs);
      timer.unref?.();
    });
  }

  private hasChildExited(): boolean {
    return this.child.exitCode !== null || this.child.signalCode !== null;
  }

  private async captureCleanupSnapshot(
    windowsCleanupDeadlineAtMs?: number,
  ): Promise<ProcessTreeSnapshot | undefined> {
    const childHadExited = this.hasChildExited();
    const liveTree = childHadExited
      ? undefined
      : await captureProcessTreeSnapshotAsync(this.child, {
          log: processTreeLogger,
          ...(windowsCleanupDeadlineAtMs === undefined ? {} : { windowsCleanupDeadlineAtMs }),
          ownedProcessStartedAtMs: this.options?.ownedProcessStartedAtMs,
          // root may exit during WMIC/CIM query. There is no exit time when the query starts,
          // The exit event record must be read after the same round of queries is completed to safely restore old descendants and exclude PID reuse.
          resolveOwnedProcessExitedAtMs: () => this.childExitedAtMs,
        });
    if (liveTree) {
      return liveTree;
    }
    if (process.platform === "win32" && !childHadExited && this.child.pid) {
      // When the query fails, the second query will no longer be appended serially; the descendants of root's normal exit during the query have been replaced by
      // captureProcessTreeSnapshotAsync uses the same process table and root lifecycle recovery. Must here
      // Explicitly leave "identity not verifiable", otherwise empty identities will be misinterpreted as the process tree has exited.
      return {
        rootPid: this.child.pid,
        descendantPids: [],
        identities: [],
        identityVerification: "unavailable",
      };
    }
    const processGroupId = this.options?.ownedProcessGroupId;
    if (processGroupId) {
      return captureProcessGroupSnapshot(processGroupId);
    }
    const exitedTree = await captureExitedRootDescendantsSnapshotAsync(this.child.pid ?? 0, {
      log: processTreeLogger,
      ...(windowsCleanupDeadlineAtMs === undefined ? {} : { windowsCleanupDeadlineAtMs }),
      ownedProcessStartedAtMs: this.options?.ownedProcessStartedAtMs,
      ownedProcessExitedAtMs: this.childExitedAtMs ?? Date.now(),
    });
    if (exitedTree) {
      return exitedTree;
    }
    // After a Windows asynchronous CIM query fails, it cannot be checked again immediately within terminateAndWait.
    // Otherwise, the two query timeouts will stack up in series and fill Main's exit budget. Non-verifiable snapshots will continue to be observed
    // Original ChildProcess, and explicitly reports residuals after timeout, but never signals unvalidated reuse PIDs.
    return process.platform === "win32" && this.child.pid
      ? {
          rootPid: this.child.pid,
          descendantPids: [],
          identities: [],
          identityVerification: "unavailable",
        }
      : undefined;
  }
}
