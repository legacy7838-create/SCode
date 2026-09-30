const processGuardInstalled = new WeakSet<object>();
const OUTPUT_CLOSED_ERROR_CODES = new Set([
  "EPIPE",
  "EIO",
  "ENXIO",
  "EBADF",
  "ERR_STREAM_DESTROYED",
]);

/**
 * Synchronous errors of a REPL cell are caught by NodeReplSession, but fire-and-forget
 * asynchronous errors (an un-awaited tab.* call being rejected when a turn is interrupted)
 * punch through the whole server process under Node's default policy. Once the child dies,
 * Browser Use is unavailable in that session ever after. Here asynchronous errors are degraded
 * to stderr log lines: the runtime state is preserved and the protocol's stdout is unaffected.
 *
 * After the parent process exits, stderr reports EPIPE. The old handler wrote the EPIPE stack
 * back to that same stderr, forming an endless EPIPE -> uncaughtException -> stderr.write ->
 * EPIPE loop. A closed output pipe means the MCP client is unreachable, so shutdown must be
 * entered directly and diagnostics must not keep being written.
 */
export function installNodeReplProcessGuards(input: {
  onOutputClosed: (error: Error) => void;
  process: Pick<NodeJS.Process, "on">;
  writeStderr: (text: string) => void;
}): void {
  if (processGuardInstalled.has(input.process)) return;
  processGuardInstalled.add(input.process);

  let outputClosed = false;
  const describe = (reason: unknown): string =>
    reason instanceof Error ? (reason.stack ?? reason.message) : String(reason);
  const report = (kind: "uncaughtException" | "unhandledRejection", reason: unknown): void => {
    if (outputClosed) return;
    if (isOutputClosedError(reason)) {
      outputClosed = true;
      input.onOutputClosed(reason);
      return;
    }

    try {
      input.writeStderr(`node_repl ${kind} (process kept alive): ${describe(reason)}\n`);
    } catch (error) {
      if (!isOutputClosedError(error)) throw error;
      outputClosed = true;
      input.onOutputClosed(error);
    }
  };
  input.process.on("unhandledRejection", (reason) => {
    report("unhandledRejection", reason);
  });
  input.process.on("uncaughtException", (error) => {
    report("uncaughtException", error);
  });
}

function isOutputClosedError(error: unknown): error is Error {
  if (!(error instanceof Error)) return false;
  const code = (error as NodeJS.ErrnoException).code;
  return typeof code === "string" && OUTPUT_CLOSED_ERROR_CODES.has(code);
}

export function installNodeReplShutdownTriggers(input: {
  process: Pick<NodeJS.Process, "once">;
  shutdown: () => void;
  stdin: Pick<NodeJS.ReadStream, "once">;
}): void {
  let shutdownStarted = false;
  const shutdownOnce = () => {
    if (shutdownStarted) return;
    shutdownStarted = true;
    input.shutdown();
  };

  // MCP SDK's stdio transport does not listen to stdin end/close. runtime when the parent process exits abnormally
  // Therefore, it does not receive the end of its life cycle and becomes an orphan process.
  input.stdin.once("end", shutdownOnce);
  input.stdin.once("close", shutdownOnce);
  input.process.once("SIGINT", shutdownOnce);
  input.process.once("SIGTERM", shutdownOnce);
}

export async function isDirectMcpEntrypoint(
  importMetaUrl: string,
  argvPath: string | undefined,
): Promise<boolean> {
  if (!argvPath) return false;
  try {
    // macOS's /tmp, /var and other paths will be resolved to /private/...; directly comparing the file URL will make
    // The stdio subprocess was misjudged as "imported", main was not started and exited without error. Asynchronous realpath is also compatible with
    // symlink installation directory and avoid introducing synchronous file IO in the module evaluation path.
    const [modulePath, executablePath] = await Promise.all([
      realpath(fileURLToPath(importMetaUrl)),
      realpath(argvPath),
    ]);
    return modulePath === executablePath;
  } catch {
    return false;
  }
}
import { realpath } from "node:fs/promises";
import { fileURLToPath } from "node:url";
