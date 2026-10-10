// TS-vs-Rust golden WRITE-parity harness for the script-workflow run/activity/event WRITE ops:
// `createScriptWorkflowRun`, `updateScriptWorkflowRun`, `createScriptWorkflowActivity`,
// `updateScriptWorkflowActivity`, `appendScriptWorkflowEvent`, and the read `findCachedScriptWorkflowActivity`.
//
// The same write sequence is applied through the REAL TS repository functions (DB A, via `node:sqlite`
// `DatabaseSync`) and the Rust addon (DB B). The TS reads `Date.now()` internally, so `Date.now` is
// frozen to a controlled epoch for every TS call and that SAME value is handed to the addon as the
// injected `now`, making both write paths deterministic (ids are caller-supplied, and the internally
// minted `attempt`/`sequence` are produced by the same max-probe SQL on both sides given the identical
// prior rows). FK parents (`session`, `workflow_definition`, the parent `workflow_run`) are seeded
// IDENTICALLY so the enforced FK/CHECK columns match. Both the whole-table dumps (`workflow_run` /
// `workflow_activity` / `workflow_event`, ordered by stable keys) AND the returned record projections
// are byte-compared. Only throwaway /tmp copies are touched — never the live `~/.zcode` DB.
// Run from the crate dir:
//   ../../../node_modules/.bin/tsx harness/session_write_workflow_run_parity.mts
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
// Import the real TS write ops by their repo-root absolute path so their transitive workspace imports
// (`@zcode/contracts` via pnpm symlinks) resolve, mirroring `session_write_workflow_def_parity.mts`.
const { createScriptWorkflowRun, updateScriptWorkflowRun } = await import(
  pathToFileURL(`${REPO}/script-workflow-runs.ts`).href
);
const {
  createScriptWorkflowActivity,
  updateScriptWorkflowActivity,
  appendScriptWorkflowEvent,
  findCachedScriptWorkflowActivity,
} = await import(pathToFileURL(`${REPO}/script-workflow-activities.ts`).href);

const dir = mkdtempSync(join(tmpdir(), "zcode-workflow-run-write-parity-"));
const A = join(dir, "ts.sqlite");
const B = join(dir, "rs.sqlite");

const SESSION = "sess-wf-a";
const DEFINITION = "wf-def-a";
const RUN = "run-1";
const FROZEN = 1_700_000_000_000;

// ---- Run inputs ----
const RUN_CREATE = {
  id: RUN,
  definitionId: DEFINITION,
  name: "build",
  parentSessionId: SESSION,
  cwd: "/work/dir",
  scriptPath: "/scripts/build.ts",
  scriptHash: "hash-1",
  args: { flag: true, count: 3, nested: { a: 1 } },
  argsHash: "args-hash",
  status: "running",
  budgetTotal: 1000,
  stats: { steps: 1, tokens: 42 },
};
// Partial patch: keep stats via re-encode, set failure + phase + timestamps.
const RUN_UPDATE = {
  id: RUN,
  status: "completed",
  currentPhase: "ship",
  budgetSpent: 250,
  failure: { kind: "timeout", detail: { ms: 5000 } },
  startedAt: 1_700_000_000_100,
  completedAt: 1_700_000_000_900,
};
// A minimal run (defaults + nullish optional columns).
const RUN_MINIMAL = {
  id: "run-min",
  name: "bare",
  cwd: "/bare",
  scriptHash: "h2",
};

// ---- Activity inputs ----
const ACT_CREATE = {
  id: "act-1",
  runId: RUN,
  parentActivityId: null,
  callIndex: 0,
  callPath: "build.compile",
  type: "step",
  phase: "compile",
  label: "compile step",
  inputHash: "ih-1",
  prompt: "do it",
  opts: { temperature: 0.2, tools: ["x"] },
  status: "running",
};
const ACT_UPDATE = {
  id: "act-1",
  status: "completed",
  childSessionId: SESSION,
  result: { ok: true, value: 7 },
  startedAt: 1_700_000_000_200,
  completedAt: 1_700_000_000_300,
};
// A second activity on a DIFFERENT run+callPath so the max(attempt) probe resets to 1 on both DBs; on
// the SAME run+callPath as another activity it must increment. `act-dup` shares ACT_CREATE's run+path.
const ACT_DUP = {
  id: "act-dup",
  runId: RUN,
  callIndex: 1,
  callPath: "build.compile",
  type: "step",
  inputHash: "ih-1",
};

// ---- Event inputs ----
const EVENT_1 = {
  id: "ev-1",
  runId: RUN,
  type: "log",
  phase: "compile",
  activityId: "act-1",
  payload: { level: "info", msg: "hello" },
};
const EVENT_2 = {
  id: "ev-2",
  runId: RUN,
  type: "metric",
  payload: { n: 1, arr: [1, 2, 3] },
};
// A minimal event (nullish phase / activityId / payload).
const EVENT_MIN = { id: "ev-3", runId: RUN, type: "tick" };

try {
  // Identical schema on both copies via the addon's own session-store bootstrap.
  addon.bootstrapSessionStoreJson(A, 5000, Date.now());
  addon.bootstrapSessionStoreJson(B, 5000, Date.now());

  // Seed the FK parents IDENTICALLY (the addon does not enforce FK on a plain DatabaseSync seed, but we
  // turn it ON and insert valid rows so the parent `session` / `workflow_definition` exist on both).
  for (const path of [A, B]) {
    const seed = new DatabaseSync(path);
    seed.exec("PRAGMA foreign_keys = ON");
    seed
      .prepare(
        `INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated)
         VALUES (?, 'p', 's', '/d', 't', 'v', 1, 5000)`,
      )
      .run(SESSION);
    seed.close();
  }
  // Seed the workflow_definition on both via the addon (same injected now), matching FK-independent but
  // realistic definition reference. `definition_id` has no FK, but seeding keeps the two DBs identical.
  const defSeed = {
    id: DEFINITION,
    name: "build",
    source: "user",
    scriptHash: "hash-1",
    meta: { kind: "build" },
  };
  addon.upsertScriptWorkflowDefinitionJson(A, JSON.stringify(defSeed), FROZEN);
  addon.upsertScriptWorkflowDefinitionJson(B, JSON.stringify(defSeed), FROZEN);

  // ---- Apply the write sequence: TS on A (frozen clock), Rust addon on B (same injected now). ----
  const realNow = Date.now;
  Date.now = () => FROZEN;
  const tsDb = new DatabaseSync(A);
  tsDb.exec("PRAGMA foreign_keys = ON");
  const tsProj = [];
  try {
    tsProj.push(await createScriptWorkflowRun(tsDb, RUN_CREATE));
    tsProj.push(await updateScriptWorkflowRun(tsDb, RUN_UPDATE));
    tsProj.push(await createScriptWorkflowRun(tsDb, RUN_MINIMAL));
    tsProj.push(await createScriptWorkflowActivity(tsDb, ACT_CREATE));
    tsProj.push(await updateScriptWorkflowActivity(tsDb, ACT_UPDATE));
    // Second activity on the SAME run+callPath: the attempt probe must return 2 (max(attempt=1)+1).
    tsProj.push(await createScriptWorkflowActivity(tsDb, ACT_DUP));
    tsProj.push(await appendScriptWorkflowEvent(tsDb, EVENT_1));
    tsProj.push(await appendScriptWorkflowEvent(tsDb, EVENT_2));
    tsProj.push(await appendScriptWorkflowEvent(tsDb, EVENT_MIN));
    // Cache lookup: act-1 is `completed` with (run-1, build.compile, ih-1) -> a hit.
    tsProj.push(
      await findCachedScriptWorkflowActivity(tsDb, {
        runId: RUN,
        callPath: "build.compile",
        inputHash: "ih-1",
      }),
    );
    // A miss: an input hash with no completed/cached match -> null.
    tsProj.push(
      await findCachedScriptWorkflowActivity(tsDb, {
        runId: RUN,
        callPath: "build.compile",
        inputHash: "nope",
      }),
    );
  } finally {
    tsDb.close();
    Date.now = realNow;
  }

  const rsProj = [];
  rsProj.push(JSON.parse(addon.createScriptWorkflowRunJson(B, JSON.stringify(RUN_CREATE), FROZEN)));
  rsProj.push(JSON.parse(addon.updateScriptWorkflowRunJson(B, JSON.stringify(RUN_UPDATE), FROZEN)));
  rsProj.push(JSON.parse(addon.createScriptWorkflowRunJson(B, JSON.stringify(RUN_MINIMAL), FROZEN)));
  rsProj.push(
    JSON.parse(addon.createScriptWorkflowActivityJson(B, JSON.stringify(ACT_CREATE), FROZEN)),
  );
  rsProj.push(
    JSON.parse(addon.updateScriptWorkflowActivityJson(B, JSON.stringify(ACT_UPDATE), FROZEN)),
  );
  rsProj.push(
    JSON.parse(addon.createScriptWorkflowActivityJson(B, JSON.stringify(ACT_DUP), FROZEN)),
  );
  rsProj.push(JSON.parse(addon.appendScriptWorkflowEventJson(B, JSON.stringify(EVENT_1), FROZEN)));
  rsProj.push(JSON.parse(addon.appendScriptWorkflowEventJson(B, JSON.stringify(EVENT_2), FROZEN)));
  rsProj.push(JSON.parse(addon.appendScriptWorkflowEventJson(B, JSON.stringify(EVENT_MIN), FROZEN)));
  rsProj.push(
    JSON.parse(
      addon.findCachedScriptWorkflowActivityJson(
        B,
        JSON.stringify({ runId: RUN, callPath: "build.compile", inputHash: "ih-1" }),
      ),
    ),
  );
  rsProj.push(
    JSON.parse(
      addon.findCachedScriptWorkflowActivityJson(
        B,
        JSON.stringify({ runId: RUN, callPath: "build.compile", inputHash: "nope" }),
      ),
    ),
  );

  // ---- Read both final states back and compare: the three tables AND the returned projections. ----
  const dump = (path) => {
    const ro = new DatabaseSync(path, { readOnly: true });
    const runs = ro.prepare("SELECT * FROM workflow_run ORDER BY id").all();
    const activities = ro.prepare("SELECT * FROM workflow_activity ORDER BY id").all();
    const events = ro.prepare("SELECT * FROM workflow_event ORDER BY id").all();
    ro.close();
    return JSON.stringify({ runs, activities, events });
  };
  const a = dump(A);
  const b = dump(B);
  const aProj = JSON.stringify(tsProj);
  const bProj = JSON.stringify(rsProj);

  if (a === b && aProj === bProj) {
    console.log(
      "WORKFLOW-RUN WRITE PARITY: OK — create/update run, create/update activity (attempt max+1), append event (sequence max+1), and cached-activity lookup identical across TS and Rust",
    );
  } else {
    console.error("WORKFLOW-RUN WRITE PARITY: DIFF");
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
