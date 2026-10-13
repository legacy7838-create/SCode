// Integration contract test for the Rust DB addon facade (`addon.ts`).
// Proves the cutover entry point works end-to-end WITHOUT touching the app or the live DB:
//   1. `loadAddon()` resolves + loads the compiled `.node`.
//   2. Every `DbAddon` method the repos will call exists as a real function on the module.
//   3. A tiny e2e (bootstrap → syncTaskMeta → getTaskMeta → queryGroupedTaskViewStructure) runs
//      through the facade against a throwaway temp DB.
//   4. The BOUNDARY SHAPE of the heavy reads is pinned by a declared manifest (see RETURN_SHAPE),
//      so a payload type crossing the N-API edge can only change as a reviewed, recorded edit.
// Run from repo root:  node_modules/.bin/tsx packages/desktop/zcode-db/tests/addon_contract.mts
import { rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { loadAddon } = await import("../addon.ts");

const EXPECTED = [
  "bootstrapTasksIndex",
  "areMigrationsApplied",
  "runStartupRepairsJson",
  "tasksCount",
  "listRecentTasks",
  "listTasksByWorkspace",
  "readTaskMetaJson",
  "getTaskMetaJson",
  "listTaskMetasJson",
  "listTaskMetasFilteredJson",
  "queryTaskListJson",
  "listDeletedTaskIdsJson",
  "listSessionsByAutomationJson",
  "hasGroupedWorkspaceBootstrapRunJson",
  "seedTaskMetaIfMissingJson",
  "syncTaskMetaJson",
  "syncTaskMetaAtGroupedTopJson",
  "updateTaskStateJson",
  "clearTaskUnreadJson",
  "applyAgentPatchJson",
  "deleteArchivedTaskJson",
  "archiveStaleTasksJson",
  "groupingCreateTaskGroupJson",
  "groupingRenameTaskGroupJson",
  "groupingUpdateTaskGroupColorJson",
  "groupingDeleteTaskGroupJson",
  "groupingUpsertTopOrderJson",
  "groupingInitializeAtTopJson",
  "groupingApplyViewOrderJson",
  "groupingQueryViewStructureJson",
  "groupingQueryViewJson",
  "listAutomationsJson",
  "getAutomationJson",
  "updateAutomationJson",
  "deleteAutomationJson",
  "automationCreateJson",
  "automationSetEnabledJson",
  "automationRestartJson",
  "automationClaimDueJson",
  "automationMarkDispatchedJson",
  "automationMarkDispatchFailedJson",
  "automationReleaseClaimJson",
  "automationReleaseManualClaimJson",
  "automationTouchManualClaimJson",
  "automationScheduledRunCountJson",
  "automationHasTaskBindingJson",
  "automationGetBotDeliveryTargetJson",
  "automationGetModelSelectionColumnJson",
  "automationModelSelectionForDispatchJson",
  "automationRunNowJson",
  "automationClaimManualRunsJson",
  "automationSkipAndRescheduleJson",
  "automationMarkManualRunDispatchedJson",
  "automationListRunsJson",
  "automationGetRunJson",
  "automationDeleteRunJson",
  "automationPruneRunsJson",
  "automationEnsureRunClaimedJson",
  "automationUpsertRunClaimedJson",
  "automationFixRunModelSelectionJson",
  "automationMarkRunDispatchJson",
  "automationMarkRunOutcomeJson",
  "automationRecordSkippedRunJson",
  "listOffPeakJson",
  "getOffPeakJson",
  "offpeakCreateJson",
  "offpeakInvalidateModelSelectionJson",
  "offpeakUpdateEditableFieldsJson",
  "offpeakUpdateSchedulingSnapshotJson",
  "offpeakDeleteJson",
  "offpeakMarkHistoryDeletedJson",
  "offpeakClaimDueJson",
  "offpeakMarkRunningJson",
  "offpeakMarkTerminalJson",
  "offpeakSetPausedJson",
  "offpeakReleaseClaimJson",
  "offpeakRecoverInterruptedJson",
  "offpeakMarkSettledJson",
  "offpeakCountNonTerminalJson",
  "offpeakHasActiveBoundTaskJson",
  "offpeakListNonTerminalJson",
  "offpeakListUnsettledTerminalJson",
  "offpeakCountActiveJson",
  "offpeakRequeueForContinuationJson",
];

let failures = 0;
const fail = (msg: string): void => {
  failures++;
  console.log(`  FAIL ${msg}`);
};

const addon = loadAddon();
console.log("loadAddon(): OK — compiled native module resolved");

// 修正记录:`addon as Record<string, unknown>` 在 strict 下是 TS2352(DbAddon 没有索引签名)。
// 该文件不在任何 tsconfig 的 include 里(pnpm typecheck 覆盖不到),所以这个错误一直没被发现;
// 经由 unknown 二段转换是有意的存在性检查,不是类型欺骗。
const addonExports = addon as unknown as Record<string, unknown>;

for (const name of EXPECTED) {
  if (typeof addonExports[name] !== "function") fail(`missing method: ${name}`);
}
console.log(
  `method presence: ${EXPECTED.length - 0} names checked, ${failures === 0 ? "all present" : `${failures} missing`}`,
);

// e2e through the facade on a temp DB.
const dir = mkdtempSync(join(tmpdir(), "zcode-contract-"));
const db = join(dir, "tasks-index.sqlite");
try {
  const kind = addon.bootstrapTasksIndex(db, 25);
  if (typeof kind !== "string") fail(`bootstrap returned ${typeof kind}`);
  const ws = "/contract/ws";
  const meta = {
    taskId: "c1",
    traceId: "t",
    title: "Hello",
    workspacePath: ws,
    createdAt: 100,
    updatedAt: 200,
    mode: "build",
    provider: "glm",
  };
  const synced = JSON.parse(
    addon.syncTaskMetaJson(db, ws, JSON.stringify(meta), JSON.stringify({}), null, 500),
  );
  if (synced.title !== "Hello") fail(`sync returned title=${synced.title}`);
  const read = JSON.parse(addon.getTaskMetaJson(db, ws, "c1") ?? "null");
  if (!read || read.taskId !== "c1") fail("getTaskMetaJson roundtrip mismatch");
  const structure = JSON.parse(
    addon.groupingQueryViewStructureJson(db, JSON.stringify([{ workspacePath: ws }])),
  );
  if (
    !Array.isArray(structure.groups) ||
    !Array.isArray(structure.members) ||
    !Array.isArray(structure.topLevelOrders)
  )
    fail("structure shape wrong");
  const view = JSON.parse(
    addon.groupingQueryViewJson(db, JSON.stringify([{ workspacePath: ws }]), false, null, 600),
  );
  if (!Array.isArray(view.nodes)) fail("grouped view shape wrong");
  if (addon.areMigrationsApplied(db) !== true) fail("areMigrationsApplied false on fresh db");
  console.log("e2e through facade: OK (bootstrap → sync → read → structure → view → migrations)");
} catch (e) {
  fail(`e2e threw: ${(e as Error).message}`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// 4. Boundary-shape manifest
// ---------------------------------------------------------------------------
// 每条记录声明一个 addon 导出在 N-API 边界上必须返回的 JS 类型。
// 为什么用清单而不是随手断言 typeof:后续把大 payload 从 UTF-16 字符串改成字节(Buffer)时,
// 必须在这里加一行,边界形状的变化因此一定出现在 diff 里并被评审,而不是静默漂移。
// 见 spec/native-boundary-zcode-db.md §3。
type BoundaryShape = "string" | "bytes" | "number" | "boolean" | "array";

interface DbPaths {
  readonly taskDb: string;
  readonly sessionDb: string;
}

interface ShapeCase {
  readonly name: string;
  readonly shape: BoundaryShape;
  /** 仅对 "string" 生效:断言解析后的顶层 JSON 形态,防止退化成 `"null"` 之类的形状漂移。 */
  readonly parsed?: "array" | "object";
  readonly run: (paths: DbPaths) => unknown;
}

/**
 * The `dwf*` journal reads are exported by the addon but are NOT declared on `DbAddon` in
 * `addon.ts` — the CLI facade under
 * `apps/zcode-cli/packages/adapters/src/storage/session-store/native-addon.ts` is their only
 * consumer. Declared locally so this manifest can pin them too; consolidating the two facades is
 * tracked as a follow-up in spec/native-boundary-zcode-db.md §2.
 */
interface JournalReads {
  dwfListRunsJson(dbPath: string, queryJson: string): string;
  dwfListEventsJson(dbPath: string, runId: string, optsJson: string): string;
  dwfListArtifactRowsJson(dbPath: string, runId: string): string;
}

const journal = addon as unknown as JournalReads;

const HEAVY_READS: readonly ShapeCase[] = [
  {
    name: "messagesJson",
    shape: "string",
    parsed: "array",
    run: (p) => addon.messagesJson(p.sessionDb, "contract-missing-session"),
  },
  {
    name: "listTaskMetasJson",
    shape: "string",
    parsed: "array",
    run: (p) => addon.listTaskMetasJson(p.taskDb, "/contract/ws"),
  },
  {
    name: "dwfListRunsJson",
    shape: "string",
    parsed: "array",
    run: (p) => journal.dwfListRunsJson(p.sessionDb, JSON.stringify({ limit: 10 })),
  },
  {
    name: "dwfListEventsJson",
    shape: "string",
    parsed: "array",
    run: (p) => journal.dwfListEventsJson(p.sessionDb, "contract-missing-run", ""),
  },
  {
    name: "dwfListArtifactRowsJson",
    shape: "string",
    parsed: "array",
    run: (p) => journal.dwfListArtifactRowsJson(p.sessionDb, "contract-missing-run"),
  },
];

const TYPED_READS: readonly ShapeCase[] = [
  { name: "tasksCount", shape: "number", run: (p) => addon.tasksCount(p.taskDb) },
  {
    name: "areMigrationsApplied",
    shape: "boolean",
    run: (p) => addon.areMigrationsApplied(p.taskDb),
  },
  {
    name: "areSessionMigrationsApplied",
    shape: "boolean",
    run: (p) => addon.areSessionMigrationsApplied(p.sessionDb),
  },
  { name: "listRecentTasks", shape: "array", run: (p) => addon.listRecentTasks(p.taskDb, 5) },
  {
    name: "bootstrapTasksIndex",
    shape: "string",
    run: (p) => addon.bootstrapTasksIndex(p.taskDb, 25),
  },
  {
    name: "bootstrapSessionStoreJson",
    shape: "string",
    parsed: "object",
    run: (p) => addon.bootstrapSessionStoreJson(p.sessionDb, 5000, Date.now()),
  },
];

const shapeOf = (value: unknown): BoundaryShape | "other" => {
  if (value instanceof Uint8Array) return "bytes";
  if (Array.isArray(value)) return "array";
  // 逐条返回字面量:直接 `return typeof value` 在 strict 下会把 bigint/symbol/function
  // 一起带进来,类型无法收窄(这正是第一版没通过 tsc 的原因)。
  if (typeof value === "number") return "number";
  if (typeof value === "boolean") return "boolean";
  if (typeof value === "string") return "string";
  return "other";
};

const shapeDir = mkdtempSync(join(tmpdir(), "zcode-shape-"));
try {
  const paths: DbPaths = {
    taskDb: join(shapeDir, "tasks-index.sqlite"),
    sessionDb: join(shapeDir, "db.sqlite"),
  };
  // Create both DBs up front so the read cases have something to open. The two bootstrap calls
  // also appear in TYPED_READS below, which re-invokes them to prove they are idempotent and
  // still return their declared boundary type on the second run.
  addon.bootstrapTasksIndex(paths.taskDb, 25);
  addon.bootstrapSessionStoreJson(paths.sessionDb, 5000, Date.now());

  let checked = 0;
  for (const group of [
    ["heavy read", HEAVY_READS] as const,
    ["typed read", TYPED_READS] as const,
  ]) {
    for (const c of group[1]) {
      checked++;
      let value: unknown;
      try {
        value = c.run(paths);
      } catch (e) {
        fail(`${group[0]} ${c.name} threw: ${(e as Error).message}`);
        continue;
      }
      const got = shapeOf(value);
      if (got !== c.shape) {
        fail(`${group[0]} ${c.name}: expected ${c.shape} at the boundary, got ${got}`);
        continue;
      }
      if (c.parsed !== undefined) {
        const text = value as string;
        let top: unknown;
        try {
          top = JSON.parse(text);
        } catch {
          fail(`${group[0]} ${c.name}: string is not valid JSON`);
          continue;
        }
        const kind = Array.isArray(top) ? "array" : typeof top;
        if (kind !== c.parsed) fail(`${group[0]} ${c.name}: parses to ${kind}, want ${c.parsed}`);
      }
    }
  }
  console.log(`boundary shape: ${checked} exports pinned to their N-API return type`);

  // The export surface is frozen: a rename/removal must be a reviewed edit to this file.
  const exported = Object.keys(addonExports).length;
  if (exported !== 177) fail(`export surface drift: ${exported} addon exports, expected 177`);
  else console.log(`export surface: 177 exports, unchanged`);
} catch (e) {
  fail(`boundary shape section threw: ${(e as Error).message}`);
} finally {
  rmSync(shapeDir, { recursive: true, force: true });
}

if (failures === 0) console.log("ADDON CONTRACT: OK");
else console.log(`ADDON CONTRACT: ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
