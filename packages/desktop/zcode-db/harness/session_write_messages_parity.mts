// TS-vs-Rust golden WRITE-parity harness for `saveMessage` / `savePart` / `removeMessage` /
// `removePart` (the guarded upserts with the `data = case ... json_set/json_extract` legacy-preservation
// arm, the scope-preserving `sequence` rule, `partCreatedAt`, the legacy `model`/`toModel` snapshots,
// the `copyFrom` legacy-member copy, and the inline `touchSession`).
//
// A uniquely-keyed parent `session` (FK target) is seeded IDENTICALLY into two bootstrapped DBs, then
// an identical write sequence is applied through the REAL TS functions (DB A) and the Rust addon
// (DB B). The sequence exercises BOTH branches of the legacy-preservation CASE:
//   - a same-session message re-save whose fresh snapshot drops a legacy key the stored row still
//     carries (`providerID`): the CASE must copy it back in;
//   - a cross-session id collision: the CASE falls through to the fresh `excluded.data`.
// Plus a `copyFrom` path, timeline/subtask parts (and the part-scope CASE via a message re-bind), and
// scoped removes. `Date.now` is frozen and the SAME value is handed to the addon as `now`, so every
// `?? now` / `partCreatedAt` fallback is identical. FK enforcement is turned ON on BOTH write paths so
// the `on delete cascade` from message → part behaves identically (the addon sets it per-connection).
//
// Only throwaway /tmp copies are touched — never the live `~/.zcode` DB. Run from the crate dir:
//   ../../../node_modules/.bin/tsx harness/session_write_messages_parity.mts
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

// Import the real TS write ops by their repo-root absolute path so their transitive workspace
// imports (`@zcode/contracts` via pnpm symlinks in the consumer package's node_modules) resolve,
// mirroring `session_write_entry_parity.mts`.
const TS_MSG_PATH = pathToFileURL(
  "/media/hdd1/ZCode/apps/zcode-cli/packages/adapters/src/storage/session-store/repositories/messages.ts",
).href;
const { saveMessage, savePart, removeMessage, removePart } = await import(TS_MSG_PATH);

const dir = mkdtempSync(join(tmpdir(), "zcode-messages-write-parity-"));
const A = join(dir, "ts.sqlite");
const B = join(dir, "rs.sqlite");

const S1 = "sess-msg-a";
const S2 = "sess-msg-b";
// Frozen clock; handed to the addon as `now` and returned by Date.now() on the TS path.
const FROZEN = 1_700_000_000_000;

// ---- Message writes ----
const USER_SAME = {
  id: "m_same",
  sessionID: S1,
  role: "user",
  time: { created: 1000 },
  agent: "main",
  modelSelection: { providerId: "p", modelId: "q", options: { reasoningLevel: "high" } },
};
// Same session re-save: drops `variant`/reasoning and the top-level `providerID` the injected legacy
// row still carries. Same-scope → CASE must preserve `providerID` (and `model` stays via rebuild).
const USER_SAME_RES = {
  id: "m_same",
  sessionID: S1,
  role: "user",
  time: { created: 2000 },
  agent: "sub",
  modelSelection: { providerId: "p", modelId: "q" },
};
const CROSS_A = {
  id: "m_cross",
  sessionID: S1,
  role: "user",
  time: { created: 1000 },
  modelSelection: { providerId: "p", modelId: "q" },
};
// Same id under a DIFFERENT session: cross-scope → CASE takes the fresh `excluded.data` (no
// preserved `providerID`) and the new scope's sequence queue.
const CROSS_B = {
  id: "m_cross",
  sessionID: S2,
  role: "assistant",
  time: { created: 3000, completed: 4000 },
  cost: 0,
};
// A copyFrom source (m_same carries legacy `model` + injected `providerID`).
const MSG_COPY = {
  id: "m_copy",
  sessionID: S1,
  role: "assistant",
  time: { created: 5000, completed: 6000 },
  cost: 1,
};
// Removable message (with parts) to exercise `on delete cascade` parity.
const MSG_DEL = {
  id: "m_del",
  sessionID: S1,
  role: "assistant",
  time: { created: 700, completed: 800 },
  cost: 0,
};
const MSG_DEL_PART = {
  id: "p_del",
  sessionID: S1,
  messageID: "m_del",
  type: "text",
  text: "to cascade",
  time: { start: 810 },
};

// ---- Part writes (parent messages already saved) ----
const P_TEXT = {
  id: "pt1",
  sessionID: S1,
  messageID: "m_same",
  type: "text",
  text: "hello",
  time: { start: 111 },
};
const P_TIMELINE = {
  id: "ptl",
  sessionID: S1,
  messageID: "m_same",
  type: "timeline",
  timelineType: "model_change",
  fromModel: { providerId: "a", modelId: "b" },
  toModel: { providerId: "c", modelId: "d", options: { reasoningLevel: "low" }, label: "L1" },
};
// Same (message_id, session_id) re-save with a changed non-legacy field: the part CASE must keep the
// existing (first-save) legacy `toModel` snapshot, not the freshly-rewritten one.
const P_TIMELINE_RES = {
  id: "ptl",
  sessionID: S1,
  messageID: "m_same",
  type: "timeline",
  timelineType: "model_change",
  fromModel: { providerId: "x", modelId: "y" },
  toModel: { providerId: "z", modelId: "w", label: "L2" },
};
const P_SUBTASK = {
  id: "psub",
  sessionID: S1,
  messageID: "m_same",
  type: "subtask",
  name: "worker",
  model: { providerId: "p", modelId: "q" },
};
// copyFrom source is the timeline part `ptl` (its stored data carries the legacy `toModel`).
const P_COPY = {
  id: "pcopy",
  sessionID: S1,
  messageID: "m_same",
  type: "text",
  text: "copied",
  time: { start: 222 },
};
// A part to remove independently (scoped).
const P_REMOVE = {
  id: "prm",
  sessionID: S1,
  messageID: "m_same",
  type: "retry",
  time: { created: 999 },
};

try {
  // Identical schema on both copies via the addon's own session-store bootstrap.
  addon.bootstrapSessionStoreJson(A, 5000, Date.now());
  addon.bootstrapSessionStoreJson(B, 5000, Date.now());

  // Seed the parent sessions (message.session_id / part.session_id FK targets) IDENTICALLY.
  for (const path of [A, B]) {
    const seed = new DatabaseSync(path);
    seed.exec("PRAGMA foreign_keys = ON");
    const stmt = seed.prepare(
      `INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated)
       VALUES (?, 'p', 's', '/d', 't', 'v', ?, ?)`,
    );
    stmt.run(S1, 1, 5000);
    stmt.run(S2, 1, 5000);
    seed.close();
  }

  // Inject an EXTRA legacy key into a stored message so the same-scope CASE preservation and the
  // cross-scope fall-through are observably different (identically on both copies).
  const stampLegacyProvider = (path) => {
    const db = new DatabaseSync(path);
    db.exec("PRAGMA foreign_keys = ON");
    db.prepare(
      `UPDATE message SET data = json_set(data, '$.providerID', 'KEEP') WHERE id = ?`,
    ).run("m_same");
    db.prepare(
      `UPDATE message SET data = json_set(data, '$.providerID', 'KEEP') WHERE id = ?`,
    ).run("m_cross");
    db.close();
  };

  // --- Apply the write sequence: TS on A (frozen clock), Rust addon on B (same payloads). ---
  const realNow = Date.now;
  Date.now = () => FROZEN;
  const tsDb = new DatabaseSync(A);
  tsDb.exec("PRAGMA foreign_keys = ON");
  try {
    saveMessage(tsDb, USER_SAME);
    stampLegacyProvider(A);
    saveMessage(tsDb, USER_SAME_RES); // same-scope → CASE preserves providerID
    saveMessage(tsDb, CROSS_A);
    // re-stamp only m_cross (m_same is a fresh insert for CROSS_B, but stamp both is harmless)
    const dBCross = new DatabaseSync(A);
    dBCross.exec("PRAGMA foreign_keys = ON");
    dBCross.prepare(`UPDATE message SET data = json_set(data, '$.providerID', 'KEEP') WHERE id = ?`).run("m_cross");
    dBCross.close();
    saveMessage(tsDb, CROSS_B); // cross-session → excluded.data (no providerID)
    saveMessage(tsDb, MSG_COPY, { id: "m_same", sessionID: S1 }); // copyFrom legacy keys
    saveMessage(tsDb, MSG_DEL);
    savePart(tsDb, P_TEXT);
    savePart(tsDb, P_TIMELINE);
    savePart(tsDb, P_TIMELINE_RES); // same part-scope → CASE keeps existing toModel snapshot
    savePart(tsDb, P_SUBTASK);
    savePart(tsDb, P_COPY, { id: "ptl", sessionID: S1 }); // copyFrom part legacy toModel
    savePart(tsDb, P_REMOVE);
    savePart(tsDb, MSG_DEL_PART);
    removePart(tsDb, { sessionID: S2, messageID: "m_same", partID: "pt1" }); // scoped miss (wrong session)
    removePart(tsDb, { sessionID: S1, messageID: "m_same", partID: "prm" }); // scoped hit
    removeMessage(tsDb, { sessionID: S2, messageID: "m_del" }); // scoped miss (wrong session)
    removeMessage(tsDb, { sessionID: S1, messageID: "m_del" }); // scoped hit → cascade p_del
  } finally {
    tsDb.close();
    Date.now = realNow;
  }

  // Rust addon: identical sequence, same frozen `now`, explicit providerID stamping at the same points.
  addon.saveMessageJson(B, JSON.stringify(USER_SAME), null, FROZEN);
  stampLegacyProvider(B);
  addon.saveMessageJson(B, JSON.stringify(USER_SAME_RES), null, FROZEN);
  addon.saveMessageJson(B, JSON.stringify(CROSS_A), null, FROZEN);
  {
    const dBCross = new DatabaseSync(B);
    dBCross.exec("PRAGMA foreign_keys = ON");
    dBCross.prepare(`UPDATE message SET data = json_set(data, '$.providerID', 'KEEP') WHERE id = ?`).run("m_cross");
    dBCross.close();
  }
  addon.saveMessageJson(B, JSON.stringify(CROSS_B), null, FROZEN);
  addon.saveMessageJson(B, JSON.stringify(MSG_COPY), JSON.stringify({ id: "m_same", sessionID: S1 }), FROZEN);
  addon.saveMessageJson(B, JSON.stringify(MSG_DEL), null, FROZEN);
  addon.savePartJson(B, JSON.stringify(P_TEXT), null, FROZEN);
  addon.savePartJson(B, JSON.stringify(P_TIMELINE), null, FROZEN);
  addon.savePartJson(B, JSON.stringify(P_TIMELINE_RES), null, FROZEN);
  addon.savePartJson(B, JSON.stringify(P_SUBTASK), null, FROZEN);
  addon.savePartJson(B, JSON.stringify(P_COPY), JSON.stringify({ id: "ptl", sessionID: S1 }), FROZEN);
  addon.savePartJson(B, JSON.stringify(P_REMOVE), null, FROZEN);
  addon.savePartJson(B, JSON.stringify(MSG_DEL_PART), null, FROZEN);
  addon.removePartJson(B, S2, "m_same", "pt1");
  addon.removePartJson(B, S1, "m_same", "prm");
  addon.removeMessageJson(B, S2, "m_del");
  addon.removeMessageJson(B, S1, "m_del");

  // --- Read both final states back and compare. ---
  const dump = (path) => {
    const ro = new DatabaseSync(path, { readOnly: true });
    const messages = ro
      .prepare("SELECT id, session_id, data, sequence, time_created, time_updated FROM message ORDER BY id")
      .all();
    const parts = ro
      .prepare("SELECT id, session_id, message_id, data, sequence, time_created, time_updated FROM part ORDER BY id")
      .all();
    const sessions = ro.prepare("SELECT id, time_updated FROM session ORDER BY id").all();
    ro.close();
    return JSON.stringify({ messages, parts, sessions });
  };
  const a = dump(A);
  const b = dump(B);
  if (a === b) {
    console.log(
      "MESSAGES WRITE PARITY: OK — guarded upsert (CASE preserve vs excluded.data), scope-preserving sequence, legacy model/toModel snapshots, copyFrom, partCreatedAt and scoped removes + touchSession identical across TS and Rust",
    );
  } else {
    console.error("MESSAGES WRITE PARITY: DIFF");
    console.error(`  TS: ${a}`);
    console.error(`  RS: ${b}`);
    process.exit(1);
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}
