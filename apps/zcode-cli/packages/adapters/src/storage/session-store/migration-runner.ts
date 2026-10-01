import {
  classifyDatabaseStartupError,
  type DatabaseMigrationFacts,
  type DatabaseStartupErrorCode,
} from "@zcode/shared";
import type { EventsClient } from "@zcode/rust/events";
import { SqliteSessionMigrationError } from "./errors.js";

export const DEFAULT_SQLITE_STARTUP_LOCK_TIMEOUT_MS = 5_000;
export const DEFAULT_SQLITE_MIGRATION_WAIT_MS = 60 * 60_000;

const SQLITE_BUSY = 5;

export type SqliteMigrationPhase =
  | "checking"
  | "waiting_for_lock"
  | "migrating"
  | "committing"
  | "ready"
  | "failed";

export interface SqliteMigrationProgress {
  phase: SqliteMigrationPhase;
  migration?: DatabaseMigrationFacts;
  elapsedMs: number;
  migrationId?: string;
  completed?: number;
  total?: number;
  errorCode?: string;
  sqliteCode?: number;
  systemCode?: string;
}

export interface AsyncSqliteMigrationOptions {
  lockWaitTimeoutMs?: number;
  onProgress?: (progress: SqliteMigrationProgress) => Promise<void>;
}

/**
 * Step driver over the native migration state machine (spec §4.4: lock
 * acquisition, pragmas, ledger, checksums and rollback run in Rust — the async
 * loop shape, `{delayMs}` timers, progress transport and error normalization
 * stay here, exactly as `runSqliteSessionMigrationsAsync` behaved).
 *
 * The frozen migration list is owned by the crate (`migrations.rs`); the runner
 * no longer carries SQL text, so no migration SQL lives in TypeScript.
 *
 * The legacy sync runner (`runSqliteSessionMigrations` + `Atomics.wait`) is
 * deleted: a synchronous open would block the event loop through the whole
 * migration.
 */
export async function runSqliteSessionMigrationsAsync(
  client: EventsClient,
  dbPath: string,
  options: AsyncSqliteMigrationOptions = {},
): Promise<void> {
  try {
    for (;;) {
      const step = await client.migrateStep();
      if (step.kind === "done") return;
      if (step.kind === "delay") {
        await new Promise<void>((resolve) => setTimeout(resolve, step.delayMs ?? 1));
        continue;
      }
      const progress = JSON.parse(step.progress ?? "{}") as SqliteMigrationProgress;
      if (progress.phase === "failed") {
        try {
          await options.onProgress?.(progress);
        } catch {
          /* Failure in error notification cannot overwrite the original database exception. */
        }
        continue;
      }
      await options.onProgress?.(progress);
    }
  } catch (error) {
    throw normalizeMigrationError(error, dbPath);
  }
  // On a progress-transport failure the native side may still hold the
  // migration transaction; the caller (`SqliteSessionStore.openStartup`) closes
  // the store, which releases the connection and rolls it back — the legacy
  // equivalent was `steps.return()` in the runner's `finally`.
  //
  // busy_timeout restoration (25 ms → 5 000) and the migration rollback happen
  // natively: the state machine restores them on `done` and before rethrowing
  // a failed step.
}

/**
 * Native errors carry structured `kind`/`errcode`/`migrationId`/`dbPath`
 * (rebuilt by `@zcode/rust/events`). Kinds that legacy threw as a finished
 * `SqliteSessionMigrationError` keep their native message; everything else is
 * normalized exactly like `migration-runner.ts` did (busy → lock timeout,
 * otherwise the generic migration message with classified kind).
 */
function normalizeMigrationError(
  error: unknown,
  dbPath: string,
  migrationId?: string,
): SqliteSessionMigrationError {
  if (error instanceof SqliteSessionMigrationError) return error;
  if (isSqliteBusyError(error)) return lockTimeoutError(error, dbPath, migrationId);

  const structured = error as { kind?: unknown; migrationId?: unknown; message?: unknown };
  const kind =
    typeof structured.kind === "string" &&
    (structured.kind === "checksum_mismatch" ||
      structured.kind === "sql_failed" ||
      structured.kind === "lock_timeout" ||
      structured.kind === "open_failed")
      ? (structured.kind as DatabaseStartupErrorCode)
      : undefined;
  if (kind) {
    return new SqliteSessionMigrationError(
      typeof structured.message === "string" ? structured.message : `SQLite migration failed for ${dbPath}`,
      {
        cause: error,
        dbPath,
        kind,
        migrationId:
          typeof structured.migrationId === "string" ? structured.migrationId : migrationId,
      },
    );
  }

  const effectiveMigrationId =
    migrationId ?? (typeof structured.migrationId === "string" ? structured.migrationId : undefined);
  return new SqliteSessionMigrationError(
    effectiveMigrationId
      ? `SQLite migration ${effectiveMigrationId} failed for ${dbPath}`
      : `SQLite migration initialization failed for ${dbPath}`,
    {
      cause: error,
      dbPath,
      kind: classifyDatabaseStartupError(error),
      migrationId: effectiveMigrationId,
    },
  );
}

function lockTimeoutError(
  cause: unknown,
  dbPath: string,
  migrationId?: string,
): SqliteSessionMigrationError {
  const structured = cause as { migrationId?: unknown };
  const effectiveMigrationId =
    migrationId ?? (typeof structured.migrationId === "string" ? structured.migrationId : undefined);
  return new SqliteSessionMigrationError(
    `Timed out waiting for SQLite migration lock at ${dbPath}`,
    { cause, dbPath, kind: "lock_timeout", migrationId: effectiveMigrationId },
  );
}

function isSqliteBusyError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "errcode" in error &&
    typeof (error as { errcode?: unknown }).errcode === "number" &&
    ((error as { errcode: number }).errcode & 0xff) === SQLITE_BUSY
  );
}
