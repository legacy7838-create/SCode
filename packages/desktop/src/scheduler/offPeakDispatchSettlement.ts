import type { OffPeakTaskRepo } from "@zcode/services/node";
import type { MainToSchedulerMessage } from "./schedulerProtocol.js";

const OFF_PEAK_DISPATCH_RETRY_BASE_MS = 30_000;
const OFF_PEAK_DISPATCH_RETRY_CAP_MS = 15 * 60_000;

type OffPeakDispatchResult = Extract<MainToSchedulerMessage, { type: "offpeak-dispatch-result" }>;

type OffPeakDispatchSettlementRepo = Pick<
  OffPeakTaskRepo,
  "markRunning" | "markTerminal" | "releaseClaim"
>;

interface OffPeakDispatchSettlementDeps {
  repo: OffPeakDispatchSettlementRepo;
  retryAt: Map<string, number>;
  retryAttempts: Map<string, number>;
  now: () => number;
  log: (level: "info" | "warn" | "error", message: string) => void;
}

/**
 * Settles the result of an off-peak task dispatch.
 *
 * failureKind cannot be ignored: deterministic configuration errors such as a missing model or
 * credentials must not back off forever, because the task would then show as permanently waiting
 * for compute while repeatedly burning server-side tickets. Only transient failures are allowed to
 * go back to queued.
 */
export async function settleOffPeakDispatchResult(
  deps: OffPeakDispatchSettlementDeps,
  msg: OffPeakDispatchResult,
): Promise<void> {
  const now = deps.now();
  if (msg.ok) {
    deps.retryAt.delete(msg.offPeakTaskId);
    deps.retryAttempts.delete(msg.offPeakTaskId);
    const updated = await deps.repo.markRunning(msg.offPeakTaskId, {
      startedAt: now,
      ...(msg.conversationId ? { conversationId: msg.conversationId } : {}),
      ...(msg.sessionId ? { sessionId: msg.sessionId } : {}),
    });
    if (!updated) {
      await deps.repo.releaseClaim(msg.offPeakTaskId, { now });
      deps.log(
        "warn",
        `off-peak dispatch result dropped (task no longer queued) task=${msg.offPeakTaskId}`,
      );
    }
    return;
  }

  const error = msg.error ?? "dispatch failed";
  if (msg.failureKind === "permanent") {
    deps.retryAt.delete(msg.offPeakTaskId);
    deps.retryAttempts.delete(msg.offPeakTaskId);
    const failed = await deps.repo.markTerminal(msg.offPeakTaskId, {
      status: "failed",
      endedAt: now,
      failureReason: error,
      dispatchError: error,
    });
    if (!failed) {
      await deps.repo.releaseClaim(msg.offPeakTaskId, { now });
      deps.log(
        "warn",
        `off-peak permanent dispatch result dropped (task already changed) task=${msg.offPeakTaskId}`,
      );
      return;
    }
    deps.log("warn", `off-peak dispatch permanently failed task=${msg.offPeakTaskId}: ${error}`);
    return;
  }

  const attempts = (deps.retryAttempts.get(msg.offPeakTaskId) ?? 0) + 1;
  deps.retryAttempts.set(msg.offPeakTaskId, attempts);
  const backoff = Math.min(
    OFF_PEAK_DISPATCH_RETRY_BASE_MS * 2 ** Math.max(0, attempts - 1),
    OFF_PEAK_DISPATCH_RETRY_CAP_MS,
  );
  deps.retryAt.set(msg.offPeakTaskId, now + backoff);
  await deps.repo.releaseClaim(msg.offPeakTaskId, { error, now });
  deps.log(
    "warn",
    `off-peak dispatch failed task=${msg.offPeakTaskId} attempts=${attempts} retryIn=${backoff}ms: ${error}`,
  );
}
