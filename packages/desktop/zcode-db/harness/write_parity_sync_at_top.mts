// TS-vs-Rust golden WRITE-parity harness for syncTaskMetaAtGroupedTop (slice 47).
// Runs an IDENTICAL sequence through the real TS repo (A) and the Rust addon (B), capturing both the
// returned {meta, initializedGroupedOrder} and the resulting `tasks` + `task_group_view_node_orders`
// rows. The first publish of a root task must initialize its grouped top order (idempotent after).
// Run from repo root:
//   node_modules/.bin/tsx packages/desktop/zcode-db/harness/write_parity_sync_at_top.mts
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

const dir = mkdtempSync(join(tmpdir(), "zcode-attop-"));
const A = join(dir, "ts.sqlite");
const B = join(dir, "rs.sqlite");
const WS = "/parity/ws";
const NOW = 5000;

const canonicalize = (v: unknown): unknown =>
  Array.isArray(v) ? v.map(canonicalize)
    : v && typeof v === "object"
      ? Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, canonicalize((v as Record<string, unknown>)[k])]))
      : v;

const meta1 = { taskId: "root_1", traceId: "tr1", title: "Root", workspacePath: WS, createdAt: 1000, updatedAt: 2000, mode: "build", provider: "glm", status: "running" };
const meta2 = { ...meta1, title: "Root Renamed", updatedAt: 2500 };

function dumpTasks(path: string): unknown {
  const db = new DatabaseSync(path, { readOnly: true });
  const r = db.prepare("SELECT * FROM tasks WHERE task_id='root_1'").get() as Record<string, unknown> | undefined;
  db.close();
  if (!r) return null;
  r.meta_json = r.meta_json == null ? null : canonicalize(JSON.parse(String(r.meta_json)));
  return canonicalize(r);
}
function dumpOrders(path: string): unknown {
  const db = new DatabaseSync(path, { readOnly: true });
  const rows = db.prepare("SELECT node_type, node_key, sort_order FROM task_group_view_node_orders ORDER BY node_type, node_key").all() as unknown[];
  db.close();
  return canonicalize(rows);
}

let diffs = 0;
function cmp(name: string, a: unknown, b: unknown): void {
  if (JSON.stringify(a) === JSON.stringify(b)) console.log(`  ${name}: OK`);
  else { diffs++; console.log(`  ${name}: DIFF`); console.log(`    ts: ${JSON.stringify(a)}`); console.log(`    rs: ${JSON.stringify(b)}`); }
}

try {
  { const t = new TaskIndexRepo(A); await t.ensureReady(); t.close(); }
  addon.bootstrapTasksIndex(B, 25);

  // TS side
  const tsRet: unknown[] = [];
  const rsRet: unknown[] = [];
  const ti = new TaskIndexRepo(A); await ti.ensureReady();
  tsRet.push(await ti.syncTaskMetaAtGroupedTop({ meta: meta1 as never }));
  tsRet.push(await ti.syncTaskMetaAtGroupedTop({ meta: meta2 as never })); // already ordered → false
  ti.close();

  // Rust side
  rsRet.push(JSON.parse(addon.syncTaskMetaAtGroupedTopJson(B, WS, JSON.stringify(meta1), JSON.stringify({}), null, NOW)));
  rsRet.push(JSON.parse(addon.syncTaskMetaAtGroupedTopJson(B, WS, JSON.stringify(meta2), JSON.stringify({ titleOverridden: false }), null, NOW)));

  cmp("atTop.return#1", tsRet[0], rsRet[0]);
  cmp("atTop.return#2", tsRet[1], rsRet[1]);
  cmp("atTop.tasks", dumpTasks(A), dumpTasks(B));
  cmp("atTop.node_orders", dumpOrders(A), dumpOrders(B));
} catch (e) {
  console.log(`ERROR ${(e as Error).message}`);
  diffs++;
} finally {
  rmSync(dir, { recursive: true, force: true });
}
if (diffs === 0) console.log("SYNC-AT-GROUPED-TOP PARITY: OK");
else console.log(`SYNC-AT-GROUPED-TOP PARITY: ${diffs} DIFF(S)`);
process.exit(diffs === 0 ? 0 : 1);
