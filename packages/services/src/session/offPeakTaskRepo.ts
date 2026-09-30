import {
  isTasksStorageMigrated,
  isTasksStoragePrepared,
} from "#src/session/tasksDatabase/prepared.js";
/* eslint-disable max-lines -- for the same reason as automationRepo: the off-peak repo centrally
   maintains the sqlite schema of off_peak_tasks, the state machine guarded writes and the scheduling
   claims; it will be split by read/write responsibility once things stabilize. */
/* off-peak task repository: the sqlite schema of off_peak_tasks, state machine guarded writes and
   scheduling claims. It shares tasks-index.sqlite and the Repo pattern with automation, but its
   tables/state machine/constants are entirely independent; never add fields to the automations
   table or to the ZCodeAutomation types. */
import { mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import {
  OFF_PEAK_TERMINAL_STATUSES,
  modelSelectionSchema,
  resolveWorkspaceKey,
  type ZCodeOffPeakTask,
  type ZCodeOffPeakTaskCreateParams,
  type ZCodeOffPeakTaskStatus,
  type ZCodeTaskMode,
} from "@zcode/shared";
import { getTasksIndexDatabasePath } from "#src/paths.js";
import { runTasksDatabaseMigrations } from "#src/session/tasksDatabase/migrations.js";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
type DatabaseSyncInstance = InstanceType<typeof DatabaseSync>;

/** Stale claim reclamation: a claim_running=1 row that is still unsettled after this long is treated
    as a crashed holder and may be claimed again. Independent of automation's CLAIM_STALE_MS (same
    semantics, its own constant — do not cross-reference them). */
export const OFF_PEAK_CLAIM_STALE_MS = 10 * 60_000;

/** Terminal-state SQL IN fragment; the single-source projection of OFF_PEAK_TERMINAL_STATUSES. */
const TERMINAL_SQL_LIST = OFF_PEAK_TERMINAL_STATUSES.map((s) => `'${s}'`).join(", ");

interface OffPeakTaskRow {
  off_peak_task_id: string;
  server_ticket_id: string | null;
  title: string;
  conversation_id: string | null;
  session_id: string | null;
  /** The bound session title obtained by list() joining tasks-index; single-row reads do not carry this column. */
  session_title?: string | null;
  prompt: string;
  permission_mode: string;
  model: string | null;
  thought_level: string | null;
  model_selection: string | null;
  workspace_key: string;
  workspace_path: string;
  workspace_identity: string | null;
  status: string;
  queued_at: number;
  started_at: number | null;
  ended_at: number | null;
  failure_reason: string | null;
  files_changed: number | null;
  settled_at: number | null;
  history_deleted_at: number | null;
  registered_at: number | null;
  schedulable: number;
  queue_position: number | null;
  next_poll_at: number | null;
  claim_running: number;
  claimed_at: number | null;
  attempt_count: number;
  last_error: string | null;
  created_at: number;
  updated_at: number;
}

function rowToTask(row: OffPeakTaskRow): ZCodeOffPeakTask {
  const modelSelection = readOffPeakModelSelection(row);
  return {
    offPeakTaskId: row.off_peak_task_id,
    serverTicketId: row.server_ticket_id ?? undefined,
    title: row.title,
    conversationId: row.conversation_id ?? undefined,
    sessionId: row.session_id ?? undefined,
    ...(row.session_title ? { sessionTitle: row.session_title } : {}),
    prompt: row.prompt,
    permissionMode: row.permission_mode as ZCodeTaskMode,
    ...(modelSelection ? { modelSelection } : {}),
    ...(!modelSelection
      ? {
          modelSelectionIssue: {
            code: "repair-required" as const,
          },
        }
      : {}),
    workspaceKey: row.workspace_key,
    workspacePath: row.workspace_path,
    workspaceIdentity: row.workspace_identity ?? undefined,
    status: row.status as ZCodeOffPeakTaskStatus,
    queuedAt: row.queued_at,
    startedAt: row.started_at ?? undefined,
    endedAt: row.ended_at ?? undefined,
    failureReason: row.failure_reason ?? undefined,
    filesChanged: row.files_changed ?? undefined,
    settledAt: row.settled_at ?? undefined,
    historyDeletedAt: row.history_deleted_at ?? undefined,
    registeredAt: row.registered_at ?? undefined,
    schedulable: row.schedulable === 1,
    queuePosition: row.queue_position ?? undefined,
    nextPollAt: row.next_poll_at ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function readOffPeakModelSelection(row: OffPeakTaskRow): ZCodeOffPeakTask["modelSelection"] | null {
  if (row.model_selection) {
    try {
      const parsed = modelSelectionSchema.safeParse(JSON.parse(row.model_selection));
      if (parsed.success) return parsed.data;
    } catch {
      // Continue to attempt a one-way import of old published columns.
    }
  }
  // The old single column does not have a Provider Family and cannot be safely migrated to any of the new Off-Peak Providers.
  return null;
}

function serializeOffPeakModelSelection(
  selection: NonNullable<ZCodeOffPeakTask["modelSelection"]>,
): string {
  const options = selection.options;
  return JSON.stringify(
    modelSelectionSchema.parse({
      providerId: selection.providerId,
      modelId: selection.modelId,
      ...(options && Object.keys(options).length > 0 ? { options } : {}),
    }),
  );
}

/**
 * Off-peak task storage repository (tasks-index.sqlite, WAL, multi-process safe).
 *
 * The repository only does storage and atomic state transitions, guarding two invariants:
 * a terminal state is irreversible; a single task's claim is single-flight (no local cap on
 * concurrency between tasks). Queueing/promotion semantics live on the server and the repository is
 * unaware of them — schedulable is just a snapshot the host writes back while polling.
 */
/** The INSERT hit idx_off_peak_bound_active (the losing side of a concurrent double create). */
export function isOffPeakBoundSessionConflict(error: unknown): boolean {
  return (
    error instanceof Error &&
    /UNIQUE constraint failed: off_peak_tasks\.workspace_key, off_peak_tasks\.session_id/.test(
      error.message,
    )
  );
}

export class OffPeakTaskRepo {
  private db: DatabaseSyncInstance | null = null;
  private dbPath: string | null = null;
  private initializePromise: Promise<void> | null = null;
  // Same as AutomationRepo, the db path cannot rely on the process-level global _dataBaseDir:
  // When vitest threads run test files concurrently, global values are overwritten by each other, and there is a window for writing into the real library.
  // The dbPath is fixed during the construction period. The temporary library path is passed in during the test through dependency injection. If the production path is not passed, the default will be returned.
  private readonly resolvedDbPath: string | null;

  constructor(
    dbPath?: string,
    private readonly startupBusyTimeoutMs = 5000,
  ) {
    this.resolvedDbPath = dbPath?.trim() || null;
  }

  private resolveDbPath(): string {
    return this.resolvedDbPath ?? getTasksIndexDatabasePath();
  }

  async ensureReady(): Promise<void> {
    const path = this.resolveDbPath();
    if (this.dbPath && this.dbPath !== path) {
      this.close();
    }
    if (!this.initializePromise) {
      this.initializePromise = this.initialize(path).catch((error) => {
        this.close();
        throw error;
      });
    }
    await this.initializePromise;
  }

  close(options?: { throwOnError?: boolean }): void {
    let closeError: unknown;
    try {
      this.db?.close();
    } catch (error) {
      closeError = error;
      // ignore
    }
    this.db = null;
    this.dbPath = null;
    this.initializePromise = null;
    if (options?.throwOnError && closeError) throw closeError;
  }

  private async initialize(path: string): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    if (!this.db) {
      this.db = new DatabaseSync(path);
      this.dbPath = path;
      this.db.exec(`PRAGMA busy_timeout = ${this.startupBusyTimeoutMs}`);
      this.db.exec("PRAGMA journal_mode = WAL");
      this.db.exec("PRAGMA synchronous = NORMAL");
    }
    // The worker has completed the original preparation of the path, and the business connection no longer needs to repeat the full table repair.
    if (isTasksStoragePrepared(path, this.db)) return;
    if (!isTasksStorageMigrated(path, this.db)) runTasksDatabaseMigrations(this.db);
    // awaiting_approval was reserved early, but the production link was never written and the UI wrapped it into available capacity.
    // Currently, only ordinary sessions are confirmed; the remaining rows are migrated back to running, and then are processed according to the real process status by startup recycling.
    this.getDatabase()
      .prepare(
        `UPDATE off_peak_tasks
        SET status = 'running', updated_at = @now
        WHERE status = 'awaiting_approval'`,
      )
      .run({ now: Date.now() });
  }

  private getDatabase(): DatabaseSyncInstance {
    if (!this.db) {
      throw new Error("OffPeakTaskRepo is not initialized: await ensureReady() first");
    }
    return this.db;
  }

  private hasTasksIndexTable(): boolean {
    return Boolean(
      this.getDatabase()
        .prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'tasks'`)
        .get(),
    );
  }

  private getRow(offPeakTaskId: string): OffPeakTaskRow | null {
    const row = this.getDatabase()
      .prepare(`SELECT * FROM off_peak_tasks WHERE off_peak_task_id = ?`)
      .get(offPeakTaskId) as OffPeakTaskRow | undefined;
    return row ?? null;
  }

  // ----Manage CRUD ----

  /**
   * Creating the task also enqueues it (status=queued). The ticket is taken in the service layer
   * first (the row is only persisted after POST /ticket succeeds), and the ticket result is written
   * along with the options; the mock-first stage may omit the server-side fields.
   */
  async create(
    params: ZCodeOffPeakTaskCreateParams,
    options?: {
      /** For test injection; defaults to Date.now(). */
      now?: number;
      /** Externally supplied primary key when the service layer takes the ticket before persisting (taking a ticket needs a task_id first); defaults to internal generation. */
      offPeakTaskId?: string;
      serverTicketId?: string;
      queuePosition?: number;
      registeredAt?: number;
      /** Dispatch straight after creation when the ticket comes back ready (the server can promote directly while off-peak is idle). */
      schedulable?: boolean;
    },
  ): Promise<ZCodeOffPeakTask> {
    await this.ensureReady();
    const now = options?.now ?? Date.now();
    const offPeakTaskId = options?.offPeakTaskId ?? `offpeak-${randomUUID()}`;
    const workspaceKey = resolveWorkspaceKey({
      workspacePath: params.workspacePath,
      workspaceIdentity: params.workspaceIdentity,
    });
    this.getDatabase()
      .prepare(
        `INSERT INTO off_peak_tasks (
          off_peak_task_id, server_ticket_id, title, conversation_id, session_id,
          prompt, permission_mode, model, thought_level, model_selection,
          workspace_key, workspace_path, workspace_identity,
          status, queued_at, registered_at, schedulable, queue_position,
          claim_running, attempt_count, created_at, updated_at
        ) VALUES (
          @off_peak_task_id, @server_ticket_id, @title, NULL, @session_id,
          @prompt, @permission_mode, @model, @thought_level, @model_selection,
          @workspace_key, @workspace_path, @workspace_identity,
          'queued', @queued_at, @registered_at, @schedulable, @queue_position,
          0, 0, @now, @now
        )`,
      )
      .run({
        off_peak_task_id: offPeakTaskId,
        server_ticket_id: options?.serverTicketId ?? null,
        title: params.title,
        // Create within the session and bind the current session; conversation_id is still waiting to be backfilled by the first run (non-empty = has been run).
        session_id: params.boundSessionId ?? null,
        prompt: params.prompt,
        permission_mode: params.permissionMode,
        model: null,
        thought_level: null,
        model_selection: serializeOffPeakModelSelection(params.modelSelection),
        workspace_key: workspaceKey,
        workspace_path: params.workspacePath,
        workspace_identity: params.workspaceIdentity ?? null,
        queued_at: now,
        registered_at: options?.registeredAt ?? null,
        schedulable: options?.schedulable ? 1 : 0,
        queue_position: options?.queuePosition ?? null,
        now,
      });
    return rowToTask(this.getRow(offPeakTaskId)!);
  }

  async list(scope?: {
    workspacePath?: string;
    workspaceIdentity?: string;
  }): Promise<ZCodeOffPeakTask[]> {
    await this.ensureReady();
    const workspaceKey = scope?.workspacePath
      ? resolveWorkspaceKey({
          workspacePath: scope.workspacePath,
          workspaceIdentity: scope.workspaceIdentity,
        })
      : null;
    // Bind the session title to join the tasks-index task table (card display) in the same library; if the independent library (before testing/migration) does not have this table, there will be no connection.
    const withSessionTitle = this.hasTasksIndexTable();
    const rows = this.getDatabase()
      .prepare(
        withSessionTitle
          ? `SELECT t.*, s.title AS session_title FROM off_peak_tasks t
            LEFT JOIN tasks s ON s.workspace_key = t.workspace_key AND s.task_id = t.session_id
            WHERE (@workspace_key IS NULL OR t.workspace_key = @workspace_key)
            ORDER BY t.created_at DESC`
          : `SELECT * FROM off_peak_tasks
            WHERE (@workspace_key IS NULL OR workspace_key = @workspace_key)
            ORDER BY created_at DESC`,
      )
      .all({ workspace_key: workspaceKey }) as unknown as OffPeakTaskRow[];
    return rows.map(rowToTask);
  }

  async get(offPeakTaskId: string): Promise<ZCodeOffPeakTask | null> {
    await this.ensureReady();
    const row = this.getRow(offPeakTaskId);
    return row ? rowToTask(row) : null;
  }

  /**
   * When a Registry change invalidates the saved Selection, the original model and level are kept so
   * the user can repair them or a later reliable restore can use them, while the official Selection
   * is cleared and the schedulable state revoked, so the scheduler cannot keep claiming the stale
   * configuration.
   */
  async invalidateModelSelection(
    offPeakTaskId: string,
    modelSelection: NonNullable<ZCodeOffPeakTask["modelSelection"]>,
    options?: { now?: number },
  ): Promise<ZCodeOffPeakTask | null> {
    await this.ensureReady();
    const db = this.getDatabase();
    db.exec("BEGIN IMMEDIATE");
    try {
      const current = this.getRow(offPeakTaskId);
      if (!current) {
        db.exec("COMMIT");
        return null;
      }
      const currentSelection = readOffPeakModelSelection(current);
      if (
        currentSelection &&
        (currentSelection.providerId !== modelSelection.providerId ||
          currentSelection.modelId !== modelSelection.modelId ||
          currentSelection.options?.reasoningLevel !== modelSelection.options?.reasoningLevel)
      ) {
        // Another process has completed the user fix to the updated value and it cannot be overwritten with the old Registry observation.
        db.exec("COMMIT");
        return rowToTask(current);
      }
      db.prepare(
        `UPDATE off_peak_tasks
         SET model = @model, thought_level = @thought_level,
             model_selection = NULL, schedulable = 0, updated_at = @now
         WHERE off_peak_task_id = @id`,
      ).run({
        id: offPeakTaskId,
        model: modelSelection.modelId,
        thought_level: modelSelection.options?.reasoningLevel ?? null,
        now: options?.now ?? Date.now(),
      });
      const invalidated = this.getRow(offPeakTaskId);
      db.exec("COMMIT");
      return invalidated ? rowToTask(invalidated) : null;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  /** Card Delete: deletable in any state (deleting a non-terminal task is settled server-side first, by the service layer cancelling it). */
  async delete(offPeakTaskId: string): Promise<void> {
    await this.ensureReady();
    this.getDatabase()
      .prepare(`DELETE FROM off_peak_tasks WHERE off_peak_task_id = ?`)
      .run(offPeakTaskId);
  }

  /**
   * Only hides the History row: the task must have actually started; repeated calls are idempotent.
   * Does not modify the status, session, started/ended/filesChanged or the server-side settlement
   * fields.
   */
  async markHistoryDeleted(
    offPeakTaskId: string,
    options?: { now?: number },
  ): Promise<ZCodeOffPeakTask | null> {
    await this.ensureReady();
    const row = this.getRow(offPeakTaskId);
    if (!row || row.started_at === null) return row ? rowToTask(row) : null;
    if (row.history_deleted_at !== null) return rowToTask(row);
    const now = options?.now ?? Date.now();
    this.getDatabase()
      .prepare(
        `UPDATE off_peak_tasks
        SET history_deleted_at = @now, updated_at = @now
        WHERE off_peak_task_id = @id AND started_at IS NOT NULL`,
      )
      .run({ id: offPeakTaskId, now });
    return rowToTask(this.getRow(offPeakTaskId)!);
  }

  /** Used for the local pre-check of the creation ceiling (the authority is the server-side ticket take 429/3103). */
  async countNonTerminal(): Promise<number> {
    await this.ensureReady();
    const row = this.getDatabase()
      .prepare(
        `SELECT COUNT(*) AS n FROM off_peak_tasks WHERE status NOT IN (${TERMINAL_SQL_LIST})`,
      )
      .get() as { n: number };
    return row.n;
  }

  /** Whether this session already has a non-terminal bound task (pre-create check; index idx_off_peak_bound_active uses the same condition). */
  async hasActiveBoundTask(workspaceKey: string, sessionId: string): Promise<boolean> {
    await this.ensureReady();
    const row = this.getDatabase()
      .prepare(
        `SELECT 1 AS hit FROM off_peak_tasks
         WHERE workspace_key = @workspace_key AND session_id = @session_id
           AND status NOT IN (${TERMINAL_SQL_LIST})
         LIMIT 1`,
      )
      .get({ workspace_key: workspaceKey, session_id: sessionId }) as { hit: number } | undefined;
    return row !== undefined;
  }

  /** In-flight count: the criterion for the keep-awake powerSaveBlocker. */
  async countActive(): Promise<number> {
    await this.ensureReady();
    const row = this.getDatabase()
      .prepare(`SELECT COUNT(*) AS n FROM off_peak_tasks WHERE status = 'running'`)
      .get() as { n: number };
    return row.n;
  }

  /**
   * Edits the fields in the editable window: only queued/paused are editable; the ticket only locks the
   * queue identity and is read at dispatch time. modelSelection can only be replaced with another
   * explicit Selection; undefined = unchanged.
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
    const row = this.getRow(offPeakTaskId);
    if (!row) return null;
    if (row.status !== "queued" && row.status !== "paused") return null;
    if (params.modelSelection === null) return null;
    const nextModelSelection = params.modelSelection ?? readOffPeakModelSelection(row);
    if (!nextModelSelection) {
      throw new Error(`Off-Peak task has no valid ModelSelection: ${offPeakTaskId}`);
    }
    // The old column is a rollback snapshot of the published version and cannot be cleared due to ordinary editing; this update only changes model_selection.
    // No reverse overwriting of old identities/grades, nor falsification of old values for new records.
    this.getDatabase()
      .prepare(
        `UPDATE off_peak_tasks SET
          title = @title, prompt = @prompt, permission_mode = @permission_mode,
          model_selection = @model_selection, updated_at = @now
        WHERE off_peak_task_id = @id`,
      )
      .run({
        id: offPeakTaskId,
        title: params.title ?? row.title,
        prompt: params.prompt ?? row.prompt,
        permission_mode: params.permissionMode ?? row.permission_mode,
        model_selection: serializeOffPeakModelSelection(nextModelSelection),
        now: options?.now ?? Date.now(),
      });
    return rowToTask(this.getRow(offPeakTaskId)!);
  }

  // ---- Server synchronization snapshot (host offPeakTaskSync write / scheduler read) ----

  /** Poll/re-take write-back: only the explicitly passed fields are overwritten. */
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
    const row = this.getRow(offPeakTaskId);
    if (!row) return;
    this.getDatabase()
      .prepare(
        `UPDATE off_peak_tasks SET
          schedulable = @schedulable,
          queue_position = @queue_position,
          next_poll_at = @next_poll_at,
          server_ticket_id = @server_ticket_id,
          registered_at = @registered_at,
          updated_at = @now
        WHERE off_peak_task_id = @id`,
      )
      .run({
        id: offPeakTaskId,
        schedulable: patch.schedulable === undefined ? row.schedulable : patch.schedulable ? 1 : 0,
        queue_position:
          patch.queuePosition === undefined ? row.queue_position : patch.queuePosition,
        next_poll_at: patch.nextPollAt === undefined ? row.next_poll_at : patch.nextPollAt,
        server_ticket_id: patch.serverTicketId ?? row.server_ticket_id,
        registered_at: patch.registeredAt ?? row.registered_at,
        now: patch.now ?? Date.now(),
      });
  }

  // ---- Scheduling state machine ----

  /**
   * Single-flight claims dispatchable tasks: status=queued and schedulable=1 and no in-flight claim,
   * atomically claim_running 0→1. FIFO order follows queued_at (the authoritative order is
   * guaranteed by the server's ticket-take order). It also reclaims zombie claims whose claim timed
   * out (claimed_at expired).
   */
  async claimDue(now: number): Promise<ZCodeOffPeakTask[]> {
    await this.ensureReady();
    const db = this.getDatabase();
    db.exec("BEGIN IMMEDIATE");
    try {
      db.prepare(
        `UPDATE off_peak_tasks
        SET claim_running = 0, claimed_at = NULL
        WHERE claim_running = 1 AND claimed_at IS NOT NULL AND claimed_at <= @stale`,
      ).run({ stale: now - OFF_PEAK_CLAIM_STALE_MS });
      const dueRows = db
        .prepare(
          `SELECT * FROM off_peak_tasks
          WHERE status = 'queued' AND schedulable = 1 AND claim_running = 0
          ORDER BY queued_at ASC, created_at ASC`,
        )
        .all() as unknown as OffPeakTaskRow[];
      const claimed: ZCodeOffPeakTask[] = [];
      const claim = db.prepare(
        `UPDATE off_peak_tasks
        SET claim_running = 1, claimed_at = @now, updated_at = @now
        WHERE off_peak_task_id = @id AND claim_running = 0`,
      );
      for (const row of dueRows) {
        // History rows may not have Provider status; they must remain in the list awaiting repair, but cannot be
        // Scheduler claims. Skipping row by row also ensures that an old record does not block subsequent health tasks.
        if (!readOffPeakModelSelection(row)) continue;
        const res = claim.run({ id: row.off_peak_task_id, now });
        if (res.changes === 1) {
          claimed.push(rowToTask({ ...row, claim_running: 1, claimed_at: now }));
        }
      }
      db.exec("COMMIT");
      return claimed;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  /**
   * Successful dispatch (gateway admitted): queued→running, backfilling the conversation/session
   * produced by the first run and this segment's ticket, and releasing the claim. Guard: only queued
   * may enter running (a terminal state is irreversible; under a paused race the dispatch result is
   * void and null is returned for the caller to handle). A continuation segment keeps the first
   * segment's started_at (one task from the user's perspective).
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
    const res = this.getDatabase()
      .prepare(
        `UPDATE off_peak_tasks
        SET status = 'running',
            started_at = COALESCE(started_at, @started_at),
            conversation_id = COALESCE(@conversation_id, conversation_id),
            session_id = COALESCE(@session_id, session_id),
            server_ticket_id = COALESCE(@server_ticket_id, server_ticket_id),
            claim_running = 0, claimed_at = NULL,
            last_error = NULL,
            updated_at = @started_at
        WHERE off_peak_task_id = @id AND status = 'queued'`,
      )
      .run({
        id: offPeakTaskId,
        started_at: options.startedAt,
        conversation_id: options.conversationId ?? null,
        session_id: options.sessionId ?? null,
        server_ticket_id: options.serverTicketId ?? null,
      });
    if (res.changes !== 1) return null;
    return rowToTask(this.getRow(offPeakTaskId)!);
  }

  /**
   * Persists the terminal state (completed/failed/cancelled). Guard: a terminal state is
   * irreversible — a row already in a terminal state refuses a second transition and null is
   * returned (the caller discards it that way when a late OffPeakRunResult arrives). settled_at is
   * backfilled separately by the settlement.
   */
  async markTerminal(
    offPeakTaskId: string,
    options: {
      status: "completed" | "failed" | "cancelled";
      endedAt: number;
      failureReason?: string;
      filesChanged?: number;
      /** A deterministic error from the scheduler's dispatch phase; when present, one dispatch attempt is atomically accumulated and last_error kept. */
      dispatchError?: string;
    },
  ): Promise<ZCodeOffPeakTask | null> {
    await this.ensureReady();
    const res = this.getDatabase()
      .prepare(
        `UPDATE off_peak_tasks
        SET status = @status,
            ended_at = @ended_at,
            failure_reason = @failure_reason,
            files_changed = COALESCE(@files_changed, files_changed),
            attempt_count = attempt_count + @dispatch_attempt_inc,
            last_error = COALESCE(@dispatch_error, last_error),
            schedulable = 0,
            claim_running = 0, claimed_at = NULL,
            updated_at = @ended_at
        WHERE off_peak_task_id = @id AND status NOT IN (${TERMINAL_SQL_LIST})`,
      )
      .run({
        id: offPeakTaskId,
        status: options.status,
        ended_at: options.endedAt,
        failure_reason: options.failureReason ?? null,
        files_changed: options.filesChanged ?? null,
        dispatch_attempt_inc: options.dispatchError ? 1 : 0,
        dispatch_error: options.dispatchError ?? null,
      });
    if (res.changes !== 1) return null;
    return rowToTask(this.getRow(offPeakTaskId)!);
  }

  /**
   * User Pause / Continue: queued ⇄ paused.
   * Pause only stops local dispatch (the ticket stays in the server queue); the ticket validity check
   * for Continue and the re-take live in the service layer. A task whose dispatch is already claimed
   * and in flight (claim_running=1) cannot be paused; null is returned.
   */
  async setPaused(
    offPeakTaskId: string,
    paused: boolean,
    options?: { now?: number },
  ): Promise<ZCodeOffPeakTask | null> {
    await this.ensureReady();
    const res = this.getDatabase()
      .prepare(
        `UPDATE off_peak_tasks
        SET status = @to, updated_at = @now
        WHERE off_peak_task_id = @id AND status = @from AND claim_running = 0`,
      )
      .run({
        id: offPeakTaskId,
        to: paused ? "paused" : "queued",
        from: paused ? "queued" : "paused",
        now: options?.now ?? Date.now(),
      });
    if (res.changes !== 1) return null;
    return rowToTask(this.getRow(offPeakTaskId)!);
  }

  /**
   * Releases the claim (dispatch failure / shutdown exit): resets the single-flight lock; when an error
   * is passed, attempt_count is accumulated and last_error recorded (for dispatch backoff and
   * diagnostics). The status is not changed — the task stays queued waiting for the next claim round
   * (no skip).
   */
  async releaseClaim(
    offPeakTaskId: string,
    options?: { error?: string; now?: number },
  ): Promise<void> {
    await this.ensureReady();
    this.getDatabase()
      .prepare(
        `UPDATE off_peak_tasks
        SET claim_running = 0, claimed_at = NULL,
            attempt_count = attempt_count + @attempt_inc,
            last_error = COALESCE(@error, last_error),
            updated_at = @now
        WHERE off_peak_task_id = @id AND claim_running = 1`,
      )
      .run({
        id: offPeakTaskId,
        attempt_inc: options?.error ? 1 : 0,
        error: options?.error ?? null,
        now: options?.now ?? Date.now(),
      });
  }

  /**
   * Startup reclamation (called once at app-level startup, before any dispatch): puts the running rows
   * left behind by a dead process back to queued (keeping queued_at, so they naturally sit near the
   * head of the queue; keeping session_id for a resumed continuation run) and cleans up timed-out
   * claims. Returns the number of reclaimed tasks.
   * ⚠ The caller must guarantee that no off-peak loop is running at call time (the owner should be
   * the app singleton process, not every host).
   */
  async recoverInterrupted(now: number): Promise<number> {
    await this.ensureReady();
    const db = this.getDatabase();
    db.exec("BEGIN IMMEDIATE");
    try {
      const recovered = db
        .prepare(
          `UPDATE off_peak_tasks
          SET status = 'queued', claim_running = 0, claimed_at = NULL, updated_at = @now
          WHERE status = 'running'`,
        )
        .run({ now });
      db.prepare(
        `UPDATE off_peak_tasks
        SET claim_running = 0, claimed_at = NULL, updated_at = @now
        WHERE claim_running = 1 AND claimed_at IS NOT NULL AND claimed_at <= @stale`,
      ).run({ now, stale: now - OFF_PEAK_CLAIM_STALE_MS });
      db.exec("COMMIT");
      return Number(recovered.changes ?? 0);
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  /**
   * Requeue for a continuation run when the 3h time box expires / the ready ticket is voided:
   * running → queued, keeping session/conversation/started_at so a resume can continue it; schedulable
   * and the queue position are cleared and refreshed by the poll after a new ticket is taken.
   * Terminal/paused tasks cannot requeue and null is returned (e.g. the user cancelled first).
   */
  async requeueForContinuation(
    offPeakTaskId: string,
    options?: { now?: number },
  ): Promise<ZCodeOffPeakTask | null> {
    await this.ensureReady();
    const res = this.getDatabase()
      .prepare(
        `UPDATE off_peak_tasks
        SET status = 'queued', schedulable = 0, queue_position = NULL,
            claim_running = 0, claimed_at = NULL, updated_at = @now
        WHERE off_peak_task_id = @id AND status = 'running'`,
      )
      .run({ id: offPeakTaskId, now: options?.now ?? Date.now() });
    if (res.changes !== 1) return null;
    return rowToTask(this.getRow(offPeakTaskId)!);
  }

  /** All non-terminal tasks (the poll input of offPeakTaskSync: it only polls when non-terminal tasks exist). */
  async listNonTerminal(): Promise<ZCodeOffPeakTask[]> {
    await this.ensureReady();
    const rows = this.getDatabase()
      .prepare(
        `SELECT * FROM off_peak_tasks
        WHERE status NOT IN (${TERMINAL_SQL_LIST})
        ORDER BY queued_at ASC`,
      )
      .all() as unknown as OffPeakTaskRow[];
    return rows.map(rowToTask);
  }

  // ---- Final write-off outbox----

  /** Backfilled after the settle server ack; only terminal rows can be settled (idempotent — a repeated backfill overwrites with the latest ack time). */
  async markSettled(offPeakTaskId: string, settledAt: number): Promise<void> {
    await this.ensureReady();
    this.getDatabase()
      .prepare(
        `UPDATE off_peak_tasks
        SET settled_at = @settled_at, updated_at = @settled_at
        WHERE off_peak_task_id = @id AND status IN (${TERMINAL_SQL_LIST})`,
      )
      .run({ id: offPeakTaskId, settled_at: settledAt });
  }

  /** Terminal tasks that are not settled yet: reported along as a side effect of the poll cycle + a host startup scan (no extra timer). */
  async listUnsettledTerminal(): Promise<ZCodeOffPeakTask[]> {
    await this.ensureReady();
    const rows = this.getDatabase()
      .prepare(
        `SELECT * FROM off_peak_tasks
        WHERE status IN (${TERMINAL_SQL_LIST}) AND settled_at IS NULL
        ORDER BY ended_at ASC`,
      )
      .all() as unknown as OffPeakTaskRow[];
    return rows.map(rowToTask);
  }
}
