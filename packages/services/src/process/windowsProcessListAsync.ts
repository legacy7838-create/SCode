import { execFile } from "node:child_process";
import type {
  ProcessIdentity,
  ProcessTreeTerminatorOptions,
} from "#src/process/processTreeTypes.js";

const WINDOWS_PROCESS_LOOKUP_TIMEOUT_MS = 2_500;
const DOTNET_UNIX_EPOCH_TICKS = 621_355_968_000_000_000n;
const TICKS_PER_MICROSECOND = 10n;
const WINDOWS_START_TIME_PREFIX = "windows-utc-us:";

type WindowsCimCapability = "cim" | "identity-unavailable";

interface WindowsProcessListFlight {
  promise: Promise<readonly ProcessIdentity[]>;
  startedAtMs: number;
}

let windowsProcessListInFlight: WindowsProcessListFlight | undefined;
let windowsCimCapability: WindowsCimCapability | undefined;

function isHardCimUnavailable(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === "ENOENT" || code === "EACCES" || code === "EPERM";
}

function remainingWindowsCleanupMs(options: ProcessTreeTerminatorOptions): number | undefined {
  return options.windowsCleanupDeadlineAtMs === undefined
    ? undefined
    : Math.max(options.windowsCleanupDeadlineAtMs - Date.now(), 0);
}

function boundedWindowsLookupTimeoutMs(
  defaultTimeoutMs: number,
  options: ProcessTreeTerminatorOptions,
): number {
  const remainingMs = remainingWindowsCleanupMs(options);
  return remainingMs === undefined
    ? defaultTimeoutMs
    : Math.max(Math.min(defaultTimeoutMs, remainingMs), 0);
}

async function awaitWindowsProcessListWithinDeadline(
  request: Promise<readonly ProcessIdentity[]>,
  options: ProcessTreeTerminatorOptions,
): Promise<readonly ProcessIdentity[]> {
  const remainingMs = remainingWindowsCleanupMs(options);
  if (remainingMs === undefined) return await request;
  if (remainingMs <= 0) return [];

  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      request,
      new Promise<readonly ProcessIdentity[]>((resolve) => {
        deadlineTimer = setTimeout(() => resolve([]), remainingMs);
      }),
    ]);
  } finally {
    if (deadlineTimer) clearTimeout(deadlineTimer);
  }
}

function warn(options: ProcessTreeTerminatorOptions, message: string, ...args: unknown[]): void {
  options.log?.warn(options.traceId, message, ...args);
}

function parsePositiveInteger(value: string | undefined): number | undefined {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function parseNonNegativeInteger(value: string | undefined): number | undefined {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

function parseWindowsProcessList(stdout: string): ProcessIdentity[] {
  const identities: ProcessIdentity[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const [pidText, parentPidText, rawStartTime] = line.trim().split(/\s+/);
    const pid = parsePositiveInteger(pidText);
    const parentPid = parseNonNegativeInteger(parentPidText);
    const startTime = normalizePowerShellStartTime(rawStartTime);
    if (pid === undefined || parentPid === undefined || !startTime) continue;
    identities.push({ parentPid, pid, startTime });
  }
  return identities;
}

function normalizePowerShellStartTime(rawStartTime: string | undefined): string | undefined {
  if (!rawStartTime) return undefined;
  try {
    const unixMicroseconds =
      (BigInt(rawStartTime) - DOTNET_UNIX_EPOCH_TICKS) / TICKS_PER_MICROSECOND;
    return `${WINDOWS_START_TIME_PREFIX}${unixMicroseconds}`;
  } catch {
    return undefined;
  }
}

export async function verifyWindowsProcessIdentityAsync(
  identity: ProcessIdentity,
  timeoutMs: number,
  options: ProcessTreeTerminatorOptions = {},
): Promise<boolean> {
  if (process.platform !== "win32" || timeoutMs <= 0) return false;
  if (windowsCimCapability === "identity-unavailable") return false;
  // Windows 11 24H2 and some Win10 images no longer provide WMIC; Windows 10+ uses it uniformly
  // PowerShell/CIM, if the query fails, it will still be processed according to the CreationDate and cannot be confirmed. It is forbidden to bypass the identity verification and kill.
  return await new Promise<boolean>((resolve) => {
    execFile(
      "powershell.exe",
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `Get-CimInstance Win32_Process -Filter "ProcessId = ${identity.pid}" | ForEach-Object { '{0} {1} {2}' -f $_.ProcessId, $_.ParentProcessId, $_.CreationDate.ToUniversalTime().Ticks }`,
      ],
      {
        encoding: "utf8",
        timeout: timeoutMs,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (error || !stdout) {
          if (isHardCimUnavailable(error)) windowsCimCapability = "identity-unavailable";
          warn(
            options,
            `Windows root identity PowerShell recheck failed pid=${identity.pid}:`,
            error ?? stderr,
          );
          resolve(false);
          return;
        }
        const current = parseWindowsProcessList(stdout).find(
          (processIdentity) => processIdentity.pid === identity.pid,
        );
        windowsCimCapability = "cim";
        resolve(current?.startTime === identity.startTime);
      },
    );
  });
}

export async function readWindowsProcessListAsync(
  options: ProcessTreeTerminatorOptions,
): Promise<readonly ProcessIdentity[]> {
  if (windowsCimCapability === "identity-unavailable") return [];
  const ownedProcessStartedAtMs = options.ownedProcessStartedAtMs;
  if (
    windowsProcessListInFlight &&
    (ownedProcessStartedAtMs === undefined ||
      ownedProcessStartedAtMs < windowsProcessListInFlight.startedAtMs)
  ) {
    return await awaitWindowsProcessListWithinDeadline(windowsProcessListInFlight.promise, options);
  }

  // Get-CimInstance takes more than 1 second on some Windows machines. Synchronous waiting will block the Host
  // exit deadline; after sharing the same asynchronous query, multiple workspaces can reuse the system process table once.
  // The old shared Promise may start earlier than the spawn of the new Agent, and it will definitely not be found when reusing this process table.
  // new root and degenerate to unverified. Only queries started strictly later than root are eligible for reuse.
  const startedAtMs = Date.now();
  const request = new Promise<readonly ProcessIdentity[]>((resolve) => {
    // After removing WMIC, use the supported CIM backend directly to avoid ENOENT fallback consuming cleanup
    // deadline; if the query fails, an empty identity is returned, and the caller continues to observe the exit along the fail-closed path.
    const timeoutMs = boundedWindowsLookupTimeoutMs(WINDOWS_PROCESS_LOOKUP_TIMEOUT_MS, options);
    if (timeoutMs <= 0) {
      resolve([]);
      return;
    }

    execFile(
      "powershell.exe",
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "Get-CimInstance Win32_Process | ForEach-Object { '{0} {1} {2}' -f $_.ProcessId, $_.ParentProcessId, $_.CreationDate.ToUniversalTime().Ticks }",
      ],
      {
        encoding: "utf8",
        timeout: timeoutMs,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (error || !stdout) {
          if (isHardCimUnavailable(error)) windowsCimCapability = "identity-unavailable";
          warn(
            options,
            "failed to query the Windows runtime process table (async):",
            error ?? stderr,
          );
          resolve([]);
          return;
        }
        const identities = parseWindowsProcessList(stdout);
        if (identities.length === 0)
          warn(options, "PowerShell returned no parsable Windows runtime process table");
        if (identities.length > 0) windowsCimCapability = "cim";
        resolve(identities);
      },
    );
  }).finally(() => {
    if (windowsProcessListInFlight?.promise === request) windowsProcessListInFlight = undefined;
  });
  windowsProcessListInFlight = { promise: request, startedAtMs };
  return await awaitWindowsProcessListWithinDeadline(request, options);
}
