// TS-vs-Rust golden WRITE-parity harness for the session-input PROMOTION state machine:
// `promoteSessionInput`, `markSessionInputPromoted`, `settleSessionInput`, `updateSessionInputs`
// (from `apps/zcode-cli/packages/adapters/src/storage/session-store/repositories/session-inputs.ts`).
//
// Two throwaway /tmp session-store DBs (A = REAL TS functions, B = Rust addon) are bootstrapped
// identically and seeded with the SAME FK parent (`session`) and the SAME admitted/promoted
// `session_input` rows, so every transition has a real prior state to move from. The clock is frozen
// (Date.now -> FROZEN) and the SAME FROZEN is handed to the addon as `now`, so `time_updated` and the
// assistant/`?? now` fallbacks are identical on both sides. An identical transition SEQUENCE is applied
// to both DBs, exercising every guard:
//   - promote (lone txn, writes promoted + promoted_message_id + promoted_sequence, NO status guard);
//   - mark from admitted (succeeds) and from an already-promoted row (guarded no-op);
//   - settle with and without a reason, and a LATE settle after promotion (guarded no-op);
//   - updateSessionInputs transactional batch: `text`/`queuePosition` re-encode, an intent patch that
//     drives `patchObject`'s `delivery`/`steer:fellBack`/`order` arms (byte-exact JSON.stringify),
//     a patch that skips a non-admitted row, and an empty batch (returns before opening a txn).
// Final state of `session_input` (all columns) and `message`/`part`/`session` (touched by promote) is
// dumped and byte-compared; any op that returns a value is compared too. Never touches `~/.zcode`.
//
// Run from the crate dir:
//   ../../../node_modules/.bin/tsx harness/session_write_promotion_parity.mts
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

// Import the REAL TS write ops by repo-root absolute path so their transitive workspace imports
// (`@zcode/contracts`, `../json.js`, sibling repositories) resolve — mirroring the sibling harnesses.
const { promoteSessionInput, markSessionInputPromoted, settleSessionInput, updateSessionInputs } =
  await import(
    pathToFileURL(
      "/media/hdd1/ZCode/apps/zcode-cli/packages/adapters/src/storage/session-store/repositories/session-inputs.ts",
    ).href
  );

const dir = mkdtempSync(join(tmpdir(), "zcode-promotion-write-parity-"));
const A = join(dir, "ts.sqlite");
const B = join(dir, "rs.sqlite");

// Frozen clock handed to both sides so every timestamp is deterministic.
const FROZEN = 1_700_000_000_000;

const SESSION_SEED =
  "insert into session (id,project_id,slug,directory,title,version,time_created,time_updated) \
   values ('s1','p','s','/d','t','v',1,1)";
// A spread of prior states: admitted rows (to transition), one already-promoted row (idempotent mark),
// and payloads carrying `conversationInputIntent` so `patchObject`'s arms are exercised.
const INPUT_SEED = `insert into session_input (
    id, session_id, kind, delivery, payload, admitted_sequence, promoted_sequence,
    promoted_message_id, status, status_reason, time_created, time_updated
  ) values
    ('i_promote','s1','user','queue','{"text":"p"}',0,null,null,'admitted',null,1,1),
    ('i_mark','s1','user','queue','{"text":"m"}',1,null,null,'admitted',null,1,1),
    ('i_idem','s1','user','queue','{"text":"i"}',2,0,'pre','promoted',null,1,1),
    ('i_settle','s1','user','queue','{"text":"s"}',3,null,null,'admitted',null,1,1),
    ('i_plain','s1','user','queue','{"text":"plain"}',4,null,null,'admitted',null,1,1),
    ('i_update','s1','user','queue','{"text":"old","conversationInputIntent":{"steer":{"state":"steered"},"order":{"a":1}}}',5,null,null,'admitted',null,1,1),
    ('i_steering','s1','user','queue','{"text":"st","conversationInputIntent":{"steer":{"state":"steered"},"order":{"z":9}}}',6,null,null,'admitted',null,1,1)`;

// A promoted user message (no shared-context refs — the attach path is covered by the unit tests).
const MSG = { id: "m1", sessionID: "s1", role: "user", time: { created: 1000 }, agent: "main" };

function seed(path) {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(SESSION_SEED);
  db.exec(INPUT_SEED);
  db.close();
}

let failed = 0;
const fail = (msg, extra) => {
  console.error(`PROMOTION WRITE PARITY: FAIL — ${msg}`);
  if (extra !== undefined) console.error(`  ${extra}`);
  failed = 1;
};

try {
  addon.bootstrapSessionStoreJson(A, 5000, Date.now());
  addon.bootstrapSessionStoreJson(B, 5000, Date.now());
  seed(A);
  seed(B);

  const dbA = new DatabaseSync(A);
  dbA.exec("PRAGMA foreign_keys = ON");

  const realNow = Date.now;
  Date.now = () => FROZEN;
  try {
    // (1) promote i_promote: transactional saveMessage + promoted bump (message id m1).
    await promoteSessionInput(dbA, { id: "i_promote", sessionID: "s1", message: MSG, parts: [] });
    addon.promoteSessionInputJson(B, "i_promote", "s1", JSON.stringify(MSG), "[]", FROZEN);

    // (2) mark i_mark from admitted → promoted.
    await markSessionInputPromoted(dbA, { id: "i_mark", sessionID: "s1", promotedMessageID: "m2" });
    addon.markSessionInputPromotedJson(B, "i_mark", "s1", "m2", FROZEN);

    // (3) mark i_idem which is ALREADY promoted → guard makes it a no-op (no double sequence bump).
    await markSessionInputPromoted(dbA, { id: "i_idem", sessionID: "s1", promotedMessageID: "mX" });
    addon.markSessionInputPromotedJson(B, "i_idem", "s1", "mX", FROZEN);

    // (4) settle i_settle (admitted) → cancelled with a reason.
    await settleSessionInput(dbA, { id: "i_settle", sessionID: "s1", status: "cancelled", reason: "bye" });
    addon.settleSessionInputJson(B, "i_settle", "s1", "cancelled", "bye", FROZEN);

    // (5) settle i_plain (admitted) → discarded with NO reason (status_reason stays NULL).
    await settleSessionInput(dbA, { id: "i_plain", sessionID: "s1", status: "discarded" });
    addon.settleSessionInputJson(B, "i_plain", "s1", "discarded", null, FROZEN);

    // (6) LATE settle of i_mark (now promoted) → guard rejects (promotion must not roll back).
    await settleSessionInput(dbA, { id: "i_mark", sessionID: "s1", status: "discarded", reason: "late" });
    addon.settleSessionInputJson(B, "i_mark", "s1", "discarded", "late", FROZEN);

    // (7) updateSessionInputs transactional batch:
    //     - i_update: text overwrite + queuePosition rebuild of conversationInputIntent.order;
    //     - i_steering: an intent patch driving patchObject's delivery + steer:fellBack arms AND the
    //       top-level payload.intent = update.intent replacement;
    //     - i_promote: a promoted row, skipped by the `status = 'admitted'` guard (unchanged).
    const updates = [
      { id: "i_update", text: "edited", queuePosition: 2 },
      { id: "i_steering", intent: { requestedDelivery: "steer", admittedDelivery: "queue", fallbackReasonCode: "fb1" } },
      { id: "i_promote", text: "should-be-skipped" },
    ];
    await updateSessionInputs(dbA, { sessionID: "s1", updates });
    addon.updateSessionInputsJson(B, "s1", JSON.stringify(updates), FROZEN);

    // (8) empty batch → returns before opening any transaction (no-op on both).
    await updateSessionInputs(dbA, { sessionID: "s1", updates: [] });
    addon.updateSessionInputsJson(B, "s1", "[]", FROZEN);
  } finally {
    dbA.close();
    Date.now = realNow;
  }

  // --- Final byte-compare: session_input (all columns) plus the tables promote touches. ---
  const dump = (path) => {
    const ro = new DatabaseSync(path, { readOnly: true });
    const out = {
      inputs: ro.prepare("SELECT * FROM session_input ORDER BY id").all(),
      messages: ro.prepare("SELECT id, session_id, data, sequence, time_created, time_updated FROM message ORDER BY id").all(),
      parts: ro.prepare("SELECT id, session_id, message_id, data, sequence, time_created, time_updated FROM part ORDER BY id").all(),
      sessions: ro.prepare("SELECT id, time_updated FROM session ORDER BY id").all(),
    };
    ro.close();
    return JSON.stringify(out);
  };

  const a = dump(A);
  const b = dump(B);
  if (a === b) {
    // Sanity-check the interesting outcomes actually happened (not just "both wrong the same way").
    const parsed = JSON.parse(a).inputs;
    const byId = Object.fromEntries(parsed.map((r) => [r.id, r]));
    const checks = [
      [byId.i_promote?.status === "promoted" && byId.i_promote?.promoted_message_id === "m1", "promote wrote promoted/m1"],
      [byId.i_mark?.status === "promoted" && byId.i_mark?.promoted_message_id === "m2", "mark wrote promoted/m2"],
      [byId.i_idem?.promoted_message_id === "pre", "idempotent mark left the pre value untouched"],
      [byId.i_settle?.status === "cancelled" && byId.i_settle?.status_reason === "bye", "settle wrote reason"],
      [byId.i_plain?.status === "discarded" && byId.i_plain?.status_reason === null, "settle no-reason left NULL"],
      [byId.i_update?.payload.includes('"text":"edited"') && byId.i_update?.payload.includes('"queuePosition":2'), "update applied text/order"],
      [byId.i_steering?.payload.includes('"steer":{"state":"fellBack"') && byId.i_steering?.payload.includes('"fallbackReasonCode"'), "update drove fellBack/delivery"],
      [byId.i_promote?.payload === '{"text":"p"}', "update skipped the promoted row"],
    ];
    for (const [ok, what] of checks) if (!ok) fail(`transition assertion failed: ${what}`, a);
    if (!failed)
      console.log(
        "PROMOTION WRITE PARITY: OK — promote/mark/settle guards + transactional update re-encode (patchObject delivery/steer/order) byte-identical across TS and Rust",
      );
  } else {
    fail("session_input/message/part/session dump differs between TS and Rust");
    console.error(`  TS: ${a}`);
    console.error(`  RS: ${b}`);
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}
process.exit(failed);
