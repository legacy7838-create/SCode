/**
 * Off-peak task storage repository (tasks-index.sqlite, WAL, multi-process safe).
 *
 * **This is a wrapper, not an implementation.** The storage, the guarded writes and the scheduling
 * claims all live in the `zcode-task-index` Rust crate
 * (`packages/rust/crates/zcode-task-index/src/offpeak.rs`); the 839 lines that used to be here are
 * deleted. Spec: docs/specs/rust-native-task-index.md §20–§21.
 *
 * What remains is exactly what has to: the `ensureReady` handshake, the `Date.now()` defaults the
 * native side deliberately does not own so it stays pure, and the `OffPeakTaskRepo` **name and
 * method signatures** the service layer already imports — so no call site changed.
 *
 * There is **no JavaScript fallback** (docs/specs/rust-native-ports.md invariant 1). `loadNative`
 * throws when the binary is missing. A scheduling state machine that silently half-runs is worse
 * than one that refuses to start: a task that is claimed but never dispatched, or edited but never
 * persisted, fails silently in a way nobody notices until a week of work is missing.
 *
 * The equivalence is not asserted by inspection. `scripts/verify-offpeak-parity.mts` replays a
 * 72-entry transcript captured from this file's TypeScript implementation, through the Rust engine,
 * and compares every return value; all 72 match.
 */
import type { ZCodeOffPeakTask, ZCodeOffPeakTaskCreateParams } from "@zcode/shared";
import { OFF_PEAK_TERMINAL_STATUSES, resolveWorkspaceKey } from "@zcode/shared";

import { getTasksIndexDatabasePath } from "#src/paths.js";
import { TaskIndexStore } from "@zcode/rust/task-index";
import { OffPeakRepository, type OffPeakTask } from "@zcode/rust/off-peak-repository";

/**
 * The engine's task shape, narrowed to the shared one.
 *
 * `packages/rust` holds no dependency on `@zcode/shared`, so `permissionMode` and `status` are
 * plain `string` there rather than the shared unions. The engine emits the shared values, and the
 * 72-entry differential transcript asserts them — so this cast is a narrowing the transcript backs,
 * not a way of hiding a mismatch. Declared once, at the boundary, so no call site repeats it.
 */
const asSharedTask = (task: OffPeakTask): ZCodeOffPeakTask => task as unknown as ZCodeOffPeakTask;
const asSharedTasks = (tasks: OffPeakTask[]): ZCodeOffPeakTask[] =>
  tasks.map(asSharedTask);

/**
 * Stale claim reclamation: a `claim_running=1` row still unsettled after this long is treated as a
 * crashed holder and may be claimed again.
 *
 * Independent of automation's claim window — same semantics, its own constant. Do not
 * cross-reference them.
 */
export const OFF_PEAK_CLAIM_STALE_MS = 10 * 60_000;

/** The terminal statuses, re-exported so callers keep importing them from here. */
export { OFF_PEAK_TERMINAL_STATUSES };

/** The INSERT that lost a concurrent double create on the bound-session unique index. */
export function isOffPeakBoundSessionConflict(error: unknown): boolean {
  return (
    error instanceof Error &&
    /UNIQUE constraint failed: off_peak_tasks\.workspace_key, off_peak_tasks\.session_id/.test(
      error.message,
    )
  );
}

/** Mirrors the `ZCodeOffPeakTaskCreateParams` members this repository consumes. */
export type OffPeakTaskCreateParams = ZCodeOffPeakTaskCreateParams;

export class OffPeakTaskRepo {
  /**
   * The path is fixed at construction.
   *
   * It deliberately does not read the process-level data directory: under vitest, test files run
   * concurrently and a global would be overwritten by whichever file ran last, opening a window in
   * which a test writes to the real library. The temporary path is injected during tests; in
   * production the default resolves lazily.
   */
  readonly #dbPath: string | null;
  readonly #startupBusyTimeoutMs: number;
  #store: TaskIndexStore | null = null;
  #repo: OffPeakRepository | null = null;
  #ready: Promise<void> | null = null;

  constructor(dbPath?: string, startupBusyTimeoutMs = 5000) {
    this.#dbPath = dbPath?.trim() || null;
    this.#startupBusyTimeoutMs = startupBusyTimeoutMs;
  }

  #resolveDbPath(): string {
    return this.#dbPath ?? getTasksIndexDatabasePath();
  }

  /**
   * Opens the file, applies the pragmas and runs the migrations.
   *
   * Idempotent, and **re-opens** if the resolved path changed — otherwise a caller that handed over
   * a different path would keep reading the old file. A failure clears the memoised promise so the
   * next call retries instead of replaying the same rejection forever.
   */
  async ensureReady(): Promise<void> {
    const path = this.#resolveDbPath();
    if (this.#store && this.#openedPath !== path) {
      this.close();
    }
    if (!this.#ready) {
      this.#ready = this.#initialize(path).catch((error: unknown) => {
        this.close();
        throw error;
      });
    }
    await this.#ready;
  }

  #openedPath: string | null = null;

  async #initialize(path: string): Promise<void> {
    // The migrations are the **crate's**: the ledger checksum is
    // `sha256(JSON.stringify(checksumInput))`, and the schema, the three frozen payloads and the
    // checksum inputs live in `crate::schema` (spec §28). `ensureReady` takes no migration list.
    const store = new TaskIndexStore({ path, busyTimeoutMs: this.#startupBusyTimeoutMs });
    await store.ensureReady(Date.now());
    this.#store = store;
    this.#repo = new OffPeakRepository(store);
    this.#openedPath = path;

    // `awaiting_approval` was reserved early but the production link was never written and the UI
    // folded it into available capacity. Only ordinary sessions are confirmed, so the remaining
    // rows go back to `running` and startup recycling then decides what happens to them.
    //
    // A **distinct** transition from `recoverInterrupted`, which goes the other way (`running` →
    // `queued`). Leaving these rows stranded in `awaiting_approval` is not a no-op: the UI counts
    // that status as available capacity, so they would look dispatchable and never be dispatched.
    await new OffPeakRepository(store).offpeakRecycleAwaitingApproval(Date.now());
  }

  /** Refuses loudly once closed, rather than silently reopening. */
  #repository(): OffPeakRepository {
    if (!this.#repo || !this.#store) {
      throw new Error("OffPeakTaskRepo is not initialized: await ensureReady() first");
    }
    return this.#repo;
  }

  /**
   * Releases the connection.
   *
   * `throwOnError` is accepted for call-site compatibility and **ignored**: a close that failed has
   * nothing actionable for the caller, and the original's `throwOnError: false` default means the
   * common path swallowed it anyway. Passing `true` is honoured by rethrowing, so the two
   * behaviours are not silently unified.
   */
  close(options?: { throwOnError?: boolean }): void {
    let closeError: unknown;
    try {
      this.#store?.close();
    } catch (error) {
      closeError = error;
    }
    this.#store = null;
    this.#repo = null;
    this.#openedPath = null;
    this.#ready = null;
    if (options?.throwOnError && closeError) throw closeError;
  }

  /**
   * Creating a task also enqueues it: the row lands `queued`.
   *
   * `model` and `thoughtLevel` are written as `NULL` for a new row — they are rollback snapshots,
   * populated only by `invalidateModelSelection`.
   */
  async create(
    params: OffPeakTaskCreateParams,
    options?: {
      /** For test injection; defaults to `Date.now()`. */
      now?: number;
      /** Externally supplied id, taken before persisting because a ticket needs one first. */
      offPeakTaskId?: string;
      serverTicketId?: string;
      queuePosition?: number;
      registeredAt?: number;
      /** Dispatch straight after creation when the ticket comes back ready. */
      schedulable?: boolean;
    },
  ): Promise<ZCodeOffPeakTask> {
    await this.ensureReady();
    const offPeakTaskId = options?.offPeakTaskId ?? `offpeak-${crypto.randomUUID()}`;
    // The identity rule, applied here as the original did: a trimmed non-empty identity wins,
    // otherwise the path. Resolving it in the engine would need the same inputs, and a caller that
    // passed only a path would get a different scope than every other repository uses.
    const workspaceKey = resolveWorkspaceKey({
      workspacePath: params.workspacePath,
      workspaceIdentity: params.workspaceIdentity,
    });
    return this.#repository().offpeakCreate({
      offPeakTaskId,
      title: params.title,
      prompt: params.prompt,
      permissionMode: params.permissionMode,
      modelSelection: params.modelSelection,
      workspacePath: params.workspacePath,
      workspaceIdentity: params.workspaceIdentity,
      workspaceKey,
      sessionId: params.boundSessionId,
      serverTicketId: options?.serverTicketId,
      queuePosition: options?.queuePosition,
      registeredAt: options?.registeredAt,
      schedulable: options?.schedulable,
      now: options?.now ?? Date.now(),
    }).then(asSharedTask);
  }

  async list(scope?: { workspacePath?: string; workspaceIdentity?: string }): Promise<ZCodeOffPeakTask[]> {
    await this.ensureReady();
    return this.#repository().offpeakList(
      scope?.workspacePath
        ? resolveWorkspaceKey({
            workspacePath: scope.workspacePath,
            workspaceIdentity: scope.workspaceIdentity,
          })
        : undefined,
    ).then(asSharedTasks);
  }

  async get(offPeakTaskId: string): Promise<ZCodeOffPeakTask | null> {
    await this.ensureReady();
    const task = await this.#repository().offpeakGet(offPeakTaskId);
    return task ? asSharedTask(task) : null;
  }

  /**
   * Applies a Registry observation that invalidated the stored selection.
   *
   * The engine refuses to overwrite a selection another process already repaired: if the stored
   * provider, model or reasoning level differs, the row comes back unchanged.
   */
  async invalidateModelSelection(
    offPeakTaskId: string,
    modelSelection: NonNullable<ZCodeOffPeakTask["modelSelection"]>,
    options?: { now?: number },
  ): Promise<ZCodeOffPeakTask | null> {
    await this.ensureReady();
    const task = await this.#repository().offpeakInvalidateModelSelection(
      offPeakTaskId,
      modelSelection,
      options?.now ?? Date.now(),
    );
    return task ? asSharedTask(task) : null;
  }

  /** Deletes in any state; the service layer settles a non-terminal task server-side first. */
  async delete(offPeakTaskId: string): Promise<void> {
    await this.ensureReady();
    await this.#repository().offpeakDelete(offPeakTaskId);
  }

  /** Hides the history row, and only for a task that actually started. Idempotent. */
  async markHistoryDeleted(
    offPeakTaskId: string,
    options?: { now?: number },
  ): Promise<ZCodeOffPeakTask | null> {
    await this.ensureReady();
    return this.#repository().offpeakMarkHistoryDeleted(offPeakTaskId, options?.now ?? Date.now()).then((task) =>
      task ? asSharedTask(task) : null,
    );
  }

  async countNonTerminal(): Promise<number> {
    await this.ensureReady();
    return this.#repository().offpeakCountNonTerminal();
  }

  async hasActiveBoundTask(workspaceKey: string, sessionId: string): Promise<boolean> {
    await this.ensureReady();
    return this.#repository().offpeakHasActiveBoundTask(workspaceKey, sessionId);
  }

  async countActive(): Promise<number> {
    await this.ensureReady();
    return this.#repository().offpeakCountActive();
  }

  /**
   * Edits the editable window; only `queued`/`paused` tasks are editable, and an explicit
   * `modelSelection: null` is **rejected** rather than applied — clearing it would make the task
   * permanently un-claimable.
   */
  async updateEditableFields(
    offPeakTaskId: string,
    params: {
      title?: string;
      prompt?: string;
      permissionMode?: string;
      modelSelection?: ZCodeOffPeakTask["modelSelection"] | null;
    },
    options?: { now?: number },
  ): Promise<ZCodeOffPeakTask | null> {
    await this.ensureReady();
    return this.#repository().offpeakUpdateEditableFields(offPeakTaskId, params, options?.now ?? Date.now()).then((task) =>
      task ? asSharedTask(task) : null,
    );
  }

  /** The poll's write-back; absent fields keep their stored value and a missing task is a no-op. */
  async updateSchedulingSnapshot(
    offPeakTaskId: string,
    patch: {
      schedulable?: boolean;
      queuePosition?: number | null;
      nextPollAt?: number | null;
      serverTicketId?: string;
      registeredAt?: number;
      now?: number;
    },
  ): Promise<void> {
    await this.ensureReady();
    await this.#repository().offpeakUpdateSchedulingSnapshot(offPeakTaskId, patch);
  }

  /**
   * Single-flight claims dispatchable tasks.
   *
   * The returned tasks carry `updatedAt` as it was **read**, not the claim's own write, so the
   * caller acts on the state it dispatched rather than on the state the claim created.
   */
  async claimDue(now: number): Promise<ZCodeOffPeakTask[]> {
    await this.ensureReady();
    return this.#repository().offpeakClaimDue(now).then(asSharedTasks);
  }

  /**
   * `queued` → `running`, guarded. A late dispatch result is refused with `null`. A continuation
   * segment keeps the first `startedAt`, so one task stays one task across resumes.
   */
  async markRunning(
    offPeakTaskId: string,
    options: {
      startedAt: number;
      conversationId?: string;
      sessionId?: string;
      serverTicketId?: string;
    },
  ): Promise<ZCodeOffPeakTask | null> {
    await this.ensureReady();
    return this.#repository()
      .offpeakMarkRunning(offPeakTaskId, options)
      .then((task) => (task ? asSharedTask(task) : null));
  }

  /**
   * Persists a terminal state, which is **irreversible**: a second transition changes no rows and
   * returns `null`, so a late result cannot rewrite a completed task as failed.
   */
  async markTerminal(
    offPeakTaskId: string,
    options: {
      status: "completed" | "failed" | "cancelled";
      endedAt: number;
      failureReason?: string;
      filesChanged?: number;
      /** A deterministic dispatch-phase error; when present, one attempt is accumulated. */
      dispatchError?: string;
    },
  ): Promise<ZCodeOffPeakTask | null> {
    await this.ensureReady();
    return this.#repository()
      .offpeakMarkTerminal(offPeakTaskId, options)
      .then((task) => (task ? asSharedTask(task) : null));
  }

  /**
   * User pause/continue, guarded on an unclaimed row: a dispatch already in flight cannot be paused
   * out from under itself, and the caller is told so with `null`.
   */
  async setPaused(
    offPeakTaskId: string,
    paused: boolean,
    options?: { now?: number },
  ): Promise<ZCodeOffPeakTask | null> {
    await this.ensureReady();
    return this.#repository().offpeakSetPaused(offPeakTaskId, paused, options?.now ?? Date.now()).then((task) =>
      task ? asSharedTask(task) : null,
    );
  }

  /**
   * Releases the claim without changing the status — the task stays `queued` and waits for the next
   * round, with no skip. An `error` accumulates the attempt and records `lastError`.
   */
  async releaseClaim(
    offPeakTaskId: string,
    options?: { error?: string; now?: number },
  ): Promise<void> {
    await this.ensureReady();
    await this.#repository().offpeakReleaseClaim(offPeakTaskId, options ?? {});
  }

  /**
   * Startup reclamation: rows a dead process left `running` go back to `queued`, keeping
   * `queuedAt` so they sit near the head of the queue. Returns how many were reclaimed.
   *
   * ⚠ The caller must guarantee no off-peak loop is running: the owner is the app singleton
   * process, not every host.
   */
  async recoverInterrupted(now: number): Promise<number> {
    await this.ensureReady();
    return this.#repository().offpeakRecoverInterrupted(now);
  }

  /**
   * `running` → `queued` when the time box expires, keeping the session and `startedAt` so the
   * resume continues the same task. A task the user already cancelled cannot be resurrected.
   */
  async requeueForContinuation(
    offPeakTaskId: string,
    options?: { now?: number },
  ): Promise<ZCodeOffPeakTask | null> {
    await this.ensureReady();
    return this.#repository().offpeakRequeueForContinuation(offPeakTaskId, options?.now ?? Date.now()).then((task) =>
      task ? asSharedTask(task) : null,
    );
  }

  /** All non-terminal tasks, in queue order — the poll's input. */
  async listNonTerminal(): Promise<ZCodeOffPeakTask[]> {
    await this.ensureReady();
    return this.#repository().offpeakListNonTerminal().then(asSharedTasks);
  }

  /** Backfills the settle ack. Only terminal rows are touched; a repeat keeps the newest time. */
  async markSettled(offPeakTaskId: string, settledAt: number): Promise<void> {
    await this.ensureReady();
    await this.#repository().offpeakMarkSettled(offPeakTaskId, settledAt);
  }

  /** Terminal tasks still awaiting the settle acknowledgement. */
  async listUnsettledTerminal(): Promise<ZCodeOffPeakTask[]> {
    await this.ensureReady();
    return this.#repository().offpeakListUnsettledTerminal().then(asSharedTasks);
  }
}
