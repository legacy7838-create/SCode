/**
 * `@zcode/rust/events` — loader + the FIFO dispatcher for the zcode-events
 * native session store (spec: docs/specs/rust-native-events.md §4.1).
 *
 * INVARIANT: there is NO JavaScript fallback anywhere. `loadEvents()` goes
 * through `loadNative`, which hard-throws when the binary is missing.
 *
 * The dispatcher is the SOLE scheduler:
 * - every store call is totally ordered by JS invocation order (one FIFO queue,
 *   one native task in flight at a time — legacy op bodies executed synchronously
 *   at invocation, so FIFO dispatch is exactly legacy's execution order);
 * - consecutive write ops coalesce into ONE `write_batch` (single
 *   BEGIN IMMEDIATE … COMMIT with the coalesced prune, §4.2);
 * - reads and transaction scopes are barriers: they wait for the in-flight
 *   batch, and while a scope is open the queue is held (§4.3);
 * - failed ops are never retried (at-most-once dispatch).
 *
 * This module is contract-free by design (typing lives in adapters).
 */
import { fromNativeError } from "./nativeError.js";
import { loadNative } from "./loader.js";

export interface NativeStoreOp {
  kind: string;
  payload: string;
}

export interface NativeMigrationStepResult {
  /** "progress" | "delay" | "done" */
  kind: string;
  /** SqliteMigrationProgress as JSON */
  progress?: string;
  delayMs?: number;
}

export interface NativeEventsStore {
  migrateStep(): Promise<NativeMigrationStepResult>;
  writeBatch(ops: NativeStoreOp[]): Promise<string>;
  read(op: NativeStoreOp): Promise<string>;
  txBegin(): Promise<void>;
  txExec(op: NativeStoreOp): Promise<string>;
  txCommit(): Promise<void>;
  txRollback(): Promise<void>;
  close(): void;
}

export interface NativeEventsOpenOptions {
  dbPath: string;
  startupLockTimeoutMs: number;
  migrationLockWaitMs: number;
  forkCommitFaultAt?: string;
}

export interface NativeEventsModule {
  EventsStore: new (options: NativeEventsOpenOptions) => NativeEventsStore;
  DwfJournal: new (dbPath: string) => NativeDwfJournal;
  DebugSnapshot: new (dbPath: string) => NativeDebugSnapshot;
}

/**
 * Read-only observation handle over the session DB (spec §14.5). The `debug`
 * package's observation server used to open its own `node:sqlite` connection;
 * this is the same connection, native.
 */
export interface NativeDebugSnapshot {
  exec(op: string): string;
  close(): void;
}

/** Typed facade over the read-only snapshot; row shaping stays in the caller. */
export class DebugSnapshotClient {
  constructor(private readonly native: NativeDebugSnapshot) {}

  rows<T = Record<string, unknown>>(op: string): T[] {
    try {
      return JSON.parse(this.native.exec(op)) as T[];
    } catch (error) {
      throw fromNativeError(error);
    }
  }

  close(): void {
    this.native.close();
  }
}

/** Opens the session DB read-only. Throws with the native `open_failed` envelope. */
export function createDebugSnapshot(dbPath: string): DebugSnapshotClient {
  const module = loadEvents();
  return new DebugSnapshotClient(new module.DebugSnapshot(dbPath));
}

/**
 * The **synchronous** dwf-journal native surface (spec §14). Its domain contract
 * (`JournalStorePort`) is synchronous by design, so these calls are synchronous too;
 * the row ⇄ record codecs stay in `@zcode/adapters`.
 */
export interface NativeDwfJournal {
  exec(op: string, payload: string): string;
  close(): void;
}

/**
 * Synchronous facade over the native journal: one `exec(op, payload)` per call.
 * Native errors are decoded through `fromNativeError` (the structured envelope),
 * so the two journal contract errors keep readable messages.
 */
export class DwfJournalClient {
  constructor(private readonly native: NativeDwfJournal) {}

  exec<T = unknown>(op: string, payload: unknown): T {
    let raw: string;
    try {
      raw = this.native.exec(op, JSON.stringify(payload));
    } catch (error) {
      throw fromNativeError(error);
    }
    return JSON.parse(raw) as T;
  }

  close(): void {
    this.native.close();
  }
}

/** Open a journal connection over the session DB (sync open, spec §14.2). */
export function createDwfJournal(dbPath: string): DwfJournalClient {
  const module = loadEvents();
  return new DwfJournalClient(new module.DwfJournal(dbPath));
}

/** Hard-throwing loader for the zcode-events binary (invariant 1: no fallback). */
export function loadEvents(): NativeEventsModule {
  return loadNative<NativeEventsModule>("zcode-events");
}

export { fromNativeError };

function storeClosedError(): Error {
  return Object.assign(
    new Error(
      "SQLite session store is closed: new calls reject with store_closed (spec §8); await pending work before close().",
    ),
    { kind: "store_closed" },
  );
}

/** Handle for running ops inside an open transaction scope (§4.3). */
export interface EventsScopeExec {
  /** Payload object (or already-encoded JSON string callers pass through as text is NOT supported — pass objects). */
  exec(kind: string, payload: unknown): Promise<string>;
}

type WriteEntry = {
  type: "write";
  op: NativeStoreOp;
  resolve: (value: string) => void;
  reject: (error: Error) => void;
};

type ReadEntry = {
  type: "read";
  op: NativeStoreOp;
  resolve: (value: string) => void;
  reject: (error: Error) => void;
};

type ScopeEntry = {
  type: "scope";
  /** Dispatch-time check immediately before `txBegin` (abort parity, §6). */
  preDispatch?: () => void;
  run: (exec: EventsScopeExec) => Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
};

type QueueEntry = WriteEntry | ReadEntry | ScopeEntry;

export class EventsClient {
  private readonly store: NativeEventsStore;
  private readonly queue: QueueEntry[] = [];
  private pumping = false;
  private closed = false;

  constructor(store: NativeEventsStore) {
    this.store = store;
  }

  /**
   * Migration step driver primitive (runs before any store op exists). The frozen
   * migration list lives in the crate (`migrations.rs`), so no SQL crosses the
   * boundary.
   */
  migrateStep(): Promise<NativeMigrationStepResult> {
    if (this.closed) return Promise.reject(storeClosedError());
    return this.store.migrateStep().catch((error: unknown) => {
      throw fromNativeError(error);
    });
  }

  /** Batched write: resolves with the per-op result JSON after the batch commits. */
  write(kind: string, payload: string): Promise<string> {
    if (this.closed) return Promise.reject(storeClosedError());
    return new Promise<string>((resolve, reject) => {
      this.queue.push({ type: "write", op: { kind, payload }, resolve, reject });
      this.start();
    });
  }

  /** Barrier read: waits for the in-flight batch, then dispatches alone. */
  read(kind: string, payload: string): Promise<string> {
    if (this.closed) return Promise.reject(storeClosedError());
    return new Promise<string>((resolve, reject) => {
      this.queue.push({ type: "read", op: { kind, payload }, resolve, reject });
      this.start();
    });
  }

  /**
   * Transaction scope: flushes pending work → `txBegin` → `run` (repo calls map
   * to `txExec`) → `txCommit`/`tx_rollback`. The queue is held for the whole
   * scope, reproducing legacy run-to-completion atomicity (§4.3, D4).
   */
  scope<T>(run: (exec: EventsScopeExec) => Promise<T>, preDispatch?: () => void): Promise<T> {
    if (this.closed) return Promise.reject(storeClosedError());
    return new Promise<T>((resolve, reject) => {
      this.queue.push({
        type: "scope",
        preDispatch,
        run: run as (exec: EventsScopeExec) => Promise<unknown>,
        resolve: resolve as (value: unknown) => void,
        reject,
      });
      this.start();
    });
  }

  /** Sync close: marks closed, rejects queued ops, releases the native store. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    const error = storeClosedError();
    for (const entry of this.queue.splice(0)) {
      entry.reject(error);
    }
    this.store.close();
  }

  get isClosed(): boolean {
    return this.closed;
  }

  private start(): void {
    if (this.pumping || this.closed) return;
    this.pumping = true;
    queueMicrotask(() => {
      void this.pump();
    });
  }

  private async pump(): Promise<void> {
    try {
      while (!this.closed && this.queue.length > 0) {
        const head = this.queue[0]!;
        if (head.type === "write") {
          // Consecutive writes at the queue head become ONE native batch (§4.2).
          const batch: WriteEntry[] = [];
          while (this.queue.length > 0 && this.queue[0]!.type === "write") {
            batch.push(this.queue.shift() as WriteEntry);
          }
          try {
            const raw = await this.store.writeBatch(batch.map((entry) => entry.op));
            // Native returns a JSON array of per-op VALUES; hand each waiter the
            // text form so every store method keeps one `JSON.parse` boundary.
            const results = JSON.parse(raw) as unknown[];
            if (results.length !== batch.length) {
              throw new Error(
                `write_batch returned ${results.length} results for ${batch.length} ops`,
              );
            }
            for (const [index, entry] of batch.entries()) {
              entry.resolve(JSON.stringify(results[index] ?? null));
            }
          } catch (error) {
            // Batch rolled back: every op in it rejects with the failing op's error (D1).
            const normalized = fromNativeError(error);
            for (const entry of batch) {
              entry.reject(normalized);
            }
          }
        } else if (head.type === "read") {
          this.queue.shift();
          try {
            head.resolve(await this.store.read(head.op));
          } catch (error) {
            head.reject(fromNativeError(error));
          }
        } else {
          this.queue.shift();
          await this.runScope(head);
        }
      }
    } finally {
      this.pumping = false;
      if (this.closed && this.queue.length > 0) {
        const error = storeClosedError();
        for (const entry of this.queue.splice(0)) {
          entry.reject(error);
        }
      }
    }
  }

  private async runScope(entry: ScopeEntry): Promise<void> {
    try {
      // Abort parity (§6): re-check immediately before dispatch; after this
      // point an abort firing mid-scope does not change the outcome — the
      // transaction commits and the promise resolves (legacy had zero
      // observation points inside its synchronous transaction).
      entry.preDispatch?.();
      await this.store.txBegin();
    } catch (error) {
      entry.reject(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    try {
      const exec: EventsScopeExec = {
        exec: (kind: string, payload: unknown) =>
          this.store.txExec({ kind, payload: JSON.stringify(payload) }).catch((error: unknown) => {
            throw fromNativeError(error);
          }),
      };
      const result = await entry.run(exec);
      await this.store.txCommit();
      entry.resolve(result);
    } catch (error) {
      try {
        await this.store.txRollback();
      } catch {
        // Keep the original scope error (legacy structure: rollback then rethrow).
      }
      entry.reject(fromNativeError(error));
    }
  }
}

/** Construct a client over a fresh native store (no I/O happens yet). */
export function createEventsClient(options: NativeEventsOpenOptions): EventsClient {
  const module = loadEvents();
  return new EventsClient(new module.EventsStore(options));
}
