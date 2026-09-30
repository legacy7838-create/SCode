type HostStructuredLogLevel = "info" | "warn" | "error";

interface HostStructuredLog {
  level: HostStructuredLogLevel;
  source: string;
  message: string;
}

interface HostLogger {
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
}

interface RawStreamLog {
  kind: "stdout" | "stderr";
  message: string;
}

interface EmitStructuredLogEntry extends HostStructuredLog {
  timestamp: string;
}

/**
 * The host now reports logs through both stdout/stderr and postMessage.
 * If main wrote both to disk immediately, the same log line would appear twice.
 * The structured postMessage is trusted first; the early-buffered stdout/stderr is replayed as a
 * fallback log only when the host never emitted a single structured log before exiting.
 */
export function createHostLogRelay(
  label: string,
  logger: HostLogger,
  emitStructuredLogToRenderer?: (entry: EmitStructuredLogEntry) => void,
) {
  let hasStructuredLog = false;
  const rawLogs: RawStreamLog[] = [];

  function emitRawLog(rawLog: RawStreamLog): void {
    if (rawLog.kind === "stderr") {
      if (isNodeWarning(rawLog.message)) {
        logger.warn(`[host-stderr] (${label}):`, formatNodeWarning(rawLog.message));
        return;
      }

      logger.error(`[host-stderr] (${label}):`, rawLog.message);
      return;
    }

    logger.info(`[host-stdout] (${label}):`, rawLog.message);
  }

  function emitStructuredLog(entry: EmitStructuredLogEntry): void {
    const line = `[host-log] (${label}) [${entry.source}] ${entry.message}`;
    if (entry.level === "error") {
      logger.error(line);
      return;
    }

    if (entry.level === "warn") {
      logger.warn(line);
      return;
    }

    logger.info(line);
  }

  return {
    onStdout(message: string): void {
      if (hasStructuredLog) {
        return;
      }

      rawLogs.push({ kind: "stdout", message });
    },

    onStderr(message: string): void {
      if (hasStructuredLog) {
        return;
      }

      rawLogs.push({ kind: "stderr", message });
    },

    onStructuredLog(entry: HostStructuredLog): void {
      hasStructuredLog = true;
      rawLogs.length = 0;
      const structuredEntry = {
        ...entry,
        timestamp: new Date().toLocaleTimeString(undefined, {
          hour12: false,
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
        }),
      } satisfies EmitStructuredLogEntry;
      emitStructuredLog(structuredEntry);
      emitStructuredLogToRenderer?.(structuredEntry);
    },

    flushRawLogs(): void {
      if (hasStructuredLog) {
        rawLogs.length = 0;
        return;
      }

      for (const rawLog of rawLogs) {
        emitRawLog(rawLog);
      }
      rawLogs.length = 0;
    },
  };
}

function isNodeWarning(message: string): boolean {
  // An early Node warning will only appear on stderr when the Electron utility process starts.
  // This type of warning is not a connection failure. The warn semantics should be maintained during full playback to prevent the remote connection log from being mistakenly dyed as an error.
  return /^\(node:\d+\)\s+(?:ExperimentalWarning|DeprecationWarning|Warning):/u.test(
    message.trimStart(),
  );
}

function formatNodeWarning(message: string): string {
  // The second line of a Node warning is usually just the --trace-warnings prompt, which will look like error details when displayed on the link page.
  // The remote connection log only retains the first line of core warnings. For complete troubleshooting, you can develop startup parameters and then enable trace.
  return message.trimStart().split(/\r?\n/u)[0]?.trimEnd() ?? message.trim();
}
