/**
 * Whole-machine normalization for Electron's `percentCPUUsage`.
 *
 * The whole-machine CPU figure the resource manager UI shows always goes through this single
 * normalization implementation: on darwin / win32 Chromium has already normalized it across the
 * whole machine, while on linux it is a per-core figure that has to be divided by the logical core
 * count.
 */

import os from "node:os";

export function normalizeElectronCpuToMachinePercent(
  cpu: number | null | undefined,
  options: { platform?: NodeJS.Platform; logicalCpuCount?: number } = {},
): number {
  const normalizedCpu = typeof cpu === "number" && Number.isFinite(cpu) ? cpu : 0;
  const platform = options.platform ?? process.platform;
  if (platform !== "linux") {
    return normalizedCpu;
  }
  const logicalCpuCount = options.logicalCpuCount ?? os.cpus().length;
  const scale = Number.isFinite(logicalCpuCount) && logicalCpuCount > 0 ? logicalCpuCount : 1;
  return normalizedCpu / scale;
}
