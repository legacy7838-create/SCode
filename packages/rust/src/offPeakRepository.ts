/**
 * `@zcode/rust/task-index` — the off-peak repository.
 *
 * Spec: docs/specs/rust-native-task-index.md §20.
 *
 * These are the twenty methods of `offPeakTaskRepo.ts`, transcribed one for one. They hang off
 * `TaskIndexStore` rather than a second class, because that is where the Rust surface puts them: a
 * separate napi class would have to take the store by reference, and napi's `ClassInstance` cannot
 * unwrap a `TaskIndexStore`, so the two facades would have been unable to share one connection.
 *
 * There is **no JavaScript fallback**: `loadNative` throws when the binary is missing, and a
 * scheduling state machine that silently half-runs is worse than one that refuses to start.
 */
import { NATIVE_STORE, type NativeStore, type TaskIndexStore } from "./taskIndex.js";

/** A validated model selection, mirroring `ModelSelection` in `@zcode/shared`. */
export interface OffPeakModelSelection {
  providerId: string;
  modelId: string;
  options?: { reasoningLevel?: string };
}

/** Mirrors `ZCodeOffPeakTask`. Optional members are **omitted** when absent, never `null`. */
export interface OffPeakTask {
  offPeakTaskId: string;
  serverTicketId?: string;
  title: string;
  conversationId?: string;
  sessionId?: string;
  /** Only `offpeakList` populates this, by joining the `tasks` table. */
  sessionTitle?: string;
  prompt: string;
  permissionMode: string;
  modelSelection?: OffPeakModelSelection;
  /** Present exactly when `modelSelection` is absent — the card's "needs repair" affordance. */
  modelSelectionIssue?: { code: "repair-required" };
  workspaceKey: string;
  workspacePath: string;
  workspaceIdentity?: string;
  status: string;
  queuedAt: number;
  startedAt?: number;
  endedAt?: number;
  failureReason?: string;
  filesChanged?: number;
  settledAt?: number;
  historyDeletedAt?: number;
  registeredAt?: number;
  schedulable: boolean;
  queuePosition?: number;
  nextPollAt?: number;
  createdAt: number;
  updatedAt: number;
}

/**
 * The off-peak repository handle.
 *
 * The same store: the two facades share one sqlite connection and one migration ledger, which is
 * the arrangement spec §4.4 chose over two connections in two languages. A named factory so a
 * caller that only wants the off-peak surface can say so.
 */

export class OffPeakRepository {
  /** The same native object the task index uses: one connection, one migration ledger. */
  readonly #store: NativeStore;

  constructor(store: TaskIndexStore) {
    this.#store = store[NATIVE_STORE];
  }

  /**
   * The domain task, not the stored row: the original's `get` returns `rowToTask(...)`, which
   * carries `title`, `permissionMode` and the validated `modelSelection`, and omits every absent
   * optional rather than sending `null`.
   */
  async offpeakGet(offPeakTaskId: string): Promise<OffPeakTask | null> {
    const raw = await this.#store.offpeakGet(offPeakTaskId);
    return raw ? (JSON.parse(raw) as OffPeakTask) : null;
  }

  /**
   * Single-flight claims dispatchable tasks.
   *
   * The returned tasks are the rows **as they were read**, so `updatedAt` is the value the caller
   * acted on rather than the claim's own write. A row whose model selection does not validate is
   * skipped rather than dispatched, and skipping row by row is what stops one bad record from
   * blocking every healthy task behind it.
   */
  async offpeakClaimDue(now: number = Date.now()): Promise<OffPeakTask[]> {
    return JSON.parse(await this.#store.offpeakClaimDue(now)) as OffPeakTask[];
  }

  /**
   * Deletes in any state. The service layer settles a non-terminal task server-side before calling
   * this, so the card's delete is unconditional — and a missing row is not an error.
   */
  async offpeakDelete(offPeakTaskId: string): Promise<void> {
    await this.#store.offpeakDelete(offPeakTaskId);
  }

  /**
   * Moves `awaiting_approval` rows back to `running`, once, after the migrations.
   *
   * **Not** the same transition as `offpeakRecoverInterrupted`, which goes the other way
   * (`running` → `queued`). A row left in `awaiting_approval` is not inert: the UI counts it as
   * available capacity, so it looks dispatchable and is never dispatched.
   */
  async offpeakRecycleAwaitingApproval(now: number = Date.now()): Promise<number> {
    return this.#store.offpeakRecycleAwaitingApproval(now);
  }

  async offpeakCountNonTerminal(): Promise<number> {
    return this.#store.offpeakCountNonTerminal();
  }

  async offpeakCountActive(): Promise<number> {
    return this.#store.offpeakCountActive();
  }

  async offpeakHasActiveBoundTask(workspaceKey: string, sessionId: string): Promise<boolean> {
    return this.#store.offpeakHasActiveBoundTask(workspaceKey, sessionId);
  }

// -------------------------------------------------------------------------

/** Creating a task also enqueues it: the row lands `queued`. */
async offpeakCreate(params: {
  offPeakTaskId: string;
  title: string;
  prompt: string;
  permissionMode: string;
  modelSelection: OffPeakModelSelection;
  workspacePath: string;
  workspaceIdentity?: string;
  /**
   * `workspaceIdentity?.trim() || workspacePath`, per §Workspace Identity.
   *
   * Optional here and resolved below, because the original resolved it inside `create` and a
   * caller that passed the path should not also have to pass the derived key — getting the two
   * out of step would file the row under a scope nothing else queries.
   */
  workspaceKey?: string;
  sessionId?: string;
  serverTicketId?: string;
  queuePosition?: number;
  registeredAt?: number;
  schedulable?: boolean;
  now?: number;
}): Promise<OffPeakTask> {
  const raw = await this.#store.offpeakCreate(
    JSON.stringify({
      offPeakTaskId: params.offPeakTaskId,
      title: params.title,
      prompt: params.prompt,
      permissionMode: params.permissionMode,
      modelSelection: params.modelSelection,
      workspacePath: params.workspacePath,
      workspaceIdentity: params.workspaceIdentity ?? null,
      // The identity rule, verbatim: a trimmed non-empty identity wins, otherwise the path.
      workspaceKey:
        params.workspaceKey ?? (params.workspaceIdentity?.trim() || params.workspacePath),
      sessionId: params.sessionId ?? null,
      serverTicketId: params.serverTicketId ?? null,
      queuePosition: params.queuePosition ?? null,
      registeredAt: params.registeredAt ?? null,
      schedulable: params.schedulable ?? false,
      now: params.now ?? Date.now(),
    }),
  );
  return JSON.parse(raw) as OffPeakTask;
}

/**
 * Lists tasks, optionally scoped to one workspace.
 *
 * The scope is a **resolved key**, not a path: the identity rule is applied by the caller, so two
 * paths sharing an identity cannot produce two scopes.
 */
async offpeakList(workspaceKey?: string): Promise<OffPeakTask[]> {
  const raw = await this.#store.offpeakList(JSON.stringify({ workspaceKey: workspaceKey ?? null }));
  return JSON.parse(raw) as OffPeakTask[];
}

/**
 * Applies a Registry observation that invalidated the stored selection.
 *
 * The Rust side refuses to overwrite a selection another process already repaired: if the stored
 * provider, model or reasoning level differs, the row comes back **unchanged**.
 */
async offpeakInvalidateModelSelection(
  offPeakTaskId: string,
  modelSelection: OffPeakModelSelection,
  now: number = Date.now(),
): Promise<OffPeakTask | null> {
  const raw = await this.#store.offpeakInvalidateModelSelection(
    JSON.stringify({ offPeakTaskId, modelSelection, now }),
  );
  return JSON.parse(raw) as OffPeakTask | null;
}

/** Hides the history row, only for a task that actually started. A repeat keeps the first time. */
async offpeakMarkHistoryDeleted(offPeakTaskId: string, now: number = Date.now()): Promise<OffPeakTask | null> {
  return JSON.parse(await this.#store.offpeakMarkHistoryDeleted(JSON.stringify({ offPeakTaskId, now }))) as
    | OffPeakTask
    | null;
}

/**
 * Edits the editable window. Only `queued`/`paused` tasks are editable.
 *
 * `modelSelection: null` is **rejected**, not applied: clearing it would make the task
 * permanently un-claimable. An absent field means "leave alone", which is why the patch fields
 * are individually optional rather than one nullable object.
 */
async offpeakUpdateEditableFields(
  offPeakTaskId: string,
  patch: {
    title?: string;
    prompt?: string;
    permissionMode?: string;
    modelSelection?: OffPeakModelSelection | null;
  },
  now: number = Date.now(),
): Promise<OffPeakTask | null> {
  const raw = await this.#store.offpeakUpdateEditableFields(
    JSON.stringify({
      offPeakTaskId,
      title: patch.title,
      prompt: patch.prompt,
      permissionMode: patch.permissionMode,
      modelSelection: patch.modelSelection ?? undefined,
      // A tri-state collapsed into a flag: absent = leave alone, null = refuse, value = set.
      clearModelSelection: patch.modelSelection === null,
      now,
    }),
  );
  return JSON.parse(raw) as OffPeakTask | null;
}

/**
 * The poll's write-back. An absent field keeps its stored value — the Rust side reads the current
 * row first, because writing `NULL` would erase a field the server did not mention. A missing
 * task is a no-op, not an error.
 */
async offpeakUpdateSchedulingSnapshot(
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
  await this.#store.offpeakUpdateSchedulingSnapshot(
    JSON.stringify({
      offPeakTaskId,
      schedulable: patch.schedulable,
      queuePosition: patch.queuePosition,
      nextPollAt: patch.nextPollAt,
      serverTicketId: patch.serverTicketId,
      registeredAt: patch.registeredAt,
      now: patch.now ?? Date.now(),
    }),
  );
}

/**
 * `queued` → `running`, guarded. A late dispatch result arriving after the task moved on is
 * refused and reported as `null`. A continuation segment keeps the first `startedAt`, so one task
 * stays one task across resumes.
 */
async offpeakMarkRunning(
  offPeakTaskId: string,
  options: {
    startedAt: number;
    conversationId?: string;
    sessionId?: string;
    serverTicketId?: string;
  },
): Promise<OffPeakTask | null> {
  const raw = await this.#store.offpeakMarkRunning(
    JSON.stringify({
      offPeakTaskId,
      startedAt: options.startedAt,
      conversationId: options.conversationId ?? null,
      sessionId: options.sessionId ?? null,
      serverTicketId: options.serverTicketId ?? null,
    }),
  );
  return JSON.parse(raw) as OffPeakTask | null;
}

/**
 * Persists a terminal state, which is **irreversible**: a second transition changes no rows and
 * returns `null`, so a late result cannot rewrite a completed task as failed.
 */
async offpeakMarkTerminal(
  offPeakTaskId: string,
  options: {
    status: "completed" | "failed" | "cancelled";
    endedAt: number;
    failureReason?: string;
    filesChanged?: number;
    /** A deterministic dispatch-phase error; when present, one attempt is accumulated. */
    dispatchError?: string;
  },
): Promise<OffPeakTask | null> {
  const raw = await this.#store.offpeakMarkTerminal(
    JSON.stringify({
      offPeakTaskId,
      status: options.status,
      endedAt: options.endedAt,
      failureReason: options.failureReason ?? null,
      filesChanged: options.filesChanged ?? null,
      dispatchError: options.dispatchError ?? null,
    }),
  );
  return JSON.parse(raw) as OffPeakTask | null;
}

/**
 * User pause/continue, guarded on `claimRunning = 0`: a dispatch already in flight cannot be
 * paused out from under itself, and the caller is told so with `null`.
 */
async offpeakSetPaused(
  offPeakTaskId: string,
  paused: boolean,
  now: number = Date.now(),
): Promise<OffPeakTask | null> {
  return JSON.parse(await this.#store.offpeakSetPaused(JSON.stringify({ offPeakTaskId, paused, now }))) as
    | OffPeakTask
    | null;
}

/**
 * Releases the claim without changing the status — the task stays `queued` and waits for the
 * next round, with no skip. An `error` accumulates the attempt and records `lastError`.
 */
async offpeakReleaseClaim(offPeakTaskId: string, options: { error?: string; now?: number } = {}): Promise<void> {
  await this.#store.offpeakReleaseClaim(
    JSON.stringify({
      offPeakTaskId,
      // `null` and `undefined` both mean "no error", which differs from an empty string.
      error: options.error ?? null,
      now: options.now ?? Date.now(),
    }),
  );
}

/**
 * Startup reclamation: rows a dead process left `running` go back to `queued`, keeping `queuedAt`
 * so they sit near the head of the queue. Returns how many were reclaimed.
 */
async offpeakRecoverInterrupted(now: number = Date.now()): Promise<number> {
  return this.#store.offpeakRecoverInterrupted(now);
}

/**
 * `running` → `queued` when the time box expires, keeping the session and `startedAt` so the
 * resume continues the same task. A task the user already cancelled cannot be resurrected.
 */
async offpeakRequeueForContinuation(offPeakTaskId: string, now: number = Date.now()): Promise<OffPeakTask | null> {
  return JSON.parse(
    await this.#store.offpeakRequeueForContinuation(JSON.stringify({ offPeakTaskId, now })),
  ) as OffPeakTask | null;
}

/** All non-terminal tasks, in queue order — the poll's input. */
async offpeakListNonTerminal(): Promise<OffPeakTask[]> {
  return JSON.parse(await this.#store.offpeakListNonTerminal()) as OffPeakTask[];
}

/** Terminal tasks still awaiting the settle acknowledgement. */
async offpeakListUnsettledTerminal(): Promise<OffPeakTask[]> {
  return JSON.parse(await this.#store.offpeakListUnsettledTerminal()) as OffPeakTask[];
}

/** Backfills the settle ack. Only terminal rows are touched; a repeat keeps the newest time. */
async offpeakMarkSettled(offPeakTaskId: string, settledAt: number): Promise<void> {
  await this.#store.offpeakMarkSettled(offPeakTaskId, settledAt);
}
}
