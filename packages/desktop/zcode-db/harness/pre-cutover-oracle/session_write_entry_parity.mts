// TS-vs-Rust golden WRITE-parity harness for `saveSessionEntry` (guarded upsert with the
// `data = case ... json_set/json_extract` merge arm + inline `touchSession`).
//
// A uniquely-keyed parent `session` (FK target) is seeded IDENTICALLY into two bootstrapped DBs, then
// an identical entry-write sequence is applied through the REAL TS `saveSessionEntry` (DB A) and the
// Rust addon (DB B). The sequence exercises the tricky CASE: (1) a plain non-model-selection insert,
// (2) a model_selection insert (payload wrapped as `{modelSelection: ...}`), (3) a re-save of that
// model_selection id after injecting an EXTRA top-level key into the stored object, so the CASE must
// MERGE `$.modelSelection` via `json_set` (preserving the extra key) rather than overwrite, and (4) a
// re-save CHANGING the type, which makes the CASE fall through to `excluded.data`.
//
// `saveSessionEntry` carries its own `time` on the entry, so no clock is read; `Date.now` is still
// frozen (harmless) and the SAME `time` values are handed to both paths so the writes are identical.
// Only throwaway /tmp copies are touched — never the live `~/.zcode` DB. Run from the crate dir:
//   ../../../node_modules/.bin/tsx harness/session_write_entry_parity.mts
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

// Import the real TS write op by its repo-root path so its transitive workspace imports
// (`@zcode/contracts` via pnpm symlinks in the consumer package's node_modules) resolve. This mirrors
// the existing `session_write_todos_parity.mts` convention of a repo-root absolute TS import.
const { saveSessionEntry } = await import(
  pathToFileURL(
    "/media/hdd1/ZCode/apps/zcode-cli/packages/adapters/src/storage/session-store/repositories/session-entries.ts",
  ).href
);

const dir = mkdtempSync(join(tmpdir(), "zcode-entry-write-parity-"));
const A = join(dir, "ts.sqlite");
const B = join(dir, "rs.sqlite");

const SESSION = "sess-entry";
const MODEL_TYPE = "runtime/model_selection";
// Parent clock starts high so an early low `updated` exercises max() no-go-backwards.
const SEED_TIME_UPDATED = 5_000;

// Identical entries on both paths. `data` is a flat object so TS `JSON.stringify` and Rust
// `serde_json::to_string` of the parsed value produce byte-identical `data` strings.
const PLAIN = {
  id: "e1",
  sessionID: SESSION,
  type: "message",
  touchSession: false,
  time: { created: 1_000, updated: 2_000 },
  data: { kind: "plain", n: 1 },
};
const MODEL = {
  id: "m1",
  sessionID: SESSION,
  type: MODEL_TYPE,
  time: { created: 3_000, updated: 4_000 },
  data: { providerId: "p", modelId: "m" },
};
const MODEL_RES = {
  id: "m1",
  sessionID: SESSION,
  type: MODEL_TYPE,
  time: { created: 3_000, updated: 8_000 },
  data: { providerId: "q", modelId: "z" },
};
const TYPE_CHANGED = {
  id: "m1",
  sessionID: SESSION,
  type: "message",
  time: { created: 3_000, updated: 9_000 },
  data: { text: "plain-after-type-change" },
};

try {
  // Identical schema on both copies via the addon's own session-store bootstrap.
  addon.bootstrapSessionStoreJson(A, 5000, Date.now());
  addon.bootstrapSessionStoreJson(B, 5000, Date.now());

  // Seed the parent session (session_entry.session_id FK → session) IDENTICALLY on both; node:sqlite
  // enforces the FK, so the parent must exist before any entry write.
  for (const path of [A, B]) {
    const seed = new DatabaseSync(path);
    seed.exec("PRAGMA foreign_keys = ON");
    seed
      .prepare(
        `INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated)
         VALUES (?, 'p', 's', '/d', 't', 'v', ?, ?)`,
      )
      .run(SESSION, 1, SEED_TIME_UPDATED);
    seed.close();
  }

  // Inject an EXTRA top-level key into the stored model_selection object (identically on both) so the
  // step-3 CASE merge is observably different from a plain `excluded.data` overwrite.
  const injectExtraKey = (path) => {
    const db = new DatabaseSync(path);
    db.exec("PRAGMA foreign_keys = ON");
    db.prepare(
      `UPDATE session_entry SET data = '{"modelSelection":{"providerId":"p","modelId":"m"},"keep":"yes"}' WHERE id = ?`,
    )
      .run(MODEL.id);
    db.close();
  };

  // --- Apply the write sequence: TS on A (frozen clock), Rust addon on B (same entry payloads). ---
  const realNow = Date.now;
  Date.now = () => 1_700_000_000_000;
  const tsDb = new DatabaseSync(A);
  try {
    saveSessionEntry(tsDb, PLAIN); // (1) plain, touchSession:false (no session bump)
    saveSessionEntry(tsDb, MODEL); // (2) model_selection insert (wrapped)
    injectExtraKey(A); // seed the merge-preservation precondition
    saveSessionEntry(tsDb, MODEL_RES); // (3) re-save → CASE must MERGE $.modelSelection, keep extra
    saveSessionEntry(tsDb, TYPE_CHANGED); // (4) re-save changing type → CASE falls to excluded.data
  } finally {
    tsDb.close();
    Date.now = realNow;
  }

  addon.saveSessionEntryJson(B, JSON.stringify(PLAIN));
  addon.saveSessionEntryJson(B, JSON.stringify(MODEL));
  injectExtraKey(B);
  addon.saveSessionEntryJson(B, JSON.stringify(MODEL_RES));
  addon.saveSessionEntryJson(B, JSON.stringify(TYPE_CHANGED));

  // --- Read both final states back and compare ---
  const dump = (path) => {
    const ro = new DatabaseSync(path, { readOnly: true });
    const entries = ro
      .prepare("SELECT id, session_id, type, data FROM session_entry ORDER BY id")
      .all();
    const sessions = ro.prepare("SELECT id, time_updated FROM session ORDER BY id").all();
    ro.close();
    return JSON.stringify({ entries, sessions });
  };
  const a = dump(A);
  const b = dump(B);
  if (a === b) {
    console.log(
      "SESSION-ENTRY WRITE PARITY: OK — guarded upsert (CASE merge vs excluded.data) + touchSession identical across TS and Rust",
    );
  } else {
    console.error("SESSION-ENTRY WRITE PARITY: DIFF");
    console.error(`  TS: ${a}`);
    console.error(`  RS: ${b}`);
    process.exit(1);
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}
