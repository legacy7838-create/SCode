// ============================================================
// There are three forms of GetWorkflowRun model: `<health>` / `<phases>` / `<subagents>` (+ `<log_tail>`)
// ============================================================
// Unpack from get-workflow-run-format.ts:
// There's the "one fact per block" skeleton, and here are three **tables** - column, alignment, and phase-by-phase wording all in one piece.
//
// Two disciplines:
//   1. Absence means not writing. There is no age without timestamps, there are no turn / tool calls without `node-progress`,
//      Never replace "don't know" with 0 - `0 tool calls` is one thing, absence is another.
//   2. The column width is calculated from these rows (with an upper bound), not a hard-coded magic number: a roster with only two sub-agents
//      You shouldn't leave twenty columns empty for a long name that doesn't exist.

import type {
  GetWorkflowRunOutput,
  GetWorkflowRunPhase,
  GetWorkflowRunSubagent,
} from "@zcode/contracts";
import {
  escapeWorkflowRunText,
  formatRelativeAge,
  formatWorkflowRunCount,
  formatWorkflowRunDuration,
} from "./workflow-run-introspection.js";

/** The gap between columns: two spaces. One space would make "name address" read as a single word. */
const COLUMN_GAP = "  ";
/** The upper bound on the width of an aligned column. A value beyond it is written as-is and makes that row longer, instead of stretching the whole table. */
const MAX_COLUMN_WIDTH = 24;
/** The indentation of the task summary row: it belongs to the previous line, it is not a new fact on a line of its own. */
const TASK_LINE_INDENT = "  ";

function padColumn(value: string, width: number): string {
  return value.length >= width ? value : value + " ".repeat(width - value.length);
}

function columnWidth(values: readonly string[]): number {
  return Math.min(
    MAX_COLUMN_WIDTH,
    values.reduce((widest, value) => Math.max(widest, value.length), 0),
  );
}

/** Join several segments into one line: empty segments (= facts that are not known) simply disappear, leaving no two adjacent gaps. */
function joinCells(cells: readonly string[]): string {
  // End trim: The padding of the last column becomes a trailing space, which is a line of invisible noise (the rows ahead are full of it).
  return cells
    .filter((cell) => cell.length > 0)
    .join(COLUMN_GAP)
    .trimEnd();
}

// ————————————————————————————————————————————————
// <health>
// ————————————————————————————————————————————————

/**
 * Whether the run as a whole is still moving, as one `key=value` line.
 *
 * `stalled` is only meaningful for a live run (a terminal run is of course not moving), and a terminal run gets one extra
 * sentence of **leftover** explanation: the rows below marked running are residue left behind because the process died under
 * them, not live work. This is one of only two places in this tool that say out loud what it does not know — silence would
 * be read as "they are still running".
 */
export function formatWorkflowRunHealthBlock(run: GetWorkflowRunOutput, terminal: boolean): string {
  const now = run.generatedAt;
  const health = run.health;
  const cells: string[] = [];

  const lastProgress = formatRelativeAge(now, health.lastProgressAt);
  if (lastProgress !== undefined) cells.push(`last_progress=${lastProgress}`);

  if (health.concurrency !== undefined) {
    const { effective, cap, reason, since } = health.concurrency;
    const sinceAge = formatRelativeAge(now, since);
    const why = [
      reason === undefined ? "" : escapeWorkflowRunText(reason),
      sinceAge === undefined ? "" : `since ${sinceAge}`,
    ]
      .filter((part) => part.length > 0)
      .join(" ");
    cells.push(`concurrency=${effective}/${cap}${why.length === 0 ? "" : ` (${why})`}`);
  }

  if (!terminal) {
    const stalledAge = formatRelativeAge(now, health.stalledSince);
    cells.push(`stalled=${stalledAge === undefined ? "no" : `since ${stalledAge}`}`);
  }

  cells.push(`consecutive_failures=${health.consecutiveFailures}`);
  cells.push(`cached_steps=${health.cachedSteps}`);

  const leftover = terminal ? health.leftoverRunning : undefined;
  const note =
    leftover === undefined || leftover === 0
      ? ""
      : `\nThe ${leftover} "running" step${leftover === 1 ? "" : "s"} below ${
          leftover === 1 ? "is a leftover" : "are leftovers"
        } of the exited process, not live work.`;
  return `<health>${joinCells(cells)}${note}</health>`;
}

// ————————————————————————————————————————————————
// <phases>
// ————————————————————————————————————————————————

/** The phase table: one phase per row, in declaration order. An `ahead` row has only a name and a status — it has not happened yet. */
export function formatWorkflowRunPhasesBlock(
  run: GetWorkflowRunOutput,
  terminal: boolean,
): string | undefined {
  const phases = run.phases;
  if (phases === undefined || phases.length === 0) return undefined;

  const names = phases.map((phase) => escapeWorkflowRunText(phase.name));
  const nameWidth = columnWidth(names);
  const stateWidth = columnWidth(phases.map((phase) => phase.state));

  const lines = phases.map((phase, index) =>
    joinCells([
      `${index + 1}. ${padColumn(names[index]!, nameWidth)}`,
      padColumn(phase.state, stateWidth),
      phaseRoundsCell(phase),
      phaseCountsCell(phase, terminal),
      phaseDurationCell(phase, run.generatedAt, terminal),
    ]),
  );
  return `<phases>\n${lines.join("\n")}\n</phases>`;
}

function phaseRoundsCell(phase: GetWorkflowRunPhase): string {
  // Rounds of 0 can only be `ahead`: a stage that has not been entered cannot say "how many times it has been entered".
  if (phase.rounds === 0) return "";
  return `${phase.rounds} round${phase.rounds === 1 ? "" : "s"}`;
}

function phaseCountsCell(phase: GetWorkflowRunPhase, terminal: boolean): string {
  if (phase.nodesRunning > 0) {
    // The "still running" in the final state run means that it has not been settled and is not moving.
    return `${phase.nodesSettled} settled, ${phase.nodesRunning} ${terminal ? "unfinished" : "running"}`;
  }
  if (phase.nodesSettled === 0) return "";
  return `${phase.nodesSettled} step${phase.nodesSettled === 1 ? "" : "s"} settled`;
}

function phaseDurationCell(phase: GetWorkflowRunPhase, now: number, terminal: boolean): string {
  if (phase.enteredAt === undefined) return "";
  if (phase.exitedAt !== undefined)
    return formatWorkflowRunDuration(phase.exitedAt - phase.enteredAt);
  // There is no departure moment: the living run says "until now", the final run says nothing - its departure moment is not recorded,
  // Subtracting "now" during reading is equivalent to counting "the few hours after the death of the process" into that stage.
  return terminal ? "" : `${formatWorkflowRunDuration(now - phase.enteredAt)} so far`;
}

// ————————————————————————————————————————————————
// <subagents>
// ————————————————————————————————————————————————

/**
 * The roster: one subagent per row, plus one indented `task:` row (when there is a task summary).
 *
 * A row reads as "who · where · which phase · which stage · what it is doing · how many tokens it has spent", where
 * "what it is doing" forks by phase — a running one names its ask and tool, a waiting one names what it waits for, a parked
 * one names which question it is parked on and for how long. This is exactly why the tool exists: the model has to be able
 * to see at a glance "who is stuck".
 */
export function formatWorkflowRunSubagentsBlock(run: GetWorkflowRunOutput): string {
  if (run.subagents.length === 0) return "<subagents>No subagents created yet.</subagents>";

  const askedAtByQid = new Map<string, number>();
  for (const question of run.pendingQuestions ?? [])
    askedAtByQid.set(question.qid, question.askedAt);

  const names = run.subagents.map((subagent) =>
    subagent.name === undefined ? "" : escapeWorkflowRunText(subagent.name),
  );
  const addresses = run.subagents.map(
    (subagent) => `${escapeWorkflowRunText(subagent.siteId)}@${subagent.ordinal}`,
  );
  const nameWidth = columnWidth(names);
  const addressWidth = columnWidth(addresses);
  const stateWidth = columnWidth(run.subagents.map((subagent) => subagent.state));

  const lines: string[] = [];
  run.subagents.forEach((subagent, index) => {
    lines.push(
      joinCells([
        // Anonymous actors do not synthesize surnames (same as pendingQuestions): leave blank, the address column is still aligned.
        padColumn(names[index]!, nameWidth),
        padColumn(addresses[index]!, addressWidth),
        padColumn(subagent.state, stateWidth),
        subagent.phaseName === undefined
          ? ""
          : `phase ${escapeWorkflowRunText(subagent.phaseName)}`,
        subagentActivityCell(subagent, run.generatedAt, askedAtByQid),
        subagent.tokens > 0 ? `${formatWorkflowRunCount(subagent.tokens)} tokens` : "",
      ]),
    );
    const head = subagent.currentAsk?.instructionsHead;
    if (head !== undefined && head.length > 0) {
      lines.push(`${TASK_LINE_INDENT}task: ${escapeWorkflowRunText(head)}`);
    }
  });
  const truncated =
    run.subagentsTruncated === true
      ? `\nOnly the first ${run.subagents.length} subagents are listed; this run has more.`
      : "";
  return `<subagents>\n${lines.join("\n")}${truncated}\n</subagents>`;
}

function subagentActivityCell(
  subagent: GetWorkflowRunSubagent,
  now: number,
  askedAtByQid: ReadonlyMap<string, number>,
): string {
  if (subagent.state === "parked" && subagent.parkedOn !== undefined) {
    const waited = formatRelativeAge(now, askedAtByQid.get(subagent.parkedOn));
    const forHow = waited === undefined ? "" : ` for ${waited.replace(/ ago$/u, "")}`;
    return `on question ${escapeWorkflowRunText(subagent.parkedOn)}${forHow}`;
  }
  if (subagent.state === "waiting") return waitCell(subagent, now);
  if (subagent.state === "unfinished" && subagent.currentAsk !== undefined) {
    return `${askAddress(subagent.currentAsk)} was in flight at the stop`;
  }
  if (subagent.currentAsk !== undefined) return executingCell(subagent, now);
  return settledCell(subagent);
}

function askAddress(ask: NonNullable<GetWorkflowRunSubagent["currentAsk"]>): string {
  // actorSeq is the 0 base of the journal; the model says "which step" is based on the human-readable 1 base.
  const step = ask.actorSeq === undefined ? "" : ` (step ${ask.actorSeq + 1})`;
  return `${escapeWorkflowRunText(ask.siteId)}@${ask.ordinal}${step}`;
}

function executingCell(subagent: GetWorkflowRunSubagent, now: number): string {
  const ask = subagent.currentAsk!;
  const parts = [askAddress(ask)];
  const onStep = formatRelativeAge(now, ask.startedAt);
  if (onStep !== undefined) parts.push(`${onStep.replace(/ ago$/u, "")} on this step`);
  if (ask.turn !== undefined) parts.push(`turn ${ask.turn}`);
  if (ask.toolCalls !== undefined)
    parts.push(`${ask.toolCalls} tool call${ask.toolCalls === 1 ? "" : "s"}`);
  if (ask.lastTool !== undefined) {
    const target =
      ask.lastTool.target === undefined ? "" : ` ${escapeWorkflowRunText(ask.lastTool.target)}`;
    const age = formatRelativeAge(now, ask.lastTool.at);
    parts.push(
      `last ${escapeWorkflowRunText(ask.lastTool.name)}${target}${age === undefined ? "" : ` ${age}`}`,
    );
  }
  return parts.join(", ");
}

function waitCell(subagent: GetWorkflowRunSubagent, now: number): string {
  const wait = subagent.wait;
  if (wait === undefined) return "";
  const waited = formatRelativeAge(now, wait.since);
  const forHow = waited === undefined ? "" : ` for ${waited.replace(/ ago$/u, "")}`;
  if (wait.cause === "slot") return `waiting for a slot${forHow}`;
  const after = wait.reason === undefined ? "" : ` after ${escapeWorkflowRunText(wait.reason)}`;
  const retry =
    wait.retryAfterMs === undefined
      ? ""
      : `, retry in ${formatWorkflowRunDuration(wait.retryAfterMs)}`;
  // "How long have you been waiting" is followed by the reason, and "how long do you have to wait" is the end: when the two durations are next to each other, the reader can't tell which one is which.
  return `backoff${after}${forHow}${retry}`;
}

function settledCell(subagent: GetWorkflowRunSubagent): string {
  if (subagent.stepsSettled === 0 && subagent.stepsFailed === 0) return "";
  const failed = subagent.stepsFailed > 0 ? `, ${subagent.stepsFailed} failed` : "";
  return `${subagent.stepsSettled} step${subagent.stepsSettled === 1 ? "" : "s"}${failed}`;
}

// ————————————————————————————————————————————————
// <log_tail>
// ————————————————————————————————————————————————

/** The narrative tail. When an event carries its persistence time, the age is prefixed; older journals have no such column, so those rows only have a sequence number. */
export function formatWorkflowRunLogTailBlock(run: GetWorkflowRunOutput): string {
  if (run.logTail.length === 0) return "<log_tail>No log() narration recorded yet.</log_tail>";
  const lines = run.logTail.map((entry) => {
    const age = formatRelativeAge(run.generatedAt, entry.at);
    return joinCells([`[${entry.sequence}]`, age ?? "", escapeWorkflowRunText(entry.message)]);
  });
  return `<log_tail>\n${lines.join("\n")}\n</log_tail>`;
}
