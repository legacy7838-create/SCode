// TS-vs-Rust golden WRITE-parity harness for the shared-context import COMPOSITE operations:
// `commitSharedContextImportBundle` and `transitionSharedContextImport`
// (from `apps/zcode-cli/packages/adapters/src/storage/session-store/sqlite-session-store.ts`,
// lines 472-577).
//
// These are ATOMIC composites wrapping multiple sub-writes in ONE `BEGIN IMMEDIATE`/`COMMIT`/
// `ROLLBACK`. The harness replicates the TS composite logic against a real `node:sqlite` DatabaseSync
// (DB A) using the exported repository functions, then drives the equivalent Rust addon
// (DB B) with the single `commitSharedContextImportBundleJson` / `transitionSharedContextImportJson`
// ops. Both DBs are bootstrapped identically, frozen to the same clock, and the same inputs are fed.
//
// Cases exercised:
//   - Happy-path fresh import (create session + message + part + entry in one txn).
//   - Idempotent re-import (session already exists; returns existing, no additional writes).
//   - Identity guard failures: context-message session mismatch, provenance session mismatch,
//     provenance id namespace violation, wrong role, wrong visibility, wrong source — all throw
//     BEFORE the transaction, no writes.
//   - Status-transition success (entry updated, message metadata stamped).
//   - Status-transition guards: entry missing -> false, status mismatch -> false.
//   - ATOMIC ROLLBACK: a mid-step FK violation (part references non-existent message) rolls back
//     ALL prior writes including the session, message, and entry.
//
// Final state of `session/message/part/session_entry` is dumped and JSON.stringify byte-compared
// across both DBs. Any diff exits 1. Never touches `~/.zcode` or the main working tree.
//
// Run from the crate dir:
//   ../../../node_modules/.bin/tsx harness/session_write_shared_context_parity.mts

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

// Import the real TS repository functions used by the composite class methods.
const TS_REPOS = "/media/hdd1/ZCode/apps/zcode-cli/packages/adapters/src/storage/session-store/repositories";
const sessionRepo = await import(pathToFileURL(`${TS_REPOS}/sessions.ts`).href);
const messageRepo = await import(pathToFileURL(`${TS_REPOS}/messages.ts`).href);
const entryRepo = await import(pathToFileURL(`${TS_REPOS}/session-entries.ts`).href);

const dir = mkdtempSync(join(tmpdir(), "zcode-shared-context-write-parity-"));
const A = join(dir, "ts.sqlite");
const B = join(dir, "rs.sqlite");

const FROZEN = 1_700_000_000_000;

let failed = 0;
const fail = (msg, extra) => {
  console.error(`SHARED CONTEXT WRITE PARITY: FAIL - ${msg}`);
  if (extra !== undefined) console.error(`  ${extra}`);
  failed = 1;
};

// Build the test bundle: a fresh shared-context import.
const SESSION_ID = "sc-import-sess";
function buildBundle() {
  return {
    session: {
      id: SESSION_ID,
      projectID: "proj-parity",
      slug: "imported-session",
      directory: "/tmp/parity",
      title: "Imported Shared Context",
      version: "1.0.0",
      time: { created: FROZEN, updated: FROZEN },
    },
    contextMessage: {
      info: {
        id: "sc-msg-1",
        sessionID: SESSION_ID,
        role: "user",
        visibility: "model-only",
        source: "shared_context",
        time: { created: FROZEN },
        metadata: { contextId: "ctx-parity-1" },
      },
      parts: [
        {
          id: "sc-part-1",
          sessionID: SESSION_ID,
          messageID: "sc-msg-1",
          type: "text",
          text: "Imported shared context text content",
        },
      ],
    },
    provenance: {
      id: `prov-${SESSION_ID}-001`,
      sessionID: SESSION_ID,
      type: "v4/shared_context_import",
      time: { created: FROZEN, updated: FROZEN },
      data: { contextId: "ctx-parity-1", status: "pending" },
      touchSession: false,
    },
  };
}

// Replicate the TS commitSharedContextImportBundle logic using the repo-level functions.
async function tsCommitBundle(db, bundle) {
  const { session, contextMessage, provenance } = bundle;
  // Identity guard
  if (
    String(contextMessage.info.sessionID) !== String(session.id) ||
    String(provenance.sessionID) !== String(session.id) ||
    !provenance.id.includes(String(session.id)) ||
    contextMessage.info.role !== "user" ||
    contextMessage.info.visibility !== "model-only" ||
    contextMessage.info.source !== "shared_context"
  ) {
    throw new Error("Shared context import bundle identity is invalid");
  }
  db.exec("begin immediate");
  try {
    const existing = sessionRepo.getSession(db, session.id);
    if (existing) {
      const entries = entryRepo.sessionEntries(db, { sessionID: session.id, type: provenance.type });
      const entry = entries.find((c) => c.id === provenance.id);
      if (!entry) throw new Error("Shared context import session is incomplete");
      db.exec("commit");
      return existing;
    }
    const persisted = sessionRepo.createSession(db, session);
    await messageRepo.saveMessage(db, contextMessage.info);
    for (const part of contextMessage.parts) {
      await messageRepo.savePart(db, part);
    }
    entryRepo.saveSessionEntry(db, provenance);
    db.exec("commit");
    return persisted;
  } catch (error) {
    db.exec("rollback");
    throw error;
  }
}

// Replicate the TS transitionSharedContextImport logic using repo-level functions.
async function tsTransition(db, input) {
  db.exec("begin immediate");
  try {
    const entries = entryRepo.sessionEntries(db, { sessionID: input.sessionID, type: "v4/shared_context_import" });
    const entry = entries.find((candidate) => {
      const data = candidate.data;
      return Boolean(
        data &&
        typeof data === "object" &&
        !Array.isArray(data) &&
        data.contextId === input.contextId,
      );
    });
    if (!entry) {
      db.exec("rollback");
      return false;
    }
    const data = entry.data;
    const expected = Array.isArray(input.expectedStatus) ? input.expectedStatus : [input.expectedStatus];
    if (!expected.includes(data.status)) {
      db.exec("rollback");
      return false;
    }
    entryRepo.saveSessionEntry(db, {
      ...entry,
      time: { ...entry.time, updated: Date.now() },
      data: {
        ...data,
        status: input.status,
        ...(input.sourceId ? { sourceId: input.sourceId } : {}),
      },
    });
    const msgs = await messageRepo.messages(db, { sessionID: input.sessionID });
    const contextMessage = msgs.find((message) => {
      const metadata = message.info.metadata;
      return Boolean(
        metadata &&
        typeof metadata === "object" &&
        metadata.contextId === input.contextId,
      );
    });
    if (contextMessage) {
      await messageRepo.saveMessage(db, {
        ...contextMessage.info,
        metadata: {
          ...(contextMessage.info.metadata ?? {}),
          sharedContextStatus: input.status,
        },
      });
    }
    db.exec("commit");
    return true;
  } catch (error) {
    db.exec("rollback");
    throw error;
  }
}

try {
  // Bootstrap both DBs with the same schema.
  addon.bootstrapSessionStoreJson(A, 5000, Date.now());
  addon.bootstrapSessionStoreJson(B, 5000, Date.now());

  // Open DB A with FK enforcement for TS operations.
  const dbA = new DatabaseSync(A);
  dbA.exec("PRAGMA foreign_keys = ON");

  // Freeze clock so the TS repos' internal Date.now() calls match the Rust `now` injection.
  const realNow = Date.now;
  Date.now = () => FROZEN;
  try {
    // --- TEST 1: Happy path fresh import ---
    const bundle = buildBundle();
    const tsResult = await tsCommitBundle(dbA, bundle);
    const rsResult = JSON.parse(
      addon.commitSharedContextImportBundleJson(B, JSON.stringify(bundle), FROZEN),
    );
    if (JSON.stringify(tsResult) !== JSON.stringify(rsResult)) {
      fail("commit happy path returned different SessionInfo");
      console.error(`  TS: ${JSON.stringify(tsResult)}`);
      console.error(`  RS: ${JSON.stringify(rsResult)}`);
    }

    // --- TEST 2: Idempotent re-import ---
    const tsResult2 = await tsCommitBundle(dbA, bundle);
    const rsResult2 = JSON.parse(
      addon.commitSharedContextImportBundleJson(B, JSON.stringify(bundle), FROZEN),
    );
    if (JSON.stringify(tsResult2) !== JSON.stringify(rsResult2)) {
      fail("commit idempotent re-import returned different SessionInfo");
    }

    // --- TEST 3: Identity guard (all clauses should throw, no writes) ---
    const guardCases = [
      { mutate: (b) => { b.contextMessage.info.sessionID = "wrong"; }, label: "context session mismatch" },
      { mutate: (b) => { b.provenance.sessionID = "wrong"; }, label: "provenance session mismatch" },
      { mutate: (b) => { b.provenance.id = "bare-no-session"; }, label: "provenance namespace" },
      { mutate: (b) => { b.contextMessage.info.role = "assistant"; }, label: "wrong role" },
      { mutate: (b) => { b.contextMessage.info.visibility = "full"; }, label: "wrong visibility" },
      { mutate: (b) => { b.contextMessage.info.source = "other"; }, label: "wrong source" },
    ];

    for (const { mutate, label } of guardCases) {
      const bad = buildBundle();
      // Change session.id to something not yet in DB so the guard fires before idempotency
      bad.session.id = `guard-test-${label.replace(/\s/g, "-")}`;
      bad.contextMessage.info.sessionID = bad.session.id;
      bad.provenance.sessionID = bad.session.id;
      bad.provenance.id = `prov-${bad.session.id}-x`;
      mutate(bad);

      let tsErr = null;
      let rsErr = null;
      try {
        await tsCommitBundle(dbA, bad);
      } catch (e) {
        tsErr = e.message;
      }
      try {
        addon.commitSharedContextImportBundleJson(B, JSON.stringify(bad), FROZEN);
      } catch (e) {
        rsErr = e.message || String(e);
      }
      if (tsErr !== "Shared context import bundle identity is invalid") {
        fail(`guard (${label}): TS did not throw identity error`, tsErr);
      }
      if (!rsErr || !rsErr.includes("Shared context import bundle identity is invalid")) {
        fail(`guard (${label}): RS did not throw identity error`, rsErr);
      }
    }

    // --- TEST 4: Transition success ---
    const transitionInput = {
      sessionID: SESSION_ID,
      contextId: "ctx-parity-1",
      expectedStatus: ["pending", "reserved"],
      status: "reserved",
      sourceId: "src-audit-42",
    };
    const tsTransResult = await tsTransition(dbA, transitionInput);
    const rsTransResult = addon.transitionSharedContextImportJson(
      B, JSON.stringify(transitionInput), FROZEN,
    );
    if (tsTransResult !== true || rsTransResult !== "true") {
      fail("transition should return true", `TS=${tsTransResult} RS=${rsTransResult}`);
    }

    // --- TEST 5: Transition guard (entry missing) ---
    const missInput = {
      sessionID: SESSION_ID,
      contextId: "no-such-context",
      expectedStatus: "pending",
      status: "attached",
    };
    const tsMiss = await tsTransition(dbA, missInput);
    const rsMiss = addon.transitionSharedContextImportJson(B, JSON.stringify(missInput), FROZEN);
    if (tsMiss !== false || rsMiss !== "false") {
      fail("transition missing entry should return false", `TS=${tsMiss} RS=${rsMiss}`);
    }

    // --- TEST 6: Transition guard (status mismatch) ---
    const mismatchInput = {
      sessionID: SESSION_ID,
      contextId: "ctx-parity-1",
      expectedStatus: "pending",
      status: "discarded",
    };
    const tsMismatch = await tsTransition(dbA, mismatchInput);
    const rsMismatch = addon.transitionSharedContextImportJson(B, JSON.stringify(mismatchInput), FROZEN);
    if (tsMismatch !== false || rsMismatch !== "false") {
      fail("transition status mismatch should return false", `TS=${tsMismatch} RS=${rsMismatch}`);
    }
  } finally {
    dbA.close();
    Date.now = realNow;
  }

  // --- TEST 7: ATOMIC ROLLBACK (FK violation) ---
  const C = join(dir, "rollback_ts.sqlite");
  const D = join(dir, "rollback_rs.sqlite");
  addon.bootstrapSessionStoreJson(C, 5000, Date.now());
  addon.bootstrapSessionStoreJson(D, 5000, Date.now());

  const badBundle = buildBundle();
  badBundle.session.id = "rollback-test-sess";
  badBundle.contextMessage.info.sessionID = "rollback-test-sess";
  badBundle.provenance.sessionID = "rollback-test-sess";
  badBundle.provenance.id = "prov-rollback-test-sess-001";
  // Part references a non-existent message -> FK violation on part insert.
  badBundle.contextMessage.parts = [
    {
      id: "fb-part",
      sessionID: "rollback-test-sess",
      messageID: "nonexistent-msg-xyz",
      type: "text",
      text: "should trigger rollback",
    },
  ];

  const dbC = new DatabaseSync(C);
  dbC.exec("PRAGMA foreign_keys = ON");
  let tsRollErr = null;
  let rsRollErr = null;
  const realNowRoll = Date.now;
  Date.now = () => FROZEN;
  try {
    await tsCommitBundle(dbC, badBundle);
  } catch (e) {
    tsRollErr = e.message;
  }
  try {
    addon.commitSharedContextImportBundleJson(D, JSON.stringify(badBundle), FROZEN);
  } catch (e) {
    rsRollErr = e.message || String(e);
  }
  Date.now = realNowRoll;
  if (!tsRollErr) fail("rollback test: TS should have thrown FK error");
  if (!rsRollErr) fail("rollback test: RS should have thrown FK error");
  // Both should fail but the session must NOT exist in either DB (full rollback).
  const tsSession = sessionRepo.getSession(dbC, "rollback-test-sess");
  dbC.close();
  const rsSession = JSON.parse(addon.getSessionJson(D, "rollback-test-sess"));
  if (tsSession !== null) fail("rollback test: TS session should not exist after rollback");
  if (rsSession !== null) fail("rollback test: RS session should not exist after rollback");

  // --- Final byte-compare: dump all touched tables from the happy-path DBs A and B ---
  const dump = (path) => {
    const ro = new DatabaseSync(path, { readOnly: true });
    const out = {
      sessions: ro.prepare(
        "SELECT * FROM session ORDER BY id",
      ).all(),
      messages: ro.prepare(
        "SELECT * FROM message ORDER BY id",
      ).all(),
      parts: ro.prepare(
        "SELECT * FROM part ORDER BY id",
      ).all(),
      entries: ro.prepare(
        "SELECT * FROM session_entry ORDER BY id",
      ).all(),
    };
    ro.close();
    return JSON.stringify(out);
  };

  const dumpA = dump(A);
  const dumpB = dump(B);
  if (dumpA === dumpB) {
    // Sanity assertions: the import actually happened
    const parsed = JSON.parse(dumpA);
    const sess = parsed.sessions.find((s) => s.id === SESSION_ID);
    if (!sess) fail("sanity: imported session missing from dump");
    const msg = parsed.messages.find((m) => m.id === "sc-msg-1");
    if (!msg) fail("sanity: imported message missing from dump");
    const part = parsed.parts.find((p) => p.id === "sc-part-1");
    if (!part) fail("sanity: imported part missing from dump");
    const entry = parsed.entries.find((e) => e.id === `prov-${SESSION_ID}-001`);
    if (!entry) fail("sanity: provenance entry missing from dump");
    // Verify the transition applied: entry data should have status "reserved" and sourceId
    if (entry && !entry.data.includes('"status":"reserved"')) {
      fail("sanity: entry status should be reserved after transition", entry.data);
    }
    if (entry && !entry.data.includes('"sourceId":"src-audit-42"')) {
      fail("sanity: entry should have sourceId after transition", entry.data);
    }
    // Verify message metadata got stamped
    if (msg && !msg.data.includes('"sharedContextStatus":"reserved"')) {
      fail("sanity: message should have sharedContextStatus after transition", msg.data);
    }
    if (!failed) {
      console.log(
        "SHARED CONTEXT WRITE PARITY: OK - commit + transition + idempotency + " +
        "identity guard (all 6 clauses) + rollback + status transition guards byte-identical",
      );
    }
  } else {
    fail("final DB state dump differs between TS and Rust");
    // Print a compact diff for debugging
    const a = JSON.parse(dumpA);
    const b = JSON.parse(dumpB);
    for (const table of ["sessions", "messages", "parts", "entries"]) {
      if (JSON.stringify(a[table]) !== JSON.stringify(b[table])) {
        console.error(`  Table '${table}' differs:`);
        console.error(`    TS: ${JSON.stringify(a[table]).slice(0, 500)}`);
        console.error(`    RS: ${JSON.stringify(b[table]).slice(0, 500)}`);
      }
    }
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}
process.exit(failed);
