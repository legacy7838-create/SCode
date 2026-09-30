// ============================================================
// Dynamic Workflow Run Service: journal capability detection and store narrowing
// ============================================================
// dynamic-workflow-run-service.ts reaches the upper limit of oxlint max-lines (400 lines), and replace journal/
// The structural narrowing of the task link store and the four sets of capability detection are split into this document; the public side is still from dynamic-workflow-run-service.ts
// Export.
//
// Every detection here follows the same discipline: store is a port and the implementation is replaceable, so it is detected based on capabilities rather than instanceof;
// Absence means **visible downgrade** (corresponding to the reading surface not being implemented/returning to empty/not being constructed), and will never be silently returned to the memory implementation.

import type { DwfRunIntrospectionQueries, DwfRunSessionListItem } from "@zcode/adapters/storage";
import type { CreateSessionTaskLinkInput, Logger, SessionStorePort } from "@zcode/contracts";
import type { JournalStorePort, RunRecord } from "@zcode/dynamic-workflow";

/** The task-link persistence surface (SqliteSessionStore in production; tests pass a spy). */
export interface DynamicWorkflowTaskLinkStore {
  createSessionTaskLink(input: CreateSessionTaskLinkInput): Promise<unknown>;
}

/**
 * A structural narrowing of the task-link persistence surface. Same treatment as
 * {@link resolveDynamicWorkflowJournalStore}: the store is a port and its implementation is replaceable, so this
 * probes by capability instead of with instanceof. When it is missing the link is simply not created — the actor
 * session itself is still persisted, the session tree just misses one ownership edge (degradable, and it does not
 * affect the correctness of the run).
 */
export function isDynamicWorkflowTaskLinkStore(
  store: SessionStorePort | undefined,
): store is SessionStorePort & DynamicWorkflowTaskLinkStore {
  return (
    typeof (store as { createSessionTaskLink?: unknown } | undefined)?.createSessionTaskLink ===
    "function"
  );
}

/**
 * Narrows a dwf journal out of the session store. A structural check rather than instanceof — the store is a port
 * and its implementation is replaceable (precedent: isScriptWorkflowStore in script-workflow-utils.ts).
 */
export function resolveDynamicWorkflowJournalStore(
  sessionStore: SessionStorePort | undefined,
  logger?: Logger,
): JournalStorePort | undefined {
  const candidate = sessionStore as
    | (SessionStorePort & { workflowJournalStore?: () => JournalStorePort })
    | undefined;
  if (typeof candidate?.workflowJournalStore !== "function") {
    // Visible degradation: Port not constructed → CreateWorkflow returns stub diagnostics. Never return the memory journal——
    // That would make run appear to be running, but silently throw everything away when the process exits.
    logger?.info?.("Dynamic workflow run service disabled: session store has no dwf journal", {
      event: "dynamic_workflow.run_service.unavailable",
      module: "bootstrap.app",
      reason: "session_store_missing_workflow_journal_store",
    });
    return undefined;
  }
  return candidate.workflowJournalStore();
}

/**
 * The host-side journal surface: the engine port plus the narrow queries used for orphan convergence and enumeration.
 *
 * It deliberately does **not** widen the engine's {@link JournalStorePort}: the engine only reads and writes its own
 * row by runId and never looks up runs by parent session — these two queries are host requirements, and putting them
 * into the domain port would mean holding every journal implementation accountable for work the engine does not do
 * (the in-memory implementation does not offer them at all). Same treatment as
 * {@link isDynamicWorkflowTaskLinkStore}: capability probing rather than instanceof, because the store is a port and
 * its implementation is replaceable.
 */
interface DynamicWorkflowJournalStore extends JournalStorePort {
  listNonTerminalRuns(parentSessionId: string): RunRecord[];
  /**
   * The runs under one parent session, most recently updated first, at most `limit` of them (the enumeration surface, backing listRunsForSession).
   *
   * Returns {@link DwfRunSessionListItem} rather than `RunRecord`: `RunRecord` deliberately carries no timestamps
   * (the engine does not care), while the enumeration surface has to report `updatedAt`. The narrow projection does
   * not read `result_json` (an unbounded payload the list does not display), but it **does keep failure** — the
   * `resumable` predicate depends on failure.code.
   */
  listRunsByParentSession(parentSessionId: string, limit: number): DwfRunSessionListItem[];
}

/** Whether the journal carries the narrow queries orphan convergence needs (the production SQLite implementation has them, the engine's in-memory one does not). */
export function supportsNonTerminalRunQuery(
  journal: JournalStorePort,
): journal is JournalStorePort & Pick<DynamicWorkflowJournalStore, "listNonTerminalRuns"> {
  return (
    typeof (journal as Partial<DynamicWorkflowJournalStore>).listNonTerminalRuns === "function"
  );
}

/** Whether the journal carries the enumeration narrow queries. The two queries are probed independently: missing one only degrades the matching read surface, with no knock-on effect. */
export function supportsRunEnumeration(
  journal: JournalStorePort,
): journal is JournalStorePort & Pick<DynamicWorkflowJournalStore, "listRunsByParentSession"> {
  return (
    typeof (journal as Partial<DynamicWorkflowJournalStore>).listRunsByParentSession === "function"
  );
}

/**
 * A journal carrying the run introspection queries (the data source behind `ListWorkflowRuns` / `GetWorkflowRun`).
 *
 * The **only source** of these signatures is adapters' {@link DwfRunIntrospectionQueries} (`import type`, zero
 * runtime dependency). Deliberately not retyped by hand here: these four queries do not live on the engine's
 * {@link JournalStorePort} (the engine never enumerates runs and never does aggregate counts), so they can only be
 * wired up by capability probing — and the moment their signatures drift the compiler will say nothing at all, it
 * will merely let both tools silently degrade into "this session has no such capability".
 */
export interface DynamicWorkflowIntrospectableJournal
  extends JournalStorePort, DwfRunIntrospectionQueries {}

/**
 * Whether the journal carries the "activity interval per incarnation" read surface (the duration basis for the completion card).
 *
 * **Probed independently, not merged into the four of {@link supportsRunIntrospection}**: those four are probed
 * together because they jointly back the availability of two tools, while this one backs a single number. Losing it
 * only makes the duration fall back to "wall clock of this incarnation" — a more conservative answer, not a broken
 * tool — so it must not take `GetWorkflowRun`'s availability down with it (the engine's built-in in-memory journal
 * does not offer it, and runs in an in-memory journal never outlive the process anyway).
 */
export function supportsRunLifeSpans(
  journal: JournalStorePort,
): journal is JournalStorePort & Pick<DwfRunIntrospectionQueries, "listRunLifeSpans"> {
  return typeof (journal as Partial<DwfRunIntrospectionQueries>).listRunLifeSpans === "function";
}

/**
 * Whether the journal carries the run introspection queries. **All four are probed together**: the capability is
 * whole (the list needs listRuns, the detail needs the other three), and a partially-present implementation would
 * only blow up one of the tools at runtime instead of visibly degrading.
 */
export function supportsRunIntrospection(
  journal: JournalStorePort,
): journal is DynamicWorkflowIntrospectableJournal {
  const candidate = journal as Partial<DwfRunIntrospectionQueries>;
  return (
    typeof candidate.countNodesByStatus === "function" &&
    typeof candidate.getRunRow === "function" &&
    typeof candidate.listRecentLogEvents === "function" &&
    typeof candidate.listRuns === "function"
  );
}
