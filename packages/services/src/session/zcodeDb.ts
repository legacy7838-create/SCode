// Node-API native binding loader for the Rust `zcode-db` addon, consumed by the session repos.
//
// The session repos already run in a Node process (they used `node:sqlite`), so they load the
// compiled addon here exactly the way `node:sqlite` was required before — a single `createRequire`.
// `loadDb()` resolves and caches the `.node` behind the typed `DbAddon` interface. Path resolution:
//   1. `process.env.ZCODE_DB_NATIVE` (absolute) — the desktop host / server sets this to the staged
//      native resource (same env-driven pattern as the other runtime asset prebuilds).
//   2. otherwise the cargo build output at `packages/desktop/zcode-db/zcode_db.node` (dev workspace).
// No `node:sqlite` import lives here: this module IS the JS-free DB entry point.

import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Every Rust DB op (JSON-string and primitive IO); mirrors the `#[napi]` fns in `zcode-db/src/lib.rs`. */
export interface DbAddon {
  bootstrapTasksIndex(dbPath: string, deadlineMs: number): string;
  areMigrationsApplied(dbPath: string): boolean;
  runStartupRepairsJson(dbPath: string, now: number): void;

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

  syncTaskMetaJson(
    dbPath: string,
    workspaceKey: string,
    incomingJson: string,
    paramsJson: string,
    searchableText: string | null,
    now: number,
  ): string;
  seedTaskMetaIfMissingJson(dbPath: string, workspaceKey: string, incomingJson: string): string;
  syncTaskMetaAtGroupedTopJson(
    dbPath: string,
    workspaceKey: string,
    incomingJson: string,
    paramsJson: string,
    searchableText: string | null,
    now: number,
  ): string;
  updateTaskStateJson(
    dbPath: string,
    workspaceKey: string,
    taskId: string,
    patchJson: string,
  ): string | null;
  clearTaskUnreadJson(
    dbPath: string,
    workspaceKey: string,
    taskId: string,
    expectedUnreadAt: number,
  ): string;
  applyAgentPatchJson(
    dbPath: string,
    workspaceKey: string,
    taskId: string,
    patchJson: string,
  ): string | null;
  deleteArchivedTaskJson(dbPath: string, workspaceKey: string, taskId: string): string | null;
  archiveStaleTasksJson(
    dbPath: string,
    workspaceKey: string,
    cutoff: number,
    provider: string | null,
  ): string;

  groupingCreateTaskGroupJson(
    dbPath: string,
    title: string | null,
    color: string | null,
    now: number,
  ): string;
  groupingRenameTaskGroupJson(dbPath: string, groupId: string, title: string, now: number): string;
  groupingUpdateTaskGroupColorJson(
    dbPath: string,
    groupId: string,
    color: string,
    now: number,
  ): string;
  groupingDeleteTaskGroupJson(dbPath: string, groupId: string): void;
  groupingUpsertTopOrderJson(
    dbPath: string,
    nodeType: string,
    nodeKey: string,
    sortOrder: number,
    now: number,
  ): void;
  groupingInitializeAtTopJson(dbPath: string, taskJson: string, now: number): boolean;
  groupingApplyViewOrderJson(dbPath: string, inputJson: string, now: number): void;
  groupingQueryViewStructureJson(dbPath: string, scopesJson: string): string;
  groupingQueryViewJson(
    dbPath: string,
    scopesJson: string,
    includeAll: boolean,
    provider: string | null,
    now: number,
  ): string;

  listAutomationsJson(dbPath: string, workspaceKey: string | null): string;
  getAutomationJson(
    dbPath: string,
    automationId: string,
    workspaceKey: string | null,
  ): string | null;
  updateAutomationJson(
    dbPath: string,
    automationId: string,
    paramsJson: string,
    optionsJson: string,
    workspaceKey: string | null,
    now: number,
  ): string | null;
  deleteAutomationJson(dbPath: string, automationId: string, workspaceKey: string | null): boolean;
  automationCreateJson(
    dbPath: string,
    paramsJson: string,
    optionsJson: string,
    now: number,
  ): string;
  automationSetEnabledJson(
    dbPath: string,
    automationId: string,
    enabled: boolean,
    workspaceKey: string | null,
    now: number,
  ): void;
  automationRestartJson(
    dbPath: string,
    automationId: string,
    nextRunAt: number | null,
    workspaceKey: string | null,
    now: number,
  ): void;
  automationClaimDueJson(dbPath: string, now: number): string;
  automationMarkDispatchedJson(
    dbPath: string,
    automationId: string,
    dispatchedAt: number,
    nextRunAt: number | null,
  ): void;
  automationMarkDispatchFailedJson(
    dbPath: string,
    automationId: string,
    failedAt: number,
    error: string,
    kind: string,
    nextRunAt: number | null,
  ): void;
  automationReleaseClaimJson(dbPath: string, automationId: string, now: number): void;
  automationReleaseManualClaimJson(
    dbPath: string,
    automationId: string,
    workspaceKey: string,
    now: number,
  ): void;
  automationTouchManualClaimJson(
    dbPath: string,
    automationId: string,
    workspaceKey: string,
    now: number,
  ): void;
  automationScheduledRunCountJson(
    dbPath: string,
    automationId: string,
    workspaceKey: string | null,
  ): number | null;
  automationHasTaskBindingJson(dbPath: string, workspaceKey: string, targetTaskId: string): boolean;
  automationModelSelectionForDispatchJson(
    dbPath: string,
    automationId: string,
    workspaceKey: string,
  ): string | null;
  automationGetBotDeliveryTargetJson(
    dbPath: string,
    automationId: string,
    workspaceKey: string | null,
  ): string | null;
  automationGetModelSelectionColumnJson(
    dbPath: string,
    automationId: string,
    workspaceKey: string | null,
  ): string;
  automationRunNowJson(
    dbPath: string,
    automationId: string,
    workspaceKey: string | null,
    now: number,
  ): string | null;
  automationClaimManualRunsJson(dbPath: string, now: number): string;
  automationSkipAndRescheduleJson(dbPath: string, paramsJson: string, now: number): void;
  automationMarkManualRunDispatchedJson(
    dbPath: string,
    runId: string,
    sessionId: string | null,
    dispatchedAt: number,
  ): boolean;
  automationListRunsJson(dbPath: string, automationId: string, workspaceKey: string | null): string;
  automationGetRunJson(dbPath: string, runId: string): string | null;
  automationDeleteRunJson(dbPath: string, runId: string, workspaceKey: string | null): void;
  automationPruneRunsJson(dbPath: string, maxAgeMs: number, now: number): number;
  automationEnsureRunClaimedJson(dbPath: string, identityJson: string, now: number): void;
  automationUpsertRunClaimedJson(
    dbPath: string,
    identityJson: string,
    selectionJson: string | null,
    now: number,
  ): void;
  automationFixRunModelSelectionJson(
    dbPath: string,
    runId: string,
    selectionJson: string,
    now: number,
  ): string;
  automationMarkRunDispatchJson(
    dbPath: string,
    runId: string,
    dispatchStatus: string,
    sessionId: string | null,
    error: string | null,
    now: number,
  ): void;
  automationMarkRunOutcomeJson(
    dbPath: string,
    runId: string,
    outcome: string,
    error: string | null,
    now: number,
  ): void;
  automationRecordSkippedRunJson(
    dbPath: string,
    identityJson: string,
    reason: string,
    now: number,
  ): void;

  listOffPeakJson(dbPath: string, workspaceKey: string | null): string;
  getOffPeakJson(dbPath: string, offPeakTaskId: string): string | null;
  offpeakCreateJson(dbPath: string, paramsJson: string, optionsJson: string, now: number): string;
  offpeakInvalidateModelSelectionJson(
    dbPath: string,
    id: string,
    selectionJson: string,
    now: number,
  ): string | null;
  offpeakUpdateEditableFieldsJson(
    dbPath: string,
    id: string,
    patchJson: string,
    now: number,
  ): string | null;
  offpeakUpdateSchedulingSnapshotJson(
    dbPath: string,
    id: string,
    patchJson: string,
    now: number,
  ): void;
  offpeakDeleteJson(dbPath: string, id: string): void;
  offpeakMarkHistoryDeletedJson(dbPath: string, id: string, now: number): string | null;
  offpeakClaimDueJson(dbPath: string, now: number): string;
  offpeakMarkRunningJson(
    dbPath: string,
    id: string,
    startedAt: number,
    conversationId: string | null,
    sessionId: string | null,
    serverTicketId: string | null,
  ): string | null;
  offpeakMarkTerminalJson(
    dbPath: string,
    id: string,
    status: string,
    endedAt: number,
    failureReason: string | null,
    filesChanged: number | null,
    dispatchError: string | null,
  ): string | null;
  offpeakSetPausedJson(dbPath: string, id: string, paused: boolean, now: number): string | null;
  offpeakReleaseClaimJson(dbPath: string, id: string, error: string | null, now: number): void;
  offpeakRecoverInterruptedJson(dbPath: string, now: number): number;
  offpeakMarkSettledJson(dbPath: string, id: string, settledAt: number): void;
  offpeakCountNonTerminalJson(dbPath: string): number;
  offpeakHasActiveBoundTaskJson(dbPath: string, workspaceKey: string, sessionId: string): boolean;
  offpeakListNonTerminalJson(dbPath: string): string;
  offpeakListUnsettledTerminalJson(dbPath: string): string;
  offpeakCountActiveJson(dbPath: string): number;
  offpeakRequeueForContinuationJson(dbPath: string, id: string, now: number): string | null;
}

function resolveNativePath(): string {
  const fromEnv = process.env.ZCODE_DB_NATIVE;
  if (fromEnv) {
    if (!existsSync(fromEnv))
      throw new Error(`ZCODE_DB_NATIVE points to a missing file: ${fromEnv}`);
    return fromEnv;
  }
  // packages/services/src/session/zcodeDb.ts → packages/desktop/zcode-db/zcode_db.node
  const here = dirname(fileURLToPath(import.meta.url));
  const candidate = join(here, "../../../desktop/zcode-db/zcode_db.node");
  if (!existsSync(candidate)) {
    throw new Error(
      `zcode-db native addon not found at ${candidate}. Build it with: node packages/desktop/scripts/prepare-zcode-db-native.mjs (or set ZCODE_DB_NATIVE).`,
    );
  }
  return candidate;
}

let cached: DbAddon | null = null;

/** Load (once, cached) the Rust DB addon behind its typed interface. */
export function loadDb(): DbAddon {
  if (!cached) {
    const req = createRequire(import.meta.url);
    cached = req(resolveNativePath()) as DbAddon;
  }
  return cached;
}
