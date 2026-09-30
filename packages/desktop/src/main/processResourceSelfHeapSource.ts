/**
 * Sample source for the heap readings that host and scheduler sample for themselves (the registry's
 * third line).
 *
 * Each of the two utilityProcesses reads `process.memoryUsage()` and `process.cpuUsage()` once
 * every 60 seconds and ships the sample to main through parentPort; the message dispatch point
 * calls the `ingestXxx` here to store the most recent reading, and the next 10-second tick folds
 * it into the complete sample for the same role as `heap_used_kb_mean` / `heap_used_kb_peak`.
 *
 * Heap only: the sole source for CPU and RSS is main's `getAppMetrics()` (the role definition
 * table), and mixing 60-second self-sampled readings into a 10-second series would pollute
 * `sample_count` and the statistics. Every reading contributes exactly one heap sample (cleared on
 * delivery); a stale value never stands in for the current fact.
 */

import { nodeSelfResourceSampleSchema, type ProcessResourceRole } from "@zcode/shared";
import type { ProcessResourceSampleSource } from "./processResourceSampleSources.js";

/** Role → Heap reads not yet delivered (KB). */
const pendingHeapUsedKb = new Map<ProcessResourceRole, number>();

/**
 * Press `unknown` on the intake port to close: host, go to host, respond to schema, scheduler, go to main, there is no private protocol for unified verification,
 * The two transmission links form the same trust boundary here, and the verification is only at this point.
 * Illegal messages (missing fields, wrong types, and extra fields) are discarded directly without throwing errors.
 */
function ingest(role: ProcessResourceRole, raw: unknown): void {
  const parsed = nodeSelfResourceSampleSchema.safeParse(raw);
  if (!parsed.success) {
    return;
  }
  // Multi-window hosts will arrive at the same tick; later arriving small heaps cannot cover earlier arriving peaks.
  pendingHeapUsedKb.set(role, Math.max(pendingHeapUsedKb.get(role) ?? 0, parsed.data.heapUsedKb));
}

export function ingestHostSelfResourceSample(raw: unknown): void {
  ingest("host", raw);
}

export function ingestSchedulerSelfResourceSample(raw: unknown): void {
  ingest("scheduler", raw);
}

export const selfHeapProcessResourceSampleSource: ProcessResourceSampleSource = {
  id: "self_heap",
  sample(context) {
    // Take it away first and then deliver it: a delivery error will not leave the old reading to the next tick.
    const delivering = [...pendingHeapUsedKb];
    pendingHeapUsedKb.clear();
    for (const [role, heapUsedKb] of delivering) {
      context.addRoleHeapSample(role, heapUsedKb);
    }
  },
  reset() {
    pendingHeapUsedKb.clear();
  },
};
