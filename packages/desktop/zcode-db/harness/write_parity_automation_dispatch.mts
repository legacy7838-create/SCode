// TS-vs-Rust golden WRITE-parity harness for AutomationRepo dispatch / claim / run-ledger ops.
// Each scenario seeds an IDENTICAL `automations` (and, for ledger cases, `automation_runs`) row
// into two bootstrapped DBs, applies the same op through the real TS repo (DB A) and the Rust
// addon (DB B), then deep-diffs the resulting row.
//   - `updated_at` is normalized on the automations table (TS setEnabled/restart/releaseClaim stamp
//     Date.now() internally; the Rust wrappers take an injected clock — a clock artifact only).
//   - `created_at` + `updated_at` are normalized on automation_runs (ensure/upsert/skip stamp
//     Date.now() in both paths).
// Everything else — status transitions, computed lifecycle/enabled/next_run_at, retry_at backoff,
// attempt counts, COALESCE guards, model_selection JSON — must match byte-for-byte.
// Run from repo root:
//   node_modules/.bin/tsx packages/desktop/zcode-db/harness/write_parity_automation_dispatch.mts
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

const dir = mkdtempSync(join(tmpdir(), "zcode-autodisp-"));
const A = join(dir, "ts.sqlite");
const B = join(dir, "rs.sqlite");
const WS = "/parity/ws";
const NOW = 1_700_000_000_000;

const canonicalize = (v: unknown): unknown =>
  Array.isArray(v)
    ? v.map(canonicalize)
    : v && typeof v === "object"
      ? Object.fromEntries(
          Object.keys(v as object)
            .sort()
            .map((k) => [k, canonicalize((v as Record<string, unknown>)[k])]),
        )
      : v;

const SEL = JSON.stringify({ providerId: "account:zai", modelId: "GLM-5" });

interface AutoSeed {
  recurring?: number;
  maxRuns?: number | null;
  endAt?: number | null;
  runCount?: number;
  scheduledRunCount?: number;
  dispatchAttempts?: number;
  dispatchStatus?: string;
  lifecycleStatus?: string;
  enabled?: number;
  running?: number;
  nextRunAt?: number | null;
  lastError?: string | null;
  retryAt?: number | null;
  modelSelection?: string | null;
}

function seedAuto(path: string, id: string, s: AutoSeed = {}): void {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA foreign_keys = ON");
  db.prepare(
    `INSERT INTO automations (automation_id, title, cron_expr, prompt, model_selection, mode,
      workspace_key, workspace_path, location_kind, recurring, max_runs, end_at,
      run_count, scheduled_run_count, enabled, lifecycle_status, dispatch_status,
      dispatch_attempts, running, next_run_at, last_error, retry_at, created_at, updated_at)
     VALUES (?, 't', '* * * * *', 'p', ?, 'plan', ?, ?, 'local', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1000, 1000)`,
  ).run(
    id,
    s.modelSelection ?? SEL,
    WS,
    WS,
    s.recurring ?? 1,
    s.maxRuns ?? null,
    s.endAt ?? null,
    s.runCount ?? 2,
    s.scheduledRunCount ?? 2,
    s.enabled ?? 1,
    s.lifecycleStatus ?? "active",
    s.dispatchStatus ?? "idle",
    s.dispatchAttempts ?? 0,
    s.running ?? 0,
    s.nextRunAt ?? 111,
    s.lastError ?? null,
    s.retryAt ?? null,
  );
  db.close();
}

function seedRun(path: string, r: { runId: string; trigger?: string; dispatchStatus?: string; attempts?: number; modelSelection?: string | null; outcome?: string | null; error?: string | null; sessionId?: string | null }): void {
  const db = new DatabaseSync(path);
  db.prepare(
    `INSERT INTO automation_runs (run_id, automation_id, workspace_key, scheduled_at, trigger,
      model_selection, dispatch_status, outcome, session_id, error, attempts, created_at, updated_at)
     VALUES (?, ?, ?, 555, ?, ?, ?, ?, ?, ?, ?, 1000, 1000)`,
  ).run(
    r.runId,
    "auto_runs_owner",
    WS,
    r.trigger ?? "schedule",
    r.modelSelection ?? null,
    r.dispatchStatus ?? "claimed",
    r.outcome ?? null,
    r.sessionId ?? null,
    r.error ?? null,
    r.attempts ?? 0,
  );
  db.close();
}

function dumpRow(path: string, table: string, keyCol: string, key: string, dropCols: string[]): unknown {
  const db = new DatabaseSync(path, { readOnly: true });
  const row = db.prepare(`SELECT * FROM ${table} WHERE ${keyCol} = ?`).get(key) as Record<string, unknown>;
  db.close();
  if (!row) return null;
  for (const c of ["model_selection"]) if (typeof row[c] === "string") row[c] = canonicalize(JSON.parse(String(row[c])));
  for (const c of dropCols) delete row[c];
  return canonicalize(row);
}

const dumpAuto = (p: string, id: string) => dumpRow(p, "automations", "automation_id", id, ["updated_at"]);
const dumpRun = (p: string, rid: string) => dumpRow(p, "automation_runs", "run_id", rid, ["created_at", "updated_at"]);

let diffs = 0;
function compare(name: string, a: unknown, b: unknown): void {
  if (JSON.stringify(a) === JSON.stringify(b)) console.log(`  ${name}: OK`);
  else {
    diffs++;
    console.log(`  ${name}: DIFF`);
    console.log(`    ts: ${JSON.stringify(a)}`);
    console.log(`    rs: ${JSON.stringify(b)}`);
  }
}

async function withTs<T>(fn: (r: InstanceType<typeof AutomationRepo>) => Promise<T>): Promise<T> {
  const repo = new AutomationRepo(A);
  await repo.ensureReady();
  try {
    return await fn(repo);
  } finally {
    repo.close();
  }
}

try {
  {
    const boot = new AutomationRepo(A);
    await boot.ensureReady();
    boot.close();
  }
  addon.bootstrapTasksIndex(B, 25);

  // ---- automations-row transitions (normalize updated_at) ----
  const autoCases: Array<[string, AutoSeed, (id: string, ts: InstanceType<typeof AutomationRepo>) => Promise<void>, (id: string) => void]> = [
    ["setEnabled(false)", {}, async (id, ts) => ts.setEnabled(id, false, WS), (id) => addon.automationSetEnabledJson(B, id, false, WS, NOW)],
    ["restart", { runCount: 9, scheduledRunCount: 9, dispatchAttempts: 3, lifecycleStatus: "completed", enabled: 0, running: 1, nextRunAt: 777, lastError: "e", retryAt: 888 }, async (id, ts) => ts.restart(id, { nextRunAt: null }, WS), (id) => addon.automationRestartJson(B, id, null, WS, NOW)],
    ["markDispatched->completed", { recurring: 0, maxRuns: 1, scheduledRunCount: 0, running: 1 }, async (id, ts) => ts.markDispatched(id, { dispatchedAt: 5000, nextRunAt: 999 }), (id) => addon.automationMarkDispatchedJson(B, id, 5000, 999)],
    ["markDispatched->active", { recurring: 1, running: 1 }, async (id, ts) => ts.markDispatched(id, { dispatchedAt: 5000, nextRunAt: 999 }), (id) => addon.automationMarkDispatchedJson(B, id, 5000, 999)],
    ["markDispatched->endAt", { recurring: 1, endAt: 100 }, async (id, ts) => ts.markDispatched(id, { dispatchedAt: 5000, nextRunAt: 999 }), (id) => addon.automationMarkDispatchedJson(B, id, 5000, 999)],
    ["markDispatchFailed transient<max", { dispatchAttempts: 0 }, async (id, ts) => ts.markDispatchFailed(id, { failedAt: 6000, error: "boom", kind: "transient" }), (id) => addon.automationMarkDispatchFailedJson(B, id, 6000, "boom", "transient", null)],
    ["markDispatchFailed permanent", {}, async (id, ts) => ts.markDispatchFailed(id, { failedAt: 6000, error: "fatal", kind: "permanent" }), (id) => addon.automationMarkDispatchFailedJson(B, id, 6000, "fatal", "permanent", null)],
    ["markDispatchFailed max+recurring", { dispatchAttempts: 4, recurring: 1 }, async (id, ts) => ts.markDispatchFailed(id, { failedAt: 6000, error: "gave up", kind: "transient", nextRunAt: 4242 }), (id) => addon.automationMarkDispatchFailedJson(B, id, 6000, "gave up", "transient", 4242)],
    ["markDispatchFailed max+nonrecurring", { dispatchAttempts: 4, recurring: 0 }, async (id, ts) => ts.markDispatchFailed(id, { failedAt: 6000, error: "gave up", kind: "transient", nextRunAt: 4242 }), (id) => addon.automationMarkDispatchFailedJson(B, id, 6000, "gave up", "transient", 4242)],
    ["releaseClaim", { running: 1, dispatchStatus: "dispatched" }, async (id, ts) => ts.releaseClaim(id), (id) => addon.automationReleaseClaimJson(B, id, NOW)],
  ];
  for (const [name, seed, tsOp, rsOp] of autoCases) {
    const id = `a_${name.replace(/[^a-z0-9]/gi, "_")}`;
    seedAuto(A, id, seed);
    seedAuto(B, id, seed);
    await withTs((ts) => tsOp(id, ts));
    rsOp(id);
    compare(name, dumpAuto(A, id), dumpAuto(B, id));
  }

  // ---- run-ledger ops (normalize created_at + updated_at) ----
  // ensureRunClaimed: insert a fresh claimed row.
  seedAuto(A, "auto_runs_owner", {});
  seedAuto(B, "auto_runs_owner", {});
  const idn = { runId: "r_ensure", automationId: "auto_runs_owner", workspaceKey: WS, scheduledAt: 555, trigger: "schedule" };
  await withTs((ts) => ts.ensureRunClaimed(idn));
  addon.automationEnsureRunClaimedJson(B, JSON.stringify(idn), NOW);
  compare("ensureRunClaimed", dumpRun(A, "r_ensure"), dumpRun(B, "r_ensure"));

  // upsertRunClaimed fresh (with model selection).
  const upsertFresh = { runId: "r_upsert_new", automationId: "auto_runs_owner", workspaceKey: WS, scheduledAt: 555, trigger: "manual", modelSelection: { providerId: "account:zai", modelId: "GLM-5" } };
  await withTs((ts) => ts.upsertRunClaimed(upsertFresh));
  addon.automationUpsertRunClaimedJson(B, JSON.stringify(upsertFresh), JSON.stringify({ providerId: "account:zai", modelId: "GLM-5" }), NOW);
  compare("upsertRunClaimed(fresh)", dumpRun(A, "r_upsert_new"), dumpRun(B, "r_upsert_new"));

  // upsertRunClaimed on existing run_id: attempts+1, outcome/error cleared, model_selection COALESCE-kept.
  seedRun(A, { runId: "r_upsert_old", dispatchStatus: "dispatched", attempts: 2, outcome: "succeeded", error: null, modelSelection: SEL });
  seedRun(B, { runId: "r_upsert_old", dispatchStatus: "dispatched", attempts: 2, outcome: "succeeded", error: null, modelSelection: SEL });
  const upsertOld = { runId: "r_upsert_old", automationId: "auto_runs_owner", workspaceKey: WS, scheduledAt: 555, trigger: "schedule", modelSelection: { providerId: "account:zai", modelId: "GLM-5-Turbo" } };
  await withTs((ts) => ts.upsertRunClaimed(upsertOld));
  addon.automationUpsertRunClaimedJson(B, JSON.stringify(upsertOld), JSON.stringify({ providerId: "account:zai", modelId: "GLM-5-Turbo" }), NOW);
  compare("upsertRunClaimed(retry)", dumpRun(A, "r_upsert_old"), dumpRun(B, "r_upsert_old"));

  // markRunDispatch: claimed -> dispatched with session, error null.
  await withTs((ts) => ts.markRunDispatch({ runId: "r_ensure", dispatchStatus: "dispatched", sessionId: "sess-9", error: null }));
  addon.automationMarkRunDispatchJson(B, "r_ensure", "dispatched", "sess-9", null, NOW);
  compare("markRunDispatch->dispatched", dumpRun(A, "r_ensure"), dumpRun(B, "r_ensure"));

  // markRunDispatch: -> failed_to_dispatch with error (clears session via COALESCE keep).
  await withTs((ts) => ts.markRunDispatch({ runId: "r_upsert_new", dispatchStatus: "failed_to_dispatch", sessionId: null, error: "nope" }));
  addon.automationMarkRunDispatchJson(B, "r_upsert_new", "failed_to_dispatch", null, "nope", NOW);
  compare("markRunDispatch->failed", dumpRun(A, "r_upsert_new"), dumpRun(B, "r_upsert_new"));

  // markRunOutcome: a terminal outcome (succeeded) is NOT overwritten by a late 'running'.
  seedRun(A, { runId: "r_out", dispatchStatus: "dispatched", outcome: "succeeded" });
  seedRun(B, { runId: "r_out", dispatchStatus: "dispatched", outcome: "succeeded" });
  await withTs((ts) => ts.markRunOutcome("r_out", "running", undefined));
  addon.automationMarkRunOutcomeJson(B, "r_out", "running", null, NOW);
  compare("markRunOutcome(running-guard)", dumpRun(A, "r_out"), dumpRun(B, "r_out"));

  // markRunOutcome: failed overwrites running outcome + records error.
  seedRun(A, { runId: "r_out2", dispatchStatus: "dispatched", outcome: "running" });
  seedRun(B, { runId: "r_out2", dispatchStatus: "dispatched", outcome: "running" });
  await withTs((ts) => ts.markRunOutcome("r_out2", "failed", "crashed"));
  addon.automationMarkRunOutcomeJson(B, "r_out2", "failed", "crashed", NOW);
  compare("markRunOutcome(failed)", dumpRun(A, "r_out2"), dumpRun(B, "r_out2"));

  // recordSkippedRun: insert a fresh skipped row (error = reason).
  const skipId = { runId: "r_skip", automationId: "auto_runs_owner", workspaceKey: WS, scheduledAt: 555, trigger: "schedule" };
  await withTs((ts) => ts.recordSkippedRun({ ...skipId, reason: "missed window" }));
  addon.automationRecordSkippedRunJson(B, JSON.stringify(skipId), "missed window", NOW);
  compare("recordSkippedRun", dumpRun(A, "r_skip"), dumpRun(B, "r_skip"));

  // fixRunModelSelection: a null model_selection is fixed once; a later fix keeps the first value.
  seedRun(A, { runId: "r_fix", dispatchStatus: "claimed", modelSelection: null });
  seedRun(B, { runId: "r_fix", dispatchStatus: "claimed", modelSelection: null });
  await withTs((ts) => ts.fixRunModelSelection("r_fix", { providerId: "account:zai", modelId: "GLM-5" }));
  addon.automationFixRunModelSelectionJson(B, "r_fix", JSON.stringify({ providerId: "account:zai", modelId: "GLM-5" }), NOW);
  await withTs((ts) => ts.fixRunModelSelection("r_fix", { providerId: "account:zai", modelId: "GLM-5-Turbo" }));
  addon.automationFixRunModelSelectionJson(B, "r_fix", JSON.stringify({ providerId: "account:zai", modelId: "GLM-5-Turbo" }), NOW);
  compare("fixRunModelSelection(keep-first)", dumpRun(A, "r_fix"), dumpRun(B, "r_fix"));
} catch (e) {
  console.log(`ERROR ${(e as Error).message}`);
  diffs++;
} finally {
  rmSync(dir, { recursive: true, force: true });
}
if (diffs === 0) console.log("AUTOMATION DISPATCH WRITE PARITY: OK — all ops identical");
else console.log(`AUTOMATION DISPATCH WRITE PARITY: ${diffs} DIFF(S)`);
process.exit(diffs === 0 ? 0 : 1);
