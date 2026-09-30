/* eslint-disable max-lines -- the off-peak task orchestration service centrally maintains
   create/cancel/pause/continue/delete, poll sync (offPeakTaskSync), the terminal settlement outbox
   and 3102 continuation re-takes; it will be split by responsibility once things stabilize. */
/* off-peak task orchestration service (host domain, modeled after automationService).
   Responsibilities:
   - Take a ticket on create (the row is only persisted after POST /ticket succeeds); 3103/3101 throw
     typed errors to the UI
   - Orchestrate the state guards of cancel/pause/continue/delete/edit
   - offPeakTaskSync: batch poll /ticket/status only when non-terminal tasks exist (polling drives
     the server-side promotion), writing back schedulable/position/next_poll_at; expired and not
     paused → automatically re-take with the same task_id
   - Terminal settlement outbox: settle as soon as a task is terminal, retry the report along with
     the poll cycle on failure, plus a startup scan
   - 3102 continuation: after the host's terminal write-back identifies the marker, call
     handleTicketExpiredDuringRun → requeue and re-take */
import { randomUUID } from "node:crypto";
import { ZodError } from "zod";
import {
  isOffPeakTerminalStatus,
  resolveWorkspaceKey,
  type OffPeakCodingPlanSupport,
  type OffPeakTaskCreateErrorCategory,
  type OffPeakTaskCreateFailureStage,
  type OffPeakTaskCreateResult,
  type ZCodeOffPeakTask,
  type ZCodeOffPeakTaskCreateParams,
} from "@zcode/shared";
import type { ServiceLogger } from "../logger/serviceLogger.js";
import { isOffPeakBoundSessionConflict, type OffPeakTaskRepo } from "./offPeakTaskRepo.js";
import type { IOffPeakTaskService, OffPeakUpdateTaskParams } from "./offPeakTask.js";
import { OffPeakServerError, type OffPeakServerClient } from "./offPeakServerClient.js";
import type { ModelSelection, ModelSelectionValidation } from "@zcode/provider";

/** Poll lower/upper bounds and failure backoff (the server's next_poll_after wins, clamped to prevent hammering and starvation). */
const OFF_PEAK_SYNC_MIN_INTERVAL_MS = 5_000;
const OFF_PEAK_SYNC_MAX_INTERVAL_MS = 5 * 60_000;
const SYNC_FAILURE_BASE_MS = 10_000;

interface OffPeakTaskServiceDeps {
  repo: OffPeakTaskRepo;
  client: OffPeakServerClient;
  /** The redacted result of the resolver shared with ticket/runtime, used for the renderer creation gate. */
  resolveCodingPlanSupport: () => Promise<OffPeakCodingPlanSupport>;
  /** Returns a safe hostname only; a resolution failure returns an empty string and must not affect the creation business result. */
  resolveTelemetryProviderName: () => Promise<string>;
  /** Resolves and validates the fixed Off-Peak Provider selection against the current full Registry. */
  resolveModelSelection: (input: {
    readonly modelId?: string;
    readonly reasoningLevel?: string;
  }) => Promise<
    | { readonly ok: true; readonly selection: ModelSelection }
    | { readonly ok: false; readonly validation: ModelSelectionValidation }
  >;
  logger: ServiceLogger;
  /** Wakes the scheduler tick immediately once schedulable flips to 1 (otherwise it waits for the 20s poll). */
  requestSchedulerWake?: () => void;
  /** Aborts the agent loop of a running task when it is cancelled (host injected; best-effort). */
  stopRunningTask?: (params: {
    conversationId: string;
    workspacePath: string;
    workspaceIdentity?: string;
  }) => Promise<void>;
  /** List-change broadcast hook (UI refresh). */
  onTasksChanged?: () => void;
  /** Clock injected by tests. */
  now?: () => number;
  /** Extra cleanup for disposeAll (e.g. shutting down the mock gateway). */
  onDispose?: () => void;
}

const VALID_CREATE_PERMISSION_MODES = new Set([
  "yolo",
  "plan",
  "edit",
  "auto",
  "autoEdit",
  "build",
]);

function isValidCreateParams(params: ZCodeOffPeakTaskCreateParams): boolean {
  return (
    typeof params.title === "string" &&
    params.title.trim().length > 0 &&
    typeof params.prompt === "string" &&
    params.prompt.trim().length > 0 &&
    typeof params.workspacePath === "string" &&
    params.workspacePath.trim().length > 0 &&
    typeof params.permissionMode === "string" &&
    VALID_CREATE_PERMISSION_MODES.has(params.permissionMode)
  );
}

function classifyOffPeakCreateFailure(
  error: unknown,
  failureStage: OffPeakTaskCreateFailureStage,
): Pick<
  Extract<OffPeakTaskCreateResult, { ok: false }>,
  "failureStage" | "errorCategory" | "errorCode"
> {
  let errorCategory: OffPeakTaskCreateErrorCategory = "unknown";
  let errorCode = "";
  if (failureStage === "client_validation") {
    errorCategory = "client_validation";
  } else if (failureStage === "local_persist") {
    errorCategory = "local_persist";
  } else if (error instanceof OffPeakServerError) {
    errorCode = error.bizCode === undefined ? "" : String(error.bizCode);
    if (error.bizCode === 3101) errorCategory = "eligibility_3101";
    else if (error.bizCode === 3103) errorCategory = "quota_3103";
  } else if (error instanceof ZodError) {
    errorCategory = "invalid_response";
  } else {
    // Credential/RPC/fetch/abort in the ticket client may be thrown across layers as ordinary Error;
    // They still belong to the ticket_request, and the server response cannot be guessed or leaked based on the raw message.
    errorCategory = "network";
  }
  return { failureStage, errorCategory, errorCode };
}

const OFF_PEAK_SESSION_BOUND_FAILURE = {
  failureStage: "client_validation",
  errorCategory: "client_validation",
  errorCode: "session_bound",
} as const;

export class OffPeakTaskService implements IOffPeakTaskService {
  private syncTimer: ReturnType<typeof setTimeout> | null = null;
  private syncRunning = false;
  private syncStopped = true;
  private consecutiveSyncFailures = 0;

  constructor(private readonly deps: OffPeakTaskServiceDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private emitChanged(): void {
    try {
      this.deps.onTasksChanged?.();
    } catch (error) {
      this.deps.logger.warn("off-peak onTasksChanged callback failed:", error);
    }
  }

  // ---- Management operations ----

  async getCodingPlanSupport(): Promise<OffPeakCodingPlanSupport> {
    return this.deps.resolveCodingPlanSupport();
  }

  /** A narrow check before the host dispatches; the final execution is re-validated by the target Agent ModelFactory. */
  async validateDispatchModelSelection(selection: ModelSelection): Promise<boolean> {
    const resolved = await this.deps.resolveModelSelection({
      modelId: selection.modelId,
      ...(selection.options?.reasoningLevel
        ? { reasoningLevel: selection.options.reasoningLevel }
        : {}),
    });
    return (
      resolved.ok &&
      resolved.selection.providerId === selection.providerId &&
      resolved.selection.modelId === selection.modelId
    );
  }

  async getTakeNumberAvailability() {
    return this.deps.client.getTakeNumberAvailability();
  }

  /** Take a ticket on create (the row is only persisted after the take succeeds); on failure only a stable category is returned, never a raw error across RPC. */
  async createTask(params: ZCodeOffPeakTaskCreateParams): Promise<OffPeakTaskCreateResult> {
    let providerName = "";
    try {
      providerName = await this.deps.resolveTelemetryProviderName();
    } catch {
      // provider_name is just a hidden dimension; failure to parse should not change creation, toast, or task execution.
    }
    if (!isValidCreateParams(params)) {
      return {
        ok: false,
        ...classifyOffPeakCreateFailure(undefined, "client_validation"),
        providerName,
      };
    }
    const selection = await this.deps.resolveModelSelection({
      modelId: params.modelSelection.modelId,
      ...(params.modelSelection.options?.reasoningLevel
        ? { reasoningLevel: params.modelSelection.options.reasoningLevel }
        : {}),
    });
    if (!selection.ok) {
      return {
        ok: false,
        ...classifyOffPeakCreateFailure(undefined, "client_validation"),
        providerName,
      };
    }
    const normalizedParams: ZCodeOffPeakTaskCreateParams = {
      ...params,
      modelSelection: selection.selection,
    };
    // If the bound session has unfinished tasks, it will be rejected. Please take the number first to avoid wasting credit;
    // Concurrency crossing the preflight side is denied by idx_off_peak_bound_active on INSERT (see local_persist branch below).
    if (
      params.boundSessionId &&
      (await this.deps.repo.hasActiveBoundTask(
        resolveWorkspaceKey({
          workspacePath: params.workspacePath,
          workspaceIdentity: params.workspaceIdentity,
        }),
        params.boundSessionId,
      ))
    ) {
      return { ok: false, ...OFF_PEAK_SESSION_BOUND_FAILURE, providerName };
    }
    const offPeakTaskId = `offpeak-${randomUUID()}`;
    let ticket;
    try {
      ticket = await this.deps.client.takeTicket(offPeakTaskId);
    } catch (error) {
      return {
        ok: false,
        ...classifyOffPeakCreateFailure(error, "ticket_request"),
        providerName,
      };
    }
    let created: ZCodeOffPeakTask;
    try {
      created = await this.deps.repo.create(normalizedParams, {
        offPeakTaskId,
        serverTicketId: ticket.ticketId,
        registeredAt: ticket.registeredAt,
        ...(ticket.position !== undefined ? { queuePosition: ticket.position } : {}),
        // Get the number and it will be ready (you will be promoted directly when you are free during off-peak hours).
        schedulable: ticket.state === "ready",
      });
      if (ticket.nextPollAfterMs !== undefined) {
        await this.deps.repo.updateSchedulingSnapshot(created.offPeakTaskId, {
          nextPollAt: this.now() + ticket.nextPollAfterMs,
        });
      }
    } catch (error) {
      if (isOffPeakBoundSessionConflict(error)) {
        // The tickets that have been taken will be invalidated with the task, and the server will recycle them as expired; no release interface is added for this purpose.
        return { ok: false, ...OFF_PEAK_SESSION_BOUND_FAILURE, providerName };
      }
      return {
        ok: false,
        ...classifyOffPeakCreateFailure(error, "local_persist"),
        providerName,
      };
    }
    this.deps.logger.info(
      `off-peak task created id=${offPeakTaskId} ticket=${ticket.ticketId} state=${ticket.state}`,
    );
    this.emitChanged();
    this.ensureSyncScheduled(0);
    if (ticket.state === "ready") {
      try {
        this.deps.requestSchedulerWake?.();
      } catch (error) {
        this.deps.logger.warn("off-peak scheduler wake failed after create:", error);
      }
    }
    return {
      ok: true,
      task: created,
      ticketInitialState: ticket.state,
      ...(ticket.position !== undefined ? { queuePosition: ticket.position } : {}),
      providerName,
    };
  }

  /**
   * Cancel (any non-terminal state): persist the terminal state first, then stop the loop — the order
   * guarantees that the loop's late stopped write-back is discarded by the terminal guard and cannot
   * overwrite cancelled (idempotent).
   */
  async cancelTask(offPeakTaskId: string): Promise<ZCodeOffPeakTask | null> {
    const existing = await this.deps.repo.get(offPeakTaskId);
    if (!existing || isOffPeakTerminalStatus(existing.status)) return existing;
    const cancelled = await this.deps.repo.markTerminal(offPeakTaskId, {
      status: "cancelled",
      endedAt: this.now(),
    });
    if (!cancelled) return this.deps.repo.get(offPeakTaskId);
    if (existing.status === "running" && existing.conversationId && this.deps.stopRunningTask) {
      try {
        await this.deps.stopRunningTask({
          conversationId: existing.conversationId,
          workspacePath: existing.workspacePath,
          ...(existing.workspaceIdentity ? { workspaceIdentity: existing.workspaceIdentity } : {}),
        });
      } catch (error) {
        this.deps.logger.warn(`off-peak cancel stop loop failed task=${offPeakTaskId}:`, error);
      }
    }
    this.emitChanged();
    void this.settleOne(cancelled);
    return cancelled;
  }

  /** Pause: stops local dispatch; the ticket stays in the server queue and keeps its place. */
  async pauseTask(offPeakTaskId: string): Promise<ZCodeOffPeakTask | null> {
    const paused = await this.deps.repo.setPaused(offPeakTaskId, true, {
      now: this.now(),
    });
    if (paused) this.emitChanged();
    return paused;
  }

  /**
   * Continue: a live ticket = resume dispatching (zero cost); a voided ticket
   * (expired/not_found/none) = manually re-take right now and go to the back of the queue (quota
   * consumption must be triggered by an explicit user action).
   */
  async continueTask(offPeakTaskId: string): Promise<ZCodeOffPeakTask | null> {
    const resumed = await this.deps.repo.setPaused(offPeakTaskId, false, {
      now: this.now(),
    });
    if (!resumed) return null;
    let ticketAlive = false;
    if (resumed.serverTicketId) {
      try {
        const status = await this.deps.client.batchStatus([resumed.serverTicketId]);
        // Must match by ticketId, tickets[0] cannot be taken - the batch response sequence/content is not guaranteed to be consistent with the request.
        const entry = status.tickets.find((t) => t.ticketId === resumed.serverTicketId);
        ticketAlive =
          entry !== undefined && entry.state !== "expired" && entry.state !== "not_found";
        if (entry && ticketAlive) {
          await this.deps.repo.updateSchedulingSnapshot(offPeakTaskId, {
            schedulable: entry.state === "ready",
            queuePosition: entry.position ?? null,
            now: this.now(),
          });
        }
      } catch (error) {
        // If the status query fails, it will be handled as a live ticket and left to polling; do not waste the number retrieval quota on Continue.
        this.deps.logger.warn(
          `off-peak continue status check failed task=${offPeakTaskId}:`,
          error,
        );
        ticketAlive = true;
      }
    }
    if (!ticketAlive) {
      await this.retakeTicket(offPeakTaskId);
    }
    this.emitChanged();
    this.ensureSyncScheduled(0);
    return this.deps.repo.get(offPeakTaskId);
  }

  /** Delete: a non-terminal task is first handled as a cancellation (stop the loop + settle), then the row is deleted; a terminal task is deleted directly. */
  async deleteTask(offPeakTaskId: string): Promise<void> {
    const existing = await this.deps.repo.get(offPeakTaskId);
    if (!existing) return;
    if (!isOffPeakTerminalStatus(existing.status)) {
      await this.cancelTask(offPeakTaskId);
    }
    await this.deps.repo.delete(offPeakTaskId);
    this.emitChanged();
  }

  /** Delete history: only writes a local visibility marker; the task and its session are kept. */
  async deleteHistory(offPeakTaskId: string): Promise<ZCodeOffPeakTask | null> {
    const updated = await this.deps.repo.markHistoryDeleted(offPeakTaskId, {
      now: this.now(),
    });
    if (updated) this.emitChanged();
    return updated;
  }

  /** Edit (all fields are editable while queued/paused; the ticket only locks the queue identity and the prompt is only read at dispatch time). */
  async updateTask(
    offPeakTaskId: string,
    params: OffPeakUpdateTaskParams,
  ): Promise<ZCodeOffPeakTask | null> {
    const existing = await this.deps.repo.get(offPeakTaskId);
    if (!existing) return null;
    if (existing.status !== "queued" && existing.status !== "paused") {
      // Editing is locked (cancel only) from running, and the final state is read-only.
      return null;
    }
    // Idle tasks must save an explicit model that can be parsed by the current Registry; clearing the model cannot degenerate into
    // "Get the first one later", otherwise the selection you see when editing and the actually dispatched model will drift.
    if (params.modelSelection === null) return null;
    const candidate = params.modelSelection ?? existing.modelSelection;
    if (!candidate) return null;
    const selection = await this.deps.resolveModelSelection({
      modelId: candidate.modelId,
      ...(candidate.options?.reasoningLevel
        ? { reasoningLevel: candidate.options.reasoningLevel }
        : {}),
    });
    if (!selection.ok) return null;
    const normalizedParams: OffPeakUpdateTaskParams = {
      ...params,
      modelSelection: selection.selection,
    };
    const updated = await this.deps.repo.updateEditableFields(offPeakTaskId, normalizedParams, {
      now: this.now(),
    });
    if (updated) this.emitChanged();
    return updated;
  }

  async list(): Promise<ZCodeOffPeakTask[]> {
    return this.projectModelSelectionIssues(await this.deps.repo.list());
  }

  async get(offPeakTaskId: string): Promise<ZCodeOffPeakTask | null> {
    const task = await this.deps.repo.get(offPeakTaskId);
    if (!task) return null;
    return (await this.projectModelSelectionIssues([task]))[0] ?? null;
  }

  /**
   * Only derives diagnostics for the current configuration, it does not write to the database; legacy fields are handled solely by the migration.
   */
  private async projectModelSelectionIssues(
    tasks: readonly ZCodeOffPeakTask[],
  ): Promise<ZCodeOffPeakTask[]> {
    const repaired: ZCodeOffPeakTask[] = [];
    for (const task of tasks) {
      if (task.modelSelection) {
        // When reading, writing the current account unavailable as NULL will permanently lose the original selection and induce rebinding of the old field.
        // The new structure only derives diagnosis and does not write tasks or tickets; the final state no longer uses the model and does not need to be rechecked.
        const usable =
          isOffPeakTerminalStatus(task.status) ||
          (await this.validateDispatchModelSelection(task.modelSelection));
        repaired.push(
          usable
            ? task
            : {
                ...task,
                schedulable: false,
                modelSelectionIssue: {
                  code: "repair-required",
                  legacyModelId: task.modelSelection.modelId,
                  legacyReasoningLevel: task.modelSelection.options?.reasoningLevel,
                },
              },
        );
        continue;
      }
      // When the database migration cannot determine the old Provider, it remains missing; the read will not be migrated or the Ticket will be re-binded.
      repaired.push({ ...task, schedulable: false });
    }
    return repaired;
  }

  // ---- 3102 Continue running (called after the host final state writes back the identification mark) ----

  /** Ticket expired (the 3h active window ended / the ready ticket was voided): requeue keeping the session → re-take with the same task_id. */
  async handleTicketExpiredDuringRun(offPeakTaskId: string): Promise<void> {
    const requeued = await this.deps.repo.requeueForContinuation(offPeakTaskId, {
      now: this.now(),
    });
    if (!requeued) {
      this.deps.logger.info(
        `off-peak ticket-expired requeue dropped (not running) task=${offPeakTaskId}`,
      );
      return;
    }
    await this.retakeTicket(offPeakTaskId);
    this.emitChanged();
    this.ensureSyncScheduled(0);
  }

  /** Re-takes with the same task_id (multiple takes are known to be allowed); on failure the poll cycle retries. */
  private async retakeTicket(offPeakTaskId: string): Promise<void> {
    try {
      const ticket = await this.deps.client.takeTicket(offPeakTaskId);
      await this.deps.repo.updateSchedulingSnapshot(offPeakTaskId, {
        serverTicketId: ticket.ticketId,
        registeredAt: ticket.registeredAt,
        schedulable: ticket.state === "ready",
        queuePosition: ticket.position ?? null,
        ...(ticket.nextPollAfterMs !== undefined
          ? { nextPollAt: this.now() + ticket.nextPollAfterMs }
          : {}),
        now: this.now(),
      });
      if (ticket.state === "ready") this.deps.requestSchedulerWake?.();
      this.deps.logger.info(
        `off-peak re-take ticket task=${offPeakTaskId} ticket=${ticket.ticketId} state=${ticket.state}`,
      );
    } catch (error) {
      // Failure to obtain the number (limit/network) is not finalized - the task remains in queue, and the next polling cycle finds that there is no valid ticket and will be re-acquired.
      this.deps.logger.warn(`off-peak re-take ticket failed task=${offPeakTaskId}:`, error);
    }
  }

  // ---- offPeakTaskSync: batch polling + promotion writeback + write-off outbox ----

  startSync(): void {
    if (!this.syncStopped) return;
    this.syncStopped = false;
    // The final state of scan once upon startup is not written off (host starts scanning).
    this.ensureSyncScheduled(0);
  }

  stopSync(): void {
    this.syncStopped = true;
    if (this.syncTimer) {
      clearTimeout(this.syncTimer);
      this.syncTimer = null;
    }
  }

  /** disposeServiceResources hook: unified reclamation on host exit (stop polling + extra cleanup). */
  disposeAll(): void {
    this.stopSync();
    try {
      this.deps.onDispose?.();
    } catch (error) {
      this.deps.logger.warn("off-peak onDispose cleanup failed:", error);
    }
  }

  private ensureSyncScheduled(delayMs: number): void {
    if (this.syncStopped) return;
    if (this.syncTimer) clearTimeout(this.syncTimer);
    this.syncTimer = setTimeout(() => {
      this.syncTimer = null;
      void this.runSyncCycle();
    }, delayMs);
    // Node timers do not prevent processes from exiting (host lifecycle is managed externally).
    this.syncTimer.unref?.();
  }

  /** A single sync cycle; an explicit call (tests/startup scan) is not affected by stopSync, only the automatically rescheduled loop is controlled. */
  async runSyncCycle(): Promise<void> {
    if (this.syncRunning) return;
    this.syncRunning = true;
    let nextDelay = OFF_PEAK_SYNC_MAX_INTERVAL_MS;
    try {
      // 1) Write off outbox incidental supplementary report (no new timer is added).
      await this.flushSettleOutbox();
      // 2) Only poll if there are non-final tasks.
      const nonTerminal = await this.projectModelSelectionIssues(
        await this.deps.repo.listNonTerminal(),
      );
      const withTickets = nonTerminal.filter((task) => task.serverTicketId);
      // Queued tasks without tickets (remaining after failed number retrieval): retrieval number.
      for (const task of nonTerminal) {
        if (!task.serverTicketId && task.status === "queued") {
          await this.retakeTicket(task.offPeakTaskId);
        }
      }
      if (withTickets.length === 0 && nonTerminal.length === 0) {
        // No tasks: no longer automatically rescheduled, waiting for the next create/continue trigger.
        this.consecutiveSyncFailures = 0;
        return;
      }
      if (withTickets.length > 0) {
        const status = await this.deps.client.batchStatus(
          withTickets.map((task) => task.serverTicketId!),
        );
        let anyBecameSchedulable = false;
        for (const task of withTickets) {
          const entry = status.tickets.find((t) => t.ticketId === task.serverTicketId);
          if (!entry) continue;
          anyBecameSchedulable =
            (await this.applyTicketStatus(task, entry.state, entry.position)) ||
            anyBecameSchedulable;
        }
        if (anyBecameSchedulable) this.deps.requestSchedulerWake?.();
        if (status.nextPollAfterMs !== undefined) {
          nextDelay = status.nextPollAfterMs;
        } else {
          nextDelay = OFF_PEAK_SYNC_MIN_INTERVAL_MS;
        }
        this.emitChanged();
      } else {
        nextDelay = OFF_PEAK_SYNC_MIN_INTERVAL_MS;
      }
      this.consecutiveSyncFailures = 0;
    } catch (error) {
      // If polling fails, back off and retry: it will not be dispatched during the period and running will not be affected.
      this.consecutiveSyncFailures += 1;
      nextDelay = Math.min(
        SYNC_FAILURE_BASE_MS * 2 ** Math.max(0, this.consecutiveSyncFailures - 1),
        OFF_PEAK_SYNC_MAX_INTERVAL_MS,
      );
      this.deps.logger.warn(
        `off-peak sync cycle failed (attempt ${this.consecutiveSyncFailures}):`,
        error,
      );
    } finally {
      this.syncRunning = false;
      const clamped = Math.min(
        Math.max(nextDelay, OFF_PEAK_SYNC_MIN_INTERVAL_MS),
        OFF_PEAK_SYNC_MAX_INTERVAL_MS,
      );
      this.ensureSyncScheduled(clamped);
    }
  }

  /** Single-ticket status mapping (two axes): returns whether it flipped to dispatchable. */
  private async applyTicketStatus(
    task: ZCodeOffPeakTask,
    state: string,
    position: number | undefined,
  ): Promise<boolean> {
    const now = this.now();
    switch (state) {
      case "ready": {
        const became = task.schedulable !== true && task.status === "queued";
        await this.deps.repo.updateSchedulingSnapshot(task.offPeakTaskId, {
          schedulable: true,
          queuePosition: position ?? null,
          nextPollAt: now + OFF_PEAK_SYNC_MIN_INTERVAL_MS,
          now,
        });
        return became;
      }
      case "queued":
        await this.deps.repo.updateSchedulingSnapshot(task.offPeakTaskId, {
          schedulable: false,
          queuePosition: position ?? null,
          now,
        });
        return false;
      case "active":
        // The client loop is running (or dispatched in transit); the snapshot does not move the state machine, only clearing the display.
        await this.deps.repo.updateSchedulingSnapshot(task.offPeakTaskId, {
          queuePosition: null,
          now,
        });
        return false;
      case "expired": {
        // Any expired → re-take the number with the same task_id and continue the arrangement (unified caliber);
        // Exception: paused stops in place and waits for manual Continue; running expires in 3h
        // Triggered by the messages 400/3102 path, only invalid tickets in the queue are processed here.
        if (task.status === "queued") {
          await this.deps.repo.updateSchedulingSnapshot(task.offPeakTaskId, {
            schedulable: false,
            queuePosition: null,
            now,
          });
          await this.retakeTicket(task.offPeakTaskId);
        }
        return false;
      }
      case "settled":
      case "not_found":
      default:
        return false;
    }
  }

  /** Reports terminal tasks that are not settled yet (idempotent; failing forever is harmless — the server's silent timeout reclamation is the backstop). */
  private async flushSettleOutbox(): Promise<void> {
    const unsettled = await this.deps.repo.listUnsettledTerminal();
    for (const task of unsettled) {
      await this.settleOne(task);
    }
  }

  private async settleOne(task: ZCodeOffPeakTask): Promise<void> {
    if (!task.serverTicketId) {
      // No ticket (mock goes first/number retrieval is never successful): There is no write-off object, mark it directly to prevent the outbox from staying permanently.
      await this.deps.repo.markSettled(task.offPeakTaskId, this.now());
      return;
    }
    try {
      await this.deps.client.settle(task.serverTicketId);
      await this.deps.repo.markSettled(task.offPeakTaskId, this.now());
    } catch (error) {
      if (error instanceof OffPeakServerError && error.httpStatus < 500) {
        // 4xx (unknown tickets, etc.) are handled as idempotent ack: the server has no such ticket to release.
        await this.deps.repo.markSettled(task.offPeakTaskId, this.now());
        return;
      }
      // Network/5xx: remain unwritten and will be supplemented in the next cycle (no new timer is added).
      this.deps.logger.warn(`off-peak settle failed ticket=${task.serverTicketId}:`, error);
    }
  }
}
