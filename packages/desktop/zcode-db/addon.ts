// Typed Node-API binding facade for the Rust `zcode-db` addon (the cutover entry point).
//
// `loadAddon()` resolves the compiled `.node` once and re-exports it behind a fully-typed
// `DbAddon` interface so the session repos can call it without any `node:sqlite`. Resolution order:
//   1. `process.env.ZCODE_DB_NATIVE` (absolute path) — what the desktop host sets in a packaged
//      build to point at the staged native resource, mirroring the existing `prepare:*` asset flow.
//   2. otherwise `zcode_db.node` next to this module's package root (dev / `pnpm` workspace).
// This module only LOADS the addon; adopting a repo (replacing its `node:sqlite` internals) is a
// separate, all-at-once change because the three repos share one `tasks-index.sqlite` connection.

import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The complete surface of the Rust DB addon. Every method takes/returns JSON strings (the ported
 * serde projections) or primitives; `now`/clock and all ids are injected by the caller so the addon
 * stays deterministic and testable. Signatures mirror the `#[napi]` fns in `src/lib.rs`.
 */
export interface DbAddon {
  // ---- bootstrap / migration ----
  bootstrapTasksIndex(dbPath: string, deadlineMs: number): string;
  areMigrationsApplied(dbPath: string): boolean;

  // ---- task index: reads ----
  tasksCount(dbPath: string): number;
  listRecentTasks(dbPath: string, limit: number): unknown[];
  listTasksByWorkspace(dbPath: string, workspaceKey: string): unknown[];
  readTaskMetaJson(dbPath: string, workspaceKey: string, taskId: string): string | null;
  getTaskMetaJson(dbPath: string, workspaceKey: string, taskId: string): string | null;
  listTaskMetasJson(dbPath: string, workspaceKey: string): string;
  listTaskMetasFilteredJson(dbPath: string, filterJson: string): string;
  queryTaskListJson(dbPath: string, queryJson: string): string;
  listDeletedTaskIdsJson(dbPath: string, workspaceKey: string, provider: string | null): string;
  listSessionsByAutomationJson(dbPath: string, automationId: string): string;
  hasGroupedWorkspaceBootstrapRunJson(dbPath: string): boolean;

  // ---- task index: writes ----
  syncTaskMetaJson(dbPath: string, workspaceKey: string, incomingJson: string, paramsJson: string, now: number): string;
  syncTaskMetaAtGroupedTopJson(dbPath: string, workspaceKey: string, incomingJson: string, paramsJson: string, searchableText: string | null, now: number): string;
  updateTaskStateJson(dbPath: string, workspaceKey: string, taskId: string, patchJson: string): string | null;
  clearTaskUnreadJson(dbPath: string, workspaceKey: string, taskId: string, expectedUnreadAt: number): string;
  applyAgentPatchJson(dbPath: string, workspaceKey: string, taskId: string, patchJson: string): string | null;
  deleteArchivedTaskJson(dbPath: string, workspaceKey: string, taskId: string): string | null;
  archiveStaleTasksJson(dbPath: string, workspaceKey: string, cutoff: number, provider: string | null): string;

  // ---- task groups / grouped view ----
  groupingCreateTaskGroupJson(dbPath: string, title: string | null, color: string | null, now: number): string;
  groupingRenameTaskGroupJson(dbPath: string, groupId: string, title: string, now: number): string;
  groupingUpdateTaskGroupColorJson(dbPath: string, groupId: string, color: string, now: number): string;
  groupingDeleteTaskGroupJson(dbPath: string, groupId: string): void;
  groupingUpsertTopOrderJson(dbPath: string, nodeType: string, nodeKey: string, sortOrder: number, now: number): void;
  groupingInitializeAtTopJson(dbPath: string, taskJson: string, now: number): boolean;
  groupingApplyViewOrderJson(dbPath: string, inputJson: string, now: number): void;
  groupingQueryViewStructureJson(dbPath: string, scopesJson: string): string;
  groupingQueryViewJson(dbPath: string, scopesJson: string, includeAll: boolean, provider: string | null, now: number): string;

  // ---- automation ----
  listAutomationsJson(dbPath: string, workspaceKey: string | null): string;
  getAutomationJson(dbPath: string, automationId: string, workspaceKey: string | null): string | null;
  updateAutomationJson(dbPath: string, automationId: string, paramsJson: string, optionsJson: string, workspaceKey: string | null, now: number): string | null;
  deleteAutomationJson(dbPath: string, automationId: string, workspaceKey: string | null): boolean;
  automationCreateJson(dbPath: string, paramsJson: string, optionsJson: string, now: number): string;
  automationSetEnabledJson(dbPath: string, automationId: string, enabled: boolean, workspaceKey: string | null, now: number): void;
  automationRestartJson(dbPath: string, automationId: string, nextRunAt: number | null, workspaceKey: string | null, now: number): void;
  automationClaimDueJson(dbPath: string, now: number): string;
  automationMarkDispatchedJson(dbPath: string, automationId: string, dispatchedAt: number, nextRunAt: number | null): void;
  automationMarkDispatchFailedJson(dbPath: string, automationId: string, failedAt: number, error: string, kind: string, nextRunAt: number | null): void;
  automationReleaseClaimJson(dbPath: string, automationId: string, now: number): void;
  automationReleaseManualClaimJson(dbPath: string, automationId: string, workspaceKey: string, now: number): void;
  automationTouchManualClaimJson(dbPath: string, automationId: string, workspaceKey: string, now: number): void;
  automationScheduledRunCountJson(dbPath: string, automationId: string, workspaceKey: string | null): number | null;
  automationHasTaskBindingJson(dbPath: string, workspaceKey: string, targetTaskId: string): boolean;
  automationModelSelectionForDispatchJson(dbPath: string, automationId: string, workspaceKey: string): string | null;
  automationRunNowJson(dbPath: string, automationId: string, workspaceKey: string | null, now: number): string | null;
  automationClaimManualRunsJson(dbPath: string, now: number): string;
  automationSkipAndRescheduleJson(dbPath: string, paramsJson: string, now: number): void;
  automationMarkManualRunDispatchedJson(dbPath: string, runId: string, sessionId: string | null, dispatchedAt: number): boolean;
  automationListRunsJson(dbPath: string, automationId: string, workspaceKey: string | null): string;
  automationGetRunJson(dbPath: string, runId: string): string | null;
  automationDeleteRunJson(dbPath: string, runId: string, workspaceKey: string | null): void;
  automationPruneRunsJson(dbPath: string, maxAgeMs: number, now: number): number;
  automationEnsureRunClaimedJson(dbPath: string, identityJson: string, now: number): void;
  automationUpsertRunClaimedJson(dbPath: string, identityJson: string, selectionJson: string | null, now: number): void;
  automationFixRunModelSelectionJson(dbPath: string, runId: string, selectionJson: string, now: number): string;
  automationMarkRunDispatchJson(dbPath: string, runId: string, dispatchStatus: string, sessionId: string | null, error: string | null, now: number): void;
  automationMarkRunOutcomeJson(dbPath: string, runId: string, outcome: string, error: string | null, now: number): void;
  automationRecordSkippedRunJson(dbPath: string, identityJson: string, reason: string, now: number): void;

  // ---- off-peak ----
  listOffPeakJson(dbPath: string, workspaceKey: string | null): string;
  getOffPeakJson(dbPath: string, offPeakTaskId: string): string | null;
  offpeakCreateJson(dbPath: string, paramsJson: string, optionsJson: string, now: number): string;
  offpeakInvalidateModelSelectionJson(dbPath: string, id: string, selectionJson: string, now: number): string | null;
  offpeakUpdateEditableFieldsJson(dbPath: string, id: string, patchJson: string, now: number): string | null;
  offpeakUpdateSchedulingSnapshotJson(dbPath: string, id: string, patchJson: string, now: number): void;
  offpeakDeleteJson(dbPath: string, id: string): void;
  offpeakMarkHistoryDeletedJson(dbPath: string, id: string, now: number): string | null;
  offpeakClaimDueJson(dbPath: string, now: number): string;
  offpeakMarkRunningJson(dbPath: string, id: string, startedAt: number, conversationId: string | null, sessionId: string | null, serverTicketId: string | null): string | null;
  offpeakMarkTerminalJson(dbPath: string, id: string, status: string, endedAt: number, failureReason: string | null, filesChanged: number | null, dispatchError: string | null): string | null;
  offpeakSetPausedJson(dbPath: string, id: string, paused: boolean, now: number): string | null;
  offpeakReleaseClaimJson(dbPath: string, id: string, error: string | null, now: number): void;
  offpeakRecoverInterruptedJson(dbPath: string, now: number): number;
  offpeakMarkSettledJson(dbPath: string, id: string, settledAt: number): void;
  offpeakCountNonTerminalJson(dbPath: string): number;
  offpeakHasActiveBoundTaskJson(dbPath: string, workspaceKey: string, sessionId: string): boolean;
  offpeakListNonTerminalJson(dbPath: string): string;
  offpeakListUnsettledTerminalJson(dbPath: string): string;
}

/**
 * Resolve the compiled addon path. `ZCODE_DB_NATIVE` (absolute) wins — the packaged/desktop host
 * sets it to the staged native resource (same pattern as the other runtime asset prebuilds).
 * Falls back to `zcode_db.node` at this package root for the pnpm/dev workspace.
 */
function resolveNativePath(): string {
  const fromEnv = process.env.ZCODE_DB_NATIVE;
  if (fromEnv) {
    if (!existsSync(fromEnv)) {
      throw new Error(`ZCODE_DB_NATIVE points to a missing file: ${fromEnv}`);
    }
    return fromEnv;
  }
  // This module lives at packages/desktop/zcode-db/addon.ts; the built addon sits alongside it.
  const here = dirname(fileURLToPath(import.meta.url));
  const candidate = join(here, "zcode_db.node");
  if (!existsSync(candidate)) {
    throw new Error(
      `zcode-db native addon not found at ${candidate}. Build it (cargo build --release; cp target/release/libzcode-db.so zcode_db.node) or set ZCODE_DB_NATIVE.`,
    );
  }
  return candidate;
}

let cached: DbAddon | null = null;

/** Load (once, cached) the Rust DB addon behind its typed interface. */
export function loadAddon(): DbAddon {
  if (!cached) {
    const requireFrom = createRequire(import.meta.url);
    cached = requireFrom(resolveNativePath()) as DbAddon;
  }
  return cached;
}
