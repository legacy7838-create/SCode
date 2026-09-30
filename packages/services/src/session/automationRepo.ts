/* eslint-disable max-lines -- `AutomationRepo` is the facade the service layer imports by name;
   splitting it would require re-export shims for 31 signatures and would let the two halves
   drift from the shared `ZCodeAutomation` contract. The actual split already happened on the
   native side (`src/automation.rs` carries the claim primitives, `src/automation_repo.rs` the
   repository), so this file is only the boundary. */
/**
 * Automation storage repository (`tasks-index.sqlite`, WAL, multi-process safe).
 *
 * **This is a wrapper, not an implementation.** The schema, the guarded writes, the scheduling
 * state machine, the run ledger and the `rowToAutomation` / `rowToRun` projections all live in the
 * `zcode-task-index` Rust crate (`packages/rust/crates/zcode-task-index/src/automation_repo.rs`).
 * The 1,489 lines that used to be here — every SQL statement, the zod re-validation, the backoff
 * arithmetic — are deleted. Spec: docs/specs/rust-native-task-index.md §15, §27.
 *
 * What remains is exactly what has to:
 *
 * - the `ensureReady` handshake;
 * - the identity rule, `workspaceIdentity?.trim() || workspacePath`, resolved **here** so the
 *   wrapper and every other repository agree on a scope;
 * - the `Date.now()` defaults the native side deliberately does not own, so it stays pure;
 * - the id minting (`automation-<uuid>` and `<automationId>:manual:<uuid>`), because the crate
 *   does not own randomness;
 * - the `AutomationRepo` **name and method signatures** the service layer already imports, so no
 *   call site changed.
 *
 * There is **no JavaScript fallback** (docs/specs/rust-native-ports.md invariant 1). `loadNative`
 * throws when the binary is missing. A scheduling state machine that silently half-runs is worse
 * than one that refuses to start: a claim that is taken but never dispatched, or a run whose
 * outcome is never written back, fails silently until a week of work is missing.
 */
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";

import {
  AUTOMATION_CREATE_LIMIT,
  AUTOMATION_CREATE_LIMIT_ERROR_CODE,
  isAutomationCreateLimitError,
  resolveWorkspaceKey,
  type ModelSelection,
  type ZCodeAutomation,
  type ZCodeAutomationBotDeliveryTarget,
  type ZCodeAutomationCreateParams,
  type ZCodeAutomationLifecycleStatus,
  type ZCodeAutomationRun,
  type ZCodeAutomationRunDispatchStatus,
  type ZCodeAutomationRunOutcome,
  type ZCodeAutomationTrigger,
  type ZCodeAutomationUpdateParams,
} from "@zcode/shared";
import { getTasksIndexDatabasePath } from "#src/paths.js";
import { TaskIndexStore } from "@zcode/rust/task-index";
import { AutomationRepository } from "@zcode/rust/automation-repository";

/** Dispatch-failure backoff constants. Kept here because they are part of this module's API. */
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

/** Backoff retry time: now + min(BASE * 2^(attempts-1), CAP). The persisted value is computed in Rust. */
export function computeRetryAt(now: number, attempts: number): number {
  const backoff = Math.min(
    DISPATCH_RETRY_BASE_MS * 2 ** Math.max(0, attempts - 1),
    DISPATCH_RETRY_CAP_MS,
  );
  return now + backoff;
}

interface ClaimedManualAutomationRun {
  automation: ZCodeAutomation;
  run: ZCodeAutomationRun;
}

const asAutomation = (value: unknown): ZCodeAutomation => value as ZCodeAutomation;
const asAutomations = (value: unknown): ZCodeAutomation[] => value as ZCodeAutomation[];
const asRun = (value: unknown): ZCodeAutomationRun => value as ZCodeAutomationRun;
const asRuns = (value: unknown): ZCodeAutomationRun[] => value as ZCodeAutomationRun[];

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
  /**
   * The path is fixed at construction.
   *
   * It deliberately does not read the process-level data directory: under vitest, test files run
   * concurrently and a global would be overwritten by whichever file ran last, opening a window in
   * which a test writes to the real library. The temporary path is injected during tests.
   */
  readonly #dbPath: string | null;
  readonly #startupBusyTimeoutMs: number;
  #store: TaskIndexStore | null = null;
  #repo: AutomationRepository | null = null;
  #ready: Promise<void> | null = null;
  #openedPath: string | null = null;

  constructor(dbPath?: string, startupBusyTimeoutMs = 5000) {
    this.#dbPath = dbPath?.trim() || null;
    this.#startupBusyTimeoutMs = startupBusyTimeoutMs;
  }

  #resolveDbPath(): string {
    return this.#dbPath ?? getTasksIndexDatabasePath();
  }

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

  async #initialize(path: string): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    // The migrations are the **crate's**: the ledger checksum is
    // `sha256(JSON.stringify(checksumInput))`, and the schema, the three frozen payloads and the
    // checksum inputs live in `crate::schema` (spec §28). `ensureReady` takes no migration list.
    const store = new TaskIndexStore({ path, busyTimeoutMs: this.#startupBusyTimeoutMs });
    await store.ensureReady(Date.now());
    this.#store = store;
    this.#repo = new AutomationRepository(store);
    this.#openedPath = path;
  }

  /** Refuses loudly once closed, rather than silently reopening. */
  #repository(): AutomationRepository {
    if (!this.#store || !this.#repo) {
      throw new Error("AutomationRepo is not initialized: await ensureReady() first");
    }
    return this.#repo;
  }

  close(options?: { throwOnError?: boolean }): void {
    let closeError: unknown;
    try {
      this.#store?.close();
    } catch (error) {
      closeError = error;
      // ignore
    }
    this.#store = null;
    this.#repo = null;
    this.#openedPath = null;
    this.#ready = null;
    if (options?.throwOnError && closeError) throw closeError;
  }

  // ---- Manage CRUD ----

  async create(
    params: ZCodeAutomationCreateParams,
    options: { nextRunAt: number | null; lifecycleStatus?: ZCodeAutomationLifecycleStatus },
  ): Promise<ZCodeAutomation> {
    await this.ensureReady();
    const workspaceKey = resolveWorkspaceKey({
      workspacePath: params.workspacePath,
      workspaceIdentity: params.workspaceIdentity,
    });
    try {
      return asAutomation(
        await this.#repository().automationCreate({
          automationId: `automation-${randomUUID()}`,
          title: params.title,
          cronExpr: params.cronExpr,
          prompt: params.prompt,
          modelSelection: params.modelSelection,
          mode: params.mode,
          workspaceKey,
          workspacePath: params.workspacePath,
          workspaceIdentity: params.workspaceIdentity,
          targetTaskId: params.targetTaskId,
          botDeliveryTarget: params.botDeliveryTarget,
          recurring: params.recurring,
          maxRuns: params.maxRuns,
          endAt: params.endAt,
          scheduleRule: params.scheduleRule,
          lifecycleStatus: options.lifecycleStatus,
          nextRunAt: options.nextRunAt,
          now: Date.now(),
        }),
      );
    } catch (error) {
      // The creation ceiling is a product outcome, not a storage fault. Re-throw it as the typed
      // error the UI recognizes; the native message carries the same code.
      if (isAutomationCreateLimitError(error)) throw new AutomationCreateLimitError();
      throw error;
    }
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
      : undefined;
    return asAutomations(await this.#repository().automationList({ workspaceKey }));
  }

  /** Read dedicated to the first dispatch: the list may display unbound tasks, but a dispatch must not treat a corrupt value as "follow the default". */
  async getModelSelectionForDispatch(
    automationId: string,
    workspaceKey: string,
  ): Promise<ModelSelection | undefined> {
    await this.ensureReady();
    return (
      ((await this.#repository().automationGetModelSelectionForDispatch({
        automationId,
        workspaceKey,
      })) as ModelSelection | null) ?? undefined
    );
  }

  /** Reads the Bot delivery target for background dispatch only; this internal source information never enters the automation display model. */
  async getBotDeliveryTarget(
    automationId: string,
    workspaceKey?: string,
  ): Promise<ZCodeAutomationBotDeliveryTarget | undefined> {
    await this.ensureReady();
    return (
      ((await this.#repository().automationGetBotDeliveryTarget({
        automationId,
        workspaceKey,
      })) as ZCodeAutomationBotDeliveryTarget | null) ?? undefined
    );
  }

  async hasTaskBinding(scope: {
    workspacePath: string;
    workspaceIdentity?: string;
    targetTaskId: string;
  }): Promise<boolean> {
    await this.ensureReady();
    const workspaceKey = resolveWorkspaceKey(scope);
    return this.#repository().automationHasTaskBinding({
      workspaceKey,
      targetTaskId: scope.targetTaskId,
    });
  }

  async get(automationId: string, workspaceKey?: string): Promise<ZCodeAutomation | null> {
    await this.ensureReady();
    return (await this.#repository().automationGet({
      automationId,
      workspaceKey,
    })) as ZCodeAutomation | null;
  }

  /** The lifecycle accounting of maxRuns only counts scheduled dispatches; manual runs only belong to the Card's cumulative display. */
  async getScheduledRunCount(automationId: string, workspaceKey?: string): Promise<number | null> {
    await this.ensureReady();
    return this.#repository().automationGetScheduledRunCount({ automationId, workspaceKey });
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
    await this.ensureReady();
    // `JSON.stringify` drops `undefined` keys and keeps `null`, which is exactly the outer/inner
    // distinction the native tri-state fields decode: omitted = leave alone, null = clear.
    return (await this.#repository().automationUpdate({
      automationId,
      workspaceKey,
      title: params.title,
      cronExpr: params.cronExpr,
      prompt: params.prompt,
      modelSelection: params.modelSelection,
      mode: params.mode,
      recurring: params.recurring,
      maxRuns: params.maxRuns,
      endAt: params.endAt,
      scheduleRule: params.scheduleRule,
      scheduleEditedByUser: params.scheduleEditedByUser,
      nextRunAt: options?.nextRunAt,
      lifecycleStatus: options?.lifecycleStatus,
      resetRetry: options?.resetRetry,
      now: Date.now(),
    })) as ZCodeAutomation | null;
  }

  async delete(automationId: string, workspaceKey?: string): Promise<boolean> {
    await this.ensureReady();
    return this.#repository().automationDelete({ automationId, workspaceKey });
  }

  /** Pause / resume. paused ↔ active, keeping next_run_at / run_count. */
  async setEnabled(automationId: string, enabled: boolean, workspaceKey?: string): Promise<void> {
    await this.ensureReady();
    await this.#repository().automationSetEnabled({
      automationId,
      enabled,
      workspaceKey,
      now: Date.now(),
    });
  }

  /** Manual re-run of a terminal task: back to active, counters and retry state cleared, with nextRunAt recomputed and passed in by the caller. */
  async restart(
    automationId: string,
    options: { nextRunAt: number | null },
    workspaceKey?: string,
  ): Promise<void> {
    await this.ensureReady();
    await this.#repository().automationRestart({
      automationId,
      nextRunAt: options.nextRunAt,
      workspaceKey,
      now: Date.now(),
    });
  }

  /**
   * Run now: writes a manual run held directly by the current host, without touching the automation's
   * cron plan/lifecycle. Repeated clicks cannot dispatch the same target concurrently, because the
   * single-flight lock is taken here and released once the host settles the dispatch.
   */
  async runNow(
    automationId: string,
    options: { now: number },
    workspaceKey?: string,
  ): Promise<ClaimedManualAutomationRun | null> {
    await this.ensureReady();
    return (await this.#repository().automationRunNow({
      automationId,
      workspaceKey,
      runId: `${automationId}:manual:${randomUUID()}`,
      now: options.now,
    })) as ClaimedManualAutomationRun | null;
  }

  // ---- Scheduling state machine ----

  /**
   * Single-flight claims due items: atomically running=0→1. At the same time it reclaims zombie items
   * whose claim timed out (claimed_at expired). The due check looks at both next_run_at and retry_at;
   * either one being due makes it due.
   */
  async claimDue(now: number): Promise<ZCodeAutomation[]> {
    await this.ensureReady();
    return asAutomations(await this.#repository().automationClaimDue(now));
  }

  /**
   * Claims the manual runs produced by the UI's "Run now".
   * Run now must not change next_run_at, or it would pollute the original cron cadence; a manual run
   * uses automation_runs as its queue and briefly takes the automation running lock to avoid
   * dispatching the same task concurrently with a scheduled trigger.
   */
  async claimManualRuns(now: number): Promise<ClaimedManualAutomationRun[]> {
    await this.ensureReady();
    return (await this.#repository().automationClaimManualRuns(
      now,
    )) as ClaimedManualAutomationRun[];
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
    await this.#repository().automationMarkDispatched({
      automationId,
      dispatchedAt: options.dispatchedAt,
      nextRunAt: options.nextRunAt,
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
    await this.#repository().automationMarkDispatchFailed({
      automationId,
      failedAt: options.failedAt,
      error: options.error,
      kind: options.kind,
      nextRunAt: options.nextRunAt,
    });
  }

  /** Releases the claim on shutdown/exit: clears running, keeps next_run_at, records no failure and advances nothing. */
  async releaseClaim(automationId: string): Promise<void> {
    await this.ensureReady();
    await this.#repository().automationReleaseClaim({ automationId, now: Date.now() });
  }

  /** After a manual run ends, only the single-flight lock is released; the automation's scheduling state is left untouched. */
  async releaseManualClaim(automationId: string, workspaceKey: string): Promise<void> {
    await this.ensureReady();
    await this.#repository().automationReleaseManualClaim({
      automationId,
      workspaceKey,
      now: Date.now(),
    });
  }

  /** Renews the lease while the host still holds a queued/running manual run, so a long task is not reclaimed by the scheduler as a zombie claim. */
  async touchManualClaim(automationId: string, workspaceKey: string): Promise<void> {
    await this.ensureReady();
    await this.#repository().automationTouchManualClaim({
      automationId,
      workspaceKey,
      now: Date.now(),
    });
  }

  /**
   * Missed fire window: atomically records a skipped run + pushes next_run_at forward to the next
   * future fire point + resets the claim. run_count is not incremented. finalize=true is for purely
   * one-shot tasks: once the target moment is missed it is terminal.
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
    await this.#repository().automationSkipAndReschedule({ ...params, now: Date.now() });
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
    await this.#repository().automationEnsureRunClaimed({ ...params, now: Date.now() });
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
    await this.#repository().automationUpsertRunClaimed({ ...params, now: Date.now() });
  }

  /**
   * Atomically pins the run Selection the first time a Select forms a Submission; later calls can
   * only read the original value back.
   */
  async fixRunModelSelection(runId: string, selection: ModelSelection): Promise<ModelSelection> {
    await this.ensureReady();
    return (await this.#repository().automationFixRunModelSelection({
      runId,
      modelSelection: selection,
      now: Date.now(),
    })) as ModelSelection;
  }

  /** Writes the dispatch result back onto the run (dispatched backfills session_id / failed_to_dispatch records the error). */
  async markRunDispatch(params: {
    runId: string;
    dispatchStatus: ZCodeAutomationRunDispatchStatus;
    sessionId?: string | null;
    error?: string | null;
  }): Promise<void> {
    await this.ensureReady();
    await this.#repository().automationMarkRunDispatch({ ...params, now: Date.now() });
  }

  /**
   * Settlement of the first successful dispatch of a manual run: atomically updates the run ledger
   * and the cumulative run count. The first entry of dispatch_status into dispatched is the
   * idempotency boundary.
   */
  async markManualRunDispatched(params: {
    runId: string;
    sessionId?: string | null;
    dispatchedAt: number;
  }): Promise<boolean> {
    await this.ensureReady();
    return this.#repository().automationMarkManualRunDispatched(params);
  }

  /** The session runtime writes the run outcome back (running / succeeded / failed / stopped). */
  async markRunOutcome(
    runId: string,
    outcome: ZCodeAutomationRunOutcome,
    error?: string,
  ): Promise<void> {
    await this.ensureReady();
    await this.#repository().automationMarkRunOutcome({
      runId,
      outcome,
      error,
      now: Date.now(),
    });
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
    await this.#repository().automationRecordSkippedRun({ ...params, now: Date.now() });
  }

  async listRuns(automationId: string, workspaceKey?: string): Promise<ZCodeAutomationRun[]> {
    await this.ensureReady();
    return asRuns(
      await this.#repository().automationListRuns({ automationId, workspaceKey }),
    );
  }

  async getRun(runId: string): Promise<ZCodeAutomationRun | null> {
    await this.ensureReady();
    return asRun(await this.#repository().automationGetRun(runId)) as ZCodeAutomationRun | null;
  }

  async deleteRun(runId: string, workspaceKey?: string): Promise<void> {
    await this.ensureReady();
    await this.#repository().automationDeleteRun({ runId, workspaceKey });
  }

  /** Retention policy: deletes historical runs older than maxAgeMs (guards against unbounded growth). */
  async pruneRuns(maxAgeMs: number): Promise<number> {
    await this.ensureReady();
    return this.#repository().automationPruneRuns({ maxAgeMs, now: Date.now() });
  }
}
