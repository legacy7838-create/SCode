// TS-vs-Rust golden READ-parity harness for the DWF journal store's READ + introspection + artifact
// surface: `getRun`, `getActor`, `listActors`, `getNode`, `listNodes`, `listEvents`, plus the host
// introspection queries `listRuns`, `getRunRow`, `countNodesByStatus`, `listRecentLogEvents`,
// `listRunLifeSpans`, `listRunsByParentSession`, `listWorldNodes`, `listArtifactRows`,
// `listArtifactItems`, `listNonTerminalRuns`.
//
// BOTH databases are seeded by the RUST addon (the same write ops already proven byte-identical by
// `session_journal_parity`), so the read surface is exercised on two databases with IDENTICAL stored
// bytes — a pure read-only diff. Each method is then called through the REAL TS `createDwfJournalStore`
// over `node:sqlite` (reading A) and the Rust addon (reading B), and every returned projection is
// byte-compared. The narrow projections (`listRuns` items, session items, world rows) intentionally
// omit `result`/`failure`, and `listRuns` disambiguates logical `stopped`/`errored` from the physical
// `failed` column inside SQL (`json_extract`); those shapes are what this harness pins. Only throwaway
// /tmp copies are touched — never the live `~/.zcode` DB. Run from the crate dir:
//   /media/hdd1/ZCode/node_modules/.bin/tsx harness/session_journal_read_parity.mts
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const addon = require(join(here, "..", "zcode_db.node"));
const { DatabaseSync } = require("node:sqlite");

const REPO =
  "/media/hdd1/ZCode/apps/zcode-cli/packages/adapters/src/storage/session-store/repositories";
const { createDwfJournalStore } = await import(pathToFileURL(`${REPO}/dwf-journal.ts`).href);

const dir = mkdtempSync(join(tmpdir(), "zcode-journal-read-parity-"));
const A = join(dir, "ts.sqlite");
const B = join(dir, "rs.sqlite");

const FROZEN = 1_700_000_000_000;
let tick = 0;
const now = () => FROZEN + ++tick * 1000;

// The seed data: a handful of runs across the full logical-status vocabulary, actors, node kinds,
// and a rich event journal (two "lives" for run-1 so listRunLifeSpans reports more than one span).
const RUNS = [
  {
    // 1: running
    runId: "run-1",
    parentSessionId: "sess-a",
    cwd: "/proj/one",
    name: "build",
    scriptText: "return 1",
    scriptHash: "h1",
    toolCallId: "t1",
    args: { a: 1, b: { c: 2 } },
    resumedFrom: null,
    caps: { maxConcurrency: 4 },
    spentTokens: 42,
    status: "running",
  },
  {
    // 2: completed with a top-level result
    runId: "run-2",
    parentSessionId: "sess-a",
    cwd: "/proj/one",
    name: "ship",
    caps: { maxConcurrency: 1 },
    spentTokens: 100,
    status: "completed",
    result: { ok: true },
  },
  {
    // 3: errored (physical failed, non-Interrupted)
    runId: "run-3",
    parentSessionId: "sess-b",
    cwd: "/proj/two",
    name: "build",
    caps: { maxConcurrency: 2 },
    spentTokens: 0,
    status: "errored",
    failure: { code: "Boom", message: "kaboom" },
  },
  {
    // 4: stopped(user) (physical cancelled + envelope)
    runId: "run-4",
    parentSessionId: "sess-b",
    cwd: "/proj/two",
    caps: { maxConcurrency: 1 },
    spentTokens: 7,
    status: "stopped",
    stopReason: "user",
  },
  {
    // 5: stopped(interrupted) via errored+Interrupted (legacy orphan shape)
    runId: "run-5",
    parentSessionId: "sess-c",
    cwd: "/proj/three",
    caps: { maxConcurrency: 1 },
    spentTokens: 0,
    status: "errored",
    failure: { code: "Interrupted", message: "host died" },
  },
  {
    // 6: stopped(superseded) envelope with supersededBy + error
    runId: "run-6",
    parentSessionId: "sess-a",
    cwd: "/proj/one",
    caps: { maxConcurrency: 3 },
    spentTokens: 0,
    status: "stopped",
    stopReason: "superseded",
    supersededBy: "run-7",
    failure: { code: "ProviderStop", message: "stop" },
  },
];

const NODES = [
  // ask node (completed with result/stats)
  { runId: "run-1", siteId: "a", ordinal: 0, kind: "ask", actorSiteId: "a", actorOrdinal: 0, actorSeq: 1, inputHash: "ih0", status: "completed", result: { ans: "ok" }, stats: { tokens: 10 }, messageBoundary: 3 },
  // world-run (completed with exit/stdout/stderr → world list byte cols)
  { runId: "run-1", siteId: "w1", ordinal: 1, kind: "world-run", inputHash: "ih1", status: "completed", input: { op: "run", args: ["echo", "hi"] }, result: { exitCode: 0, stdout: "hi", stderr: "" } },
  // world-read (running, array result for result_count)
  { runId: "run-1", siteId: "w2", ordinal: 2, kind: "world-read", inputHash: "ih2", status: "completed", input: { op: "files.glob", args: ["**/*.ts"] }, result: ["a.ts", "b.ts"] },
  // report (tagged for `perf`)
  { runId: "run-1", siteId: "rp", ordinal: 3, kind: "report", inputHash: "ih3", status: "completed", artifactId: "perf", result: { finding: "x" } },
  // report (untagged)
  { runId: "run-1", siteId: "rp2", ordinal: 4, kind: "report", inputHash: "ih4", status: "completed", result: { finding: "y" } },
  // artifact node
  { runId: "run-1", siteId: "art", ordinal: 5, kind: "artifact", inputHash: "ih5", status: "completed", artifactId: "perf", result: { id: "perf", version: 1 } },
  // failed world-run (for countNodesByStatus failed bucket)
  { runId: "run-2", siteId: "fw", ordinal: 0, kind: "world-run", inputHash: "ih6", status: "failed", input: { op: "run", args: ["false"] }, error: { code: "WorldError", message: "nonzero" } },
];

const ACTORS = [
  { runId: "run-1", siteId: "a", ordinal: 0, name: "worker", persona: { name: "worker", systemPrompt: "p" }, sessionId: "as1", resolvedModel: "anthropic/m" },
  { runId: "run-1", siteId: "b", ordinal: 1 },
];

// events: two lives for run-1.
const EVENTS = [
  { runId: "run-1", type: "run-started", event: { type: "run-started", runId: "run-1", caps: { maxConcurrency: 4 } } },
  { runId: "run-1", type: "log", event: { type: "log", message: "l1" } },
  { runId: "run-1", type: "log", event: { type: "log", message: "l2" } },
  { runId: "run-1", type: "report", event: { type: "report", instance: { siteId: "rp", ordinal: 3 }, item: { v: 1 }, artifactId: "perf" } },
  { runId: "run-1", type: "report", event: { type: "report", instance: { siteId: "rp", ordinal: 3 }, item: { v: 2 } } },
  { runId: "run-1", type: "run-started", event: { type: "run-started", runId: "run-1", caps: { maxConcurrency: 4 } } },
  { runId: "run-1", type: "log", event: { type: "log", message: "l3" } },
  { runId: "run-1", type: "usage-updated", event: { type: "usage-updated", spentTokens: 42 } },
  { runId: "run-2", type: "run-started", event: { type: "run-started", runId: "run-2", caps: { maxConcurrency: 1 } } },
  { runId: "run-2", type: "log", event: { type: "log", message: "only" } },
];

const jsonStr = (v) => (v === undefined ? "null" : JSON.stringify(v));

try {
  addon.bootstrapSessionStoreJson(A, 5000, Date.now());
  addon.bootstrapSessionStoreJson(B, 5000, Date.now());

  // ---- Seed BOTH DBs through the (already-proven) Rust write path — identical stored bytes. ----
  tick = 0;
  for (const r of RUNS) addon.dwfCreateRunJson(A, JSON.stringify(r), now());
  tick = 0;
  for (const r of RUNS) addon.dwfCreateRunJson(B, JSON.stringify(r), now());

  tick = 0;
  for (const n of NODES) addon.dwfPutNodeJson(A, JSON.stringify(n), now());
  tick = 0;
  for (const n of NODES) addon.dwfPutNodeJson(B, JSON.stringify(n), now());

  tick = 0;
  for (const a of ACTORS) addon.dwfPutActorJson(A, JSON.stringify(a), now());
  tick = 0;
  for (const a of ACTORS) addon.dwfPutActorJson(B, JSON.stringify(a), now());

  tick = 0;
  for (const e of EVENTS) addon.dwfAppendEventJson(A, e.runId, JSON.stringify(e.event), now());
  tick = 0;
  for (const e of EVENTS) addon.dwfAppendEventJson(B, e.runId, JSON.stringify(e.event), now());

  // ------------------------------------------------------------------ TS reads (A) ----------
  const tsProj = [];
  const tsDb = new DatabaseSync(A);
  tsDb.exec("PRAGMA foreign_keys = ON");
  const store = createDwfJournalStore(tsDb);
  try {
    tsProj.push(["getRun(run-1)", jsonStr(store.getRun("run-1"))]);
    tsProj.push(["getRun(run-6)", jsonStr(store.getRun("run-6"))]);
    tsProj.push(["getRun(ghost)", jsonStr(store.getRun("ghost"))]);
    tsProj.push(["getActor(run-1,a,0)", jsonStr(store.getActor("run-1", "a", 0))]);
    tsProj.push(["getActor(run-1,b,1)", jsonStr(store.getActor("run-1", "b", 1))]);
    tsProj.push(["listActors(run-1)", jsonStr(store.listActors("run-1"))]);
    tsProj.push(["getNode(run-1,a,0)", jsonStr(store.getNode("run-1", "a", 0))]);
    tsProj.push(["getNode(run-1,w1,1)", jsonStr(store.getNode("run-1", "w1", 1))]);
    tsProj.push(["getNode(ghost)", jsonStr(store.getNode("run-1", "ghost", 0))]);
    tsProj.push(["listNodes(run-1)", jsonStr(store.listNodes("run-1"))]);
    tsProj.push(["listEvents(run-1)", jsonStr(store.listEvents("run-1"))]);
    tsProj.push(["listEvents:after3", jsonStr(store.listEvents("run-1", { afterSequence: 3 }))]);
    tsProj.push(["listEvents:limit2", jsonStr(store.listEvents("run-1", { limit: 2 }))]);

    // Introspection.
    tsProj.push(["listRuns:all", jsonStr(store.listRuns({ limit: 50 }))]);
    tsProj.push(["listRuns:cwd", jsonStr(store.listRuns({ cwd: "/proj/one", limit: 50 }))]);
    tsProj.push(["listRuns:status-running", jsonStr(store.listRuns({ limit: 50, statuses: ["running"] }))]);
    tsProj.push(["listRuns:status-stopped", jsonStr(store.listRuns({ limit: 50, statuses: ["stopped"] }))]);
    tsProj.push(["listRuns:status-errored", jsonStr(store.listRuns({ limit: 50, statuses: ["errored"] }))]);
    tsProj.push(["listRuns:status-completed", jsonStr(store.listRuns({ limit: 50, statuses: ["completed"] }))]);
    tsProj.push(["listRuns:name", jsonStr(store.listRuns({ limit: 50, name: "build" }))]);
    tsProj.push(["listRuns:emptyStatus", jsonStr(store.listRuns({ limit: 50, statuses: [] }))]);
    tsProj.push(["listRuns:zeroLimit", jsonStr(store.listRuns({ limit: 0 }))]);
    tsProj.push(["listRuns:limit1", jsonStr(store.listRuns({ limit: 1 }))]);
    tsProj.push(["getRunRow(run-1)", jsonStr(store.getRunRow("run-1"))]);
    tsProj.push(["getRunRow(ghost)", jsonStr(store.getRunRow("ghost"))]);
    tsProj.push(["countNodesByStatus(run-1)", jsonStr(store.countNodesByStatus("run-1"))]);
    tsProj.push(["listRecentLogEvents:2", jsonStr(store.listRecentLogEvents("run-1", 2))]);
    tsProj.push(["listRecentLogEvents:0", jsonStr(store.listRecentLogEvents("run-1", 0))]);
    tsProj.push(["listRunLifeSpans(run-1)", jsonStr(store.listRunLifeSpans("run-1"))]);
    tsProj.push(["listRunsByParentSession:a", jsonStr(store.listRunsByParentSession("sess-a", 50))]);
    tsProj.push(["listWorldNodes(run-1)", jsonStr(store.listWorldNodes("run-1"))]);
    tsProj.push(["listArtifactRows(run-1)", jsonStr(store.listArtifactRows("run-1"))]);
    tsProj.push(["listArtifactItems:perf", jsonStr(store.listArtifactItems("run-1", "perf", { limit: 50 }))]);
    tsProj.push(["listArtifactItems:after1", jsonStr(store.listArtifactItems("run-1", "perf", { afterSequence: 1, limit: 50 }))]);
    tsProj.push(["listNonTerminalRuns:sess-a", jsonStr(store.listNonTerminalRuns("sess-a"))]);
  } finally {
    tsDb.close();
  }

  // ---------------------------------------------------------------- Rust reads (B) ----------
  const rsProj = [];
  const push = (label, s) => rsProj.push([label, s]);
  push("getRun(run-1)", addon.dwfGetRunJson(B, "run-1"));
  push("getRun(run-6)", addon.dwfGetRunJson(B, "run-6"));
  push("getRun(ghost)", addon.dwfGetRunJson(B, "ghost"));
  push("getActor(run-1,a,0)", addon.dwfGetActorJson(B, "run-1", "a", 0));
  push("getActor(run-1,b,1)", addon.dwfGetActorJson(B, "run-1", "b", 1));
  push("listActors(run-1)", addon.dwfListActorsJson(B, "run-1"));
  push("getNode(run-1,a,0)", addon.dwfGetNodeJson(B, "run-1", "a", 0));
  push("getNode(run-1,w1,1)", addon.dwfGetNodeJson(B, "run-1", "w1", 1));
  push("getNode(ghost)", addon.dwfGetNodeJson(B, "run-1", "ghost", 0));
  push("listNodes(run-1)", addon.dwfListNodesJson(B, "run-1"));
  push("listEvents(run-1)", addon.dwfListEventsJson(B, "run-1", ""));
  push("listEvents:after3", addon.dwfListEventsJson(B, "run-1", JSON.stringify({ afterSequence: 3 })));
  push("listEvents:limit2", addon.dwfListEventsJson(B, "run-1", JSON.stringify({ limit: 2 })));
  push("listRuns:all", addon.dwfListRunsJson(B, JSON.stringify({ limit: 50 })));
  push("listRuns:cwd", addon.dwfListRunsJson(B, JSON.stringify({ cwd: "/proj/one", limit: 50 })));
  push("listRuns:status-running", addon.dwfListRunsJson(B, JSON.stringify({ limit: 50, statuses: ["running"] })));
  push("listRuns:status-stopped", addon.dwfListRunsJson(B, JSON.stringify({ limit: 50, statuses: ["stopped"] })));
  push("listRuns:status-errored", addon.dwfListRunsJson(B, JSON.stringify({ limit: 50, statuses: ["errored"] })));
  push("listRuns:status-completed", addon.dwfListRunsJson(B, JSON.stringify({ limit: 50, statuses: ["completed"] })));
  push("listRuns:name", addon.dwfListRunsJson(B, JSON.stringify({ limit: 50, name: "build" })));
  push("listRuns:emptyStatus", addon.dwfListRunsJson(B, JSON.stringify({ limit: 50, statuses: [] })));
  push("listRuns:zeroLimit", addon.dwfListRunsJson(B, JSON.stringify({ limit: 0 })));
  push("listRuns:limit1", addon.dwfListRunsJson(B, JSON.stringify({ limit: 1 })));
  push("getRunRow(run-1)", addon.dwfGetRunRowJson(B, "run-1"));
  push("getRunRow(ghost)", addon.dwfGetRunRowJson(B, "ghost"));
  push("countNodesByStatus(run-1)", addon.dwfCountNodesByStatusJson(B, "run-1"));
  push("listRecentLogEvents:2", addon.dwfListRecentLogEventsJson(B, "run-1", 2));
  push("listRecentLogEvents:0", addon.dwfListRecentLogEventsJson(B, "run-1", 0));
  push("listRunLifeSpans(run-1)", addon.dwfListRunLifeSpansJson(B, "run-1"));
  push("listRunsByParentSession:a", addon.dwfListRunsByParentSessionJson(B, "sess-a", 50));
  push("listWorldNodes(run-1)", addon.dwfListWorldNodesJson(B, "run-1"));
  push("listArtifactRows(run-1)", addon.dwfListArtifactRowsJson(B, "run-1"));
  push("listArtifactItems:perf", addon.dwfListArtifactItemsJson(B, "run-1", "perf", JSON.stringify({ limit: 50 })));
  push("listArtifactItems:after1", addon.dwfListArtifactItemsJson(B, "run-1", "perf", JSON.stringify({ afterSequence: 1, limit: 50 })));
  push("listNonTerminalRuns:sess-a", addon.dwfListNonTerminalRunsJson(B, "sess-a"));

  const tsStr = JSON.stringify(tsProj);
  const rsStr = JSON.stringify(rsProj);

  if (tsStr === rsStr) {
    console.log(
      "JOURNAL READ PARITY: OK — getRun/getActor/getNode/listActors/listNodes/listEvents, listRuns (cwd/status/name/limit guards, stopped-vs-errored SQL disambiguation), getRunRow, countNodesByStatus, listRecentLogEvents (ascending tail), listRunLifeSpans (per-life spans), listRunsByParentSession, listWorldNodes (no result body, byte counts), listArtifactRows/Items, listNonTerminalRuns identical across TS and Rust",
    );
  } else {
    console.error("JOURNAL READ PARITY: DIFF");
    for (let i = 0; i < Math.max(tsProj.length, rsProj.length); i++) {
      const a = JSON.stringify(tsProj[i] ?? null);
      const b = JSON.stringify(rsProj[i] ?? null);
      if (a !== b) {
        console.error("  proj diff @" + (tsProj[i]?.[0] ?? rsProj[i]?.[0]));
        console.error("    TS:", a);
        console.error("    RS:", b);
      }
    }
    process.exit(1);
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}
