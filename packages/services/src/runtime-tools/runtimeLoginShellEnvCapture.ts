import { execFileSync, spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { prependPathEntries } from "./runtimeToolResolver.js";

const LOGIN_ENV_CAPTURE_PREFIX = "__ZCODE_LOGIN_ENV_START__";
const LOGIN_ENV_CAPTURE_SUFFIX = "__ZCODE_LOGIN_ENV_END__";
const DEFAULT_POSIX_BOOTSTRAP_PATH =
  process.platform === "darwin"
    ? "/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"
    : "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";

let cachedLoginShellEnvSnapshot: Record<string, string> | null | undefined;

interface LoginShellExecutionOptions {
  encoding: "utf8";
  windowsHide: boolean;
  timeout: number;
  maxBuffer: number;
  env: NodeJS.ProcessEnv;
  signal?: AbortSignal;
}

export type LoginShellExecutor = (
  shellPath: string,
  shellArgs: string[],
  options: LoginShellExecutionOptions,
) => Promise<string>;

function isExecutableFile(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function resolveShellPathForLoginEnv(baseEnv: NodeJS.ProcessEnv): string | null {
  const candidates = [baseEnv.SHELL, "/bin/zsh", "/bin/bash", "/bin/sh"];
  for (const candidate of candidates) {
    if (candidate && isExecutableFile(candidate)) {
      return candidate;
    }
  }
  return null;
}

export function buildShellBootstrapPath(currentPath: string | undefined): string {
  return prependPathEntries(currentPath, DEFAULT_POSIX_BOOTSTRAP_PATH.split(":"));
}

function buildLoginShellArgs(shellPath: string): string[] {
  const command = `printf '%s\\0' '${LOGIN_ENV_CAPTURE_PREFIX}'; env -0; printf '%s\\0' '${LOGIN_ENV_CAPTURE_SUFFIX}'`;
  return shellPath.endsWith("/zsh") || shellPath.endsWith("/bash")
    ? ["-ilc", command]
    : ["-lc", command];
}

function buildLoginShellExecutionOptions(baseEnv: NodeJS.ProcessEnv): LoginShellExecutionOptions {
  return {
    encoding: "utf8",
    windowsHide: true,
    timeout: 4_000,
    maxBuffer: 2 * 1024 * 1024,
    env: {
      ...baseEnv,
      // The PATH of the GUI/remote service process is often not initialized by the login shell.
      // Give the probing shell a minimum system PATH, and then let the profile play back the user's own command path.
      PATH: buildShellBootstrapPath(baseEnv.PATH),
      TERM: "dumb",
      CI: "1",
    },
  };
}

function killLoginShellProcessTree(child: ChildProcess): void {
  if (process.platform !== "win32" && child.pid) {
    try {
      process.kill(-child.pid, "SIGKILL");
      return;
    } catch {
      // The process may have exited before close; continue trying to kill directly to avoid leaving collection descendants.
    }
  }
  try {
    child.kill("SIGKILL");
  } catch {
    // Timeout and natural exit may compete, and no additional processing is required when the process no longer exists.
  }
}

const executeLoginShell: LoginShellExecutor = (shellPath, shellArgs, options) =>
  new Promise((resolve, reject) => {
    const child = spawn(shellPath, shellArgs, {
      env: options.env,
      windowsHide: options.windowsHide,
      stdio: ["ignore", "pipe", "pipe"],
      // login profile may start descendant processes that inherit stdout/stderr; only kill shell will
      // execFile waits for pipe close. Only independent process groups under POSIX can completely terminate the collection tree at the deadline.
      detached: process.platform !== "win32",
    });
    let stdout = "";
    let outputBytes = 0;
    let settled = false;

    const killProcessTree = () => {
      killLoginShellProcessTree(child);
      child.stdout.destroy();
      child.stderr.destroy();
    };
    const handleAbort = () => {
      killProcessTree();
      settle(new Error(`login shell environment capture timed out after ${options.timeout}ms`));
    };
    const settle = (error?: Error) => {
      if (settled) return;
      settled = true;
      options.signal?.removeEventListener("abort", handleAbort);
      if (error) reject(error);
      else resolve(stdout);
    };
    const appendOutput = (chunk: Buffer | string, includeInStdout: boolean) => {
      const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      outputBytes += Buffer.byteLength(text);
      if (outputBytes > options.maxBuffer) {
        killProcessTree();
        settle(new Error(`login shell environment capture exceeded ${options.maxBuffer} bytes`));
      } else if (includeInStdout) {
        stdout += text;
      }
    };

    child.stdout.on("data", (chunk: Buffer | string) => appendOutput(chunk, true));
    child.stderr.on("data", (chunk: Buffer | string) => appendOutput(chunk, false));
    child.once("error", (error) => settle(error));
    child.once("close", (code, signal) => {
      if (code === 0) settle();
      else {
        settle(
          new Error(
            `login shell environment capture exited with code ${code ?? "null"}, signal ${signal ?? "none"}`,
          ),
        );
      }
    });
    options.signal?.addEventListener("abort", handleAbort, { once: true });
    if (options.signal?.aborted) handleAbort();
  });

function extractCapturedEnvSnapshot(rawOutput: string): Record<string, string> | null {
  const startMarker = `${LOGIN_ENV_CAPTURE_PREFIX}\0`;
  const endMarker = `${LOGIN_ENV_CAPTURE_SUFFIX}\0`;
  const startIndex = rawOutput.lastIndexOf(startMarker);
  const endIndex = rawOutput.lastIndexOf(endMarker);
  if (startIndex < 0 || endIndex <= startIndex) return null;
  return parseNullSeparatedEnvSnapshot(rawOutput.slice(startIndex + startMarker.length, endIndex));
}

function parseNullSeparatedEnvSnapshot(rawOutput: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const entry of rawOutput.split("\0")) {
    if (!entry) continue;
    const separatorIndex = entry.indexOf("=");
    if (separatorIndex <= 0) continue;
    const key = entry.slice(0, separatorIndex).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    result[key] = entry.slice(separatorIndex + 1);
  }
  return result;
}

export async function captureLoginShellEnvSnapshot(
  options: {
    baseEnv?: NodeJS.ProcessEnv;
    platform?: NodeJS.Platform;
    shellPath?: string | null;
    executeShell?: LoginShellExecutor;
    timeoutMs?: number;
  } = {},
): Promise<Record<string, string> | null> {
  const baseEnv = options.baseEnv ?? process.env;
  const platform = options.platform ?? process.platform;
  if (platform === "win32" || baseEnv.VITEST) return null;

  const shellPath =
    options.shellPath === undefined ? resolveShellPathForLoginEnv(baseEnv) : options.shellPath;
  if (!shellPath) return null;

  const timeoutMs = options.timeoutMs ?? 4_000;
  const abortController = new AbortController();
  let deadlineTimer: ReturnType<typeof setTimeout> | null = null;
  try {
    const executionPromise = (options.executeShell ?? executeLoginShell)(
      shellPath,
      buildLoginShellArgs(shellPath),
      {
        ...buildLoginShellExecutionOptions(baseEnv),
        timeout: timeoutMs,
        signal: abortController.signal,
      },
    );
    // Node's execFile's timeout will still wait for all descendants inheriting pipe to close.
    // The outer deadline independent settlement API; the default executor kills the entire POSIX process group through AbortSignal at the same time.
    const deadlinePromise = new Promise<never>((_resolve, reject) => {
      deadlineTimer = setTimeout(() => {
        abortController.abort();
        reject(new Error(`login shell environment capture timed out after ${timeoutMs}ms`));
      }, timeoutMs);
    });
    const output = await Promise.race([executionPromise, deadlinePromise]);
    return extractCapturedEnvSnapshot(output);
  } catch {
    return null;
  } finally {
    if (deadlineTimer) clearTimeout(deadlineTimer);
  }
}

export function captureLoginShellEnvSnapshotSync(
  baseEnv: NodeJS.ProcessEnv,
): Record<string, string> | null {
  if (cachedLoginShellEnvSnapshot !== undefined) return cachedLoginShellEnvSnapshot;
  if (process.platform === "win32" || process.env.VITEST) {
    cachedLoginShellEnvSnapshot = null;
    return cachedLoginShellEnvSnapshot;
  }

  const shellPath = resolveShellPathForLoginEnv(baseEnv);
  if (!shellPath) {
    cachedLoginShellEnvSnapshot = null;
    return cachedLoginShellEnvSnapshot;
  }
  try {
    // Compatible with non-Desktop synchronous createLocalServices entry. Even if fallback compatibility is used here, a complete snapshot will only be collected once.
    const output = execFileSync(
      shellPath,
      buildLoginShellArgs(shellPath),
      buildLoginShellExecutionOptions(baseEnv),
    );
    cachedLoginShellEnvSnapshot = extractCapturedEnvSnapshot(output);
  } catch {
    cachedLoginShellEnvSnapshot = null;
  }
  return cachedLoginShellEnvSnapshot;
}
