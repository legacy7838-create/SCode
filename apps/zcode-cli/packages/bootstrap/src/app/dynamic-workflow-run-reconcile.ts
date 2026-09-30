// ============================================================
// Dynamic Workflow Run Service: Convergence on construction of orphan run
// ============================================================
// dynamic-workflow-run-service.ts reaches the upper limit of oxlint max-lines (400 lines) and converges orphans
// (interruptedRunFailure / reconcileOrphanRuns) is removed to this file; the public version is still from
// dynamic-workflow-run-service.ts export. For the semantics, see invariant 4 in the file header there.

import type { Logger } from "@zcode/contracts";
import type { JournalStorePort, RunRecord, WorkflowErrorJson } from "@zcode/dynamic-workflow";
import { supportsNonTerminalRunQuery } from "./dynamic-workflow-run-journal.js";
import {
  INTERRUPTED_FAILURE_CODE,
  TERMINAL_RUN_STATUSES,
} from "./dynamic-workflow-run-observation.js";

/**
 * The subset of deps that reconciliation needs (a structural subset of DynamicWorkflowRunServiceDeps, passed through as-is by the
 * service). Only these three are listed instead of pulling in the whole deps type: reconciliation only reads the
 * journal and only recognizes this session, and extra dependencies would only make "what exactly does it touch" invisible.
 */
interface DynamicWorkflowOrphanReconcileDeps {
  journal: JournalStorePort;
  parentSessionId: string;
  logger?: Logger;
}

/**
 * The failure encoding of an interrupted run. It keeps the engine's {@link WorkflowErrorJson} shape (it lands
 * in dwf_run.failure_json, the same read surface as the engine's own failures), but the code is **exclusive**:
 *
 *   - It cannot be `DriverError` — a script that throws on its own is encoded as that too (dynamic-workflow-runtime/src/harness.ts), and
 *     sharing the code would leave "the process was killed" vs "the script really failed" distinguishable only through the message text;
 *   - The status cannot be `cancelled` — that is the semantics of "the user cancelled".
 *     Both are recoverable (the resume gate accepts {@link INTERRUPTED_FAILURE_CODE}), but the semantics must stay distinguishable.
 */
function interruptedRunFailure(runId: string): WorkflowErrorJson {
  return {
    code: INTERRUPTED_FAILURE_CODE,
    message: `dynamic workflow run ${runId} was interrupted: the owning process exited before the run settled`,
  };
}

/**
 * On construction, reconcile this parent session's orphan runs (the problem that used to exist:
 * the process was killed after run-started, so the dwf_run row **stayed running forever**, while getTask/waitForTask answer
 * with the journal snapshot for any run not in this process's registry, so after
 * resuming the session every journal read surface was told "still running" and nothing ever self-healed).
 *
 * Why the timing is **construction**: at that moment zero in-flight runs carry this service instance's name, so any non-terminal row in the journal
 * belonging to this session can only be debris of a dead process. A second construction is therefore naturally idempotent (no non-terminal items are left).
 *
 * Three boundaries:
 *   - **Reconcile this session only** (`deps.parentSessionId`). A global sweep would mark the in-flight runs of sibling sessions
 *     in the same process dead; two processes on one session are excluded by session ownership.
 *   - **Do not synthesize dwf_event rows**. The event log's contract is "what the engine emitted", and the authority
 *     on state is the run row; `run-settled` is the engine's closure, not the sweeper's.
 *   - **Do not let a failed reconciliation take the construction down**. Reconciliation is a self-healing action, not a precondition of a run: on a failed query or write, log a warning
 *     and continue (the only consequence is that the lie in that row stays), never turn one app construction into a startup failure.
 */
export function reconcileOrphanRuns(deps: DynamicWorkflowOrphanReconcileDeps): void {
  const { journal, logger, parentSessionId } = deps;
  if (!supportsNonTerminalRunQuery(journal)) {
    logger?.warn?.("Dynamic workflow orphan run reconciliation skipped", {
      event: "dynamic_workflow.run.reconcile_skipped",
      module: "bootstrap.app",
      reason: "journal_missing_list_non_terminal_runs",
    });
    return;
  }

  let orphans: RunRecord[];
  try {
    orphans = journal.listNonTerminalRuns(parentSessionId);
  } catch (error) {
    logger?.warn?.("Dynamic workflow orphan run query failed", {
      errorMessage: error instanceof Error ? error.message : String(error),
      event: "dynamic_workflow.run.reconcile_failed",
      module: "bootstrap.app",
    });
    return;
  }

  for (const record of orphans) {
    // The authority for final status determination lies in this document (TERMINAL_RUN_STATUSES): the status filtering of journal is just a pre-screening.
    if (TERMINAL_RUN_STATUSES.has(record.status)) continue;
    try {
      // stopped(interrupted): Recoverable and related to the user
      // Cancel/the model side stops being distinguishable - reason says "the process is dead", and code is the second evidence of the same fact.
      journal.updateRunStatus(record.runId, "stopped", {
        stopReason: "interrupted",
        failure: interruptedRunFailure(record.runId),
      });
      logger?.warn?.("Dynamic workflow run reconciled as interrupted", {
        event: "dynamic_workflow.run.reconciled_interrupted",
        module: "bootstrap.app",
        previousStatus: record.status,
        runId: record.runId,
      });
    } catch (error) {
      logger?.warn?.("Dynamic workflow orphan run reconciliation failed", {
        errorMessage: error instanceof Error ? error.message : String(error),
        event: "dynamic_workflow.run.reconcile_failed",
        module: "bootstrap.app",
        runId: record.runId,
      });
    }
  }
}
