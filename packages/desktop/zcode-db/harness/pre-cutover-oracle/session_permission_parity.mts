// Read-op parity for getProjectPermission: tier-1 (local_setting ruleset), tier-2 (legacy
// permission.data fallback), and neither → null. Throwaway migrated+seeded DB; never the live store.
import { DatabaseSync } from "node:sqlite";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getProjectPermission } from "/media/hdd1/ZCode/apps/zcode-cli/packages/adapters/src/storage/session-store/repositories/local-settings.ts";

const require = createRequire(import.meta.url);
const addon = require("/media/hdd1/ZCode/packages/desktop/zcode-db/zcode_db.node");

const dir = mkdtempSync(join(tmpdir(), "zcode-perm-parity-"));
const path = join(dir, "db.sqlite");
let failed = 0;

try {
  addon.bootstrapSessionStoreJson(path, 5000, Date.now());
  const seed = new DatabaseSync(path);
  // tier-1: a local_setting ruleset.
  seed
    .prepare(
      `insert into local_setting (scope, scope_id, namespace, key, value, schema_version, time_created, time_updated)
       values ('project','projLS','permission','ruleset',?,1,1,1)`,
    )
    .run('{"mode":"yolo","allow":["bash"],"nested":{"x":1}}');
  // tier-2: a legacy permission row with no matching local_setting.
  seed
    .prepare(
      `insert into permission (project_id, time_created, time_updated, data) values (?,?,?,?)`,
    )
    .run("projP", 1, 1, '{"legacy":true,"rules":[]}');
  seed.close();

  const read = new DatabaseSync(path, { readOnly: true });
  const cases = [
    ["tier-1 local_setting", "projLS"],
    ["tier-2 legacy permission", "projP"],
    ["neither → null", "projNone"],
  ];
  for (const [label, pid] of cases) {
    const ts = await getProjectPermission(read, pid);
    const rs = JSON.parse(addon.getProjectPermissionJson(path, pid));
    const a = JSON.stringify(ts);
    const b = JSON.stringify(rs);
    if (a !== b) {
      console.error(`${label} PARITY DIFFERS\n  TS: ${a}\n  RS: ${b}`);
      failed = 1;
    }
  }
  read.close();
  if (!failed)
    console.log("PERMISSION READ PARITY: OK — tier-1, tier-2 fallback, and null identical");
} finally {
  rmSync(dir, { recursive: true, force: true });
}
process.exit(failed);
