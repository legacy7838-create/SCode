// Integration contract test for the Rust DB addon facade (`addon.ts`).
// Proves the cutover entry point works end-to-end WITHOUT touching the app or the live DB:
//   1. `loadAddon()` resolves + loads the compiled `.node`.
//   2. Every `DbAddon` method the repos will call exists as a real function on the module.
//   3. A tiny e2e (bootstrap → syncTaskMeta → getTaskMeta → queryGroupedTaskViewStructure) runs
//      through the facade against a throwaway temp DB.
// Run from repo root:  node_modules/.bin/tsx packages/desktop/zcode-db/tests/addon_contract.mts
import { rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { loadAddon } = await import("../addon.ts");

const EXPECTED = [
  "bootstrapTasksIndex", "areMigrationsApplied", "runStartupRepairsJson",
  "tasksCount", "listRecentTasks", "listTasksByWorkspace", "readTaskMetaJson", "getTaskMetaJson",
  "listTaskMetasJson", "listTaskMetasFilteredJson", "queryTaskListJson", "listDeletedTaskIdsJson",
  "listSessionsByAutomationJson", "hasGroupedWorkspaceBootstrapRunJson",
  "seedTaskMetaIfMissingJson", "syncTaskMetaJson", "syncTaskMetaAtGroupedTopJson", "updateTaskStateJson", "clearTaskUnreadJson",
  "applyAgentPatchJson", "deleteArchivedTaskJson", "archiveStaleTasksJson",
  "groupingCreateTaskGroupJson", "groupingRenameTaskGroupJson", "groupingUpdateTaskGroupColorJson",
  "groupingDeleteTaskGroupJson", "groupingUpsertTopOrderJson", "groupingInitializeAtTopJson",
  "groupingApplyViewOrderJson", "groupingQueryViewStructureJson", "groupingQueryViewJson",
  "listAutomationsJson", "getAutomationJson", "updateAutomationJson", "deleteAutomationJson",
  "automationCreateJson", "automationSetEnabledJson", "automationRestartJson", "automationClaimDueJson",
  "automationMarkDispatchedJson", "automationMarkDispatchFailedJson", "automationReleaseClaimJson",
  "automationReleaseManualClaimJson", "automationTouchManualClaimJson", "automationScheduledRunCountJson",
  "automationHasTaskBindingJson", "automationGetBotDeliveryTargetJson", "automationGetModelSelectionColumnJson", "automationModelSelectionForDispatchJson", "automationRunNowJson",
  "automationClaimManualRunsJson", "automationSkipAndRescheduleJson", "automationMarkManualRunDispatchedJson",
  "automationListRunsJson", "automationGetRunJson", "automationDeleteRunJson", "automationPruneRunsJson",
  "automationEnsureRunClaimedJson", "automationUpsertRunClaimedJson", "automationFixRunModelSelectionJson",
  "automationMarkRunDispatchJson", "automationMarkRunOutcomeJson", "automationRecordSkippedRunJson",
  "listOffPeakJson", "getOffPeakJson", "offpeakCreateJson", "offpeakInvalidateModelSelectionJson",
  "offpeakUpdateEditableFieldsJson", "offpeakUpdateSchedulingSnapshotJson", "offpeakDeleteJson",
  "offpeakMarkHistoryDeletedJson", "offpeakClaimDueJson", "offpeakMarkRunningJson", "offpeakMarkTerminalJson",
  "offpeakSetPausedJson", "offpeakReleaseClaimJson", "offpeakRecoverInterruptedJson", "offpeakMarkSettledJson",
  "offpeakCountNonTerminalJson", "offpeakHasActiveBoundTaskJson", "offpeakListNonTerminalJson",
  "offpeakListUnsettledTerminalJson", "offpeakCountActiveJson", "offpeakRequeueForContinuationJson",
];

let failures = 0;
const fail = (msg: string): void => { failures++; console.log(`  FAIL ${msg}`); };

const addon = loadAddon();
console.log("loadAddon(): OK — compiled native module resolved");

for (const name of EXPECTED) {
  if (typeof (addon as Record<string, unknown>)[name] !== "function") fail(`missing method: ${name}`);
}
console.log(`method presence: ${EXPECTED.length - 0} names checked, ${failures === 0 ? "all present" : `${failures} missing`}`);

// e2e through the facade on a temp DB.
const dir = mkdtempSync(join(tmpdir(), "zcode-contract-"));
const db = join(dir, "tasks-index.sqlite");
try {
  const kind = addon.bootstrapTasksIndex(db, 25);
  if (typeof kind !== "string") fail(`bootstrap returned ${typeof kind}`);
  const ws = "/contract/ws";
  const meta = { taskId: "c1", traceId: "t", title: "Hello", workspacePath: ws, createdAt: 100, updatedAt: 200, mode: "build", provider: "glm" };
  const synced = JSON.parse(addon.syncTaskMetaJson(db, ws, JSON.stringify(meta), JSON.stringify({}), 500));
  if (synced.title !== "Hello") fail(`sync returned title=${synced.title}`);
  const read = JSON.parse(addon.getTaskMetaJson(db, ws, "c1") ?? "null");
  if (!read || read.taskId !== "c1") fail("getTaskMetaJson roundtrip mismatch");
  const structure = JSON.parse(addon.groupingQueryViewStructureJson(db, JSON.stringify([{ workspacePath: ws }])));
  if (!Array.isArray(structure.groups) || !Array.isArray(structure.members) || !Array.isArray(structure.topLevelOrders)) fail("structure shape wrong");
  const view = JSON.parse(addon.groupingQueryViewJson(db, JSON.stringify([{ workspacePath: ws }]), false, null, 600));
  if (!Array.isArray(view.nodes)) fail("grouped view shape wrong");
  if (addon.areMigrationsApplied(db) !== true) fail("areMigrationsApplied false on fresh db");
  console.log("e2e through facade: OK (bootstrap → sync → read → structure → view → migrations)");
} catch (e) {
  fail(`e2e threw: ${(e as Error).message}`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}

if (failures === 0) console.log("ADDON CONTRACT: OK");
else console.log(`ADDON CONTRACT: ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
