import { formatLogPrefix } from "@zcode/shared";

export type LogLevel = "debug" | "info" | "warn" | "error";

type DesktopLogLevel = Exclude<LogLevel, "debug">;

type DesktopLogBridgeWindow = Window & {
  zcode?: {
    log?: (level: DesktopLogLevel, args: unknown[]) => void;
  };
};

function isRendererProductionBuild(): boolean {
  const viteProduction =
    ((import.meta as ImportMeta & { env?: { readonly PROD?: boolean } }).env ?? {}).PROD === true;
  // Vitest's import.meta.env.PROD is fixed at the transform stage; the NODE_ENV fallback allows the production branch
  // to be verified by unit tests; the actual renderer build still follows Vite's PROD flag.
  return (
    viteProduction || (typeof process !== "undefined" && process.env.NODE_ENV === "production")
  );
}

function isRendererLoggingDisabled(): boolean {
  return (
    (
      globalThis as typeof globalThis & {
        __ZCODE_RENDERER_DISABLE_LOGGING__?: boolean;
      }
    ).__ZCODE_RENDERER_DISABLE_LOGGING__ === true
  );
}

const consoleFns: Record<LogLevel, (...args: unknown[]) => void> = {
  debug: console.debug,
  info: console.log,
  warn: console.warn,
  error: console.error,
};

function isLoggerLevelEnabled(_level: LogLevel): boolean {
  // In production builds all renderer log levels are disabled; the guard is exposed so callers can exit before constructing heavy payloads.
  return !isRendererProductionBuild() && !isRendererLoggingDisabled();
}

function log(level: LogLevel, ...args: unknown[]) {
  // In production builds renderer logs are a direct no-op, avoiding console formatting, IPC forwarding, and disk writes that would slow the renderer main thread.
  if (!isLoggerLevelEnabled(level)) {
    return;
  }
  consoleFns[level](formatLogPrefix("ui"), ...args);
  // When the ui package is type-checked alone, it doesn't have the window.zcode declaration injected by the desktop renderer,
  // and the Electron bridge only accepts info/warn/error; passing debug through as-is would make both the type and host protocol inconsistent.
  // Here the bridge shape is explicitly narrowed, and only the levels actually supported by the main process are forwarded.
  if (level !== "debug" && typeof window !== "undefined") {
    // Pure frontend state modules like tabStore now also emit info logs in Vitest's Node environment.
    // If window is accessed unconditionally here, tests would throw a ReferenceError as soon as a log is triggered,
    // resulting in "introducing new test noise to troubleshoot a problem". Confirm the browser environment first, then use the desktop bridge.
    (window as DesktopLogBridgeWindow).zcode?.log?.(level, args);
  }
}

function lifecycleLog(level: DesktopLogLevel, ...args: unknown[]) {
  // Production builds by default only keep filtered lifecycle diagnostics, avoiding reopening message stream logs.
  // Tests and fault injection can still disable all renderer logs via an explicit global switch.
  if (isRendererLoggingDisabled()) {
    return;
  }
  if (isRendererProductionBuild()) {
    if (typeof window !== "undefined") {
      (window as DesktopLogBridgeWindow).zcode?.log?.(level, args);
    }
    return;
  }
  log(level, ...args);
}

export const logger = {
  debug: (...args: unknown[]) => log("debug", ...args),
  info: (...args: unknown[]) => log("info", ...args),
  warn: (...args: unknown[]) => log("warn", ...args),
  error: (...args: unknown[]) => log("error", ...args),
  lifecycle: {
    info: (...args: unknown[]) => lifecycleLog("info", ...args),
    warn: (...args: unknown[]) => lifecycleLog("warn", ...args),
    error: (...args: unknown[]) => lifecycleLog("error", ...args),
  },
  /** A log line prefixed with a traceId, for end-to-end tracing */
  trace: (traceId: string, level: LogLevel, ...args: unknown[]) => {
    log(level, `[trace:${traceId}]`, ...args);
  },
};

/**
 * The renderer's only outlet for in-process local diagnostic logs. It is the “official monitoring
 * channel” exception in the renderer's production logging policy: production builds still persist
 * through the desktop bridge (at most one line every 60s, written only when something changed) and
 * it is a no-op on the web side where there is no bridge. Feature modules must not borrow it to
 * bypass the production gate.
 */
export function logMemoryDiagnostics(line: string): void {
  if (isRendererLoggingDisabled()) {
    return;
  }
  if (typeof window !== "undefined") {
    const bridge = (window as DesktopLogBridgeWindow).zcode?.log;
    if (bridge) {
      bridge("info", [line]);
      return;
    }
  }
  if (!isRendererProductionBuild()) {
    consoleFns.info(formatLogPrefix("ui"), line);
  }
}
