/**
 * The storage-startup surface the desktop host imports by name.
 *
 * `prepareTasksIndexStorage` used to be a TypeScript function in
 * `#src/session/tasksDatabase/startup.js`: it opened the database with the Node built-in SQLite
 * driver, waited for
 * the write lock, ran the migrations and repaired the grouping rows. All of that now lives in
 * `zcode-task-index` (`TaskIndexStore::prepare_storage`), because a module that owns a persisted
 * file's schema, its ledger and its startup lock has no business behind a JavaScript fallback
 * (docs/specs/rust-native-ports.md invariant 1; spec docs/specs/rust-native-task-index.md §28).
 *
 * This barrel is the **platform boundary**, not a fallback: the desktop worker owns the
 * `parentPort` and forwards the progress callback; the connection, the pragmas, the lock wait and
 * the migrations are native. `markTasksStoragePrepared` is gone with it — it was a process-level
 * `Set<string>` that skipped a ledger re-read; `ensure_ready` re-reads the ledger every time, so
 * the handover had nothing left to skip.
 */
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";

import type { DatabaseMigrationFacts } from "@zcode/shared";
import { TaskIndexStore, type StorageProgress } from "@zcode/rust/task-index";

export type TasksStoragePhase = StorageProgress["phase"];

/**
 * Opens `path`, applies the pragmas, waits for the write lock, runs the migrations and repairs
 * the grouping rows, reporting progress.
 *
 * The `lockWaitMs` matches the deleted `LOCK_WAIT_MS` (one hour): a second window starting
 * simultaneously waits asynchronously rather than failing after the 5 s `busy_timeout`.
 */
export async function prepareTasksIndexStorage(
  path: string,
  onProgress: (phase: TasksStoragePhase, migration?: DatabaseMigrationFacts) => void,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  // The deleted startup opened with `PRAGMA busy_timeout = 25` so a held write lock fails fast
  // and the `waiting_for_lock` phase is reported immediately; the asynchronous wait is the
  // native `wait_for_lock` retry loop, not this busy timeout. 5 000 ms here would make the first
  // `BEGIN IMMEDIATE` block for five seconds before the phase is ever emitted.
  const store = new TaskIndexStore({ path, busyTimeoutMs: 25 });
  try {
    await store.prepareStorage(Date.now(), 60 * 60_000, (event) => {
      onProgress(event.phase, event.migration as DatabaseMigrationFacts);
    });
  } finally {
    store.close();
  }
}

export { getTasksIndexDatabasePath } from "#src/paths.js";
export { resolveDefaultZCodeAgentCommand } from "#src/zcode-agent/zcodeAgentProcessManager.js";
export { resolveZCodeAgentSpawnCwd } from "#src/zcode-agent/zcodeAgentSpawnCwd.js";
