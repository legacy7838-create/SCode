// TS-vs-Rust golden WRITE-parity harness for `upsertScriptWorkflowDefinition` (single workflow_definition
// upsert + read-back projection). The same inputs are applied through the REAL TS repo (DB A) and the
// Rust addon (DB B). The TS reads `Date.now()` internally, so `Date.now` is frozen to a controlled epoch
// for the TS calls and that SAME value is passed as the addon's injected `now`, making both writes
// deterministic (the update branch must preserve `time_created` while bumping `time_updated`, so the two
// ops use two distinct frozen clocks). Then the whole `workflow_definition` table AND the returned
// projection are read back from both DBs and deep-compared. Only throwaway /tmp copies are touched —
// never the live `~/.zcode` DB.
// Run from the crate dir:
//   ../../../node_modules/.bin/tsx harness/session_write_workflow_def_parity.mts
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
const { upsertScriptWorkflowDefinition } = await import(
  pathToFileURL(
    "/media/hdd1/ZCode/apps/zcode-cli/packages/adapters/src/storage/session-store/repositories/script-workflow-runs.ts",
  ).href
);

const dir = mkdtempSync(join(tmpdir(), "zcode-workflow-def-write-parity-"));
const A = join(dir, "ts.sqlite");
const B = join(dir, "rs.sqlite");

// Two distinct frozen clocks so the update branch shows time_created preserved / time_updated bumped.
const T1 = 1_700_000_000_000;
const T2 = 1_700_000_005_000;

// 1) New definition, source builtin with NO scope (exercises builtin defaulting), explicit
//    trusted/enabled, a present scriptPath, and a nested meta object.
const defBuiltin = {
  id: "wf-build",
  name: "build",
  source: "builtin",
  trusted: true,
  enabled: false,
  scriptPath: "/scripts/build.ts",
  scriptHash: "hash-1",
  meta: { kind: "build", owner: "ci" },
};

// 2) Update the SAME id with changed fields: source now user, explicit scope, trusted absent (-> 0),
//    enabled absent (-> default 1), null scriptPath (-> omitted from projection), new meta.
const defUpdate = {
  id: "wf-build",
  name: "build-v2",
  source: "user",
  scope: "project",
  scriptHash: "hash-2",
  meta: { kind: "ship" },
};

try {
  // Identical schema on both copies via the addon's own session-store bootstrap (applies all migrations
  // incl. the workflow_definition table and the 0008 scope column).
  addon.bootstrapSessionStoreJson(A, 5000, Date.now());
  addon.bootstrapSessionStoreJson(B, 5000, Date.now());

  // --- Apply the writes: TS on A (frozen clock), Rust addon on B (same injected now). ---
  const realNow = Date.now;
  const tsProjections: unknown[] = [];
  const rsProjections: unknown[] = [];
  Date.now = () => T1;
  const tsDb = new DatabaseSync(A);
  try {
    tsProjections.push(await upsertScriptWorkflowDefinition(tsDb, defBuiltin));
    Date.now = () => T2;
    tsProjections.push(await upsertScriptWorkflowDefinition(tsDb, defUpdate));
  } finally {
    tsDb.close();
    Date.now = realNow;
  }
  rsProjections.push(
    JSON.parse(addon.upsertScriptWorkflowDefinitionJson(B, JSON.stringify(defBuiltin), T1)),
  );
  rsProjections.push(
    JSON.parse(addon.upsertScriptWorkflowDefinitionJson(B, JSON.stringify(defUpdate), T2)),
  );

  // --- Read both final states back and compare: full table AND the returned projections. ---
  const dump = (path: string) => {
    const ro = new DatabaseSync(path, { readOnly: true });
    const rows = ro.prepare("select * from workflow_definition order by id").all();
    ro.close();
    return JSON.stringify(rows);
  };
  const a = dump(A);
  const b = dump(B);
  // The projections must match key-for-key AND in serialized order (both use decodeDefinition order).
  const aProj = JSON.stringify(tsProjections);
  const bProj = JSON.stringify(rsProjections);

  if (a === b && aProj === bProj) {
    console.log(
      "WORKFLOW-DEF WRITE PARITY: OK — upsert + read-back projection identical across TS and Rust",
    );
  } else {
    console.error("WORKFLOW-DEF WRITE PARITY: DIFF");
    if (a !== b) {
      console.error("  table TS:", a);
      console.error("  table RS:", b);
    }
    if (aProj !== bProj) {
      console.error("  proj TS:", aProj);
      console.error("  proj RS:", bProj);
    }
    process.exit(1);
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}
