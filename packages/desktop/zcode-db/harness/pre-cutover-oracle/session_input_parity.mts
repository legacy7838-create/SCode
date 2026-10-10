// Read-op parity for session_input (listSessionInputs + getSessionInputById). Exercises payload
// object-merge key order, optional-field presence/absence, delivery/status coercion, and
// admitted_sequence ordering. Throwaway migrated+seeded DB; never the live store.
import { DatabaseSync } from "node:sqlite";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  listSessionInputs,
  getSessionInputById,
} from "/media/hdd1/ZCode/apps/zcode-cli/packages/adapters/src/storage/session-store/repositories/session-inputs.ts";

const require = createRequire(import.meta.url);
const addon = require("/media/hdd1/ZCode/packages/desktop/zcode-db/zcode_db.node");

const dir = mkdtempSync(join(tmpdir(), "zcode-input-parity-"));
const path = join(dir, "db.sqlite");
const sid = "sess-1";
let failed = 0;

try {
  addon.bootstrapSessionStoreJson(path, 5000, Date.now());
  const seed = new DatabaseSync(path);
  seed.exec(
    `insert into session (id, project_id, slug, directory, title, version, time_created, time_updated)
     values ('${sid}','p','s','/d','t','v',1,1)`,
  );
  const cols =
    "id, session_id, kind, delivery, payload, admitted_sequence, promoted_sequence, promoted_message_id, status, status_reason, time_created, time_updated";
  // Deliberately out of admitted_sequence order to test ordering.
  seed
    .prepare(`insert into session_input (${cols}) values (?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run("c", sid, "user", "queue", '{"foo":2}', 2, null, null, "cancelled", "dropped", 5, 5);
  seed
    .prepare(`insert into session_input (${cols}) values (?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(
      "a",
      sid,
      "user",
      "queue",
      '{"text":"hi","extra":1}',
      0,
      null,
      null,
      "admitted",
      null,
      1,
      1,
    );
  seed
    .prepare(`insert into session_input (${cols}) values (?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run("b", sid, "user", "guide", "not-json", 1, 0, "m1", "promoted", null, 2, 2);
  seed.close();

  const read = new DatabaseSync(path, { readOnly: true });
  const tsAll = await listSessionInputs(read, { sessionID: sid });
  const tsAdmitted = await listSessionInputs(read, { sessionID: sid, status: "admitted" });
  const tsById = await getSessionInputById(read, "b");
  const tsMissing = await getSessionInputById(read, "zzz");
  read.close();

  const checks = [
    ["list all", tsAll, JSON.parse(addon.listSessionInputsJson(path, sid, null))],
    ["list by status", tsAdmitted, JSON.parse(addon.listSessionInputsJson(path, sid, "admitted"))],
    ["get by id", tsById, JSON.parse(addon.getSessionInputByIdJson(path, "b"))],
    ["get missing", tsMissing, JSON.parse(addon.getSessionInputByIdJson(path, "zzz"))],
  ];
  for (const [name, ts, rs] of checks) {
    const a = JSON.stringify(ts);
    const b = JSON.stringify(rs);
    if (a !== b) {
      console.error(`${name} PARITY DIFFERS\n  TS: ${a}\n  RS: ${b}`);
      failed = 1;
    }
  }
  if (!failed)
    console.log(
      "SESSION INPUT READ PARITY: OK — 4 cases identical (merge order, coercion, optional fields, ordering)",
    );
} finally {
  rmSync(dir, { recursive: true, force: true });
}
process.exit(failed);
