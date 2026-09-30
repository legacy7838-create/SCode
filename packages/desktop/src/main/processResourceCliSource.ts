/**
 * Resource sample source for the zcode-cli roles (`cli_chat` / `cli_aux`) — the fifth row of the registry.
 *
 * Every CLI process samples itself once per 60 seconds and hands the reading to services through a
 * protocol notification (tagged there with a lane according to the owning process manager), which
 * the Host then forwards to main. Here we keep the most recent reading per process under
 * "role × runtime_surface × process instance" and hand the total of the currently live processes to
 * the window aggregator every 60 seconds:
 *
 * - Why not hand off on every 10 second tick: CLI runs on a 60 second cadence, and handing off per
 *   tick would count the same reading into the statistics repeatedly, turning `sample_count` from
 *   the expected 5 into 30.
 * - Why not "hand off on arrival, clear on delivery" (what the host / renderer heap does): the 60
 *   second timers of several CLI processes each have their own phase, so one tick usually only
 *   receives readings from some of them, and both `process_count_peak` and the total would come out
 *   too small. A role event wants exactly "how many processes are alive at the same time, and how
 *   much in total", so the latest reading per process has to be retained.
 * - The expiry criterion matches the device-level external samples: no new reading for more than two
 *   sampling periods means the process is considered gone and is no longer counted. Undercounting
 *   is better than passing a stale value off as a current fact.
 * - Delivery happens only when there is a new reading, so the same reading is never counted twice
 *   by two deliveries.
 * - Normal exit goes through `flushPending`, handing the readings that already arrived but have not
 *   reached their 60 second delivery point to the window (it only moves facts that already exist; it
 *   takes no new samples).
 *
 * Privacy boundary: `instanceToken` only lives in this module's memory to tell processes apart and
 * never reaches any ARMS attribute; samples carry no pid.
 */

import {
  agentLaneResourceSampleSchema,
  resolveCliProcessResourceRole,
  ZCODE_CLI_RESOURCE_SAMPLE_INTERVAL_MS,
  type AgentLaneResourceSample,
  type ProcessResourceRole,
  type ProcessResourceRuntimeSurface,
} from "@zcode/shared";
import { recordExternalAppResourceSample } from "./processResourceExternalAppSamples.js";
import type {
  ProcessResourceSampleContext,
  ProcessResourceSampleSource,
} from "./processResourceSampleSources.js";
import {
  processResourceHardwareKey,
  type ProcessResourceHardwareOverride,
  type ProcessRoleSample,
} from "./processResourceWindowAggregator.js";
import { roundMetric } from "./resourceMetricsStats.js";

/**
 * Maximum number of CLI processes to be tracked simultaneously (memory bounded).
 * The normal state is one chat process plus three control plane lanes per workspace. The 64 is far more than the actual number; new processes will be discarded directly after exceeding the limit.
 */
const PROCESS_RESOURCE_MAX_CLI_INSTANCES = 64;

/** The old CLI samples without instanceToken share the same bucket: processes cannot be distinguished and can only be counted as one process. */
const LEGACY_INSTANCE_KEY = "legacy";

interface StoredCliSample {
  role: ProcessResourceRole;
  runtimeSurface: ProcessResourceRuntimeSurface;
  environmentKey?: string;
  sample: AgentLaneResourceSample;
  /** The arrival time is only used for expiration determination. */
  receivedAt: number;
  /**
   * Whether this reading has been given to the window aggregator.
   * Use explicit tags instead of timestamps: if the read and delivery hit the same millisecond, the timestamp will misjudge it as delivered and discard it permanently.
   */
  delivered: boolean;
}

const latestSamplesByInstance = new Map<string, StoredCliSample>();

/**
 * The main-side trust boundary: the payload has already been strictly validated against the Host
 * response schema by the time it reaches here, and we validate it once more (other links —
 * scheduler, remote relay, … — reuse this same entry point). Illegal samples are dropped outright,
 * without throwing.
 */
export function ingestCliResourceSample(
  raw: unknown,
  runtimeSurface: ProcessResourceRuntimeSurface,
  environmentKey?: string,
): void {
  const parsed = agentLaneResourceSampleSchema.safeParse(raw);
  if (!parsed.success) {
    return;
  }
  const sample = parsed.data;
  const role = resolveCliProcessResourceRole(sample.lane);
  const key = [
    role,
    runtimeSurface,
    environmentKey ?? "",
    sample.instanceToken ?? LEGACY_INSTANCE_KEY,
  ].join(":");
  if (
    !latestSamplesByInstance.has(key) &&
    latestSamplesByInstance.size >= PROCESS_RESOURCE_MAX_CLI_INSTANCES
  ) {
    return;
  }
  const receivedAt = Date.now();
  latestSamplesByInstance.set(key, {
    role,
    runtimeSurface,
    environmentKey,
    sample,
    receivedAt,
    delivered: false,
  });
  // The total device volume saves the original arrival time as an instance; the delivery time of the used group will cause the discontinued instance to be renewed by other groups or active instances in the same group.
  recordExternalAppResourceSample({
    sourceKey: `cli:${key}`,
    runtimeSurface,
    cpuPercent: sample.cpuPercent,
    rssKbTotal: sample.rssKb,
    processCount: 1,
    intervalMs: resolveSampleIntervalMs(sample),
    receivedAt,
  });
}

/** The sampling period is at least based on the CLI self-sampling period: abnormally small reading intervals cannot shorten the expiration window accordingly. */
function resolveSampleIntervalMs(sample: AgentLaneResourceSample): number {
  return Math.max(ZCODE_CLI_RESOURCE_SAMPLE_INTERVAL_MS, sample.intervalMs);
}

function resolveHardware(sample: AgentLaneResourceSample): ProcessResourceHardwareOverride {
  return {
    platform: sample.platform,
    arch: sample.arch,
    logicalCpuCount: sample.logicalCpuCount,
    // The old CLI does not have running machine memory, and the default is to export the value of the desktop machine.
    ...(sample.totalMemoryGb === undefined ? {} : { totalMemoryGb: sample.totalMemoryGb }),
  };
}

/** Process entries with no new readings for more than two sampling periods are discarded. */
function purgeExpired(now: number): void {
  for (const [key, entry] of latestSamplesByInstance) {
    if (now - entry.receivedAt > resolveSampleIntervalMs(entry.sample) * 2) {
      latestSamplesByInstance.delete(key);
    }
  }
}

interface CliRoleGroup {
  role: ProcessResourceRole;
  runtimeSurface: ProcessResourceRuntimeSurface;
  environmentKey?: string;
  /** The common running machine of this group: It enters the group key, so the running machine information of each process in the group is completely consistent. */
  hardware: ProcessResourceHardwareOverride;
  samples: AgentLaneResourceSample[];
  fresh: boolean;
}

/**
 * Grouping key: role × runtime_surface × runtime machine.
 * The reason for adding a running machine is that multiple remote workspaces may run on different machines, and their RSS cannot be added.
 * The hardware dimension can only describe one machine (the window key of the aggregator uses the same fingerprint to separate windows).
 */
function groupByRole(): CliRoleGroup[] {
  const groups = new Map<string, CliRoleGroup>();
  for (const entry of latestSamplesByInstance.values()) {
    const hardware = resolveHardware(entry.sample);
    // The same hardware does not mean the same running environment. The identity injected by the Host must run through the instance cache and grouping.
    const key = [
      entry.role,
      entry.runtimeSurface,
      entry.environmentKey ?? "",
      processResourceHardwareKey(hardware),
    ].join(":");
    const group = groups.get(key);
    if (group) {
      group.samples.push(entry.sample);
      group.fresh ||= !entry.delivered;
      continue;
    }
    groups.set(key, {
      role: entry.role,
      runtimeSurface: entry.runtimeSurface,
      environmentKey: entry.environmentKey,
      hardware,
      samples: [entry.sample],
      fresh: !entry.delivered,
    });
  }
  return [...groups.values()];
}

function projectRoleSample(group: CliRoleGroup): ProcessRoleSample {
  let cpuPercent = 0;
  let rssKbTotal = 0;
  let rssKbMaxProcess = 0;
  let uptimeMinutes = 0;
  let heapUsedKb: number | undefined;
  for (const sample of group.samples) {
    cpuPercent += sample.cpuPercent;
    rssKbTotal += sample.rssKb;
    rssKbMaxProcess = Math.max(rssKbMaxProcess, sample.rssKb);
    uptimeMinutes = Math.max(uptimeMinutes, sample.uptimeMinutes ?? 0);
    // The heap of the multi-process role is the largest single process sampled this time.
    if (sample.heapUsedKb !== undefined) {
      heapUsedKb = Math.max(heapUsedKb ?? 0, sample.heapUsedKb);
    }
  }

  return {
    role: group.role,
    runtimeSurface: group.runtimeSurface,
    ...(group.environmentKey === undefined ? {} : { environmentKey: group.environmentKey }),
    // The CPU only rounds after the addition, and successive rounds will cause the error to accumulate with the number of processes.
    cpuPercent: roundMetric(cpuPercent),
    rssKbTotal: roundMetric(rssKbTotal),
    rssKbMaxProcess: roundMetric(rssKbMaxProcess),
    processCount: group.samples.length,
    uptimeMinutes,
    ...(heapUsedKb === undefined ? {} : { heapUsedKb }),
    hardware: group.hardware,
  };
}

/** The last time a character sample was handed over to the window aggregator (`context.now`, the same wall clock as ingest's `Date.now()`). */
let lastDeliveredAt: number | null = null;

/** Are there any readings that have been "received but not yet handed in": the same facts should not be handed in again without new readings. */
function hasUndeliveredReading(): boolean {
  for (const entry of latestSamplesByInstance.values()) {
    if (!entry.delivered) {
      return true;
    }
  }
  return false;
}

/** Give the combination of live processes with new readings to the role window; the device total is maintained independently on a per-instance basis upon ingestion. */
function deliverRoleSamples(context: ProcessResourceSampleContext): void {
  lastDeliveredAt = context.now;
  // Read the new reading mark of each group first and then seal it; having new readings globally does not mean that each group has them, and old groups cannot be renewed.
  const groups = groupByRole();
  for (const entry of latestSamplesByInstance.values()) {
    entry.delivered = true;
  }
  for (const group of groups) {
    if (!group.fresh) continue;
    context.addRoleSample(projectRoleSample(group));
  }
}

export const cliProcessResourceSampleSource: ProcessResourceSampleSource = {
  id: "cli",
  sample(context) {
    purgeExpired(context.now);
    // Submitted once every 60 seconds, and only when there are new readings: the window splitting right is still on the flush clock of main,
    // This only determines "how often to count a CLI sample", and the same reading will not be included in the statistics twice.
    if (
      lastDeliveredAt !== null &&
      context.now - lastDeliveredAt < ZCODE_CLI_RESOURCE_SAMPLE_INTERVAL_MS
    ) {
      return;
    }
    if (!hasUndeliveredReading()) {
      return;
    }
    deliverRoleSamples(context);
  },
  flushPending(context) {
    // Normal exit: hand over the readings that have been received in this cycle and have not yet reached the 60-second delivery point.
    // Otherwise, exiting within the 1-minute window (development state/E2E) will leave the cli role without any events.
    purgeExpired(context.now);
    if (!hasUndeliveredReading()) {
      return;
    }
    deliverRoleSamples(context);
  },
  reset() {
    latestSamplesByInstance.clear();
    lastDeliveredAt = null;
  },
};
