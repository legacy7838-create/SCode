// Read-op parity for queryAppUsage (aggregations). Seeds model/turn/tool usage across two day buckets
// with multiple models/tools, error rows, null durations (avg ignores nulls), and a longest-session.
// Compares TS queryAppUsage vs addon.queryAppUsageJson over a shared [since,until] window (JSON.parse
// canonicalizes float formatting; equality checks the real values + ordering + merge + null handling).
import { DatabaseSync } from "node:sqlite";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { queryAppUsage } from "/media/hdd1/ZCode/apps/zcode-cli/packages/adapters/src/storage/session-store/repositories/usage.ts";

const require = createRequire(import.meta.url);
const addon = require("/media/hdd1/ZCode/packages/desktop/zcode-db/zcode_db.node");

const dir = mkdtempSync(join(tmpdir(), "zcode-appusage-"));
const path = join(dir, "db.sqlite");
let failed = 0;
const CHECK = async (label: string, since: number, until: number, tz: number) => {
  const read = new DatabaseSync(path, { readOnly: true });
  const ts = await queryAppUsage(read, { since, until, tzOffsetMs: tz });
  read.close();
  const rs = JSON.parse(addon.queryAppUsageJson(path, since, until, tz));
  const x = JSON.stringify(ts);
  const y = JSON.stringify(rs);
  if (x !== y) {
    console.error(`${label} DIFFERS\n  TS: ${x}\n  RS: ${y}`);
    failed = 1;
  }
};

try {
  addon.bootstrapSessionStoreJson(path, 5000, Date.now());
  const seed = new DatabaseSync(path);
  seed.exec(
    `insert into session (id,project_id,slug,directory,title,version,time_created,time_updated) values ('s1','p','s','/d','t','v',1,1),('s2','p','s','/d','t','v',1,1)`,
  );
  const mu = seed.prepare(
    `insert into model_usage (id,logical_request_id,session_id,query_source,provider_id,model_id,status,started_at,input_tokens,output_tokens,reasoning_tokens,cache_creation_input_tokens,cache_read_input_tokens,computed_total_tokens,time_to_first_token_ms)
     values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  );
  mu.run("u1", "l1", "s1", "main_turn", "p", "m1", "completed", 1000, 10, 5, 2, 1, 3, 100, 50);
  mu.run("u2", "l2", "s1", "main_turn", "p", "m1", "completed", 2000, 8, 4, 0, 0, 0, 80, null);
  mu.run("u3", "l3", "s2", "subagent", "p", "m2", "error", 90000000, 20, 10, 0, 0, 0, 200, 70);
  const tu = seed.prepare(
    `insert into turn_usage (session_id,turn_id,status,started_at,duration_ms) values (?,?,?,?,?)`,
  );
  tu.run("s1", "t1", "completed", 1000, 300);
  tu.run("s1", "t2", "completed", 2000, 500);
  tu.run("s1", "t3", "running", 90000000, null);
  tu.run("s2", "t4", "completed", 90000000, 1000);
  const ku = seed.prepare(
    `insert into tool_usage (id,session_id,tool_call_id,tool_name,status,started_at,duration_ms) values (?,?,?,?,?,?,?)`,
  );
  ku.run("k1", "s1", "c1", "grep", "completed", 1500, 40);
  ku.run("k2", "s1", "c2", "grep", "error", 2500, 60);
  ku.run("k3", "s2", "c3", "edit", "completed", 90000000, null);
  seed.close();

  await CHECK("full window", 0, 200000000, 0);
  await CHECK("tz offset 12h", 0, 200000000, 43200000);
  await CHECK("empty window → nulls/0", 500000000, 600000000, 0);
  if (!failed)
    console.log(
      "APP USAGE READ PARITY: OK — aggregates/avg/nulls/day-merge/ordering identical (3 windows)",
    );
} finally {
  rmSync(dir, { recursive: true, force: true });
}
process.exit(failed);
