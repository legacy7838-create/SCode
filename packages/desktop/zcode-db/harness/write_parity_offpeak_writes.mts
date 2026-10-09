// TS-vs-Rust golden WRITE-parity harness for the off-peak create/repair + automation create ops
// (slice 46): OffPeakTaskRepo.create / updateEditableFields / updateSchedulingSnapshot /
// invalidateModelSelection / markHistoryDeleted / delete, and AutomationRepo.create.
// Each op runs against IDENTICAL seeded state through the real TS repo (A) and the Rust addon (B),
// then the raw persisted row is deep-diffed. Random ids (offpeak-/automation-) are normalized;
// JSON columns (model_selection/schedule_rule/bot_delivery_target) canonicalized. `now`/clock is
// injected on both sides, so created_at/updated_at are NOT normalized away (they must match).
// Run from repo root:
//   node_modules/.bin/tsx packages/desktop/zcode-db/harness/write_parity_offpeak_writes.mts
import { createRequire } from "node:module";
import { rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const addon = require(join(here, "..", "zcode_db.node"));
const { DatabaseSync } = require("node:sqlite");
const { OffPeakTaskRepo } = await import("../../../services/src/session/offPeakTaskRepo.js");
const { AutomationRepo } = await import("../../../services/src/session/automationRepo.js");

const dir = mkdtempSync(join(tmpdir(), "zcode-opw-"));
const A = join(dir, "ts.sqlite");
const B = join(dir, "rs.sqlite");
const WS = "/parity/ws";
const NOW = 1_700_000_000_000;
const SEL = { providerId: "account:zai", modelId: "GLM-5", options: { reasoningLevel: "high" } };

const canonicalize = (v: unknown): unknown =>
  Array.isArray(v)
    ? v.map(canonicalize)
    : v && typeof v === "object"
      ? Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, canonicalize((v as Record<string, unknown>)[k])]))
      : v;
const normId = (row: Record<string, unknown>, col: string) => {
  if (typeof row[col] === "string") row[col] = (row[col] as string).replace(/^(offpeak|automation)-[0-9a-f-]{36}$/, "$1-<ID>");
};
function dump(path: string, table: string, keyCol: string, key: string, jsonCols: string[]): unknown {
  const db = new DatabaseSync(path, { readOnly: true });
  const row = db.prepare(`SELECT * FROM ${table} WHERE ${keyCol} = ?`).get(key) as Record<string, unknown> | undefined;
  db.close();
  if (!row) return null;
  for (const c of jsonCols) if (typeof row[c] === "string") row[c] = canonicalize(JSON.parse(String(row[c])));
  normId(row, keyCol);
  return canonicalize(row);
}
let diffs = 0;
function cmp(name: string, a: unknown, b: unknown): void {
  if (JSON.stringify(a) === JSON.stringify(b)) console.log(`  ${name}: OK`);
  else { diffs++; console.log(`  ${name}: DIFF`); console.log(`    ts: ${JSON.stringify(a)}`); console.log(`    rs: ${JSON.stringify(b)}`); }
}
function exec(path: string, sql: string, ...args: unknown[]): void {
  const db = new DatabaseSync(path); db.prepare(sql).run(...(args as never[])); db.close();
}
function seedOffPeak(path: string, id: string, o: { status?: string; sel?: unknown | null; schedulable?: number; startedAt?: number | null; historyDeletedAt?: number | null } = {}): void {
  exec(path,
    `INSERT INTO off_peak_tasks (off_peak_task_id, title, prompt, permission_mode, model_selection,
      workspace_key, workspace_path, status, queued_at, schedulable, started_at, history_deleted_at,
      created_at, updated_at)
     VALUES (?, 't', 'p', 'plan', ?, ?, ?, ?, 100, ?, ?, ?, 1000, 1000)`,
    id, o.sel === undefined ? JSON.stringify(SEL) : (o.sel === null ? null : JSON.stringify(o.sel)), WS, WS,
    o.status ?? "queued", o.schedulable ?? 1, o.startedAt ?? null, o.historyDeletedAt ?? null);
}

try {
  { const a = new OffPeakTaskRepo(A); await a.ensureReady(); a.close(); }
  addon.bootstrapTasksIndex(B, 25);

  // 1) create with a PINNED id (external-mint path) → deterministic raw row.
  {
    const createParams = { workspacePath: WS, title: "T", prompt: "P", permissionMode: "plan", modelSelection: SEL, boundSessionId: "sess-1" };
    const tsRepo = new OffPeakTaskRepo(A); await tsRepo.ensureReady();
    await tsRepo.create(createParams as never, { offPeakTaskId: "op_pin", serverTicketId: "tick", queuePosition: 3, registeredAt: 90, schedulable: true, now: NOW });
    tsRepo.close();
    addon.offpeakCreateJson(B, JSON.stringify(createParams), JSON.stringify({ offPeakTaskId: "op_pin", serverTicketId: "tick", queuePosition: 3, registeredAt: 90, schedulable: true }), NOW);
    cmp("create(pinned)", dump(A, "off_peak_tasks", "off_peak_task_id", "op_pin", ["model_selection"]), dump(B, "off_peak_tasks", "off_peak_task_id", "op_pin", ["model_selection"]));
  }

  // 2) updateEditableFields: title/prompt/permissionMode + modelSelection replace.
  for (const p of [A, B]) seedOffPeak(p, "ed1", { status: "queued" });
  {
    const tsRepo = new OffPeakTaskRepo(A); await tsRepo.ensureReady();
    await tsRepo.updateEditableFields("ed1", { title: "NewTitle", modelSelection: { providerId: "account:zai", modelId: "GLM-4.7" } }, { now: NOW });
    tsRepo.close();
    addon.offpeakUpdateEditableFieldsJson(B, "ed1", JSON.stringify({ title: "NewTitle", modelSelection: { providerId: "account:zai", modelId: "GLM-4.7" } }), NOW);
    cmp("updateEditableFields", dump(A, "off_peak_tasks", "off_peak_task_id", "ed1", ["model_selection"]), dump(B, "off_peak_tasks", "off_peak_task_id", "ed1", ["model_selection"]));
  }

  // 3) updateEditableFields guard: modelSelection:null → reject (null return), row unchanged.
  for (const p of [A, B]) seedOffPeak(p, "ed2", { status: "queued" });
  {
    const tsRepo = new OffPeakTaskRepo(A); await tsRepo.ensureReady();
    const r = await tsRepo.updateEditableFields("ed2", { modelSelection: null }, { now: NOW });
    tsRepo.close();
    const r2 = addon.offpeakUpdateEditableFieldsJson(B, "ed2", JSON.stringify({ modelSelection: null }), NOW);
    cmp("updateEditableFields(null-sel reject)", r, r2);
  }

  // 4) updateSchedulingSnapshot: schedulable + queuePosition(null clear) + nextPollAt(set).
  for (const p of [A, B]) seedOffPeak(p, "sch", { status: "queued", schedulable: 1 });
  {
    const tsRepo = new OffPeakTaskRepo(A); await tsRepo.ensureReady();
    await tsRepo.updateSchedulingSnapshot("sch", { schedulable: false, queuePosition: null, nextPollAt: 500, serverTicketId: "tk2", now: NOW });
    tsRepo.close();
    addon.offpeakUpdateSchedulingSnapshotJson(B, "sch", JSON.stringify({ schedulable: false, queuePosition: null, nextPollAt: 500, serverTicketId: "tk2" }), NOW);
    cmp("updateSchedulingSnapshot", dump(A, "off_peak_tasks", "off_peak_task_id", "sch", ["model_selection"]), dump(B, "off_peak_tasks", "off_peak_task_id", "sch", ["model_selection"]));
  }

  // 5) invalidateModelSelection: observed matches stored → clear selection, revoke schedulable, snapshot model/thought.
  for (const p of [A, B]) seedOffPeak(p, "inv", { status: "queued", schedulable: 1 });
  {
    const tsRepo = new OffPeakTaskRepo(A); await tsRepo.ensureReady();
    await tsRepo.invalidateModelSelection("inv", SEL, { now: NOW });
    tsRepo.close();
    addon.offpeakInvalidateModelSelectionJson(B, "inv", JSON.stringify(SEL), NOW);
    cmp("invalidateModelSelection(match)", dump(A, "off_peak_tasks", "off_peak_task_id", "inv", ["model_selection"]), dump(B, "off_peak_tasks", "off_peak_task_id", "inv", ["model_selection"]));
  }

  // 6) invalidate guard: observed differs from stored → preserve row (no overwrite).
  for (const p of [A, B]) seedOffPeak(p, "inv2", { status: "queued", sel: { providerId: "account:zai", modelId: "GLM-4.7" }, schedulable: 1 });
  {
    const tsRepo = new OffPeakTaskRepo(A); await tsRepo.ensureReady();
    await tsRepo.invalidateModelSelection("inv2", SEL, { now: NOW });
    tsRepo.close();
    addon.offpeakInvalidateModelSelectionJson(B, "inv2", JSON.stringify(SEL), NOW);
    cmp("invalidateModelSelection(stale-preserve)", dump(A, "off_peak_tasks", "off_peak_task_id", "inv2", ["model_selection"]), dump(B, "off_peak_tasks", "off_peak_task_id", "inv2", ["model_selection"]));
  }

  // 7) markHistoryDeleted: started row → stamp; not-started → unchanged.
  for (const p of [A, B]) seedOffPeak(p, "mh", { status: "running", startedAt: 150 });
  for (const p of [A, B]) seedOffPeak(p, "mh2", { status: "queued", startedAt: null });
  {
    const tsRepo = new OffPeakTaskRepo(A); await tsRepo.ensureReady();
    await tsRepo.markHistoryDeleted("mh", { now: NOW });
    await tsRepo.markHistoryDeleted("mh2", { now: NOW });
    tsRepo.close();
    addon.offpeakMarkHistoryDeletedJson(B, "mh", NOW);
    addon.offpeakMarkHistoryDeletedJson(B, "mh2", NOW);
    cmp("markHistoryDeleted(started)", dump(A, "off_peak_tasks", "off_peak_task_id", "mh", []), dump(B, "off_peak_tasks", "off_peak_task_id", "mh", []));
    cmp("markHistoryDeleted(notStarted)", dump(A, "off_peak_tasks", "off_peak_task_id", "mh2", []), dump(B, "off_peak_tasks", "off_peak_task_id", "mh2", []));
  }

  // 8) delete.
  for (const p of [A, B]) seedOffPeak(p, "del", { status: "queued" });
  {
    const tsRepo = new OffPeakTaskRepo(A); await tsRepo.ensureReady();
    await tsRepo.delete("del"); tsRepo.close();
    addon.offpeakDeleteJson(B, "del");
    cmp("delete", dump(A, "off_peak_tasks", "off_peak_task_id", "del", []), dump(B, "off_peak_tasks", "off_peak_task_id", "del", []));
  }

  // 9) automation create (id normalized).
  {
    const aParams = { workspacePath: WS, title: "Auto", cronExpr: "0 9 * * *", prompt: "p", modelSelection: SEL, mode: "plan", recurring: false, maxRuns: 3 };
    const ar = new AutomationRepo(A); await ar.ensureReady();
    const created = await ar.create(aParams as never, { nextRunAt: 500, lifecycleStatus: "active" });
    ar.close();
    const rs = JSON.parse(addon.automationCreateJson(B, JSON.stringify(aParams), JSON.stringify({ nextRunAt: 500, lifecycleStatus: "active" }), NOW)) as { automationId: string };
    // TS AutomationRepo.create stamps Date.now() internally (not injectable) vs the wrapper's
    // injected `now` — a clock artifact only. Drop created_at/updated_at before compare.
    const dropClock = (r: unknown) => { const x = r as Record<string, unknown>; if (x) { delete x.created_at; delete x.updated_at; } return x; };
    cmp("automation.create",
      dropClock(dump(A, "automations", "automation_id", created.automationId, ["model_selection", "schedule_rule", "bot_delivery_target"])),
      dropClock(dump(B, "automations", "automation_id", rs.automationId, ["model_selection", "schedule_rule", "bot_delivery_target"])));
  }
} catch (e) {
  console.log(`ERROR ${(e as Error).message}`);
  diffs++;
} finally {
  rmSync(dir, { recursive: true, force: true });
}
if (diffs === 0) console.log("OFFPEAK/AUTOMATION WRITE-OP PARITY: OK");
else console.log(`OFFPEAK/AUTOMATION WRITE-OP PARITY: ${diffs} DIFF(S)`);
process.exit(diffs === 0 ? 0 : 1);
