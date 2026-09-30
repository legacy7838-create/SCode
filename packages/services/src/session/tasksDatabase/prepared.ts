import type { DatabaseSync } from "node:sqlite";
import { areTasksDatabaseMigrationsApplied } from "#src/session/tasksDatabase/migrations.js";
// Only the startup handover credentials of the current process are transferred; it does not drop the disk, does not replace the SQLite ledger, and does not affect new libraries with different paths.
const migrated = new Set<string>();
const prepared = new Set<string>();
export function markTasksStorageMigrated(path: string): void {
  migrated.add(path);
}
export function markTasksStoragePrepared(path: string): void {
  migrated.add(path);
  prepared.add(path);
}
export function isTasksStorageMigrated(path: string, db: DatabaseSync): boolean {
  return migrated.has(path) && areTasksDatabaseMigrationsApplied(db);
}
export function isTasksStoragePrepared(path: string, db: DatabaseSync): boolean {
  return prepared.has(path) && areTasksDatabaseMigrationsApplied(db);
}
