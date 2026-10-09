// TS-vs-Rust golden WRITE-parity harness for AutomationRepo.update/delete (slice 39).
// Two freshly-bootstrapped DBs get an IDENTICAL seeded `automations` row; the same update patch
// is applied through the real TS repo and the Rust addon, then the resulting rows are deep-diffed.
// JSON columns (model_selection / schedule_rule / bot_delivery_target) are canonicalized before
// compare because serialization key order is not a parity contract.
// Run from repo root:  node_modules/.bin/tsx packages/desktop/zcode-db/harness/write_parity_automation.mts
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

const dir = mkdtempSync(join(tmpdir(), "zcode-auto-"));
const A = join(dir, "ts.sqlite");
const B = join(dir, "rs.sqlite");
const ID = "auto_parity_1";
const WS = "/parity/ws";
const NOW = 1_700_000_000_000;

const canonicalize = (v: unknown): unknown =>
  Array.isArray(v) ? v.map(canonicalize)
  : v && typeof v === "object" ? Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, canonicalize((v as Record<string, unknown>)[k])]))
  : v;

function seed(path: string): void {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA foreign_keys = ON");
  db.prepare(
    `INSERT INTO automations (automation_id, title, cron_expr, prompt, model_selection, mode,
      workspace_key, workspace_path, location_kind, recurring, run_count, scheduled_run_count,
      enabled, lifecycle_status, dispatch_status, dispatch_attempts, next_run_at, created_at, updated_at)
     VALUES (?, 't', '* * * * *', 'p', ?, 'plan', ?, ?, 'local', 1, 2, 2, 1, 'active', 'idle', 0, 111, 1000, 1000)`,
  ).run(ID, JSON.stringify({ providerId: "account:zai", modelId: "GLM-5" }), WS, WS);
  db.close();
}

function dump(path: string): unknown {
  const db = new DatabaseSync(path, { readOnly: true });
  const row = db.prepare("SELECT * FROM automations WHERE automation_id = ?").get(ID) as Record<string, unknown>;
  db.close();
  for (const c of ["model_selection", "schedule_rule", "bot_delivery_target"]) {
    if (typeof row[c] === "string") row[c] = canonicalize(JSON.parse(String(row[c])));
  }
  // `updated_at` is stamped Date.now() inside the TS repo (not injectable) vs an injected `now` in
  // the Rust wrapper — a clock artifact, not a merge difference. Normalize it out to compare the real
  // merge result. (created_at is fixed by the seed and already matches.)
  delete row.updated_at;
  return canonicalize(row);
}

const updPatch = { title: "renamed", cronExpr: "0 9 * * *", recurring: false, maxRuns: null, endAt: 555, modelSelection: null, mode: "build" };
const updOptions = { nextRunAt: 999, lifecycleStatus: "paused", resetRetry: true };

let diffs = 0;
try {
  const ta = new AutomationRepo(A); await ta.ensureReady(); ta.close(); seed(A);
  const rb = addon.bootstrapTasksIndex(B, 25); // create schema on B
  if (rb !== "initialize") console.log(`rust kind=${rb}`);
  seed(B);

  const tb = new AutomationRepo(A); await tb.ensureReady();
  await tb.update(ID, updPatch as never, updOptions as never, WS);
  tb.close();

  addon.updateAutomationJson(B, ID, JSON.stringify(updPatch), JSON.stringify(updOptions), WS, NOW);

  const a = dump(A), b = dump(B);
  if (JSON.stringify(a) === JSON.stringify(b)) console.log("AUTOMATION WRITE PARITY: OK — rows identical after update");
  else {
    diffs = 1;
    console.log("AUTOMATION WRITE PARITY: DIFF");
    console.log("ts:", JSON.stringify(a));
    console.log("rs:", JSON.stringify(b));
  }

  // delete differential
  const td = new AutomationRepo(A); await td.ensureReady();
  const delTs = await td.delete(ID, WS); td.close();
  const delRs = addon.deleteAutomationJson(B, ID, WS);
  if (delTs !== delRs) { console.log(`delete mismatch ts=${delTs} rs=${delRs}`); diffs++; }
  else console.log(`DELETE PARITY: OK (${delTs})`);
} catch (e) { console.log(`ERROR ${(e as Error).message}`); diffs++; }
finally { rmSync(dir, { recursive: true, force: true }); }
process.exit(diffs === 0 ? 0 : 1);
