import {
  isTasksStorageMigrated,
  isTasksStoragePrepared,
} from "#src/session/tasksDatabase/prepared.js";
/* eslint-disable max-lines -- the automation repo centrally maintains the sqlite schema of
   automations / automation_runs, the scheduling state machine writes and the run history; it will be
   split by read/write responsibility once things stabilize. */
import { mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import {
  AUTOMATION_CREATE_LIMIT,
  AUTOMATION_CREATE_LIMIT_ERROR_CODE,
  resolveWorkspaceKey,
  zcodeAutomationBotDeliveryTargetSchema,
  modelSelectionSchema,
  zcodeTaskModeSchema,
  type ZCodeAutomation,
  type ZCodeAutomationBotDeliveryTarget,
  type ZCodeAutomationCreateParams,
  type ZCodeAutomationDispatchStatus,
  type ZCodeAutomationLifecycleStatus,
  type ModelSelection,
  type ZCodeAutomationRun,
  type ZCodeAutomationRunDispatchStatus,
  type ZCodeAutomationRunOutcome,
  type ZCodeAutomationTrigger,
  type ZCodeAutomationUpdateParams,
} from "@zcode/shared";
import { getTasksIndexDatabasePath } from "#src/paths.js";
import { runTasksDatabaseMigrations } from "#src/session/tasksDatabase/migrations.js";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
type DatabaseSyncInstance = InstanceType<typeof DatabaseSync>;

/** Dispatch-failure backoff constants. */
export const DISPATCH_RETRY_BASE_MS = 30_000;
export const DISPATCH_RETRY_CAP_MS = 15 * 60_000;
export const DISPATCH_MAX_ATTEMPTS = 5;
/** Stale claim reclamation: a running=1 row that is still unsettled after this long is treated as a crashed holder and may be claimed again. */
export const CLAIM_STALE_MS = 10 * 60_000;

/** The total creation count exceeds the product ceiling; the error code is preserved in the message across RPC for the UI to recognize. */
export class AutomationCreateLimitError extends Error {
  readonly code = AUTOMATION_CREATE_LIMIT_ERROR_CODE;

  constructor() {
    super(
      `[${AUTOMATION_CREATE_LIMIT_ERROR_CODE}] At most ${AUTOMATION_CREATE_LIMIT} automations may be retained. Delete an existing automation before creating another.`,
    );
    this.name = "AutomationCreateLimitError";
  }
}

interface AutomationRow {
  automation_id: string;
  title: string;
  cron_expr: string;
  prompt: string;
  model: string | null;
  provider: string | null;
  mode: string | null;
  thought_level: string | null;
  model_selection: string | null;
  workspace_key: string;
  workspace_path: string;
  workspace_identity: string | null;
  target_task_id: string | null;
  bot_delivery_target: string | null;
  location_kind: string;
  recurring: number;
  max_runs: number | null;
  end_at: number | null;
  schedule_rule: string | null;
  schedule_edited_by_user: number;
  run_count: number;
  scheduled_run_count: number;
  enabled: number;
  lifecycle_status: string;
  next_run_at: number | null;
  last_run_at: number | null;
  running: number;
  claimed_at: number | null;
  dispatch_status: string;
  dispatch_attempts: number;
  retry_at: number | null;
  last_error: string | null;
  created_at: number;
  updated_at: number;
}

interface AutomationRunRow {
  run_id: string;
  automation_id: string;
  workspace_key: string;
  scheduled_at: number | null;
  trigger: string;
  model_selection: string | null;
  dispatch_status: string;
  outcome: string | null;
  session_id: string | null;
  error: string | null;
  attempts: number;
  created_at: number;
  updated_at: number;
}

interface ClaimedManualAutomationRun {
  automation: ZCodeAutomation;
  run: ZCodeAutomationRun;
}

function rowToAutomation(row: AutomationRow): ZCodeAutomation {
  const modelSelection = readAutomationModelSelection(row);
  return {
    automationId: row.automation_id,
    title: row.title,
    cronExpr: row.cron_expr,
    prompt: row.prompt,
    ...(modelSelection ? { modelSelection } : {}),
    // Historical versions once wrote empty strings into mode, and the old reading logic was directly forced to enumeration, resulting in
    // automation/list gets bogged down by a single piece of dirty data while verifying the entire array at the protocol level. Historical illegal values ​​are compatible with not being set.
    mode: normalizeAutomationMode(row.mode),
    workspaceKey: row.workspace_key,
    workspacePath: row.workspace_path,
    workspaceIdentity: row.workspace_identity ?? undefined,
    targetTaskId: row.target_task_id ?? undefined,
    locationKind: row.location_kind === "remote" ? "remote" : "local",
    recurring: row.recurring === 1,
    maxRuns: row.max_runs ?? undefined,
    endAt: row.end_at ?? undefined,
    scheduleRule: row.schedule_rule
      ? (JSON.parse(row.schedule_rule) as ZCodeAutomation["scheduleRule"])
      : undefined,
    ...(row.schedule_edited_by_user === 1 ? { scheduleEditedByUser: true } : {}),
    runCount: row.run_count,
    enabled: row.enabled === 1,
    lifecycleStatus: row.lifecycle_status as ZCodeAutomationLifecycleStatus,
    nextRunAt: row.next_run_at ?? undefined,
    lastRunAt: row.last_run_at ?? undefined,
    dispatchStatus: row.dispatch_status as ZCodeAutomationDispatchStatus,
    dispatchAttempts: row.dispatch_attempts,
    retryAt: row.retry_at ?? undefined,
    lastError: row.last_error ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function readAutomationModelSelection(row: AutomationRow): ZCodeAutomation["modelSelection"] {
  // Old fields can only go through a standalone importer; old selections cannot be resurrected when new fields are corrupted or explicitly cleared.
  return readSerializedModelSelection(row.model_selection);
}

function serializeAutomationModelSelection(
  selection: ZCodeAutomation["modelSelection"],
): string | null {
  if (!selection) return null;
  const options = selection.options;
  const parsed = modelSelectionSchema.parse({
    providerId: selection.providerId,
    modelId: selection.modelId,
    ...(options && Object.keys(options).length > 0 ? { options } : {}),
  });
  return JSON.stringify(parsed);
}

function normalizeAutomationMode(mode: string | null): ZCodeAutomation["mode"] | undefined {
  const parsed = zcodeTaskModeSchema.safeParse(mode);
  return parsed.success ? parsed.data : undefined;
}

function assertValidAutomationMode(mode: unknown): void {
  if (mode === undefined || mode === null) return;
  if (!zcodeTaskModeSchema.safeParse(mode).success) {
    // Reading compatible historical dirty data does not mean that you are allowed to continue writing dirty data; Repo is the final persistence boundary when bypassing RPC.
    throw new Error(`Invalid automation mode: ${String(mode)}`);
  }
}

function rowToRun(row: AutomationRunRow): ZCodeAutomationRun {
  const modelSelection = readSerializedModelSelection(row.model_selection);
  return {
    runId: row.run_id,
    automationId: row.automation_id,
    workspaceKey: row.workspace_key,
    scheduledAt: row.scheduled_at ?? undefined,
    trigger: row.trigger as ZCodeAutomationTrigger,
    ...(modelSelection ? { modelSelection } : {}),
    dispatchStatus: row.dispatch_status as ZCodeAutomationRunDispatchStatus,
    outcome: (row.outcome as ZCodeAutomationRunOutcome | null) ?? undefined,
    sessionId: row.session_id ?? undefined,
    error: row.error ?? undefined,
    attempts: row.attempts,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function readSerializedModelSelection(value: string | null): ModelSelection | undefined {
  if (!value) return undefined;
  try {
    const parsed = modelSelectionSchema.safeParse(JSON.parse(value));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/** Backoff retry time: now + min(BASE * 2^(attempts-1), CAP). */
export function computeRetryAt(now: number, attempts: number): number {
  const backoff = Math.min(
    DISPATCH_RETRY_BASE_MS * 2 ** Math.max(0, attempts - 1),
    DISPATCH_RETRY_CAP_MS,
  );
  return now + backoff;
}

/**
 * automation storage repository: automations (definition + scheduling state) and automation_runs
 * (run history + runId idempotency ledger), sharing tasks-index.sqlite with the task index
 * (WAL, multi-process safe).
 *
 * The repository only does storage and atomic state transitions; cron expression parsing /
 * next_run_at computation is done by the caller (scheduler / management layer) with a cron library
 * and passed in, so the repository is unaware of cron semantics.
 */
export class AutomationRepo {
  private db: DatabaseSyncInstance | null = null;
  private dbPath: string | null = null;
  private initializePromise: Promise<void> | null = null;
  // db path cannot be resolved from process-level global _dataBaseDir(getTasksIndexDatabasePath):
  // The vitest threads pool will run multiple test files concurrently in the same process. The setDataBaseDir(tempDir) of each file
  // Overwriting each other's global values, causing repo and bare SQL operations to be written into the real library ~/.zcode/v2 (historical dirty data) within the concurrency window
  // The /tmp/ws series is thus contaminated). Instead, a copy of dbPath is fixed during construction, and the test passes in the temporary library path through dependency injection.
  // If the production path is not passed, it will fall back to getTasksIndexDatabasePath, which is backward compatible.
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
  }

  private getDatabase(): DatabaseSyncInstance {
    if (!this.db) {
      throw new Error("AutomationRepo is not initialized: await ensureReady() first");
    }
    return this.db;
  }

  // Forced ownership verification when workspaceKey is passed in (write/single check path to prevent cross-workspace cross-border); omitted = no filtering,
  // Used by scheduler/host for cross-workspace scheduling state machines.
  private getRow(automationId: string, workspaceKey?: string): AutomationRow | null {
    const row = this.getDatabase()
      .prepare(
        `SELECT * FROM automations
        WHERE automation_id = @id
          AND (@workspace_key IS NULL OR workspace_key = @workspace_key)`,
      )
      .get({ id: automationId, workspace_key: workspaceKey ?? null }) as AutomationRow | undefined;
    return row ?? null;
  }

  // ----Manage CRUD ----

  async create(
    params: ZCodeAutomationCreateParams,
    options: { nextRunAt: number | null; lifecycleStatus?: ZCodeAutomationLifecycleStatus },
  ): Promise<ZCodeAutomation> {
    assertValidAutomationMode(params.mode);
    await this.ensureReady();
    const now = Date.now();
    const automationId = `automation-${randomUUID()}`;
    const workspaceKey = resolveWorkspaceKey({
      workspacePath: params.workspacePath,
      workspaceIdentity: params.workspaceIdentity,
    });
    const db = this.getDatabase();
    // Just list then create outside the UI or transaction will make multiple window/CronCreate concurrent requests pass the old count at the same time.
    // BEGIN IMMEDIATE serializes "full state total check + insert" to ensure that the local task index does not exceed 20 entries.
    db.exec("BEGIN IMMEDIATE");
    try {
      const countRow = db.prepare("SELECT COUNT(*) AS count FROM automations").get() as {
        count: number | bigint;
      };
      if (Number(countRow.count) >= AUTOMATION_CREATE_LIMIT) {
        throw new AutomationCreateLimitError();
      }
      db.prepare(
        `INSERT INTO automations (
          automation_id, title, cron_expr, prompt, model, provider, model_selection,
          workspace_key, workspace_path, workspace_identity, target_task_id, bot_delivery_target, location_kind,
          recurring, max_runs, end_at, schedule_rule, schedule_edited_by_user,
          run_count, enabled, lifecycle_status,
          next_run_at, last_run_at, running, claimed_at,
          dispatch_status, dispatch_attempts, retry_at, last_error,
          mode, thought_level,
          created_at, updated_at
        ) VALUES (
          @automation_id, @title, @cron_expr, @prompt, @model, @provider, @model_selection,
          @workspace_key, @workspace_path, @workspace_identity, @target_task_id, @bot_delivery_target, 'local',
          @recurring, @max_runs, @end_at, @schedule_rule, 0,
          0, @enabled, @lifecycle_status,
          @next_run_at, NULL, 0, NULL,
          'idle', 0, NULL, NULL,
          @mode, @thought_level,
          @created_at, @updated_at
        )`,
      ).run({
        automation_id: automationId,
        title: params.title,
        cron_expr: params.cronExpr,
        prompt: params.prompt,
        model: null,
        provider: null,
        // Explicit NULLs for task configurations are separated from SQL NULLs that have not yet been migrated; SQL NULL freeze semantics for run are unchanged.
        model_selection: serializeAutomationModelSelection(params.modelSelection) ?? "null",
        mode: params.mode ?? null,
        thought_level: null,
        workspace_key: workspaceKey,
        workspace_path: params.workspacePath,
        workspace_identity: params.workspaceIdentity ?? null,
        target_task_id: params.targetTaskId ?? null,
        bot_delivery_target: params.botDeliveryTarget
          ? JSON.stringify(params.botDeliveryTarget)
          : null,
        recurring: params.recurring ? 1 : 0,
        max_runs: params.maxRuns ?? null,
        end_at: params.endAt ?? null,
        schedule_rule: params.scheduleRule ? JSON.stringify(params.scheduleRule) : null,
        enabled: options.lifecycleStatus === "completed" ? 0 : 1,
        lifecycle_status: options.lifecycleStatus ?? "active",
        next_run_at: options.nextRunAt,
        created_at: now,
        updated_at: now,
      });
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    return rowToAutomation(this.getRow(automationId)!);
  }

  async list(scope?: {
    workspacePath?: string;
    workspaceIdentity?: string;
  }): Promise<ZCodeAutomation[]> {
    await this.ensureReady();
    const workspaceKey = scope?.workspacePath
      ? resolveWorkspaceKey({
          workspacePath: scope.workspacePath,
          workspaceIdentity: scope.workspaceIdentity,
        })
      : null;
    const rows = this.getDatabase()
      .prepare(
        `SELECT * FROM automations
        WHERE (@workspace_key IS NULL OR workspace_key = @workspace_key)
        ORDER BY created_at DESC`,
      )
      .all({ workspace_key: workspaceKey }) as unknown as AutomationRow[];
    return rows.map(rowToAutomation);
  }

  /** Read dedicated to the first dispatch: the list may display unbound tasks, but a dispatch must not treat a corrupt value as "follow the default". */
  async getModelSelectionForDispatch(
    automationId: string,
    workspaceKey: string,
  ): Promise<ModelSelection | undefined> {
    await this.ensureReady();
    const row = this.getRow(automationId, workspaceKey);
    if (!row) throw new Error("Automation does not exist or does not belong to this workspace");
    const selection = readAutomationModelSelection(row);
    if (selection) return selection;
    // The migration has written the old default as JSON null. SQL NULL is a missing configuration, and old columns cannot be used to determine the default value.
    const followsWorkspace = row.model_selection === "null";
    if (!followsWorkspace)
      throw new Error(
        "Automation model selection is unavailable; pick a model and thought level again",
      );
    return undefined;
  }

  /**
   * Reads the Bot delivery target for background dispatch only; this internal source information never enters the automation display model.
   */
  async getBotDeliveryTarget(
    automationId: string,
    workspaceKey?: string,
  ): Promise<ZCodeAutomationBotDeliveryTarget | undefined> {
    await this.ensureReady();
    const raw = this.getRow(automationId, workspaceKey)?.bot_delivery_target;
    if (!raw) return undefined;
    try {
      const parsed = zcodeAutomationBotDeliveryTargetSchema.safeParse(JSON.parse(raw));
      return parsed.success ? parsed.data : undefined;
    } catch {
      // Bug reason: History/dirty JSON written externally cannot bring down the task list or scheduler; invalid sources are handled as unconfigured.
      return undefined;
    }
  }

  async hasTaskBinding(scope: {
    workspacePath: string;
    workspaceIdentity?: string;
    targetTaskId: string;
  }): Promise<boolean> {
    await this.ensureReady();
    const workspaceKey = resolveWorkspaceKey(scope);
    // CronCreate used to read and serialize the complete list to determine the ownership of a session, regardless of the
    // Corruption of display fields will cause security queries to fail. Here only the authorization criterion itself is queried, and workspaceKey is strictly limited.
    const row = this.getDatabase()
      .prepare(
        `SELECT 1 AS bound FROM automations
        WHERE workspace_key = @workspace_key AND target_task_id = @target_task_id
        LIMIT 1`,
      )
      .get({ workspace_key: workspaceKey, target_task_id: scope.targetTaskId }) as
      | { bound: number }
      | undefined;
    return row !== undefined;
  }

  async get(automationId: string, workspaceKey?: string): Promise<ZCodeAutomation | null> {
    await this.ensureReady();
    const row = this.getRow(automationId, workspaceKey);
    return row ? rowToAutomation(row) : null;
  }

  /** The lifecycle accounting of maxRuns only counts scheduled dispatches; manual runs only belong to the Card's cumulative display. */
  async getScheduledRunCount(automationId: string, workspaceKey?: string): Promise<number | null> {
    await this.ensureReady();
    const row = this.getRow(automationId, workspaceKey);
    return row?.scheduled_run_count ?? null;
  }

  /**
   * Edits the definition fields. The caller passes a recomputed nextRunAt (when cron_expr changes) and
   * the new lifecycleStatus (when recurring/max_runs change) as needed; the repository is unaware of
   * cron semantics. Changing cron_expr clears the retry state.
   */
  async update(
    automationId: string,
    params: ZCodeAutomationUpdateParams,
    options?: {
      nextRunAt?: number | null;
      lifecycleStatus?: ZCodeAutomationLifecycleStatus;
      resetRetry?: boolean;
    },
    workspaceKey?: string,
  ): Promise<ZCodeAutomation | null> {
    assertValidAutomationMode(params.mode);
    await this.ensureReady();
    const existing = this.getRow(automationId, workspaceKey);
    if (!existing) return null;
    const now = Date.now();
    const next: AutomationRow = {
      ...existing,
      title: params.title ?? existing.title,
      cron_expr: params.cronExpr ?? existing.cron_expr,
      prompt: params.prompt ?? existing.prompt,
      // The old three columns are only retained for rollback; editing such as titles cannot clear the old selections that have not been moved in, nor can they participate in the new version running and reading.
      model: existing.model,
      provider: existing.provider,
      model_selection:
        params.modelSelection === undefined
          ? existing.model_selection
          : (serializeAutomationModelSelection(params.modelSelection ?? undefined) ?? "null"),
      mode: params.mode === undefined ? existing.mode : params.mode,
      thought_level: existing.thought_level,
      recurring: params.recurring === undefined ? existing.recurring : params.recurring ? 1 : 0,
      max_runs: params.maxRuns === undefined ? existing.max_runs : params.maxRuns,
      end_at: params.endAt === undefined ? existing.end_at : params.endAt,
      schedule_rule:
        params.scheduleRule === undefined
          ? existing.schedule_rule
          : params.scheduleRule
            ? JSON.stringify(params.scheduleRule)
            : null,
      schedule_edited_by_user:
        params.scheduleEditedByUser === undefined
          ? existing.schedule_edited_by_user
          : params.scheduleEditedByUser
            ? 1
            : 0,
      next_run_at: options?.nextRunAt === undefined ? existing.next_run_at : options.nextRunAt,
      lifecycle_status: options?.lifecycleStatus ?? existing.lifecycle_status,
      dispatch_attempts: options?.resetRetry ? 0 : existing.dispatch_attempts,
      retry_at: options?.resetRetry ? null : existing.retry_at,
      dispatch_status: options?.resetRetry ? "idle" : existing.dispatch_status,
      // enabled is completely derived from lifecycleStatus: it is only touched when the caller explicitly changes the life cycle.
      // (active→incoming scheduling=1; completed/failed/paused→outgoing scheduling=0), otherwise keep the original value.
      // Fix: The original implementation incorrectly retains existing.enabled when completed/failed, and "Completed but still claimed by claimDue" may appear.
      enabled: options?.lifecycleStatus
        ? options.lifecycleStatus === "active"
          ? 1
          : 0
        : existing.enabled,
      updated_at: now,
    };
    this.writeRow(next);
    return rowToAutomation(next);
  }

  async delete(automationId: string, workspaceKey?: string): Promise<boolean> {
    await this.ensureReady();
    const result = this.getDatabase()
      .prepare(
        `DELETE FROM automations
        WHERE automation_id = @id
          AND (@workspace_key IS NULL OR workspace_key = @workspace_key)`,
      )
      .run({ id: automationId, workspace_key: workspaceKey ?? null });
    return result.changes > 0;
  }

  /** Pause / resume. paused ↔ active, keeping next_run_at / run_count. */
  async setEnabled(automationId: string, enabled: boolean, workspaceKey?: string): Promise<void> {
    await this.ensureReady();
    this.getDatabase()
      .prepare(
        `UPDATE automations
        SET enabled = @enabled,
            lifecycle_status = @lifecycle_status,
            updated_at = @now
        WHERE automation_id = @id
          AND (@workspace_key IS NULL OR workspace_key = @workspace_key)`,
      )
      .run({
        id: automationId,
        enabled: enabled ? 1 : 0,
        lifecycle_status: enabled ? "active" : "paused",
        now: Date.now(),
        workspace_key: workspaceKey ?? null,
      });
  }

  /** Manual re-run of a terminal task: back to active, counters and retry state cleared, with nextRunAt recomputed and passed in by the caller. */
  async restart(
    automationId: string,
    options: { nextRunAt: number | null },
    workspaceKey?: string,
  ): Promise<void> {
    await this.ensureReady();
    this.getDatabase()
      .prepare(
        `UPDATE automations
        SET lifecycle_status = 'active',
            enabled = 1,
            run_count = 0,
            scheduled_run_count = 0,
            dispatch_attempts = 0,
            retry_at = NULL,
            dispatch_status = 'idle',
            running = 0,
            claimed_at = NULL,
            next_run_at = @next_run_at,
            last_error = NULL,
            updated_at = @now
        WHERE automation_id = @id
          AND (@workspace_key IS NULL OR workspace_key = @workspace_key)`,
      )
      .run({
        id: automationId,
        next_run_at: options.nextRunAt,
        now: Date.now(),
        workspace_key: workspaceKey ?? null,
      });
  }

  /**
   * Run now: writes a manual run held directly by the current host, without touching the automation's
   * cron plan/lifecycle. The direct-dispatch path used to not take the automation running lock, so
   * repeated clicks dispatched concurrently to the same target task, making model configuration
   * revisions trample each other. It reuses the scheduler's single-flight lock here, released once
   * the host settles the dispatch. attempts=1 means it was already handed to the direct dispatcher;
   * the scheduler only performs crash recovery after a claim times out.
   */
  async runNow(
    automationId: string,
    options: { now: number },
    workspaceKey?: string,
  ): Promise<ClaimedManualAutomationRun | null> {
    await this.ensureReady();
    const db = this.getDatabase();
    db.exec("BEGIN IMMEDIATE");
    try {
      db.prepare(
        `UPDATE automations
        SET running = 0, claimed_at = NULL
        WHERE running = 1 AND claimed_at IS NOT NULL AND claimed_at <= @stale`,
      ).run({ stale: options.now - CLAIM_STALE_MS });

      const row = this.getRow(automationId, workspaceKey);
      if (!row) {
        db.exec("COMMIT");
        return null;
      }

      const claimed = db
        .prepare(
          `UPDATE automations
          SET running = 1, claimed_at = @now, updated_at = @now
          WHERE automation_id = @id
            AND running = 0
            AND (@workspace_key IS NULL OR workspace_key = @workspace_key)`,
        )
        .run({
          id: automationId,
          now: options.now,
          workspace_key: workspaceKey ?? null,
        });
      if (claimed.changes !== 1) {
        db.exec("COMMIT");
        return null;
      }

      const runId = `${automationId}:manual:${randomUUID()}`;
      db.prepare(
        `INSERT INTO automation_runs (
          run_id, automation_id, workspace_key, scheduled_at, trigger,
          model_selection, dispatch_status, attempts, created_at, updated_at
        ) VALUES (
          @run_id, @automation_id, @workspace_key, @scheduled_at, 'manual',
          @model_selection, 'claimed', 1, @now, @now
        )`,
      ).run({
        run_id: runId,
        automation_id: automationId,
        workspace_key: row.workspace_key,
        scheduled_at: options.now,
        // The claim has not been resolved by the target Host; the original intention is still in automation, run and will be fixed after the first distribution.
        model_selection: null,
        now: options.now,
      });
      db.exec("COMMIT");
      return {
        automation: rowToAutomation({
          ...row,
          running: 1,
          claimed_at: options.now,
          updated_at: options.now,
        }),
        run: rowToRun({
          run_id: runId,
          automation_id: automationId,
          workspace_key: row.workspace_key,
          scheduled_at: options.now,
          trigger: "manual",
          model_selection: null,
          dispatch_status: "claimed",
          outcome: null,
          session_id: null,
          error: null,
          attempts: 1,
          created_at: options.now,
          updated_at: options.now,
        }),
      };
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  // ---- Scheduling state machine ----

  /**
   * Single-flight claims due items: atomically running=0→1. At the same time it reclaims zombie items
   * whose claim timed out (claimed_at expired). The due check looks at both next_run_at and retry_at;
   * either one being due makes it due.
   */
  async claimDue(now: number): Promise<ZCodeAutomation[]> {
    await this.ensureReady();
    const db = this.getDatabase();
    db.exec("BEGIN IMMEDIATE");
    try {
      // The deadline is the planning boundary; expired tasks are transferred to the final state first to avoid being claimed by normal cron or retry.
      db.prepare(
        `UPDATE automations
        SET lifecycle_status = 'completed', enabled = 0, next_run_at = NULL,
            retry_at = NULL, running = 0, claimed_at = NULL, updated_at = @now
        WHERE enabled = 1 AND end_at IS NOT NULL AND end_at < @now`,
      ).run({ now });
      // First reclaim the zombie claim (the holder crashes, running=1 but claimed_at expires).
      db.prepare(
        `UPDATE automations
        SET running = 0, claimed_at = NULL
        WHERE running = 1 AND claimed_at IS NOT NULL AND claimed_at <= @stale`,
      ).run({ stale: now - CLAIM_STALE_MS });
      // Claim conditions: enabled and not in transit.
      // - With retry_at (transient retreat): only press retry_at to expire and claim, ignore next_run_at——
      //   Otherwise next_run_at remains stuck in the past, causing backoff to be bypassed and retried immediately every tick. next_run_at remains unchanged,
      //   Ensure that retries reuse the same runId (scheduler uses next_run_at as scheduledAt).
      // - No retry_at: Claim due by next_run_at.
      const dueRows = db
        .prepare(
          `SELECT * FROM automations
          WHERE enabled = 1 AND running = 0
            AND (
              (retry_at IS NOT NULL AND retry_at <= @now)
              OR (retry_at IS NULL AND next_run_at IS NOT NULL AND next_run_at <= @now)
            )`,
        )
        .all({ now }) as unknown as AutomationRow[];
      const claimed: ZCodeAutomation[] = [];
      const claim = db.prepare(
        `UPDATE automations
        SET running = 1, claimed_at = @now, dispatch_status = 'claimed', updated_at = @now
        WHERE automation_id = @id AND running = 0`,
      );
      for (const row of dueRows) {
        const res = claim.run({ id: row.automation_id, now });
        if (res.changes === 1) {
          claimed.push(
            rowToAutomation({
              ...row,
              running: 1,
              claimed_at: now,
              dispatch_status: "claimed",
            }),
          );
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
   * Claims the manual runs produced by the UI's "Run now".
   * Run now must not change next_run_at, or it would pollute the original cron cadence; a manual run
   * uses automation_runs as its queue and briefly takes the automation running lock to avoid
   * dispatching the same task concurrently with a scheduled trigger.
   */
  async claimManualRuns(now: number): Promise<ClaimedManualAutomationRun[]> {
    await this.ensureReady();
    const db = this.getDatabase();
    db.exec("BEGIN IMMEDIATE");
    try {
      db.prepare(
        `UPDATE automations
        SET running = 0, claimed_at = NULL
        WHERE running = 1 AND claimed_at IS NOT NULL AND claimed_at <= @stale`,
      ).run({ stale: now - CLAIM_STALE_MS });

      const rows = db
        .prepare(
          `SELECT
            a.automation_id AS a_automation_id,
            a.title AS a_title,
            a.cron_expr AS a_cron_expr,
            a.prompt AS a_prompt,
            a.model AS a_model,
            a.provider AS a_provider,
            a.model_selection AS a_model_selection,
            a.mode AS a_mode,
            a.thought_level AS a_thought_level,
            a.workspace_key AS a_workspace_key,
            a.workspace_path AS a_workspace_path,
            a.workspace_identity AS a_workspace_identity,
            a.target_task_id AS a_target_task_id,
            a.location_kind AS a_location_kind,
            a.recurring AS a_recurring,
            a.max_runs AS a_max_runs,
            a.end_at AS a_end_at,
            a.schedule_rule AS a_schedule_rule,
            a.schedule_edited_by_user AS a_schedule_edited_by_user,
            a.run_count AS a_run_count,
            a.scheduled_run_count AS a_scheduled_run_count,
            a.enabled AS a_enabled,
            a.lifecycle_status AS a_lifecycle_status,
            a.next_run_at AS a_next_run_at,
            a.last_run_at AS a_last_run_at,
            a.running AS a_running,
            a.claimed_at AS a_claimed_at,
            a.dispatch_status AS a_dispatch_status,
            a.dispatch_attempts AS a_dispatch_attempts,
            a.retry_at AS a_retry_at,
            a.last_error AS a_last_error,
            a.bot_delivery_target AS a_bot_delivery_target,
            a.created_at AS a_created_at,
            a.updated_at AS a_updated_at,
            r.run_id AS r_run_id,
            r.automation_id AS r_automation_id,
            r.workspace_key AS r_workspace_key,
            r.scheduled_at AS r_scheduled_at,
            r.trigger AS r_trigger,
            r.model_selection AS r_model_selection,
            r.dispatch_status AS r_dispatch_status,
            r.outcome AS r_outcome,
            r.session_id AS r_session_id,
            r.error AS r_error,
            r.attempts AS r_attempts,
            r.created_at AS r_created_at,
            r.updated_at AS r_updated_at
          FROM automation_runs r
          JOIN automations a ON a.automation_id = r.automation_id
          WHERE r.trigger = 'manual'
            AND r.dispatch_status = 'claimed'
            AND a.running = 0
            AND (r.attempts = 0 OR r.updated_at <= @stale)
          ORDER BY r.created_at ASC`,
        )
        .all({ stale: now - CLAIM_STALE_MS }) as unknown as Array<Record<string, unknown>>;

      const claimed: ClaimedManualAutomationRun[] = [];
      const claimAutomation = db.prepare(
        `UPDATE automations
        SET running = 1, claimed_at = @now, updated_at = @now
        WHERE automation_id = @id AND running = 0`,
      );
      const claimRun = db.prepare(
        `UPDATE automation_runs
        SET attempts = attempts + 1, updated_at = @now
        WHERE run_id = @run_id AND trigger = 'manual' AND dispatch_status = 'claimed'`,
      );

      for (const row of rows) {
        const automationId = row["a_automation_id"] as string;
        const runId = row["r_run_id"] as string;
        const res = claimAutomation.run({ id: automationId, now });
        if (res.changes !== 1) continue;
        claimRun.run({ run_id: runId, now });
        claimed.push({
          automation: rowToAutomation({
            automation_id: automationId,
            title: row["a_title"] as string,
            cron_expr: row["a_cron_expr"] as string,
            prompt: row["a_prompt"] as string,
            model: (row["a_model"] as string | null) ?? null,
            provider: (row["a_provider"] as string | null) ?? null,
            model_selection: (row["a_model_selection"] as string | null) ?? null,
            mode: (row["a_mode"] as string | null) ?? null,
            thought_level: (row["a_thought_level"] as string | null) ?? null,
            workspace_key: row["a_workspace_key"] as string,
            workspace_path: row["a_workspace_path"] as string,
            workspace_identity: (row["a_workspace_identity"] as string | null) ?? null,
            target_task_id: (row["a_target_task_id"] as string | null) ?? null,
            location_kind: row["a_location_kind"] as string,
            recurring: row["a_recurring"] as number,
            max_runs: (row["a_max_runs"] as number | null) ?? null,
            end_at: (row["a_end_at"] as number | null) ?? null,
            schedule_rule: (row["a_schedule_rule"] as string | null) ?? null,
            schedule_edited_by_user: row["a_schedule_edited_by_user"] as number,
            run_count: row["a_run_count"] as number,
            scheduled_run_count: row["a_scheduled_run_count"] as number,
            enabled: row["a_enabled"] as number,
            lifecycle_status: row["a_lifecycle_status"] as string,
            next_run_at: (row["a_next_run_at"] as number | null) ?? null,
            last_run_at: (row["a_last_run_at"] as number | null) ?? null,
            running: 1,
            claimed_at: now,
            dispatch_status: row["a_dispatch_status"] as string,
            dispatch_attempts: row["a_dispatch_attempts"] as number,
            retry_at: (row["a_retry_at"] as number | null) ?? null,
            last_error: (row["a_last_error"] as string | null) ?? null,
            bot_delivery_target: (row["a_bot_delivery_target"] as string | null) ?? null,
            created_at: row["a_created_at"] as number,
            updated_at: now,
          }),
          run: rowToRun({
            run_id: runId,
            automation_id: row["r_automation_id"] as string,
            workspace_key: row["r_workspace_key"] as string,
            scheduled_at: (row["r_scheduled_at"] as number | null) ?? null,
            trigger: row["r_trigger"] as string,
            model_selection: (row["r_model_selection"] as string | null) ?? null,
            dispatch_status: row["r_dispatch_status"] as string,
            outcome: (row["r_outcome"] as string | null) ?? null,
            session_id: (row["r_session_id"] as string | null) ?? null,
            error: (row["r_error"] as string | null) ?? null,
            attempts: (row["r_attempts"] as number) + 1,
            created_at: row["r_created_at"] as number,
            updated_at: now,
          }),
        });
      }
      db.exec("COMMIT");
      return claimed;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  /**
   * Successful dispatch settlement: display total and scheduled dispatch count each +1, writes
   * last_run_at, clears the retry state, resets running; a recurring task goes back to active
   * (nextRunAt is recomputed by the caller from the actual dispatch time and passed in); a
   * finite-run task that reaches max_runs turns completed (enabled=0, next_run_at=NULL).
   */
  async markDispatched(
    automationId: string,
    options: { dispatchedAt: number; nextRunAt: number | null },
  ): Promise<void> {
    await this.ensureReady();
    const row = this.getRow(automationId);
    if (!row) return; // Deleted, discard writeback, avoid resurrection
    const runCount = row.run_count + 1;
    const scheduledRunCount = row.scheduled_run_count + 1;
    // The limited number of tasks (recurring=0) reaches the upper limit and is completed. When max_runs is not explicitly set, it is processed as a one-time task (default upper limit is 1).
    // Otherwise, the one-time cron will always stay active and be triggered by cron repeatedly, never ending. You must use an independent
    // scheduled_run_count; run_count also includes manual run, which can only be used for Card cumulative display.
    const reachedMax = row.recurring === 0 && scheduledRunCount >= (row.max_runs ?? 1);
    const reachedEnd = row.end_at !== null && (options.nextRunAt ?? Infinity) > row.end_at;
    this.getDatabase()
      .prepare(
        `UPDATE automations
        SET run_count = @run_count,
            scheduled_run_count = @scheduled_run_count,
            last_run_at = @dispatched_at,
            dispatch_status = 'dispatched',
            dispatch_attempts = 0,
            retry_at = NULL,
            last_error = NULL,
            running = 0,
            claimed_at = NULL,
            lifecycle_status = @lifecycle_status,
            enabled = @enabled,
            next_run_at = @next_run_at,
            updated_at = @now
        WHERE automation_id = @id`,
      )
      .run({
        id: automationId,
        run_count: runCount,
        scheduled_run_count: scheduledRunCount,
        dispatched_at: options.dispatchedAt,
        lifecycle_status: reachedMax || reachedEnd ? "completed" : "active",
        enabled: reachedMax || reachedEnd ? 0 : 1,
        next_run_at: reachedMax || reachedEnd ? null : options.nextRunAt,
        now: options.dispatchedAt,
      });
  }

  /**
   * Dispatch failure: a transient failure accumulates attempts and writes retry_at per the backoff;
   * once the ceiling is reached a recurring task gives up this round and skips to the next
   * next_run_at (passed in by the caller), while a finite-run task turns failed. A permanent failure
   * goes straight to the failed terminal state and is disabled.
   */
  async markDispatchFailed(
    automationId: string,
    options: {
      failedAt: number;
      error: string;
      kind: "transient" | "permanent";
      /** After a transient failure hits the ceiling, the next normal next_run_at of the recurring task (recomputed by the caller). */
      nextRunAt?: number | null;
    },
  ): Promise<void> {
    await this.ensureReady();
    const row = this.getRow(automationId);
    if (!row) return;
    const db = this.getDatabase();
    const now = options.failedAt;
    if (options.kind === "permanent") {
      db.prepare(
        `UPDATE automations
        SET dispatch_status = 'failed_to_dispatch', lifecycle_status = 'failed',
            enabled = 0, running = 0, claimed_at = NULL,
            last_error = @error, updated_at = @now
        WHERE automation_id = @id`,
      ).run({ id: automationId, error: options.error, now });
      return;
    }
    const attempts = row.dispatch_attempts + 1;
    if (attempts >= DISPATCH_MAX_ATTEMPTS) {
      if (row.recurring === 1) {
        // Cyclic task: give up this round, jump to the next normal next_run_at, clear the retry state and return to idle.
        db.prepare(
          `UPDATE automations
          SET dispatch_status = 'idle', dispatch_attempts = 0, retry_at = NULL,
              running = 0, claimed_at = NULL, next_run_at = @next_run_at,
              last_error = @error, updated_at = @now
          WHERE automation_id = @id`,
        ).run({
          id: automationId,
          next_run_at: options.nextRunAt ?? null,
          error: options.error,
          now,
        });
      } else {
        db.prepare(
          `UPDATE automations
          SET dispatch_status = 'failed_to_dispatch', lifecycle_status = 'failed',
              enabled = 0, running = 0, claimed_at = NULL,
              last_error = @error, updated_at = @now
          WHERE automation_id = @id`,
        ).run({ id: automationId, error: options.error, now });
      }
      return;
    }
    // The upper limit has not been reached: write backoff retry_at, reset running and wait for re-claiming in the next round.
    db.prepare(
      `UPDATE automations
      SET dispatch_status = 'failed_to_dispatch', dispatch_attempts = @attempts,
          retry_at = @retry_at, running = 0, claimed_at = NULL,
          last_error = @error, updated_at = @now
      WHERE automation_id = @id`,
    ).run({
      id: automationId,
      attempts,
      retry_at: computeRetryAt(now, attempts),
      error: options.error,
      now,
    });
  }

  /** Releases the claim on shutdown/exit: clears running, keeps next_run_at, records no failure and advances nothing. */
  async releaseClaim(automationId: string): Promise<void> {
    await this.ensureReady();
    this.getDatabase()
      .prepare(
        `UPDATE automations
        SET running = 0, claimed_at = NULL, dispatch_status = 'idle', updated_at = @now
        WHERE automation_id = @id AND running = 1`,
      )
      .run({ id: automationId, now: Date.now() });
  }

  /** After a manual run ends, only the single-flight lock is released; the automation's scheduling state is left untouched. */
  async releaseManualClaim(automationId: string, workspaceKey: string): Promise<void> {
    await this.ensureReady();
    this.getDatabase()
      .prepare(
        `UPDATE automations
        SET running = 0, claimed_at = NULL, updated_at = @now
        WHERE automation_id = @id
          AND workspace_key = @workspace_key
          AND running = 1`,
      )
      .run({ id: automationId, workspace_key: workspaceKey, now: Date.now() });
  }

  /** Renews the lease while the host still holds a queued/running manual run, so a long task is not reclaimed by the scheduler as a zombie claim. */
  async touchManualClaim(automationId: string, workspaceKey: string): Promise<void> {
    await this.ensureReady();
    this.getDatabase()
      .prepare(
        `UPDATE automations
        SET claimed_at = @now, updated_at = @now
        WHERE automation_id = @id
          AND workspace_key = @workspace_key
          AND running = 1`,
      )
      .run({ id: automationId, workspace_key: workspaceKey, now: Date.now() });
  }

  /**
   * Missed fire window: atomically records a skipped run + pushes next_run_at forward to the next
   * future fire point + resets the claim. run_count is not incremented. Used for the compensating
   * skip when the scheduler, on startup/recovery, finds next_run_at already far earlier than now.
   * finalize=true is for purely one-shot tasks: once the target moment is missed it is terminal
   * (completed + disabled + scheduling cleared), and no further cycles may be derived from the
   * compatibility scheduleRule.
   */
  async skipAndReschedule(params: {
    automationId: string;
    runId: string;
    workspaceKey: string;
    scheduledAt: number | null;
    reason: string;
    nextRunAt: number | null;
    finalize?: boolean;
  }): Promise<void> {
    await this.ensureReady();
    const db = this.getDatabase();
    const now = Date.now();
    db.exec("BEGIN IMMEDIATE");
    try {
      db.prepare(
        `INSERT INTO automation_runs (
          run_id, automation_id, workspace_key, scheduled_at, trigger,
          dispatch_status, error, attempts, created_at, updated_at
        ) VALUES (@run_id, @automation_id, @workspace_key, @scheduled_at, 'schedule', 'skipped', @reason, 0, @now, @now)
        ON CONFLICT(run_id) DO UPDATE SET
          dispatch_status = 'skipped', error = excluded.error, updated_at = excluded.updated_at`,
      ).run({
        run_id: params.runId,
        automation_id: params.automationId,
        workspace_key: params.workspaceKey,
        scheduled_at: params.scheduledAt,
        reason: params.reason,
        now,
      });
      if (params.finalize) {
        db.prepare(
          `UPDATE automations
          SET lifecycle_status = 'completed', enabled = 0, next_run_at = NULL,
              running = 0, claimed_at = NULL,
              dispatch_status = 'idle', dispatch_attempts = 0, retry_at = NULL,
              updated_at = @now
          WHERE automation_id = @id`,
        ).run({ id: params.automationId, now });
      } else {
        db.prepare(
          `UPDATE automations
          SET next_run_at = @next_run_at, running = 0, claimed_at = NULL,
              dispatch_status = 'idle', dispatch_attempts = 0, retry_at = NULL,
              updated_at = @now
          WHERE automation_id = @id`,
        ).run({ id: params.automationId, next_run_at: params.nextRunAt, now });
      }
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  // ---- Run history automation_runs ----

  /** Ensures the run history exists. Used as a fallback when the host writes back an outcome; it does not bump attempts, so it cannot pollute the scheduler's retry counter. */
  async ensureRunClaimed(params: {
    runId: string;
    automationId: string;
    workspaceKey: string;
    scheduledAt: number | null;
    trigger: ZCodeAutomationTrigger;
  }): Promise<void> {
    await this.ensureReady();
    const now = Date.now();
    this.getDatabase()
      .prepare(
        `INSERT INTO automation_runs (
          run_id, automation_id, workspace_key, scheduled_at, trigger,
          dispatch_status, attempts, created_at, updated_at
        ) VALUES (@run_id, @automation_id, @workspace_key, @scheduled_at, @trigger, 'claimed', 0, @now, @now)
        ON CONFLICT(run_id) DO NOTHING`,
      )
      .run({
        run_id: params.runId,
        automation_id: params.automationId,
        workspace_key: params.workspaceKey,
        scheduled_at: params.scheduledAt,
        trigger: params.trigger,
        now,
      });
  }

  /** Upserts one run row on claim (a run_id conflict means this round's retry is hit, so no new row is created). */
  async upsertRunClaimed(params: {
    runId: string;
    automationId: string;
    workspaceKey: string;
    scheduledAt: number | null;
    trigger: ZCodeAutomationTrigger;
    modelSelection?: ModelSelection;
  }): Promise<void> {
    await this.ensureReady();
    const now = Date.now();
    this.getDatabase()
      .prepare(
        `INSERT INTO automation_runs (
          run_id, automation_id, workspace_key, scheduled_at, trigger,
          model_selection, dispatch_status, attempts, created_at, updated_at
        ) VALUES (@run_id, @automation_id, @workspace_key, @scheduled_at, @trigger, @model_selection, 'claimed', 0, @now, @now)
        ON CONFLICT(run_id) DO UPDATE SET
          dispatch_status = 'claimed',
          model_selection = COALESCE(automation_runs.model_selection, excluded.model_selection),
          outcome = NULL,
          error = NULL,
          attempts = attempts + 1,
          updated_at = excluded.updated_at`,
      )
      .run({
        run_id: params.runId,
        automation_id: params.automationId,
        workspace_key: params.workspaceKey,
        scheduled_at: params.scheduledAt,
        trigger: params.trigger,
        model_selection: serializeAutomationModelSelection(params.modelSelection),
        now,
      });
  }

  /**
   * Atomically pins the run Selection the first time a Select forms a Submission; later calls can
   * only read the original value back. The old dispatch re-read the Host preferred selection on
   * every transient retry, which made the same run switch models.
   */
  async fixRunModelSelection(runId: string, selection: ModelSelection): Promise<ModelSelection> {
    await this.ensureReady();
    const db = this.getDatabase();
    db.prepare(
      `UPDATE automation_runs
       SET model_selection = COALESCE(model_selection, @model_selection), updated_at = @now
       WHERE run_id = @run_id`,
    ).run({
      run_id: runId,
      model_selection: serializeAutomationModelSelection(selection),
      now: Date.now(),
    });
    const row = db
      .prepare(`SELECT model_selection FROM automation_runs WHERE run_id = @run_id`)
      .get({ run_id: runId }) as Pick<AutomationRunRow, "model_selection"> | undefined;
    const fixed = row ? readSerializedModelSelection(row.model_selection) : undefined;
    if (!fixed)
      throw new Error(`Automation run does not exist or has no pinned model selection: ${runId}`);
    return fixed;
  }

  /** Writes the dispatch result back onto the run (dispatched backfills session_id / failed_to_dispatch records the error). */
  async markRunDispatch(params: {
    runId: string;
    dispatchStatus: ZCodeAutomationRunDispatchStatus;
    sessionId?: string | null;
    error?: string | null;
  }): Promise<void> {
    await this.ensureReady();
    this.getDatabase()
      .prepare(
        `UPDATE automation_runs
        SET dispatch_status = @dispatch_status,
            session_id = COALESCE(@session_id, session_id),
            error = @error,
            updated_at = @now
        WHERE run_id = @run_id`,
      )
      .run({
        run_id: params.runId,
        dispatch_status: params.dispatchStatus,
        session_id: params.sessionId ?? null,
        error: params.error ?? null,
        now: Date.now(),
      });
  }

  /**
   * Settlement of the first successful dispatch of a manual run: atomically updates the run ledger
   * and the cumulative run count. Manual runs used to only touch automation_runs, so the Card's
   * runCount only counted scheduled triggers; the same runId may also be settled more than once by a
   * direct host, scheduler crash recovery or a late report, so the first entry of dispatch_status into
   * dispatched must serve as the idempotency boundary. manual does not advance cron/maxRuns/lifecycle
   * and does not release the single-flight claim either — the claim is still closed by the real
   * terminal turn.
   */
  async markManualRunDispatched(params: {
    runId: string;
    sessionId?: string | null;
    dispatchedAt: number;
  }): Promise<boolean> {
    await this.ensureReady();
    const db = this.getDatabase();
    db.exec("BEGIN IMMEDIATE");
    try {
      const run = db
        .prepare(
          `SELECT automation_id, workspace_key, dispatch_status
          FROM automation_runs
          WHERE run_id = @run_id AND trigger = 'manual'`,
        )
        .get({ run_id: params.runId }) as
        | Pick<AutomationRunRow, "automation_id" | "workspace_key" | "dispatch_status">
        | undefined;
      if (!run || run.dispatch_status === "dispatched") {
        db.exec("COMMIT");
        return false;
      }

      db.prepare(
        `UPDATE automation_runs
        SET dispatch_status = 'dispatched',
            session_id = COALESCE(@session_id, session_id),
            error = NULL,
            updated_at = @now
        WHERE run_id = @run_id AND trigger = 'manual' AND dispatch_status <> 'dispatched'`,
      ).run({
        run_id: params.runId,
        session_id: params.sessionId ?? null,
        now: params.dispatchedAt,
      });
      const automationUpdate = db
        .prepare(
          `UPDATE automations
          SET run_count = run_count + 1,
              last_run_at = @dispatched_at,
              updated_at = @now
          WHERE automation_id = @automation_id AND workspace_key = @workspace_key`,
        )
        .run({
          automation_id: run.automation_id,
          workspace_key: run.workspace_key,
          dispatched_at: params.dispatchedAt,
          now: params.dispatchedAt,
        });
      db.exec("COMMIT");
      return automationUpdate.changes > 0;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  /** The session runtime writes the run outcome back (running / succeeded / failed / stopped). */
  async markRunOutcome(
    runId: string,
    outcome: ZCodeAutomationRunOutcome,
    error?: string,
  ): Promise<void> {
    await this.ensureReady();
    this.getDatabase()
      .prepare(
        `UPDATE automation_runs
        SET outcome = CASE
              WHEN @outcome = 'running' AND outcome IS NOT NULL AND outcome <> 'running' THEN outcome
              ELSE @outcome
            END,
            error = CASE
              WHEN @outcome = 'running' AND outcome IS NOT NULL AND outcome <> 'running' THEN error
              ELSE COALESCE(@error, error)
            END,
            updated_at = @now
        WHERE run_id = @run_id`,
      )
      .run({ run_id: runId, outcome, error: error ?? null, now: Date.now() });
  }

  /** Missed fire window: records a skipped run (session_id=null) without incrementing run_count. */
  async recordSkippedRun(params: {
    runId: string;
    automationId: string;
    workspaceKey: string;
    scheduledAt: number | null;
    trigger: ZCodeAutomationTrigger;
    reason: string;
  }): Promise<void> {
    await this.ensureReady();
    const now = Date.now();
    this.getDatabase()
      .prepare(
        `INSERT INTO automation_runs (
          run_id, automation_id, workspace_key, scheduled_at, trigger,
          dispatch_status, error, attempts, created_at, updated_at
        ) VALUES (@run_id, @automation_id, @workspace_key, @scheduled_at, @trigger, 'skipped', @reason, 0, @now, @now)
        ON CONFLICT(run_id) DO UPDATE SET
          dispatch_status = 'skipped', error = excluded.error, updated_at = excluded.updated_at`,
      )
      .run({
        run_id: params.runId,
        automation_id: params.automationId,
        workspace_key: params.workspaceKey,
        scheduled_at: params.scheduledAt,
        trigger: params.trigger,
        reason: params.reason,
        now,
      });
  }

  async listRuns(automationId: string, workspaceKey?: string): Promise<ZCodeAutomationRun[]> {
    await this.ensureReady();
    const rows = this.getDatabase()
      .prepare(
        `SELECT * FROM automation_runs
        WHERE automation_id = @id
          AND (@workspace_key IS NULL OR workspace_key = @workspace_key)
        ORDER BY created_at DESC`,
      )
      .all({
        id: automationId,
        workspace_key: workspaceKey ?? null,
      }) as unknown as AutomationRunRow[];
    return rows.map(rowToRun);
  }

  async getRun(runId: string): Promise<ZCodeAutomationRun | null> {
    await this.ensureReady();
    const row = this.getDatabase()
      .prepare(`SELECT * FROM automation_runs WHERE run_id = @run_id`)
      .get({ run_id: runId }) as AutomationRunRow | undefined;
    return row ? rowToRun(row) : null;
  }

  async deleteRun(runId: string, workspaceKey?: string): Promise<void> {
    await this.ensureReady();
    this.getDatabase()
      .prepare(
        `DELETE FROM automation_runs
        WHERE run_id = @run_id
          AND (@workspace_key IS NULL OR workspace_key = @workspace_key)`,
      )
      .run({ run_id: runId, workspace_key: workspaceKey ?? null });
  }

  /** Retention policy: deletes historical runs older than maxAgeMs (guards against unbounded growth). */
  async pruneRuns(maxAgeMs: number): Promise<number> {
    await this.ensureReady();
    const res = this.getDatabase()
      .prepare(`DELETE FROM automation_runs WHERE created_at < ?`)
      .run(Date.now() - maxAgeMs);
    return Number(res.changes ?? 0);
  }

  private writeRow(row: AutomationRow): void {
    this.getDatabase()
      .prepare(
        `UPDATE automations SET
          title = @title, cron_expr = @cron_expr, prompt = @prompt, model = @model, provider = @provider,
          model_selection = @model_selection,
          mode = @mode, thought_level = @thought_level,
          recurring = @recurring, max_runs = @max_runs, end_at = @end_at,
          schedule_rule = @schedule_rule,
          schedule_edited_by_user = @schedule_edited_by_user,
          next_run_at = @next_run_at, lifecycle_status = @lifecycle_status,
          dispatch_attempts = @dispatch_attempts, retry_at = @retry_at, dispatch_status = @dispatch_status,
          enabled = @enabled, updated_at = @updated_at
        WHERE automation_id = @automation_id`,
      )
      .run({
        automation_id: row.automation_id,
        title: row.title,
        cron_expr: row.cron_expr,
        prompt: row.prompt,
        model: row.model,
        provider: row.provider,
        model_selection: row.model_selection,
        mode: row.mode,
        thought_level: row.thought_level,
        recurring: row.recurring,
        max_runs: row.max_runs,
        end_at: row.end_at,
        schedule_rule: row.schedule_rule,
        schedule_edited_by_user: row.schedule_edited_by_user,
        next_run_at: row.next_run_at,
        lifecycle_status: row.lifecycle_status,
        dispatch_attempts: row.dispatch_attempts,
        retry_at: row.retry_at,
        dispatch_status: row.dispatch_status,
        enabled: row.enabled,
        updated_at: row.updated_at,
      });
  }
}
