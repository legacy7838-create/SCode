// Read-op parity for recallPreviousInputHistory (async). Covers time_created desc/id desc ordering with
// a tiebreak, skip offset, and attachment normalization (trim path, drop data: content, drop invalid
// type, drop empty → omit; session_id "" → omit). Throwaway DB.
import { DatabaseSync } from "node:sqlite";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recallPreviousInputHistory } from "/media/hdd1/ZCode/apps/zcode-cli/packages/adapters/src/storage/session-store/repositories/input-history.ts";

const require = createRequire(import.meta.url);
const addon = require("/media/hdd1/ZCode/packages/desktop/zcode-db/zcode_db.node");

const dir = mkdtempSync(join(tmpdir(), "zcode-inphist-"));
const path = join(dir, "db.sqlite");
let failed = 0;
const CHECK = async (l: string, sid: string, skip: number) => {
  const read = new DatabaseSync(path, { readOnly: true });
  const ts = await recallPreviousInputHistory(read, { projectID: sid, skip });
  read.close();
  const rs = JSON.parse(addon.recallPreviousInputHistoryJson(path, sid, skip));
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
  const ins = seed.prepare(
    `insert into input_history (id, project_id, session_id, text, kind, time_created, attachments) values (?,?,?,?,?,?,?)`,
  );
  ins.run("ih1", "p1", null, "a", "prompt", 100, "[]");
  ins.run(
    "ih2",
    "p1",
    "ses",
    "b",
    "prompt",
    200,
    '[{"type":"file","path":"  /p  "},{"type":"image","content":"data:x"},{"type":"file","content":"plain"},{"type":"nope"}]',
  );
  ins.run("ih3", "p1", "", "c", "prompt", 200, '[{"type":"url","path":"  "}]');
  seed.close();

  for (const [label, skip] of [
    ["newest (id desc tiebreak)", 0],
    ["second", 1],
    ["oldest", 2],
    ["past end → null", 3],
  ] as const) {
    await CHECK(label, "p1", skip);
  }
  await CHECK("empty project → null", "p_none", 0);
  if (!failed)
    console.log(
      "INPUT-HISTORY READ PARITY: OK — ordering/skip/attachment-normalization/omit identical",
    );
} finally {
  rmSync(dir, { recursive: true, force: true });
}
process.exit(failed);
