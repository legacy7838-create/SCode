import { useEffect, useRef } from "react";
import type { IPlatformService } from "@zcode/shared";
import type { ZCodeOffPeakTaskStatus } from "@zcode/shared";
import type { IOffPeakTaskService } from "@zcode/services";
import type { IntlInstance } from "@/i18n/index.js";
import { logger } from "@/logger.js";

// Off-Peak task system notifications (authoritative path in-app; clicking a notification jumps to the session; styling still pending design).
// Mounted globally (App root, one per window): main's dispatchTaskNotification dedupes by (status:taskId) for 3s, so repeated
// multi-window triggers show only one notification and no leader election is needed. Polling is independent of host sync (renderer has no sqlite access).

const OFF_PEAK_NOTIFICATION_POLL_MS = 30_000;

/** Off-Peak aggregates only notify terminal states; permission/elicitation are handled by the normal session notification chain to avoid duplicate notifications. */
function notifiableStatus(status: ZCodeOffPeakTaskStatus): "completed" | "failed" | null {
  if (status === "completed") return "completed";
  if (status === "failed") return "failed";
  return null;
}

export function useOffPeakTaskNotifications(params: {
  offPeakTaskService: IOffPeakTaskService;
  platform: Pick<IPlatformService, "showTaskNotification"> | null | undefined;
  enabled: boolean;
  formatMessage: IntlInstance["formatMessage"];
}): void {
  const { offPeakTaskService, platform, enabled, formatMessage } = params;
  // offPeakTaskId → last-seen status; fires only on "new → notifiable status" edges to avoid resending every round.
  const seenStatusRef = useRef(new Map<string, ZCodeOffPeakTaskStatus>());

  useEffect(() => {
    if (!enabled || !platform) return;
    let disposed = false;

    const tick = async () => {
      try {
        const tasks = await offPeakTaskService.list();
        if (disposed) return;
        const seen = seenStatusRef.current;
        const alive = new Set<string>();
        for (const task of tasks) {
          alive.add(task.offPeakTaskId);
          const previous = seen.get(task.offPeakTaskId);
          seen.set(task.offPeakTaskId, task.status);
          if (previous === task.status) continue;
          const kind = notifiableStatus(task.status);
          if (!kind) continue;
          // A terminal state seen for the first time (e.g. backlog right after opening the app) does not backfill historical notifications; only real transitions notify.
          if (previous === undefined) continue;
          const titleKey =
            kind === "completed" ? "offPeak.notify.completed.title" : "offPeak.notify.failed.title";
          const bodyKey =
            kind === "completed" ? "offPeak.notify.completed.body" : "offPeak.notify.failed.body";
          try {
            platform.showTaskNotification({
              // Click-to-jump uses the run session's taskId (a terminal state with no session can't jump; taskId falls back to offPeakTaskId).
              taskId: task.sessionId ?? task.conversationId ?? task.offPeakTaskId,
              status: kind === "completed" ? "completed" : "failed",
              title: formatMessage({ id: titleKey }),
              body: formatMessage({ id: bodyKey }, { title: task.title || task.prompt }),
            });
          } catch (error) {
            logger.warn("[off-peak] notification dispatch failed", error);
          }
        }
        // Prune tasks that have disappeared (deleted) to keep the Map from growing without bound.
        for (const id of seen.keys()) {
          if (!alive.has(id)) seen.delete(id);
        }
      } catch (error) {
        logger.warn("[off-peak] notification poll failed", error);
      }
    };

    void tick();
    const timer = setInterval(() => void tick(), OFF_PEAK_NOTIFICATION_POLL_MS);
    return () => {
      disposed = true;
      clearInterval(timer);
    };
  }, [enabled, platform, offPeakTaskService, formatMessage]);
}
