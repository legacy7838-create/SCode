// TS-vs-Rust golden WRITE-parity harness for the `session_task_link` + `permission-full-access` WRITE
// ops: `createSessionTaskLink` (script-workflow-activities.ts) and `commitPermissionFullAccess`
// (permission-full-access.ts).
//
// Two throwaway /tmp session-store DBs (A = TS, B = Rust addon) are bootstrapped identically via the
// addon's own `bootstrapSessionStoreJson`. The REAL TS repository functions are imported by their
// repo-root absolute paths so their transitive `@zcode/contracts` workspace imports resolve.
//
// Determinism:
//   - Every write id is fixed/caller-supplied, and the TS `Date.now()` is frozen to `FROZEN` — the SAME
//     value handed to the addon as the injected `now` — so `time_created`/`time_updated` match. (The
//     permission-commit loop's per-iteration `Date.now()` collapses to the one frozen value.)
//   - FK parents (sessions, the `workflow_run` + `workflow_activity` the task link points at, and the
//     `admitted` `session_input` rows the permission commit reads) are seeded IDENTICALLY on both DBs
//     via `node:sqlite`, with `PRAGMA foreign_keys = ON`, so the enforced FK/CHECK columns match.
//
// Scenarios exercised: task-link fresh insert + on-conflict(child_session_id) upsert (touches ONLY
// status/time_updated) + a link carrying a non-null parent_link_id; permission fresh commit (flips
// intent/conversationInputIntent to mode:"yolo" + writes both entries) + re-commit idempotency
// (short-circuits, no further change) + the mis-scoped throw (commit-session mismatch, before the txn)
// + the atomic-rollback case (missing pending input rolls the whole BEGIN IMMEDIATE back).
//
// Both the returned projections AND full-table dumps of `session_task_link` / `session_entry` /
// `session_input` are byte-compared. Only /tmp copies are touched — never the live `~/.zcode` DB.
//
// Run from the crate dir:
//   ../../../node_modules/.bin/tsx harness/session_write_link_permission_parity.mts
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

const REPO =
  "/media/hdd1/ZCode/apps/zcode-cli/packages/adapters/src/storage/session-store/repositories";
// Import the real TS write ops by their repo-root absolute paths so their transitive workspace imports
// resolve, mirroring `session_write_workflow_run_parity.mts`.
const { createSessionTaskLink } = await import(
  pathToFileURL(`${REPO}/script-workflow-activities.ts`).href
);
const { commitPermissionFullAccess } = await import(
  pathToFileURL(`${REPO}/permission-full-access.ts`).href
);

const dir = mkdtempSync(join(tmpdir(), "zcode-link-permission-write-parity-"));
const A = join(dir, "ts.sqlite");
const B = join(dir, "rs.sqlite");

const FROZEN = 1_700_000_000_000;
const LINK_CHILD = "linkchild";
const LINK_PARENT = "linkparent";
const LINK_CHILD2 = "linkchild2";
const RUN = "run-1";
const ACT = "act-1";
const PERM_SESSION = "perm-s";

// ---- Task-link inputs ----
// Fresh insert with every optional reference column populated (run/activity/parent session).
const LINK_CREATE = {
  id: "link-1",
  rootWorkflowRunId: RUN,
  parentLinkId: null,
  activityId: ACT,
  parentSessionId: LINK_PARENT,
  childSessionId: LINK_CHILD,
  role: "worker",
  depth: 2,
  path: "root/worker",
  phase: "build",
  label: "the worker",
  agentType: "explore",
  model: "opus",
  status: "running",
};
// Re-insert for the SAME child session: the on-conflict(child_session_id) arm must touch ONLY status +
// time_updated, so the different id/role/depth/path/label here are all ignored (already-stored row wins).
const LINK_RECOMMIT = {
  id: "link-DIFFERENT",
  childSessionId: LINK_CHILD,
  role: "changed",
  depth: 99,
  path: "changed/path",
  label: "changed",
  status: "completed",
};
// A second child carrying a NON-NULL parent_link_id (references link-1) so the FK + projection surface
// the present value, contrasted against the null case in LINK_CREATE.
const LINK_WITH_PARENT = {
  id: "link-2",
  parentLinkId: "link-1",
  childSessionId: LINK_CHILD2,
  parentSessionId: LINK_PARENT,
  role: "leaf",
  depth: 3,
  path: "root/worker/leaf",
  status: "running",
};

// ---- Permission-commit inputs ----
function permissionInput(queueItemIds, execId, rcptId, execSession = PERM_SESSION) {
  return {
    sessionID: PERM_SESSION,
    queueItemIds,
    execution: {
      id: execId,
      sessionID: execSession,
      type: "permission/execution",
      time: { created: FROZEN, updated: FROZEN },
      data: { granted: true },
    },
    receipt: {
      id: rcptId,
      sessionID: PERM_SESSION,
      type: "permission/receipt",
      time: { created: FROZEN, updated: FROZEN },
      data: { mode: "yolo" },
    },
  };
}
// Fresh commit flips BOTH `intent` (object) and `conversationInputIntent` (object) to mode:"yolo".
const PERM_FRESH = permissionInput(["q1", "q2"], "exec-1", "rcpt-1");
// Mis-scoped: the execution entry belongs to a different session → throw before the transaction.
const PERM_MIS_SCOPED = permissionInput(["q1"], "exec-mis", "rcpt-mis", "other-session");
// Atomic-rollback: q3 is not an admitted input → throw mid-loop and roll the whole txn back (no entry
// writes), under its own fresh exec/receipt ids so the existing-receipt short-circuit does not fire.
const PERM_ROLLBACK = permissionInput(["q1", "q3-missing"], "exec-rb", "rcpt-rb");

async function runTs(db) {
  const proj = [];
  const errors = [];
  proj.push(JSON.stringify(await createSessionTaskLink(db, LINK_CREATE)));
  proj.push(JSON.stringify(await createSessionTaskLink(db, LINK_RECOMMIT)));
  proj.push(JSON.stringify(await createSessionTaskLink(db, LINK_WITH_PARENT)));
  // Fresh commit: returns void → "null".
  await commitPermissionFullAccess(db, PERM_FRESH);
  proj.push("null");
  // Re-commit identical input: receipt already exists for this session → idempotent short-circuit.
  await commitPermissionFullAccess(db, PERM_FRESH);
  proj.push("null");
  // Mis-scoped commit: throws BEFORE the transaction; the message is part of the contract.
  try {
    await commitPermissionFullAccess(db, PERM_MIS_SCOPED);
    proj.push("NO-THROW");
  } catch (e) {
    errors.push(String(e.message ?? e));
    proj.push("THROW");
  }
  // Rollback commit: throws mid-transaction; the atomic write must leave no residue.
  try {
    await commitPermissionFullAccess(db, PERM_ROLLBACK);
    proj.push("NO-THROW");
  } catch (e) {
    errors.push(String(e.message ?? e));
    proj.push("THROW");
  }
  return { proj, errors };
}

function runRust() {
  const proj = [];
  const errors = [];
  proj.push(addon.createSessionTaskLinkJson(B, JSON.stringify(LINK_CREATE), FROZEN));
  proj.push(addon.createSessionTaskLinkJson(B, JSON.stringify(LINK_RECOMMIT), FROZEN));
  proj.push(addon.createSessionTaskLinkJson(B, JSON.stringify(LINK_WITH_PARENT), FROZEN));
  addon.commitPermissionFullAccessJson(B, JSON.stringify(PERM_FRESH), FROZEN);
  proj.push("null");
  addon.commitPermissionFullAccessJson(B, JSON.stringify(PERM_FRESH), FROZEN);
  proj.push("null");
  try {
    addon.commitPermissionFullAccessJson(B, JSON.stringify(PERM_MIS_SCOPED), FROZEN);
    proj.push("NO-THROW");
  } catch (e) {
    errors.push(String(e.message ?? e));
    proj.push("THROW");
  }
  try {
    addon.commitPermissionFullAccessJson(B, JSON.stringify(PERM_ROLLBACK), FROZEN);
    proj.push("NO-THROW");
  } catch (e) {
    errors.push(String(e.message ?? e));
    proj.push("THROW");
  }
  return { proj, errors };
}

try {
  addon.bootstrapSessionStoreJson(A, 5000, FROZEN);
  addon.bootstrapSessionStoreJson(B, 5000, FROZEN);

  // Seed the FK parents + admitted queue inputs IDENTICALLY on both DBs.
  for (const path of [A, B]) {
    const seed = new DatabaseSync(path);
    seed.exec("PRAGMA foreign_keys = ON");
    for (const id of [LINK_CHILD, LINK_PARENT, LINK_CHILD2, PERM_SESSION, "other-session"]) {
      seed
        .prepare(
          `INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated)
           VALUES (?, 'p', 'slug-' || ?, '/d', 't', 'v', 1, 5000)`,
        )
        .run(id, id);
    }
    seed
      .prepare(
        `INSERT INTO workflow_run (id, name, kind, status, cwd, script_hash, budget_spent, time_created, time_updated)
         VALUES (?, 'n', 'script', 'running', '/c', 'h', 0, 1, 1)`,
      )
      .run(RUN);
    seed
      .prepare(
        `INSERT INTO workflow_activity (id, run_id, call_index, call_path, attempt, type, input_hash, status, time_created, time_updated)
         VALUES (?, ?, 0, 'p', 1, 'step', 'h', 'queued', 1, 1)`,
      )
      .run(ACT, RUN);
    // Admitted queue inputs: q1 has a top-level `intent` object (existing keys preserved on the flip),
    // q2 has a `conversationInputIntent` object, plus an already-committed (promoted) q0 the commit
    // loop must NOT see (its `status='admitted'` filter).
    const inputs = [
      ["q1", '{"text":"a","intent":{"queuePosition":1,"foo":"bar"}}'],
      ["q2", '{"conversationInputIntent":{"steer":{"state":"x"}},"text":"b"}'],
    ];
    for (const [id, payload] of inputs) {
      seed
        .prepare(
          `INSERT INTO session_input (id, session_id, kind, delivery, payload, admitted_sequence, status, time_created, time_updated)
           VALUES (?, ?, 'user', 'queue', ?, 0, 'admitted', 1, 1)`,
        )
        .run(id, PERM_SESSION, payload);
    }
    seed.close();
  }

  // Apply the TS write sequence on A (frozen clock).
  const realNow = Date.now;
  Date.now = () => FROZEN;
  const tsDb = new DatabaseSync(A);
  tsDb.exec("PRAGMA foreign_keys = ON");
  let ts;
  try {
    ts = await runTs(tsDb);
  } finally {
    tsDb.close();
    Date.now = realNow;
  }

  // Apply the Rust write sequence on B (same injected now).
  const rs = runRust();

  // Final-state table dumps from both DBs (ordered by stable keys).
  const dump = (path) => {
    const ro = new DatabaseSync(path, { readOnly: true });
    try {
      const links = ro.prepare("SELECT * FROM session_task_link ORDER BY id").all();
      const entries = ro.prepare("SELECT * FROM session_entry ORDER BY id").all();
      const inputs = ro.prepare("SELECT * FROM session_input ORDER BY id").all();
      return JSON.stringify({ links, entries, inputs });
    } finally {
      ro.close();
    }
  };
  const aDump = dump(A);
  const bDump = dump(B);
  const aProj = JSON.stringify(ts.proj);
  const bProj = JSON.stringify(rs.proj);
  const aErr = JSON.stringify(ts.errors);
  const bErr = JSON.stringify(rs.errors);

  if (aDump === bDump && aProj === bProj && aErr === bErr) {
    console.log(
      "LINK-PERMISSION WRITE PARITY: OK — createSessionTaskLink (fresh/upsert-parent-scope/with parent_link_id) and commitPermissionFullAccess (fresh yolo-flip / idempotent re-commit / mis-scoped throw / atomic rollback) produce byte-identical session_task_link + session_entry + session_input rows and matching returned projections + error messages across TS and Rust",
    );
  } else {
    console.error("LINK-PERMISSION WRITE PARITY: DIFF");
    if (aProj !== bProj) {
      console.error("  proj TS:", aProj);
      console.error("  proj RS:", bProj);
    }
    if (aErr !== bErr) {
      console.error("  err  TS:", aErr);
      console.error("  err  RS:", bErr);
    }
    if (aDump !== bDump) {
      console.error("  table TS:", aDump);
      console.error("  table RS:", bDump);
    }
    process.exit(1);
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}
