// Read-op parity for readTarget (readSessionTarget, sync). Covers a row with all optionals null and
// one fully populated; key order + null passthrough must match decodeTargetRow. Throwaway DB.
import { DatabaseSync } from "node:sqlite";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readSessionTarget } from "/media/hdd1/ZCode/apps/zcode-cli/packages/adapters/src/storage/session-target.ts";

const require = createRequire(import.meta.url);
const addon = require("/media/hdd1/ZCode/packages/desktop/zcode-db/zcode_db.node");

const dir = mkdtempSync(join(tmpdir(), "zcode-target-"));
const path = join(dir, "db.sqlite");
let failed = 0;
const CHECK = (l: string, a: unknown, b: unknown) => {
  const x = JSON.stringify(a);
  const y = JSON.stringify(b);
  if (x !== y) {
    console.error(`${l} DIFFERS\n  TS: ${x}\n  RS: ${y}`);
    failed = 1;
  }
};

try {
  addon.bootstrapSessionStoreJson(path, 5000, Date.now());
  const seed = new DatabaseSync(path);
  seed.exec(
    `insert into session (id,project_id,slug,directory,title,version,time_created,time_updated)
     values ('s1','p','s','/d','t','v',1,1),('s2','p','s','/d','t','v',1,1),('s3','p','s','/d','t','v',1,1)`,
  );
  const cols =
    "session_id,target_id,objective,summary_title,status,token_budget,tokens_used,time_used_seconds,active_input_id,active_run_started_at,active_run_last_seen_at,time_created,time_updated";
  // minimal: null optionals.
  seed
    .prepare(`insert into session_target (${cols}) values (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run("s1", "t1", "obj", null, "active", null, 0, 0, null, null, null, 10, 20);
  // full: every optional set.
  seed
    .prepare(`insert into session_target (${cols}) values (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run("s2", "t2", "obj2", "sum", "paused", 5000, 123, 45, "ai1", 111, 222, 30, 40);
  seed.close();

  const read = new DatabaseSync(path, { readOnly: true });
  CHECK(
    "minimal",
    readSessionTarget(read, { sessionID: "s1" }),
    JSON.parse(addon.readTargetJson(path, "s1")),
  );
  CHECK(
    "full",
    readSessionTarget(read, { sessionID: "s2" }),
    JSON.parse(addon.readTargetJson(path, "s2")),
  );
  CHECK(
    "missing",
    readSessionTarget(read, { sessionID: "s3" }),
    JSON.parse(addon.readTargetJson(path, "s3")),
  );
  read.close();
  if (!failed)
    console.log("TARGET READ PARITY: OK — null-passthrough + full row + missing identical");
} finally {
  rmSync(dir, { recursive: true, force: true });
}
process.exit(failed);
