// Read-op parity for getScriptWorkflowRun/listScriptWorkflowRuns. Covers a minimal run (JSON cols null
// → omitted) and a fully-populated run, list filters (statuses/cwd/limit), and missing → null.
import { DatabaseSync } from "node:sqlite";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getScriptWorkflowRun,
  listScriptWorkflowRuns,
} from "/media/hdd1/ZCode/apps/zcode-cli/packages/adapters/src/storage/session-store/repositories/script-workflow-runs.ts";

const require = createRequire(import.meta.url);
const addon = require("/media/hdd1/ZCode/packages/desktop/zcode-db/zcode_db.node");

const dir = mkdtempSync(join(tmpdir(), "zcode-wfruns-"));
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
  seed
    .prepare(
      `insert into workflow_run (id,name,kind,cwd,script_hash,status,budget_spent,time_created,time_updated)
       values ('r_min','n','script','/x','h','pending',0,10,100)`,
    )
    .run();
  seed
    .prepare(
      `insert into workflow_run (id,definition_id,name,kind,parent_session_id,cwd,script_path,script_hash,args_json,args_hash,status,current_phase,budget_total,budget_spent,stats_json,failure_json,time_created,time_started,time_updated,time_completed)
       values ('r_full','def1','n2','script','ps','/y','/sp','h2','{"a":1}','ah','running','ph',100,5,'{}','{"e":2}',20,21,200,22)`,
    )
    .run();
  seed.close();

  const read = new DatabaseSync(path, { readOnly: true });
  await CHECK(
    "get r_min",
    await getScriptWorkflowRun(read, "r_min"),
    JSON.parse(addon.getScriptWorkflowRunJson(path, "r_min")),
  );
  await CHECK(
    "get r_full",
    await getScriptWorkflowRun(read, "r_full"),
    JSON.parse(addon.getScriptWorkflowRunJson(path, "r_full")),
  );
  await CHECK(
    "get missing",
    await getScriptWorkflowRun(read, "zzz"),
    JSON.parse(addon.getScriptWorkflowRunJson(path, "zzz")),
  );
  await CHECK(
    "list all",
    await listScriptWorkflowRuns(read, {}),
    JSON.parse(addon.listScriptWorkflowRunsJson(path, "{}")),
  );
  await CHECK(
    "list statuses pending",
    await listScriptWorkflowRuns(read, { statuses: ["pending", "bogus"] }),
    JSON.parse(addon.listScriptWorkflowRunsJson(path, '{"statuses":["pending","bogus"]}')),
  );
  await CHECK(
    "list cwd /y",
    await listScriptWorkflowRuns(read, { cwd: "/y" }),
    JSON.parse(addon.listScriptWorkflowRunsJson(path, '{"cwd":"/y"}')),
  );
  await CHECK(
    "list limit 1",
    await listScriptWorkflowRuns(read, { limit: 1 }),
    JSON.parse(addon.listScriptWorkflowRunsJson(path, '{"limit":1}')),
  );
  read.close();
  if (!failed)
    console.log("WORKFLOW RUNS READ PARITY: OK — minimal/full get + 4 list cases identical");
} finally {
  rmSync(dir, { recursive: true, force: true });
}
process.exit(failed);
