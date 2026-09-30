// ============================================================
// workflowRuns: the real-time running state schema of dwf engine run (the workflowRuns key of snapshot.ts)
// ============================================================
// Detached from snapshot.ts: this vocabulary is self-contained (run / actor / node / usage / limits),
// Detach snapshot.ts to return it to the max-lines limit (same precedent as workspace-hook-review.ts).

import { z } from "zod";

import { workflowRunArtifactSummarySchema } from "./workflow-artifacts.js";

// ── workflowRuns: the real-time running state of dwf engine run──
// The same pattern as subagents: the running state belongs to the conversation's authoritative projection, not the renderer's query cache.
// An engine RunEvent → A session event → The key level here is completely replaced, so there is no dual clock of "event + check RPC".
export const WORKFLOW_RUNS_LIMITS = {
  /** The most recent few runs; beyond that the oldest is evicted. */
  maxRuns: 8,
  /**
   * actors and nodes use the same capacity bound, so that a node can never be displayable while the
   * subagent it belongs to has already been truncated away.
   * Key-level deltas make each event carry only what changed; the capacity bounds limit the size of
   * a single run's projection, and limit the resource cost of a misbehaving script that keeps
   * creating entries. The total across runs is controlled by {@link maxTotalEntries}.
   * This is a capacity limit on display state; it does not limit how many subagents the engine
   * actually runs.
   */
  maxActors: 1_024,
  maxNodes: 1_024,
  /**
   * The entry budget for the whole state key: the sum of `nodes.length + actors.length` over all
   * runs.
   *
   * The per-run bound times {@link maxRuns} is 16384 entries, which at roughly 150 bytes each is
   * ~2.5 MB — not far from the 16 MiB snapshot cap, and the snapshot has to be serialized in
   * full. The budget presses the worst case back to ~1 MB, at the cost that the **oldest terminal
   * runs** leave early (their complete facts are still in the journal and the detail page can
   * still find them). When over budget the reduction only evicts terminal runs; it never touches a
   * running run, and never touches the run the event belongs to.
   */
  maxTotalEntries: 6_144,
  /**
   * The **display** budget of the detail page's Results section, deliberately far smaller than the
   * engine's run-level report cap (256 entries): the bound on the protocol wire is a display
   * budget, the engine's bound is the contract, and the two need not be equal. Entries beyond this
   * bound are still in the journal (`dwf_node.kind = "report"`); they just do not enter this
   * high-frequency state key.
   */
  maxReports: 64,
  maxReportPreviewLength: 2_048,
  maxResultPreviewLength: 2_048,
  maxErrorLength: 2_048,
  /**
   * The number of escalated questions parked at the same time. The real upper bound on the engine
   * side is 3 per ask × the number of asks in flight (maxConcurrency), so 32 suffices under any
   * realistic caps; it is also a line of defence — a runaway script must not be able to blow up a
   * high-frequency state key.
   */
  maxPendingQuestions: 32,
  /** Display bound for the question and the supplementary explanation. Same value as the event payload's string bound (2048), so the normal path never truncates. */
  maxQuestionLength: 2_048,
  /** Upper bound for the provider key of a concurrency bucket (`${providerId}/${modelId}`). */
  maxConcurrencyKeyLength: 256,
  /**
   * Wire bound for the subagent model string (`providerId/modelId`, optionally with a
   * `$reasoningLevel` suffix). Same value as the concurrency bucket's provider key: the two are the
   * same family of identifier strings, except that this one may carry an extra reasoning-level
   * suffix.
   */
  maxSubagentModelLength: 256,
  /**
   * The bound on `run.concurrencyCeiling`. The ceiling is derived as `min(16, cores − 2)`, and this
   * bound only blocks bad payloads (a value outside the bounds is read as unreadable by the
   * reducer, which keeps the known value).
   */
  maxConcurrencyCeiling: 1_024,
  /**
   * Wire bound for the subagent display name (the same value for actor.name and
   * pendingQuestion.actorName). The name is an arbitrary string written by the script author
   * (`agent("reader-" + paths.join("+"))`), and the reducer must trim it to this bound before it
   * goes on the wire: a 131-character name once made every frame after the parent session be
   * rejected by the renderer, permanently killing the subscription.
   */
  maxActorNameLength: 128,
  /**
   * The number of user-facing artifacts. **The same value** as the engine-side
   * `ARTIFACT_CAPS.maxArtifactsPerRun`, for the opposite reason to maxReports' "display budget <
   * engine contract": the engine's artifact cap is 32 to begin with, and pressing the display bound
   * lower would only make a script running at the cap silently lose a few cards in the sidebar —
   * and those cards are the entire reason this feature exists.
   */
  maxArtifacts: 32,
  /**
   * The number of phases that have been entered. Same value as the display payload's
   * `CREATE_WORKFLOW_GRAPH_MAX_PHASES`: a phase that cannot be drawn on the timeline need not be
   * recorded in the projection either.
   */
  maxPhases: 32,
  /** Wire bound for a phase name, the same value as display's `CREATE_WORKFLOW_GRAPH_MAX_NAME_CHARS` (the UI relates the two sides by name). */
  maxPhaseNameLength: 128,
  /**
   * The bound on one ask's **task summary** (the `instructionsHead` of `node-queued`). Same value
   * as the engine-side `INSTRUCTIONS_HEAD_MAX_CHARS`: that head is already cut to this bound, and
   * this is the second gate on the wire. 240 is the length needed to "tell at a glance what this
   * subagent was sent off to do" — anything longer would be shipping the full instruction text on
   * the protocol wire, and the full instruction text has two places to go: the journal and the
   * subagent transcript.
   */
  maxInstructionsHeadLength: 240,
  /** Bound on the tool name of the most recent tool call (the same order of magnitude as an actor/node siteId — a tool name is an identifier, not text). */
  maxLastToolNameLength: 64,
  /**
   * The bound on the **target** of the most recent tool call (a file path, a command head). Same
   * value as the engine-side `LAST_TOOL_TARGET_MAX_CHARS`. This bound is also a safety bound: it
   * only fits one path or command head, and cannot fit the full argument list or file contents —
   * the latter two must never appear on this high-frequency state key.
   */
  maxLastToolTargetLength: 120,
} as const;

/**
 * The actors / nodes bounds compiled into **legacy consumers** (the generation without the
 * `workflowRunDeltas` capability).
 *
 * ⚠ These two numbers **must never change**: they are not our bounds, they are the validation
 * bounds inside someone else's binary. A payload over the bound does not lose one key — it makes
 * the whole `state.updated` patch fail to parse and the whole frame get dropped, and that
 * subscription goes silent forever. So frames for such subscribers must pass through
 * `clampWorkflowRunsForLegacy` first.
 *
 * The "first 256 entries" is not arbitrary: the legacy reduction rejects new entries on hitting
 * the bound, so what it produced is exactly the earliest 256.
 */
export const WORKFLOW_RUNS_LEGACY_LIMITS = {
  maxActors: 256,
  maxNodes: 256,
} as const;

/**
 * A phase the control flow has entered (a `phase("…")` marker). `name` is the author's original
 * wording (the timeline relates display's `phases[].name` by it); `rounds` is the number of
 * entries — monotonic (the reducer takes a max), so the prefix replayed on resume does not double
 * it.
 */
export const workflowRunPhaseSchema = z.object({
  name: z.string().min(1).max(WORKFLOW_RUNS_LIMITS.maxPhaseNameLength),
  rounds: z.number().int().positive(),
});
export type WorkflowRunPhase = z.infer<typeof workflowRunPhaseSchema>;

/**
 * How much the bound was spent on a given **birth phase**.
 *
 * The two counters (`nodesUnlisted` / `nodesUnlistedSettled` of {@link workflowRunUsageSchema}) can
 * say how many entries a run missed listing in total, but not at **which station** they were
 * missed — and the read surface is drawn per station: a station's roster, count ring and "N more"
 * all have to add back the out-of-table entries of their own cell, otherwise a wide fan-out
 * station would show a small number.
 *
 * An absent `phaseName` = the "no phase" cell (born before any `phase()` marker, or an old CLI that
 * did not stamp it). `actors` is the number of subagents **not on the actor table right now** in
 * this phase (rejected ones, evicted ones, and ones removed by the orphan rule all count),
 * `actorsSettled` how many of those are known to have finished, `actorsFailed` how many of those
 * failed, and `settled` is the number of out-of-table settled nodes recorded in this cell. `actors`
 * can go up and down: an evicted subagent returns to the table the next time it is given work.
 * Optional sub-keys with a zero value are absent, and a cell with all four numbers zero is absent
 * altogether (following the "absent when not there" rule of the rest of this file).
 */
export const workflowRunUnlistedPhaseSchema = z.object({
  phaseName: z.string().min(1).max(WORKFLOW_RUNS_LIMITS.maxPhaseNameLength).optional(),
  actors: z.number().int().nonnegative(),
  actorsSettled: z.number().int().nonnegative().optional(),
  actorsFailed: z.number().int().nonnegative().optional(),
  settled: z.number().int().nonnegative(),
});
export type WorkflowRunUnlistedPhase = z.infer<typeof workflowRunUnlistedPhaseSchema>;

/**
 * Run-level usage: an observation surface, not a control surface. `spentTokens` is taken straight
 * from the total spent carried by the engine's `usage-updated` event (written in the same
 * synchronous step as `dwf_run.spent_tokens`, so the two are always equal); `nodesUsed` is the
 * number of nodes dispatched in this run, counted from node events — there is no cap to back it
 * out from, and none is needed.
 */
export const workflowRunUsageSchema = z.object({
  spentTokens: z.number().int().nonnegative(),
  nodesUsed: z.number().int().nonnegative(),
  /**
   * The number of instances that hit {@link WORKFLOW_RUNS_LIMITS.maxNodes} and were **refused
   * entry to the table**, plus how many of them have settled. `truncated` can only say that
   * "something did not get in", not how much — so a 3000-way fan-out run would show up on the
   * read surface as "1024 steps", which is a lie.
   *
   * Both are counters that are **added up** (a refused instance is not in the table at all and has
   * no dedupable identity), so the reduction only counts when the event **advances the
   * watermark**; a retransmitted tail event does not push them any higher. `run-started` zeroes
   * them along with the whole usage: resume re-emits the script prefix, and not zeroing would
   * add up the step counts of two lives. When zero, the whole key is absent.
   */
  nodesUnlisted: z.number().int().nonnegative().optional(),
  nodesUnlistedSettled: z.number().int().nonnegative().optional(),
});
export type WorkflowRunUsage = z.infer<typeof workflowRunUsageSchema>;

/**
 * An actor instance. `status` is a **derived** three-state:
 * apart from `actor-created` the engine's Boundary C emits no actor lifecycle events, so the
 * status is derived from that actor's nodes and the run's terminal state —
 *   - `running`: it has a node in executing / repairing / nudged (the model request has gone out
 *     and is running);
 *   - `waiting`: it has a live node (queued / dispatched / waiting: not yet dispatched, waiting
 *     for a slot, or backing off), **or** it has no node yet while the run is not terminal (created
 *     but not yet asked);
 *   - `completed`: the rest (all nodes settled, or the run is terminal).
 * There is no observable actor-level failed: a failed ask still means "its work is done", and the
 * result is on the node.
 *
 * `sessionId` is the actor session id (phase 5's transcript drill-down reads it directly). It is
 * likewise not on Boundary C; it is computed by the same deterministic minting function in the run
 * service, keyed on `(runId, actorRef)`.
 */
export const workflowRunActorSchema = z.object({
  siteId: z.string().min(1).max(64),
  ordinal: z.number().int().nonnegative(),
  name: z.string().min(1).max(WORKFLOW_RUNS_LIMITS.maxActorNameLength).optional(),
  sessionId: z.string().min(1).max(256).optional(),
  status: z.enum(["waiting", "running", "completed"]),
  /**
   * The phase this instance was **born** in: the name of the `phase("…")` marker the control flow
   * was at the moment its ordinal was minted. The UI relates it to `phases[].name` **by name** —
   * the name is the only vocabulary shared by the engine and the analyzer, so the bound is the
   * same value as `maxPhaseNameLength`.
   *
   * Absence has two readings and consumers must accept both: born before any marker (the script
   * never wrote `phase()`, or wrote it later), or the emitting CLI is an old one that does not
   * carry this key.
   */
  phaseName: z.string().min(1).max(WORKFLOW_RUNS_LIMITS.maxPhaseNameLength).optional(),
});
export type WorkflowRunActor = z.infer<typeof workflowRunActorSchema>;

/**
 * The **most recent** tool call in one ask (carried by `node-progress`). `name` is the tool name;
 * `target` is a target short enough to serve as a label — a path for file tools, a command head
 * for Bash — absent when unreadable.
 *
 * **Deliberately only these two keys**: the full argument list and file contents do not enter this
 * high-frequency state key (one per resolved turn), they live in the journal and the subagent
 * transcript. The bound on `target` is therefore both the display budget and the guard on that
 * constraint.
 */
export const workflowRunNodeLastToolSchema = z.object({
  name: z.string().min(1).max(WORKFLOW_RUNS_LIMITS.maxLastToolNameLength),
  target: z.string().min(1).max(WORKFLOW_RUNS_LIMITS.maxLastToolTargetLength).optional(),
});
export type WorkflowRunNodeLastTool = z.infer<typeof workflowRunNodeLastToolSchema>;

/**
 * A node (ask / world-read) instance. `phase` is exactly the node event the engine **actually**
 * emitted:
 *   queued → dispatched → executing ⇄ waiting → (repairing | nudged) → settled.
 * `executing` / `waiting` come from the driver's observation:
 * `node-executing` = that ask's model request really went out; `node-waiting` = it is waiting for
 * a process-level slot or backing off. `dispatched` is therefore a brief phase meaning "the session
 * is ready, the first request has not yet been admitted", and the read surface groups it with
 * queued / waiting under "waiting".
 *
 * `kind` may be absent: a resume whose completion hits the cache short-circuits and emits
 * `node-settled` directly (for an ask via scheduler.ts's releaseCachedAsk / tryImportedSettle, for
 * a world-read via engine-world.ts's replay and import hits), without going through `node-queued`,
 * and kind is only carried on queued.
 */
export const workflowRunNodeSchema = z.object({
  siteId: z.string().min(1).max(64),
  ordinal: z.number().int().nonnegative(),
  kind: z.enum(["ask", "world-read"]).optional(),
  phase: z.enum(["queued", "dispatched", "executing", "waiting", "repairing", "nudged", "settled"]),
  outcome: z.enum(["ok", "failed", "cancelled"]).optional(),
  cached: z.boolean().optional(),
  /** The site id of the actor this node belongs to (a world-read has no actor). */
  actorSiteId: z.string().min(1).max(64).optional(),
  actorOrdinal: z.number().int().nonnegative().optional(),
  /**
   * The phase this instance was **born** in,
   * with semantics verbatim identical to the same-named key of {@link workflowRunActorSchema}: the
   * `phase("…")` marker name at the moment the ordinal was minted, related by the UI to
   * `phases[].name` by name; absence = born before any marker, or an old CLI.
   *
   * ⚠ This is **not** the same thing as the `phase` above: `phase` is the node's lifecycle phase
   * (queued / executing / settled…), `phaseName` is the script's phase coordinate. The field is
   * deliberately not called `phase` so as not to blend the two concepts together.
   *
   * The engine stamps it only on the **birth event** (`node-queued`, and the `node-settled {
   * cached: true }` emitted directly on a replay hit); the other `node-*` events do not carry it,
   * and the reducer carries it forward.
   */
  phaseName: z.string().min(1).max(WORKFLOW_RUNS_LIMITS.maxPhaseNameLength).optional(),
  /**
   * The **task** of this ask: the first 240 characters of the author-written `instructions`,
   * arriving with `node-queued`. The read surface uses it to answer "what was this subagent sent
   * off to do" — the phase can only say "it is running", not what it is running.
   *
   * It is the head of the **author's original text**, without the trailing note the engine appends
   * later (those are runtime scaffolding, not the task).
   * Absence has two readings and consumers must accept both: a world-read node (which has no
   * instructions), or an old CLI / old journal that does not carry this key.
   */
  instructionsHead: z
    .string()
    .min(1)
    .max(WORKFLOW_RUNS_LIMITS.maxInstructionsHeadLength)
    .optional(),
  /**
   * Which resolved turn this ask has reached (starting at 1, nudge turns included), the cumulative
   * tool call count, and the most recent tool call — arriving with `node-progress`, one per resolved
   * turn.
   *
   * The three together answer "is it moving": for an ask stuck in `executing` for ten minutes,
   * only these readings can tell "working on one long job" apart from "already dead". **On an old
   * journal with no `node-progress` all three keys are absent**, and the read surface must show the
   * absence as "unknown" rather than as 0 — 0 is the fact "not a single tool was called".
   *
   * The reduction is **last-writer-wins** rather than a max (the opposite of `phases[].rounds`):
   * when the same instance is re-queued on resume that is a brand-new ask, the turns count again
   * from 1, and taking a max would freeze the previous life's readings here.
   */
  turn: z.number().int().positive().optional(),
  toolCalls: z.number().int().nonnegative().optional(),
  lastTool: workflowRunNodeLastToolSchema.optional(),
});
export type WorkflowRunNode = z.infer<typeof workflowRunNodeSchema>;

/**
 * The concurrency state of this run. Two bounds,
 * the effective concurrency is the **smaller of the two**:
 *
 * - `cap`: the current state of the **shared** gate of the provider key this run belongs to (the
 *   governor buckets by key and fans out per run, moving with `concurrency-changed`); `ceiling`:
 *   the CPU-derived ceiling. The event itself carries no ceiling, the reduction derives it from
 *   the largest `previous` / `next` that run has seen (the bucket starts at the ceiling, so the
 *   first event's `previous` is it; in a only-decreasing sequence it is also always the maximum).
 * - `limit`: this run's **own** bound (`CreateWorkflow` / `AmendWorkflow`'s `max_concurrency`
 *   landing in `caps.maxConcurrency`), arriving with `run-started` and fixed for the whole run.
 *   **Present only when below the ceiling**: a run running at the ceiling is exactly as before,
 *   not one key more.
 * - `cooldownMs`: how long rate limiting with Retry-After freezes new dispatches, a **relative
 *   amount** (same reasoning as `retryInMs`); `idle_reset` and the run's terminal state clear it.
 *
 * The UI shows the reading only when `min(cap, limit) < ceiling` (see
 * workflowRunConcurrencyView).
 */
export const workflowRunConcurrencySchema = z.object({
  key: z.string().min(1).max(WORKFLOW_RUNS_LIMITS.maxConcurrencyKeyLength).optional(),
  cap: z.number().int().positive(),
  ceiling: z.number().int().positive(),
  limit: z.number().int().positive().optional(),
  cooldownMs: z.number().int().nonnegative().optional(),
});
export type WorkflowRunConcurrency = z.infer<typeof workflowRunConcurrencySchema>;

/**
 * A **progressive artifact** handed over by the script's `report(item)` (one row of the detail
 * page's Results section).
 *
 * `report` is not the same kind of thing as `log`: it has a site identity, goes into the journal
 * and has its own `RunEvent`, so it enters the event log, enters the Results section, and comes
 * back to the model with the completion notification; but it does **not** enter the causal graph
 * (it is a pure progress emission with no ordering meaning whatsoever), and it does **not** enter
 * `nodes[]` — a report-heavy workflow should not look like it has an inflated step count.
 *
 * `siteId × ordinal` is the identity (the journal's key) and also the reduction's dedup key: when
 * the script replays, every `report` call runs again, and the same instance must land as the same
 * single row rather than two rows.
 *
 * It stores **preview text** rather than the original value: the serialization rules (strings
 * as-is; everything else pretty JSON) share their source with the run artifact hand-back path,
 * are computed once on the CLI side, so the renderer need not copy a serialization contract; and
 * it also lands the "every payload at the protocol boundary is bounded" invariant on a single
 * string bound.
 */
export const workflowRunReportSchema = z.object({
  siteId: z.string().min(1).max(64),
  ordinal: z.number().int().nonnegative(),
  preview: z.string().max(WORKFLOW_RUNS_LIMITS.maxReportPreviewLength),
  /**
   * The second argument of `report(item, artifactId)`: which **preset board** this entry feeds.
   * Absent = untagged, going only into the Results section as before.
   *
   * A tagged entry **still enters `reports`**: one channel has one bound, and the tag is just one
   * more destination, not a reroute. The bound is the same as for the artifact id (64), because
   * that is exactly what it is.
   */
  artifactId: z.string().min(1).max(64).optional(),
});
export type WorkflowRunReport = z.infer<typeof workflowRunReportSchema>;

/**
 * An escalated question that is **parked**: some actor hit a real blocker
 * (a bad gate, self-contradictory instructions, a missing key fact), escalated the question to the
 * main agent, and parked itself in its own ask waiting for an answer.
 *
 * The identity is the `qid` (globally unique, across runs), not the station instance — an
 * escalation has **no** site identity: it writes no dwf_node row, occupies no maxNodes slot, and is
 * a slow tool call **inside** one ask turn. So the dedup key is the qid, and the actor is merely an
 * attribute. That is a different family from the three tables — nodes/actors/reports — that dedup
 * by (siteId, ordinal).
 *
 * `actorSiteId` / `actorOrdinal` are therefore optional (shaped exactly like the same-named pair
 * of `WorkflowRunNode`): a record that cannot name its asker must still be displayed — the reason
 * this feature exists is to make a blocked question **visible**, and hiding the whole question
 * over one unreadable actor ref destroys its only fallback value. `actorName` is the persona name,
 * absent for an anonymous actor (the event side deliberately does not synthesize a fallback label;
 * each consumer decides how to render "unnamed").
 *
 * **Purely in memory, cleared at the run's terminal state**: the truth is a deferred parked
 * inside the CLI process. Once the process dies those deferreds are gone, so "who still owes an
 * answer" is constantly false for a terminal run — a terminal run by definition has nobody
 * listening.
 */
export const workflowRunPendingQuestionSchema = z.object({
  /** The globally unique question id (of the form `dwfq-<runId fragment>-<seq>`). The main agent answers by it. */
  qid: z.string().min(1).max(128),
  actorSiteId: z.string().min(1).max(64).optional(),
  actorOrdinal: z.number().int().nonnegative().optional(),
  actorName: z.string().min(1).max(WORKFLOW_RUNS_LIMITS.maxActorNameLength).optional(),
  question: z.string().min(1).max(WORKFLOW_RUNS_LIMITS.maxQuestionLength),
  context: z.string().min(1).max(WORKFLOW_RUNS_LIMITS.maxQuestionLength).optional(),
  /**
   * The moment the question was asked (epoch milliseconds), carried by the event — this module is
   * a pure reduction and has no clock available.
   *
   * It is **required** on the event side (the driver is the only producer and takes the same
   * `Date.now()` as the parked record), yet still optional here: a journal on an old dev machine
   * may replay events from before askedAt existed. So the render side treats it as "show the wait
   * duration when present"; an absence is not an error.
   */
  askedAt: z.number().int().nonnegative().optional(),
});
export type WorkflowRunPendingQuestion = z.infer<typeof workflowRunPendingQuestionSchema>;

export const workflowRunSchema = z.object({
  runId: z.string().min(1).max(128),
  /** The CreateWorkflow tool call that started this run (the correlation key from the tool card to the detail page). */
  toolCallId: z.string().min(1).max(128).optional(),
  status: z.enum(["pending", "running", "completed", "errored", "stopped"]),
  /** Present only when `status === "stopped"`. */
  stopReason: z.enum(["user", "model", "provider", "interrupted", "superseded"]).optional(),
  /**
   * The two ends of the lineage: which run this run was revised from
   * (the `resumedFrom` of the `run-started` payload), and which revision stopped and superseded
   * this run (the `supersededBy` of the `run-settled` payload, appearing only with `stopReason:
   * "superseded"`). Both are optional, for the same reason as `reports`: adding a field to an
   * existing state key means that when an old CLI does not send it, one key less is a degradation
   * rather than a whole dropped frame.
   */
  resumedFrom: z.string().min(1).max(128).optional(),
  supersededBy: z.string().min(1).max(128).optional(),
  usage: workflowRunUsageSchema,
  error: z.string().min(1).max(WORKFLOW_RUNS_LIMITS.maxErrorLength).optional(),
  /**
   * Resumable. **Present only when true.**
   *
   * Determined by the CLI on the `run-settled` payload with the very same predicate as the resume
   * gate (live: computed by toProgressPayload; cold replay: computed by the backfill from journal
   * rows), and the reducer only carries it — the UI must never derive it on its own from status +
   * failureCode (the two predicates will one day disagree: the button is lit but the command is
   * rejected). The reason it is optional is the same as for `reports`: adding a field to an
   * existing state key means that when an old CLI does not send it, one key less is a degradation
   * rather than a whole dropped frame.
   */
  resumable: z.literal(true).optional(),
  resultPreview: z.string().max(WORKFLOW_RUNS_LIMITS.maxResultPreviewLength).optional(),
  actors: z.array(workflowRunActorSchema).max(WORKFLOW_RUNS_LIMITS.maxActors),
  nodes: z.array(workflowRunNodeSchema).max(WORKFLOW_RUNS_LIMITS.maxNodes),
  /**
   * The progressive artifacts handed over by `report(item)`, in report order. **The whole key is
   * absent when there are zero** (not an empty array): the Results section then renders no section
   * at all, rather than leaving an empty shell for a workflow that does not use `report`.
   *
   * Deliberately optional rather than required: this is a field added to an **existing state key**,
   * and a parse error on a known key is not stripped — it makes the whole `state.updated` patch
   * fail and the whole frame get dropped.
   * Required would mean any old CLI that does not send reports triggers exactly that fate;
   * optional degrades it to "one key less".
   */
  reports: z.array(workflowRunReportSchema).max(WORKFLOW_RUNS_LIMITS.maxReports).optional(),
  /**
   * The escalated questions parked right now, in asking order. **The whole key is absent when
   * there are zero** (not an empty array), following the same convention as `reports`: the sidebar
   * then renders no section at all, rather than leaving an empty shell for a run nobody asked
   * anything in.
   *
   * "Zero" is this key's **normal state**, and it comes and goes: a question disappears from the
   * table the moment it is answered, and once the last one is answered it falls back to absent. So
   * consumers must not take "having seen this key once" as "it will always be there".
   *
   * The second reason it is optional is the same as for `reports`: this is a field added to an
   * **existing state key**, and a parse error on a known key is not stripped — required would make
   * any old CLI that does not send this field lose its whole frame.
   */
  pendingQuestions: z
    .array(workflowRunPendingQuestionSchema)
    .max(WORKFLOW_RUNS_LIMITS.maxPendingQuestions)
    .optional(),
  /**
   * The concurrency state (see {@link workflowRunConcurrencySchema}). Present only when **one of
   * the two bounds is below the ceiling**: either a `concurrency-changed` has been received (the
   * shared bucket was pressed down by rate limiting), or `run-started` brought a `limit` below the
   * ceiling (the user set a cap for this run). A run with neither simply runs at the ceiling and
   * has nothing to report.
   * The reason it is optional is the same as for `reports` / `pendingQuestions`.
   */
  concurrency: workflowRunConcurrencySchema.optional(),
  /**
   * The local concurrency ceiling (the `concurrencyCeiling` of the `run-started` payload, a
   * process fact spliced in by the CLI when minting the payload).
   * It differs from `concurrency.ceiling`: that one is the reading chip's own watermark and is only
   * present along with the chip; this one is **present whenever it can be read**, regardless of
   * whether this run is below it — that is where the stepper in the "configuration" popover stops.
   * The reason it is optional is the same as for `concurrency`: an old CLI does not send it, and
   * one key less is a degradation.
   */
  concurrencyCeiling: z
    .number()
    .int()
    .positive()
    .max(WORKFLOW_RUNS_LIMITS.maxConcurrencyCeiling)
    .optional(),
  /**
   * The model this run's **subagents** run on (`CreateWorkflow` / `AmendWorkflow`'s
   * `subagent_model` landing in the payload's `subagentModel`), the canonical string
   * `providerId/modelId`, optionally with a `$reasoningLevel` suffix.
   * It arrives with `run-started` and is fixed for the whole run — same family as
   * `concurrency.limit`: a condition the user set for this run, which does not rise and fall with
   * runtime behaviour.
   *
   * **Present only when the user specified a model for this run**: in a run without one the
   * subagents follow the session model and there is nothing to report. The main agent stays on the
   * session model regardless, so this key only speaks for the subagent side.
   * The reason it is optional is verbatim identical to `reports` / `concurrency`: adding a field
   * to an existing state key means that when an old CLI does not send it, one key less is a
   * degradation rather than a whole dropped frame.
   */
  subagentModel: z.string().min(1).max(WORKFLOW_RUNS_LIMITS.maxSubagentModelLength).optional(),
  /**
   * The **user-facing** artifacts this run has published, in first-appearance order, each entry
   * carrying only the **latest** version's metadata. **The whole key is absent when there are zero
   * entries** (not an empty array): the sidebar's Artifacts section then renders no section at
   * all — the "absent when not there" rule is the same as for `reports` / `pendingQuestions`.
   *
   * The second reason it is optional is verbatim identical to `reports`, and is the one that really
   * matters here: this is a field added to an **existing state key**, and a parse error on a known
   * key is not stripped — required would make any old CLI that publishes no artifact lose its
   * whole frame. One key less is a degradation, not an error.
   *
   * ⚠ Terminology: the artifact here is an output the script publishes for the user to see, not
   * the "script top-level return value" behind `resultPreview` (which the engine also calls an
   * artifact). See the file header of workflow-artifacts.ts.
   */
  artifacts: z
    .array(workflowRunArtifactSummarySchema)
    .max(WORKFLOW_RUNS_LIMITS.maxArtifacts)
    .optional(),
  /**
   * The phases that have been entered, in first-entry order.
   * **The whole key is absent when there are zero**; the reason it is optional is verbatim
   * identical to `reports` (an old CLI does not send it, and one key less is a degradation, not an
   * error). The timeline uses it to light up the stations with no members and to fill in the
   * running segment "before the first ask was dispatched" for every station.
   */
  phases: z.array(workflowRunPhaseSchema).max(WORKFLOW_RUNS_LIMITS.maxPhases).optional(),
  /** The name of the phase the control flow last entered (the last `phase-entered`); absent when no phase was ever entered. */
  currentPhase: z.string().min(1).max(WORKFLOW_RUNS_LIMITS.maxPhaseNameLength).optional(),
  /**
   * The phase table the script **declared**, in declaration order (`run-launched.phaseNames`).
   * It complements `phases` (the entered ones): the sidebar's mini track uses it to draw the
   * stations still ahead. The whole key is absent when there are zero, with an old CLI, or for a
   * script without markers.
   */
  phaseNames: z
    .array(z.string().min(1).max(WORKFLOW_RUNS_LIMITS.maxPhaseNameLength))
    .max(WORKFLOW_RUNS_LIMITS.maxPhases)
    .optional(),
  /**
   * The "running at the same time" table, **positionally aligned** with `phaseNames`
   * (`run-launched.phaseAlongside`): `phaseAlongside[i]` holds the **indices** of the other phases
   * whose strand is still running when entering `phaseNames[i]`, and those indices are into the
   * `phaseNames` table. The sidebar's mini track uses it to draw a double segment between two
   * parallel stations.
   *
   * It is attached to `phaseNames`: when the latter is absent it is certainly absent too, and it
   * is likewise absent when no phase runs in parallel — an absence means "this track is a straight
   * line". The reduction guarantees that every index falls inside the accepted table
   * (workflow-runs-phases.ts).
   */
  phaseAlongside: z
    .array(z.array(z.number().int().nonnegative()).max(WORKFLOW_RUNS_LIMITS.maxPhases))
    .max(WORKFLOW_RUNS_LIMITS.maxPhases)
    .optional(),
  /**
   * How much the bound was spent on each birth phase (see {@link workflowRunUnlistedPhaseSchema}).
   * **The whole key is absent when not a single cell exists.** The table is one cell longer than
   * `maxPhases`: that extra cell is "no phase", and it shares the same table as the named phases.
   *
   * Once the table is full the attribution of new phases is **dropped**, while the two run-level
   * counters stay accurate — a station may lack a number it never had, but the run's totals must
   * not tell a lie.
   */
  unlistedByPhase: z
    .array(workflowRunUnlistedPhaseSchema)
    .max(WORKFLOW_RUNS_LIMITS.maxPhases + 1)
    .optional(),
  /**
   * Set when actors / nodes / reports / pendingQuestions / artifacts / phases hit their caps;
   * the raw facts are still in the journal. Eviction (making room for a live newcomer) sets it
   * too: this run's entry table can no longer hold its own facts, and `run-started` decides from
   * exactly this bit whether the new life should restart from an empty table.
   */
  truncated: z.boolean().optional(),
  /** The journal sequence of the last reduced event; its advance is the trigger for refetching the event log. */
  lastEventSequence: z.number().int().nonnegative(),
});
export type WorkflowRunState = z.infer<typeof workflowRunSchema>;

export const workflowRunsStateSchema = z.object({
  revision: z.number().int().nonnegative(),
  runs: z.array(workflowRunSchema).max(WORKFLOW_RUNS_LIMITS.maxRuns),
});
export type WorkflowRunsState = z.infer<typeof workflowRunsStateSchema>;
