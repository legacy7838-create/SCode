// Read-op parity for queryTaskUsage (integer accumulation). Covers main_turn baseline growth +
// compaction lowering the baseline, a non-baseline source (cache add + distance branch), provider vs
// computed total, error status counting, and an empty session. Throwaway DB.
import { DatabaseSync } from "node:sqlite";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { queryTaskUsage } from "/media/hdd1/ZCode/apps/zcode-cli/packages/adapters/src/storage/session-store/repositories/usage.ts";

const require = createRequire(import.meta.url);
const addon = require("/media/hdd1/ZCode/packages/desktop/zcode-db/zcode_db.node");

const dir = mkdtempSync(join(tmpdir(), "zcode-usage-"));
const path = join(dir, "db.sqlite");
let failed = 0;
const CHECK = async (l: string, sid: string) => {
  const read = new DatabaseSync(path, { readOnly: true });
  const ts = await queryTaskUsage(read, { sessionID: sid });
  read.close();
  const rs = JSON.parse(addon.queryTaskUsageJson(path, sid));
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
    `insert into session (id,project_id,slug,directory,title,version,time_created,time_updated) values ('su','p','s','/d','t','v',1,1),('empty','p','s','/d','t','v',1,1)`,
  );
  const cols =
    "id,logical_request_id,session_id,query_source,provider_id,model_id,status,started_at,input_tokens,output_tokens,reasoning_tokens,cache_creation_input_tokens,cache_read_input_tokens,computed_total_tokens,provider_total_tokens";
  const mu = seed.prepare(
    `insert into model_usage (${cols}) values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  );
  mu.run("r1", "lr1", "su", "main_turn", "pr", "md", "completed", 1, 100, 50, 5, 0, 0, 150, null);
  mu.run("r2", "lr2", "su", "main_turn", "pr", "md", "completed", 2, 80, 20, 0, 0, 0, 100, null);
  mu.run("r3", "lr3", "su", "utility", "pr", "md", "completed", 3, 10, 2, 0, 5, 3, 20, null);
  mu.run("r4", "lr4", "su", "subagent", "pr", "md", "completed", 4, 5, 1, 1, 0, 0, 0, 40);
  mu.run("r5", "lr5", "su", "main_turn", "pr", "md", "error", 5, 0, 0, 0, 0, 0, 0, null);
  seed.close();

  await CHECK("session su", "su");
  await CHECK("empty session", "empty");
  await CHECK("missing session", "nope");
  if (!failed)
    console.log(
      "USAGE TASK READ PARITY: OK — baseline/compaction/cache/provider/error/empty identical",
    );
} finally {
  rmSync(dir, { recursive: true, force: true });
}
process.exit(failed);
