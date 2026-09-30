// Resident cron scheduler process: pulled up by desktop main through electronUtilityProcess.fork.
// Responsibilities (tasks-index owner plan):
//   - Poll the automations of tasks-index, and the transaction claims the expired task (AutomationRepo.claimDue: BEGIN IMMEDIATE + running 0→1)
//   - Poll the manual run in automation_runs, manually trigger the accumulated run_count, but do not advance next_run_at / max_runs / lifecycle
//   - Maintain dispatch state machine: misfire skip, single-flight claim, successful settlement, failed retreat and retry
//   - Send the dispatch request of the due task back to main (main is then translated into CronRun and transferred to the workspace host to execute createTask+sendPrompt)
//   - Settlement after receiving main return automation + automation_runs
//   - Off-peak tasks (off_peak_tasks): start the recycling interrupt task and claim the dispatch of queued tasks with schedulable=1;
//     All independent of automation tables/messages/constants, ⚠ no misfire-skip semantics (delayed without discarding)
// This process only reads and writes tasks-index and does not touch the UI/agent runtime; createTask is executed by the host domain.
import {
  AutomationRepo,
  computeAutomationNextRunAt,
  isOneShotAutomation,
  OffPeakTaskRepo,
} from "@zcode/services/node";
import {
  resolveWorkspaceKey,
  type ZCodeAutomation,
  type ZCodeAutomationTrigger,
  type ZCodeAutomationRun,
  type ZCodeOffPeakTask,
} from "@zcode/shared";
import type { MainToSchedulerMessage, SchedulerToMainMessage } from "./schedulerProtocol.js";
import { settleManualClaimForDispatchResult } from "./manualClaimRelease.js";
import { settleOffPeakDispatchResult } from "./offPeakDispatchSettlement.js";
import {
  startSchedulerResourceTelemetry,
  type SchedulerResourceTelemetry,
} from "./schedulerResourceTelemetry.js";

/** Polling interval: The minimum granularity of cron is minutes, and 20s polling is enough to hit on time and with low overhead. */
const POLL_INTERVAL_MS = 20_000;
/**
 * misfire grace: if next_run_at exceeds this value earlier than now, it will be regarded as a "window missed during shutdown/hibernation/exit" → skipped will not be rerun.
 * The value needs to be significantly larger than a normal polling delay (to avoid misjudgment of a normal arrival point as a misfire), and it must be able to cover short-term freezes.
 */
const MISFIRE_GRACE_MS = 5 * 60_000;

const { parentPort } = process;

type InFlight = {
  automationId: string;
  workspaceKey: string;
  trigger: ZCodeAutomationTrigger;
};

const repo = new AutomationRepo();
/** runId → Distribute context in transit; settle after waiting for main to report. When the scheduler restarts and is lost, rely on claimDue's zombie recovery to cover it up. */
const inFlight = new Map<string, InFlight>();

// ----Leisure time tasks (off-peak)----
const offPeakRepo = new OffPeakTaskRepo();
/** In-process backoff table: offPeakTaskId → next allowed dispatch time/number of failures. The scheduler is reset when it is restarted, which is harmless. */
const offPeakRetryAt = new Map<string, number>();
const offPeakRetryAttempts = new Map<string, number>();
/** Dispatch collection in transit: only used to release claims when exiting; late results can be settled based on offPeakTaskId and do not rely on it. */
const offPeakInFlight = new Set<string>();

let ticking = false;
let tickRequested = false;
let schedulerReady = false;
let disposed = false;
let pollTimer: ReturnType<typeof setInterval> | null = null;
/** Resource telemetry: The only self-collection timer for this process. */
let resourceTelemetry: SchedulerResourceTelemetry | null = null;

function log(level: "info" | "warn" | "error", message: string): void {
  const msg: SchedulerToMainMessage = { type: "scheduler-log", level, message };
  parentPort?.postMessage(msg);
  // Bottom line: traces remain when parentPort is unavailable (non-utilityProcess debugging run).
  if (!parentPort) {
    // eslint-disable-next-line no-console -- scheduler debugging
    console[level === "error" ? "error" : "log"](`[scheduler] ${message}`);
  }
}

/** Distribution timestamp: Prioritize using next_run_at (unchanged during retry, ensuring runId is stable), and fall back to retry_at / now. */
function resolveScheduledAt(automation: ZCodeAutomation, now: number): number {
  return automation.nextRunAt ?? automation.retryAt ?? now;
}

function buildRunId(automationId: string, scheduledAt: number): string {
  return `${automationId}:${scheduledAt}`;
}

async function tick(): Promise<void> {
  if (disposed || !schedulerReady || ticking) return;
  ticking = true;
  try {
    do {
      tickRequested = false;
      try {
        const now = Date.now();
        const claimed = await repo.claimDue(now);
        for (const automation of claimed) {
          await handleClaimed(automation, now);
        }
        const manualRuns = await repo.claimManualRuns(now);
        for (const manualRun of manualRuns) {
          await handleClaimedManual(manualRun.automation, manualRun.run);
        }
        const offPeakClaimed = await offPeakRepo.claimDue(now);
        for (const task of offPeakClaimed) {
          await handleOffPeakClaimed(task, now);
        }
        // keep-awake: Report the execution count, main + setting determines powerSaveBlocker accordingly.
        await reportOffPeakActiveCount();
      } catch (error) {
        log("error", `tick failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      // The wake-up of manual run may overlap with the current tick; because ticking=true, discarding it directly will cause
      // The user still needs to wait for the next 20-second poll. Record pending and make up the run immediately after the current round is completed.
    } while (tickRequested && !disposed);
  } finally {
    ticking = false;
  }
}

function requestTick(): void {
  if (disposed) return;
  if (!schedulerReady || ticking) {
    tickRequested = true;
    return;
  }
  void tick();
}

async function handleClaimed(automation: ZCodeAutomation, now: number): Promise<void> {
  const scheduledAt = resolveScheduledAt(automation, now);
  const runId = buildRunId(automation.automationId, scheduledAt);
  const workspaceKey = resolveWorkspaceKey({
    workspacePath: automation.workspacePath,
    workspaceIdentity: automation.workspaceIdentity,
  });
  const isRetry = automation.dispatchAttempts > 0;

  // misfire: the first round (non-retry) and the planned trigger time is much earlier than now → the window is considered missed and no make-up is allowed.
  const missed =
    !isRetry && automation.nextRunAt != null && automation.nextRunAt <= now - MISFIRE_GRACE_MS;
  if (missed) {
    // After a purely one-time task (such as delayMinutes completed by minute scheduleRule) misses the window,
    // The general recalculation will give the next cycle of anchorAt + k*interval, so that the "only run once" reminder will be displayed in subsequent cycles.
    // Continue execution. One-time semantics is a determined target moment. If it is missed, it is the final state, and no new execution commitments can be scheduled.
    const finalize = isOneShotAutomation(automation);
    const nextRunAt = finalize ? null : computeAutomationNextRunAt(automation, now);
    await repo.skipAndReschedule({
      automationId: automation.automationId,
      runId,
      workspaceKey,
      scheduledAt,
      reason: "computer_asleep_or_app_not_running",
      nextRunAt,
      finalize,
    });
    log(
      "info",
      `skip missed window automation=${automation.automationId} scheduledAt=${scheduledAt}${finalize ? " finalized=one-shot" : ""}`,
    );
    return;
  }

  // Normal distribution: first drop/update the run ledger (claimed), and then send the request back to main.
  await repo.upsertRunClaimed({
    runId,
    automationId: automation.automationId,
    workspaceKey,
    scheduledAt,
    trigger: "schedule",
    // The original intent is passed in the dispatch request, and the first valid selection is fixed by the target Host; it is not frozen in advance here.
  });
  inFlight.set(runId, {
    automationId: automation.automationId,
    workspaceKey,
    trigger: "schedule",
  });
  const run = await repo.getRun(runId);
  postDispatchRequest(automation, runId, run?.modelSelection);
}

function postDispatchRequest(
  automation: ZCodeAutomation,
  runId: string,
  fixedSelection?: ZCodeAutomationRun["modelSelection"],
): void {
  const request: SchedulerToMainMessage = {
    type: "cron-dispatch-request",
    automationId: automation.automationId,
    runId,
    prompt: automation.prompt,
    ...(automation.targetTaskId ? { targetTaskId: automation.targetTaskId } : {}),
    ...((fixedSelection ?? automation.modelSelection)
      ? { modelSelection: fixedSelection ?? automation.modelSelection }
      : {}),
    ...(automation.mode ? { mode: automation.mode } : {}),
    workspacePath: automation.workspacePath,
    ...(automation.workspaceIdentity ? { workspaceIdentity: automation.workspaceIdentity } : {}),
  };
  parentPort?.postMessage(request);
}

async function handleClaimedManual(
  automation: ZCodeAutomation,
  run: ZCodeAutomationRun,
): Promise<void> {
  inFlight.set(run.runId, {
    automationId: automation.automationId,
    workspaceKey: resolveWorkspaceKey({
      workspacePath: automation.workspacePath,
      workspaceIdentity: automation.workspaceIdentity,
    }),
    trigger: "manual",
  });
  postDispatchRequest(automation, run.runId, run.modelSelection);
}

/** Count reporting during execution (keep-awake): only sends messages when the value changes to reduce noise. */
let lastOffPeakActiveCount = -1;
async function reportOffPeakActiveCount(): Promise<void> {
  try {
    const count = await offPeakRepo.countActive();
    if (count === lastOffPeakActiveCount) return;
    lastOffPeakActiveCount = count;
    const msg: SchedulerToMainMessage = { type: "offpeak-active-count", count };
    parentPort?.postMessage(msg);
  } catch (error) {
    log(
      "warn",
      `off-peak active count report failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

// ---- Task distribution during free time ----

/**
 * After claiming it, the free time tasks will be dispatched. Tasks in retreat are released immediately to claim and wait for the next round (in-process retreat table; claim+release in each round
 * Write twice, the number of tasks is small, and the overhead under WAL is negligible - if the backoff task reaches a large scale, then sink the backoff into claimDue).
 */
async function handleOffPeakClaimed(task: ZCodeOffPeakTask, now: number): Promise<void> {
  const retryAt = offPeakRetryAt.get(task.offPeakTaskId) ?? 0;
  if (retryAt > now) {
    await offPeakRepo.releaseClaim(task.offPeakTaskId, { now });
    return;
  }
  offPeakInFlight.add(task.offPeakTaskId);
  const request: SchedulerToMainMessage = {
    type: "offpeak-dispatch-request",
    offPeakTaskId: task.offPeakTaskId,
    prompt: task.prompt,
    permissionMode: task.permissionMode,
    modelSelection: task.modelSelection,
    ...(task.conversationId ? { conversationId: task.conversationId } : {}),
    ...(task.sessionId ? { sessionId: task.sessionId } : {}),
    ...(task.serverTicketId ? { serverTicketId: task.serverTicketId } : {}),
    workspacePath: task.workspacePath,
    ...(task.workspaceIdentity ? { workspaceIdentity: task.workspaceIdentity } : {}),
  };
  parentPort?.postMessage(request);
  log("info", `off-peak dispatch requested task=${task.offPeakTaskId}`);
}

async function settleDispatchResult(
  msg: Extract<MainToSchedulerMessage, { type: "cron-dispatch-result" }>,
): Promise<void> {
  const context = inFlight.get(msg.runId);
  inFlight.delete(msg.runId);
  const now = Date.now();
  // Restore automationId from runId (cover when context is lost, such as receiving late reports after scheduler restarts).
  const automationId = context?.automationId ?? msg.runId.split(":")[0]!;
  const workspaceKey = context?.workspaceKey;
  const trigger: ZCodeAutomationTrigger =
    context?.trigger ?? (msg.runId.includes(":manual:") ? "manual" : "schedule");
  const settleManualClaim = async (ok: boolean): Promise<void> => {
    await settleManualClaimForDispatchResult({
      repo,
      automationId,
      runId: msg.runId,
      workspaceKey,
      ok,
      logError: (message) => log("error", message),
    });
  };

  if (msg.ok) {
    if (trigger === "manual") {
      await repo.markManualRunDispatched({
        runId: msg.runId,
        sessionId: msg.sessionId ?? null,
        dispatchedAt: now,
      });
      await settleManualClaim(true);
      return;
    }
    await repo.markRunDispatch({
      runId: msg.runId,
      dispatchStatus: "dispatched",
      sessionId: msg.sessionId ?? null,
    });
    const automation = await repo.get(automationId);
    const nextRunAt = automation ? computeAutomationNextRunAt(automation, now) : null;
    await repo.markDispatched(automationId, { dispatchedAt: now, nextRunAt });
    return;
  }

  await repo.markRunDispatch({
    runId: msg.runId,
    dispatchStatus: "failed_to_dispatch",
    error: msg.error ?? "dispatch failed",
  });
  if (trigger === "manual") {
    await settleManualClaim(false);
    return;
  }
  const kind = msg.failureKind ?? "transient";
  await repo.markDispatchFailed(automationId, {
    failedAt: now,
    error: msg.error ?? "dispatch failed",
    kind,
    // After transient reaches the upper limit, the cyclic task jumps to the next normal next_run_at.
    nextRunAt: await repo
      .get(automationId)
      .then((automation) => (automation ? computeAutomationNextRunAt(automation, now) : null)),
  });
}

async function dispose(): Promise<void> {
  if (disposed) return;
  disposed = true;
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
  resourceTelemetry?.stop();
  resourceTelemetry = null;
  // Release the claims that are still in progress for this process to avoid waiting until CLAIM_STALE at the next startup.
  for (const [, context] of inFlight) {
    try {
      if (context.trigger === "manual") {
        await repo.releaseManualClaim(context.automationId, context.workspaceKey);
      } else {
        await repo.releaseClaim(context.automationId);
      }
    } catch {
      // Ignore: Exit path best effort.
    }
  }
  inFlight.clear();
  for (const offPeakTaskId of offPeakInFlight) {
    try {
      await offPeakRepo.releaseClaim(offPeakTaskId);
    } catch {
      // Ignore: Exit path best effort.
    }
  }
  offPeakInFlight.clear();
  try {
    repo.close();
  } catch {
    // neglect.
  }
  try {
    offPeakRepo.close();
  } catch {
    // neglect.
  }
  process.exit(0);
}

parentPort?.on("message", (event: Electron.MessageEvent) => {
  const msg = event.data as MainToSchedulerMessage;
  if (!msg || typeof msg !== "object") return;
  if (msg.type === "scheduler-dispose") {
    void dispose();
    return;
  }
  if (msg.type === "cron-dispatch-result") {
    void settleDispatchResult(msg)
      .then(() => {
        // Manual run may be temporarily unavailable because the same automation has been dispatched.
        // Actively tick after releasing the single-flight lock in the previous round of settlement to avoid waiting for another 20 seconds for polling.
        requestTick();
      })
      .catch((error) => {
        log(
          "error",
          `settle dispatch result failed runId=${msg.runId}: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
    return;
  }
  if (msg.type === "offpeak-dispatch-result") {
    offPeakInFlight.delete(msg.offPeakTaskId);
    void settleOffPeakDispatchResult(
      {
        repo: offPeakRepo,
        retryAt: offPeakRetryAt,
        retryAttempts: offPeakRetryAttempts,
        now: Date.now,
        log,
      },
      msg,
    ).catch((error) => {
      log(
        "error",
        `settle off-peak dispatch result failed task=${msg.offPeakTaskId}: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
    return;
  }
  if (msg.type === "scheduler-wake") {
    log("info", `manual run wake requested automation=${msg.automationId}`);
    requestTick();
  }
});

async function main(): Promise<void> {
  await repo.ensureReady();
  // Idle task interruption recovery: scheduler is an app singleton, started before any dispatch - at this moment in DB
  // Running must be a remnant of the previous app instance and can be safely returned to queued (session is reserved for resume to continue running).
  try {
    const recovered = await offPeakRepo.recoverInterrupted(Date.now());
    if (recovered > 0) {
      log("info", `off-peak recovered ${recovered} interrupted task(s) back to queued`);
    }
  } catch (error) {
    log(
      "error",
      `off-peak recoverInterrupted failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  schedulerReady = true;
  log("info", "cron scheduler started");
  requestTick();
  pollTimer = setInterval(requestTick, POLL_INTERVAL_MS);
  // Resource telemetry: self-sample CPU/memory once every 60 seconds and send it to main (heap can only be read by this process).
  resourceTelemetry = startSchedulerResourceTelemetry({
    postMessage: (message) => parentPort?.postMessage(message),
  });
}

void main().catch((error) => {
  log(
    "error",
    `scheduler bootstrap failed: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(1);
});
