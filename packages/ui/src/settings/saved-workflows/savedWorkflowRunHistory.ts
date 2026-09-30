// Grouping and presentation of running history.
// Attribution only depends on `dwf_run.name === workflow name`; the run with another name of the model does not belong to any workflow, so it is not a guess.
import type { ZCodeSavedWorkflowRun, ZCodeSavedWorkflowRunStatus } from "@zcode/shared";

/**
 * The row with the newest `updatedAt` for each name (the server orders them by time_updated
 * descending; here we just take the first one seen).
 */
export function lastRunByWorkflowName(
  runs: readonly ZCodeSavedWorkflowRun[],
): Map<string, ZCodeSavedWorkflowRun> {
  const byName = new Map<string, ZCodeSavedWorkflowRun>();
  const sorted = [...runs].sort((left, right) => right.updatedAt - left.updatedAt);
  for (const run of sorted) {
    if (run.name === undefined || byName.has(run.name)) continue;
    byName.set(run.name, run);
  }
  return byName;
}

type SavedWorkflowRunBadgeKind = "completed" | "errored" | "running" | "stopped" | "never";

/**
 * The four states of the card's "last run" badge plus "never run". pending and running are both
 * drawn as the active state. The terminal vocabulary is errored / stopped; an older CLI may still
 * send `failed` / `cancelled`, which are folded into the same meanings rather than leaving the
 * badge absent.
 */
export function savedWorkflowRunBadgeKind(
  status: ZCodeSavedWorkflowRunStatus | "errored" | "stopped" | "failed" | "cancelled" | undefined,
): SavedWorkflowRunBadgeKind {
  switch (status) {
    case undefined:
      return "never";
    case "pending":
    case "running":
      return "running";
    case "completed":
      return "completed";
    case "errored":
    case "failed":
      return "errored";
    case "stopped":
    case "cancelled":
      return "stopped";
  }
}

/** The argument chips of a run history row: `key=value`, with the value compacted as JSON. */
export function formatSavedWorkflowRunArgs(args: Record<string, unknown> | undefined): string[] {
  if (!args) return [];
  return Object.entries(args).map(
    ([key, value]) => `${key}=${typeof value === "string" ? value : JSON.stringify(value)}`,
  );
}

/** The duration of a single run (milliseconds); a non-terminal state is measured against now. */
export function savedWorkflowRunDurationMs(run: ZCodeSavedWorkflowRun, now: number): number {
  const end = run.status === "pending" || run.status === "running" ? now : run.updatedAt;
  return Math.max(0, end - run.createdAt);
}

export function formatSavedWorkflowTokens(spent: number): string {
  if (!Number.isFinite(spent)) return "—";
  if (spent >= 1_000_000) return `${(spent / 1_000_000).toFixed(1)}M`;
  if (spent >= 1_000) return `${(spent / 1_000).toFixed(1)}k`;
  return String(Math.round(spent));
}
