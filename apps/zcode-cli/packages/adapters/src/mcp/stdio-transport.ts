import {
  StdioClientTransport,
  type StdioServerParameters,
} from "@modelcontextprotocol/client/stdio";
import type { JSONRPCMessage } from "@modelcontextprotocol/client";
import type { ChildProcess } from "node:child_process";
import { terminateMcpStdioProcessTree } from "./process-tree.js";
import {
  attachProcessToWindowsJobObject,
  type WindowsJobObjectController,
} from "./windows-job-object.js";

type SdkStdioDispose = (this: StdioClientTransport) => Promise<void>;

const sdkDispose = Object.getOwnPropertyDescriptor(StdioClientTransport.prototype, "_dispose")
  ?.value as SdkStdioDispose | undefined;

type StdioRequestMetaProvider = () => Promise<Record<string, unknown> | undefined>;

interface StdioProcessExitInfo {
  exitCode: number | null;
  exitedAt: number;
  signal: NodeJS.Signals | null;
  startedAt: number;
}

type ProcessTreeStdioServerParameters = StdioServerParameters & {
  /**
   * The per-message identity payload provider of the official stdio MCP. It is kept as a non-executed field of
   * the spawn arguments, ensuring that when the SDK clones a sibling transport for the modern probe,
   * `server/discover` and the real session use the same injection boundary.
   */
  requestMetaProvider?: StdioRequestMetaProvider;
};

interface ProcessTreeStdioClientTransportOptions {
  windowsJobObjectFactory?: (pid: number) => Promise<WindowsJobObjectController | undefined>;
}

/**
 * SDK 2.0 creates a one-shot sibling process for stdio version probing, but its private disposal hook only
 * terminates the direct child.
 * Descendants spawned by the launcher/watchdog therefore become orphans; in the same hook, reap the whole
 * process tree first, then let the SDK clean up the pipes and read buffers. The prototype must own `_dispose`
 * directly for the SDK to recognize this transport as a probe transport that is safe to clone.
 */
export class ProcessTreeStdioClientTransport extends StdioClientTransport {
  private childProcess?: ChildProcess;
  private lastProcessExit?: StdioProcessExitInfo;
  private readonly requestMetaProvider?: StdioRequestMetaProvider;
  private readonly windowsJobObjectFactory: (
    pid: number,
  ) => Promise<WindowsJobObjectController | undefined>;
  private windowsJobObject?: WindowsJobObjectController;

  constructor(
    server: ProcessTreeStdioServerParameters,
    options: ProcessTreeStdioClientTransportOptions = {},
  ) {
    super(server);
    this.requestMetaProvider = server.requestMetaProvider;
    this.windowsJobObjectFactory =
      options.windowsJobObjectFactory ?? attachProcessToWindowsJobObject;
  }

  async terminateWindowsJobObject(): Promise<void> {
    const windowsJobObject = this.windowsJobObject;
    this.windowsJobObject = undefined;
    if (!windowsJobObject) return;
    try {
      windowsJobObject.terminate();
    } catch {
      // Continue to execute close and taskkill to roll back.
    } finally {
      try {
        windowsJobObject.close();
      } catch {
        // Failure to close the handle cannot prevent SDK pipe cleanup.
      }
    }
  }

  override async send(message: JSONRPCMessage): Promise<void> {
    const requestMeta = await this.requestMetaProvider?.();
    await super.send(mergeRequestMeta(message, requestMeta));
  }

  override async start(): Promise<void> {
    const startedAt = Date.now();
    await super.start();
    const child = (this as unknown as { _process?: ChildProcess })._process;
    if (!child) return;
    this.childProcess = child;
    const recordExit = (exitCode: number | null, signal: NodeJS.Signals | null): void => {
      this.lastProcessExit ??= {
        exitCode,
        exitedAt: Date.now(),
        signal,
        startedAt,
      };
    };
    if (child.exitCode !== null || child.signalCode !== null) {
      recordExit(child.exitCode, child.signalCode);
      return;
    }
    child.once("exit", recordExit);

    // Staging once combined the Job Object takeover and exit observations into two start()s with the same name, resulting in CLI
    // The build directly reports Duplicate function implementation; here the two responsibilities are merged and Windows
    // Process tree hosting and cross-platform exit logging.
    if (process.platform !== "win32" || this.pid == null) return;
    try {
      this.windowsJobObject = await this.windowsJobObjectFactory(this.pid);
    } catch {
      // Keep the taskkill fallback when native hosting is unavailable, and do not allow MCP connection establishment to fail due to optional capabilities.
      this.windowsJobObject = undefined;
    }
  }

  get processExit(): StdioProcessExitInfo | undefined {
    return this.lastProcessExit;
  }

  get processAlive(): boolean {
    return Boolean(
      this.childProcess &&
      this.childProcess.exitCode === null &&
      this.childProcess.signalCode === null,
    );
  }
}

function mergeRequestMeta(
  message: JSONRPCMessage,
  requestMeta: Record<string, unknown> | undefined,
): JSONRPCMessage {
  // JSON-RPC response has no method, and forged params must not be given to the response. Only the requests and notifications sent by the client are modified.
  if (!("method" in message) || !requestMeta || Object.keys(requestMeta).length === 0) {
    return message;
  }
  const params = isRecord(message.params) ? message.params : {};
  const existingMeta = isRecord(params._meta) ? params._meta : {};
  return {
    ...message,
    params: {
      ...params,
      // The official identity payload just parsed by the host must overwrite the caller's residual value to prevent old credentials from continuing to survive.
      _meta: { ...existingMeta, ...requestMeta },
    },
  } as JSONRPCMessage;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

Object.defineProperty(ProcessTreeStdioClientTransport.prototype, "_dispose", {
  configurable: true,
  async value(this: ProcessTreeStdioClientTransport): Promise<void> {
    const pid = this.pid;
    await this.terminateWindowsJobObject();
    if (typeof pid === "number" && Number.isInteger(pid) && pid > 0) {
      try {
        await terminateMcpStdioProcessTree(pid);
      } catch {
        // The detection and recycling of the SDK is inherently best effort; the pipe still needs to be released to avoid the negotiation being permanently stuck.
      }
    }

    if (sdkDispose) {
      await sdkDispose.call(this);
      return;
    }
    await this.close();
  },
});
