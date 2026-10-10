// Node-API loader for the Rust `zcode-db` addon, used by the Agent CLI session store.
//
// This is the CLI-side twin of `packages/desktop/zcode-db/addon.ts` / `packages/services/src/session/
// zcodeDb.ts`: the desktop and the CLI are separate build graphs, and `apps/zcode-cli` must not import
// `packages/desktop` (layer boundary), so each side declares the slice of the addon it actually calls.
// Every op takes/returns JSON strings (the ported serde projections) or primitives; `now` and every
// generated id are injected by the caller so the addon never reads the clock and stays deterministic.
//
// Resolution order (same contract as the desktop loader):
//   1. `process.env.ZCODE_DB_NATIVE` (absolute) — what a packaged host sets to the staged native
//      resource, mirroring the other runtime asset prebuilds.
//   2. the staged cargo artifact at `packages/desktop/zcode-db/zcode_db.node` (pnpm/dev workspace).
// There is deliberately NO Node built-in SQLite fallback: this module is the only DB entry point.

import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The session-store + DWF-journal slice of the Rust addon surface (the ops `SqliteSessionStore` and
 * the journal adapter call). Signatures mirror the `#[napi]` fns in `zcode-db/src/session_*.rs`; the
 * desktop task-index/automation/off-peak ops are not re-declared here because the CLI never calls
 * them. Returns are JSON text (`"null"` for "no row") unless the op is documented as a primitive.
 */
export interface DbAddon {
  // ---- bootstrap / migration ----
  bootstrapSessionStoreJson(dbPath: string, deadlineMs: number, now: number): string;
  areSessionMigrationsApplied(dbPath: string): boolean;

  // ---- session reads ----
  getSessionJson(dbPath: string, sessionId: string): string;
  listSessionsJson(dbPath: string, filterJson: string): string;
  sessionEntriesJson(dbPath: string, sessionId: string, entryType: string | null): string;
  messagesJson(dbPath: string, sessionId: string): string;
  messageWithPartsJson(dbPath: string, sessionId: string, messageId: string): string;
  readTodosJson(dbPath: string, sessionId: string): string;
  readTargetJson(dbPath: string, sessionId: string): string;
  listSessionInputsJson(dbPath: string, sessionId: string, status: string | null): string;
  getSessionInputByIdJson(dbPath: string, id: string): string;
  getProjectPermissionJson(dbPath: string, projectId: string): string;
  getProjectPermissionModeJson(dbPath: string, projectId: string): string;
  recallPreviousInputHistoryJson(dbPath: string, projectId: string, skip: number): string;
  getScriptWorkflowRunJson(dbPath: string, runId: string): string;
  listScriptWorkflowRunsJson(dbPath: string, filterJson: string): string;
  listScriptWorkflowActivitiesJson(dbPath: string, runId: string): string;
  listScriptWorkflowEventsJson(dbPath: string, runId: string, limit: number | null): string;
  findCachedScriptWorkflowActivityJson(dbPath: string, filterJson: string): string;
  queryTaskUsageJson(dbPath: string, sessionId: string): string;
  queryAppUsageJson(dbPath: string, since: number, until: number, tzOffsetMs: number): string;

  // ---- session writes ----
  createSessionJson(dbPath: string, inputJson: string, now: number): string;
  updateSessionJson(dbPath: string, inputJson: string, now: number): string;
  setRevertJson(dbPath: string, inputJson: string, now: number): string;
  clearRevertJson(dbPath: string, sessionId: string, now: number): string;
  claimLegacySessionWorkspaceJson(dbPath: string, inputJson: string): string;
  repairLegacyRemoteSessionWorkspaceJson(dbPath: string, inputJson: string): string;
  repairRemoteSessionPathsJson(dbPath: string, inputJson: string): string;
  saveMessageJson(
    dbPath: string,
    messageJson: string,
    copyFromJson: string | null,
    now: number,
  ): string;
  savePartJson(dbPath: string, partJson: string, copyFromJson: string | null, now: number): string;
  removeMessageJson(dbPath: string, sessionId: string, messageId: string): string;
  removePartJson(dbPath: string, sessionId: string, messageId: string, partId: string): string;
  saveSessionEntryJson(dbPath: string, entryJson: string): string;
  saveSessionInputJson(
    dbPath: string,
    id: string,
    sessionId: string,
    kind: string,
    delivery: string,
    payloadJson: string,
    now: number,
  ): string;
  updateSessionInputsJson(dbPath: string, sessionId: string, updatesJson: string, now: number): string;
  promoteSessionInputJson(
    dbPath: string,
    id: string,
    sessionId: string,
    messageJson: string,
    partsJson: string,
    now: number,
  ): string;
  markSessionInputPromotedJson(
    dbPath: string,
    id: string,
    sessionId: string,
    promotedMessageId: string,
    now: number,
  ): string;
  settleSessionInputJson(
    dbPath: string,
    id: string,
    sessionId: string,
    status: string,
    reason: string | null,
    now: number,
  ): string;
  createForkedSessionWithMetadataJson(
    dbPath: string,
    inputJson: string,
    metadataJson: string,
    now: number,
  ): string;
  commitForkBundleJson(dbPath: string, bundleJson: string, now: number): string;
  commitSharedContextImportBundleJson(dbPath: string, bundleJson: string, now: number): string;
  transitionSharedContextImportJson(dbPath: string, inputJson: string, now: number): string;
  commitPermissionFullAccessJson(dbPath: string, inputJson: string, now: number): string;
  recordInputHistoryJson(dbPath: string, inputJson: string, id: string, now: number): string;
  saveProjectPermissionJson(
    dbPath: string,
    projectId: string,
    permissionJson: string,
    now: number,
  ): string;
  saveProjectPermissionModeJson(dbPath: string, projectId: string, mode: string, now: number): string;
  updateTodosJson(dbPath: string, sessionId: string, todosJson: string, now: number): string;

  // ---- session target (goal) writes ----
  setSessionTargetJson(
    dbPath: string,
    sessionId: string,
    targetId: string,
    objective: string,
    status: string,
    tokenBudget: number | null,
    now: number,
  ): string;
  createSessionTargetJson(
    dbPath: string,
    sessionId: string,
    targetId: string,
    objective: string,
    tokenBudget: number | null,
    now: number,
  ): string;
  updateSessionTargetStatusJson(dbPath: string, sessionId: string, status: string, now: number): string;
  clearSessionTargetJson(dbPath: string, sessionId: string, now: number): string;
  updateTargetSummaryTitleJson(
    dbPath: string,
    sessionId: string,
    targetId: string,
    summaryTitle: string,
    now: number,
  ): string;
  startSessionTargetRunJson(
    dbPath: string,
    sessionId: string,
    targetId: string,
    inputId: string,
    startedAtMs: number,
  ): string;
  heartbeatSessionTargetRunJson(
    dbPath: string,
    sessionId: string,
    targetId: string,
    inputId: string,
    seenAtMs: number,
  ): string;
  finishSessionTargetRunJson(
    dbPath: string,
    sessionId: string,
    targetId: string,
    inputId: string,
    endedAtMs: number,
    status: string | null,
    tokensUsedDelta: number | null,
  ): string;
  recoverInterruptedSessionTargetRunJson(dbPath: string, sessionId: string): string;
  accountSessionTargetUsageJson(
    dbPath: string,
    sessionId: string,
    targetId: string,
    tokensUsedDelta: number | null,
    timeUsedSecondsDelta: number | null,
    now: number,
  ): string;
  cloneSessionTargetForForkJson(
    dbPath: string,
    sourceJson: string,
    sessionId: string,
    status: string,
    now: number,
  ): string;

  // ---- usage writes ----
  recordModelUsageJson(dbPath: string, modelJson: string, now: number): string;
  upsertTurnUsageJson(dbPath: string, turnJson: string, now: number): string;
  upsertToolUsageJson(dbPath: string, toolJson: string, now: number): string;
  pruneUsageJson(dbPath: string, beforeTime: number | null, now: number): string;

  // ---- script workflow writes ----
  upsertScriptWorkflowDefinitionJson(dbPath: string, definitionJson: string, now: number): string;
  createScriptWorkflowRunJson(dbPath: string, runJson: string, now: number): string;
  updateScriptWorkflowRunJson(dbPath: string, runJson: string, now: number): string;
  createScriptWorkflowActivityJson(dbPath: string, activityJson: string, now: number): string;
  updateScriptWorkflowActivityJson(dbPath: string, activityJson: string, now: number): string;
  appendScriptWorkflowEventJson(dbPath: string, eventJson: string, now: number): string;
  createSessionTaskLinkJson(dbPath: string, linkJson: string, now: number): string;

  // ---- DWF journal writes ----
  dwfCreateRunJson(dbPath: string, recordJson: string, now: number): string;
  dwfUpdateRunStatusJson(
    dbPath: string,
    runId: string,
    status: string,
    settlementJson: string,
    now: number,
  ): string;
  dwfUpdateRunUsageJson(dbPath: string, runId: string, spentTokens: number, now: number): string;
  dwfUpdateRunCapsJson(dbPath: string, runId: string, capsJson: string, now: number): string;
  dwfPutActorJson(dbPath: string, recordJson: string, now: number): string;
  dwfPutNodeJson(dbPath: string, recordJson: string, now: number): string;
  dwfAppendEventJson(dbPath: string, runId: string, eventJson: string, now: number): string;

  // ---- DWF journal reads ----
  dwfGetRunJson(dbPath: string, runId: string): string;
  dwfGetActorJson(dbPath: string, runId: string, siteId: string, ordinal: number): string;
  dwfListActorsJson(dbPath: string, runId: string): string;
  dwfGetNodeJson(dbPath: string, runId: string, siteId: string, ordinal: number): string;
  dwfListNodesJson(dbPath: string, runId: string): string;
  dwfListEventsJson(dbPath: string, runId: string, optsJson: string): string;
  dwfListNonTerminalRunsJson(dbPath: string, parentSessionId: string): string;
  dwfListRunsJson(dbPath: string, queryJson: string): string;
  dwfListRunsByParentSessionJson(dbPath: string, parentSessionId: string, limit: number): string;
  dwfGetRunRowJson(dbPath: string, runId: string): string;
  dwfCountNodesByStatusJson(dbPath: string, runId: string): string;
  dwfListRecentLogEventsJson(dbPath: string, runId: string, limit: number): string;
  dwfListRunLifeSpansJson(dbPath: string, runId: string): string;
  dwfListArtifactRowsJson(dbPath: string, runId: string): string;
  dwfListWorldNodesJson(dbPath: string, runId: string): string;
  dwfListArtifactItemsJson(
    dbPath: string,
    runId: string,
    artifactId: string,
    queryJson: string,
  ): string;

  // ---- read-only raw-row dump for the developer observation server ----
  debugObservationJson(
    dbPath: string,
    sessionsLimit: number,
    messagesLimit: number,
    partsLimit: number,
  ): string;
}

/** Resolve the compiled addon path: `ZCODE_DB_NATIVE` wins, else the staged cargo artifact. */
function resolveNativePath(): string {
  const fromEnv = process.env.ZCODE_DB_NATIVE;
  if (fromEnv) {
    if (!existsSync(fromEnv)) {
      throw new Error(`ZCODE_DB_NATIVE points to a missing file: ${fromEnv}`);
    }
    return fromEnv;
  }
  // .../apps/zcode-cli/packages/adapters/src/storage/session-store → repo root.
  const here = dirname(fileURLToPath(import.meta.url));
  const candidate = join(here, "../../../../../../../packages/desktop/zcode-db/zcode_db.node");
  if (!existsSync(candidate)) {
    throw new Error(
      `zcode-db native addon not found at ${candidate}. Build it with: ` +
        `node packages/desktop/scripts/prepare-zcode-db-native.mjs (or set ZCODE_DB_NATIVE).`,
    );
  }
  return candidate;
}

let cached: DbAddon | null = null;

/** Load (once, cached) the Rust DB addon behind its typed interface. */
export function loadSessionAddon(): DbAddon {
  if (!cached) {
    const requireFrom = createRequire(import.meta.url);
    cached = requireFrom(resolveNativePath()) as DbAddon;
  }
  return cached;
}
