// TS-vs-Rust golden WRITE-parity harness for `updateSession` / `setRevert` / `clearRevert`.
// A uniquely-keyed set of `session` rows is seeded IDENTICALLY into two bootstrapped DBs; the SAME
// sequence of partial-update writes is applied through the REAL TS repos (DB A) and the Rust addon
// (DB B). The TS `updateSession`/`setRevert`/`clearRevert` read `Date.now()` internally, so `Date.now`
// is frozen to a fixed epoch for the TS calls and that SAME value is passed as the addon's injected
// `now`, making both writes deterministic. The sequence exercises every TS branch: undefined-keeps-
// current, explicit replace, explicit-null clear, summary set/clear, the `expectedTitleSources`
// compare-and-set no-op and match, revert set/clear via the delegating helpers, and the guarded
// `time_updated = max(time_updated, ?)` that must never move the clock backwards. Finally the whole
// `session` table (`select * ... order by id`) AND every write's returned projection are read back
// from both DBs and deep-compared. Only throwaway /tmp copies are touched — never the live `~/.zcode`.
// Run from the crate dir:
//   /media/hdd1/ZCode/node_modules/.bin/tsx harness/session_write_session_update_parity.mts
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
// (`@zcode/contracts`, `../codecs.js`, `../json.js`) resolve, mirroring the todos write harness.
const sessionsRepo = "/media/hdd1/ZCode/apps/zcode-cli/packages/adapters/src/storage/session-store/repositories/sessions.ts";
const { updateSession, setRevert, clearRevert } = await import(pathToFileURL(sessionsRepo).href);

const dir = mkdtempSync(join(tmpdir(), "zcode-session-update-write-parity-"));
const A = join(dir, "ts.sqlite");
const B = join(dir, "rs.sqlite");

// Fixed clock: TS reads it via Date.now(); Rust receives it as the injected `now`.
const NOW = 1_700_000_000_000;
const SEED_TIME_UPDATED = 1_000; // < NOW, so the max() guard picks the newer clock.
const S1 = "sess-update-main";
const S2 = "sess-update-cas";

try {
  // Identical schema on both copies via the addon's own session-store bootstrap.
  addon.bootstrapSessionStoreJson(A, 5000, Date.now());
  addon.bootstrapSessionStoreJson(B, 5000, Date.now());

  // Seed both parent sessions IDENTICALLY. S1 has a pre-existing revert + permission so the
  // keep-current path re-encodes a real JSON column; S2 carries a `generated` title source to make the
  // compare-and-set no-op vs match distinguishable.
  for (const path of [A, B]) {
    const seed = new DatabaseSync(path);
    seed.exec("PRAGMA foreign_keys = ON");
    seed
      .prepare(
        `INSERT INTO session (id, project_id, slug, directory, title, version, title_source,
                              time_created, time_updated, revert, permission)
         VALUES (?, 'p', 's', '/orig', 'origTitle', 'v', 'first_input', ?, ?, ?, ?)`,
      )
      .run(S1, 1, SEED_TIME_UPDATED, '{"a":1,"b":2}', '{"read":"ask"}');
    seed
      .prepare(
        `INSERT INTO session (id, project_id, slug, directory, title, version, title_source,
                              time_created, time_updated)
         VALUES (?, 'p', 's', '/cas', 'casTitle', 'v', 'generated', ?, ?)`,
      )
      .run(S2, 1, SEED_TIME_UPDATED);
    seed.close();
  }

  // One shared operation list drives BOTH sides; each entry names which real function to call.
  const ops = [
    // undefined everywhere except an explicit newer clock → keeps every current field.
    { kind: "update", arg: { id: S1, timeUpdated: NOW + 10 } },
    // explicit replace of directory/title/share_url (nullish + strict present).
    { kind: "update", arg: { id: S1, directory: "/new", title: "newTitle", shareURL: "https://s" } },
    // set a full summary (additions/deletions/files/diffs).
    {
      kind: "update",
      arg: {
        id: S1,
        summary: { additions: 3, deletions: 1, files: 2, diffs: [{ file: "a.ts", additions: 1, deletions: 2 }] },
      },
    },
    // explicit null path → strict-undefined clear (NOT keep-current).
    { kind: "update", arg: { id: S1, path: "/tmp/rel", } },
    { kind: "update", arg: { id: S1, path: null } },
    // provide a new permission → replace; revert stays undefined → keep-current re-encode.
    { kind: "update", arg: { id: S1, permission: { read: "allow", write: "deny" } } },
    // CAS no-op: title offered but stored source (first_input) not in expectedTitleSources.
    { kind: "update", arg: { id: S1, title: "ignored", expectedTitleSources: ["generated"] } },
    // CAS match: stored source is allowed → write proceeds.
    { kind: "update", arg: { id: S1, title: "casKept", expectedTitleSources: ["first_input", "custom"] } },
    // S2 stored source is `generated` → a `generated`-expected CAS matches, `custom`-expected no-ops.
    { kind: "update", arg: { id: S2, title: "s2NoChange", expectedTitleSources: ["custom"] } },
    { kind: "update", arg: { id: S2, title: "s2Changed", expectedTitleSources: ["generated"] } },
    // setRevert delegates: revert + summary provided, title untouched.
    {
      kind: "setRevert",
      arg: {
        sessionID: S1,
        revert: { messageID: "m1", checkpoint: "c1" },
        summary: { additions: 9, deletions: 8, files: 7, diffs: [{ file: "x.ts" }] },
      },
    },
    // timeCompacting / timeArchived provided (strict present).
    { kind: "update", arg: { id: S1, timeCompacting: NOW + 5, timeArchived: NOW + 6 } },
    // stale clock must NOT regress the guarded max().
    { kind: "update", arg: { id: S1, timeUpdated: 42 } },
    // clearRevert delegates: revert → null, summary → null (all four columns cleared).
    { kind: "clearRevert", arg: { sessionID: S1 } },
  ];

  // --- Apply the writes: TS on A (frozen clock), Rust addon on B (same injected now). For `update`
  // ops (TS returns a SessionInfo) the returned projection is collected and compared too; `setRevert`
  // /`clearRevert` return void in TS, so only their DB effect (covered by the table dump) is checked. ---
  const realNow = Date.now;
  Date.now = () => NOW;

  const tsProjections = [];
  const rsProjections = [];
  const tsDb = new DatabaseSync(A);
  const rsDbPath = B;
  try {
    for (const op of ops) {
      if (op.kind === "update") {
        const ret = await updateSession(tsDb, op.arg);
        tsProjections.push(JSON.stringify(ret));
        rsProjections.push(addon.updateSessionJson(rsDbPath, JSON.stringify(op.arg), NOW));
      } else if (op.kind === "setRevert") {
        await setRevert(tsDb, op.arg);
        addon.setRevertJson(rsDbPath, JSON.stringify(op.arg), NOW);
      } else {
        await clearRevert(tsDb, op.arg.sessionID);
        addon.clearRevertJson(rsDbPath, op.arg.sessionID, NOW);
      }
    }
  } finally {
    tsDb.close();
    Date.now = realNow;
  }

  // --- Read both final states back and compare: full table dump + the write-returned projections. ---
  const dump = (path) => {
    const ro = new DatabaseSync(path, { readOnly: true });
    const rows = ro.prepare("SELECT * FROM session ORDER BY id").all();
    ro.close();
    return JSON.stringify(rows);
  };
  const tableA = dump(A);
  const tableB = dump(B);
  const projA = JSON.stringify(tsProjections);
  const projB = JSON.stringify(rsProjections);

  const tableOk = tableA === tableB;
  const projOk = projA === projB;

  if (tableOk && projOk) {
    console.log(
      "SESSION-UPDATE WRITE PARITY: OK — updateSession/setRevert/clearRevert identical across TS and Rust",
    );
    process.exit(0);
  }

  console.error("SESSION-UPDATE WRITE PARITY: DIFF");
  if (!tableOk) {
    console.error(`  TS table: ${tableA}`);
    console.error(`  RS table: ${tableB}`);
  }
  if (!projOk) {
    for (let i = 0; i < tsProjections.length; i += 1) {
      if (tsProjections[i] !== rsProjections[i]) {
        console.error(`  projection[${i}] TS: ${tsProjections[i]}`);
        console.error(`  projection[${i}] RS: ${rsProjections[i]}`);
      }
    }
  }
  process.exit(1);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
