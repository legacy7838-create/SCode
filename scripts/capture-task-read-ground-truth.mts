/**
 * Differential capture for the task-index read path.
 *
 * Drives the **JavaScript** `TaskIndexRepo` through every read — and every filter combination that
 * matters — and records the result. The Rust port is then asserted against that file by
 * `scripts/verify-task-read-parity.mts`.
 *
 * The point is the cases where a read *silently* returns the wrong thing: a deleted task that reads
 * as live, an absent filter that narrows, a kind that is not the closed set it looks like, a
 * `hasMore` that compares the page against itself. None of them throw, and none is visible without
 * an expected value recorded in the other language.
 *
 * Usage (from the repo root):
 *   node_modules/.bin/tsx scripts/capture-task-read-ground-truth.mts
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { checkpointTaskIndexWal } from "../packages/rust/src/taskIndex.ts";

import { TaskIndexRepo } from "../packages/services/src/session/taskIndexRepo.ts";

const workspace = mkdtempSync(join(tmpdir(), "zcode-task-read-gt-"));
const dbPath = join(workspace, "tasks-index.sqlite");

const transcript: unknown[] = [];
const record = (label: string, value: unknown): void => {
  transcript.push({ label, value });
};

const repo = new TaskIndexRepo(dbPath);
await repo.ensureReady();

// `syncTaskMeta` is the only way to create a task, and it is not part of batch A, so the fixture
// rows go in through it — the *read* results are what this transcript is about.
const meta = (over: Record<string, unknown>) => ({
  taskId: "t",
  traceId: "tr",
  title: "t",
  workspacePath: "/ws",
  createdAt: 1,
  updatedAt: 1,
  mode: "auto",
  ...over,
});

const seed = async (
  taskId: string,
  over: Record<string, unknown>,
  options?: Record<string, unknown>,
): Promise<void> => {
  // `searchableText` and the flags are **sync options**, not meta fields; passing them inside the
  // meta writes them to meta_json where nothing reads them.
  const { searchableText, ...metaOverrides } = over as Record<string, unknown> & {
    searchableText?: string;
  };
  await repo.syncTaskMeta({
    meta: meta({ taskId, ...metaOverrides }) as never,
    // Spreading an empty object when there is no text is the same as spreading nothing.
    ...(searchableText === undefined ? undefined : { searchableText }),
    ...options,
  });
};

/** Marks a task completed, which is the status the archive sweep selects on. */
const complete = async (taskId: string): Promise<void> => {
  await repo.updateTaskState({
    workspacePath: "/ws",
    taskId,
    patch: { status: "completed", unreadAt: undefined },
  });
};

await seed("plain", { title: "plain task", updatedAt: 100, unreadAt: 1, searchableText: "the quick brown fox" });
await seed("pinned", { title: "pinned task", updatedAt: 200, unreadAt: 2 }, { pinned: true });
await seed("archived", { title: "archived task", updatedAt: 300, unreadAt: 3 }, { archived: true });
await seed("gone", { title: "deleted task", updatedAt: 400, unreadAt: 4 }, { deleted: true });
await seed("other", {
  title: "other workspace",
  updatedAt: 500,
  unreadAt: 5,
  workspacePath: "/other",
  workspaceIdentity: "other-id",
});

// A task carrying a goal, which is where the `sessionID`/`targetID` acronym lives.
await seed("goal", {
  title: "goal task",
  updatedAt: 600,
  unreadAt: 6,
  target: {
    sessionID: "sess-1",
    targetID: "goal-1",
    objective: "ship the port",
    status: "active",
    tokenBudget: null,
    tokensUsed: 4,
    timeUsedSeconds: 9,
    time: { created: 1, updated: 2 },
  },
} as never);

// A task with a cron identity, so the automation read has something to find.
await seed("cron", {
  title: "cron task",
  updatedAt: 700,
  unreadAt: 7,
  cronAutomationId: "auto-1",
});

// A task whose title only, for the fallback snippet path.
await seed("bodiless", { title: "zebra", updatedAt: 800, unreadAt: 8, searchableText: "" });

// Completed, unread-free tasks, so the archive sweep has something to select. The sweep requires
// **all** of `completed`, `unread_at IS NULL`, unpinned, unarchived and not deleted — a task
// missing any one of them is left alone, and a fixture that misses all of them proves nothing.
for (const taskId of ["plain", "bodiless", "pinned", "archived"]) {
  await complete(taskId);
}

// Checkpoint the WAL, then keep the file: replaying the reads needs *identical* rows, and the
// seeding goes through `syncTaskMeta`, which is not part of batch A. A committed database is the
// fixture that does not depend on the JavaScript still existing.
repo.close();

// Checkpoint the WAL. The database runs in WAL mode, so the writes made *after* the last
// checkpoint — the `completed` status updates — live in the `-wal` sidecar and are **not** in the
// main file. Copying `dbPath` alone produced a fixture silently missing every task the sweep
// selects, which showed up as 18 mismatches all of the form "the Rust replay is missing a row".
//
// The checkpoint runs natively: this is the harness that *produces* the fixture, and the
// assertion path is Rust. Nothing in the shipped code reads SQLite from Node — the last
// `node:sqlite` import in `scripts/` is gone (spec §28).
checkpointTaskIndexWal(dbPath);
writeFileSync(
  join(process.cwd(), "packages/rust/crates/zcode-task-index/tests/fixtures/task_read_seed.sqlite"),
  readFileSync(dbPath),
);


// ---- getTaskMeta ----
record("get.plain", await repo.getTaskMeta({ workspacePath: "/ws", taskId: "plain" }));
record("get.goal", await repo.getTaskMeta({ workspacePath: "/ws", taskId: "goal" }));
record("get.cron", await repo.getTaskMeta({ workspacePath: "/ws", taskId: "cron" }));
record("get.deleted", await repo.getTaskMeta({ workspacePath: "/ws", taskId: "gone" }));
record("get.missing", await repo.getTaskMeta({ workspacePath: "/ws", taskId: "no-such-task" }));
record("get.otherWorkspace", await repo.getTaskMeta({ workspaceIdentity: "other-id", taskId: "other" }));
// The identity rule: the same task under a path that does not match must not resolve.
record("get.wrongIdentity", await repo.getTaskMeta({ workspaceIdentity: "wrong", taskId: "other" }));

// ---- listTaskMetas: the tri-state filters ----
const all = { workspacePath: "/ws" };
record("list.default", await repo.listTaskMetas(all));
record("list.noScope", await repo.listTaskMetas({}));
record("list.includeDeleted", await repo.listTaskMetas({ ...all, includeDeleted: true }));
record("list.pinnedTrue", await repo.listTaskMetas({ ...all, pinned: true }));
record("list.pinnedFalse", await repo.listTaskMetas({ ...all, pinned: false }));
record("list.archivedTrue", await repo.listTaskMetas({ ...all, archived: true }));
record("list.archivedFalse", await repo.listTaskMetas({ ...all, archived: false }));
// Two tri-states at once, which is where a shared placeholder would show up.
record("list.pinnedAndUnarchived", await repo.listTaskMetas({ ...all, pinned: true, archived: false }));
// A path **and** an identity: the scope is derived from the path's presence, so a call with
// only an identity is a full query rather than a workspace query.
record("list.otherScope", await repo.listTaskMetas({ workspacePath: "/other", workspaceIdentity: "other-id" }));

// ---- listDeletedTaskIds ----
record("deleted.ws", await repo.listDeletedTaskIds({ workspacePath: "/ws" }));
record("deleted.other", await repo.listDeletedTaskIds({ workspaceIdentity: "other-id" }));
record("deleted.provider", await repo.listDeletedTaskIds({ workspacePath: "/ws", provider: "glm" as never }));

// ---- listSessionsByAutomation ----
record("byAutomation.found", await repo.listSessionsByAutomation("auto-1"));
record("byAutomation.missing", await repo.listSessionsByAutomation("no-such-automation"));

// ---- hasGroupedWorkspaceBootstrapRun ----
record("bootstrapRun.before", await repo.hasGroupedWorkspaceBootstrapRun());

// ---- queryTaskList: the closed `kind` set ----
const scope = { workspaceScopes: [{ workspacePath: "/ws" }] };
record("listView.default", await repo.queryTaskList(scope));
record("listView.pinned", await repo.queryTaskList({ ...scope, kind: "pinned" }));
record("listView.archived", await repo.queryTaskList({ ...scope, kind: "archived" }));
record("listView.all", await repo.queryTaskList({ ...scope, kind: "all" }));
record("listView.emptyScope", await repo.queryTaskList({ workspaceScopes: [] }));
record("listView.searchTitle", await repo.queryTaskList({ ...scope, search: "zebra" }));
record("listView.searchBody", await repo.queryTaskList({ ...scope, search: "brown" }));
record("listView.searchWhitespace", await repo.queryTaskList({ ...scope, search: "   " }));
record("listView.searchMixedCase", await repo.queryTaskList({ ...scope, search: "ZEBRA" }));
record("listView.searchNoHit", await repo.queryTaskList({ ...scope, search: "absent-word" }));
record("listView.limit", await repo.queryTaskList({ ...scope, limit: 2 }));
record("listView.limitZero", await repo.queryTaskList({ ...scope, limit: 0 }));
record("listView.sortCreated", await repo.queryTaskList({ ...scope, sortBy: "created" }));
record("listView.searchAndLimit", await repo.queryTaskList({ ...scope, search: "task", limit: 1 }));
// Two scopes, so the `IN (?, ?)` placeholder count is exercised.
const twoScopes = {
  workspaceScopes: [{ workspacePath: "/ws" }, { workspaceIdentity: "other-id" }],
};
record("listView.twoScopes", await repo.queryTaskList(twoScopes));
record("listView.twoScopesPinned", await repo.queryTaskList({ ...twoScopes, kind: "pinned" }));
// A search on a multi-scope query, so the two LIKE placeholders land after the scope placeholders.
record("listView.twoScopesSearch", await repo.queryTaskList({ ...twoScopes, search: "task" }));
record("listView.withPurpose", await repo.queryTaskList({
  ...scope,
  workspaceScopes: [{ workspacePath: "/ws", workspacePurpose: "project" }],
}) as never);

// ---- archiveStaleTasks ----
// Only `completed`, `unread_at IS NULL` tasks qualify, so nothing does yet.
record("archive.noneQualify", await repo.archiveStaleTasks({ workspacePath: "/ws", olderThanDays: 30 }));
// Clear the unread marks, then a zero-day span floors to 1 day and still finds nothing.
await repo.updateTaskState({ workspacePath: "/ws", taskId: "plain", patch: { unreadAt: undefined } });
record("archive.afterClearStillNone", await repo.archiveStaleTasks({ workspacePath: "/ws", olderThanDays: 0 }));
// A negative span floors to 1 day rather than archiving everything.
record("archive.negativeFloored", await repo.archiveStaleTasks({ workspacePath: "/ws", olderThanDays: -5 }));
// A 0-day cutoff is in the future, so the completed task with no unread mark qualifies.
record("archive.cutoffInFuture", await repo.archiveStaleTasks({ workspacePath: "/ws", olderThanDays: 0, provider: undefined }));
record("listAfterArchive", await repo.listTaskMetas(all));
record("listAfterArchive.pinned", await repo.listTaskMetas({ ...all, pinned: true }));

writeFileSync(
  join(
    process.cwd(),
    "packages/rust/crates/zcode-task-index/tests/fixtures/task_read_transcript.json",
  ),
  `${JSON.stringify(transcript, null, 2)}\n`,
  "utf-8",
);
rmSync(workspace, { recursive: true, force: true });
console.log(`captured ${transcript.length} entries`);
