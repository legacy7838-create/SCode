// TS-vs-Rust golden WRITE-parity harness for the usage write ops: `recordModelUsage`,
// `upsertTurnUsage`, `upsertToolUsage`, `pruneUsage` (ported from
// `apps/zcode-cli/packages/adapters/src/storage/session-store/repositories/usage.ts`).
//
// Two throwaway /tmp session-store DBs (A = TS via node:sqlite, B = the Rust addon) are bootstrapped
// identically. A single FK parent `session` (the `session_id` column on all three usage tables
// references `session(id)`) is seeded IDENTICALLY into both. The REAL TS repository functions are
// imported by repo-root absolute path so their transitive workspace imports resolve.
//
// `Date.now` is frozen to `FROZEN` on the TS path and the SAME `FROZEN` is handed to the addon as
// `now`, so every op's trailing `pruneUsage(db)` default cutoff (`now - 30 days`) is identical on both
// sides. Usage records carry CALLER-SUPPLIED ids (model_usage.id / tool_usage.id; turn_usage keys on
// (session_id, turn_id)) — the source mints NO non-deterministic id — so both sides are fed byte-
// identical payloads and NO id read-back is needed.
//
// The matrix exercises: a fresh model insert + an id re-save (on conflict(id) overwrite); a model row
// with null/undefined optional columns + providerTotalTokens; a turn upsert whose re-save hits the
// coalesce/min merge arms; a tool upsert whose re-save hits the `tool_name = 'unknown'` guard, the
// terminal-status downgrade guard, the started_at min and the *_bytes max; a rawUsage/providerMetadata
// JSON object whose key order must byte-match `JSON.stringify` (serde `preserve_order`); and both an
// explicit-cutoff `pruneUsage` (removes some rows, keeps the one exactly at the cutoff) and a
// default-cutoff `pruneUsage({})` no-op. After mirroring, `SELECT * FROM <each table>` is dumped from
// both DBs, JSON.stringify'd, and byte-compared. Only /tmp copies are touched — never the live
// `~/.zcode`. Run from the crate dir:
//   ../../../node_modules/.bin/tsx harness/session_write_usage_parity.mts
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

// Import the real TS usage ops by their repo-root absolute path so their transitive workspace imports
// (`@zcode/contracts` via pnpm symlinks, and `../json.js` for encodeJson) resolve.
const TS_USAGE_PATH = pathToFileURL(
  "/media/hdd1/ZCode/apps/zcode-cli/packages/adapters/src/storage/session-store/repositories/usage.ts",
).href;
const { recordModelUsage, upsertTurnUsage, upsertToolUsage, pruneUsage } = await import(TS_USAGE_PATH);

const dir = mkdtempSync(join(tmpdir(), "zcode-usage-write-parity-"));
const A = join(dir, "ts.sqlite");
const B = join(dir, "rs.sqlite");

const S = "sess-usage-a";
// Frozen clock; handed to the addon as `now` and returned by Date.now() on the TS path.
const FROZEN = 1_700_000_000_000;
const RETENTION = 30 * 24 * 60 * 60 * 1000; // mirrors usage.ts USAGE_RETENTION_MS
// Started timestamps all inside the retention window so each op's trailing default-cutoff prune keeps
// the rows; the standalone prune test then removes the older ones by an explicit cutoff.
const T_OLD = FROZEN - RETENTION + 1000;
const T_MID = FROZEN - 5000;
const T_NEW = FROZEN;

let failed = 0;
const fail = (msg) => {
  console.error(`USAGE WRITE PARITY: FAIL — ${msg}`);
  failed = 1;
};

// One mirrored op: run it on TS (DB A, frozen clock) and on the Rust addon (DB B) with a byte-
// identical payload. The returned addon string must be "null" (TS ops return void).
async function mirror(name, tsFn, payload, addonFn) {
  await tsFn(payload);
  const out = addonFn(payload);
  if (out !== "null") fail(`${name}: addon returned ${JSON.stringify(out)}, expected "null"`);
}

try {
  addon.bootstrapSessionStoreJson(A, 5000, FROZEN);
  addon.bootstrapSessionStoreJson(B, 5000, FROZEN);

  // Seed the parent session IDENTICALLY into both DBs (the usage tables FK-reference session(id)).
  for (const path of [A, B]) {
    const seed = new DatabaseSync(path);
    seed.exec("PRAGMA foreign_keys = ON");
    seed
      .prepare(
        `INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated)
         VALUES (?, 'p', 's', '/d', 't', 'v', 1, 5000)`,
      )
      .run(S);
    seed.close();
  }

  // ---- model_usage: fresh insert, re-save/upsert, null/undefined columns, rawUsage ordering ----
  const MODEL_FULL = {
    id: "mu1",
    logicalRequestId: "lr-1",
    attemptIndex: 2,
    sessionID: S,
    turnID: "t1",
    querySource: "main_turn",
    providerId: "anthropic",
    modelId: "claude-x",
    reasoningLevel: "high",
    agent: "main",
    mode: "code",
    taskType: "interactive",
    status: "completed",
    startedAt: T_MID,
    firstTokenAt: T_MID + 10,
    completedAt: T_MID + 20,
    durationMs: 20,
    timeToFirstTokenMs: 10,
    finishReason: "stop",
    toolCallCount: 3,
    inputTokens: 100,
    outputTokens: 40,
    reasoningTokens: 5,
    cacheCreationInputTokens: 7,
    cacheReadInputTokens: 11,
    providerTotalTokens: 158,
    retryCount: 1,
    retryable: true,
    cancelledByUser: false,
    contextExceeded: false,
    rawUsage: { b: 2, a: 1, note: "hello" },
    providerMetadata: { z: 26, y: 25 },
  };
  // Re-save the SAME id with changed scalar fields and a DIFFERENT rawUsage: the on-conflict arm must
  // overwrite every column (no coalesce), keeping a single row.
  const MODEL_RES = {
    id: "mu1",
    logicalRequestId: "lr-1",
    attemptIndex: 5,
    sessionID: S,
    turnID: "t9",
    querySource: "subagent",
    providerId: "openai",
    modelId: "gpt-z",
    status: "error",
    startedAt: T_MID,
    errorType: "overloaded",
    errorCode: "503",
    errorMessage: "boom",
    rawUsage: { c: 3 },
  };
  // A model row with only the required fields: every `?? null` column → SQL NULL, every integer()/
  // boolean() column → 0, computedTotalTokens falls back to input+cache logic.
  const MODEL_MIN = {
    id: "mu2",
    logicalRequestId: "lr-2",
    sessionID: S,
    querySource: "main_turn",
    providerId: "pv",
    modelId: "md",
    status: "running",
    startedAt: T_NEW,
  };
  // Rows used purely for the standalone prune boundary test (distinct started_at around a cutoff).
  const MODEL_OLD = { ...MODEL_MIN, id: "mu-old", startedAt: T_OLD };
  const MODEL_MID = { ...MODEL_MIN, id: "mu-mid", startedAt: T_MID };
  const MODEL_NEW2 = { ...MODEL_MIN, id: "mu-new", startedAt: T_NEW };

  // ---- turn_usage ----
  const TURN_FIRST = {
    sessionID: S,
    turnID: "tu1",
    traceID: "tr-keep",
    userMessageID: "um-keep",
    status: "running",
    startedAt: T_MID,
    firstTokenAt: T_MID + 1,
    completedAt: null,
    durationMs: null,
    inputTokens: 5,
    outputTokens: 5,
    computedTotalTokens: 10,
    retryable: false,
    cancelledByUser: false,
    contextExceeded: false,
  };
  // Re-save the same (session_id, turn_id): traceID/userMessageID omitted → coalesce keeps existing;
  // startedAt later → min keeps earlier; firstTokenAt present → coalesce(existing, excluded) keeps
  // existing; completedAt present → coalesce(excluded, existing) takes excluded; tokens overwrite.
  const TURN_RES = {
    sessionID: S,
    turnID: "tu1",
    status: "completed",
    startedAt: T_NEW,
    firstTokenAt: T_NEW + 1,
    completedAt: T_NEW + 2,
    durationMs: 3,
    inputTokens: 9,
    outputTokens: 8,
    computedTotalTokens: 17,
    errorType: "timeout",
    errorCode: "408",
  };

  // ---- tool_usage ----
  const TOOL_FIRST = {
    id: "tu-tool",
    sessionID: S,
    turnID: "tu1",
    toolCallID: "call-1",
    toolName: "bash",
    sideEffectScope: "local",
    readOnly: true,
    // destructive undefined → NULL
    approvalStatus: "allowed",
    status: "completed",
    startedAt: T_MID,
    firstOutputAt: T_MID + 1,
    completedAt: T_MID + 2,
    durationMs: 2,
    timeToFirstOutputMs: 1,
    exitCode: 0,
    outputBytes: 100,
    stdoutBytes: 70,
    stderrBytes: 30,
    truncated: true,
    retryCount: 2,
    retryable: true,
    cancelledByUser: false,
    errorType: null,
    errorCode: null,
    errorMessage: null,
  };
  // Re-save the same id: tool_name 'unknown' → keep existing 'bash'; status 'running' while stored is
  // terminal 'completed' → keep 'completed'; startedAt later → min keeps earlier; firstOutputAt absent →
  // coalesce(existing, excluded) keeps existing; outputBytes/stdout/stderr smaller → max keeps existing;
  // truncated true|0 → max keeps 1; readOnly undefined → coalesce keeps existing 1; destructive false →
  // now 0 (present overrides NULL); exitCode absent → coalesce keeps existing.
  const TOOL_RES = {
    id: "tu-tool",
    sessionID: S,
    toolCallID: "call-1",
    toolName: "unknown",
    status: "running",
    startedAt: T_NEW,
    outputBytes: 10,
    stdoutBytes: 1,
    stderrBytes: 1,
    truncated: false,
    destructive: false,
    retryable: false,
    cancelledByUser: true,
  };

  const tsDb = new DatabaseSync(A);
  tsDb.exec("PRAGMA foreign_keys = ON");

  // TS wrappers bound to the A connection.
  const tsModel = (p) => recordModelUsage(tsDb, p);
  const tsTurn = (p) => upsertTurnUsage(tsDb, p);
  const tsTool = (p) => upsertToolUsage(tsDb, p);
  const tsPruneDefault = () => pruneUsage(tsDb);
  const tsPruneCutoff = (before) => pruneUsage(tsDb, { beforeTime: before });

  // addon wrappers bound to B.
  const rsModel = (p) => addon.recordModelUsageJson(B, JSON.stringify(p), FROZEN);
  const rsTurn = (p) => addon.upsertTurnUsageJson(B, JSON.stringify(p), FROZEN);
  const rsTool = (p) => addon.upsertToolUsageJson(B, JSON.stringify(p), FROZEN);
  const rsPruneDefault = () => addon.pruneUsageJson(B, null, FROZEN);
  const rsPruneCutoff = (before) => addon.pruneUsageJson(B, before, FROZEN);

  const realNow = Date.now;
  Date.now = () => FROZEN;
  try {
    // (1) model fresh + re-save + min + three prune-seed rows.
    await mirror("recordModelUsage(mu1)", tsModel, MODEL_FULL, rsModel);
    await mirror("recordModelUsage(mu1 resave)", tsModel, MODEL_RES, rsModel);
    await mirror("recordModelUsage(mu2 min)", tsModel, MODEL_MIN, rsModel);
    await mirror("recordModelUsage(mu-old)", tsModel, MODEL_OLD, rsModel);
    await mirror("recordModelUsage(mu-mid)", tsModel, MODEL_MID, rsModel);
    await mirror("recordModelUsage(mu-new)", tsModel, MODEL_NEW2, rsModel);

    // (2) turn fresh + re-save.
    await mirror("upsertTurnUsage(tu1)", tsTurn, TURN_FIRST, rsTurn);
    await mirror("upsertTurnUsage(tu1 resave)", tsTurn, TURN_RES, rsTurn);

    // (3) tool fresh + re-save.
    await mirror("upsertToolUsage(tu-tool)", tsTool, TOOL_FIRST, rsTool);
    await mirror("upsertToolUsage(tu-tool resave)", tsTool, TOOL_RES, rsTool);

    // (4) default-cutoff pruneUsage({}) — a no-op here (all rows are inside the window) but must match.
    await mirror("pruneUsage(default)", tsPruneDefault, null, () => rsPruneDefault());

    // (5) explicit-cutoff pruneUsage: drop started_at < T_MID. mu-old is removed; mu-mid (exactly the
    //     cutoff) and the rest survive. Same cutoff on both sides.
    const cutoff = T_MID;
    await tsPruneCutoff(cutoff);
    if (addon.pruneUsageJson(B, cutoff, FROZEN) !== "null")
      fail("explicit-cutoff prune addon must return null");
  } finally {
    tsDb.close();
    Date.now = realNow;
  }

  // ---- Final byte-for-byte dump of all three tables from both DBs. ----
  const dump = (path) => {
    const ro = new DatabaseSync(path, { readOnly: true });
    try {
      return JSON.stringify({
        model: ro.prepare("SELECT * FROM model_usage ORDER BY id").all(),
        turn: ro.prepare("SELECT * FROM turn_usage ORDER BY turn_id").all(),
        tool: ro.prepare("SELECT * FROM tool_usage ORDER BY id").all(),
      });
    } finally {
      ro.close();
    }
  };
  const a = dump(A);
  const b = dump(B);
  if (a !== b) {
    fail("usage dump differs between TS and Rust");
    console.error(`  TS: ${a}`);
    console.error(`  RS: ${b}`);
  } else {
    const models = JSON.parse(a).model.length;
    console.log(
      `USAGE WRITE PARITY: OK — model/turn/tool guarded upserts (overwrite vs coalesce/min/max arms, tool_name unknown + terminal-status guards), integer/boolean/nullableBoolean/encodeJson defaults, rawUsage key-order and pruneUsage (default + explicit cutoff) identical across TS and Rust (${models} model rows)`,
    );
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}
process.exit(failed);
