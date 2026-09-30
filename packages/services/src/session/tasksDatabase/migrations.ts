import { databaseMigrationIdSchema, type DatabaseMigrationFacts } from "@zcode/shared";
import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  AUTOMATION_SCHEMA,
  OFF_PEAK_SCHEMA,
  TASK_INDEX_SCHEMA,
} from "#src/session/tasksDatabase/schema-v1.js";
import {
  LEGACY_SELECTION_SOURCE_SQL,
  importLegacyAutomationSelections,
  legacySelectionSql,
  type LegacySelectionRow,
} from "#src/session/tasksDatabase/provider-selection-v2.js";
import { OFFICIAL_GLM_SELECTION_MIGRATION_SQL } from "#src/session/tasksDatabase/official-glm-selection-v3.js";
import type { TaskIndexMigration } from "@zcode/rust/task-index";

// Frozen history column declaration cannot be replaced by real-time Repo/schema, otherwise the new version build will change the applied checksum.
const columns = [
  ["tasks", "title_overridden", "INTEGER NOT NULL DEFAULT 0"],
  ["tasks", "last_unread_at", "INTEGER NOT NULL DEFAULT 0"],
  ["tasks", "searchable_text", "TEXT NOT NULL DEFAULT ''"],
  ["tasks", "cron_automation_id", "TEXT"],
  ["tasks", "off_peak_task_id", "TEXT"],
  ["automations", "target_task_id", "TEXT"],
  ["automations", "bot_delivery_target", "TEXT"],
  ["automations", "mode", "TEXT"],
  ["automations", "end_at", "INTEGER"],
  ["automations", "schedule_rule", "TEXT"],
  ["automations", "schedule_edited_by_user", "INTEGER NOT NULL DEFAULT 0"],
  ["automations", "thought_level", "TEXT"],
  ["automations", "model_selection", "TEXT"],
  ["automations", "scheduled_run_count", "INTEGER NOT NULL DEFAULT 0"],
  ["automation_runs", "model_selection", "TEXT"],
  ["off_peak_tasks", "thought_level", "TEXT"],
  ["off_peak_tasks", "model_selection", "TEXT"],
  ["off_peak_tasks", "history_deleted_at", "INTEGER"],
] as const;
const indexes = `
  CREATE INDEX IF NOT EXISTS idx_tasks_cron_automation ON tasks(cron_automation_id, updated_at DESC)
    WHERE cron_automation_id IS NOT NULL AND deleted=0;
  CREATE INDEX IF NOT EXISTS idx_tasks_off_peak_task ON tasks(off_peak_task_id, updated_at DESC)
    WHERE off_peak_task_id IS NOT NULL AND deleted=0;
  CREATE INDEX IF NOT EXISTS idx_automations_target_task ON automations(target_task_id) WHERE target_task_id IS NOT NULL;
`;
const terminalStatuses = "'completed','failed','cancelled'";
const activePredicate = `session_id IS NOT NULL AND status NOT IN (${terminalStatuses})`;
const boundIndex = `CREATE UNIQUE INDEX IF NOT EXISTS idx_off_peak_bound_active ON off_peak_tasks(workspace_key,session_id) WHERE ${activePredicate}`;

// It is also a library-level serial transaction like Agent, but does not depend on its specific adapter across domains. TS transformation uses frozen semantic versioning,
// Disable function.toString hashing: Electron/SEA packaging changes function text rather than migrating semantics.
const definitions = [
  {
    id: "0001_adopt_task_schema",
    checksumInput: [
      TASK_INDEX_SCHEMA,
      AUTOMATION_SCHEMA,
      OFF_PEAK_SCHEMA,
      columns,
      indexes,
      boundIndex,
      "scheduled-count-backfill-v1",
    ],
  },
  {
    id: "0002_provider_selection",
    checksumInput: ["legacy-automation-selection-v1", "no-provider-for-legacy-off-peak-v1"],
  },
  {
    id: "0003_official_glm_selection",
    checksumInput: [OFFICIAL_GLM_SELECTION_MIGRATION_SQL],
  },
] as const;

/**
 * The migration list, in the shape `@zcode/rust/task-index` expects.
 *
 * `checksumInputJson` is the **already-stringified** `JSON.stringify(checksumInput)`, because the
 * ledger checksum is `sha256(JSON.stringify(checksumInput))` and the serialisation must happen
 * once, in the language whose `JSON.stringify` defined the format.
 *
 * `sql` is the migration's body, and it is **required** — the native runner applies exactly what it
 * is given. These used to be empty strings, which recorded the ledger row and created nothing, so a
 * store opened on a fresh file had a migration history and no schema (spec §19a).
 *
 * The payload is not part of `checksumInput`, so the three checksums the real ledger holds are
 * unchanged by anything that happens here.
 */
export function tasksDatabaseMigrationsForNative(db?: DatabaseSync): TaskIndexMigration[] {
  return definitions.map((migration) => ({
    id: migration.id,
    sql: migrationSqlForNative(migration.id, db),
    checksumInputJson: JSON.stringify(migration.checksumInput),
  }));
}

/**
 * The body of one migration, at the frozen semantics the TypeScript runner applied.
 *
 * `0001` and `0002` are derived and `0003` is a frozen constant. The difference matters: `0001`'s
 * `ALTER TABLE` list is the pre-`IF NOT EXISTS` form the migration actually ran, and
 * `adoptTaskSchemaSql()` is the single description of it — `adoptSchema()` executes the same string
 * after its own idempotence check.
 */
export function migrationSqlForNative(migrationId: string, db?: DatabaseSync): string {
  switch (migrationId) {
    case "0001_adopt_task_schema":
      return adoptTaskSchemaSql();
    case "0002_provider_selection":
      // Frozen history. The decode depends on the rows that existed when `0002` first ran, so the
      // emission reads the current rows once; the `IS`-guards make it a no-op everywhere else.
      return legacySelectionSql(readLegacySelectionRows(db), readSelectionPreImage(db));
    case "0003_official_glm_selection":
      return OFFICIAL_GLM_SELECTION_MIGRATION_SQL;
    default:
      // No `""` default: a migration that declares no SQL would record a ledger row and create
      // nothing, which is the bug this function exists to fix.
      throw new Error(`no SQL declared for task database migration ${migrationId}`);
  }
}

/**
 * `0001`'s body: the three schemas, the frozen `ALTER TABLE` list, the indexes and the bound index.
 *
 * `columns` is declared as data because the checksum depends on it; here it is rendered into the
 * statements the migration executed. Two of its rows — `tasks.title_overridden` and
 * `tasks.last_unread_at` — are **already inside `TASK_INDEX_SCHEMA`**, so a literal `ALTER` list
 * fails on a fresh file with `duplicate column name`. The live runner never hit that because
 * `adoptSchema()` filters with `PRAGMA table_info`; the native runner receives plain SQL, so the
 * filter has to be folded in here. Emitting `ADD COLUMN` only for the columns the schemas do not
 * already create reproduces exactly what the JavaScript did on a fresh file, statically.
 *
 * The `scheduled_run_count` backfill stays attached to its `ALTER`, as in the migration, and is
 * **not** produced when that column already exists (the live `adoptSchema()` branch would backfill
 * again).
 */
function adoptTaskSchemaSql(): string {
  const statements: string[] = [];
  for (const [table, column, definition] of columns) {
    if (schemaAlreadyDeclares(table, column)) continue;
    statements.push(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition};`);
    if (table === "automations" && column === "scheduled_run_count") {
      statements.push("UPDATE automations SET scheduled_run_count=run_count;");
    }
  }
  return `${schemaDdl()}\n${statements.join("\n")}\n${indexes}${boundIndex}`;
}

/**
 * Whether `TASK_INDEX_SCHEMA`/`AUTOMATION_SCHEMA`/`OFF_PEAK_SCHEMA` already create this column.
 *
 * Matched inside the `CREATE TABLE <table> (` block, on a line whose first token is the column name,
 * so a column named in another table's body or inside an index expression cannot match by accident.
 * If it ever fails to match, the failure is a loud `duplicate column name` from sqlite — never a
 * silently skipped column.
 */
function schemaAlreadyDeclares(table: string, column: string): boolean {
  const marker = `CREATE TABLE IF NOT EXISTS ${table} (`;
  const start = schemaDdl().indexOf(marker);
  if (start < 0) return false;
  const body = schemaDdl().slice(start + marker.length);
  const end = body.indexOf("\n      )");
  const block = end < 0 ? body : body.slice(0, end);
  return block.split("\n").some((line) => line.trim().startsWith(`${column} `));
}

/** The legacy selection snapshot, read once and handed to the frozen `0002` rules. */
function readLegacySelectionRows(db?: DatabaseSync): LegacySelectionRow[] {
  if (!db) return [];
  return db.prepare(LEGACY_SELECTION_SOURCE_SQL).all() as unknown as LegacySelectionRow[];
}

/**
 * What each automation's `model_selection` already holds, so `0002` can skip an update that would
 * write the value that is already there. Only rows whose legacy columns are present are needed —
 * the `IS`-guard means an update for any other row could not take effect anyway.
 */
function readSelectionPreImage(db?: DatabaseSync): Map<string, string | null> {
  const existing = new Map<string, string | null>();
  if (!db) return existing;
  const rows = db
    .prepare(
      `SELECT a.automation_id AS automation_id, a.model_selection AS model_selection
       FROM automations a WHERE a.model IS NOT NULL`,
    )
    .all() as unknown as { automation_id: string; model_selection: string | null }[];
  for (const row of rows) existing.set(row.automation_id, row.model_selection);
  return existing;
}

/** The migration list, with a live connection so the frozen `0002` payload can read its rows. */
export function tasksDatabaseMigrationsForNativeDatabase(db: DatabaseSync): TaskIndexMigration[] {
  return tasksDatabaseMigrationsForNative(db);
}


export function runTasksDatabaseMigrations(
  db: DatabaseSync,
  options: {
    transactionOpen?: boolean;
    migration?: DatabaseMigrationFacts;
    onProgress?: (phase: "migrating" | "committing", migration: DatabaseMigrationFacts) => void;
  } = {},
): void {
  if (!options.transactionOpen) db.exec("BEGIN IMMEDIATE");
  const migrationFacts: DatabaseMigrationFacts = options.migration ?? {
    kind: "none",
    executedCount: 0,
    committedCount: 0,
  };
  let currentMigrationId: string | undefined;
  try {
    if (!options.migration) migrationFacts.kind = inspectTasksMigrationKind(db);
    db.exec(`CREATE TABLE IF NOT EXISTS tasks_schema_migration (
      id TEXT PRIMARY KEY, checksum TEXT NOT NULL, time_applied INTEGER NOT NULL
    )`);
    // Within the lock, the version SQL is collected before; the empty ledger is none, and the exception number is not sent as the original telemetry text.
    const baseline = db
      .prepare("SELECT id FROM tasks_schema_migration ORDER BY id DESC LIMIT 1")
      .get();
    migrationFacts.lastAppliedMigrationId = baseline
      ? databaseMigrationIdSchema.safeParse(baseline.id).data
      : null;
    for (const migration of definitions) {
      currentMigrationId = migration.id;
      const checksum = createHash("sha256")
        .update(JSON.stringify(migration.checksumInput))
        .digest("hex");
      const applied = db
        .prepare("SELECT checksum FROM tasks_schema_migration WHERE id=?")
        .get(migration.id);
      if (applied) {
        if (applied.checksum !== checksum)
          throw Object.assign(
            new Error(`Task database migration checksum mismatch: ${migration.id}`),
            { kind: "checksum_mismatch" },
          );
        continue;
      }
      if (migrationFacts.kind === "none") migrationFacts.kind = "upgrade";
      options.onProgress?.("migrating", { ...migrationFacts });
      if (migration.id === "0001_adopt_task_schema") adoptSchema(db);
      else if (migration.id === "0002_provider_selection") importLegacyAutomationSelections(db);
      else db.exec(OFFICIAL_GLM_SELECTION_MIGRATION_SQL);
      migrationFacts.executedCount++;
      db.prepare("INSERT INTO tasks_schema_migration VALUES(?,?,?)").run(
        migration.id,
        checksum,
        Date.now(),
      );
    }
    options.onProgress?.("committing", { ...migrationFacts });
    db.exec("COMMIT");
    migrationFacts.committedCount = migrationFacts.executedCount;
  } catch (error) {
    // Rollback may also fail due to IO failure and cannot cover the exception that actually caused the migration to fail.
    try {
      if (db.isTransaction) db.exec("ROLLBACK");
    } catch {
      /* Leave recovery to the caller by closing the connection. */
    }
    if (error && typeof error === "object" && currentMigrationId)
      Object.assign(error, { migrationId: currentMigrationId });
    throw error;
  }
}

function adoptSchema(db: DatabaseSync): void {
  // The DDL is built once, by the same function the native migration payload uses, so the two
  // runners cannot drift into two descriptions of `0001`.
  db.exec(schemaDdl());
  const alters: string[] = [];
  for (const [table, column, definition] of columns) {
    const existing = db.prepare(`PRAGMA table_info(${table})`).all();
    if (existing.some((entry) => entry.name === column)) continue;
    alters.push(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    if (table === "automations" && column === "scheduled_run_count") {
      alters.push(`UPDATE automations SET scheduled_run_count=run_count`);
    }
  }
  if (alters.length) db.exec(`${alters.join(";\n")};`);
  db.exec(indexes);
  // Keep the old adjudicated duplicate binding retention policy, but no longer swallow real SQL errors like permissions/syntax/disk etc.
  const duplicate = db
    .prepare(`SELECT 1 FROM off_peak_tasks WHERE ${activePredicate}
    GROUP BY workspace_key, session_id HAVING count(*)>1 LIMIT 1`)
    .get();
  if (!duplicate) db.exec(boundIndex);
}

/** `TASK_INDEX_SCHEMA + AUTOMATION_SCHEMA + OFF_PEAK_SCHEMA` — the DDL both runners start from. */
export function schemaDdl(): string {
  return TASK_INDEX_SCHEMA + AUTOMATION_SCHEMA + OFF_PEAK_SCHEMA;
}

/** Handover only reuses an already-completed initialization; every new connection still confirms against the frozen ledger — a replaced or emptied file must not fake ready. */
export function areTasksDatabaseMigrationsApplied(db: DatabaseSync): boolean {
  if (
    !db
      .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='tasks_schema_migration'")
      .get()
  )
    return false;
  for (const migration of definitions) {
    const row = db
      .prepare("SELECT checksum FROM tasks_schema_migration WHERE id=?")
      .get(migration.id);
    if (!row) return false;
    const expected = createHash("sha256")
      .update(JSON.stringify(migration.checksumInput))
      .digest("hex");
    if (row.checksum !== expected)
      throw Object.assign(new Error(`Task database migration checksum mismatch: ${migration.id}`), {
        kind: "checksum_mismatch",
      });
  }
  return true;
}

/** Display-oriented pre-check against a read-only ledger, not an execution authorization; the migration runner still rechecks every item after taking the lock. */
export function inspectTasksMigrationKind(db: DatabaseSync): DatabaseMigrationFacts["kind"] {
  const hasLedger = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='tasks_schema_migration'")
    .get();
  let pending = false;
  for (const migration of definitions) {
    const row = hasLedger
      ? db.prepare("SELECT checksum FROM tasks_schema_migration WHERE id=?").get(migration.id)
      : undefined;
    if (!row) pending = true;
    else if (
      row.checksum !==
      createHash("sha256").update(JSON.stringify(migration.checksumInput)).digest("hex")
    )
      throw Object.assign(new Error(`Task database migration checksum mismatch: ${migration.id}`), {
        kind: "checksum_mismatch",
        migrationId: migration.id,
      });
  }
  if (!pending) return "none";
  return db
    .prepare(
      "SELECT 1 FROM sqlite_master WHERE type='table' AND name NOT IN ('tasks_schema_migration', 'sqlite_sequence') LIMIT 1",
    )
    .get()
    ? "upgrade"
    : "initialize";
}
