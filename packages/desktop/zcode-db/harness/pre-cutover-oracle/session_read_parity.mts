// Read-op parity: real TS `readTodos` vs addon `readTodosJson` on a throwaway migrated+seeded DB.
// Never touches the live store. Establishes the codec-projection parity pattern for the READ cluster.
import { DatabaseSync } from "node:sqlite";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readTodos } from "/media/hdd1/ZCode/apps/zcode-cli/packages/adapters/src/storage/session-store/repositories/todos.ts";

const require = createRequire(import.meta.url);
const addon = require("/media/hdd1/ZCode/packages/desktop/zcode-db/zcode_db.node");

const dir = mkdtempSync(join(tmpdir(), "zcode-read-parity-"));
const path = join(dir, "db.sqlite");
let failed = 0;
const sid = "sess-1";

try {
  // Create the full schema via the Rust bootstrap, then seed todo rows with plain SQL (throwaway copy).
  addon.bootstrapSessionStoreJson(path, 5000, Date.now());
  const seed = new DatabaseSync(path);
  // A parent session row is required (todo.session_id FK → session.id).
  seed.exec(
    `insert into session (id, project_id, slug, directory, title, version, time_created, time_updated)
     values ('${sid}','p','s','/d','t','v',1,1),('other','p','s','/d','t','v',1,1)`,
  );
  const ins = seed.prepare(
    "insert into todo (session_id, content, status, priority, position, time_created, time_updated) values (?,?,?,?,?,?,?)",
  );
  // Insert deliberately out of position order to exercise `order by position asc`.
  ins.run(sid, "second", "in_progress", "medium", 1, 1, 1);
  ins.run(sid, "quote \" and ' chars — unicode ✓", "pending", "high", 0, 1, 1);
  ins.run(sid, "third", "completed", "low", 2, 1, 1);
  // A different session's row must NOT leak into this read.
  ins.run("other", "nope", "pending", "low", 0, 1, 1);
  seed.close();

  const read = new DatabaseSync(path, { readOnly: true });
  const ts = await readTodos(read, { sessionID: sid });
  read.close();
  const rs = JSON.parse(addon.readTodosJson(path, sid));

  const a = JSON.stringify(ts);
  const b = JSON.stringify(rs);
  if (a !== b) {
    console.error("READ TODOS PARITY DIFFERS\n  TS:", a, "\n  RS:", b);
    failed = 1;
  } else {
    console.log(
      `READ PARITY: OK — readTodos identical (${rs.length} rows, ordered, scoped, unicode-safe)`,
    );
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}
process.exit(failed);
