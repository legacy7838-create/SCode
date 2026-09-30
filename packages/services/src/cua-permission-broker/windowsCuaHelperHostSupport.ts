import { fork as nodeFork, type ForkOptions } from "node:child_process";

import {
  mintBrokerSocketPath,
  probeHelperHealth,
  type HelperHealth,
} from "@zcode/zcode-cua/broker";
// Contract constants are single-sourced from the producer package: locally re-declared literals here had drifted risk — a rename in the
// producer would silently orphan these. Kept as aliases for existing callers.
import { HELPER_ADDON_ENV, WINDOWS_DEV_CONTROL_PROTOCOL } from "@zcode/zcode-cua/broker/server";

import type { ServiceLogger } from "#src/logger/serviceLogger.js";
import type { WindowsCuaRuntime } from "#src/cua-permission-broker/windowsCuaDevRuntime.js";

const CONTROL_PROTOCOL = WINDOWS_DEV_CONTROL_PROTOCOL;
export const ADDON_ENV = HELPER_ADDON_ENV;

export interface WindowsCuaChild {
  readonly pid?: number;
  send(message: unknown): boolean;
  kill(): boolean;
  on(event: "message" | "error" | "exit", listener: (...args: unknown[]) => void): this;
  off(event: "message" | "error" | "exit", listener: (...args: unknown[]) => void): this;
}

export interface WindowsCuaChildProcessAdapter {
  /** command is the runtime Node/Electron, argv[0] is the Helper entry. */
  fork(command: string, argv: string[], options: ForkOptions): WindowsCuaChild;
}

export interface WindowsCuaHelperHostOptions {
  runtime: WindowsCuaRuntime;
  childProcess?: WindowsCuaChildProcessAdapter;
  mintSocketPath?: () => string;
  mintPluginAuthority?: () => string;
  healthProbe?: (socketPath: string, timeoutMs: number) => Promise<HelperHealth>;
  startupTimeoutMs?: number;
  shutdownTimeoutMs?: number;
  logger?: ServiceLogger;
  /** Ready Helper notifies the life cycle owner after unexpected exit, and only triggers Helper recovery. */
  onUnexpectedExit?: (info: { generation: number; pid: number | undefined }) => void;
}

export interface Generation {
  id: number;
  child: WindowsCuaChild;
  socketPath: string;
  stopped: boolean;
  exitObserved: boolean;
  abort?: (error: Error) => void;
  terminationPromise?: Promise<void>;
  removeMainListeners(): void;
}

export const defaultChildProcess: WindowsCuaChildProcessAdapter = {
  fork(command, argv, options) {
    const [entryPath, ...args] = argv;
    if (!entryPath) throw new Error("Windows Computer Use Helper entry path is required");
    return nodeFork(entryPath, args, { ...options, execPath: command });
  },
};

export const defaultSocketPathFactory = mintBrokerSocketPath;
export const defaultHealthProbe = (socketPath: string, timeoutMs: number): Promise<HelperHealth> =>
  probeHelperHealth(socketPath, { timeoutMs });

export class WindowsCuaChildLifecycle {
  constructor(private readonly logger: ServiceLogger) {}

  async terminate(generation: Generation, context: string, timeoutMs: number): Promise<void> {
    if (generation.exitObserved) {
      generation.removeMainListeners();
      return;
    }
    // Hang wait listener first and then send shutdown/kill to avoid missing observations due to the process exiting in the same synchronization round of signal.
    const firstExit = this.waitForExit(generation, "first-wait", timeoutMs);
    this.sendShutdown(generation, context);
    if (await firstExit) {
      generation.removeMainListeners();
      return;
    }
    const secondExit = this.waitForExit(generation, "second-wait", timeoutMs);
    this.kill(generation, context);
    if (await secondExit) {
      generation.removeMainListeners();
      return;
    }
    const blocker = new Error(
      "Windows Computer Use Helper termination blocker: child did not exit after kill",
    );
    this.logFailure(generation.id, generation.child.pid, `${context}-termination-blocker`, blocker);
    throw blocker;
  }

  sendShutdown(generation: Generation, context: string): void {
    try {
      generation.child.send({ protocol: CONTROL_PROTOCOL, type: "shutdown" });
    } catch (error) {
      this.logFailure(generation.id, generation.child.pid, `${context}-send`, error);
    }
  }

  kill(generation: Generation, context: string): void {
    try {
      generation.child.kill();
    } catch (error) {
      this.logFailure(generation.id, generation.child.pid, `${context}-kill`, error);
    }
  }

  on(
    child: WindowsCuaChild,
    event: "message" | "error" | "exit",
    listener: (...args: unknown[]) => void,
    generation: number,
    errorClass: string,
  ): boolean {
    try {
      child.on(event, listener);
      return true;
    } catch (error) {
      this.logFailure(generation, child.pid, errorClass, error);
      return false;
    }
  }

  off(
    child: WindowsCuaChild,
    event: "message" | "error" | "exit",
    listener: (...args: unknown[]) => void,
    generation: number,
    errorClass: string,
  ): void {
    try {
      child.off(event, listener);
    } catch (error) {
      this.logFailure(generation, child.pid, errorClass, error);
    }
  }

  logFailure(
    generation: number,
    pid: number | undefined,
    errorClass: string,
    error: unknown,
  ): void {
    this.logger.warn(undefined, "Windows Computer Use Helper lifecycle failure", {
      generation,
      pid,
      errorClass,
      error: error instanceof Error ? error.name : typeof error,
    });
  }

  private waitForExit(
    generation: Generation,
    errorClass: string,
    timeoutMs: number,
  ): Promise<boolean> {
    if (generation.exitObserved) return Promise.resolve(true);
    return new Promise((resolve) => {
      let done = false;
      const finish = (exited: boolean) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        this.off(generation.child, "exit", onExit, generation.id, `${errorClass}-off`);
        resolve(exited);
      };
      const onExit = () => {
        generation.exitObserved = true;
        finish(true);
      };
      const timer = setTimeout(() => finish(false), timeoutMs);
      timer.unref?.();
      if (!this.on(generation.child, "exit", onExit, generation.id, `${errorClass}-on`))
        finish(false);
      // After send(), before the temporary listener is registered, the child may have triggered the main exit listener; read again
      // generation fact to avoid mistaking exiting H1 as a timeout and leaving a non-existent termination blocker.
      else if (generation.exitObserved) finish(true);
    });
  }
}

type WindowsDevHelperControlMessage =
  | { protocol: typeof CONTROL_PROTOCOL; type: "transport_ready"; socketPath: string; pid: number }
  | { protocol: typeof CONTROL_PROTOCOL; type: "ready"; socketPath: string; pid: number }
  | { protocol: typeof CONTROL_PROTOCOL; type: "error"; message: string };

/**
 * Parse a `zcode-cua-windows-dev/v1` control message from the helper child.
 *
 * "transport_ready" means the named pipe is bound and authenticated, while
 * "ready" remains the full health handshake. "error" is the helper's OWN startup-failure
 * report (windowsDevHelperMain.ts sends `{protocol, type:"error", message}`
 * before exiting 1/2) — previously this fell through to null and the host
 * misclassified it as "Invalid Windows Computer Use Helper control message"
 * (malformed-message), discarding the diagnostic string.
 * Any future additive message type parses as "ignore" (forward-compatible)
 * instead of failing the generation.
 */
export function parseReadyMessage(
  message: unknown,
): WindowsDevHelperControlMessage | "ignore" | null {
  if (!message || typeof message !== "object") return null;
  const value = message as Record<string, unknown>;
  if (value.protocol !== CONTROL_PROTOCOL) return "ignore";
  if (value.type === "error") {
    if (typeof value.message !== "string" || value.message.length === 0) {
      return null;
    }
    return { protocol: CONTROL_PROTOCOL, type: "error", message: value.message };
  }
  if (value.type !== "ready" && value.type !== "transport_ready") return "ignore";
  if (
    typeof value.socketPath !== "string" ||
    !value.socketPath ||
    !Number.isInteger(value.pid) ||
    (value.pid as number) <= 0
  )
    return null;
  return {
    protocol: CONTROL_PROTOCOL,
    type: value.type,
    socketPath: value.socketPath,
    pid: value.pid as number,
  };
}

export function isExactHealthPid(
  health: HelperHealth,
  childPid: number | undefined,
): health is HelperHealth & { pid: number } {
  return Number.isInteger(health.pid) && (health.pid as number) > 0 && health.pid === childPid;
}

export function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
