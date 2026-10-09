// TS-vs-Rust golden parity for AutomationRepo.runNow + claimManualRuns return shapes (slice 55) —
// the two ops the dispatch harness didn't cover. Both return `{ automation, run }` projections built
// from post-mutation row state; runNow mints a `:manual:<uuid>` run id (normalized). Seeds IDENTICAL
// `automations` rows, applies the same op through the real TS repo (A) and the addon (B), and diffs
// the returned projections plus the resulting automation row.
// Run from repo root:
//   node_modules/.bin/tsx packages/desktop/zcode-db/harness/write_parity_automation_runnow.mts
import { createRequire } from "node:module";
import { rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const addon = require(join(here, "..", "zcode_db.node"));
const { DatabaseSync } = require("node:sqlite");
const { AutomationRepo } = await import("../../../services/src/session/automationRepo.js");

const dir = mkdtempSync(join(tmpdir(), "zcode-rnow-"));
const A = join(dir, "ts.sqlite");
const B = join(dir, "rs.sqlite");
const WS = "/parity/ws";
const NOW = 1_700_000_000_000;

const canon = (v: unknown): unknown =>
  Array.isArray(v) ? v.map(canon)
    : v && typeof v === "object"
      ? Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, canon((v as Record<string, unknown>)[k])]))
      : v;
// run_id = `<automationId>:manual:<uuid>`; collapse the random uuid tail wherever it appears
// (top-level `runId`, nested `.run.runId`, or array elements).
const stripUuid = (o: Record<string, unknown> | null | undefined): void => {
  if (!o || typeof o !== "object") return;
  if (typeof o.runId === "string") o.runId = o.runId.replace(/:manual:[0-9a-f-]{36}$/, ":manual:<ID>");
  if (o.run && typeof o.run === "object") stripUuid(o.run as Record<string, unknown>);
};
const normRunId = (v: unknown): unknown => {
  const c = canon(v) as unknown;
  if (Array.isArray(c)) c.forEach((x) => stripUuid(x as Record<string, unknown>));
  else if (c && typeof c === "object") stripUuid(c as Record<string, unknown>);
  return c;
};
function seedAuto(path: string, id: string, running: number): void {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA foreign_keys = ON");
  db.prepare(
    `INSERT INTO automations (automation_id, title, cron_expr, prompt, model_selection, mode,
      workspace_key, workspace_path, location_kind, recurring, run_count, scheduled_run_count,
      enabled, lifecycle_status, dispatch_status, dispatch_attempts, running, next_run_at, created_at, updated_at)
     VALUES (?, 't', '* * * * *', 'p', ?, 'plan', ?, ?, 'local', 1, 0, 0, 1, 'active', 'idle', 0, ?, 111, 1000, 1000)`,
  ).run(id, JSON.stringify({ providerId: "account:zai", modelId: "GLM-5" }), WS, WS, running);
  db.close();
}
function dumpAuto(path: string, id: string): unknown {
  const db = new DatabaseSync(path, { readOnly: true });
  const r = db.prepare("SELECT * FROM automations WHERE automation_id=?").get(id) as Record<string, unknown>;
  db.close();
  if (!r) return null;
  delete r.updated_at; delete r.claimed_at; r.running = r.running; // running/claimed_at deterministic-but-clock-stamped; compare running, drop claimed_at(time==now both sides)
  delete r.claimed_at;
  for (const c of ["model_selection"]) if (typeof r[c] === "string") r[c] = canon(JSON.parse(String(r[c])));
  return canon(r);
}
function dumpRun(path: string, autoId: string): unknown {
  const db = new DatabaseSync(path, { readOnly: true });
  const r = db.prepare("SELECT * FROM automation_runs WHERE automation_id=?").get(autoId) as Record<string, unknown> | undefined;
  db.close();
  if (!r) return null;
  if (typeof r.run_id === "string") r.run_id = r.run_id.replace(/:manual:[0-9a-f-]{36}$/, ":manual:<ID>");
  delete r.created_at; delete r.updated_at; // clock artifacts (TS Date.now vs injected now)
  return canon(r);
}
let diffs = 0;
const cmp = (name: string, a: unknown, b: unknown) => {
  const sa = JSON.stringify(a), sb = JSON.stringify(b);
  if (sa === sb) console.log(`  ${name}: OK`);
  else { diffs++; console.log(`  ${name}: DIFF\n    ts: ${sa}\n    rs: ${sb}`); }
};
async function tsRun<T>(fn: (r: InstanceType<typeof AutomationRepo>) => Promise<T>): Promise<T> {
  const r = new AutomationRepo(A); await r.ensureReady();
  try { return await fn(r); } finally { r.close(); }
}

try {
  { const b = new AutomationRepo(A); await b.ensureReady(); b.close(); }
  addon.bootstrapTasksIndex(B, 25);

  // 1) runNow on a live (running=0) automation → returns {automation(running=1), run(manual,attempts1)}.
  seedAuto(A, "rn1", 0); seedAuto(B, "rn1", 0);
  const rnTs = await tsRun((r) => r.runNow("rn1", { now: NOW }, WS));
  const rnRs = JSON.parse(addon.automationRunNowJson(B, "rn1", WS, NOW) ?? "null");
  cmp("runNow.return", normRunId(rnTs), normRunId(rnRs));
  cmp("runNow.automationRow", dumpAuto(A, "rn1"), dumpAuto(B, "rn1"));
  cmp("runNow.runRow", dumpRun(A, "rn1"), dumpRun(B, "rn1"));

  // 2) runNow again while running=1 → guard returns null both sides.
  const rn2Ts = await tsRun((r) => r.runNow("rn1", { now: NOW + 1 }, WS));
  const rn2Rs = addon.automationRunNowJson(B, "rn1", WS, NOW + 1);
  cmp("runNow(again→null)", rn2Ts, rn2Rs);

  // 3) claimManualRuns picks the manual claimed run (after releasing the automation running lock).
  //    Both sides must release the automation running=1 first so the join matches a.running=0.
  await tsRun((r) => r.releaseManualClaim("rn1", WS));
  addon.automationReleaseManualClaimJson(B, "rn1", WS, NOW);
  const cmTs = await tsRun((r) => r.claimManualRuns(NOW));
  const cmRs = JSON.parse(addon.automationClaimManualRunsJson(B, NOW));
  cmp("claimManualRuns", normRunId(cmTs), normRunId(cmRs));
} catch (e) {
  console.log(`ERROR ${(e as Error).message}`);
  diffs++;
} finally {
  rmSync(dir, { recursive: true, force: true });
}
if (diffs === 0) console.log("AUTOMATION RUNNOW/CLAIM PARITY: OK");
else console.log(`AUTOMATION RUNNOW/CLAIM PARITY: ${diffs} DIFF(S)`);
process.exit(diffs === 0 ? 0 : 1);
