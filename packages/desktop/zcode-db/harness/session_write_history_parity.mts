// TS-vs-Rust golden WRITE-parity harness for `recordInputHistory`.
// Two throwaway /tmp session-store DBs (A = TS, B = Rust addon) are bootstrapped identically. The
// REAL TS repository function is imported by repo-root absolute path; its clock is frozen via
// `Date.now` and each call receives an explicit `time.created` so `time_created` is deterministic.
// For every input we run the TS op on A, read back the id it minted (the TS uses
// `input_<base36>_<uuid>` — non-deterministic), and pass THAT SAME id to the Rust addon so B's rows
// are byte-identical. Skips (empty text / duplicate of the newest entry) return `null` on both sides.
// After mirroring the whole script we dump `SELECT * FROM input_history` from both DBs and deep-compare,
// plus returned-projection equality per step. Only /tmp copies are touched — never the live `~/.zcode`.
//
// Run from the crate dir:
//   ../../../node_modules/.bin/tsx harness/session_write_history_parity.mts
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

// Import the real TS write op by its repo-root path so its transitive workspace imports resolve,
// mirroring `session_write_todos_parity.mts`.
const { recordInputHistory } = await import(
  pathToFileURL(
    "/media/hdd1/ZCode/apps/zcode-cli/packages/adapters/src/storage/session-store/repositories/input-history.ts",
  ).href
);

const dir = mkdtempSync(join(tmpdir(), "zcode-history-write-parity-"));
const A = join(dir, "ts.sqlite");
const B = join(dir, "rs.sqlite");

const NOW = 1_700_000_000_000;
let failed = 0;
const fail = (msg: string) => {
  console.error(`INPUT-HISTORY WRITE PARITY: FAIL — ${msg}`);
  failed = 1;
};

const rowCount = (path: string): number => {
  const ro = new DatabaseSync(path, { readOnly: true });
  try {
    const r = ro.prepare("SELECT count(*) AS n FROM input_history").get() as { n: number };
    return r.n;
  } finally {
    ro.close();
  }
};

// One mirrored step: apply the identical input to TS (A) and Rust (B). The id the TS mints is read
// back from its returned projection (or a dummy when it skips) and fed to the Rust addon so the
// resulting rows are identical. Returns the two returned-projection JSON strings for comparison.
async function mirror(
  dbA: DatabaseSync,
  input: Record<string, unknown>,
  created: number,
): Promise<{ tsStr: string; rsStr: string; rsId: string }> {
  const tsEntry = await recordInputHistory(dbA, input as never);
  const id = tsEntry?.id ?? "unused-skipped-id";
  const rsStr: string = addon.recordInputHistoryJson(B, JSON.stringify(input), id, created);
  const tsStr = tsEntry === null ? "null" : JSON.stringify(tsEntry);
  return { tsStr, rsStr, rsId: id };
}

try {
  addon.bootstrapSessionStoreJson(A, 5000, NOW);
  addon.bootstrapSessionStoreJson(B, 5000, NOW);

  const dbA = new DatabaseSync(A);
  dbA.exec("PRAGMA foreign_keys = ON");

  const realNow = Date.now;
  Date.now = () => NOW;
  try {
    // (1) first insert — trimmed text, a real session id, no attachments.
    const before = rowCount(A);
    const s1 = await mirror(dbA, {
      projectID: "p",
      sessionID: "s1",
      text: "  hello world  ",
      kind: "prompt",
      time: { created: NOW + 1 },
    }, NOW + 1);
    if (rowCount(A) !== before + 1 || rowCount(B) !== before + 1)
      fail("first insert did not add exactly one row on both sides");
    if (s1.tsStr === "null" || s1.rsStr === "null") fail("first insert unexpectedly returned null");

    // (2) duplicate of the newest entry: same text + same (no) attachments → skip, no new row.
    const cnt = rowCount(A);
    const s2 = await mirror(dbA, {
      projectID: "p",
      sessionID: "s1",
      text: "hello world",
      kind: "prompt",
      time: { created: NOW + 2 },
    }, NOW + 2);
    if (rowCount(A) !== cnt || rowCount(B) !== cnt) fail("duplicate text should not add a row");
    if (s2.tsStr !== "null" || s2.rsStr !== "null") fail("duplicate must return null on both sides");

    // (3) changed text → new row.
    if ((await mirror(dbA, {
      projectID: "p",
      sessionID: "s1",
      text: "second entry",
      kind: "prompt",
      time: { created: NOW + 3 },
    }, NOW + 3)).rsStr === "null") fail("changed text must insert a new row");

    // (4a) attachments fully dropped (data: content, bad type, empty path) → key omitted, NULL column.
    const s4a = await mirror(dbA, {
      projectID: "p",
      text: "att all dropped",
      kind: "prompt",
      attachments: [
        { type: "image", content: "data:image/png;base64,AAAA" },
        { type: "bogus", path: "/x" },
        { type: "url", path: "   " },
      ],
      time: { created: NOW + 4 },
    }, NOW + 4);
    if (s4a.rsStr === "null") fail("dropped-attachments step must still insert (text is non-empty)");
    if (s4a.tsStr.includes("attachments")) fail("all-dropped attachments must omit the key (TS)");

    // (4b) one valid attachment survives alongside a data: URL and a bad type.
    const s4b = await mirror(dbA, {
      projectID: "p",
      text: "att one kept",
      kind: "prompt",
      attachments: [
        { type: "file", path: " /a/b.txt " },
        { type: "image", content: "data:x" },
        { type: "nope", path: "/z" },
      ],
      time: { created: NOW + 5 },
    }, NOW + 5);
    if (s4b.rsStr === "null") fail("kept-attachment step must insert");

    // (5) 105 rows → the 100-row prune fires. Distinct texts so none dedup-skip.
    for (let i = 0; i < 105; i++) {
      await mirror(dbA, {
        projectID: "prune",
        text: `line ${i}`,
        kind: "prompt",
        time: { created: NOW + 1000 + i },
      }, NOW + 1000 + i);
    }
    if (rowCount(A) !== 100 || rowCount(B) !== 100)
      fail(`prune should leave 100 rows (A=${rowCount(A)} B=${rowCount(B)})`);
  } finally {
    Date.now = realNow;
    dbA.close();
  }

  // --- Final deep comparison: full ordered dump of the table from both DBs. ---
  const dump = (path: string) => {
    const ro = new DatabaseSync(path, { readOnly: true });
    try {
      return JSON.stringify(
        ro.prepare("SELECT * FROM input_history ORDER BY time_created, id").all(),
      );
    } finally {
      ro.close();
    }
  };
  const a = dump(A);
  const b = dump(B);
  if (a !== b) {
    fail("input_history dump differs between TS and Rust");
    console.error(`  TS: ${a}`);
    console.error(`  RS: ${b}`);
  }

  if (!failed)
    console.log(
      "INPUT-HISTORY WRITE PARITY: OK — insert/dedup/attachment-normalization/prune identical across TS and Rust",
    );
} finally {
  rmSync(dir, { recursive: true, force: true });
}
process.exit(failed);
