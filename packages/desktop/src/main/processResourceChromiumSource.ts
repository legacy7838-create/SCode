/**
 * Resource sample source for the Chromium family (main / renderer / gpu / utility).
 *
 * Reads `app.getAppMetrics()` every 10 seconds, aggregates by role and feeds the window aggregator.
 * The main process has zero external processes, so only in-process APIs are used here.
 */

import { app, type ProcessMetric } from "electron";
import os from "node:os";
import { normalizeElectronCpuToMachinePercent } from "./electronCpuNormalization.js";
import {
  aggregateChromiumProcessRoles,
  sumChromiumRoleAggregates,
  type ChromiumProcessMetricSample,
} from "./processResourceRoleClassifier.js";
import { collectChromiumProcessRolePids } from "./resourceManagerWindow.js";
import type { ProcessResourceSampleSource } from "./processResourceSampleSources.js";

function toNormalizedSample(
  metric: ProcessMetric,
  logicalCpuCount: number,
): ChromiumProcessMetricSample {
  return {
    pid: metric.pid,
    type: metric.type,
    cpuPercent: normalizeElectronCpuToMachinePercent(metric.cpu.percentCPUUsage, {
      logicalCpuCount,
    }),
    // The memory.workingSetSize unit of getAppMetrics is KB.
    rssKb: metric.memory.workingSetSize ?? 0,
    creationTime: metric.creationTime,
  };
}

export const chromiumProcessResourceSampleSource: ProcessResourceSampleSource = {
  id: "chromium",
  sample(context) {
    const metrics = app.getAppMetrics();
    const logicalCpuCount = os.cpus().length;
    const aggregates = aggregateChromiumProcessRoles({
      processes: metrics.map((metric) => toNormalizedSample(metric, logicalCpuCount)),
      pids: collectChromiumProcessRolePids(),
      now: context.now,
    });

    // ChromiumRoleAggregate is the Chromium subset of ProcessRoleSample (without heap / mcpId / hardware),
    // Moving field by field will only cause silent errors when the two field names drift.
    for (const aggregate of aggregates) {
      context.addRoleSample(aggregate);
    }
    // The total application amount of device-level events requires the exact total of this tick; this line will not be executed when a sampling error is thrown.
    // There are no device samples for this tick, and old readings are never used as current facts.
    context.addAppProcessTotals(sumChromiumRoleAggregates(aggregates));
  },
};
