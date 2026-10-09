// TS-vs-Rust golden differential for queryGroupedTaskView — the side-effecting grouped-list read
// (runs the one-shot workspace-group bootstrap + the two lazy order normalizations, then assembles
// the nested node list). Seeds IDENTICAL state into two bootstrapped DBs, runs the same query through
// the real TS repo (A) and the Rust addon (B), and compares BOTH the returned `nodes` AND the mutated
// grouping tables.
//   - The bootstrap/normalize writes stamp `Date.now()` inside the TS but an injected `now` in the
//     addon, so `created_at`/`updated_at`/`added_at` on task_groups / *_members / *_node_orders are
//     stripped before compare (clock artifacts). All DETERMINISTIC columns (sort_order, group ids,
//     titles, colors, membership) plus the returned node metas + sortOrders must match.
// Two scenarios: (S1) fresh DB → bootstrap fires and builds the workspace group;
// (S2) pre-bootstrapped marker + user group w/ a null-sort member + ungrouped tasks → exercises both
// normalizations + visibility + assembly without the bootstrap churn.
// Run from repo root:
//   node_modules/.bin/tsx packages/desktop/zcode-db/harness/write_parity_grouped_view.mts
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

const dir = mkdtempSync(join(tmpdir(), "zcode-gview-"));
const A = join(dir, "ts.sqlite");
const B = join(dir, "rs.sqlite");
const WS = "/parity/ws";
const NOW = 1_700_000_000_000;

const canonicalize = (v: unknown): unknown =>
  Array.isArray(v) ? v.map(canonicalize)
    : v && typeof v === "object"
      ? Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, canonicalize((v as Record<string, unknown>)[k])]))
      : v;

function seedTask(path: string, id: string, o: { updatedAt: number; createdAt?: number; pinned?: number; archived?: number; deleted?: number; title?: string }): void {
  const db = new DatabaseSync(path);
  const meta = { taskId: id, traceId: `tr-${id}`, title: o.title ?? `t-${id}`, workspacePath: WS, createdAt: o.createdAt ?? 1000, updatedAt: o.updatedAt, mode: "build", provider: "glm" };
  db.prepare(
    `INSERT INTO tasks (workspace_key, workspace_path, task_id, title, task_status, provider, mode, created_at, updated_at, pinned, archived, deleted, meta_json)
     VALUES (?, ?, ?, ?, 'completed', 'glm', 'build', ?, ?, ?, ?, ?, ?)`,
  ).run(WS, WS, id, o.title ?? `t-${id}`, o.createdAt ?? 1000, o.updatedAt, o.pinned ?? 0, o.archived ?? 0, o.deleted ?? 0, JSON.stringify(meta));
  db.close();
}
function exec(path: string, sql: string, ...a: unknown[]): void { const db = new DatabaseSync(path); db.prepare(sql).run(...(a as never[])); db.close(); }

// Deterministic grouping tables (clock columns stripped).
function dumpGrouping(path: string): unknown {
  const db = new DatabaseSync(path, { readOnly: true });
  const groups = (db.prepare("SELECT group_id, title, color FROM task_groups ORDER BY group_id").all() as unknown[]).map(canonicalize);
  const members = (db.prepare("SELECT group_id, workspace_key, task_id, sort_order FROM task_group_members ORDER BY group_id, workspace_key, task_id").all() as unknown[]).map(canonicalize);
  const orders = (db.prepare("SELECT node_type, node_key, sort_order FROM task_group_view_node_orders ORDER BY node_type, node_key").all() as unknown[]).map(canonicalize);
  db.close();
  return { groups, members, orders };
}

let diffs = 0;
function cmp(name: string, a: unknown, b: unknown): void {
  const sa = JSON.stringify(a), sb = JSON.stringify(b);
  if (sa === sb) console.log(`  ${name}: OK`);
  else { diffs++; console.log(`  ${name}: DIFF`); console.log(`    ts: ${sa?.slice(0, 400)}`); console.log(`    rs: ${sb?.slice(0, 400)}`); }
}

const tsQuery = async (dbPath: string, params: unknown) => {
  const r = new TaskIndexRepo(dbPath); await r.ensureReady();
  try { return await r.queryGroupedTaskView(params as never); } finally { r.close(); }
};

// The workspace group is CREATED during the bootstrap query, so its group.createdAt/updatedAt are
// clock stamps (TS Date.now() vs injected now) — a write artifact, not an assembly difference.
// Strip them from the returned group nodes (task metas keep their seeded deterministic timestamps).
function stripGroupClock(view: unknown): unknown {
  const nodes = (view as { nodes?: unknown[] })?.nodes;
  if (Array.isArray(nodes)) {
    for (const n of nodes as Array<Record<string, unknown>>) {
      const g = n.group as Record<string, unknown> | undefined;
      if (g) { delete g.createdAt; delete g.updatedAt; }
    }
  }
  return view;
}

try {
  // ===== Scenario 1: fresh → bootstrap fires =====
  for (const p of [A, B]) { const x = new TaskIndexRepo(p); await x.ensureReady(); x.close(); }
  addon.bootstrapTasksIndex(B, 25);
  // 3 active (newest last), 1 archived, 1 pinned, 1 deleted → only the 3 active are grouped.
  for (const p of [A, B]) {
    seedTask(p, "a1", { updatedAt: 100, createdAt: 90 });
    seedTask(p, "a2", { updatedAt: 300, createdAt: 200 });
    seedTask(p, "a3", { updatedAt: 200, createdAt: 150 });
    seedTask(p, "arch", { updatedAt: 500, archived: 1 });
    seedTask(p, "pin", { updatedAt: 600, pinned: 1 });
    seedTask(p, "del", { updatedAt: 700, deleted: 1 });
  }
  const scopes = [{ workspacePath: WS }];
  const s1ts = await tsQuery(A, { workspaceScopes: scopes });
  const s1rs = JSON.parse(addon.groupingQueryViewJson(B, JSON.stringify(scopes), false, null, NOW));
  cmp("S1.nodes", canonicalize(stripGroupClock(s1ts)), canonicalize(stripGroupClock(s1rs)));
  cmp("S1.grouping", dumpGrouping(A), dumpGrouping(B));

  // ===== Scenario 2: fresh pair again but pre-seed a user group + null-sort member + ungrouped =====
  const A2 = join(dir, "ts2.sqlite"); const B2 = join(dir, "rs2.sqlite");
  { const x = new TaskIndexRepo(A2); await x.ensureReady(); x.close(); }
  addon.bootstrapTasksIndex(B2, 25);
  for (const p of [A2, B2]) {
    seedTask(p, "g1a", { updatedAt: 100, createdAt: 100 });
    seedTask(p, "g1b", { updatedAt: 200, createdAt: 200 });
    seedTask(p, "free1", { updatedAt: 300, createdAt: 300 });
    // mark bootstrap already-run so scenario 2 tests assembly + normalize without bootstrap churn.
    exec(p, `INSERT INTO task_group_workspace_bootstraps (workspace_key, group_id, created_at, updated_at) VALUES (?, NULL, 1000, 1000)`, WS);
    exec(p, `INSERT INTO task_groups (group_id, title, color, created_at, updated_at) VALUES ('ug1','My Group','blue',1000,1000)`);
    // g1a ordered, g1b NOT ordered (null sort_order) → normalize member assigns it.
    exec(p, `INSERT INTO task_group_members (group_id, workspace_key, workspace_path, task_id, sort_order, added_at, created_at, updated_at) VALUES ('ug1',?,?, 'g1a', 1000, 1000, 1000, 1000)`, WS, WS);
    exec(p, `INSERT INTO task_group_members (group_id, workspace_key, workspace_path, task_id, sort_order, added_at, created_at, updated_at) VALUES ('ug1',?,?, 'g1b', NULL, 1100, 1000, 1000)`, WS, WS);
    // ug1 group has a top order; free1 (ungrouped) does NOT → normalize top appends it.
    exec(p, `INSERT INTO task_group_view_node_orders (node_type, node_key, sort_order, created_at, updated_at) VALUES ('group','ug1', 5000, 1000, 1000)`);
  }
  const s2ts = await tsQuery(A2, { workspaceScopes: scopes });
  const s2rs = JSON.parse(addon.groupingQueryViewJson(B2, JSON.stringify(scopes), false, null, NOW));
  cmp("S2.nodes", canonicalize(stripGroupClock(s2ts)), canonicalize(stripGroupClock(s2rs)));
  cmp("S2.grouping", dumpGrouping(A2), dumpGrouping(B2));
} catch (e) {
  console.log(`ERROR ${(e as Error).message}`);
  diffs++;
} finally {
  rmSync(dir, { recursive: true, force: true });
}
if (diffs === 0) console.log("GROUPED VIEW PARITY: OK — nodes + mutated grouping identical");
else console.log(`GROUPED VIEW PARITY: ${diffs} DIFF(S)`);
process.exit(diffs === 0 ? 0 : 1);
