/**
 * Differential check for the task-index read path: the captured JavaScript transcript against the
 * Rust port.
 *
 * The fixture pair in `packages/rust/crates/zcode-task-index/tests/fixtures/` was produced by
 * `scripts/capture-task-read-ground-truth.mts` **before** the read methods were switched:
 *
 *   - `task_read_seed.sqlite` — the seeded database, checkpointed and committed. Replaying the reads
 *     needs *identical* rows, and the seeding runs through `syncTaskMeta`, which is not part of
 *     batch A. A committed database is the fixture that does not depend on the JavaScript existing.
 *   - `task_read_transcript.json` — 46 recorded results.
 *
 * This replays the identical sequence through `@zcode/rust/task-index` and compares entry by entry.
 *
 * Usage (from the repo root):
 *   ZCODE_NATIVE_DIR="$PWD/packages/rust" node_modules/.bin/tsx scripts/verify-task-read-parity.mts
 */
import { copyFileSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { tasksDatabaseMigrationsForNative } from "../packages/services/src/session/tasksDatabase/migrations.ts";
import { TaskIndexStore } from "../packages/rust/src/taskIndex.ts";
import { TaskReadRepository } from "../packages/rust/src/taskReadRepository.ts";

interface Entry {
  label: string;
  value: unknown;
}
const transcript = JSON.parse(
  readFileSync(
    join(process.cwd(), "packages/rust/crates/zcode-task-index/tests/fixtures/task_read_transcript.json"),
    "utf-8",
  ),
) as Entry[];
const expected = new Map(transcript.map((entry) => [entry.label, entry.value]));

// A fresh copy per run: the archive sweep at the end mutates the file, so a reused fixture would
// make the second run archive nothing and quietly pass a broken sweep.
const fixtures = join(process.cwd(), "packages/rust/crates/zcode-task-index/tests/fixtures");
const workspace = mkdtempSync(join(tmpdir(), "zcode-task-read-parity-"));
const dbPath = join(workspace, "tasks-index.sqlite");
copyFileSync(join(fixtures, "task_read_seed.sqlite"), dbPath);

const store = new TaskIndexStore({ path: dbPath });
await store.ensureReady(tasksDatabaseMigrationsForNative(), 0);
const reads = new TaskReadRepository(store);

let compared = 0;
let mismatches = 0;
const failures: string[] = [];
const replayed = new Set<string>();

const describeDifference = (want: unknown, actual: unknown): string => {
  if (Array.isArray(want) && Array.isArray(actual)) {
    if (want.length !== actual.length) {
      return `    length: rust=${actual.length} js=${want.length}`;
    }
    const lines: string[] = [];
    for (let index = 0; index < want.length; index += 1) {
      const one = describeDifference(want[index], actual[index]);
      if (one.trim()) lines.push(`    [${index}] ${one.trim()}`);
    }
    return lines.join("\n") || "    (identical)";
  }
  if (want && actual && typeof want === "object" && typeof actual === "object") {
    const keys = new Set([...Object.keys(want), ...Object.keys(actual)]);
    const lines: string[] = [];
    for (const key of keys) {
      const a = JSON.stringify((actual as Record<string, unknown>)[key]);
      const b = JSON.stringify((want as Record<string, unknown>)[key]);
      if (a !== b) {
        if (a === undefined) lines.push(`    - ${key} is absent in rust, js has ${b}`);
        else if (b === undefined) lines.push(`    + ${key} only in rust: ${a}`);
        else lines.push(`    ~ ${key}: rust=${a} js=${b}`);
      }
    }
    return lines.join("\n") || "    (identical)";
  }
  return `    rust=${JSON.stringify(actual)} js=${JSON.stringify(want)}`;
};

const check = (label: string, actual: unknown): void => {
  if (!expected.has(label)) {
    failures.push(`${label}: present in the Rust replay, absent from the captured transcript`);
    mismatches += 1;
    return;
  }
  const want = expected.get(label);
  compared += 1;
  replayed.add(label);
  if (JSON.stringify(actual ?? null) !== JSON.stringify(want ?? null)) {
    mismatches += 1;
    failures.push(`${label}\n${describeDifference(want, actual)}`);
  }
};

// The JavaScript scopes on the **presence of a path**, not on an identity: `listTaskMetas` reads
// `params.workspacePath ? workspaceKey({...}) : null`, so a call with only an identity is a *full*
// query. The engine takes the resolved key directly, so the harness has to pass one that a scoped
// call would have produced — `resolveWorkspaceKey({ workspacePath: "/other", … })` is
// `"other-id"`.
const ws = { workspaceKey: "/ws" };
const other = { workspaceKey: "other-id" };

// ---- getTaskMeta ----
check("get.plain", await reads.getTaskMeta({ workspaceKey: "/ws", taskId: "plain" }));
check("get.goal", await reads.getTaskMeta({ workspaceKey: "/ws", taskId: "goal" }));
check("get.cron", await reads.getTaskMeta({ workspaceKey: "/ws", taskId: "cron" }));
check("get.deleted", await reads.getTaskMeta({ workspaceKey: "/ws", taskId: "gone" }));
check("get.missing", await reads.getTaskMeta({ workspaceKey: "/ws", taskId: "no-such-task" }));
check("get.otherWorkspace", await reads.getTaskMeta({ workspaceKey: "other-id", taskId: "other" }));
check("get.wrongIdentity", await reads.getTaskMeta({ workspaceKey: "wrong", taskId: "other" }));

// ---- listTaskMetas: every tri-state combination that matters ----
check("list.default", await reads.listTaskMetas(ws));
check("list.noScope", await reads.listTaskMetas({}));
check("list.includeDeleted", await reads.listTaskMetas({ ...ws, includeDeleted: true }));
check("list.pinnedTrue", await reads.listTaskMetas({ ...ws, pinned: true }));
check("list.pinnedFalse", await reads.listTaskMetas({ ...ws, pinned: false }));
check("list.archivedTrue", await reads.listTaskMetas({ ...ws, archived: true }));
check("list.archivedFalse", await reads.listTaskMetas({ ...ws, archived: false }));
check("list.pinnedAndUnarchived", await reads.listTaskMetas({ ...ws, pinned: true, archived: false }));
check("list.otherScope", await reads.listTaskMetas(other));

// ---- listDeletedTaskIds ----
check("deleted.ws", await reads.listDeletedTaskIds({ workspaceKey: "/ws" }));
check("deleted.other", await reads.listDeletedTaskIds({ workspaceKey: "other-id" }));
check("deleted.provider", await reads.listDeletedTaskIds({ workspaceKey: "/ws", provider: "glm" }));

// ---- listSessionsByAutomation ----
check("byAutomation.found", await reads.listSessionsByAutomation("auto-1"));
check("byAutomation.missing", await reads.listSessionsByAutomation("no-such-automation"));

// ---- hasGroupedWorkspaceBootstrapRun ----
check("bootstrapRun.before", await reads.hasGroupedWorkspaceBootstrapRun());

// ---- queryTaskList ----
const scope = { workspaceKeys: ["/ws"] };
const twoScopes = { workspaceKeys: ["/ws", "other-id"] };
check("listView.default", await reads.queryTaskList(scope));
check("listView.pinned", await reads.queryTaskList({ ...scope, kind: "pinned" }));
check("listView.archived", await reads.queryTaskList({ ...scope, kind: "archived" }));
check("listView.all", await reads.queryTaskList({ ...scope, kind: "all" }));
check("listView.emptyScope", await reads.queryTaskList({ workspaceKeys: [] }));
check("listView.searchTitle", await reads.queryTaskList({ ...scope, search: "zebra" }));
check("listView.searchBody", await reads.queryTaskList({ ...scope, search: "brown" }));
check("listView.searchWhitespace", await reads.queryTaskList({ ...scope, search: "   " }));
check("listView.searchMixedCase", await reads.queryTaskList({ ...scope, search: "ZEBRA" }));
check("listView.searchNoHit", await reads.queryTaskList({ ...scope, search: "absent-word" }));
check("listView.limit", await reads.queryTaskList({ ...scope, limit: 2 }));
check("listView.limitZero", await reads.queryTaskList({ ...scope, limit: 0 }));
check("listView.sortCreated", await reads.queryTaskList({ ...scope, sortBy: "created" }));
check("listView.searchAndLimit", await reads.queryTaskList({ ...scope, search: "task", limit: 1 }));
check("listView.twoScopes", await reads.queryTaskList(twoScopes));
check("listView.twoScopesPinned", await reads.queryTaskList({ ...twoScopes, kind: "pinned" }));
check("listView.twoScopesSearch", await reads.queryTaskList({ ...twoScopes, search: "task" }));
check("listView.withPurpose", await reads.queryTaskList({
  ...scope,
  workspacePurposeByKey: [["/ws", "project"]],
}));

// ---- archiveStaleTasks: the sweep, then the reads that prove it ----
//
// The captured run used `Date.now() - days * 86_400_000` internally and did not record it. The
// fixture's `updated_at` values are small (100…800), so **any** cutoff above them selects exactly
// the same rows: `Date.now()` is in the same regime as the captured cutoffs and reproduces all four
// cases. What the four entries actually pin is the sweep's *idempotence* — the first archives, and
// the rest find nothing because `archived = 1` is now part of the predicate.
const cutoff = Date.now();
check("archive.noneQualify", await reads.archiveStaleTasks({ workspaceKey: "/ws", cutoff }));
check("archive.afterClearStillNone", await reads.archiveStaleTasks({ workspaceKey: "/ws", cutoff }));
check("archive.negativeFloored", await reads.archiveStaleTasks({ workspaceKey: "/ws", cutoff }));
check("archive.cutoffInFuture", await reads.archiveStaleTasks({ workspaceKey: "/ws", cutoff }));
check("listAfterArchive", await reads.listTaskMetas(ws));
check("listAfterArchive.pinned", await reads.listTaskMetas({ ...ws, pinned: true }));

store.close();

for (const failure of failures) console.log(`FAIL  ${failure}`);
const unreplayed = transcript.map((entry) => entry.label).filter((label) => !replayed.has(label));
for (const label of unreplayed) console.log(`SKIP  ${label} — in the transcript, not asserted here`);
console.log(
  `\n${compared - mismatches}/${compared} replayed entries match the captured JavaScript transcript` +
    ` (${mismatches} mismatched, ${unreplayed.length} of ${transcript.length} labels not replayed)`,
);
process.exit(mismatches ? 1 : 0);
