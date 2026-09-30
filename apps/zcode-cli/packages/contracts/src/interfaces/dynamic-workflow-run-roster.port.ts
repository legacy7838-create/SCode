// ============================================================
// **Situation Cross-section** of Dynamic Workflow Run: Stages / Subagents / Health
// ============================================================
// Detached from dynamic-workflow-run.port.ts for the same reason as dwf-journal-introspection.ts: that contract
// The max-lines limit of oxlint has been reached. The public side remains unchanged - the main port file exports every name here in place,
// The import path of `@zcode/contracts` is unchanged verbatim.
//
// Three sets of fields are hung on `DynamicWorkflowRunDetail`, which are derived when the reader reads in `getRunDetail`;
// See the notes for each type below for contracts and invariants.

// A discipline that runs through the three groups: **There is only one source of time**, that is, `dwf_event.time_created` (the event falls into the journal
// moment). It is wrong for readers to retrieve `Date.now()` now - that will mark the entire history of a week ago in a cold reading as "just".
// The whole reason for the existence of these three sets of fields is to make "how long ago" credible. Old journals that do not have this column will always use the time field
// **Absent**, do not give 0, do not give NaN.

/**
 * Where a phase stands in the situation snapshot.
 *
 * - `ahead`: the script declared it but control flow has not reached it -- the **only** state with `rounds: 0`;
 * - `current`: the run is still alive and this is the last phase it entered;
 * - `unfinished`: the run is terminal and this phase still holds unsettled asks (the process died under it);
 * - `done`: everything else.
 */
export type DynamicWorkflowRunPhaseState = "done" | "current" | "ahead" | "unfinished";

/** One phase in the situation snapshot (a `phase("…")` marker). */
export interface DynamicWorkflowRunPhaseView {
  /** The author's own wording, from the same vocabulary as `run-launched.phaseNames` / `phase-entered.name`. */
  name: string;
  state: DynamicWorkflowRunPhaseState;
  /** How many times it has been entered (re-entering under the same name counts +1). Always 0 for `ahead`, always >= 1 for the rest. */
  rounds: number;
  /** The settled / unsettled counts among the nodes born in this phase. */
  nodesSettled: number;
  nodesRunning: number;
  /**
   * The moment of the **most recent** entry, plus the moment it left on that occasion (the next `phase-entered` with a different name).
   * The most recent one rather than the first: for a phase a back edge has looped through three times, the reader wants to know "how long has this lap been inside".
   * The current phase has no leave moment; when the events carry no timestamp, both are absent together.
   */
  enteredAt?: number;
  exitedAt?: number;
}

/**
 * Where a subagent stands right now. **The read order is the write order**, the first match settles it:
 *
 * Run not terminal: `parked` (it has a question of its own sitting there waiting for an answer) -> `waiting` (the last lifecycle event of the current ask is
 * `node-waiting`: waiting for a slot or backing off) -> `executing` (an ask row is still running) -> `failed`
 * (the last settled ask failed) -> `idle`.
 *
 * Run terminal: all three living words retire -- `unfinished` (ask rows are still marked running, i.e. the process died under
 * it) -> `failed` -> `done`.
 */
export type DynamicWorkflowRunSubagentState =
  | "idle"
  | "executing"
  | "waiting"
  | "parked"
  | "done"
  | "failed"
  | "unfinished";

/**
 * The most recently observed tool call within one ask. `target` is a human-facing **clue** (a file path, a command head),
 * not the arguments themselves -- every segment of this path from the engine to here is cut along the same line, and the full arguments never get in.
 */
export interface DynamicWorkflowRunSubagentLastTool {
  name: string;
  target?: string;
  /** The persisted moment of the `node-progress` that observed it; absent when the event has no timestamp. */
  at?: number;
}

/** The ask this subagent is running right now (present while an ask row is still `running`). */
export interface DynamicWorkflowRunSubagentAsk {
  siteId: string;
  ordinal: number;
  /** Which ask of this subagent it is (the journal's `actorSeq`); absent on old rows that do not store this column. */
  actorSeq?: number;
  /**
   * The first 240 characters of the instruction the author wrote for this ask. The read surface answers "what was this subagent sent off to do" from it -- the phase alone
   * can only say "it is running". Absent on old journals without `instructionsHead`, and **it never goes and reads the full instruction to fill it in**.
   */
  instructionsHead?: string;
  /** The `node-dispatched` moment of this ask; absent when the event has no timestamp. */
  startedAt?: number;
  /**
   * How many rounds have been resolved and how many tool calls have been made in total (arriving with `node-progress`).
   * Always absent on old journals without `node-progress` -- absence reads as "unknown", while `0` reads as
   * "not a single tool call was made", and those are two different facts.
   */
  turn?: number;
  toolCalls?: number;
  lastTool?: DynamicWorkflowRunSubagentLastTool;
}

/** What the current ask is waiting for (from the last `node-waiting` observation). */
export interface DynamicWorkflowRunSubagentWait {
  /** `slot` = waiting on the process-level admission gate; `backoff` = the runner is backing off and retrying. */
  cause: "slot" | "backoff";
  reason?: string;
  retryAfterMs?: number;
  /**
   * The moment it **entered this wait** (that is, the first `node-waiting` after the most recent non-waiting
   * lifecycle event), not the moment of the last one: a backoff ladder fires several in a row, while the reader is asking "how long has it been stuck".
   * Absent when the event has no timestamp.
   */
  since?: number;
}

/** One subagent in the situation snapshot (= one actor instance). */
export interface DynamicWorkflowRunSubagentView {
  siteId: string;
  ordinal: number;
  /** The effective name of `agent("poet")`; absent for an anonymous actor, and no fallback label is synthesized here (same as pendingQuestions). */
  name?: string;
  state: DynamicWorkflowRunSubagentState;
  /** The phase its current (or last) ask was born in; when neither can be read, fall back to its own birth phase. */
  phaseName?: string;
  currentAsk?: DynamicWorkflowRunSubagentAsk;
  wait?: DynamicWorkflowRunSubagentWait;
  /**
   * The question it is parked on (`pendingQuestions[].qid`). **It can only be present when the resident table really is reachable**:
   * a read where `health.pendingQuestionsKnown` is false has no idea whether anyone is waiting; see that field.
   */
  parkedOn?: string;
  /** The number of asks it has settled / how many of those failed, plus the sum of the tokens of those asks (the node row's `stats`). */
  stepsSettled: number;
  stepsFailed: number;
  tokens: number;
  /** The moment it was last observed moving (the last progress-class event of any node under its name). */
  lastProgressAt?: number;
}

/**
 * The run-level concurrency state: how far it is squeezed right now, what it should be, and why and since when.
 *
 * **The whole object is present only when `effective < cap`** (the same absence rule as `maxConcurrency` on the detail surface):
 * a run that is running at its own bound has nothing to say, and being present here means "it is being throttled right now".
 */
export interface DynamicWorkflowRunConcurrencyHealth {
  /** The count the governor is actually letting through right now = min(the shared gate, {@link cap}). */
  effective: number;
  /**
   * **This run's own** upper bound: the number the user set for it if they did, and only otherwise the machine ceiling.
   *
   * It deliberately does not report the ceiling: a run started with `max_concurrency: 3` on a six-core machine would forever display as "3/6",
   * which reads like rate limiting, while it is running exactly on the bound the user set by hand -- that bound is a setting, not a fault.
   */
  cap: number;
  /** The reason on the last `concurrency-changed` event (`rate_limited` / `recovered` ...). */
  reason?: string;
  /** The persisted moment of that event; absent when it carries no timestamp. */
  since?: number;
}

/** Whether the run as a whole is still moving. */
export interface DynamicWorkflowRunHealth {
  /** The moment of the last progress-class event across the whole run. */
  lastProgressAt?: number;
  /**
   * The moment of the last `run-stalled`, with **no** progress-class event after it.
   * "Waiting for a slot" is not progress -- that wait is the stall itself, and counting it would make the stall permanently invisible.
   */
  stalledSince?: number;
  concurrency?: DynamicWorkflowRunConcurrencyHealth;
  /** The number of consecutive failed asks **at the end** in settlement order: 3 in a row and 3 scattered are two different situations. */
  consecutiveFailures: number;
  /** The number of settlements that hit the completed cache (`node-settled { cached: true }`). */
  cachedSteps: number;
  /** **Terminal runs only**: the number of node rows still marked `running`, i.e. the ones the process died under. Absent when it is 0. */
  leftoverRunning?: number;
  /**
   * Whether this read **can** answer "is there a question waiting for an answer".
   *
   * A parked question only lives in the memory of the process that asked it (see {@link DynamicWorkflowRunDetail.pendingQuestions}),
   * so when reading an in-flight run owned by another process, "there are no pending questions" and "unknown" look exactly alike -- and those two
   * are two completely different next steps for a model. The condition for it to be true: this session holds the registry entry of this run, or the run is
   * already terminal (a terminal run by definition has nobody listening). When false, the whole `pendingQuestions` field is absent, and no
   * subagent will ever be reported as `parked`.
   */
  pendingQuestionsKnown: boolean;
}
