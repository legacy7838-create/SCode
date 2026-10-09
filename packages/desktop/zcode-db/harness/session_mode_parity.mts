// Read-op parity for getProjectPermissionMode (sync). Covers valid enum, non-enum, missing/empty,
// non-object/array payloads, and the invalid-JSON throw path (both sides must raise). Throwaway DB.
import { DatabaseSync } from "node:sqlite";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getProjectPermissionMode } from "/media/hdd1/ZCode/apps/zcode-cli/packages/adapters/src/storage/session-store/repositories/local-settings.ts";

const require = createRequire(import.meta.url);
const addon = require("/media/hdd1/ZCode/packages/desktop/zcode-db/zcode_db.node");

const dir = mkdtempSync(join(tmpdir(), "zcode-mode-parity-"));
const path = join(dir, "db.sqlite");
let failed = 0;

try {
  addon.bootstrapSessionStoreJson(path, 5000, Date.now());
  const seed = new DatabaseSync(path);
  const put = (id: string, value: string) =>
    seed
      .prepare(
        `insert into local_setting (scope, scope_id, namespace, key, value, schema_version, time_created, time_updated)
         values ('project',?,'permission','mode',?,1,1,1)`,
      )
      .run(id, value);
  put("m_yolo", '{"mode":"yolo"}');
  put("m_bad", '{"mode":"bogus"}');
  put("m_nomode", '{"x":1}');
  put("m_num", "5");
  put("m_arr", '[{"mode":"yolo"}]');
  put("m_empty", "");
  put("m_invalid", "{bad");
  seed.close();

  const read = new DatabaseSync(path, { readOnly: true });
  const scalar = [
    ["m_yolo", '"yolo"'],
    ["m_bad", "null"],
    ["m_nomode", "null"],
    ["m_num", "null"],
    ["m_arr", "null"],
    ["m_empty", "null"],
    ["m_none", "null"],
  ] as const;
  for (const [pid, expect] of scalar) {
    const ts = JSON.stringify(getProjectPermissionMode(read, pid));
    const rs = addon.getProjectPermissionModeJson(path, pid);
    if (ts !== rs) {
      console.error(`${pid} PARITY DIFFERS\n  TS: ${ts}\n  RS: ${rs}\n  exp: ${expect}`);
      failed = 1;
    }
  }
  // invalid JSON: both sides must throw.
  let tsThrew = false;
  let rsThrew = false;
  try {
    getProjectPermissionMode(read, "m_invalid");
  } catch {
    tsThrew = true;
  }
  try {
    addon.getProjectPermissionModeJson(path, "m_invalid");
  } catch {
    rsThrew = true;
  }
  read.close();
  if (tsThrew !== rsThrew) {
    console.error(`m_invalid throw parity differs: TS=${tsThrew} RS=${rsThrew}`);
    failed = 1;
  }
  if (!failed)
    console.log("PERMISSION MODE READ PARITY: OK — 7 scalar cases + invalid-JSON throw match");
} finally {
  rmSync(dir, { recursive: true, force: true });
}
process.exit(failed);
