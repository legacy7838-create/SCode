// Migration-parity harness (data-safety gate before any session-store repo swap).
// Drives the REAL TS `runSqliteSessionMigrations` on a throwaway /tmp DB and the Rust addon's
// `bootstrapSessionStoreJson` on another throwaway /tmp DB, then compares:
//   (1) the schema objects in sqlite_master (type,name + normalized DDL), and
//   (2) the `schema_migration` ledger rows (id, checksum, app_version).
// Never touches the live `~/.zcode/cli/db/db.sqlite`. Exits non-zero on any divergence.
import { DatabaseSync } from "node:sqlite";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runSqliteSessionMigrations } from "/media/hdd1/ZCode/apps/zcode-cli/packages/adapters/src/storage/session-store/migration-runner.ts";

const require = createRequire(import.meta.url);
const addon = require("/media/hdd1/ZCode/packages/desktop/zcode-db/zcode_db.node");

function dump(path) {
  const db = new DatabaseSync(path, { readOnly: true });
  const schema = db
    .prepare(`SELECT type, name, sql FROM sqlite_master ORDER BY type, name`)
    .all()
    .map((r) => ({ type: r.type, name: r.name, sql: String(r.sql ?? "").replace(/\s+/g, "") }));
  const ledger = db
    .prepare(`SELECT id, checksum, app_version FROM schema_migration ORDER BY id`)
    .all()
    .map((r) => ({ id: r.id, checksum: r.checksum, app_version: r.app_version }));
  db.close();
  return { schema, ledger };
}

const dir = mkdtempSync(join(tmpdir(), "zcode-sess-parity-"));
const tsPath = join(dir, "ts.sqlite");
const rsPath = join(dir, "rs.sqlite");
let failed = 0;

try {
  // TS reference: open (creates file), then run the real runner.
  const tdb = new DatabaseSync(tsPath);
  tdb.exec("PRAGMA foreign_keys = ON");
  tdb.close();
  const handle = new DatabaseSync(tsPath);
  runSqliteSessionMigrations(handle, tsPath, 5000);
  handle.close();

  // Rust: bootstrap creates + migrates in one shot.
  const facts = JSON.parse(addon.bootstrapSessionStoreJson(rsPath, 5000, Date.now()));
  if (facts.committedCount !== 22) throw new Error(`rust executed ${facts.committedCount} != 22`);
  if (!addon.areSessionMigrationsApplied(rsPath))
    throw new Error("rust: not applied after bootstrap");

  const ts = dump(tsPath);
  const rs = dump(rsPath);

  // (1) schema objects
  const key = (o) => `${o.type}|${o.name}`;
  const tsKeys = ts.schema.map(key).sort();
  const rsKeys = rs.schema.map(key).sort();
  if (JSON.stringify(tsKeys) !== JSON.stringify(rsKeys)) {
    console.error("SCHEMA OBJECT SET DIFFERS");
    console.error(
      "  ts only:",
      tsKeys.filter((k) => !rsKeys.includes(k)),
    );
    console.error(
      "  rs only:",
      rsKeys.filter((k) => !tsKeys.includes(k)),
    );
    failed = 1;
  }
  const tsBy = Object.fromEntries(ts.schema.map((o) => [key(o), o.sql]));
  const rsBy = Object.fromEntries(rs.schema.map((o) => [key(o), o.sql]));
  for (const k of tsKeys) {
    if (tsBy[k] !== rsBy[k]) {
      console.error(`DDL DIFFERS for ${k}\n  TS: ${tsBy[k]}\n  RS: ${rsBy[k]}`);
      failed = 1;
    }
  }

  // (2) ledger
  if (JSON.stringify(ts.ledger) !== JSON.stringify(rs.ledger)) {
    console.error("LEDGER DIFFERS");
    console.error("  ts:", JSON.stringify(ts.ledger));
    console.error("  rs:", JSON.stringify(rs.ledger));
    failed = 1;
  }

  if (!failed) {
    console.log(
      `SESSION MIGRATION PARITY: OK — ${rs.schema.length} schema objects, ${rs.ledger.length} ledger rows identical (TS vs Rust)`,
    );
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}
process.exit(failed);
