// TS-vs-Rust golden WRITE-parity harness for OffPeakTaskRepo state-machine transitions.
// For each transition, a uniquely-keyed `off_peak_tasks` row is seeded IDENTICALLY into two
// bootstrapped DBs; the same guarded UPDATE is applied through the real TS repo (DB A) and the
// Rust addon (DB B); then the raw row is deep-diffed. All timestamps (started_at / ended_at /
// now / settled_at) are injected on BOTH sides, so the writes are deterministic and no clock
// normalization is needed. JSON columns are canonicalized (key order is not a parity contract).
// Run from repo root:
//   node_modules/.bin/tsx packages/desktop/zcode-db/harness/write_parity_offpeak.mts
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

const dir = mkdtempSync(join(tmpdir(), "zcode-offpeak-"));
const A = join(dir, "ts.sqlite");
const B = join(dir, "rs.sqlite");

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

interface Seed {
  status: string;
  claimRunning: number;
  sessionId?: string;
  conversationId?: string;
  serverTicketId?: string;
  startedAt?: number;
  attemptCount?: number;
}

const BASE = { queuedAt: 1000, created: 900 };

function seed(path: string, id: string, s: Seed): void {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA foreign_keys = ON");
  db.prepare(
    `INSERT INTO off_peak_tasks (off_peak_task_id, title, prompt, permission_mode,
      workspace_key, workspace_path, status, queued_at, schedulable, claim_running,
      attempt_count, session_id, conversation_id, server_ticket_id, started_at,
      created_at, updated_at)
     VALUES (?, 't', 'p', 'plan', ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    "/parity/ws",
    "/parity/ws",
    s.status,
    BASE.queuedAt,
    s.claimRunning,
    s.attemptCount ?? 0,
    s.sessionId ?? null,
    s.conversationId ?? null,
    s.serverTicketId ?? null,
    s.startedAt ?? null,
    BASE.created,
    BASE.created,
  );
  db.close();
}

function dump(path: string, id: string): unknown {
  const db = new DatabaseSync(path, { readOnly: true });
  const row = db
    .prepare("SELECT * FROM off_peak_tasks WHERE off_peak_task_id = ?")
    .get(id) as Record<string, unknown>;
  db.close();
  if (typeof row.model_selection === "string")
    row.model_selection = canonicalize(JSON.parse(String(row.model_selection)));
  return canonicalize(row);
}

let diffs = 0;
function compare(name: string, id: string): void {
  const a = JSON.stringify(dump(A, id));
  const b = JSON.stringify(dump(B, id));
  if (a === b) {
    console.log(`  ${name}: OK`);
  } else {
    diffs++;
    console.log(`  ${name}: DIFF`);
    console.log(`    ts: ${a}`);
    console.log(`    rs: ${b}`);
  }
}

// Reopen the TS repo once (schema already bootstrapped) for the transition calls.
async function withTs<T>(fn: (r: InstanceType<typeof OffPeakTaskRepo>) => Promise<T>): Promise<T> {
  const repo = new OffPeakTaskRepo(A);
  await repo.ensureReady();
  try {
    return await fn(repo);
  } finally {
    repo.close();
  }
}

try {
  // Bootstrap schemas: TS side via the repo, Rust side via the addon.
  {
    const boot = new OffPeakTaskRepo(A);
    await boot.ensureReady();
    boot.close();
  }
  addon.bootstrapTasksIndex(B, 25);

  // 1) markRunning: queued -> running (COALESCE ids, reset claim/last_error).
  seed(A, "run", { status: "queued", claimRunning: 0 });
  seed(B, "run", { status: "queued", claimRunning: 0 });
  await withTs((r) =>
    r.markRunning("run", {
      startedAt: 2000,
      conversationId: "conv-1",
      sessionId: "sess-1",
      serverTicketId: "tick-1",
    }),
  );
  addon.offpeakMarkRunningJson(B, "run", 2000, "conv-1", "sess-1", "tick-1");
  compare("markRunning", "run");

  // 2) setPaused(true): queued -> paused.
  seed(A, "pause", { status: "queued", claimRunning: 0 });
  seed(B, "pause", { status: "queued", claimRunning: 0 });
  await withTs((r) => r.setPaused("pause", true, { now: 2100 }));
  addon.offpeakSetPausedJson(B, "pause", true, 2100);
  compare("setPaused(true)", "pause");

  // 3) setPaused(false): paused -> queued.
  seed(A, "unpause", { status: "paused", claimRunning: 0 });
  seed(B, "unpause", { status: "paused", claimRunning: 0 });
  await withTs((r) => r.setPaused("unpause", false, { now: 2200 }));
  addon.offpeakSetPausedJson(B, "unpause", false, 2200);
  compare("setPaused(false)", "unpause");

  // 4) setPaused guard: mid-dispatch (claim_running=1) -> rejected on both sides (null / no write).
  seed(A, "pauseblocked", { status: "queued", claimRunning: 1 });
  seed(B, "pauseblocked", { status: "queued", claimRunning: 1 });
  const tsPauseGuard = await withTs((r) => r.setPaused("pauseblocked", true, { now: 2300 }));
  addon.offpeakSetPausedJson(B, "pauseblocked", true, 2300);
  if (tsPauseGuard !== null) {
    diffs++;
    console.log("  setPaused-guard: DIFF (ts returned a row, expected null)");
  } else {
    compare("setPaused-guard", "pauseblocked");
  }

  // 5) markTerminal: running -> completed, filesChanged kept, dispatchError bumps attempt + last_error.
  seed(A, "done", { status: "running", claimRunning: 1, startedAt: 1500, attemptCount: 2 });
  seed(B, "done", { status: "running", claimRunning: 1, startedAt: 1500, attemptCount: 2 });
  await withTs((r) =>
    r.markTerminal("done", {
      status: "completed",
      endedAt: 3000,
      failureReason: "none",
      filesChanged: 7,
      dispatchError: "boom",
    }),
  );
  addon.offpeakMarkTerminalJson(B, "done", "completed", 3000, "none", 7, "boom");
  compare("markTerminal(completed)", "done");

  // 6) markTerminal irreversibility guard: an already-terminal row rejects the 2nd transition.
  seed(A, "already", { status: "failed", claimRunning: 0, attemptCount: 1 });
  seed(B, "already", { status: "failed", claimRunning: 0, attemptCount: 1 });
  await withTs((r) => r.markTerminal("already", { status: "completed", endedAt: 3100 }));
  addon.offpeakMarkTerminalJson(B, "already", "completed", 3100, null, null, null);
  compare("markTerminal-guard", "already");

  // 7) releaseClaim: clear single-flight lock, bump attempt + last_error when error present.
  seed(A, "rel", { status: "running", claimRunning: 1, attemptCount: 0 });
  seed(B, "rel", { status: "running", claimRunning: 1, attemptCount: 0 });
  await withTs((r) => r.releaseClaim("rel", { error: "dispatch failed", now: 4000 }));
  addon.offpeakReleaseClaimJson(B, "rel", "dispatch failed", 4000);
  compare("releaseClaim", "rel");

  // 8) markSettled: backfill settled_at on a terminal row.
  seed(A, "settle", { status: "completed", claimRunning: 0 });
  seed(B, "settle", { status: "completed", claimRunning: 0 });
  await withTs((r) => r.markSettled("settle", 5000));
  addon.offpeakMarkSettledJson(B, "settle", 5000);
  compare("markSettled", "settle");
} catch (e) {
  console.log(`ERROR ${(e as Error).message}`);
  diffs++;
} finally {
  rmSync(dir, { recursive: true, force: true });
}
if (diffs === 0) console.log("OFFPEAK WRITE PARITY: OK — all transitions identical");
else console.log(`OFFPEAK WRITE PARITY: ${diffs} DIFF(S)`);
process.exit(diffs === 0 ? 0 : 1);
