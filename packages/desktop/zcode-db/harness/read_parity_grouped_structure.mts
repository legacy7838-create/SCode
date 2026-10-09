// TS-vs-Rust golden READ-parity harness for queryGroupedTaskViewStructure (the pure grouped-view
// structure read: groups + members + top-level orders, no task join, no bootstrap/normalize writes).
// Seeds IDENTICAL grouping-table rows into two bootstrapped DBs, then runs the real TS repo read (A)
// vs the Rust addon (B) and deep-diffs the {groups, members, topLevelOrders} payload.
// Exercises: bootstrapped-group visibility (hidden when its workspace is out of scope), invalid-color
// fallback to gray, null member sortOrder, a JSON-encoded task node key, and a dirty node key that
// BOTH sides skip.
// Run from repo root:
//   node_modules/.bin/tsx packages/desktop/zcode-db/harness/read_parity_grouped_structure.mts
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

const dir = mkdtempSync(join(tmpdir(), "zcode-gstruct-"));
const A = join(dir, "ts.sqlite");
const B = join(dir, "rs.sqlite");

const short = (v: unknown) => JSON.stringify(v)?.slice(0, 200);
function diff(a: unknown, b: unknown, path: string, out: string[]): void {
  if (a === b) return;
  if (a === null || b === null || a === undefined || b === undefined) {
    if (a !== b) out.push(`${path}: ts=${short(a)} rust=${short(b)}`);
    return;
  }
  if (typeof a !== typeof b) { out.push(`${path}: type ts=${typeof a} rust=${typeof b}`); return; }
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) out.push(`${path}: len ts=${a.length} rust=${b.length}`);
    for (let i = 0; i < Math.min(a.length, b.length); i++) diff(a[i], b[i], `${path}[${i}]`, out);
    return;
  }
  if (typeof a === "object") {
    const ao = a as Record<string, unknown>, bo = b as Record<string, unknown>;
    for (const k of new Set([...Object.keys(ao), ...Object.keys(bo)])) {
      if (!(k in ao)) out.push(`${path}.${k}: MISSING-IN-TS rust=${short(bo[k])}`);
      else if (!(k in bo)) out.push(`${path}.${k}: MISSING-IN-RUST ts=${short(ao[k])}`);
      else diff(ao[k], bo[k], `${path}.${k}`, out);
    }
  }
}

function seed(path: string): void {
  const db = new DatabaseSync(path);
  const g = db.prepare("INSERT INTO task_groups (group_id, title, color, created_at, updated_at) VALUES (?,?,?,?,?)");
  g.run("g1", "One", "red", 1000, 1000);
  g.run("g2", "Two", "blue", 1001, 1001); // bootstrapped to /other → hidden under scope /w
  g.run("g3", "Three", "chartreuse", 1002, 1002); // invalid color → gray
  db.prepare("INSERT INTO task_group_workspace_bootstraps (workspace_key, group_id, created_at, updated_at) VALUES (?,?,?,?)").run("/other", "g2", 1003, 1003);

  const m = db.prepare(
    "INSERT INTO task_group_members (group_id, workspace_key, workspace_path, workspace_identity, task_id, sort_order, added_at, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)",
  );
  m.run("g1", "/w", "/w", null, "t1", 5, 1004, 1004, 1004);
  m.run("g3", "/w", "/w", "/w", "t2", null, 1005, 1005, 1005); // workspaceIdentity present + null sortOrder

  const o = db.prepare("INSERT INTO task_group_view_node_orders (node_type, node_key, sort_order, created_at, updated_at) VALUES (?,?,?,?,?)");
  o.run("group", "g1", 1000, 1006, 1006);
  o.run("task", JSON.stringify(["/w", "t3"]), 500, 1007, 1007);
  o.run("task", "not-json-dirty", 700, 1008, 1008); // skipped by both sides
  o.run("group", "g3", 900, 1009, 1009);
  db.close();
}

try {
  { const b = new TaskIndexRepo(A); await b.ensureReady(); b.close(); }
  addon.bootstrapTasksIndex(B, 25);
  seed(A);
  seed(B);

  const scopes = [{ workspacePath: "/w" }];
  const repo = new TaskIndexRepo(A);
  await repo.ensureReady();
  const ts = await repo.queryGroupedTaskViewStructure({ workspaceScopes: scopes });
  repo.close();
  const rust = JSON.parse(addon.groupingQueryViewStructureJson(B, JSON.stringify(scopes)));

  const out: string[] = [];
  diff(ts.groups, rust.groups, "groups", out);
  diff(ts.members, rust.members, "members", out);
  diff(ts.topLevelOrders, rust.topLevelOrders, "topLevelOrders", out);
  if (out.length === 0) {
    console.log(
      `GROUPED STRUCTURE READ PARITY: OK — groups=${ts.groups.length} members=${ts.members.length} orders=${ts.topLevelOrders.length}`,
    );
    process.exit(0);
  }
  console.log(`GROUPED STRUCTURE READ PARITY: ${out.length} DIFF(s)`);
  console.log(out.slice(0, 12).join("\n"));
  process.exit(1);
} catch (e) {
  console.log(`ERROR ${(e as Error).message}`);
  process.exit(1);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
