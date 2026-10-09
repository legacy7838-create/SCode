// TS-vs-Rust golden WRITE-parity harness for syncTaskMeta (slice 36).
// Boots two empty DBs (one via the TS TaskIndexRepo, one via the Rust addon), runs an IDENTICAL
// sequence of syncTaskMeta operations through each, then deep-diffs the resulting `tasks` rows.
// `meta_json` is canonicalized (key-sorted) before compare because serialization key order is not a
// parity contract (even two TS writes differ); every scalar column and the semantic meta_json must
// match. Exercises the monotonic-updatedAt + terminal-status + title-overridden + cron-preserve
// rules. Read-only w.r.t. any real file (uses temp DBs).
//
// Run from repo root:  node_modules/.bin/tsx packages/desktop/zcode-db/harness/write_parity.mts
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

const dir = mkdtempSync(join(tmpdir(), "zcode-write-"));
const DB_TS = join(dir, "ts.sqlite");
const DB_RS = join(dir, "rs.sqlite");
const WS = "/parity/ws";
const TASK = "sess_parity_1";

const baseMeta = (over: Record<string, unknown> = {}) => ({
  taskId: TASK, traceId: "tr-parity-1", title: "auto title", workspacePath: WS,
  createdAt: 1000, updatedAt: 2000, mode: "build", ...over,
});

// Deterministic sequence (no Date.now dependence in the `tasks` row):
const seq = [
  baseMeta({ status: "running" }),                              // insert
  baseMeta({ status: "completed", updatedAt: 3000 }),           // running -> completed
  baseMeta({ status: "running", updatedAt: 2500 }),             // STALE: must not downgrade completed / rewind updatedAt
  baseMeta({ title: "second auto", updatedAt: 3500, titleOverridden: true }), // user-override path
  baseMeta({ updatedAt: 3600, cronAutomationId: "cron-1", status: "completed" }), // cron identity appears
  baseMeta({ updatedAt: 3700 }),                                // snapshot WITHOUT cron → must preserve cron-1
];

function canonicalize(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonicalize);
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return Object.fromEntries(Object.keys(o).sort().map((k) => [k, canonicalize(o[k])]));
  }
  return v;
}

function dumpTasks(path: string): unknown[] {
  const db = new DatabaseSync(path, { readOnly: true });
  const rows = db.prepare("SELECT * FROM tasks ORDER BY task_id").all() as Record<string, unknown>[];
  db.close();
  return rows.map((r) => canonicalize({ ...r, meta_json: r.meta_json == null ? null : JSON.parse(String(r.meta_json)) }));
}

// Deterministic updateTaskState patch (in-fields lastError/target + ??-fields + unread marker).
const updPatch = {
  title: "manual rename",
  status: "running",
  unreadAt: 5,
  lastError: { message: "boom" },
  target: null,
  model: "glm-4.6",
};

let diffs = 0;
try {
  // TS side
  const ti = new TaskIndexRepo(DB_TS);
  await ti.ensureReady();
  for (const m of seq) await ti.syncTaskMeta({ meta: m as never, ...(m.titleOverridden ? { titleOverridden: true } : {}) });
  await ti.updateTaskState({ workspacePath: WS, taskId: TASK, patch: updPatch as never });
  ti.close();

  // Rust side (bootstrap an empty file, then the same sync sequence; fixed `now` for grouping)
  const kind = addon.bootstrapTasksIndex(DB_RS, 25);
  if (kind !== "initialize") { console.log(`rust bootstrap kind=${kind} (expected initialize)`); }
  for (const m of seq) addon.syncTaskMetaJson(DB_RS, WS, JSON.stringify(m), JSON.stringify({ titleOverridden: m.titleOverridden ? true : undefined }), 5000);
  addon.updateTaskStateJson(DB_RS, WS, TASK, JSON.stringify(updPatch));

  const ts = dumpTasks(DB_TS);
  const rs = dumpTasks(DB_RS);
  const out: string[] = [];
  const cmp = (a: unknown, b: unknown, p: string): void => {
    if (JSON.stringify(a) === JSON.stringify(b)) return;
    if (Array.isArray(a) && Array.isArray(b)) {
      if (a.length !== b.length) out.push(`${p}: len ts=${a.length} rs=${b.length}`);
      for (let i = 0; i < Math.min(a.length, b.length); i++) cmp(a[i], b[i], `${p}[${i}]`);
      return;
    }
    if (a && b && typeof a === "object" && typeof b === "object") {
      const ao = a as Record<string, unknown>, bo = b as Record<string, unknown>;
      for (const k of new Set([...Object.keys(ao), ...Object.keys(bo)])) {
        if (JSON.stringify(ao[k]) !== JSON.stringify(bo[k])) out.push(`${p}.${k}: ts=${JSON.stringify(ao[k])} rs=${JSON.stringify(bo[k])}`);
      }
      return;
    }
    out.push(`${p}: ts=${JSON.stringify(a)} rs=${JSON.stringify(b)}`);
  };
  cmp(ts, rs, "tasks");
  diffs = out.length;
  console.log(`tasks rows: ts=${ts.length} rs=${rs.length}`);
  if (diffs === 0) console.log("WRITE PARITY (syncTaskMeta): OK — resulting tasks rows identical");
  else { console.log(`WRITE PARITY: ${diffs} diff(s):`); console.log(out.slice(0, 15).join("\n")); }
} catch (e) {
  console.log(`ERROR ${(e as Error).message}`);
  diffs++;
} finally {
  rmSync(dir, { recursive: true, force: true });
}
process.exit(diffs === 0 ? 0 : 1);
