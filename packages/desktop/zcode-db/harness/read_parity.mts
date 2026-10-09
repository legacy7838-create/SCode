// TS-vs-Rust golden read-parity harness for the tasks-index DB.
// Runs the REAL TypeScript repos and the Rust N-API addon against the SAME copy of a live
// tasks-index.sqlite and deep-diffs their projections — the differential gate that validates the
// read ports (rowToMeta/listTaskMetas/queryTaskList, automation list, off-peak list) against the
// authoritative TS implementation, not just hand-written unit tests. Read-only w.r.t. the real file
// (operates on a throwaway copy).
//
// Run from the repo root:  node_modules/.bin/tsx packages/desktop/zcode-db/harness/read_parity.mts
// Optional env: ZCODE_DB_SRC=/abs/path/to/tasks-index.sqlite
import { createRequire } from "node:module";
import { cpSync, rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const addon = require(join(here, "..", "zcode_db.node"));
const { TaskIndexRepo } = await import("../../../services/src/session/taskIndexRepo.js");
const { AutomationRepo } = await import("../../../services/src/session/automationRepo.js");
const { OffPeakTaskRepo } = await import("../../../services/src/session/offPeakTaskRepo.js");

const src = process.env.ZCODE_DB_SRC ?? join(process.env.HOME ?? "", ".zcode/v2/tasks-index.sqlite");
const dir = mkdtempSync(join(tmpdir(), "zcode-golden-"));
const copy = join(dir, "tasks-index.sqlite");
cpSync(src, copy);

const short = (v: unknown) => JSON.stringify(v)?.slice(0, 120);
let totalDiffs = 0;

function diff(a: unknown, b: unknown, path: string, out: string[]): void {
  if (a === b) return;
  if (a === null || b === null || a === undefined || b === undefined) {
    if (a !== b) out.push(`${path}: ts=${short(a)} rust=${short(b)}`);
    return;
  }
  if (typeof a !== typeof b) { out.push(`${path}: type ts=${typeof a} rust=${typeof b}`); return; }
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) out.push(`${path}: length ts=${a.length} rust=${b.length}`);
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

function section(name: string, ts: unknown[], rust: unknown[], idKey: string): void {
  const t = JSON.parse(JSON.stringify(ts)).sort((x, y) => String(x[idKey]).localeCompare(String(y[idKey])));
  const r = JSON.parse(JSON.stringify(rust)).sort((x, y) => String(x[idKey]).localeCompare(String(y[idKey])));
  const out: string[] = [];
  diff(t, r, name, out);
  totalDiffs += out.length;
  if (out.length === 0) console.log(`[${name}] OK  (${t.length} rows)`);
  else { console.log(`[${name}] ${out.length} diff(s):`); console.log(out.slice(0, 10).join("\n")); }
}

const repos = [];
try {
  const ti = new TaskIndexRepo(copy); await ti.ensureReady(); repos.push(ti);
  section("task-metas", await ti.listTaskMetas({ includeDeleted: true }),
    JSON.parse(addon.listTaskMetasFilteredJson(copy, JSON.stringify({ includeDeleted: true }))), "taskId");

  const metas = await ti.listTaskMetas({ includeDeleted: false });
  const scopes = [...new Map(metas.map((m) => [m.workspacePath, { workspacePath: m.workspacePath, workspaceIdentity: m.workspaceIdentity }])).values()];
  const tsList = await ti.queryTaskList({ workspaceScopes: scopes });
  const rsList = JSON.parse(addon.queryTaskListJson(copy, JSON.stringify({ workspaceScopes: scopes })));
  section("query-task-list", tsList.items, rsList.items, "taskId");
} catch (e) { console.log(`[task-index] ERROR ${(e as Error).message}`); totalDiffs++; }

try {
  const ar = new AutomationRepo(copy); await ar.ensureReady(); repos.push(ar);
  section("automations", await ar.list(), JSON.parse(addon.listAutomationsJson(copy, null)), "automationId");
} catch (e) { console.log(`[automations] ERROR ${(e as Error).message}`); totalDiffs++; }

try {
  const or = new OffPeakTaskRepo(copy); await or.ensureReady(); repos.push(or);
  section("offpeak", await or.list(), JSON.parse(addon.listOffPeakJson(copy, null)), "offPeakTaskId");
} catch (e) { console.log(`[offpeak] ERROR ${(e as Error).message}`); totalDiffs++; }

for (const r of repos) { try { r.close(); } catch { /* ignore */ } }
rmSync(dir, { recursive: true, force: true });

if (totalDiffs === 0) { console.log("\nGOLDEN READ PARITY: OK (all sections match the TS repos)"); process.exit(0); }
console.log(`\nGOLDEN READ PARITY: FAILED (${totalDiffs} diff(s)/error(s))`); process.exit(1);
