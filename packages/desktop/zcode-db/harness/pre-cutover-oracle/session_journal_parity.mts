// TS-vs-Rust golden WRITE-parity harness for the DWF (dynamic-workflow) journal store's MUTATING
// ops: `createRun`, `updateRunStatus`, `updateRunUsage`, `updateRunCaps`, `putActor`, `putNode`,
// `appendEvent`, plus the read projections they feed (`getRun`/`getActor`/`listActors`/`getNode`/
// `listNodes`/`listEvents`).
//
// The same write sequence runs through the REAL TS `createDwfJournalStore` over `node:sqlite`
// `DatabaseSync` (DB A) and the Rust addon (DB B). The TS store calls `Date.now()` internally, so
// `Date.now` is frozen and advanced deterministically per write; the SAME value is handed to the
// addon as the injected `now`, making both write paths byte-identical (ids are caller-supplied; the
// per-run `sequence` is minted by the same `coalesce(max+1,0)` SQL on both sides given identical
// prior rows). FK enforcement (`dwf_actor/dwf_node/dwf_event -> dwf_run.id`) is ON for both. The
// special contracts are pinned: the three single-column updates touch ONLY their own column and
// THROW on an unknown run; `createRun` throws the duplicate-run contract error; `appendEvent` mints
// sequence 0,1,2… scoped per run. Both whole-table dumps (`dwf_run`/`dwf_node`/`dwf_event`, ordered
// by stable keys) AND every returned projection are byte-compared. Only throwaway /tmp copies are
// touched — never the live `~/.zcode` DB. Run from the crate dir:
//   /media/hdd1/ZCode/node_modules/.bin/tsx harness/session_journal_parity.mts
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
// Import the real TS journal store by its repo-root absolute path; its only runtime imports are
// `node:sqlite` and the relative `../json.js` (the `@zcode/dynamic-workflow` types are `import type`
// and erased at runtime), so tsx resolves it without any workspace value dependency.
const { createDwfJournalStore } = await import(pathToFileURL(`${REPO}/dwf-journal.ts`).href);

const dir = mkdtempSync(join(tmpdir(), "zcode-journal-write-parity-"));
const A = join(dir, "ts.sqlite");
const B = join(dir, "rs.sqlite");

const FROZEN = 1_700_000_000_000;
// Each write uses a DISTINCT injected clock tick so `order by time_updated` resolves the same way on
// both DBs regardless of the bundled SQLite version's tie-breaking. The B pass reuses these values.
let tick = 0;
const nextNow = () => FROZEN + ++tick * 1000;
const resetClock = () => {
  tick = 0;
};

// ---- Run records ----
const R1 = {
  runId: "run-1",
  parentSessionId: "sess-parent",
  cwd: "/work/dir",
  name: "build",
  scriptText: "// hello\nreturn 1",
  scriptHash: "hash-1",
  toolCallId: "tool-abc",
  args: { flag: true, count: 3, nested: { a: 1 } },
  resumedFrom: "run-0",
  caps: { maxConcurrency: 4 },
  spentTokens: 0,
  status: "running",
};
// createRun of a stopped run carries the settlement bag through the record itself.
const R2 = {
  runId: "run-2",
  parentSessionId: "sess-parent",
  cwd: "/work/dir",
  caps: { maxConcurrency: 2 },
  spentTokens: 10,
  status: "stopped",
  stopReason: "superseded",
  supersededBy: "run-9",
  failure: { code: "ProviderStop", message: "model side stop", detail: { x: 1 } },
};
// errored run.
const R3 = {
  runId: "run-3",
  caps: { maxConcurrency: 1 },
  spentTokens: 0,
  status: "errored",
  failure: { code: "Boom", message: "kaboom" },
};
// completed run with a top-level result.
const R4 = {
  runId: "run-4",
  caps: { maxConcurrency: 1 },
  spentTokens: 0,
  status: "completed",
  result: { ok: true, value: 7 },
};

// ---- Actor / node records ----
const ACTOR_FULL = {
  runId: "run-1",
  siteId: "a.site",
  ordinal: 0,
  name: "worker",
  persona: { name: "worker", systemPrompt: "do work" },
  sessionId: "sess-actor",
  resolvedModel: "anthropic/claude-x",
};
const ACTOR_UPDATE = {
  runId: "run-1",
  siteId: "a.site",
  ordinal: 0,
  name: "worker2",
  sessionId: "sess-actor2",
};
const NODE_RUNNING = {
  runId: "run-1",
  siteId: "n.ask",
  ordinal: 0,
  kind: "ask",
  actorSiteId: "a.site",
  actorOrdinal: 0,
  actorSeq: 5,
  inputHash: "ih-1",
  status: "running",
  artifactId: "art-1",
  messageBoundary: 0,
};
// Second write on the SAME node: full-row replace clears artifactId (contract pinned).
const NODE_SETTLED = {
  runId: "run-1",
  siteId: "n.ask",
  ordinal: 0,
  kind: "ask",
  actorSiteId: "a.site",
  actorOrdinal: 0,
  actorSeq: 5,
  inputHash: "ih-1",
  status: "completed",
  result: { answer: "done" },
  stats: { tokens: 100 },
};
// A node with result === null (encodeResultJson must store the string "null", not SQL NULL).
const NODE_NULL_RESULT = {
  runId: "run-1",
  siteId: "n.null",
  ordinal: 1,
  kind: "ask",
  inputHash: "ih-null",
  status: "completed",
  result: null,
};
// An errored node carrying a structured error.
const NODE_FAILED = {
  runId: "run-1",
  siteId: "n.fail",
  ordinal: 2,
  kind: "world-run",
  inputHash: "ih-2",
  status: "failed",
  error: { code: "WorldError", message: "boom" },
  input: { op: "run", args: ["ls"], truncated: true },
  result: { exitCode: 2, stdout: "out", stderr: "err" },
};
// A tagged report node feeding a preset artifact.
const NODE_REPORT = {
  runId: "run-1",
  siteId: "n.report",
  ordinal: 3,
  kind: "report",
  inputHash: "ih-3",
  status: "completed",
  artifactId: "perf",
  result: { finding: "x" },
};
// An artifact node.
const NODE_ARTIFACT = {
  runId: "run-1",
  siteId: "n.art",
  ordinal: 4,
  kind: "artifact",
  inputHash: "ih-4",
  status: "completed",
  artifactId: "perf",
  result: { id: "perf", kind: "board", version: 1 },
};
// A world-read node (no result body of size yet).
const NODE_WORLD_READ = {
  runId: "run-1",
  siteId: "n.wread",
  ordinal: 5,
  kind: "world-read",
  inputHash: "ih-5",
  status: "running",
  input: { op: "files.glob", args: ["**/*.ts"] },
};

// ---- Events (the payload is stored verbatim; `event_json == JSON.stringify(obj)`) ----
const EVENTS = [
  { type: "run-started", runId: "run-1", caps: { maxConcurrency: 4 } },
  { type: "run-launched", inputId: "input-1", toolCallId: "tool-abc", parentSessionId: "sess-parent" },
  { type: "log", message: "step 1" },
  { type: "node-queued", instance: { siteId: "n.ask", ordinal: 0 }, kind: "ask", actor: { siteId: "a.site", ordinal: 0 }, actorSeq: 5 },
  { type: "node-dispatched", instance: { siteId: "n.ask", ordinal: 0 } },
  { type: "node-settled", instance: { siteId: "n.ask", ordinal: 0 }, outcome: "ok" },
  { type: "usage-updated", spentTokens: 250 },
  { type: "report", instance: { siteId: "n.report", ordinal: 3 }, item: { v: 1 }, artifactId: "perf" },
  { type: "report", instance: { siteId: "n.report", ordinal: 3 }, item: { v: 2 } },
  { type: "run-settled", status: "completed" },
];

const jsonStr = (v) => (v === undefined ? "null" : JSON.stringify(v));
const capThrow = (fn) => {
  try {
    fn();
    return "<NO THROW>";
  } catch (e) {
    return e && e.message ? e.message : String(e);
  }
};

try {
  addon.bootstrapSessionStoreJson(A, 5000, Date.now());
  addon.bootstrapSessionStoreJson(B, 5000, Date.now());

  // ------------------------------------------------------------------ TS pass (DB A) ----------
  const realNow = Date.now;
  resetClock();
  const tsProj = [];
  let tsStore = null;
  const tsDb = new DatabaseSync(A);
  tsDb.exec("PRAGMA foreign_keys = ON");
  try {
    tsStore = createDwfJournalStore(tsDb);
    const setNow = () => {
      const n = nextNow();
      Date.now = () => n;
      return n;
    };

    // createRun × 4 (each advances the clock).
    setNow();
    tsStore.createRun(R1);
    setNow();
    tsStore.createRun(R2);
    setNow();
    tsStore.createRun(R3);
    setNow();
    tsStore.createRun(R4);

    // getRun projections.
    tsProj.push(["getRun(run-1)", jsonStr(tsStore.getRun("run-1"))]);
    tsProj.push(["getRun(run-2)", jsonStr(tsStore.getRun("run-2"))]);
    tsProj.push(["getRun(run-3)", jsonStr(tsStore.getRun("run-3"))]);
    tsProj.push(["getRun(run-4)", jsonStr(tsStore.getRun("run-4"))]);
    tsProj.push(["getRun(ghost)", jsonStr(tsStore.getRun("ghost"))]);

    // updateRunStatus → completed with result; then getRun.
    setNow();
    tsStore.updateRunStatus("run-1", "completed", { result: { a: 1 } });
    tsProj.push(["getRun(run-1:completed)", jsonStr(tsStore.getRun("run-1"))]);
    // updateRunStatus non-terminal clears failure/result (run-4 completed → running).
    setNow();
    tsStore.updateRunStatus("run-4", "running");
    tsProj.push(["getRun(run-4:resumed)", jsonStr(tsStore.getRun("run-4"))]);

    // updateRunUsage / updateRunCaps (single-column).
    setNow();
    tsStore.updateRunUsage("run-1", 500);
    setNow();
    tsStore.updateRunCaps("run-1", { maxConcurrency: 2 });
    tsProj.push(["getRun(run-1:usage+caps)", jsonStr(tsStore.getRun("run-1"))]);

    // putActor + getActor + listActors.
    setNow();
    tsStore.putActor(ACTOR_FULL);
    tsProj.push(["getActor(full)", jsonStr(tsStore.getActor("run-1", "a.site", 0))]);
    setNow();
    tsStore.putActor(ACTOR_UPDATE);
    tsProj.push(["getActor(updated)", jsonStr(tsStore.getActor("run-1", "a.site", 0))]);
    tsProj.push(["listActors", jsonStr(tsStore.listActors("run-1"))]);
    tsProj.push(["getActor(ghost)", jsonStr(tsStore.getActor("run-1", "nope", 9))]);

    // putNode × several + getNode + listNodes.
    for (const [label, rec] of [
      ["running", NODE_RUNNING],
      ["settled", NODE_SETTLED],
      ["null", NODE_NULL_RESULT],
      ["failed", NODE_FAILED],
      ["report", NODE_REPORT],
      ["artifact", NODE_ARTIFACT],
      ["wread", NODE_WORLD_READ],
    ]) {
      setNow();
      tsStore.putNode(rec);
    }
    tsProj.push(["getNode(running:ask)", jsonStr(tsStore.getNode("run-1", "n.ask", 0))]);
    tsProj.push(["getNode(null-result)", jsonStr(tsStore.getNode("run-1", "n.null", 1))]);
    tsProj.push(["getNode(failed:world)", jsonStr(tsStore.getNode("run-1", "n.fail", 2))]);
    tsProj.push(["getNode(ghost)", jsonStr(tsStore.getNode("run-1", "ghost", 0))]);
    tsProj.push(["listNodes", jsonStr(tsStore.listNodes("run-1"))]);

    // appendEvent × N + listEvents variants.
    for (const ev of EVENTS) {
      setNow();
      tsProj.push(["append:" + ev.type, jsonStr(tsStore.appendEvent("run-1", ev))]);
    }
    tsProj.push(["listEvents:all", jsonStr(tsStore.listEvents("run-1"))]);
    tsProj.push(["listEvents:after2", jsonStr(tsStore.listEvents("run-1", { afterSequence: 2 }))]);
    tsProj.push(["listEvents:limit3", jsonStr(tsStore.listEvents("run-1", { limit: 3 }))]);
    tsProj.push([
      "listEvents:after2+limit2",
      jsonStr(tsStore.listEvents("run-1", { afterSequence: 2, limit: 2 })),
    ]);
    // The race-window contract: unknown run and out-of-range cursor return [] (no throw).
    tsProj.push(["listEvents:oob", jsonStr(tsStore.listEvents("run-1", { afterSequence: 9999 }))]);
    tsProj.push(["listEvents:unknownRun", jsonStr(tsStore.listEvents("ghost"))]);

    // ---- throw contracts (captured, not stored) ----
    tsProj.push(["throw:usage-unknown", capThrow(() => tsStore.updateRunUsage("ghost", 1))]);
    tsProj.push(["throw:caps-unknown", capThrow(() => tsStore.updateRunCaps("ghost", { maxConcurrency: 1 }))]);
    tsProj.push(["throw:status-unknown", capThrow(() => tsStore.updateRunStatus("ghost", "completed"))]);
    tsProj.push(["throw:createRun-dup", capThrow(() => tsStore.createRun(R1))]);
  } finally {
    tsDb.close();
    Date.now = realNow;
  }

  // ---------------------------------------------------------------- Rust pass (DB B) --------
  resetClock();
  const next = () => nextNow();
  const rsProj = [];
  const rsAppend = (label, fn) => rsProj.push([label, fn()]);

  addon.dwfCreateRunJson(B, JSON.stringify(R1), next());
  addon.dwfCreateRunJson(B, JSON.stringify(R2), next());
  addon.dwfCreateRunJson(B, JSON.stringify(R3), next());
  addon.dwfCreateRunJson(B, JSON.stringify(R4), next());

  rsAppend("getRun(run-1)", () => addon.dwfGetRunJson(B, "run-1"));
  rsAppend("getRun(run-2)", () => addon.dwfGetRunJson(B, "run-2"));
  rsAppend("getRun(run-3)", () => addon.dwfGetRunJson(B, "run-3"));
  rsAppend("getRun(run-4)", () => addon.dwfGetRunJson(B, "run-4"));
  rsAppend("getRun(ghost)", () => addon.dwfGetRunJson(B, "ghost"));

  addon.dwfUpdateRunStatusJson(B, "run-1", "completed", JSON.stringify({ result: { a: 1 } }), next());
  rsAppend("getRun(run-1:completed)", () => addon.dwfGetRunJson(B, "run-1"));
  addon.dwfUpdateRunStatusJson(B, "run-4", "running", "", next());
  rsAppend("getRun(run-4:resumed)", () => addon.dwfGetRunJson(B, "run-4"));

  addon.dwfUpdateRunUsageJson(B, "run-1", 500, next());
  addon.dwfUpdateRunCapsJson(B, "run-1", JSON.stringify({ maxConcurrency: 2 }), next());
  rsAppend("getRun(run-1:usage+caps)", () => addon.dwfGetRunJson(B, "run-1"));

  addon.dwfPutActorJson(B, JSON.stringify(ACTOR_FULL), next());
  rsAppend("getActor(full)", () => addon.dwfGetActorJson(B, "run-1", "a.site", 0));
  addon.dwfPutActorJson(B, JSON.stringify(ACTOR_UPDATE), next());
  rsAppend("getActor(updated)", () => addon.dwfGetActorJson(B, "run-1", "a.site", 0));
  rsAppend("listActors", () => addon.dwfListActorsJson(B, "run-1"));
  rsAppend("getActor(ghost)", () => addon.dwfGetActorJson(B, "run-1", "nope", 9));

  for (const rec of [
    NODE_RUNNING,
    NODE_SETTLED,
    NODE_NULL_RESULT,
    NODE_FAILED,
    NODE_REPORT,
    NODE_ARTIFACT,
    NODE_WORLD_READ,
  ]) {
    addon.dwfPutNodeJson(B, JSON.stringify(rec), next());
  }
  rsAppend("getNode(running:ask)", () => addon.dwfGetNodeJson(B, "run-1", "n.ask", 0));
  rsAppend("getNode(null-result)", () => addon.dwfGetNodeJson(B, "run-1", "n.null", 1));
  rsAppend("getNode(failed:world)", () => addon.dwfGetNodeJson(B, "run-1", "n.fail", 2));
  rsAppend("getNode(ghost)", () => addon.dwfGetNodeJson(B, "run-1", "ghost", 0));
  rsAppend("listNodes", () => addon.dwfListNodesJson(B, "run-1"));

  for (const ev of EVENTS) {
    const label = "append:" + ev.type;
    const now = next();
    rsProj.push([label, addon.dwfAppendEventJson(B, "run-1", JSON.stringify(ev), now)]);
  }
  rsAppend("listEvents:all", () => addon.dwfListEventsJson(B, "run-1", ""));
  rsAppend("listEvents:after2", () => addon.dwfListEventsJson(B, "run-1", JSON.stringify({ afterSequence: 2 })));
  rsAppend("listEvents:limit3", () => addon.dwfListEventsJson(B, "run-1", JSON.stringify({ limit: 3 })));
  rsAppend("listEvents:after2+limit2", () =>
    addon.dwfListEventsJson(B, "run-1", JSON.stringify({ afterSequence: 2, limit: 2 })),
  );
  rsAppend("listEvents:oob", () => addon.dwfListEventsJson(B, "run-1", JSON.stringify({ afterSequence: 9999 })));
  rsAppend("listEvents:unknownRun", () => addon.dwfListEventsJson(B, "ghost", ""));

  rsAppend("throw:usage-unknown", () => capThrow(() => addon.dwfUpdateRunUsageJson(B, "ghost", 1, FROZEN)));
  rsAppend("throw:caps-unknown", () =>
    capThrow(() => addon.dwfUpdateRunCapsJson(B, "ghost", JSON.stringify({ maxConcurrency: 1 }), FROZEN)),
  );
  rsAppend("throw:status-unknown", () => capThrow(() => addon.dwfUpdateRunStatusJson(B, "ghost", "completed", "", FROZEN)));
  rsAppend("throw:createRun-dup", () => capThrow(() => addon.dwfCreateRunJson(B, JSON.stringify(R1), FROZEN)));

  // ---------------------------------------------------------------- compare -----------------
  const dump = (path) => {
    const ro = new DatabaseSync(path, { readOnly: true });
    const runs = ro.prepare("SELECT * FROM dwf_run ORDER BY id").all();
    const actors = ro.prepare("SELECT * FROM dwf_actor ORDER BY id").all();
    const nodes = ro.prepare("SELECT * FROM dwf_node ORDER BY id").all();
    const events = ro.prepare("SELECT * FROM dwf_event ORDER BY id").all();
    ro.close();
    return JSON.stringify({ runs, actors, nodes, events });
  };
  const dumpA = dump(A);
  const dumpB = dump(B);
  const tsStr = JSON.stringify(tsProj);
  const rsStr = JSON.stringify(rsProj);

  if (dumpA === dumpB && tsStr === rsStr) {
    console.log(
      "JOURNAL WRITE PARITY: OK — createRun (logical→physical status), updateRunStatus (non-terminal clears / terminal coalesce), single-column updateRunUsage/updateRunCaps, appendEvent (sequence coalesce(max+1,0) scoped per run), putActor/putNode upsert full-replace, throw-on-unknown-run, and get/list projections identical across TS and Rust",
    );
  } else {
    console.error("JOURNAL WRITE PARITY: DIFF");
    if (dumpA !== dumpB) {
      console.error("  dump TS:", dumpA);
      console.error("  dump RS:", dumpB);
    }
    if (tsStr !== rsStr) {
      for (let i = 0; i < Math.max(tsProj.length, rsProj.length); i++) {
        const a = JSON.stringify(tsProj[i] ?? null);
        const b = JSON.stringify(rsProj[i] ?? null);
        if (a !== b) {
          console.error("  proj diff @" + (tsProj[i]?.[0] ?? rsProj[i]?.[0]));
          console.error("    TS:", a);
          console.error("    RS:", b);
        }
      }
    }
    process.exit(1);
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}
