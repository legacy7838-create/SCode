// WRITE-parity harness for the `saveSessionInput` op. Real TS `saveSessionInput` (DB copy A) vs the
// Rust addon `saveSessionInputJson` (DB copy B), driven by the SAME fixed arguments through a
// three-step script:
//   1) admit a new input i1   -> admitted_sequence starts the per-session ledger at 0;
//   2) admit a second input i2 -> the auto-increment subquery yields the next sequence;
//   3) re-admit i1 with changed kind/delivery/payload -> the `on conflict(id) do update` path fixes
//      the row IN PLACE without bumping admitted_sequence and without touching status.
// Timestamps (`time_created`/`time_updated`) are deliberately NOT compared: the TS reads `Date.now()`
// internally while the Rust `now` is injected, so only the deterministic ledger columns are checked.
// Both copies get a parent `session` row (session_input.session_id FK -> session). Throwaway /tmp DBs;
// NEVER the live store.
import { DatabaseSync } from "node:sqlite";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { saveSessionInput } from "/media/hdd1/ZCode/apps/zcode-cli/packages/adapters/src/storage/session-store/repositories/session-inputs.ts";

const require = createRequire(import.meta.url);
// Resolve the addon relative to this harness so it picks up the freshly built `.node` in the
// current checkout (worktree or main), never a stale copy elsewhere.
const here = join(fileURLToPath(import.meta.url), "..");
const addon = require(join(here, "..", "zcode_db.node"));

// JSON.stringify key order is not a parity contract; canonicalize the payload column before compare.
const canonicalize = (v: unknown): unknown =>
  Array.isArray(v)
    ? v.map(canonicalize)
    : v && typeof v === "object"
      ? Object.fromEntries(
          Object.keys(v as object)
            .sort()
            .map((k) => [k, canonicalize((v as Record<string, unknown>)[k])]),
        )
      : v;

const dir = mkdtempSync(join(tmpdir(), "zcode-input-write-parity-"));
const A = join(dir, "ts.sqlite");
const B = join(dir, "rs.sqlite");

// Fixed args shared by both sides. The Rust clock (`now`) is irrelevant to the compared columns.
const NOW = 1_700_000_000_000;
const P1 = { text: "first" };
const P2 = { text: "second" };
const P1b = { text: "first-changed", extra: 7 };

const SEED = `insert into session (id,project_id,slug,directory,title,version,time_created,time_updated)
  values ('s1','p','s','/d','t','v',1,1)`;
const DUMP =
  "select id, kind, delivery, payload, admitted_sequence, status from session_input order by admitted_sequence";

function bootstrap(path: string): void {
  addon.bootstrapSessionStoreJson(path, 5000, Date.now());
  const seed = new DatabaseSync(path);
  seed.exec("PRAGMA foreign_keys = ON");
  seed.exec(SEED);
  seed.close();
}

function dump(path: string): string {
  const db = new DatabaseSync(path, { readOnly: true });
  const rows = db.prepare(DUMP).all() as Array<Record<string, unknown>>;
  db.close();
  return JSON.stringify(
    rows.map((r) => ({
      id: r.id,
      kind: r.kind,
      delivery: r.delivery,
      payload: canonicalize(JSON.parse(String(r.payload))),
      admitted_sequence: r.admitted_sequence,
      status: r.status,
    })),
  );
}

let failed = 0;
try {
  bootstrap(A);
  bootstrap(B);

  // ---- TS side (copy A): call the real saveSessionInput (uses Date.now() internally). ----
  const dbA = new DatabaseSync(A);
  dbA.exec("PRAGMA foreign_keys = ON");
  await saveSessionInput(dbA, { id: "i1", sessionID: "s1", kind: "user", delivery: "queue", payload: P1 });
  await saveSessionInput(dbA, { id: "i2", sessionID: "s1", kind: "user", delivery: "queue", payload: P2 });
  await saveSessionInput(dbA, {
    id: "i1",
    sessionID: "s1",
    kind: "system",
    delivery: "startNow",
    payload: P1b,
  });
  dbA.close();

  // ---- Rust side (copy B): the addon with the same fixed args + injected now. ----
  addon.saveSessionInputJson(B, "i1", "s1", "user", "queue", JSON.stringify(P1), NOW);
  addon.saveSessionInputJson(B, "i2", "s1", "user", "queue", JSON.stringify(P2), NOW);
  addon.saveSessionInputJson(B, "i1", "s1", "system", "startNow", JSON.stringify(P1b), NOW);

  const a = dump(A);
  const b = dump(B);
  if (a !== b) {
    console.error("SESSION-INPUT WRITE PARITY DIFFERS\n  TS:", a, "\n  RS:", b);
    failed = 1;
  } else {
    // Sanity: the ledger auto-incremented (0 then 1) and the re-admit kept i1 at its original order.
    const parsed = JSON.parse(a) as Array<{ id: string; admitted_sequence: number; status: string }>;
    const seq = Object.fromEntries(parsed.map((r) => [r.id, r.admitted_sequence]));
    if (parsed.length !== 2 || seq.i1 !== 0 || seq.i2 !== 1 || parsed.some((r) => r.status !== "admitted")) {
      console.error(`UNEXPECTED LEDGER STATE (expected i1=0, i2=1, both admitted, i-seq not bumped):`, a);
      failed = 1;
    } else {
      console.log(
        "SESSION-INPUT WRITE PARITY: OK — insert/increment/upsert-in-place identical (TS == Rust)",
      );
    }
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}
process.exit(failed);
