import { execFile as nodeExecFile } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { basename } from "node:path";
import os from "node:os";
import {
  formatZCodeAgentProcessName,
  type HostResourceUsageProcess,
  type ZCodeProcessChildProcess,
} from "@zcode/shared";

/**
 * Host-side sampling for the resource manager.
 *
 * Design boundaries:
 * - It runs only inside the Window Host (utility process), and reads the process table only once, when the
 *   resource manager window issues a request; the main process is forbidden from starting any external
 *   process (a synchronous ps / PowerShell call historically froze the whole app).
 * - After reading the machine-wide process table it attributes rows by Host descendants; plugin attribution comes from the CLI's `process/childProcesses`.
 * - CPU is uniformly a machine-wide normalized percentage (100% = all logical cores saturated), derived from the cputime delta of two samples.
 */

const POSIX_TABLE_TIMEOUT_MS = 3_000;
const WINDOWS_TABLE_TIMEOUT_MS = 5_000;
const TABLE_MAX_BUFFER_BYTES = 16 * 1024 * 1024;
/** Linux /proc always reports utime/stime in USER_HZ=100 units, independent of the kernel HZ. */
const LINUX_CLOCK_TICKS_PER_SECOND = 100;
const WINDOWS_100NS_PER_MS = 10_000;
/** A previous cputime baseline is discarded after it has not been seen again for this long (pid reuse guard) */
const CPU_BASELINE_TTL_MS = 60_000;

interface ProcessResourceRow {
  pid: number;
  ppid: number;
  rssKb: number;
  /** Process cumulative CPU time (user + system), in milliseconds */
  cpuTimeMs: number;
  /** Command name or executable path (as the platform reports it) */
  command: string;
}

type ProcessResourceTableReader = (
  signal?: AbortSignal,
) => Promise<ProcessResourceRow[] | undefined>;

interface ExecFileResult {
  error?: unknown;
  stdout: string;
}

type ExecFileFn = (
  file: string,
  args: readonly string[],
  options: { timeout: number; maxBuffer: number; windowsHide?: boolean; signal?: AbortSignal },
) => Promise<ExecFileResult>;

function defaultExecFile(
  file: string,
  args: readonly string[],
  options: { timeout: number; maxBuffer: number; windowsHide?: boolean; signal?: AbortSignal },
): Promise<ExecFileResult> {
  return new Promise((resolve) => {
    nodeExecFile(file, [...args], { ...options, encoding: "utf8" }, (error, stdout) => {
      resolve(error ? { error, stdout: "" } : { stdout });
    });
  });
}

function parseNonNegativeInteger(text: string | undefined): number | undefined {
  const value = Number(text);
  return Number.isInteger(value) && value >= 0 ? value : undefined;
}

/**
 * Parses the cputime text of ps: macOS `[[dd-]hh:]mm:ss.cc`, Linux `[dd-]hh:mm:ss`.
 * Returns milliseconds; returns undefined when it cannot be parsed.
 */
function parseCpuTimeText(text: string): number | undefined {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  let days = 0;
  let clock = trimmed;
  const dayIndex = trimmed.indexOf("-");
  if (dayIndex > 0) {
    days = Number(trimmed.slice(0, dayIndex));
    clock = trimmed.slice(dayIndex + 1);
    if (!Number.isInteger(days) || days < 0) return undefined;
  }
  const parts = clock.split(":");
  if (parts.length === 0 || parts.length > 3) return undefined;
  const seconds = Number(parts[parts.length - 1]);
  const minutes = parts.length >= 2 ? Number(parts[parts.length - 2]) : 0;
  const hours = parts.length === 3 ? Number(parts[0]) : 0;
  if (![seconds, minutes, hours].every((value) => Number.isFinite(value) && value >= 0)) {
    return undefined;
  }
  return Math.round((((days * 24 + hours) * 60 + minutes) * 60 + seconds) * 1000);
}

/** Output of `ps -axo pid=,ppid=,rss=,cputime=,comm=`; comm may contain spaces, so everything after the first 4 columns is comm */
function parseDarwinProcessTable(stdout: string): ProcessResourceRow[] {
  const rows: ProcessResourceRow[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line);
    if (!match) continue;
    const pid = parseNonNegativeInteger(match[1]);
    const ppid = parseNonNegativeInteger(match[2]);
    const rssKb = parseNonNegativeInteger(match[3]);
    const cpuTimeMs = parseCpuTimeText(match[4] ?? "");
    if (pid === undefined || pid <= 0 || ppid === undefined || rssKb === undefined) continue;
    if (cpuTimeMs === undefined) continue;
    rows.push({ pid, ppid, rssKb, cpuTimeMs, command: (match[5] ?? "").trim() });
  }
  return rows;
}

/** Parses `/proc/<pid>/stat`: comm is wrapped in parentheses and may contain spaces and parentheses, so it is split on the last `)` */
function parseLinuxProcStat(
  content: string,
): { pid: number; ppid: number; command: string; cpuTimeMs: number } | undefined {
  const open = content.indexOf("(");
  const close = content.lastIndexOf(")");
  if (open < 0 || close < open) return undefined;
  const pid = parseNonNegativeInteger(content.slice(0, open).trim());
  const command = content.slice(open + 1, close);
  const rest = content
    .slice(close + 1)
    .trim()
    .split(/\s+/);
  // rest[0]=state, rest[1]=ppid, ... rest[11]=utime, rest[12]=stime (original field number 14/15)
  const ppid = parseNonNegativeInteger(rest[1]);
  const utime = parseNonNegativeInteger(rest[11]);
  const stime = parseNonNegativeInteger(rest[12]);
  if (
    pid === undefined ||
    pid <= 0 ||
    ppid === undefined ||
    utime === undefined ||
    stime === undefined
  ) {
    return undefined;
  }
  return {
    pid,
    ppid,
    command,
    cpuTimeMs: Math.round(((utime + stime) * 1000) / LINUX_CLOCK_TICKS_PER_SECOND),
  };
}

/** Parses `VmRSS:\t 1234 kB` in `/proc/<pid>/status` */
export function parseLinuxVmRssKb(content: string): number {
  const match = /^VmRSS:\s*(\d+)\s*kB/m.exec(content);
  return match ? Number(match[1]) : 0;
}

/** PowerShell output: `pid ppid workingSetBytes cpu100ns name...` */
function parseWindowsProcessTable(stdout: string): ProcessResourceRow[] {
  const rows: ProcessResourceRow[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*(.*)$/.exec(line);
    if (!match) continue;
    const pid = parseNonNegativeInteger(match[1]);
    const ppid = parseNonNegativeInteger(match[2]);
    const workingSetBytes = parseNonNegativeInteger(match[3]);
    const cpu100ns = parseNonNegativeInteger(match[4]);
    if (pid === undefined || pid <= 0 || ppid === undefined || workingSetBytes === undefined)
      continue;
    if (cpu100ns === undefined) continue;
    rows.push({
      pid,
      ppid,
      rssKb: Math.round(workingSetBytes / 1024),
      cpuTimeMs: cpu100ns / WINDOWS_100NS_PER_MS,
      command: (match[5] ?? "").trim(),
    });
  }
  return rows;
}

interface CreateProcessResourceTableReaderOptions {
  platform?: NodeJS.Platform;
  execFile?: ExecFileFn;
  readdir?: (path: string) => Promise<string[]>;
  readFile?: (path: string) => Promise<string>;
}

/** Reads the machine-wide process table per platform; any failure returns undefined (skip this round) instead of throwing */
export function createProcessResourceTableReader(
  options: CreateProcessResourceTableReaderOptions = {},
): ProcessResourceTableReader {
  const platform = options.platform ?? process.platform;
  const execFile = options.execFile ?? defaultExecFile;

  if (platform === "win32") {
    return async (signal) => {
      signal?.throwIfAborted();
      const result = await execFile(
        "powershell.exe",
        [
          "-NoLogo",
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          "Get-CimInstance Win32_Process | ForEach-Object { '{0} {1} {2} {3} {4}' -f $_.ProcessId, $_.ParentProcessId, $_.WorkingSetSize, ($_.KernelModeTime + $_.UserModeTime), $_.Name }",
        ],
        {
          timeout: WINDOWS_TABLE_TIMEOUT_MS,
          maxBuffer: TABLE_MAX_BUFFER_BYTES,
          windowsHide: true,
          signal,
        },
      );
      return result.error ? undefined : parseWindowsProcessTable(result.stdout);
    };
  }

  if (platform === "linux") {
    const readDirectory = options.readdir ?? ((path: string) => readdir(path));
    return async (signal) => {
      signal?.throwIfAborted();
      const readText =
        options.readFile ?? ((path: string) => readFile(path, { encoding: "utf8", signal }));
      let entries: string[];
      try {
        entries = await readDirectory("/proc");
      } catch {
        return undefined;
      }
      const rows = await Promise.all(
        entries
          .filter((entry) => /^\d+$/.test(entry))
          .map(async (entry): Promise<ProcessResourceRow | undefined> => {
            try {
              signal?.throwIfAborted();
              const [stat, status] = await Promise.all([
                readText(`/proc/${entry}/stat`),
                readText(`/proc/${entry}/status`),
              ]);
              const parsed = parseLinuxProcStat(stat);
              if (!parsed) return undefined;
              return { ...parsed, rssKb: parseLinuxVmRssKb(status) };
            } catch {
              // It is normal for the process to exit during reading and can be skipped.
              return undefined;
            }
          }),
      );
      return rows.filter((row): row is ProcessResourceRow => row !== undefined);
    };
  }

  return async (signal) => {
    signal?.throwIfAborted();
    const result = await execFile("ps", ["-axo", "pid=,ppid=,rss=,cputime=,comm="], {
      timeout: POSIX_TABLE_TIMEOUT_MS,
      maxBuffer: TABLE_MAX_BUFFER_BYTES,
      signal,
    });
    return result.error ? undefined : parseDarwinProcessTable(result.stdout);
  };
}

export interface ProcessResourceSample {
  pid: number;
  ppid: number;
  rssKb: number;
  /** Machine-wide normalized CPU percentage; the first sample records 0 because it has no delta baseline */
  cpuPercent: number;
  command: string;
}

export interface ProcessResourceSampler {
  sample(signal?: AbortSignal): Promise<Map<number, ProcessResourceSample> | undefined>;
}

interface CreateProcessResourceSamplerOptions {
  readTable: ProcessResourceTableReader;
  now?: () => number;
  logicalCpuCount?: number;
}

export function createProcessResourceSampler(
  options: CreateProcessResourceSamplerOptions,
): ProcessResourceSampler {
  const now = options.now ?? Date.now;
  const logicalCpuCount = Math.max(1, options.logicalCpuCount ?? os.cpus().length);
  const baselines = new Map<number, { cpuTimeMs: number; at: number; command: string }>();

  return {
    async sample(signal) {
      const rows = await options.readTable(signal);
      // Late IO after closing the window cannot change the sampling baseline for the next time the window is opened.
      signal?.throwIfAborted();
      if (!rows) return undefined;
      const at = now();
      const samples = new Map<number, ProcessResourceSample>();
      for (const row of rows) {
        const baseline = baselines.get(row.pid);
        let cpuPercent = 0;
        // PID reuse protection: if the command changes or the cputime goes backwards, it will be treated as a new process and the baseline will be re-established.
        const reusable =
          baseline &&
          baseline.command === row.command &&
          row.cpuTimeMs >= baseline.cpuTimeMs &&
          at > baseline.at;
        if (reusable) {
          const elapsedMs = at - baseline.at;
          cpuPercent = (((row.cpuTimeMs - baseline.cpuTimeMs) / elapsedMs) * 100) / logicalCpuCount;
        }
        baselines.set(row.pid, { cpuTimeMs: row.cpuTimeMs, at, command: row.command });
        samples.set(row.pid, {
          pid: row.pid,
          ppid: row.ppid,
          rssKb: row.rssKb,
          cpuPercent: Math.max(0, Math.min(100, roundPercent(cpuPercent))),
          command: row.command,
        });
      }
      for (const [pid, baseline] of baselines) {
        if (!samples.has(pid) && at - baseline.at > CPU_BASELINE_TTL_MS) {
          baselines.delete(pid);
        }
      }
      return samples;
    },
  };
}

function roundPercent(value: number): number {
  return Number.isFinite(value) ? Math.round(value * 10) / 10 : 0;
}

export interface HostResourceUsageAgent {
  pid: number;
  provider: string;
  workspacePath: string;
  /** The report of the CLI's `process/childProcesses`; an empty array when the request fails, in which case all its descendants fall under cli */
  children: readonly ZCodeProcessChildProcess[];
}

interface AttributeHostProcessTreeOptions {
  samples: ReadonlyMap<number, ProcessResourceSample>;
  hostPid: number;
  agents: readonly HostResourceUsageAgent[];
  /** Built-in plugin processes the Host manages directly (e.g. the Windows CUA Helper): pid → plugin name */
  builtinPluginPids?: ReadonlyMap<number, string>;
}

type Owner =
  | { kind: "agent"; agent: HostResourceUsageAgent }
  | { kind: "mcp"; child: ZCodeProcessChildProcess }
  | { kind: "builtin"; pluginName: string };

function commandDisplayName(command: string): string {
  const name = basename(command.trim()).replace(/\.exe$/i, "");
  return name || command.trim() || "process";
}

function ownerToRow(
  owner: Owner | undefined,
  sample: ProcessResourceSample,
  isOwnerRoot: boolean,
): HostResourceUsageProcess {
  const cpuPercent = sample.cpuPercent;
  const memoryBytes = sample.rssKb * 1024;
  if (!owner) {
    return {
      pid: sample.pid,
      name: commandDisplayName(sample.command),
      category: "base",
      groupKey: "host",
      groupLabel: "host",
      cpuPercent,
      memoryBytes,
    };
  }
  if (owner.kind === "agent") {
    return {
      pid: sample.pid,
      name: isOwnerRoot
        ? formatZCodeAgentProcessName(owner.agent.provider, owner.agent.workspacePath)
        : commandDisplayName(sample.command),
      category: "base",
      groupKey: "cli",
      groupLabel: "cli",
      cpuPercent,
      memoryBytes,
    };
  }
  if (owner.kind === "builtin") {
    return {
      pid: sample.pid,
      name: commandDisplayName(sample.command),
      category: "builtin-plugin",
      groupKey: owner.pluginName,
      groupLabel: owner.pluginName,
      cpuPercent,
      memoryBytes,
    };
  }
  const { child } = owner;
  const groupLabel = child.pluginName ?? child.serverName;
  return {
    pid: sample.pid,
    name: isOwnerRoot ? child.serverName : commandDisplayName(sample.command),
    // User verdict: The official market plugins are built-in plugins, the rest (3rd party market + custom MCP) are all community plugins.
    category: child.mcpSource === "builtin" ? "builtin-plugin" : "community-plugin",
    groupKey: `${child.mcpSource}:${groupLabel}`,
    groupLabel,
    cpuPercent,
    memoryBytes,
  };
}

/**
 * Attributes every descendant of the Host by its "nearest known ancestor":
 * MCP root pid → the matching plugin; Agent pid → the basic-service cli; no attribution → a basic-service host subprocess.
 * The Host itself is not in the result (its metrics come from main's app.getAppMetrics).
 */
export function attributeHostProcessTree(
  options: AttributeHostProcessTreeOptions,
): HostResourceUsageProcess[] {
  const childrenByParent = new Map<number, number[]>();
  for (const sample of options.samples.values()) {
    const siblings = childrenByParent.get(sample.ppid) ?? [];
    siblings.push(sample.pid);
    childrenByParent.set(sample.ppid, siblings);
  }

  const ownerRoots = new Map<number, Owner>();
  for (const agent of options.agents) {
    ownerRoots.set(agent.pid, { kind: "agent", agent });
    for (const child of agent.children) {
      ownerRoots.set(child.pid, { kind: "mcp", child });
    }
  }
  for (const [pid, pluginName] of options.builtinPluginPids ?? []) {
    ownerRoots.set(pid, { kind: "builtin", pluginName });
  }

  const rows: HostResourceUsageProcess[] = [];
  const visited = new Set<number>([options.hostPid]);
  const visit = (pid: number, inheritedOwner: Owner | undefined): void => {
    for (const childPid of childrenByParent.get(pid) ?? []) {
      if (visited.has(childPid)) continue;
      visited.add(childPid);
      const sample = options.samples.get(childPid);
      if (!sample) continue;
      const rootOwner = ownerRoots.get(childPid);
      const owner = rootOwner ?? inheritedOwner;
      rows.push(ownerToRow(owner, sample, rootOwner !== undefined));
      visit(childPid, owner);
    }
  };
  visit(options.hostPid, undefined);

  // Processes that are known in the Agent registry but are not under the Host subtree (extreme case: ppid is rearranged to 1) are also added to avoid topological row loss.
  for (const [pid, owner] of ownerRoots) {
    if (visited.has(pid)) continue;
    const sample = options.samples.get(pid);
    if (!sample) continue;
    visited.add(pid);
    rows.push(ownerToRow(owner, sample, true));
    visit(pid, owner);
  }

  return rows.sort((left, right) => left.pid - right.pid);
}
