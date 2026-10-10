// TS-vs-Rust golden WRITE-parity harness for the target-run LIFECYCLE writes:
//   startSessionTargetRun, heartbeatSessionTargetRun, finishSessionTargetRun,
//   recoverInterruptedSessionTargetRun and accountSessionTargetUsage.
//
// How the TS side is reproduced (honesty note): all five live in
// `apps/zcode-cli/packages/adapters/src/storage/session-target.ts` as EXPORTED functions taking `db`, so
// this harness imports and calls the REAL TS functions on DB A (no verbatim-SQL re-transcription needed)
// and applies the ported Rust addon on DB B, then byte-compares the `session_target` rows and the touched
// `session.time_updated`. Each session_target row is seeded with a FIXED target_id via raw SQL (bypassing
// `createSessionTarget`/`setSessionTarget`, which mint a random `target_<base36(Date)>_<uuid>`), so target_id
// is fully deterministic and included in the compared column set.
//
// Clock: four of the five methods take their time as an INPUT argument (startedAtMs/seenAtMs/endedAtMs) and
// never read Date.now; only `accountSessionTargetUsage` reads `Date.now()` (for `time_updated` + the session
// touch). For that one the frozen TS `Date.now` and the Rust-injected `now` are pinned to the SAME value per
// call. Everything else is clock-independent given the fixed seeds. Only throwaway /tmp DBs are touched —
// never the live `~/.zcode`.
//
// Run from the crate dir:
//   ../../../node_modules/.bin/tsx harness/session_write_target_run_parity.mts
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
// Load the freshly-built addon from THIS crate dir (the parity target under test).
const addon = require(join(here, "..", "zcode_db.node"));
const { DatabaseSync } = require("node:sqlite");

// Import the REAL TS target-run write ops by repo-root absolute path so their transitive workspace
// imports (`@zcode/contracts`) resolve via the consumer package's pnpm symlinks. Mirrors
// `session_write_target_parity.mts`.
const TS = await import(
  pathToFileURL(
    "/media/hdd1/ZCode/apps/zcode-cli/packages/adapters/src/storage/session-target.ts",
  ).href
);
const {
  startSessionTargetRun,
  heartbeatSessionTargetRun,
  finishSessionTargetRun,
  recoverInterruptedSessionTargetRun,
  accountSessionTargetUsage,
} = TS;

const dir = mkdtempSync(join(tmpdir(), "zcode-target-run-write-parity-"));
const A = join(dir, "ts.sqlite");
const B = join(dir, "rs.sqlite");

// Fixed run/heartbeat/finish inputs (epoch ms) — these are method ARGUMENTS on BOTH sides.
const START = 10_000;
const HB = 13_500;
const FINISH_END = 15_000;
// Fixed `now` for the account op (the only Date.now read); frozen for TS and injected for Rust.
const ACCOUNT_NOW = 1_700_000_000_000;

// Session ids, one per scenario.
const S_START = "s-start"; // start(active) → heartbeat → finish(complete, tokens)
const S_START_PAUSED = "s-start-paused"; // start on a paused target (guard → read, no touch)
const S_FINISH_MISMATCH = "s-finish-mismatch"; // finish with no active run (guard → current, no touch)
const S_FINISH_BUDGET = "s-finish-budget"; // start → finish(no override, budget reached) → budget_limited
const S_RECOVER = "s-recover"; // start → heartbeat → recover → paused, settles at last-seen
const S_RECOVER_IDLE = "s-recover-idle"; // recover with no active run (guard → current, no touch)
const S_ACCOUNT = "s-account"; // account(tokens,time) → account(0,0 no-op) → account(target mismatch)
const S_ACCOUNT_BUDGET = "s-account-budget"; // account reaching budget on active target → budget_limited

// Run one TS op with `Date.now` frozen to `now`, restoring it afterwards.
function tsRun(now, fn) {
  const realNow = Date.now;
  Date.now = () => now;
  try {
    return fn();
  } finally {
    Date.now = realNow;
  }
}

// Seed a parent session + a fixed-target session_target row into a DB file (raw SQL → no random ids).
// `time_updated` starts low (1) on both tables so every later op's max()/set bumps it forward.
function seedTargets() {
  for (const path of [A, B]) {
    const seed = new DatabaseSync(path);
    seed.exec("PRAGMA foreign_keys = ON");
    const insSession = seed.prepare(
      `INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated)
       VALUES (?, 'p', 's', '/d', 't', 'v', 1, 1)`,
    );
    const insTarget = seed.prepare(
      `INSERT INTO session_target (session_id, target_id, objective, status, token_budget, tokens_used, time_used_seconds, time_created, time_updated)
       VALUES (?, ?, 'obj', ?, ?, 0, 0, 1, 1)`,
    );
    for (const [sid, status, budget] of [
      [S_START, "active", null],
      [S_START_PAUSED, "paused", null],
      [S_FINISH_MISMATCH, "active", null],
      [S_FINISH_BUDGET, "active", 100],
      [S_RECOVER, "active", null],
      [S_RECOVER_IDLE, "active", null],
      [S_ACCOUNT, "active", null],
      [S_ACCOUNT_BUDGET, "active", 100],
    ]) {
      insSession.run(sid);
      insTarget.run(sid, `tid-${sid}`, status, budget);
    }
    seed.close();
  }
}

try {
  // Identical schema on both copies via the addon's own session-store bootstrap.
  addon.bootstrapSessionStoreJson(A, 5000, Date.now());
  addon.bootstrapSessionStoreJson(B, 5000, Date.now());
  seedTargets();

  const TID = (sid) => `tid-${sid}`;

  // ---- A (TS side) ----
  const tsDb = new DatabaseSync(A);
  try {
    // start(active) → heartbeat → finish(complete, +100 tokens)
    tsRun(ACCOUNT_NOW, () => startSessionTargetRun(tsDb, { sessionID: S_START, targetID: TID(S_START), inputID: "in-1", startedAtMs: START }));
    tsRun(ACCOUNT_NOW, () => heartbeatSessionTargetRun(tsDb, { sessionID: S_START, targetID: TID(S_START), inputID: "in-1", seenAtMs: HB }));
    tsRun(ACCOUNT_NOW, () => finishSessionTargetRun(tsDb, { sessionID: S_START, targetID: TID(S_START), inputID: "in-1", endedAtMs: FINISH_END, status: "complete", tokensUsedDelta: 100 }));

    // start on a PAUSED target: `status = 'active'` guard → zero change → current read, no touch.
    tsRun(ACCOUNT_NOW, () => startSessionTargetRun(tsDb, { sessionID: S_START_PAUSED, targetID: TID(S_START_PAUSED), inputID: "in-2", startedAtMs: START }));

    // finish with NO active run (active_run_started_at null) → early guard → current read, no touch.
    tsRun(ACCOUNT_NOW, () => finishSessionTargetRun(tsDb, { sessionID: S_FINISH_MISMATCH, targetID: TID(S_FINISH_MISMATCH), inputID: "in-3", endedAtMs: FINISH_END, status: "complete", tokensUsedDelta: 999 }));

    // start → finish(no status override, budget reached: +100 vs budget 100) → auto budget_limited.
    tsRun(ACCOUNT_NOW, () => startSessionTargetRun(tsDb, { sessionID: S_FINISH_BUDGET, targetID: TID(S_FINISH_BUDGET), inputID: "in-4", startedAtMs: START }));
    tsRun(ACCOUNT_NOW, () => finishSessionTargetRun(tsDb, { sessionID: S_FINISH_BUDGET, targetID: TID(S_FINISH_BUDGET), inputID: "in-4", endedAtMs: FINISH_END, tokensUsedDelta: 100 }));

    // start → heartbeat → recover: settles at last-seen, active → paused.
    tsRun(ACCOUNT_NOW, () => startSessionTargetRun(tsDb, { sessionID: S_RECOVER, targetID: TID(S_RECOVER), inputID: "in-5", startedAtMs: START }));
    tsRun(ACCOUNT_NOW, () => heartbeatSessionTargetRun(tsDb, { sessionID: S_RECOVER, targetID: TID(S_RECOVER), inputID: "in-5", seenAtMs: HB }));
    tsRun(ACCOUNT_NOW, () => recoverInterruptedSessionTargetRun(tsDb, { sessionID: S_RECOVER }));

    // recover with NO active run → guard → current read, no touch.
    tsRun(ACCOUNT_NOW, () => recoverInterruptedSessionTargetRun(tsDb, { sessionID: S_RECOVER_IDLE }));

    // account(+50 tok, +7 sec, now) → account(0,0 no-op) → account(target mismatch, no touch).
    tsRun(ACCOUNT_NOW, () => accountSessionTargetUsage(tsDb, { sessionID: S_ACCOUNT, targetID: TID(S_ACCOUNT), tokensUsedDelta: 50, timeUsedSecondsDelta: 7 }));
    tsRun(ACCOUNT_NOW, () => accountSessionTargetUsage(tsDb, { sessionID: S_ACCOUNT, targetID: TID(S_ACCOUNT), tokensUsedDelta: 0, timeUsedSecondsDelta: 0 }));
    tsRun(ACCOUNT_NOW, () => accountSessionTargetUsage(tsDb, { sessionID: S_ACCOUNT, targetID: "tid-does-not-exist", tokensUsedDelta: 1000, timeUsedSecondsDelta: 100 }));

    // account reaching budget on an active target → budget_limited.
    tsRun(ACCOUNT_NOW, () => accountSessionTargetUsage(tsDb, { sessionID: S_ACCOUNT_BUDGET, targetID: TID(S_ACCOUNT_BUDGET), tokensUsedDelta: 100 }));
  } finally {
    tsDb.close();
  }

  // ---- B (Rust side): the SAME op sequence with fixed ids/args and injected `now` ----
  addon.startSessionTargetRunJson(B, S_START, TID(S_START), "in-1", START);
  addon.heartbeatSessionTargetRunJson(B, S_START, TID(S_START), "in-1", HB);
  addon.finishSessionTargetRunJson(B, S_START, TID(S_START), "in-1", FINISH_END, "complete", 100);

  addon.startSessionTargetRunJson(B, S_START_PAUSED, TID(S_START_PAUSED), "in-2", START);

  addon.finishSessionTargetRunJson(B, S_FINISH_MISMATCH, TID(S_FINISH_MISMATCH), "in-3", FINISH_END, "complete", 999);

  addon.startSessionTargetRunJson(B, S_FINISH_BUDGET, TID(S_FINISH_BUDGET), "in-4", START);
  addon.finishSessionTargetRunJson(B, S_FINISH_BUDGET, TID(S_FINISH_BUDGET), "in-4", FINISH_END, null, 100);

  addon.startSessionTargetRunJson(B, S_RECOVER, TID(S_RECOVER), "in-5", START);
  addon.heartbeatSessionTargetRunJson(B, S_RECOVER, TID(S_RECOVER), "in-5", HB);
  addon.recoverInterruptedSessionTargetRunJson(B, S_RECOVER);

  addon.recoverInterruptedSessionTargetRunJson(B, S_RECOVER_IDLE);

  addon.accountSessionTargetUsageJson(B, S_ACCOUNT, TID(S_ACCOUNT), 50, 7, ACCOUNT_NOW);
  addon.accountSessionTargetUsageJson(B, S_ACCOUNT, TID(S_ACCOUNT), 0, 0, ACCOUNT_NOW);
  addon.accountSessionTargetUsageJson(B, S_ACCOUNT, "tid-does-not-exist", 1000, 100, ACCOUNT_NOW);

  addon.accountSessionTargetUsageJson(B, S_ACCOUNT_BUDGET, TID(S_ACCOUNT_BUDGET), 100, null, ACCOUNT_NOW);

  // ---- Read both final states back and compare every deterministic column ----
  const dump = (path) => {
    const ro = new DatabaseSync(path, { readOnly: true });
    const targetRows = ro
      .prepare(
        `SELECT session_id, target_id, objective, summary_title, status, token_budget, tokens_used,
                time_used_seconds, active_input_id, active_run_started_at, active_run_last_seen_at,
                time_created, time_updated
         FROM session_target ORDER BY session_id`,
      )
      .all();
    const sessionRows = ro.prepare("SELECT id, time_updated FROM session ORDER BY id").all();
    ro.close();
    return JSON.stringify({ targetRows, sessionRows });
  };

  const a = dump(A);
  const b = dump(B);
  if (a === b) {
    console.log(
      "TARGET-RUN WRITE PARITY: OK — start/heartbeat/finish/recover/account + touchSession identical across TS and Rust",
    );
  } else {
    console.error("TARGET-RUN WRITE PARITY: DIFF");
    console.error(`  TS: ${a}`);
    console.error(`  RS: ${b}`);
    process.exit(1);
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}
