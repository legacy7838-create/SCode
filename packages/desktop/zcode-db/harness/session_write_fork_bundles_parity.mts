// TS-vs-Rust golden WRITE-parity harness for the fork COMPOSITE bundle writes:
// `createForkedSessionWithMetadata` + `commitForkBundle` (the ATOMIC transcript-copy paths that wrap
// child session + messages + parts + entries + input + parent command fact in ONE `begin immediate`).
//
// Two throwaway /tmp session-store DBs (A = TS composite, B = Rust addon composite) are bootstrapped
// identically via the addon's OWN Rust session-store bootstrap (so both reach the same schema), seeded
// with the SAME parent `session`, then the REAL TS facade methods (bound onto a fake `this` carrying a
// `node:sqlite` DatabaseSync over A) run on A and the Rust `#[napi]` composite wrappers run on B with
// the SAME bundle/input/metadata objects. `Date.now` is frozen to FROZEN and the SAME value is handed
// to the addon as `now`, so every internal `Date.now()` (createSession fallback, message/part times,
// the command-fact `now`, clone-target `touch`) is identical across both paths.
//
// The composite writes child + messages + parts (with `copyFrom` sources) + entries + initialInput +
// cloned goal target + the final `v4/command_fact`. We cover: the happy full bundle, the idempotent
// re-commit (existing command fact → returns the existing child, no double writes), and — critically —
// the ATOMIC ROLLBACK: a second DB pair (C = TS, D = Rust) runs a bundle that fails MID-transaction
// (a part whose `copyFrom` source row is absent throws after earlier writes). Both sides must leave NO
// partial rows (child + messages + parts + entries + input absent).
//
// The TS fault hooks (`maybeThrowForkCommitFault`) are TEST-ONLY and cannot cross the addon JSON
// boundary; the harness reproduces "a mid-step failure rolls everything back" with a genuine failing
// step instead. Only /tmp copies are touched — never the live `~/.zcode`.
//
// Run from the crate dir:
//   /media/hdd1/ZCode/node_modules/.bin/tsx harness/session_write_fork_bundles_parity.mts
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

// Import the REAL TS facade so we exercise the true composite orchestration (transaction boundaries,
// guards, copySources, goal→clone-target, command-fact), not a re-implementation. Absolute repo-root
// path mirrors how the sibling write harnesses load the repo functions.
const STORE_PATH =
  "/media/hdd1/ZCode/apps/zcode-cli/packages/adapters/src/storage/session-store/sqlite-session-store.ts";
const { SqliteSessionStore } = await import(pathToFileURL(STORE_PATH).href);

const dir = mkdtempSync(join(tmpdir(), "zcode-fork-bundles-parity-"));
const A = join(dir, "ts.sqlite");
const B = join(dir, "rs.sqlite");
const C = join(dir, "ts-rollback.sqlite");
const D = join(dir, "rs-rollback.sqlite");

const PARENT = "PARENT";
// Frozen clock; handed to the addon as `now` and returned by Date.now() on the TS path.
const FROZEN = 1_700_000_000_000;

// Build the REAL TS composite against a node:sqlite DatabaseSync over `path`, WITHOUT running the
// facade's TS migration bootstrap (both DBs were bootstrapped identically via the addon). We bind the
// prototype methods onto an object carrying only the fields the composites read (`db`, `dbPath`,
// `forkCommitFaultAt`), so the genuine transaction/guard/copy logic executes over the pre-bootstrapped
// A/C schema. `forkCommitFaultAt` is undefined → the test-only fault hooks never fire.
function makeTsStore(path) {
  const store = Object.create(SqliteSessionStore.prototype);
  const db = new DatabaseSync(path);
  db.exec("PRAGMA foreign_keys = ON");
  store.db = db;
  store.dbPath = path;
  store.forkCommitFaultAt = undefined;
  return {
    store,
    close: () => db.close(),
  };
}

// A single child `CreateSessionInput` for the createForked path.
const CHILD_INPUT = {
  id: "CHILD1",
  projectID: "p",
  slug: "child1-slug",
  directory: "/d",
  path: "/d",
  title: "child one",
  version: "v",
  parentID: PARENT,
  time: { created: 1000, updated: 1000 },
};
const CREATE_METADATA = {
  parentSessionId: PARENT,
  sourceCommandId: "cmd-create",
  forkTarget: {
    productTurnId: "pt1",
    transcriptTurnId: "tt1",
    orderedMessageIds: ["bm1"],
    boundaryMessageId: "bm1",
  },
};

// A COMPLETE commit bundle: child + user msg (+ text part + a timeline part with a copyFrom source
// seeded below) + verifier entry + initialInput + a cloned goal + the parent command fact.
function makeFullBundle(childId, cmd) {
  return {
    child: {
      id: childId,
      projectID: "p",
      slug: `${childId}-slug`,
      directory: "/d",
      path: "/d",
      title: "child",
      version: "v",
      parentID: PARENT,
      time: { created: 1000, updated: 1000 },
    },
    messages: [
      {
        info: {
          id: "m1",
          sessionID: childId,
          role: "user",
          time: { created: 1001 },
          agent: "main",
          modelSelection: { providerId: "p", modelId: "q", options: { reasoningLevel: "high" } },
        },
        parts: [
          {
            id: "p1",
            sessionID: childId,
            messageID: "m1",
            type: "text",
            text: "hello",
            time: { start: 1002 },
          },
        ],
      },
      {
        info: {
          id: "m2",
          sessionID: childId,
          role: "assistant",
          parentID: "m1",
          time: { created: 1003, completed: 1004 },
          cost: 0,
        },
        parts: [
          {
            id: "p2",
            sessionID: childId,
            messageID: "m2",
            type: "text",
            text: "reply",
            time: { start: 1005 },
          },
          {
            id: "p3",
            sessionID: childId,
            messageID: "m2",
            type: "timeline",
            timelineType: "model_change",
            anchorMessageId: "m1",
            fromModel: { providerId: "a", modelId: "b" },
            toModel: { providerId: "c", modelId: "d", options: { reasoningLevel: "low" }, label: "L" },
          },
        ],
      },
    ],
    entries: [
      {
        id: `${childId}-ventry`,
        sessionID: childId,
        type: "goal/verifier",
        time: { created: 1006, updated: 1006 },
        data: { payload: { anchorAssistantMessageId: "m2", targetId: "tgt-clone" } },
      },
    ],
    goal: {
      source: {
        sessionID: childId,
        targetID: "tgt-clone",
        objective: "goal objective",
        summaryTitle: "sum",
        status: "active",
        tokenBudget: 500,
        tokensUsed: 120,
        timeUsedSeconds: 42,
        time: { created: 900, updated: 950 },
      },
      status: "paused",
    },
    initialInput: {
      id: `${childId}-in1`,
      sessionID: childId,
      kind: "text",
      delivery: "startNow",
      payload: { text: "kick it off", extra: { a: 1 } },
    },
    commandFact: {
      parentSessionId: PARENT,
      sourceCommandId: cmd,
      ack: {
        commandId: cmd,
        status: "accepted",
        revisionAtDecision: 0,
        result: { type: "forkAssistant", sessionId: childId },
      },
      metadata: {
        parentSessionId: PARENT,
        sourceCommandId: cmd,
        forkTarget: { productTurnId: "pt1", transcriptTurnId: "tt1", orderedMessageIds: ["m2"], boundaryMessageId: "m2" },
      },
    },
  };
}

// A bundle engineered to FAIL mid-transaction: the timeline part p2 carries a copyFrom source that
// does not exist, so `savePart` throws `Storage copy source missing` AFTER the child session and the
// earlier message/parts were already written. The whole bundle must roll back.
function makeFailingBundle(childId, cmd) {
  const bundle = makeFullBundle(childId, cmd);
  bundle.copySources = { messages: {}, parts: { p2: "GHOST_SOURCE_PART" } };
  return bundle;
}

const TABLES = [
  ["session", "id"],
  ["message", "id"],
  ["part", "id"],
  ["session_entry", "id"],
  ["session_input", "id"],
  ["session_target", "session_id"],
];

function bootstrapAndSeed(path) {
  addon.bootstrapSessionStoreJson(path, 5000, FROZEN);
  const seed = new DatabaseSync(path);
  seed.exec("PRAGMA foreign_keys = ON");
  seed
    .prepare(
      `INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated)
       VALUES (?, 'p', 'pslug', '/p', 'parent', 'v', 1000, 1000)`,
    )
    .run(PARENT);
  // Seed a legacy-carrying parent message + part as the copyFrom SOURCE rows (distinct ids so the
  // bundle's own rows don't collide with them). Only the happy-path DBs need this.
  seed
    .prepare(
      `INSERT INTO message (id, session_id, time_created, time_updated, data, sequence)
       VALUES ('src_m2', ?, 1, 1, '{"providerID":"LEGACY_P","modelID":"LEGACY_M"}', 0)`,
    )
    .run(PARENT);
  seed
    .prepare(
      `INSERT INTO part (id, message_id, session_id, time_created, time_updated, data, sequence)
       VALUES ('src_p2', 'src_m2', ?, 1, 1, '{"toModel":{"providerID":"LP","modelID":"LM","label":"OLD"}}', 0)`,
    )
    .run(PARENT);
  seed.close();
}

// Full multi-table dump, each table ordered by a stable key so the byte-compare is order-independent.
function dump(path) {
  const ro = new DatabaseSync(path, { readOnly: true });
  const out = {};
  for (const [table, key] of TABLES) {
    out[table] = ro.prepare(`SELECT * FROM ${table} ORDER BY ${key}`).all();
  }
  ro.close();
  return JSON.stringify(out);
}

// Canonical (key-sorted) stringify retained only as a diagnostic fallback; the authoritative check is
// the RAW byte-for-byte comparison of the returned `SessionInfo` (the addon read-back projection is
// fixed-order and must match the TS return character-for-character).
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    const o = {};
    for (const k of Object.keys(value).sort()) o[k] = canonical(value[k]);
    return o;
  }
  return value;
}

let failed = 0;
const fail = (msg) => {
  console.error(`FORK BUNDLES PARITY: FAIL — ${msg}`);
  failed = 1;
};

function checkReturn(label, tsRet, rsJson) {
  const tsJson = JSON.stringify(tsRet);
  if (tsJson !== rsJson) {
    // A raw mismatch that only the sorted-key form resolves means a pure key-ORDER divergence; surface
    // which so it is not mistaken for a value difference.
    const orderOnly = JSON.stringify(canonical(tsRet)) === JSON.stringify(canonical(JSON.parse(rsJson)));
    fail(`${label} returned SessionInfo diverged${orderOnly ? " (key order only)" : ""}:\n  TS=${tsJson}\n  RS=${rsJson}`);
  }
}

try {
  // ---- HAPPY PATH + IDEMPOTENCY on A (TS) / B (Rust) ----
  bootstrapAndSeed(A);
  bootstrapAndSeed(B);

  const realNow = Date.now;
  Date.now = () => FROZEN;
  try {
    // TS composite on A.
    const tsA = makeTsStore(A);
    const tsChild = await tsA.store.createForkedSessionWithMetadata(CHILD_INPUT, CREATE_METADATA);
    // Idempotent re-run: the existing command fact short-circuits to the existing child.
    const tsChildAgain = await tsA.store.createForkedSessionWithMetadata(CHILD_INPUT, CREATE_METADATA);
    const bundle = makeFullBundle("CHILD2", "cmd-commit");
    // Give the timeline part p2 a real copyFrom source (the seeded parent src_p2 row).
    bundle.copySources = { messages: {}, parts: { p2: "src_p2" } };
    const tsBundleChild = await tsA.store.commitForkBundle(bundle);
    const tsBundleAgain = await tsA.store.commitForkBundle(bundle);
    tsA.close();

    // Rust composite on B (same ids, same frozen now).
    const rsChild = addon.createForkedSessionWithMetadataJson(B, JSON.stringify(CHILD_INPUT), JSON.stringify(CREATE_METADATA), FROZEN);
    const rsChildAgain = addon.createForkedSessionWithMetadataJson(B, JSON.stringify(CHILD_INPUT), JSON.stringify(CREATE_METADATA), FROZEN);
    const bundleJson = JSON.stringify(bundle);
    const rsBundleChild = addon.commitForkBundleJson(B, bundleJson, FROZEN);
    const rsBundleAgain = addon.commitForkBundleJson(B, bundleJson, FROZEN);

    checkReturn("createForkedSessionWithMetadata", tsChild, rsChild);
    checkReturn("createForkedSessionWithMetadata(idempotent)", tsChildAgain, rsChildAgain);
    checkReturn("commitForkBundle", tsBundleChild, rsBundleChild);
    checkReturn("commitForkBundle(idempotent)", tsBundleAgain, rsBundleAgain);

    const dumpA = dump(A);
    const dumpB = dump(B);
    if (dumpA !== dumpB) {
      fail("happy-path + idempotent final DB state diverged");
      console.error(`  TS: ${dumpA}`);
      console.error(`  RS: ${dumpB}`);
    }
  } finally {
    Date.now = realNow;
  }

  // ---- ATOMIC ROLLBACK on C (TS) / D (Rust): a failing bundle must leave NO partial rows ----
  const C_PARENT = PARENT;
  addon.bootstrapSessionStoreJson(C, 5000, FROZEN);
  addon.bootstrapSessionStoreJson(D, 5000, FROZEN);
  // Fresh parent only — no prior child/message/part; a full rollback returns to this pristine state.
  for (const path of [C, D]) {
    const seed = new DatabaseSync(path);
    seed.exec("PRAGMA foreign_keys = ON");
    seed
      .prepare(
        `INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated)
         VALUES (?, 'p', 'pslug', '/p', 'parent', 'v', 1000, 1000)`,
      )
      .run(C_PARENT);
    seed.close();
  }
  const pristine = dump(C);

  const failBundle = makeFailingBundle("CHILD_RB", "cmd-rollback");
  const failJson = JSON.stringify(failBundle);
  const now2 = Date.now;
  Date.now = () => FROZEN;
  let tsThrew = false;
  let rsThrew = false;
  try {
    const tsC = makeTsStore(C);
    try {
      await tsC.store.commitForkBundle(failBundle);
    } catch (e) {
      tsThrew = String(e && e.message ? e.message : e).includes("Storage copy source missing");
    } finally {
      tsC.close();
    }
    try {
      addon.commitForkBundleJson(D, failJson, FROZEN);
    } catch (e) {
      rsThrew = String(e && e.message ? e.message : e).includes("Storage copy source missing");
    }
  } finally {
    Date.now = now2;
  }
  if (!tsThrew) fail("TS rollback case did not throw the copy-source error");
  if (!rsThrew) fail("Rust rollback case did not throw the copy-source error");
  // Both sides must be pristine: the child + every earlier partial write are gone.
  if (dump(C) !== pristine) fail("TS rollback left partial rows");
  if (dump(D) !== pristine) fail("Rust rollback left partial rows");
  if (dump(C) !== dump(D)) fail("TS vs Rust rollback DB state diverged");

  if (failed === 0) {
    console.log(
      "FORK BUNDLES PARITY: OK — createForkedSessionWithMetadata + commitForkBundle (guards, idempotent command fact, copySources messages/parts, goal→clone target, entries, initialInput, final v4/command_fact) byte-identical across TS and Rust, and the mid-transaction failure rolls back EVERYTHING on both sides",
    );
    process.exit(0);
  }
  console.error("FORK BUNDLES PARITY: DIFF");
  process.exit(1);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
