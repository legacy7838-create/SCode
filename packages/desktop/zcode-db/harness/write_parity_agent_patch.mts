// TS-vs-Rust golden WRITE-parity harness for applyAgentPatch + deleteArchivedTask.
// Seeds an IDENTICAL `tasks` row (with a schema-valid meta_json so row_to_meta takes the meta path,
// not the column fallback) into two bootstrapped DBs; runs the same op through the real TS repo (A)
// and the Rust addon (B); deep-diffs BOTH the returned meta and the raw persisted row, plus grouping
// references for the tombstone case.
// Run from repo root:
//   node_modules/.bin/tsx packages/desktop/zcode-db/harness/write_parity_agent_patch.mts
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

const dir = mkdtempSync(join(tmpdir(), "zcode-agent-"));
const A = join(dir, "ts.sqlite");
const B = join(dir, "rs.sqlite");
const WS = "/parity/ws";

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
let diffs = 0;
function cmp(name: string, tsRaw: unknown, rustRaw: unknown): void {
  const ts = JSON.parse(JSON.stringify(tsRaw ?? null));
  const rust = typeof rustRaw === "string" ? JSON.parse(rustRaw) : JSON.parse(JSON.stringify(rustRaw ?? null));
  const out: string[] = [];
  diff(ts, rust, name, out);
  if (out.length === 0) console.log(`  ${name}: OK`);
  else { diffs++; console.log(`  ${name}: ${out.length} DIFF(s)`); console.log(out.slice(0, 8).join("\n")); }
}

interface Seed {
  taskId: string;
  title?: string;
  status?: string | null;
  model?: string | null;
  updatedAt?: number;
  pinned?: number;
  archived?: number;
  deleted?: number;
  titleOverridden?: number;
  metaJson?: Record<string, unknown>;
}

function seedTask(path: string, t: Seed): void {
  const db = new DatabaseSync(path);
  // A schema-valid meta_json (zcodeTaskMetaSchema): status is the persist enum (omitted here), so
  // both TS safeParse and the Rust meta path take the SUCCESS branch (provider read from meta_json),
  // avoiding the known nested-zod strictness gap. Column `task_status` carries the live status.
  const meta = t.metaJson ?? {
    taskId: t.taskId, traceId: "trace", title: t.title ?? "base", workspacePath: WS,
    createdAt: 100, updatedAt: t.updatedAt ?? 200, mode: "plan", provider: "glm",
    model: t.model ?? undefined,
  };
  db.prepare(
    `INSERT INTO tasks (workspace_key, workspace_path, task_id, title, task_status, provider, mode,
      model, created_at, updated_at, pinned, archived, deleted, title_overridden, meta_json)
     VALUES (?, ?, ?, ?, ?, 'glm', 'plan', ?, 100, ?, ?, ?, ?, ?, ?)`,
  ).run(
    WS, WS, t.taskId, t.title ?? "base", t.status ?? null, t.model ?? null,
    t.updatedAt ?? 200, t.pinned ?? 0, t.archived ?? 0, t.deleted ?? 0, t.titleOverridden ?? 0,
    JSON.stringify(meta),
  );
  db.close();
}

function dumpRaw(path: string, id: string): unknown {
  const db = new DatabaseSync(path, { readOnly: true });
  const r = db.prepare(
    "SELECT title, task_status, provider, mode, model, updated_at, unread_at, pinned, archived, deleted, title_overridden FROM tasks WHERE workspace_key = ? AND task_id = ?",
  ).get(WS, id) as Record<string, unknown> | undefined;
  db.close();
  return r ?? null;
}
const hasMember = (path: string, id: string): number => {
  const db = new DatabaseSync(path, { readOnly: true });
  const c = db.prepare("SELECT COUNT(*) AS n FROM task_group_members WHERE workspace_key = ? AND task_id = ?").get(WS, id) as { n: number };
  db.close();
  return c.n;
};

async function withTs<T>(fn: (r: InstanceType<typeof TaskIndexRepo>) => Promise<T>): Promise<T> {
  const repo = new TaskIndexRepo(A);
  await repo.ensureReady();
  try { return await fn(repo); } finally { repo.close(); }
}

try {
  { const b = new TaskIndexRepo(A); await b.ensureReady(); b.close(); }
  addon.bootstrapTasksIndex(B, 25);

  // ---- applyAgentPatch ----
  // a) agent title accepted (not overridden) + status + updatedAt + a schema-valid target present.
  const goal = { sessionID: "s1", targetID: "t1", objective: "obj", summaryTitle: null, status: "active", tokenBudget: null, tokensUsed: 0, timeUsedSeconds: 0, time: { created: 100, updated: 100 } };
  seedTask(A, { taskId: "ap1", title: "base", status: "running" });
  seedTask(B, { taskId: "ap1", title: "base", status: "running" });
  const ap1Ts = await withTs((r) => r.applyAgentPatch({ workspacePath: WS, taskId: "ap1", patch: { title: "Agent Title", status: "completed", updatedAt: 555, target: goal } as never }));
  const ap1Rs = addon.applyAgentPatchJson(B, WS, "ap1", JSON.stringify({ title: "Agent Title", status: "completed", updatedAt: 555, target: goal }));
  cmp("agentPatch(a).meta", ap1Ts, ap1Rs);
  cmp("agentPatch(a).raw", dumpRaw(A, "ap1"), dumpRaw(B, "ap1"));

  // b) user-title-overridden → agent title REJECTED (title kept), other fields still applied.
  seedTask(A, { taskId: "ap2", title: "User", titleOverridden: 1 });
  seedTask(B, { taskId: "ap2", title: "User", titleOverridden: 1 });
  const ap2Ts = await withTs((r) => r.applyAgentPatch({ workspacePath: WS, taskId: "ap2", patch: { title: "Agent", updatedAt: 777 } as never }));
  const ap2Rs = addon.applyAgentPatchJson(B, WS, "ap2", JSON.stringify({ title: "Agent", updatedAt: 777 }));
  cmp("agentPatch(b).meta", ap2Ts, ap2Rs);
  cmp("agentPatch(b).raw", dumpRaw(A, "ap2"), dumpRaw(B, "ap2"));

  // c) lastError present-null clears; target absent keeps; empty title falsy keeps current title.
  const m3 = { taskId: "ap3", traceId: "t", title: "Keep", workspacePath: WS, createdAt: 100, updatedAt: 200, mode: "plan", provider: "glm", model: "GLM-5", lastError: { code: "E", message: "boom" } };
  seedTask(A, { taskId: "ap3", title: "Keep", model: "GLM-5", metaJson: m3 });
  seedTask(B, { taskId: "ap3", title: "Keep", model: "GLM-5", metaJson: JSON.parse(JSON.stringify(m3)) });
  const ap3Ts = await withTs((r) => r.applyAgentPatch({ workspacePath: WS, taskId: "ap3", patch: { title: "", lastError: null } as never }));
  const ap3Rs = addon.applyAgentPatchJson(B, WS, "ap3", JSON.stringify({ title: "", lastError: null }));
  cmp("agentPatch(c).meta", ap3Ts, ap3Rs);

  // d) missing row → null on both sides.
  const ap4Ts = await withTs((r) => r.applyAgentPatch({ workspacePath: WS, taskId: "nope", patch: { title: "X" } as never }));
  const ap4Rs = addon.applyAgentPatchJson(B, WS, "nope", JSON.stringify({ title: "X" }));
  cmp("agentPatch(missing)", ap4Ts, ap4Rs);

  // ---- deleteArchivedTask ----
  // a) archived live row with grouping refs → tombstone (deleted=1) + refs dropped.
  for (const p of [A, B]) {
    seedTask(p, { taskId: "da1", title: "Arch", archived: 1 });
    const db = new DatabaseSync(p);
    db.exec("PRAGMA foreign_keys = ON");
    db.prepare("INSERT OR IGNORE INTO task_groups (group_id, title, color, created_at, updated_at) VALUES ('g1','G','gray',1000,1000)").run();
    db.prepare("INSERT INTO task_group_members (group_id, workspace_key, workspace_path, task_id, sort_order, added_at, created_at, updated_at) VALUES ('g1',?,?,'da1',NULL,1000,1000,1000)").run(WS, WS);
    db.close();
  }
  const da1Ts = await withTs((r) => r.deleteArchivedTask({ workspacePath: WS, taskId: "da1" }));
  const da1Rs = addon.deleteArchivedTaskJson(B, WS, "da1");
  cmp("deleteArchived(a).meta", da1Ts, da1Rs);
  cmp("deleteArchived(a).raw", dumpRaw(A, "da1"), dumpRaw(B, "da1"));
  cmp("deleteArchived(a).member", hasMember(A, "da1"), hasMember(B, "da1"));

  // b) not archived → null, row untouched.
  seedTask(A, { taskId: "da2", title: "Live", archived: 0 });
  seedTask(B, { taskId: "da2", title: "Live", archived: 0 });
  const da2Ts = await withTs((r) => r.deleteArchivedTask({ workspacePath: WS, taskId: "da2" }));
  const da2Rs = addon.deleteArchivedTaskJson(B, WS, "da2");
  cmp("deleteArchived(notArchived).meta", da2Ts, da2Rs);
  cmp("deleteArchived(notArchived).raw", dumpRaw(A, "da2"), dumpRaw(B, "da2"));

  // c) already deleted → null.
  seedTask(A, { taskId: "da3", title: "Del", archived: 1, deleted: 1 });
  seedTask(B, { taskId: "da3", title: "Del", archived: 1, deleted: 1 });
  const da3Ts = await withTs((r) => r.deleteArchivedTask({ workspacePath: WS, taskId: "da3" }));
  const da3Rs = addon.deleteArchivedTaskJson(B, WS, "da3");
  cmp("deleteArchived(alreadyDeleted)", da3Ts, da3Rs);
} catch (e) {
  console.log(`ERROR ${(e as Error).message}`);
  diffs++;
} finally {
  rmSync(dir, { recursive: true, force: true });
}
if (diffs === 0) console.log("AGENT-PATCH / DELETE-ARCHIVED PARITY: OK");
else console.log(`AGENT-PATCH / DELETE-ARCHIVED PARITY: ${diffs} DIFF(S)`);
process.exit(diffs === 0 ? 0 : 1);
