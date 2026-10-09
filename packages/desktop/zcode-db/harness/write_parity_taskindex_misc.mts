// TS-vs-Rust golden WRITE/READ-parity harness for the remaining TaskIndexRepo surfaces:
// hasGroupedWorkspaceBootstrapRun, listDeletedTaskIds, listSessionsByAutomation, archiveStaleTasks.
// Both DBs get IDENTICAL seeded `tasks` / `task_group_workspace_bootstraps` rows; the same op runs
// through the real TS repo (A) and the Rust addon (B); results deep-diffed with the read harness's
// null/undefined-tolerant comparison. `archiveStaleTasks` also verifies the flipped `archived` flag.
// Run from repo root:
//   node_modules/.bin/tsx packages/desktop/zcode-db/harness/write_parity_taskindex_misc.mts
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

const dir = mkdtempSync(join(tmpdir(), "zcode-timisc-"));
const A = join(dir, "ts.sqlite");
const B = join(dir, "rs.sqlite");
const WS = "/parity/ws";

const short = (v: unknown) => JSON.stringify(v)?.slice(0, 160);
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

let diffs = 0;
function cmp(name: string, tsRaw: unknown, rustRaw: unknown): void {
  // JSON round-trip drops `undefined`-valued keys (how JS represents an absent meta field), so the
  // TS object and the Rust JSON (serde `skip_serializing_if` omits the same fields) become comparable.
  const ts = JSON.parse(JSON.stringify(tsRaw ?? null));
  const rust = typeof rustRaw === "string" ? JSON.parse(rustRaw) : JSON.parse(JSON.stringify(rustRaw ?? null));
  const out: string[] = [];
  diff(ts, rust, name, out);
  if (out.length === 0) console.log(`  ${name}: OK`);
  else { diffs++; console.log(`  ${name}: ${out.length} DIFF(s)`); console.log(out.slice(0, 8).join("\n")); }
}

interface TSeed {
  taskId: string;
  status?: string | null;
  provider?: string | null;
  updatedAt: number;
  createdAt?: number;
  unreadAt?: number | null;
  pinned?: number;
  archived?: number;
  deleted?: number;
  cronId?: string | null;
  title?: string;
  model?: string | null;
  mode?: string;
}

function seedTask(path: string, t: TSeed): void {
  const db = new DatabaseSync(path);
  db.prepare(
    `INSERT INTO tasks (workspace_key, workspace_path, task_id, title, task_status, provider, mode,
      model, created_at, updated_at, unread_at, pinned, archived, deleted, cron_automation_id, meta_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    WS, WS, t.taskId, t.title ?? `title:${t.taskId}`, t.status ?? null, t.provider ?? null,
    t.mode ?? "build", t.model ?? null, t.createdAt ?? 100, t.updatedAt,
    t.unreadAt ?? null, t.pinned ?? 0, t.archived ?? 0, t.deleted ?? 0, t.cronId ?? null,
    JSON.stringify({ model: t.model ?? null, status: t.status ?? null }),
  );
  db.close();
}

const archivedFlag = (path: string, id: string): number | undefined => {
  const db = new DatabaseSync(path, { readOnly: true });
  const r = db.prepare("SELECT archived FROM tasks WHERE workspace_key = ? AND task_id = ?").get(WS, id) as { archived: number } | undefined;
  db.close();
  return r?.archived;
};

async function withTs<T>(fn: (r: InstanceType<typeof TaskIndexRepo>) => Promise<T>): Promise<T> {
  const repo = new TaskIndexRepo(A);
  await repo.ensureReady();
  try { return await fn(repo); } finally { repo.close(); }
}

try {
  { const b = new TaskIndexRepo(A); await b.ensureReady(); b.close(); }
  addon.bootstrapTasksIndex(B, 25);

  // 1) hasGroupedWorkspaceBootstrapRun: empty -> false; one bootstrap row -> true.
  cmp("hasBootstrapRun(empty)", await withTs((r) => r.hasGroupedWorkspaceBootstrapRun()), addon.hasGroupedWorkspaceBootstrapRunJson(B));
  for (const p of [A, B]) { const db = new DatabaseSync(p); db.prepare("INSERT INTO task_group_workspace_bootstraps (workspace_key, group_id, created_at, updated_at) VALUES (?, ?, 1000, 1000)").run(WS, "g-bootstrap"); db.close(); }
  cmp("hasBootstrapRun(after-insert)", await withTs((r) => r.hasGroupedWorkspaceBootstrapRun()), addon.hasGroupedWorkspaceBootstrapRunJson(B));

  // 2) listDeletedTaskIds: provider-scoped + unscoped.
  for (const p of [A, B]) {
    seedTask(p, { taskId: "d1", deleted: 1, provider: "glm", updatedAt: 5 });
    seedTask(p, { taskId: "d2", deleted: 1, provider: null, updatedAt: 5 });
    seedTask(p, { taskId: "d3", deleted: 1, provider: "gemini", updatedAt: 5 });
    seedTask(p, { taskId: "d4", deleted: 0, provider: "glm", updatedAt: 5 });
  }
  const delTsAll = await withTs((r) => r.listDeletedTaskIds({ workspacePath: WS }));
  const delRsAll = JSON.parse(addon.listDeletedTaskIdsJson(B, WS, null)) as string[];
  cmp("listDeletedTaskIds(all)", delTsAll, delRsAll);
  const delTsGlm = await withTs((r) => r.listDeletedTaskIds({ workspacePath: WS, provider: "glm" as never }));
  const delRsGlm = JSON.parse(addon.listDeletedTaskIdsJson(B, WS, "glm")) as string[];
  cmp("listDeletedTaskIds(glm)", delTsGlm, delRsGlm);

  // 3) listSessionsByAutomation: cron sessions (non-deleted), newest first.
  for (const p of [A, B]) {
    seedTask(p, { taskId: "c1", cronId: "auto1", deleted: 0, createdAt: 10, updatedAt: 10, model: "GLM-5", status: "completed" });
    seedTask(p, { taskId: "c2", cronId: "auto1", deleted: 0, createdAt: 30, updatedAt: 30, model: "GLM-4.7", status: "failed" });
    seedTask(p, { taskId: "c3", cronId: "auto1", deleted: 1, createdAt: 20, updatedAt: 20 }); // excluded
    seedTask(p, { taskId: "c4", cronId: "auto2", deleted: 0, createdAt: 20, updatedAt: 20 }); // other automation
  }
  const sessTs = await withTs((r) => r.listSessionsByAutomation("auto1"));
  const sessRs = JSON.parse(addon.listSessionsByAutomationJson(B, "auto1"));
  cmp("listSessionsByAutomation", sessTs, sessRs);

  // 4) archiveStaleTasks: cutoff excludes new/unread/pinned/non-completed; flips archived flag.
  for (const p of [A, B]) {
    seedTask(p, { taskId: "s_arch", status: "completed", updatedAt: 100, model: "GLM-5", title: "old done" });
    seedTask(p, { taskId: "s_new", status: "completed", updatedAt: 999_999_999_999_999 });
    seedTask(p, { taskId: "s_unread", status: "completed", updatedAt: 100, unreadAt: 50 });
    seedTask(p, { taskId: "s_pinned", status: "completed", updatedAt: 100, pinned: 1 });
    seedTask(p, { taskId: "s_failed", status: "failed", updatedAt: 100 });
    seedTask(p, { taskId: "s_gm", status: "completed", updatedAt: 100, provider: "gemini" });
  }
  const archTs = await withTs((r) => r.archiveStaleTasks({ workspacePath: WS, olderThanDays: 1, provider: undefined }));
  // cutoff for the Rust side must equal the TS Date.now() cutoff; recompute with the same formula.
  const cutoff = Date.now() - 1 * 24 * 60 * 60 * 1000;
  const archRs = JSON.parse(addon.archiveStaleTasksJson(B, WS, cutoff, null));
  // The cutoff clock can straddle between the two calls (both ~1e12 ms); the seeded boundary rows
  // (100 vs 1e6) are far on both sides of any plausible cutoff, so ordering/content is stable.
  cmp("archiveStaleTasks(returned)", archTs, archRs);
  for (const id of ["s_arch", "s_new", "s_unread", "s_pinned", "s_failed", "s_gm"])
    cmp(`archiveStaleTasks(flag:${id})`, archivedFlag(A, id), archivedFlag(B, id));
} catch (e) {
  console.log(`ERROR ${(e as Error).message}`);
  diffs++;
} finally {
  rmSync(dir, { recursive: true, force: true });
}
if (diffs === 0) console.log("TASKINDEX MISC PARITY: OK");
else console.log(`TASKINDEX MISC PARITY: ${diffs} DIFF(S)`);
process.exit(diffs === 0 ? 0 : 1);
