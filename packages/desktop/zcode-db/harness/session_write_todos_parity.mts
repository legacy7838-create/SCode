// TS-vs-Rust golden WRITE-parity harness for `updateTodos` (todo list replacement + touchSession).
// A uniquely-keyed `session` + its `todo` rows are seeded IDENTICALLY into two bootstrapped DBs; the
// same list-replacement write is applied through the REAL TS repo (DB A) and the Rust addon (DB B).
// The TS `updateTodos` calls `Date.now()` internally, so `Date.now` is frozen to a fixed epoch for
// the TS calls and that SAME value is passed as the addon's injected `now`, making both writes
// deterministic. Then the whole `todo` table and the parent `session.time_updated` are read back from
// both DBs and deep-compared. Only throwaway /tmp copies are touched — never the live `~/.zcode` DB.
// Run from the crate dir:
//   ../../../node_modules/.bin/tsx harness/session_write_todos_parity.mts
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
// the existing `session_input_parity.mts` convention of a repo-root absolute TS import.
const { updateTodos } = await import(
  pathToFileURL(
    "/media/hdd1/ZCode/apps/zcode-cli/packages/adapters/src/storage/session-store/repositories/todos.ts",
  ).href
);

const dir = mkdtempSync(join(tmpdir(), "zcode-todos-write-parity-"));
const A = join(dir, "ts.sqlite");
const B = join(dir, "rs.sqlite");

// Fixed clock: TS reads it via Date.now(); Rust receives it as the injected `now`.
const NOW = 1_700_000_000_000;
const S1 = "sess-update"; // non-empty replacement target (seed time_updated < NOW → max picks NOW).
const S0 = "sess-empty"; // empty-list target (seed time_updated > NOW → max keeps the newer clock).

// The three incoming todos (TS TodoItem shape; `position` is the array index, not a payload field).
const todos = [
  { content: "alpha", status: "completed", priority: "low" },
  { content: "beta", status: "in_progress", priority: "high" },
  { content: "gamma", status: "pending", priority: "medium" },
];

try {
  // Identical schema on both copies via the addon's own session-store bootstrap.
  addon.bootstrapSessionStoreJson(A, 5000, Date.now());
  addon.bootstrapSessionStoreJson(B, 5000, Date.now());

  // Seed the parent sessions + a pre-existing (to-be-replaced/cleared) todo list, IDENTICALLY on both.
  for (const path of [A, B]) {
    const seed = new DatabaseSync(path);
    seed.exec("PRAGMA foreign_keys = ON");
    seed
      .prepare(
        `INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated)
         VALUES (?, 'p', 's', '/d', 't', 'v', ?, ?)`,
      )
      .run(S1, 1, 1_000); // 1000 < NOW
    seed
      .prepare(
        `INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated)
         VALUES (?, 'p', 's', '/d', 't', 'v', ?, ?)`,
      )
      .run(S0, 1, NOW + 5_000); // > NOW, to exercise the max() no-go-backwards branch
    const ins = seed.prepare(
      `INSERT INTO todo (session_id, content, status, priority, position, time_created, time_updated)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    ins.run(S1, "stale-old-0", "pending", "medium", 0, 5, 5);
    ins.run(S1, "stale-old-1", "completed", "high", 1, 6, 6);
    ins.run(S0, "stale-empty-0", "pending", "low", 0, 7, 7);
    seed.close();
  }

  // --- Apply the writes: TS on A (frozen clock), Rust addon on B (same injected now). ---
  const realNow = Date.now;
  Date.now = () => NOW;
  const tsDb = new DatabaseSync(A);
  try {
    await updateTodos(tsDb, { sessionID: S1, todos });
    await updateTodos(tsDb, { sessionID: S0, todos: [] });
  } finally {
    tsDb.close();
    Date.now = realNow;
  }
  addon.updateTodosJson(B, S1, JSON.stringify(todos), NOW);
  addon.updateTodosJson(B, S0, JSON.stringify([]), NOW);

  // --- Read both final states back and compare ---
  const dump = (path: string) => {
    const ro = new DatabaseSync(path, { readOnly: true });
    const todoRows = ro.prepare("SELECT * FROM todo ORDER BY session_id, position").all();
    const sessionRows = ro
      .prepare("SELECT id, time_updated FROM session ORDER BY id")
      .all();
    ro.close();
    return JSON.stringify({ todoRows, sessionRows });
  };
  const a = dump(A);
  const b = dump(B);
  if (a === b) {
    console.log(
      "TODOS WRITE PARITY: OK — todo-list replacement + touchSession identical across TS and Rust",
    );
  } else {
    console.error("TODOS WRITE PARITY: DIFF");
    console.error(`  TS: ${a}`);
    console.error(`  RS: ${b}`);
    process.exit(1);
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}
