/**
 * Process role classification and per-role aggregation for the Chromium family
 * (`getAppMetrics` on the main side).
 * Pure functions with zero Electron runtime dependencies, so they are easy to unit-test; the pid
 * sets come from the registry in resourceManagerWindow.
 */

import type { ProcessResourceRole } from "@zcode/shared";
import {
  addAppResourceTotals,
  createEmptyAppResourceTotals,
  type AppResourceTotals,
} from "./processResourceAppTotals.js";
import { roundMetric } from "./resourceMetricsStats.js";

/** The seven roles that getAppMetrics can cover; cli_* and mcp are contributed by the CLI samples and do not appear here. */
const CHROMIUM_PROCESS_RESOURCE_ROLES = [
  "main",
  "renderer_main",
  "renderer_guest",
  "gpu",
  "chromium_other",
  "host",
  "scheduler",
] as const satisfies readonly ProcessResourceRole[];

type ChromiumProcessResourceRole = (typeof CHROMIUM_PROCESS_RESOURCE_ROLES)[number];

/** A normalized single-process sample: CPU is already normalized to whole-machine scale, memory in KB. */
export interface ChromiumProcessMetricSample {
  pid: number;
  type: string;
  cpuPercent: number;
  rssKb: number;
  /** Process creation time (epoch ms); absent means unknown, and uptime is counted as 0. */
  creationTime?: number;
}

/**
 * A snapshot of which pids belong to which role. Renderers must distinguish the main window from
 * `<webview>` guests; the utilityProcess pids for host and scheduler are registered by their
 * respective spawn points.
 */
export interface ChromiumProcessRolePids {
  mainPid: number;
  mainWindowRendererPids: ReadonlySet<number>;
  guestRendererPids: ReadonlySet<number>;
  hostPids: ReadonlySet<number>;
  schedulerPids: ReadonlySet<number>;
}

export interface ChromiumRoleAggregate {
  role: ChromiumProcessResourceRole;
  /** Sum of CPU across every process in the role (percentage normalized to the whole machine). */
  cpuPercent: number;
  rssKbTotal: number;
  rssKbMaxProcess: number;
  processCount: number;
  /** Uptime in minutes of the oldest process in the role. */
  uptimeMinutes: number;
}

/**
 * Sums every Chromium role of one tick into the total for the app processes main can enumerate
 * exactly. The device-level app total takes its Chromium part only from here: CLI and MCP come in
 * through the external sample entry points, so the two sides never double-count.
 */
export function sumChromiumRoleAggregates(
  aggregates: readonly ChromiumRoleAggregate[],
): AppResourceTotals {
  let totals = createEmptyAppResourceTotals();
  for (const aggregate of aggregates) {
    totals = addAppResourceTotals(totals, {
      cpuPercent: aggregate.cpuPercent,
      rssKbTotal: aggregate.rssKbTotal,
      processCount: aggregate.processCount,
    });
  }
  return totals;
}

function classifyChromiumProcessRole(
  sample: Pick<ChromiumProcessMetricSample, "pid" | "type">,
  pids: ChromiumProcessRolePids,
): ChromiumProcessResourceRole {
  if (sample.pid === pids.mainPid) {
    return "main";
  }
  if (sample.type === "GPU") {
    return "gpu";
  }
  if (pids.mainWindowRendererPids.has(sample.pid)) {
    return "renderer_main";
  }
  if (pids.guestRendererPids.has(sample.pid)) {
    return "renderer_guest";
  }
  if (pids.hostPids.has(sample.pid)) {
    return "host";
  }
  if (pids.schedulerPids.has(sample.pid)) {
    return "scheduler";
  }
  return "chromium_other";
}

function uptimeMinutesOf(sample: ChromiumProcessMetricSample, now: number): number {
  const creationTime = sample.creationTime;
  if (typeof creationTime !== "number" || !Number.isFinite(creationTime) || creationTime <= 0) {
    return 0;
  }
  return Math.max(0, Math.round((now - creationTime) / 60_000));
}

/** Aggregates all Chromium processes of one tick by role; only roles with live processes in this tick are returned. */
export function aggregateChromiumProcessRoles(input: {
  processes: readonly ChromiumProcessMetricSample[];
  pids: ChromiumProcessRolePids;
  now: number;
}): ChromiumRoleAggregate[] {
  const byRole = new Map<ChromiumProcessResourceRole, ChromiumRoleAggregate>();

  for (const sample of input.processes) {
    const role = classifyChromiumProcessRole(sample, input.pids);
    const existing = byRole.get(role);
    const uptimeMinutes = uptimeMinutesOf(sample, input.now);
    if (!existing) {
      byRole.set(role, {
        role,
        cpuPercent: sample.cpuPercent,
        rssKbTotal: sample.rssKb,
        rssKbMaxProcess: sample.rssKb,
        processCount: 1,
        uptimeMinutes,
      });
      continue;
    }
    // Only round after accumulation: successive rounds will cause the error to accumulate with the number of processes.
    existing.cpuPercent += sample.cpuPercent;
    existing.rssKbTotal += sample.rssKb;
    existing.rssKbMaxProcess = Math.max(existing.rssKbMaxProcess, sample.rssKb);
    existing.processCount += 1;
    existing.uptimeMinutes = Math.max(existing.uptimeMinutes, uptimeMinutes);
  }

  // The output order is fixed based on role enumeration, and the event order can be expected in both single tests and Kanban boards.
  return CHROMIUM_PROCESS_RESOURCE_ROLES.map((role) => byRole.get(role))
    .filter((aggregate): aggregate is ChromiumRoleAggregate => aggregate !== undefined)
    .map((aggregate) => ({ ...aggregate, cpuPercent: roundMetric(aggregate.cpuPercent) }));
}
