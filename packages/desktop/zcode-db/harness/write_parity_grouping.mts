// TS-vs-Rust golden WRITE-parity harness for TaskGroup CRUD + mixed-list ordering primitives.
// Seeds IDENTICAL `task_groups` / `task_group_view_node_orders` rows into two bootstrapped DBs,
// applies the same op through the real TS repo (DB A) and the Rust addon (DB B), then deep-diffs.
//   - `created_at` / `updated_at` are normalized (TS stamps Date.now() internally; wrappers inject a
//     clock) — clock artifacts only.
//   - `createTaskGroup` mints a random `task-group-<uuid>` id in BOTH paths; the id and any node_key
//     that embeds it are replaced with a stable placeholder before compare, so the shared logic
//     (title default, color default, the auto-inserted top order row) is what actually gets checked.
// Run from repo root:
//   node_modules/.bin/tsx packages/desktop/zcode-db/harness/write_parity_grouping.mts
import { createRequire } from "node:module";
import { rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const addon = require(join(here, "..", "zcode_db.node"));
const { DatabaseSync } = require("node:sqlite");
const { TaskIndexRepo } = await import("../../../services/src/session/taskIndexRepo.js");

const dir = mkdtempSync(join(tmpdir(), "zcode-group-"));
const A = join(dir, "ts.sqlite");
const B = join(dir, "rs.sqlite");
const NOW = 1_700_000_000_000;

const canonicalize = (v: unknown): unknown =>
  Array.isArray(v)
    ? v.map(canonicalize)
    : v && typeof v === "object"
      ? Object.fromEntries(
          Object.keys(v as object)
            .sort()
            .map((k) => [k, canonicalize((v as Record<string, unknown>)[k])]),
        )
      : v;

// Both paths mint `task-group-<uuid>` ids independently; collapse the random part so the shared
// logic (prefix, title/color defaults, auto top-order base) is what gets compared.
const normalizeId = (s: unknown): unknown =>
  typeof s === "string" ? s.replace(/task-group-[0-9a-f-]{36}/, "task-group-<ID>") : s;

function exec(path: string, sql: string, ...args: unknown[]): void {
  const db = new DatabaseSync(path);
  db.prepare(sql).run(...(args as never[]));
  db.close();
}

function seedGroup(path: string, id: string, title: string, color: string): void {
  exec(path, `INSERT INTO task_groups (group_id, title, color, created_at, updated_at) VALUES (?,?,?,1000,1000)`, id, title, color);
}

const dumpGroup = (path: string, id: string) => {
  const db = new DatabaseSync(path, { readOnly: true });
  const row = db.prepare("SELECT * FROM task_groups WHERE group_id = ?").get(id) as Record<string, unknown>;
  db.close();
  if (!row) return null;
  delete row.created_at;
  delete row.updated_at;
  return canonicalize(
    Object.fromEntries(
      Object.entries(row).map(([k, v]) => [k, k === "group_id" || k === "node_key" ? normalizeId(v) : v]),
    ),
  );
};

const dumpOrder = (path: string, nodeType: string, nodeKey: string) => {
  const db = new DatabaseSync(path, { readOnly: true });
  const row = db
    .prepare("SELECT * FROM task_group_view_node_orders WHERE node_type = ? AND node_key = ?")
    .get(nodeType, nodeKey) as Record<string, unknown>;
  db.close();
  if (!row) return null;
  delete row.created_at;
  delete row.updated_at;
  return canonicalize(
    Object.fromEntries(
      Object.entries(row).map(([k, v]) => [k, k === "group_id" || k === "node_key" ? normalizeId(v) : v]),
    ),
  );
};

let diffs = 0;
function compare(name: string, a: unknown, b: unknown): void {
  if (JSON.stringify(a) === JSON.stringify(b)) console.log(`  ${name}: OK`);
  else {
    diffs++;
    console.log(`  ${name}: DIFF`);
    console.log(`    ts: ${JSON.stringify(a)}`);
    console.log(`    rs: ${JSON.stringify(b)}`);
  }
}

async function withTs<T>(fn: (r: InstanceType<typeof TaskIndexRepo>) => Promise<T>): Promise<T> {
  const repo = new TaskIndexRepo(A);
  await repo.ensureReady();
  try {
    return await fn(repo);
  } finally {
    repo.close();
  }
}

try {
  {
    const boot = new TaskIndexRepo(A);
    await boot.ensureReady();
    boot.close();
  }
  addon.bootstrapTasksIndex(B, 25);

  // 1) createTaskGroup default title/color → verify the group row + its auto top-order row.
  const tsGroup = await withTs((ts) => ts.createTaskGroup());
  const rsGroup = JSON.parse(addon.groupingCreateTaskGroupJson(B, null, null, NOW)) as { id: string };
  compare(
    "createTaskGroup(default)",
    dumpGroup(A, tsGroup.id),
    dumpGroup(B, rsGroup.id),
  );
  compare(
    "createTaskGroup(default order-row)",
    dumpOrder(A, "group", tsGroup.id),
    dumpOrder(B, "group", rsGroup.id),
  );

  // 2) createTaskGroup explicit title + color.
  const tsG2 = await withTs((ts) => ts.createTaskGroup({ title: "My Group", color: "blue" }));
  const rsG2 = JSON.parse(addon.groupingCreateTaskGroupJson(B, "My Group", "blue", NOW)) as { id: string };
  compare("createTaskGroup(explicit)", dumpGroup(A, tsG2.id), dumpGroup(B, rsG2.id));

  // 3) renameTaskGroup: trim + blank→"New Group".
  seedGroup(A, "g1", "old", "gray");
  seedGroup(B, "g1", "old", "gray");
  await withTs((ts) => ts.renameTaskGroup({ groupId: "g1", title: "  Spaced  " }));
  addon.groupingRenameTaskGroupJson(B, "g1", "  Spaced  ", NOW);
  compare("renameTaskGroup(trim)", dumpGroup(A, "g1"), dumpGroup(B, "g1"));

  seedGroup(A, "g2", "keep", "gray");
  seedGroup(B, "g2", "keep", "gray");
  await withTs((ts) => ts.renameTaskGroup({ groupId: "g2", title: "   " }));
  addon.groupingRenameTaskGroupJson(B, "g2", "   ", NOW);
  compare("renameTaskGroup(blank->default)", dumpGroup(A, "g2"), dumpGroup(B, "g2"));

  // 4) updateTaskGroupColor valid + invalid (invalid must throw on both sides → neither changes).
  seedGroup(A, "g3", "t", "gray");
  seedGroup(B, "g3", "t", "gray");
  await withTs((ts) => ts.updateTaskGroupColor({ groupId: "g3", color: "green" }));
  addon.groupingUpdateTaskGroupColorJson(B, "g3", "green", NOW);
  compare("updateTaskGroupColor(green)", dumpGroup(A, "g3"), dumpGroup(B, "g3"));

  let tsColorThrew = false;
  try {
    await withTs((ts) => ts.updateTaskGroupColor({ groupId: "g3", color: "chartreuse" as never }));
  } catch {
    tsColorThrew = true;
  }
  let rsColorThrew = false;
  try {
    addon.groupingUpdateTaskGroupColorJson(B, "g3", "chartreuse", NOW);
  } catch {
    rsColorThrew = true;
  }
  if (tsColorThrew !== rsColorThrew) {
    diffs++;
    console.log(`  updateTaskGroupColor(invalid-guard): DIFF (ts=${tsColorThrew} rs=${rsColorThrew})`);
  } else {
    console.log("  updateTaskGroupColor(invalid-guard): OK (both rejected)");
  }

  // 5) deleteTaskGroup: removes the group row + its 'group' node order row.
  seedGroup(A, "g4", "t", "gray");
  seedGroup(B, "g4", "t", "gray");
  exec(A, `INSERT INTO task_group_view_node_orders (node_type, node_key, sort_order, created_at, updated_at) VALUES ('group','g4',10,1000,1000)`);
  exec(B, `INSERT INTO task_group_view_node_orders (node_type, node_key, sort_order, created_at, updated_at) VALUES ('group','g4',10,1000,1000)`);
  await withTs((ts) => ts.deleteTaskGroup({ groupId: "g4" }));
  addon.groupingDeleteTaskGroupJson(B, "g4");
  compare("deleteTaskGroup(group)", dumpGroup(A, "g4"), dumpGroup(B, "g4"));
  compare("deleteTaskGroup(order)", dumpOrder(A, "group", "g4"), dumpOrder(B, "group", "g4"));
} catch (e) {
  console.log(`ERROR ${(e as Error).message}`);
  diffs++;
} finally {
  rmSync(dir, { recursive: true, force: true });
}
if (diffs === 0) console.log("GROUPING WRITE PARITY: OK — all ops identical");
else console.log(`GROUPING WRITE PARITY: ${diffs} DIFF(S)`);
process.exit(diffs === 0 ? 0 : 1);
