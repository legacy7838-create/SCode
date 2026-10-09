// Read-op parity for listScriptWorkflowActivities + listScriptWorkflowEvents. Covers JSON cols
// (result/opts/error, payload), optional-field omission, call_index/id ordering, and the events
// limit branch (newest N re-ascending). Throwaway DB, rows FK-parented to a real workflow_run.
import { DatabaseSync } from "node:sqlite";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  listScriptWorkflowActivities,
  listScriptWorkflowEvents,
} from "/media/hdd1/ZCode/apps/zcode-cli/packages/adapters/src/storage/session-store/repositories/script-workflow-activities.ts";

const require = createRequire(import.meta.url);
const addon = require("/media/hdd1/ZCode/packages/desktop/zcode-db/zcode_db.node");

const dir = mkdtempSync(join(tmpdir(), "zcode-wfchild-"));
const path = join(dir, "db.sqlite");
let failed = 0;
const CHECK = async (l: string, ts: unknown, rs: unknown) => {
  const x = JSON.stringify(ts);
  const y = JSON.stringify(rs);
  if (x !== y) {
    console.error(`${l} DIFFERS\n  TS: ${x}\n  RS: ${y}`);
    failed = 1;
  }
};

try {
  addon.bootstrapSessionStoreJson(path, 5000, Date.now());
  const seed = new DatabaseSync(path);
  seed.exec(
    `insert into session (id,project_id,slug,directory,title,version,time_created,time_updated) values ('ps','p','s','/d','t','v',1,1)`,
  );
  seed.exec(
    `insert into workflow_run (id,name,kind,cwd,script_hash,status,budget_spent,time_created,time_updated) values ('r1','n','script','/x','h','running',0,10,100)`,
  );
  const ac = seed.prepare(
    `insert into workflow_activity (id,run_id,call_index,attempt,call_path,type,input_hash,status,time_created,time_updated,result_json,opts_json,error_json,prompt,label,phase,child_session_id,parent_activity_id,time_started,time_completed)
     values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  );
  ac.run(
    "a1",
    "r1",
    0,
    1,
    "p/0",
    "ask",
    "h1",
    "completed",
    10,
    10,
    '{"ok":true}',
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    11,
  );
  ac.run(
    "a2",
    "r1",
    1,
    2,
    "p/1",
    "tool",
    "h2",
    "failed",
    20,
    20,
    null,
    '{"o":1}',
    '{"e":"x"}',
    "pp",
    "lbl",
    "ph",
    "ps",
    "a1",
    21,
    22,
  );
  const ev = seed.prepare(
    `insert into workflow_event (id,run_id,sequence,type,payload_json,phase,activity_id,time_created) values (?,?,?,?,?,?,?,?)`,
  );
  ev.run("e1", "r1", 1, "start", '{"x":1}', null, null, 1);
  ev.run("e2", "r1", 2, "tick", null, "ph", "a1", 2);
  ev.run("e3", "r1", 3, "done", "[]", null, null, 3);
  seed.close();

  const read = new DatabaseSync(path, { readOnly: true });
  await CHECK(
    "activities",
    await listScriptWorkflowActivities(read, { runId: "r1" }),
    JSON.parse(addon.listScriptWorkflowActivitiesJson(path, "r1")),
  );
  await CHECK(
    "events all",
    await listScriptWorkflowEvents(read, { runId: "r1" }),
    JSON.parse(addon.listScriptWorkflowEventsJson(path, "r1", null)),
  );
  await CHECK(
    "events limit 2",
    await listScriptWorkflowEvents(read, { runId: "r1", limit: 2 }),
    JSON.parse(addon.listScriptWorkflowEventsJson(path, "r1", 2)),
  );
  await CHECK(
    "activities empty run",
    await listScriptWorkflowActivities(read, { runId: "nope" }),
    JSON.parse(addon.listScriptWorkflowActivitiesJson(path, "nope")),
  );
  read.close();
  if (!failed)
    console.log(
      "WORKFLOW ACTIVITIES/EVENTS PARITY: OK — json cols, omission, ordering, limit re-asc identical",
    );
} finally {
  rmSync(dir, { recursive: true, force: true });
}
process.exit(failed);
