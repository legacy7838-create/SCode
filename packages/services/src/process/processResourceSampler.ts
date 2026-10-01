import os from "node:os";
import { basename } from "node:path";
import {
  formatZCodeAgentProcessName,
  type HostResourceUsageProcess,
  type ZCodeProcessChildProcess,
} from "@zcode/shared";
import { loadSysinfo } from "@zcode/rust/sysinfo";

/**
 * Host-side attribution for the resource manager.
 *
 * Design boundaries:
 * - It runs only inside the Window Host (utility process), and reads the process table only once, when the
 *   resource manager window issues a request; the main process is forbidden from starting any external
 *   process (a synchronous ps / PowerShell call historically froze the whole app).
 * - After reading the machine-wide process table it attributes rows by Host descendants; plugin attribution comes from the CLI's `process/childProcesses`.
 * - CPU is uniformly a machine-wide normalized percentage (100% = all logical cores saturated), derived from the cputime delta of two samples.
 *
 * The table read and the cputime-delta accounting live in Rust
 * (`zcode-sysinfo`, spec: docs/specs/rust-native-sysinfo.md). This module is the
 * TypeScript adapter: it owns the wall clock, the abort wiring and the `Map` the
 * attribution pass consumes, because those are host concerns the native boundary
 * deliberately does not own.
 */

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
  now?: () => number;
  logicalCpuCount?: number;
}

export function createProcessResourceSampler(
  options: CreateProcessResourceSamplerOptions = {},
): ProcessResourceSampler {
  const now = options.now ?? Date.now;
  const logicalCpuCount = Math.max(1, options.logicalCpuCount ?? os.cpus().length);
  const native = new (loadSysinfo().ProcessResourceSampler)(logicalCpuCount);

  return {
    async sample(signal) {
      signal?.throwIfAborted();
      // `cancel()` is the native half of the abort contract (spec invariant 6): it
      // abandons the round mid-read and the pending `sample()` resolves to null.
      // The listener is attached before `sample()` is called because the native side
      // clears its own cancel flag synchronously on entry.
      const onAbort = () => native.cancel();
      signal?.addEventListener("abort", onAbort, { once: true });
      try {
        const rows = await native.sample(now());
        // Same position as the predecessor's post-read check: a round that raced an
        // abort must surface as AbortError, not as "no processes".
        signal?.throwIfAborted();
        if (!rows) {
          return undefined;
        }
        return new Map(rows.map((row) => [row.pid, row]));
      } finally {
        signal?.removeEventListener("abort", onAbort);
      }
    },
  };
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
 *
 * Not ported: measured at 0.119 ms for 309 samples, which is 1 253x the FFI floor but
 * less than the ~0.19 ms it costs to marshal 309 sample objects in and 309 attributed
 * rows back out. See docs/specs/rust-native-sysinfo.md §2.3.
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
