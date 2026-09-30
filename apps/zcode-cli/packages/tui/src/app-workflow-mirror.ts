// ============================================================
// workflowRuns image on TUI side
// ============================================================
// Single clock: The running state is maintained **only** by the shared reducer event-by-event reduction (@zcode/shared's
// workflow-runs-reducer, the same implementation as the v4 projection), plus one-time reseeding during cold start/recovery.
// There is no polling, no setInterval - the legacy workflow panel is fully repulsed every second, which is a negative example.
//
// The image has two more things than the protocol status key, both of which are intentional:
//   1. `logTailByRunId`: log events are not in workflowRuns schema (they only enter the journal event log),
//      However, the expanded details need to display the tail of the log, so TUI keeps the most recent ones (bounded).
//   2. `seedByRunId`: **Display meta information** (label / updatedAt) brought back from listDynamicWorkflowRuns by cold reseeding.
//      Running status (status, steps, usage, resumable) **not** from the summary: journal events during cold start/`/resume`
//      After `replayWorkflowRuns` is played back into the same reducer (cold playback), the run in the image is the same as before restarting byte by byte; `resumable` is the status bit, which is controlled by CLI in
//      The run-settled payload rule - the existing rule "render server boolean" of dynamic-workflow-run.port.ts remains the same.

import {
  reduceWorkflowRunsState,
  workflowRunStepCounts as sharedWorkflowRunStepCounts,
  type WorkflowRunActor,
  type WorkflowRunUsage,
  type WorkflowRunProgressEnvelope,
  type WorkflowRunState,
  type WorkflowRunsState,
} from "@zcode/shared/zcode-protocol-v4";

/** The bounds of the log tail: both the entry count and the per-entry length are limited, so a talkative run cannot eat the mirror unbounded. */
const TUI_WORKFLOW_LOG_TAIL_LIMITS = {
  maxEntries: 10,
  maxEntryLength: 200,
} as const;

/**
 * The **display** fields of the cold reseed summary that the TUI renders (runtime state always goes through
 * replay, see the file header).
 *
 * `label` / `updatedAt` are additive optional (see the "revision during implementation" line on the spec's
 * `/dwf` boundary): they are undefined until the server carries them, and the render side always falls back
 * to runId, never fabricating a fake label here.
 */
export type TuiWorkflowRunSeed = {
  runId: string;
  label?: string;
  updatedAt?: number;
};

export type TuiWorkflowMirror = {
  /** The authoritative runtime state maintained by the shared reducer. */
  state: WorkflowRunsState;
  logTailByRunId: Readonly<Record<string, readonly string[]>>;
  seedByRunId: Readonly<Record<string, TuiWorkflowRunSeed>>;
};

export const EMPTY_TUI_WORKFLOW_MIRROR: TuiWorkflowMirror = {
  state: { revision: 0, runs: [] },
  logTailByRunId: {},
  seedByRunId: {},
};

/**
 * One dwf progress event -> a new mirror.
 *
 * **With no change it returns the very same reference it was handed in**, so React's setState skips the
 * re-render outright: the shared reducer's "null = semantically unchanged" contract lands here as "no
 * repaint", with no extra equality check needed.
 */
export function applyWorkflowProgressToMirror(
  mirror: TuiWorkflowMirror,
  envelope: WorkflowRunProgressEnvelope,
): TuiWorkflowMirror {
  const state = reduceWorkflowRunsState(mirror.state, envelope);
  const logTailByRunId = appendWorkflowLogTail(mirror.logTailByRunId, envelope);
  if (state === null && logTailByRunId === mirror.logTailByRunId) return mirror;
  return {
    ...mirror,
    ...(state === null ? {} : { state }),
    logTailByRunId,
  };
}

/**
 * Cold reseed: merges the **display names** from the session-level summary of `listDynamicWorkflowRuns` into
 * the mirror.
 *
 * It only fills in metadata and **does not** fabricate runtime state entries: runtime state comes from cold
 * replay (`replayWorkflowRuns` -> the shared reducer) and is byte-identical to before the restart; nothing the
 * summary lacks (beyond the label) is invented here.
 */
export function seedWorkflowMirror(
  mirror: TuiWorkflowMirror,
  seeds: readonly TuiWorkflowRunSeed[],
): TuiWorkflowMirror {
  if (seeds.length === 0) return mirror;
  const seedByRunId = { ...mirror.seedByRunId };
  let changed = false;
  for (const seed of seeds) {
    if (!seed.runId) continue;
    const existing = seedByRunId[seed.runId];
    if (existing && sameSeed(existing, seed)) continue;
    seedByRunId[seed.runId] = seed;
    changed = true;
  }
  return changed ? { ...mirror, seedByRunId } : mirror;
}

/**
 * Step progress: **settled / scheduled** (settled / observed).
 *
 * A dynamic workflow has no static total, so the denominator is the number of scheduled nodes; it never
 * pretends to be a whole-run percentage.
 *
 * There is exactly one way to count: `workflowRunStepCounts` in @zcode/shared (shared by the run card, the
 * timeline summary and here). This used to count `nodes` itself, so a run that hit the node limit showed three
 * different numbers on three read surfaces, and all three were smaller than the true step count: hitting the
 * limit is a **rejection of new work**, and a rejected instance is not in `nodes` at all, only in the two
 * usage counters. This function keeps only the TUI's field names (the card and the i18n strings say
 * nodesSettled / nodesTotal).
 */
export function workflowRunStepCounts(run: WorkflowRunState): {
  nodesSettled: number;
  nodesTotal: number;
} {
  const { total, settled } = sharedWorkflowRunStepCounts(run);
  return { nodesSettled: settled, nodesTotal: total };
}

/** All the facts the card rendering needs: making the view a pure function of its props (TUI tests invoke components functionally). */
export type TuiWorkflowCard = {
  runId: string;
  status: WorkflowRunState["status"];
  /** The reason for `stopped`; the reducer carries it over from the run-settled payload. */
  stopReason?: WorkflowRunState["stopReason"];
  nodesSettled: number;
  nodesTotal: number;
  label?: string;
  resumable?: boolean;
  usage?: WorkflowRunUsage;
  actors: readonly WorkflowRunActor[];
  logTail: readonly string[];
  error?: string;
  resultPreview?: string;
  truncated?: boolean;
};

/**
 * The tool card -> workflow run link, by `toolCallId` (in the schema's own comment it is "the tool card ->
 * detail page linking key").
 * It follows the same rule as the GUI's `buildWorkflowRunByToolCallId`. Runtime state has a single source,
 * the mirror state (live events and cold replay pass through the same reducer), and the reseed only supplies
 * display names.
 */
export function buildTuiWorkflowCardIndex(
  mirror: TuiWorkflowMirror,
): ReadonlyMap<string, TuiWorkflowCard> {
  const byToolCallId = new Map<string, TuiWorkflowCard>();
  for (const run of mirror.state.runs) {
    // A run without toolCallId has no connectable cards and is not entered into the table.
    if (!run.toolCallId) continue;
    byToolCallId.set(run.toolCallId, cardFromRun(run, mirror));
  }
  return byToolCallId;
}

function cardFromRun(run: WorkflowRunState, mirror: TuiWorkflowMirror): TuiWorkflowCard {
  const { nodesSettled, nodesTotal } = workflowRunStepCounts(run);
  const seed = mirror.seedByRunId[run.runId];
  return {
    runId: run.runId,
    status: run.status,
    ...(run.stopReason === undefined ? {} : { stopReason: run.stopReason }),
    nodesSettled,
    nodesTotal,
    // The label is only known by the server; projection entries do not carry it, and reseeding is used when reseeding is hit.
    ...(seed?.label === undefined ? {} : { label: seed.label }),
    // resumable is a status bit (CLI arbitrates on run-settled loads, reducer handles), TUI does not re-derive.
    ...(run.resumable === undefined ? {} : { resumable: run.resumable }),
    usage: run.usage,
    actors: run.actors,
    logTail: mirror.logTailByRunId[run.runId] ?? [],
    ...(run.error === undefined ? {} : { error: run.error }),
    ...(run.resultPreview === undefined ? {} : { resultPreview: run.resultPreview }),
    ...(run.truncated === undefined ? {} : { truncated: run.truncated }),
  };
}

function appendWorkflowLogTail(
  current: Readonly<Record<string, readonly string[]>>,
  envelope: WorkflowRunProgressEnvelope,
): Readonly<Record<string, readonly string[]>> {
  if (envelope.eventType !== "log" || !envelope.runId) return current;
  const message = logMessage(envelope.payload);
  if (message === undefined) return current;
  const previous = current[envelope.runId] ?? [];
  const appended = [...previous, message].slice(-TUI_WORKFLOW_LOG_TAIL_LIMITS.maxEntries);
  return { ...current, [envelope.runId]: appended };
}

function logMessage(payload: Record<string, unknown> | undefined): string | undefined {
  if (!payload) return undefined;
  const raw = payload.message;
  if (typeof raw !== "string") return undefined;
  const collapsed = raw.replace(/\s+/gu, " ").trim();
  if (collapsed.length === 0) return undefined;
  return collapsed.slice(0, TUI_WORKFLOW_LOG_TAIL_LIMITS.maxEntryLength);
}

function sameSeed(left: TuiWorkflowRunSeed, right: TuiWorkflowRunSeed): boolean {
  return left.label === right.label && left.updatedAt === right.updatedAt;
}
