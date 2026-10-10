// TS-vs-Rust golden WRITE-parity harness for the legacy/remote session repair + claim ops
// (`claimLegacySessionWorkspace`, `repairLegacyRemoteSessionWorkspace`, `repairRemoteSessionPaths`).
// Two throwaway /tmp session-store DBs (A = TS, B = Rust addon) are bootstrapped identically and seeded
// with the SAME variety of `session` rows: legacy rows with a NULL workspace, already-claimed rows,
// remote rows whose path must be re-pointed, and already-repaired rows (to prove idempotency). The REAL
// TS repository functions are imported by repo-root absolute path. None of the three ops read the clock,
// so no `Date.now` freeze is needed — but the injected `timeUpdated` is identical on both sides so the
// guarded `max(time_updated, ?)` is deterministic. For every op we run the TS call on A and the Rust
// addon call on B and compare BOTH the returned count/boolean AND the full `SELECT * FROM session ORDER
// BY id` dump byte-for-byte. Only /tmp copies are touched — never the live `~/.zcode`.
//
// Run from the crate dir:
//   ../../../node_modules/.bin/tsx harness/session_write_repairs_parity.mts
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

// Import the real TS write ops by their repo-root path so their transitive workspace imports
// (`@zcode/contracts`, `../codecs.js`, `../json.js`) resolve, mirroring the session_update harness.
const sessionsRepo =
  "/media/hdd1/ZCode/apps/zcode-cli/packages/adapters/src/storage/session-store/repositories/sessions.ts";
const { claimLegacySessionWorkspace, repairLegacyRemoteSessionWorkspace, repairRemoteSessionPaths } =
  await import(pathToFileURL(sessionsRepo).href);

const dir = mkdtempSync(join(tmpdir(), "zcode-repairs-write-parity-"));
const A = join(dir, "ts.sqlite");
const B = join(dir, "rs.sqlite");

let failed = 0;
const fail = (msg) => {
  console.error(`REPAIRS WRITE PARITY: FAIL — ${msg}`);
  failed = 1;
};

// A fixed, distinctive seed set applied IDENTICALLY to both DBs. Covers: a NULL-workspace legacy row with
// a matching directory (claim target), a NULL-workspace legacy row with the full old directory/path CAS
// pair (repair-legacy target), a remote row already bound to a workspace whose path must be re-pointed
// (repair-paths null arm), a remote row with a non-null path (repair-paths string arm), and rows that
// are already-repaired so the second run exercises idempotency on both sides.
const SEED = [
  { id: "c-claim-1", project_id: "p", workspace_id: null, directory: "/w", path: null, time_updated: 100 },
  { id: "c-claim-2", project_id: "p", workspace_id: null, directory: "/w", path: null, time_updated: 100 },
  { id: "c-claim-3", project_id: "p", workspace_id: null, directory: "/other", path: null, time_updated: 100 },
  { id: "c-claim-4", project_id: "p", workspace_id: "done", directory: "/w", path: null, time_updated: 100 },
  { id: "rl-match", project_id: "oldProj", workspace_id: null, directory: "/legacy", path: null, time_updated: 100 },
  { id: "rl-path-eq", project_id: "oldProj", workspace_id: null, directory: "/legacy", path: "/legacy", time_updated: 100 },
  { id: "rl-path-diff", project_id: "oldProj", workspace_id: null, directory: "/legacy", path: "/elsewhere", time_updated: 100 },
  { id: "rp-null", project_id: "p", workspace_id: "W", directory: "/old", path: null, time_updated: 100 },
  { id: "rp-str", project_id: "p", workspace_id: "W", directory: "/old", path: "/old/rel", time_updated: 1000 },
  { id: "rp-ws-mismatch", project_id: "p", workspace_id: "OTHER", directory: "/old", path: null, time_updated: 100 },
];

function seedBoth() {
  for (const path of [A, B]) {
    const s = new DatabaseSync(path);
    s.exec("PRAGMA foreign_keys = ON");
    const stmt = s.prepare(
      `INSERT INTO session (id, project_id, workspace_id, slug, directory, path, title, version,
                            time_created, time_updated)
       VALUES (?, ?, ?, 's', ?, ?, 't', 'v', 1, ?)`,
    );
    for (const r of SEED) {
      stmt.run(r.id, r.project_id, r.workspace_id, r.directory, r.path, r.time_updated);
    }
    s.close();
  }
}

// One mirrored op: run the identical TS call on A and Rust addon call on B, compare the returned
// count/boolean projections. `dump` captures the affected-table state after every step so a divergence
// in the WHERE/normalization logic surfaces immediately, not only at the end.
function mirror(kind, input) {
  const inStr = JSON.stringify(input);
  let tsRet;
  if (kind === "claim") tsRet = claimLegacySessionWorkspace(new DatabaseSync(A), input);
  else if (kind === "repairLegacy") tsRet = repairLegacyRemoteSessionWorkspace(new DatabaseSync(A), input);
  else tsRet = repairRemoteSessionPaths(new DatabaseSync(A), input);

  let rsRet;
  if (kind === "claim") rsRet = addon.claimLegacySessionWorkspaceJson(B, inStr);
  else if (kind === "repairLegacy") rsRet = addon.repairLegacyRemoteSessionWorkspaceJson(B, inStr);
  else rsRet = addon.repairRemoteSessionPathsJson(B, inStr);

  const tsStr = JSON.stringify(tsRet);
  if (tsStr !== rsRet) {
    fail(`${kind} return mismatch: TS=${tsStr} RS=${rsRet} (input ${inStr})`);
  }
  const tableA = dumpTable(A);
  const tableB = dumpTable(B);
  if (tableA !== tableB) {
    fail(`${kind} table diverged after input ${inStr}`);
  }
}

function dumpTable(path) {
  const ro = new DatabaseSync(path, { readOnly: true });
  const rows = ro.prepare("SELECT * FROM session ORDER BY id").all();
  ro.close();
  return JSON.stringify(rows);
}

try {
  addon.bootstrapSessionStoreJson(A, 5000, Date.now());
  addon.bootstrapSessionStoreJson(B, 5000, Date.now());
  seedBoth();

  // --- claimLegacySessionWorkspace: match set, allowlist misses, dedup, empty, idempotency. ---
  mirror("claim", { sessionIDs: ["c-claim-1", "c-claim-1", "c-claim-2", "c-claim-3", "c-claim-4", "ghost"], directory: "/w", workspaceID: "W-CLAIM" });
  // Second run: the two now-claimed rows fail the `workspace_id is null` guard → 0.
  mirror("claim", { sessionIDs: ["c-claim-1", "c-claim-2"], directory: "/w", workspaceID: "W-CLAIM2" });
  // Empty allowlist short-circuits 0.
  mirror("claim", { sessionIDs: [], directory: "/w", workspaceID: "W-EMPTY" });

  // --- repairLegacyRemoteSessionWorkspace: null-path CAS match, path-equal match, path-diff miss. ---
  mirror("repairLegacy", { sessionID: "rl-match", projectID: "newProj", legacyWorkspaceDirectory: "/legacy", workspaceID: "W-RL", workspacePath: "/resolved" });
  mirror("repairLegacy", { sessionID: "rl-path-eq", projectID: "newProj", legacyWorkspaceDirectory: "/legacy", workspaceID: "W-RL", workspacePath: "/resolved" });
  mirror("repairLegacy", { sessionID: "rl-path-diff", projectID: "newProj", legacyWorkspaceDirectory: "/legacy", workspaceID: "W-RL", workspacePath: "/resolved" });
  // Idempotency: rl-match is now workspace-bound and directory=/resolved → CAS fails → false.
  mirror("repairLegacy", { sessionID: "rl-match", projectID: "again", legacyWorkspaceDirectory: "/legacy", workspaceID: "W-RL2", workspacePath: "/again" });

  // --- repairRemoteSessionPaths: null-expectedPath arm, string-expectedPath arm, workspace miss, clock guard. ---
  mirror("repairPaths", { sessionID: "rp-null", workspaceID: "W", expectedDirectory: "/old", expectedPath: null, directory: "/new", path: null, timeUpdated: 500 });
  mirror("repairPaths", { sessionID: "rp-str", workspaceID: "W", expectedDirectory: "/old", expectedPath: "/old/rel", directory: "/new", path: "/new/rel", timeUpdated: 4 });
  // Stale timeUpdated (4) on rp-str: dir now /new so expectedDirectory=/old no longer matches → false.
  mirror("repairPaths", { sessionID: "rp-str", workspaceID: "W", expectedDirectory: "/old", expectedPath: "/new/rel", directory: "/x", path: null, timeUpdated: 9 });
  // string expectedPath vs a NULL column: no match.
  mirror("repairPaths", { sessionID: "rp-null", workspaceID: "W", expectedDirectory: "/new", expectedPath: "/ghost", directory: "/y", path: null, timeUpdated: 999 });
  // workspace CAS mismatch → false.
  mirror("repairPaths", { sessionID: "rp-ws-mismatch", workspaceID: "W", expectedDirectory: "/old", expectedPath: null, directory: "/z", path: null, timeUpdated: 7 });

  // --- Final whole-table dump byte-compare (also implicitly checked after every step above). ---
  const tableA = dumpTable(A);
  const tableB = dumpTable(B);
  const tableOk = tableA === tableB && failed === 0;

  if (tableOk) {
    console.log(
      "REPAIRS WRITE PARITY: OK — claimLegacySessionWorkspace/repairLegacyRemoteSessionWorkspace/repairRemoteSessionPaths identical across TS and Rust",
    );
    process.exit(0);
  }

  console.error("REPAIRS WRITE PARITY: DIFF");
  if (tableA !== tableB) {
    console.error(`  TS table: ${tableA}`);
    console.error(`  RS table: ${tableB}`);
  }
  process.exit(1);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
