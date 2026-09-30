import { randomUUID } from "node:crypto";
import {
  ZCODE_PROCESS_DIAGNOSTIC_PREFIX,
  ZCODE_PROCESS_DIAGNOSTIC_NAME_MAX_CHARS,
  ZCODE_PROCESS_DIAGNOSTIC_MESSAGE_MAX_CHARS,
  ZCODE_PROCESS_DIAGNOSTIC_STACK_MAX_CHARS,
  type ZCodeProcessDiagnostic,
} from "@zcode/shared/process-diagnostic";

interface CliProcessErrorBoundaryTarget {
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  off(event: string, listener: (...args: unknown[]) => void): unknown;
}

interface CliProcessErrorBoundaryOptions {
  onFatal: (reason: unknown) => void;
  target?: CliProcessErrorBoundaryTarget;
  stderr?: {
    write(chunk: string): unknown;
  };
}

interface MonitoredException {
  error: unknown;
  origin: string;
}

/**
 * Install the last process-level exception boundary for the protocol-style CLI.
 *
 * Preserve one diagnostic first, then hand off to the entry lifecycle for a bounded
 * shutdown. An unknown exception must not keep the process alive and accepting work, and its
 * write failure on a broken stderr must not be reported recursively; the caller must have
 * installed the stderr output boundary first.
 */
export function installCliProcessErrorBoundary(
  options: CliProcessErrorBoundaryOptions,
): () => void {
  const target = options.target ?? (process as unknown as CliProcessErrorBoundaryTarget);
  const stderr = options.stderr ?? process.stderr;
  let monitoredException: MonitoredException | undefined;
  let fatal = false;
  const reportFatal = (
    kind: "uncaughtException" | "unhandledRejection",
    origin: string,
    reason: unknown,
  ) => {
    if (fatal) return;
    fatal = true;
    writeProcessErrorDiagnostic(stderr, kind, origin, reason);
    options.onFatal(reason);
  };

  const onUncaughtExceptionMonitor = (error: unknown, origin: unknown): void => {
    monitoredException = {
      error,
      origin: typeof origin === "string" ? origin : "uncaughtException",
    };
  };
  const onUncaughtException = (error: unknown): void => {
    const matchingMonitor = monitoredException?.error === error ? monitoredException : undefined;
    const origin = matchingMonitor ? matchingMonitor.origin : "uncaughtException";
    monitoredException = undefined;
    // Node strict mode first triggers uncaughtException, and then triggers unhandledRejection after processing.
    // Unified reporting by the rejection listener prevents the same Promise error from generating two different errorIds.
    if (origin === "unhandledRejection") return;
    reportFatal("uncaughtException", origin, error);
  };
  const onUnhandledRejection = (reason: unknown): void => {
    monitoredException = undefined;
    reportFatal("unhandledRejection", "unhandledRejection", reason);
  };

  target.on("uncaughtExceptionMonitor", onUncaughtExceptionMonitor);
  target.on("uncaughtException", onUncaughtException);
  target.on("unhandledRejection", onUnhandledRejection);

  return () => {
    target.off("uncaughtExceptionMonitor", onUncaughtExceptionMonitor);
    target.off("uncaughtException", onUncaughtException);
    target.off("unhandledRejection", onUnhandledRejection);
    monitoredException = undefined;
  };
}

function writeProcessErrorDiagnostic(
  stderr: { write(chunk: string): unknown },
  kind: "uncaughtException" | "unhandledRejection",
  origin: string,
  reason: unknown,
): void {
  try {
    const detail = formatProcessError(reason).slice(0, ZCODE_PROCESS_DIAGNOSTIC_STACK_MAX_CHARS);
    const diagnostic: ZCodeProcessDiagnostic = {
      version: 1,
      errorId: randomUUID(),
      kind,
      origin: origin === "unhandledRejection" ? origin : "uncaughtException",
      name: (reason instanceof Error ? reason.name || "Error" : "Error").slice(
        0,
        ZCODE_PROCESS_DIAGNOSTIC_NAME_MAX_CHARS,
      ),
      message: (reason instanceof Error ? reason.message : detail).slice(
        0,
        ZCODE_PROCESS_DIAGNOSTIC_MESSAGE_MAX_CHARS,
      ),
      ...(reason instanceof Error && reason.stack ? { stack: detail } : {}),
      occurredAt: Date.now(),
    };
    // Root cause: When the process is alive, the old stderr only enters debug, and the Electron SDK cannot catch child process exceptions.
    // Add a single line of structured events for immediate forwarding by the Host, retaining readable text for compatibility with old Hosts and crash tails.
    stderr.write(
      `${ZCODE_PROCESS_DIAGNOSTIC_PREFIX}${JSON.stringify(diagnostic)}\n[zcode] process error kind=${kind} origin=${origin}\n${detail}\n`,
    );
  } catch {
    // Diagnostic output cannot cross the process-level exception boundary again.
  }
}

function formatProcessError(reason: unknown): string {
  if (reason instanceof Error) {
    return reason.stack || `${reason.name}: ${reason.message}`;
  }
  if (typeof reason === "string") {
    return reason;
  }
  try {
    const serialized = JSON.stringify(reason);
    return serialized === undefined ? String(reason) : serialized;
  } catch {
    return String(reason);
  }
}
