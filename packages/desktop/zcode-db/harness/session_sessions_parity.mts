// Read-op parity for getSession/listSessions. Exercises decodeSessionRow's subtle rules:
// truthy fields (workspace/parent/trace/titleMessageID) omit on null OR ""; `?? undefined` fields
// (path/shareURL) keep ""; integer `?? undefined` keeps 0; task_type/title_source coercion; and
// listSessions ordering + filters (projectID/roots/includeArchived/taskTypes/limit). Throwaway DB.
import { DatabaseSync } from "node:sqlite";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getSession,
  listSessions,
} from "/media/hdd1/ZCode/apps/zcode-cli/packages/adapters/src/storage/session-store/repositories/sessions.ts";

const require = createRequire(import.meta.url);
const addon = require("/media/hdd1/ZCode/packages/desktop/zcode-db/zcode_db.node");

const dir = mkdtempSync(join(tmpdir(), "zcode-sess-read-"));
const path = join(dir, "db.sqlite");
let failed = 0;

const CHECK = (label: string, ts: unknown, rs: unknown) => {
  const a = JSON.stringify(ts);
  const b = JSON.stringify(rs);
  if (a !== b) {
    console.error(`${label} DIFFERS\n  TS: ${a}\n  RS: ${b}`);
    failed = 1;
  }
};

try {
  addon.bootstrapSessionStoreJson(path, 5000, Date.now());
  const seed = new DatabaseSync(path);
  // minimal: required only → task_type/title_source defaults, optionals null.
  seed
    .prepare(
      `insert into session (id, project_id, slug, directory, title, version, time_created, time_updated)
       values ('s_min','pA','slug','/a','t','v',10,100)`,
    )
    .run();
  // full: every optional present, summary int 0, valid JSON columns, non-default task_type.
  seed
    .prepare(
      `insert into session (id, project_id, workspace_id, parent_id, trace_id, task_type, slug,
        directory, path, title, title_source, title_message_id, version, share_url,
        summary_additions, summary_deletions, summary_files, summary_diffs, revert, permission,
        time_created, time_updated, time_title_updated, time_compacting, time_archived)
       values ('s_full','pB','ws1','root1','tr1','fork','slug','/b','/b/p','T','custom','tm1','v','sh',
        0, 5, 3, '[{"file":"a"}]', '{"k":"r"}', '{"mode":"build"}', 20, 200, 21, null, null)`,
    )
    .run();
  // empty-string edges: truthy fields "" (omit), path/shareURL "" (keep).
  seed
    .prepare(
      `insert into session (id, project_id, workspace_id, parent_id, trace_id, task_type, slug,
        directory, path, title, title_message_id, version, share_url, time_created, time_updated)
       values ('s_empty','pA','','','','bogus_task','slug','/e','','t','','v','',30,300)`,
    )
    .run();
  // archived (excluded unless includeArchived).
  seed
    .prepare(
      `insert into session (id, project_id, slug, directory, title, version, time_created, time_updated, time_archived)
       values ('s_arch','pA','slug','/x','t','v',40,400,999)`,
    )
    .run();
  seed.close();

  const read = new DatabaseSync(path, { readOnly: true });
  for (const id of ["s_min", "s_full", "s_empty", "s_none"]) {
    CHECK(`get ${id}`, getSession(read, id), JSON.parse(addon.getSessionJson(path, id)));
  }
  const listCases: Array<[string, unknown]> = [
    ["no filter", {}],
    ["includeArchived", { includeArchived: true }],
    ["projectID pA", { projectID: "pA" }],
    ["roots", { roots: true }],
    ["taskTypes fork", { taskTypes: ["fork", "bogus"] }],
    ["limit 1", { limit: 1 }],
  ];
  for (const [label, f] of listCases) {
    const ts = await listSessions(read, f as never);
    const rs = JSON.parse(addon.listSessionsJson(path, JSON.stringify(f)));
    CHECK(`list ${label}`, ts, rs);
  }
  read.close();
  if (!failed)
    console.log(
      "SESSION READ PARITY: OK — get(4) + list(6 filters) identical, incl empty-string/0/coercion/order rules",
    );
} finally {
  rmSync(dir, { recursive: true, force: true });
}
process.exit(failed);
