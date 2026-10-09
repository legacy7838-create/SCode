// Read-op parity for sessionEntries (sync). Focus: the runtime/model_selection normalization vs raw
// fallback, key-order canonicalization, trim, strict rejection (unknown keys), options present/absent/
// empty/null, non-record data (omit), and non-model-selection passthrough (order preserved). Throwaway DB.
import { DatabaseSync } from "node:sqlite";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sessionEntries } from "/media/hdd1/ZCode/apps/zcode-cli/packages/adapters/src/storage/session-store/repositories/session-entries.ts";

const require = createRequire(import.meta.url);
const addon = require("/media/hdd1/ZCode/packages/desktop/zcode-db/zcode_db.node");

const dir = mkdtempSync(join(tmpdir(), "zcode-entries-"));
const path = join(dir, "db.sqlite");
const sid = "s1";
const MS = "runtime/model_selection";
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
  seed.exec(
    `insert into session (id, project_id, slug, directory, title, version, time_created, time_updated)
     values ('${sid}','p','s','/d','t','v',1,1)`,
  );
  const put = (id: string, type: string, data: unknown, tc: number) =>
    seed
      .prepare(
        `insert into session_entry (id, session_id, type, time_created, time_updated, data) values (?,?,?,?,?,?)`,
      )
      .run(id, sid, type, tc, tc, JSON.stringify(data));
  // non-model-selection passthrough: key order must survive.
  put("e_plain", "v4/custom", { foo: 1, bar: 2, baz: { x: [1, 2] } }, 10);
  put("e_null", "v4/nullish", null, 11);
  put("e_arr", "v4/list", [3, 1, 2], 12);
  // valid selection, non-canonical key order + untrimmed values → normalized {providerId,modelId,options}.
  put(
    "e_ms_ok",
    MS,
    { modelSelection: { options: { reasoningLevel: "high" }, modelId: " m ", providerId: " p " } },
    13,
  );
  put("e_ms_noopts", MS, { modelSelection: { providerId: "p", modelId: "m" } }, 14);
  put("e_ms_optsempty", MS, { modelSelection: { providerId: "p", modelId: "m", options: {} } }, 15);
  // invalid → raw modelSelection fallback (unknown top key; bad options key; empty trim; null options).
  put("e_ms_unknown", MS, { modelSelection: { providerId: "p", modelId: "m", zzz: 1 } }, 16);
  put(
    "e_ms_optunknown",
    MS,
    {
      modelSelection: { providerId: "p", modelId: "m", options: { reasoningLevel: "high", x: 1 } },
    },
    17,
  );
  put(
    "e_ms_emptyrl",
    MS,
    { modelSelection: { providerId: "p", modelId: "m", options: { reasoningLevel: "   " } } },
    18,
  );
  put("e_ms_optnull", MS, { modelSelection: { providerId: "p", modelId: "m", options: null } }, 19);
  put("e_ms_emptyprov", MS, { modelSelection: { providerId: "   ", modelId: "m" } }, 20);
  // model_selection whose data is not an object / lacks the key → data omitted.
  put("e_ms_notobj", MS, [1, 2, 3], 21);
  put("e_ms_nosub", MS, { other: 1 }, 22);
  seed.close();

  const read = new DatabaseSync(path, { readOnly: true });
  CHECK(
    "all",
    sessionEntries(read, { sessionID: sid }),
    JSON.parse(addon.sessionEntriesJson(path, sid, null)),
  );
  CHECK(
    "by type ms",
    sessionEntries(read, { sessionID: sid, type: MS }),
    JSON.parse(addon.sessionEntriesJson(path, sid, MS)),
  );
  CHECK(
    "by type plain",
    sessionEntries(read, { sessionID: sid, type: "v4/custom" }),
    JSON.parse(addon.sessionEntriesJson(path, sid, "v4/custom")),
  );
  read.close();
  if (!failed)
    console.log(
      "SESSION ENTRIES PARITY: OK — normalization/raw-fallback/order/omit cases identical",
    );
} finally {
  rmSync(dir, { recursive: true, force: true });
}
process.exit(failed);
