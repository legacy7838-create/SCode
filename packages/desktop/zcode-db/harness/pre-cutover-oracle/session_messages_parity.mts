// Read-op parity for messages/messageWithParts — the order-sensitive chat projection. Covers:
// user (strip `model`, normalize+append modelSelection / drop when invalid), assistant (strip
// providerID/modelID/variant), other-role passthrough, plain/timeline(model_change w/ from/to
// selection + label)/subtask parts, invalid-selection omission, and `sequence is null` ordering.
import { DatabaseSync } from "node:sqlite";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  messages,
  messageWithParts,
} from "/media/hdd1/ZCode/apps/zcode-cli/packages/adapters/src/storage/session-store/repositories/messages.ts";

const require = createRequire(import.meta.url);
const addon = require("/media/hdd1/ZCode/packages/desktop/zcode-db/zcode_db.node");

const dir = mkdtempSync(join(tmpdir(), "zcode-msgs-"));
const path = join(dir, "db.sqlite");
const sid = "s1";
let failed = 0;
const CHECK = (l: string, a: unknown, b: unknown) => {
  const x = JSON.stringify(a);
  const y = JSON.stringify(b);
  if (x !== y) {
    console.error(`${l} DIFFERS\n  TS: ${x}\n  RS: ${y}`);
    failed = 1;
  }
};

try {
  addon.bootstrapSessionStoreJson(path, 5000, Date.now());
  const seed = new DatabaseSync(path);
  seed.exec(
    `insert into session (id,project_id,slug,directory,title,version,time_created,time_updated) values ('${sid}','p','s','/d','t','v',1,1)`,
  );
  const msg = (id: string, seq: number | null, tc: number, data: unknown) =>
    seed
      .prepare(
        `insert into message (id,session_id,time_created,time_updated,data,sequence) values (?,?,?,?,?,?)`,
      )
      .run(id, sid, tc, tc, JSON.stringify(data), seq);
  msg("m_user_valid", 0, 1, {
    role: "user",
    text: "hi",
    model: { legacy: 1 },
    modelSelection: { providerId: " p ", modelId: " m ", options: { reasoningLevel: "high" } },
  });
  msg("m_user_invalid", 1, 2, {
    role: "user",
    text: "x",
    modelSelection: { providerId: "p", bad: 1 },
  });
  msg("m_assistant", 2, 3, {
    role: "assistant",
    content: "y",
    providerID: "p",
    modelID: "m",
    variant: "v",
  });
  msg("m_other", 3, 4, { role: "system", foo: "bar" });
  msg("m_nullseq", null, 0, { role: "user", text: "last" });
  const part = (id: string, mid: string, seq: number | null, tc: number, data: unknown) =>
    seed
      .prepare(
        `insert into part (id,message_id,session_id,time_created,time_updated,data,sequence) values (?,?,?,?,?,?,?)`,
      )
      .run(id, mid, sid, tc, tc, JSON.stringify(data), seq);
  part("p_timeline", "m_user_valid", 0, 1, {
    type: "timeline",
    timelineType: "model_change",
    fromModel: { legacy: 1 },
    fromModelSelection: { providerId: " a ", modelId: "x" },
    toModelSelection: { providerId: "b", modelId: "c", label: "L" },
  });
  part("p_text", "m_assistant", 0, 1, { type: "text", text: "hello" });
  part("p_timeline_bad", "m_assistant", 1, 2, {
    type: "timeline",
    timelineType: "model_change",
    fromModelSelection: { bad: 1 },
  });
  part("p_subtask", "m_other", 0, 1, {
    type: "subtask",
    model: { legacy: 1 },
    modelSelection: { providerId: "p", modelId: "m" },
  });
  seed.close();

  const read = new DatabaseSync(path, { readOnly: true });
  CHECK(
    "messages",
    await messages(read, { sessionID: sid }),
    JSON.parse(addon.messagesJson(path, sid)),
  );
  CHECK(
    "mwp valid",
    await messageWithParts(read, { sessionID: sid, messageID: "m_user_valid" }),
    JSON.parse(addon.messageWithPartsJson(path, sid, "m_user_valid")),
  );
  CHECK(
    "mwp assistant",
    await messageWithParts(read, { sessionID: sid, messageID: "m_assistant" }),
    JSON.parse(addon.messageWithPartsJson(path, sid, "m_assistant")),
  );
  CHECK(
    "mwp missing",
    await messageWithParts(read, { sessionID: sid, messageID: "zzz" }),
    JSON.parse(addon.messageWithPartsJson(path, sid, "zzz")),
  );
  read.close();
  if (!failed)
    console.log(
      "MESSAGES READ PARITY: OK — order-sensitive reconstruction across all decode branches",
    );
} finally {
  rmSync(dir, { recursive: true, force: true });
}
process.exit(failed);
