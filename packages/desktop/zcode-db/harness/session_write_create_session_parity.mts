// TS-vs-Rust golden WRITE-parity harness for `createSession` (the single `insert into session ...
// on conflict(id) do update set ...` upsert with the seven literal-NULL columns, the `?? default`
// taskType/titleSource fallbacks, `encodeJson(permission)`, the truthy `input.titleSource ||
// input.titleMessageID` stamp of `time_title_updated`, the `?? ` time fallbacks that keep `0`, and
// the conflict arm's `coalesce` preservation of `trace_id`/`permission` and untouched `time_created`).
//
// Two throwaway /tmp session-store DBs (A = TS, B = Rust addon) are bootstrapped IDENTICALLY via
// `addon.bootstrapSessionStoreJson`. The REAL TS repository function is imported by repo-root
// absolute path (mirroring `session_write_history_parity.mts`); its clock is frozen via
// `Date.now = () => FROZEN` and the SAME FROZEN value is handed to the addon as `now`, so every
// `?? now` fallback is identical. `createSession` never mints ids (the caller provides `input.id`),
// so both sides receive the same literal ids and no id read-back is needed. `session` has no
// incoming FK requirements, so no parent rows must be seeded. After mirroring the whole script we
// dump `SELECT * FROM session ORDER BY id` from both DBs and JSON.stringify-byte-compare, plus
// returned-`SessionInfo` equality (byte-for-byte, including projection key order) per step.
// Only /tmp copies are touched — never the live `~/.zcode`.
//
// Run from the crate dir:
//   ../../../node_modules/.bin/tsx harness/session_write_create_session_parity.mts
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

// Import the real TS write op by its repo-root absolute path so its transitive workspace imports
// (`@zcode/contracts`, `../codecs.js`, `../json.js`) resolve via the consumer package's pnpm
// node_modules, mirroring `session_write_messages_parity.mts`.
const { createSession } = await import(
  pathToFileURL(
    "/media/hdd1/ZCode/apps/zcode-cli/packages/adapters/src/storage/session-store/repositories/sessions.ts",
  ).href
);

const dir = mkdtempSync(join(tmpdir(), "zcode-create-session-write-parity-"));
const A = join(dir, "ts.sqlite");
const B = join(dir, "rs.sqlite");

// Frozen clock; returned by Date.now() on the TS path and handed to the addon as `now`.
const FROZEN = 1_700_000_000_000;
let failed = 0;

// One mirrored step: apply the identical CreateSessionInput through the REAL TS function (DB A) and
// the Rust addon (DB B), then byte-compare the two returned SessionInfo projections.
function mirror(dbA, label, input) {
  const tsInfo = createSession(dbA, input);
  const rsStr = addon.createSessionJson(B, JSON.stringify(input), FROZEN);
  const tsStr = JSON.stringify(tsInfo);
  if (tsStr !== rsStr) {
    console.error(`CREATE-SESSION WRITE PARITY: FAIL — returned projection differs at step "${label}"`);
    console.error(`  TS: ${tsStr}`);
    console.error(`  RS: ${rsStr}`);
    failed = 1;
  }
}

try {
  // Identical schema on both copies via the addon's own session-store bootstrap.
  addon.bootstrapSessionStoreJson(A, 5000, Date.now());
  addon.bootstrapSessionStoreJson(B, 5000, Date.now());

  const realNow = Date.now;
  Date.now = () => FROZEN;
  const dbA = new DatabaseSync(A);
  dbA.exec("PRAGMA foreign_keys = ON");
  try {
    // (1) minimal input — only the six required fields: `?? default` taskType/titleSource, every
    // optional column NULL, both times = frozen now, time_title_updated NULL (falsy ||).
    mirror(dbA, "minimal", {
      id: "s_min",
      projectID: "p1",
      slug: "sl-min",
      directory: "/d/min",
      title: "Min",
      version: "1.0.0",
    });

    // (2) input with ALL optional fields set, explicit time.created/time.updated (must beat the
    // frozen clock), permission object with a deliberately non-alphabetical key order (the stored
    // JSON text must preserve it), and a truthy titleSource stamping time_title_updated.
    mirror(dbA, "full", {
      id: "s_full",
      projectID: "p2",
      workspaceID: "w-2",
      parentID: "s_min",
      traceID: "trace-2",
      taskType: "workflow_child",
      slug: "sl-full",
      directory: "/d/full",
      path: "/d/full/nested",
      title: "Full",
      titleSource: "generated",
      titleMessageID: "m-2",
      version: "2.0.0",
      shareURL: "https://share.example/x",
      permission: { zebra: [1, { inner: null }], alpha: "keep-order" },
      time: { created: FROZEN - 5, updated: FROZEN - 3 },
    });

    // (3) explicit nulls for EVERY nullable optional (null is nullish like undefined, so the row
    // matches the absent-fields case of step 1 with its own id) — binds SQL NULL on both sides.
    mirror(dbA, "explicit-nulls", {
      id: "s_null",
      projectID: "p3",
      workspaceID: null,
      parentID: null,
      traceID: null,
      taskType: null,
      slug: "sl-null",
      directory: "/d/null",
      path: null,
      title: "Nulls",
      titleSource: null,
      titleMessageID: null,
      version: "3.0.0",
      shareURL: null,
      permission: null,
      time: { created: 0, updated: null },
    });
    // `time.created: 0` must be KEPT (?? only falls back on null/undefined) and `time.updated: null`
    // must fall back to timeCreated (0), never to the frozen clock — asserted again by the dump.

    // (4) titleMessageID alone (titleSource absent): the column still defaults to 'first_input' but
    // the truthy `||` stamps time_title_updated = timeUpdated.
    mirror(dbA, "title-message-only", {
      id: "s_tmid",
      projectID: "p4",
      slug: "sl-tmid",
      directory: "/d/tmid",
      title: "Tm",
      version: "4",
      titleMessageID: "m-4",
    });

    // (5) re-create `s_full` (conflict arm): new title/version/directory, NO traceID and NO
    // permission in the fresh input — coalesce must keep the existing trace_id and permission,
    // time_created must survive (absent from the update set) and time_updated = excluded (0 wins:
    // `time: { created: 7, updated: 0 }` — an explicit 0 updated is kept, not re-fallbacked).
    mirror(dbA, "re-create-upsert-arm", {
      id: "s_full",
      projectID: "p2b",
      slug: "sl-full-v2",
      directory: "/d/full2",
      title: "Full Renamed",
      version: "2.0.1",
      taskType: "interactive",
      time: { created: 7, updated: 0 },
    });

    // (6) empty-string optionals that are NOT nullish: path '' is stored as '' (and the projection
    // keeps it via `?? undefined`), while the falsy titleSource '' must NOT stamp title_updated.
    mirror(dbA, "empty-string-fields", {
      id: "s_empty",
      projectID: "p5",
      workspaceID: "",
      path: "",
      slug: "sl-empty",
      directory: "/d/empty",
      title: "Empty",
      version: "5",
    });
  } finally {
    dbA.close();
    Date.now = realNow;
  }

  // --- Final deep comparison: full ordered dump of the whole table from both DBs. ---
  const dump = (path) => {
    const ro = new DatabaseSync(path, { readOnly: true });
    try {
      return JSON.stringify(ro.prepare("SELECT * FROM session ORDER BY id").all());
    } finally {
      ro.close();
    }
  };
  const a = dump(A);
  const b = dump(B);
  if (a !== b) {
    console.error("CREATE-SESSION WRITE PARITY: FAIL — session dump differs between TS and Rust");
    console.error(`  TS: ${a}`);
    console.error(`  RS: ${b}`);
    failed = 1;
  }

  if (!failed)
    console.log(
      "CREATE-SESSION WRITE PARITY: OK — insert/upsert defaults, ?? vs truthiness, encodeJson key order, explicit-null vs absent, time fallbacks and conflict-arm coalescing identical across TS and Rust",
    );
} finally {
  rmSync(dir, { recursive: true, force: true });
}
process.exit(failed);
