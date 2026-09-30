import { spawnSync, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import type {
  ProcessIdentity,
  ProcessTreeSnapshot,
  ProcessTreeTerminatorOptions,
} from "#src/process/processTreeTypes.js";

const PROCESS_LOOKUP_TIMEOUT_MS = 1_000;
const DOTNET_UNIX_EPOCH_TICKS = 621_355_968_000_000_000n;
const TICKS_PER_MILLISECOND = 10_000n;

let windowsProcessListCache: readonly ProcessIdentity[] | undefined;

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

function parsePosixProcessList(stdout: string, includeCommand: boolean): ProcessIdentity[] {
  const identities: ProcessIdentity[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const fields = line.trim().split(/\s+/);
    const [pidText, parentPidText, processGroupIdText] = fields;
    const pid = parsePositiveInteger(pidText);
    const parentPid = parseNonNegativeInteger(parentPidText);
    const processGroupId = parsePositiveInteger(processGroupIdText);
    const lstart = fields.slice(3, 8).join(" ");
    const command = includeCommand ? fields.slice(8).join(" ") : "";
    // Darwin's ps only exposes second-level lstart; appends the complete command as reuse verification entropy.
    // Linux then overwrites this value with /proc start ticks.
    const startTime = includeCommand ? `${lstart}|command:${command}` : lstart;
    if (pid === undefined || parentPid === undefined || !processGroupId || !startTime) {
      continue;
    }
    identities.push({ parentPid, pid, processGroupId, startTime });
  }
  return identities;
}

function parseWindowsProcessList(stdout: string): ProcessIdentity[] {
  const identities: ProcessIdentity[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const [pidText, parentPidText, startTime] = line.trim().split(/\s+/);
    const pid = parsePositiveInteger(pidText);
    const parentPid = parseNonNegativeInteger(parentPidText);
    if (pid === undefined || parentPid === undefined || !startTime) {
      continue;
    }
    identities.push({ parentPid, pid, startTime });
  }
  return identities;
}

function parseWindowsCreationTimeMs(startTime: string): number | undefined {
  try {
    const unixTicks = BigInt(startTime) - DOTNET_UNIX_EPOCH_TICKS;
    const timestamp = Number(unixTicks / TICKS_PER_MILLISECOND);
    return Number.isSafeInteger(timestamp) ? timestamp : undefined;
  } catch {
    return undefined;
  }
}

function readPosixProcessList(options: ProcessTreeTerminatorOptions): ProcessIdentity[] {
  const includeCommand = process.platform === "darwin";
  const result = spawnSync(
    "ps",
    includeCommand
      ? ["-axo", "pid=,ppid=,pgid=,lstart=,command="]
      : ["-eo", "pid=,ppid=,pgid=,lstart="],
    {
      encoding: "utf8",
      timeout: PROCESS_LOOKUP_TIMEOUT_MS,
    },
  );
  if (result.error) {
    warn(
      options,
      "failed to look up runtime descendant processes (process table query):",
      result.error,
    );
    return [];
  }
  if (result.signal === "SIGTERM" || result.signal === "SIGKILL") {
    warn(
      options,
      `failed to look up runtime descendant processes (process table timeout) signal=${result.signal}`,
    );
    return [];
  }
  if (result.status !== 0 || !result.stdout) {
    warn(
      options,
      `failed to look up runtime descendant processes (process table query) status=${result.status ?? "unknown"}`,
    );
    return [];
  }
  return parsePosixProcessList(result.stdout, includeCommand);
}

function readWindowsProcessList(options: ProcessTreeTerminatorOptions): readonly ProcessIdentity[] {
  if (windowsProcessListCache) {
    return windowsProcessListCache;
  }
  const result = spawnSync(
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
      timeout: PROCESS_LOOKUP_TIMEOUT_MS,
      windowsHide: true,
    },
  );
  if (result.error || result.status !== 0 || !result.stdout) {
    warn(
      options,
      `failed to query the Windows runtime process table status=${result.status ?? "unknown"}:`,
      result.error ?? result.stderr,
    );
    return [];
  }
  const identities = parseWindowsProcessList(result.stdout);
  windowsProcessListCache = identities;
  // The same round of app quit will capture multiple workspaces simultaneously and reuse the same system process table with CreationDate;
  // The next microtask will be invalidated immediately to avoid misjudgment of PID reuse as an old process during subsequent restart/quit.
  queueMicrotask(() => {
    if (windowsProcessListCache === identities) {
      windowsProcessListCache = undefined;
    }
  });
  return identities;
}

function readProcessList(options: ProcessTreeTerminatorOptions): readonly ProcessIdentity[] {
  return process.platform === "win32"
    ? readWindowsProcessList(options)
    : readPosixProcessList(options);
}

function refineLinuxProcessIdentity(identity: ProcessIdentity): ProcessIdentity | undefined {
  if (process.platform !== "linux") {
    return identity;
  }
  try {
    const stat = readFileSync(`/proc/${identity.pid}/stat`, "utf8");
    const commandEnd = stat.lastIndexOf(")");
    if (commandEnd < 0) {
      return undefined;
    }
    // Field 22 of /proc/<pid>/stat is the startup tick since boot; the accuracy is higher than ps lstart
    // Second-level time, the PID will not be mistaken for the old runtime member when it is reused in the same second.
    const fieldsAfterCommand = stat
      .slice(commandEnd + 2)
      .trim()
      .split(/\s+/);
    const parentPid = parseNonNegativeInteger(fieldsAfterCommand[1]);
    const processGroupId = parsePositiveInteger(fieldsAfterCommand[2]);
    const startTimeTicks = fieldsAfterCommand[19];
    if (
      parentPid === undefined ||
      !processGroupId ||
      !startTimeTicks ||
      parentPid !== identity.parentPid ||
      processGroupId !== identity.processGroupId
    ) {
      // When PID reuse/reparent occurs between two reads of ps and /proc, mixed identities cannot be spelled out.
      return undefined;
    }
    return {
      ...identity,
      parentPid,
      processGroupId,
      startTime: `linux-ticks:${startTimeTicks}`,
    };
  } catch {
    return undefined;
  }
}

function refineProcessIdentities(identities: readonly ProcessIdentity[]): ProcessIdentity[] {
  if (process.platform !== "linux") {
    return [...identities];
  }
  return identities
    .map((identity) => refineLinuxProcessIdentity(identity))
    .filter((identity): identity is ProcessIdentity => identity !== undefined);
}

function collectDescendantIdentitiesFromProcessList(
  rootPid: number,
  identities: readonly ProcessIdentity[],
): ProcessIdentity[] {
  const childrenByParentPid = new Map<number, ProcessIdentity[]>();
  for (const identity of identities) {
    const children = childrenByParentPid.get(identity.parentPid) ?? [];
    children.push(identity);
    childrenByParentPid.set(identity.parentPid, children);
  }

  const descendants: ProcessIdentity[] = [];
  const seen = new Set<number>([rootPid]);
  const visit = (pid: number) => {
    for (const child of childrenByParentPid.get(pid) ?? []) {
      if (seen.has(child.pid)) {
        continue;
      }
      seen.add(child.pid);
      descendants.push(child);
      visit(child.pid);
    }
  };
  visit(rootPid);
  return descendants;
}

export function filterCurrentProcessIdentities(
  identities: readonly ProcessIdentity[],
  options: ProcessTreeTerminatorOptions,
): ProcessIdentity[] {
  if (identities.length === 0) {
    return [];
  }
  const trackedPids = new Set(identities.map((identity) => identity.pid));
  const currentByPid = new Map(
    refineProcessIdentities(
      readProcessList(options).filter((identity) => trackedPids.has(identity.pid)),
    ).map((identity) => [identity.pid, identity]),
  );
  return identities.filter((identity) => {
    const current = currentByPid.get(identity.pid);
    return (
      current?.startTime === identity.startTime &&
      (identity.processGroupId === undefined || current.processGroupId === identity.processGroupId)
    );
  });
}

export function captureProcessTreeSnapshot(
  child: ChildProcess,
  options: ProcessTreeTerminatorOptions = {},
): ProcessTreeSnapshot | undefined {
  if (child.pid == null) {
    return undefined;
  }
  const processList = readProcessList(options);
  const rootIdentity = processList.find((identity) => identity.pid === child.pid);
  if (!rootIdentity) {
    // A rootPid that does not create an identity cannot form process ownership; returning a half-snapshot would
    // Delayed recycling reclaims the unrelated process tree along the bare root PID after PID reuse.
    return undefined;
  }
  const descendantIdentities = collectDescendantIdentitiesFromProcessList(child.pid, processList);
  // POSIX detached root is the leader of its own process group; if it exits during a ps scan,
  // Descendants will be reparented, and relying on the PPID chain alone will miss processes that still belong to the owned PGID. only in
  // When PGID === root PID, merge the members of the same group to avoid including the host process group where the ordinary child is located into the snapshot.
  const ownedProcessGroupIdentities =
    process.platform !== "win32" && rootIdentity.processGroupId === child.pid
      ? processList.filter((identity) => identity.processGroupId === child.pid)
      : [];
  const snapshotCandidates = new Map(
    [rootIdentity, ...descendantIdentities, ...ownedProcessGroupIdentities].map((identity) => [
      identity.pid,
      identity,
    ]),
  );
  const identities = refineProcessIdentities([...snapshotCandidates.values()]);
  if (!identities.some((identity) => identity.pid === child.pid)) {
    return undefined;
  }
  return {
    rootPid: child.pid,
    descendantPids: identities
      .filter((identity) => identity.pid !== child.pid)
      .map((identity) => identity.pid),
    identities,
  };
}

export function captureProcessGroupSnapshot(
  processGroupId: number,
  options: ProcessTreeTerminatorOptions = {},
): ProcessTreeSnapshot | undefined {
  if (process.platform === "win32" || !Number.isInteger(processGroupId) || processGroupId <= 0) {
    return undefined;
  }
  // The root of POSIX detached Agent may exit before the same group of MCP/tool processes.
  // At this point the PPID has changed, but the kernel will retain the original PGID until the last member exits. Only in cleanup
  // Boundaries are queried by the PGID owned by the Host when spawned to avoid bringing process table scans into the protocol message hot path.
  const identities = refineProcessIdentities(
    readProcessList(options).filter((identity) => identity.processGroupId === processGroupId),
  );
  if (identities.length === 0) {
    return undefined;
  }
  return {
    rootPid: processGroupId,
    descendantPids: identities
      .filter((identity) => identity.pid !== processGroupId)
      .map((identity) => identity.pid),
    identities,
  };
}

export function captureExitedRootDescendantsSnapshot(
  rootPid: number,
  options: ProcessTreeTerminatorOptions = {},
): ProcessTreeSnapshot | undefined {
  const startedAtMs = options.ownedProcessStartedAtMs;
  const exitedAtMs = options.ownedProcessExitedAtMs;
  if (
    process.platform !== "win32" ||
    !Number.isInteger(rootPid) ||
    rootPid <= 0 ||
    typeof startedAtMs !== "number" ||
    !Number.isFinite(startedAtMs) ||
    typeof exitedAtMs !== "number" ||
    !Number.isFinite(exitedAtMs)
  ) {
    return undefined;
  }
  // Windows Win32_Process retains creator ParentProcessId even if CLI root
  // Already exited. The naked ParentProcessId will mistakenly claim an unrelated process after PID reuse, so the candidate member's
  // CreationDate must also fall within the root life cycle of the Host record; subsequent force presses the same
  // CreationDate review, cannot signal a descendant PID that has been reused.
  const processList = readProcessList(options).filter((identity) => {
    const createdAtMs = parseWindowsCreationTimeMs(identity.startTime);
    return createdAtMs !== undefined && createdAtMs >= startedAtMs && createdAtMs <= exitedAtMs;
  });
  const identities = collectDescendantIdentitiesFromProcessList(rootPid, processList);
  if (identities.length === 0) {
    return undefined;
  }
  return {
    rootPid,
    descendantPids: identities.map((identity) => identity.pid),
    identities,
  };
}
