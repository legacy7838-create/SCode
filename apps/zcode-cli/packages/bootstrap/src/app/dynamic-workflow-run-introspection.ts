// ============================================================
// Dynamic Workflow Run Service: run introspection reading surface (ListWorkflowRuns/GetWorkflowRun)
// ============================================================
// dynamic-workflow-run-service.ts reaches the upper limit of oxlint max-lines (400 lines), put `listRuns` /
// `getRunDetail` Two optional port members and their pendingQuestions slices are split into this file; the public side remains from
// dynamic-workflow-run-service.ts export. Both members only load the service object when the journal is queried with introspection -
// In its absence, the entire non-implemented assertion remains in the service (see the `introspection` field comment there).

import type {
  DynamicWorkflowRunDetail,
  DynamicWorkflowRunLifecycleStatus,
  DynamicWorkflowRunListItem,
  DynamicWorkflowRunListQuery,
  DynamicWorkflowRunListResult,
  DynamicWorkflowRunPendingQuestion,
  DynamicWorkflowRunPort,
} from "@zcode/contracts";
import type { JournalStorePort } from "@zcode/dynamic-workflow";
import { reduceWorkflowRunsState, type WorkflowRunsState } from "@zcode/shared/zcode-protocol-v4";
import type { DynamicWorkflowIntrospectableJournal } from "./dynamic-workflow-run-journal.js";
import { readRunScriptPath, readRunSubagentModel } from "./dynamic-workflow-run-launch-anchor.js";
import {
  artifactsOf,
  journalRunSummary,
  registryRunSummary,
  runConcurrencyField,
  runScriptPathField,
  runSubagentModelField,
  terminalErrorField,
  terminalResultField,
  toLogTailEntry,
  TERMINAL_RUN_STATUSES,
  type RunRegistryEntry,
} from "./dynamic-workflow-run-observation.js";
import { replayRunProgressFromEvents } from "./dynamic-workflow-run-replay.js";
import { buildWorkflowRunRoster } from "./dynamic-workflow-run-roster.js";
import type { WorkflowEscalationRegistry } from "./workflow-escalation-registry.js";

/**
 * How many trailing `log()` entries `getRunDetail` takes by default. The tail samples narrative progress rather than being the full log — the full event
 * log is paged by {@link DynamicWorkflowRunPort.listEvents}.
 */
const DEFAULT_LOG_TAIL_LIMIT = 20;

/** The service-internal state the introspection read surfaces have to read: the registry and the parked table are references to the **same instance**, not copies. */
interface DynamicWorkflowRunIntrospectionContext {
  /** The journal already narrowed by capability probing (the same object as `journal`, just with a wider type). */
  introspection: DynamicWorkflowIntrospectableJournal;
  journal: JournalStorePort;
  parentSessionId: string;
  /** The service's in-memory registry (in flight + bounded terminal states). */
  runs: ReadonlyMap<string, RunRegistryEntry>;
  /** The parked table for upgrade questions, the single projection source of the pendingQuestions slice. */
  escalations: WorkflowEscalationRegistry;
  /**
   * The concurrency ceiling of this process (the service's own implementation of it). The detail surface uses it to judge that a run's upper bound is not worth reporting
   * ({@link runConcurrencyField}). It is a function rather than a number: the introspection member is built once at service construction time, while the ceiling
   * is a fact that has to be read fresh every time.
   */
  concurrencyCeiling: () => number;
}

/** Builds the two members `listRuns` / `getRunDetail`, which the service spreads into the returned port object. */
export function createRunIntrospectionMethods(
  ctx: DynamicWorkflowRunIntrospectionContext,
): Required<Pick<DynamicWorkflowRunPort, "listRuns" | "getRunDetail">> {
  const { introspection, journal, parentSessionId, runs, escalations, concurrencyCeiling } = ctx;
  return {
    /**
     * Enumerates runs per project: journal rows ∪ this session's registry. **Read-only** — `possiblyInterrupted` is
     * a label carried by the read surface and never rewrites the journal (burying a sibling session's in-flight run means marking a live run dead;
     * the authority to converge orphans belongs solely to the owning session's construction moment, see invariant 4 in the file header).
     */
    async listRuns(query: DynamicWorkflowRunListQuery): Promise<DynamicWorkflowRunListResult> {
      const limit = Math.max(0, query.limit);
      // Taking an extra ** is just to determine truncated**, it will not enter the results page. The criterion must not be `length === limit`:
      // When the number of records is exactly equal to the limit, there will be false positives, and false positives will cause the model to chase a page of history that does not exist. The same convention is in
      // It has been used once on the event paging (hasMore) of the v4 gateway.
      const rows = introspection.listRuns({
        cwd: query.cwd,
        limit: limit + 1,
        ...(query.statuses === undefined ? {} : { statuses: query.statuses }),
      });
      const journalItems = rows.map((row) => ({
        ...journalRunSummary(row, runs.get(row.runId), parentSessionId),
        spentTokens: row.spentTokens,
      }));

      // Registry complement: among the microtasks that submit has returned but the engine has not yet createdRun, in the journal
      // There are no traces. Without this branch, the newly started run of the model will completely disappear in its own project list.
      const listed = new Set(rows.map((row) => row.runId));
      const gapItems: DynamicWorkflowRunListItem[] = [];
      for (const [runId, entry] of runs) {
        if (listed.has(runId) || entry.cwd !== query.cwd) continue;
        // The row already exists but is not selected by this query, indicating that it is excluded by limit / statuses - the complement will never
        // Get it back (that's equivalent to silently invalidating an explicitly passed filter).
        if (journal.getRun(runId) !== undefined) continue;
        const summary = registryRunSummary(runId, entry);
        if (query.statuses !== undefined && !query.statuses.includes(summary.status)) continue;
        // Usage: The line has not yet fallen, but the starting point of the revised run is determined at the moment of submit (see RunRegistryEntry.inheritedTokens).
        // A new run has no starting point ⇒ 0, the same as before.
        gapItems.push({ ...summary, spentTokens: entry.inheritedTokens ?? 0 });
      }

      // The run in the gap must be the latest submission (there were only a few microtasks before the journal line fell), so press
      // The commit time is sorted in reverse order before the journal line of time_updated desc; limit is the bounds of the entire page.
      gapItems.sort((left, right) => right.createdAt - left.createdAt);
      const merged = [...gapItems, ...journalItems];
      const truncated = merged.length > limit;
      return {
        runs: truncated ? merged.slice(0, limit) : merged,
        // Only present when true: `false` is a noise field that must be carried on every page.
        ...(truncated ? { truncated: true } : {}),
      };
    },

    /** Single-run detail: the dwf_run row + node counts + actors + the log tail + the in-memory terminal artifacts. */
    async getRunDetail(runId: string): Promise<DynamicWorkflowRunDetail | undefined> {
      const row = introspection.getRunRow(runId);
      const entry = runs.get(runId);
      if (row === undefined) {
        // Neither → really unknown (tool layer normalized to run_not_found). Only the registry has → exactly
        // The gap above: run does exist, and reporting not_found would be a lie.
        if (entry === undefined) return undefined;
        const gapSummary = registryRunSummary(runId, entry);
        // The gap shape of the situation section: there is no event or node row yet, so the stage table is absent and the roster is empty.
        // Zero health. The only one with content is `pendingQuestionsKnown` - the entry is in this session,
        // Of course, the parking table can be found (and it is **most likely** that there are parked questions at this moment, see the pendingQuestions comment below).
        const gapRoster = buildWorkflowRunRoster({
          run: undefined,
          events: [],
          nodes: [],
          actors: [],
          status: gapSummary.status,
          pendingQuestions: escalations.pendingFor(runId),
          now: Date.now(),
        });
        return {
          ...gapSummary,
          // Gapped copies of the concurrency upper bound (see RunRegistryEntry.maxConcurrency): the row has not fallen yet, but this value is
          // Submit has been determined at that moment, and there is no reason to pretend not to know the details in these microtasks.
          ...runConcurrencyField(entry.maxConcurrency, concurrencyCeiling()),
          // A gapped copy of the subagent model, same argument (see RunRegistryEntry.subagentModel).
          ...runSubagentModelField(entry.subagentModel),
          // A gapped copy of the script file with the same argument (see RunRegistryEntry.scriptPath).
          ...runScriptPathField(entry.scriptPath),
          // The count has no authoritative source at the moment and is honestly 0; the starting point of the usage is known (revised run inherits from the predecessor
          // Cumulative value, see RunRegistryEntry.inheritedTokens), reporting 0 will say "This lineage cost nothing."
          usage: {
            spentTokens: entry.inheritedTokens ?? 0,
            nodesObserved: 0,
            nodesRunning: 0,
            nodesCompleted: 0,
            nodesFailed: 0,
          },
          actors: [],
          logTail: [],
          ...gapRoster,
          ...terminalResultField(gapSummary.status, entry),
          ...terminalErrorField(gapSummary.status, entry),
          // This gap branch is the moment when "run is flying and journal row has not yet fallen", which is the most likely problem
          // Dwell moment - miss it and the blocked actor in the initial run is not visible on the model side.
          ...pendingQuestionsField(escalations, runId),
          // Product: The dwf_run line in this gap branch has not yet fallen.
          // But the **node line may have been dropped** - the engine can putNode an artifact immediately after createRun
          // OK. So here we still take it once, instead of taking it for granted: a run that was checked for details just after declaring the kanban board.
          // It shouldn't appear like nothing is being produced on the model side. Parts of artifactsOf make the entire field absent.
          ...artifactsOf(runId, journal),
        };
      }

      const summary = journalRunSummary(row, entry, parentSessionId);
      const counts = introspection.countNodesByStatus(runId);
      // Event **read only once**: the same sequence
      // First, the casting chain is reduced to the same state in the run panel through cold playback, and then fed to the form section together with the node row/actor row.
      // Reading both sides once means paying twice for the same data, and this query is the most expensive part of a long run.
      const stored = journal.listEvents(runId, {});
      const pendingQuestions = pendingQuestionsOf(escalations, runId, summary.status, entry);
      return {
        ...summary,
        // The upper bound of the drop library (`dwf_run.caps_max_concurrency`), only present when below the ceiling. deliberately not to advance
        // journalRunSummary - This is the common cross section of list rows, a rarely set field should not widen every row.
        ...runConcurrencyField(row.caps.maxConcurrency, concurrencyCeiling()),
        // The subagent model of this run is only present when set. It is not on the dwf_run column (deliberately not migrated) -
        // The authority is the `run-launched` event. The same rule as the snapshot: there is an entry to read the entry (the three paths to create an entry are all failed),
        // Only Leng Xing scans the event head. JournalRunSummary is deliberately not entered in line with the concurrency upper bound: a rare setting
        // The fields should not widen each row of the list.
        ...runSubagentModelField(
          entry === undefined ? readRunSubagentModel(journal, runId) : entry.subagentModel,
        ),
        // The script file of this run is only present when it is recorded. Same as subagent model: authority is `run-launched`
        // Event (dwf_run does not have this column), if there is an entry, read the entry, and only scan the event header once when running coldly; also deliberately
        // Not going into journalRunSummary - list rows should not be widened for a field that only AmendWorkflow uses.
        ...runScriptPathField(
          entry === undefined ? readRunScriptPath(journal, runId) : entry.scriptPath,
        ),
        usage: {
          // Direct reading dwf_run.spent_tokens: the only authority for run-level token usage.
          spentTokens: row.spentTokens,
          // The sum of the number of rows of dropped nodes is not the "total number of steps": dynamic workflow does not have a static total number.
          // And queued only exists in the event phase and does not fall into the library.
          nodesObserved: counts.running + counts.completed + counts.failed,
          nodesRunning: counts.running,
          nodesCompleted: counts.completed,
          nodesFailed: counts.failed,
        },
        actors: journal.listActors(runId).map((actor) => ({
          siteId: actor.siteId,
          ordinal: actor.ordinal,
          // persona is unintentional: the entire system prompt is a naturally unbounded field on the port.
          ...(actor.name === undefined ? {} : { name: actor.name }),
        })),
        logTail: introspection
          .listRecentLogEvents(runId, DEFAULT_LOG_TAIL_LIMIT)
          .map(toLogTailEntry),
        ...buildWorkflowRunRoster({
          run: reduceRunState(row, stored, concurrencyCeiling()),
          events: stored,
          nodes: journal.listNodes(runId),
          actors: journal.listActors(runId),
          status: summary.status,
          ...(pendingQuestions === undefined ? {} : { pendingQuestions }),
          now: Date.now(),
        }),
        ...terminalResultField(summary.status, entry, row),
        ...terminalErrorField(summary.status, entry, row),
        ...(pendingQuestions === undefined || pendingQuestions.length === 0
          ? {}
          : { pendingQuestions }),
        // Product cross-section: Any status is attached, including failed / canceled
        // - A run that dies at step 12 still delivers the image it produced earlier. with `listArtifacts` and final state
        // The snapshot takes the same artifactsOf, and the same list is given in three places (each of the three places merges one copy, and sooner or later it will be in
        // "Does the failed row count as one edition?" This is a branch of discussion). Part when the entire field is absent.
        ...artifactsOf(runId, journal),
      };
    },
  };
}

/**
 * The pendingQuestions slice of `getRunDetail`.
 *
 * It is the **same projection source** as the `getTask` snapshot (the in-memory upgrade parking table), and deliberately not a journal replay: the journal holds
 * raised / resolved events of both kinds, but "who is still owed an answer right now" is a live in-process fact — an unpaired raised
 * event replayed out of the journal lies as soon as the process is gone (the deferred parked there has long since vanished along with the process).
 *
 * At zero entries the whole field is absent (no empty array, same rule as the snapshot): an empty array reads like "asked, and all answered", while absence reads
 * as "nobody is waiting".
 */
function pendingQuestionsField(
  escalations: WorkflowEscalationRegistry,
  runId: string,
): Pick<DynamicWorkflowRunDetail, "pendingQuestions"> {
  const pendingQuestions = escalations.pendingFor(runId);
  return pendingQuestions.length === 0 ? {} : { pendingQuestions };
}

/**
 * Whether this read **can** answer "are there questions waiting for an answer", plus the answer itself
 * (`health.pendingQuestionsKnown`).
 *
 * `undefined` = cannot find out, not "there are none". The parking table lives in **this process's memory** (see the argument in {@link pendingQuestionsField}),
 * so there are only two situations in which this read can tell the truth: the run is in this session's registry, or the run is terminal
 * — a terminal run by definition has nobody left listening. In every other case (a sibling session's in-flight run, the leftovers of a dead process)
 * an empty table and "I don't know" look exactly the same, and those are two different next steps for the model: one can go on waiting,
 * the other has to change course and ask.
 */
function pendingQuestionsOf(
  escalations: WorkflowEscalationRegistry,
  runId: string,
  status: DynamicWorkflowRunLifecycleStatus,
  entry: RunRegistryEntry | undefined,
): readonly DynamicWorkflowRunPendingQuestion[] | undefined {
  const known = entry !== undefined || TERMINAL_RUN_STATUSES.has(status);
  return known ? escalations.pendingFor(runId) : undefined;
}

/**
 * Journal event → the same reduced status as the run panel. The task summary on `node-queued` and the progress reading on `node-progress`
 * live only on the event, and the rules for pulling them out have already been written once inside the reducer — that same pass is reused here instead of writing
 * yet another parser on the read surface (two parsers would eventually diverge on something like "does re-queueing clear the round").
 *
 * The caller reads the events and hands them over; `replayRunProgressFromEvents` is that cold-replay minting chain itself, so the status reduced here
 * is byte for byte the one the UI sees after a restart.
 */
function reduceRunState(
  row: Parameters<typeof replayRunProgressFromEvents>[0],
  stored: Parameters<typeof replayRunProgressFromEvents>[1],
  concurrencyCeiling: number,
): WorkflowRunsState["runs"][number] | undefined {
  let state: WorkflowRunsState | undefined;
  for (const payload of replayRunProgressFromEvents(row, stored, concurrencyCeiling)) {
    state = reduceWorkflowRunsState(state, payload) ?? state;
  }
  return state?.runs.find((run) => run.runId === row.runId);
}
