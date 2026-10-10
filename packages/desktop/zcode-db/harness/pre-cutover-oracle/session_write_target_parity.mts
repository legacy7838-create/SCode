// TS-vs-Rust golden WRITE-parity harness for the basic `session_target` lifecycle:
//   setSessionTarget (upsert), createSessionTarget (insert-or-ignore), updateSessionTargetStatus,
//   clearSessionTarget and updateSessionTargetSummaryTitle — each followed by the inline
//   `touchSessionForTarget` bump.
//
// The TS mints a non-reproducible `target_id` (base36(Date.now()) + randomUUID) and reads Date.now().
// Both are pinned for the comparison: the Rust addon receives a FIXED `targetId`+`now` per call, and
// `Date.now` is frozen on the TS side per call to the SAME `now`. `target_id` itself is excluded from
// the compared column set (it is the only non-deterministic column), so every DETERMINISTIC column —
// session_id, objective, summary_title, status, token_budget, tokens_used, time_used_seconds, the three
// active_* run fields, time_created, time_updated — plus the touched `session.time_updated` are
// deep-compared. Target-id-guarded ops (summary title) read the row's ACTUAL stored id per DB so the
// guard matches on both sides. Only throwaway /tmp DBs are touched — never the live `~/.zcode`.
//
// Run from the crate dir:
//   ../../../node_modules/.bin/tsx harness/session_write_target_parity.mts
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

// Import the REAL TS write ops by repo-root absolute path so their transitive workspace imports
// (`@zcode/contracts`) resolve via the consumer package's pnpm symlinks. Mirrors `session_input_parity.mts`.
const TS = await import(
  pathToFileURL(
    "/media/hdd1/ZCode/apps/zcode-cli/packages/adapters/src/storage/session-target.ts",
  ).href
);
const { setSessionTarget, createSessionTarget, updateSessionTargetStatus, clearSessionTarget, updateSessionTargetSummaryTitle } = TS;

const dir = mkdtempSync(join(tmpdir(), "zcode-target-write-parity-"));
const A = join(dir, "ts.sqlite");
const B = join(dir, "rs.sqlite");

// Fixed clocks per op (epoch ms): identical value feeds the frozen TS Date.now and the injected Rust `now`.
const NOW1 = 1_700_000_000_001; // S1 set
const NOW2 = 1_700_000_000_002; // S1 status
const NOW3 = 1_700_000_000_003; // S1 summary title (matched)
const NOW4 = 1_700_000_000_004; // S1 summary title (mismatch guard)
const NOW5 = 1_700_000_000_005; // S2 create (insert branch)
const NOW6 = 1_700_000_000_006; // S2 create (ignore branch)
const NOW7 = 1_700_000_000_007; // S2 status
const NOW8 = 1_700_000_000_008; // S3 set
const NOW9 = 1_700_000_000_009; // S3 clear
const NOW10 = 1_700_000_000_010; // S3 status after clear (zero-change → null, no touch)

// Fixed ids: Rust receives these; the TS ignores them (generates its own uuid), which is why target_id
// is excluded from the compared column set.
const TID_S1 = "target-rust-s1";
const TID_S2_CREATE = "target-rust-s2-create";
const TID_S2_IGNORE = "target-rust-s2-ignore"; // differs from stored → triggers the ignore branch
const TID_S3 = "target-rust-s3";

const S1 = "sess-set"; // set → status → summary(title) → summary(mismatch)
const S2 = "sess-create"; // create(insert) → create(ignore) → status
const S3 = "sess-clear"; // set → clear → status-after-clear(null)

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

// Read the ACTUAL stored target_id from a DB file (for target-id-guarded summary-title ops).
function getTid(path, sid) {
  const ro = new DatabaseSync(path, { readOnly: true });
  try {
    const row = ro.prepare("SELECT target_id FROM session_target WHERE session_id = ?").get(sid);
    return row ? row.target_id : null;
  } finally {
    ro.close();
  }
}

try {
  // Identical schema on both copies via the addon's own session-store bootstrap.
  addon.bootstrapSessionStoreJson(A, 5000, Date.now());
  addon.bootstrapSessionStoreJson(B, 5000, Date.now());

  // Seed the three parent sessions IDENTICALLY (time_updated starts below every NOW → max() moves forward).
  for (const path of [A, B]) {
    const seed = new DatabaseSync(path);
    seed.exec("PRAGMA foreign_keys = ON");
    const ins = seed.prepare(
      `INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated)
       VALUES (?, 'p', 's', '/d', 't', 'v', 1, 1)`,
    );
    ins.run(S1);
    ins.run(S2);
    ins.run(S3);
    seed.close();
  }

  // Open one TS handle (its implicit autocommit mirrors `DatabaseSync.run`, no explicit txn).
  const tsDb = new DatabaseSync(A);
  try {
    // ---- S1: set (insert arm) → status → summary title (matched) → summary title (mismatch) ----
    tsRun(NOW1, () => setSessionTarget(tsDb, { sessionID: S1, objective: "obj-1", status: "active", tokenBudget: 1000 }));
    tsRun(NOW2, () => updateSessionTargetStatus(tsDb, { sessionID: S1, status: "paused" }));
    tsRun(NOW3, () => updateSessionTargetSummaryTitle(tsDb, { sessionID: S1, targetID: getTid(A, S1), summaryTitle: "title-1" }));
    // Mismatched guard: zero changes → TS returns readSessionTarget (live row, unchanged) and does NOT touch.
    tsRun(NOW4, () => updateSessionTargetSummaryTitle(tsDb, { sessionID: S1, targetID: "target-does-not-exist", summaryTitle: "nope" }));

    // ---- S2: create (insert arm) → create (ignore arm) → status ----
    tsRun(NOW5, () => createSessionTarget(tsDb, { sessionID: S2, objective: "obj-2", tokenBudget: 500 }));
    // Row now exists for S2, so this create is ignored: TS returns null and does NOT touch (clock stays NOW5).
    tsRun(NOW6, () => createSessionTarget(tsDb, { sessionID: S2, objective: "IGNORED", tokenBudget: 9 }));
    tsRun(NOW7, () => updateSessionTargetStatus(tsDb, { sessionID: S2, status: "complete" }));

    // ---- S3: set → clear → status-after-clear (zero-change null, no touch) ----
    tsRun(NOW8, () => setSessionTarget(tsDb, { sessionID: S3, objective: "obj-3", status: "active", tokenBudget: null }));
    tsRun(NOW9, () => clearSessionTarget(tsDb, { sessionID: S3 }));
    tsRun(NOW10, () => updateSessionTargetStatus(tsDb, { sessionID: S3, status: "paused" }));
  } finally {
    tsDb.close();
  }

  // ---- Apply the SAME op sequence through the Rust addon (fixed target_id + injected now) ----
  addon.setSessionTargetJson(B, S1, TID_S1, "obj-1", "active", 1000, NOW1);
  addon.updateSessionTargetStatusJson(B, S1, "paused", NOW2);
  addon.updateTargetSummaryTitleJson(B, S1, getTid(B, S1), "title-1", NOW3);
  addon.updateTargetSummaryTitleJson(B, S1, "target-does-not-exist", "nope", NOW4);

  addon.createSessionTargetJson(B, S2, TID_S2_CREATE, "obj-2", 500, NOW5);
  addon.createSessionTargetJson(B, S2, TID_S2_IGNORE, "IGNORED", 9, NOW6);
  addon.updateSessionTargetStatusJson(B, S2, "complete", NOW7);

  addon.setSessionTargetJson(B, S3, TID_S3, "obj-3", "active", null, NOW8);
  addon.clearSessionTargetJson(B, S3, NOW9);
  addon.updateSessionTargetStatusJson(B, S3, "paused", NOW10);

  // ---- Read both final states back and compare (target_id deliberately excluded) ----
  const dump = (path) => {
    const ro = new DatabaseSync(path, { readOnly: true });
    const targetRows = ro
      .prepare(
        `SELECT session_id, objective, summary_title, status, token_budget, tokens_used,
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
      "TARGET WRITE PARITY: OK — set/create/status/clear/summary + touchSession identical across TS and Rust",
    );
  } else {
    console.error("TARGET WRITE PARITY: DIFF");
    console.error(`  TS: ${a}`);
    console.error(`  RS: ${b}`);
    process.exit(1);
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}
