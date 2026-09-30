// scheduler(utilityProcess) ↔ main’s control message protocol. Both ends are on the Electron side, go parentPort.postMessage.
// Different from host↔main's CronRun/CronRunResult (see @zcode/shared channels + validation):
// This layer is the private channel between main and the "resident cron scheduler process"; after main receives the dispatch request, it translates it into CronRun and forwards it to the host.
import type { ModelSelection, NodeSelfResourceSample } from "@zcode/shared";

/** scheduler → main */
export type SchedulerToMainMessage =
  | {
      type: "cron-dispatch-request";
      automationId: string;
      runId: string;
      prompt: string;
      targetTaskId?: string;
      modelSelection?: ModelSelection;
      mode?: string;
      workspacePath: string;
      workspaceIdentity?: string;
    }
  | {
      // Off-time task dispatching: independent of cron messages. The first run does not have conversationId/sessionId,
      // host createTask creates a new session; resume/interrupt recovery brings both to resume the same session.
      type: "offpeak-dispatch-request";
      offPeakTaskId: string;
      prompt: string;
      permissionMode: string;
      modelSelection: ModelSelection;
      conversationId?: string;
      sessionId?: string;
      serverTicketId?: string;
      workspacePath: string;
      workspaceIdentity?: string;
    }
  | {
      type: "scheduler-log";
      level: "info" | "warn" | "error";
      message: string;
    }
  | {
      // The idle task running count changes → main accordingly + keepAwakeWhileRunning is set
      // Decide whether to enable powerSaveBlocker. Report the current value after each tick (idempotent).
      type: "offpeak-active-count";
      count: number;
    }
  | {
      // The scheduler process self-samples every 60 seconds.
      // main only takes the heap as the heap dimension of the scheduler role event. CPU and RSS are still based on getAppMetrics.
      type: "scheduler-resource-sample";
      sample: NodeSelfResourceSample;
    };

/** main → scheduler */
export type MainToSchedulerMessage =
  | {
      type: "cron-dispatch-result";
      runId: string;
      ok: boolean;
      taskId?: string;
      sessionId?: string;
      error?: string;
      failureKind?: "transient" | "permanent";
    }
  | {
      // The results are dispatched during idle time; the late results are only settled based on offPeakTaskId (no inFlight context is available, idempotent).
      type: "offpeak-dispatch-result";
      offPeakTaskId: string;
      ok: boolean;
      conversationId?: string;
      sessionId?: string;
      error?: string;
      failureKind?: "transient" | "permanent";
    }
  | {
      // Main notifies the scheduler to finish gracefully (release claims, close the library) before exiting.
      type: "scheduler-dispose";
    }
  | {
      // The manual run has been submitted and triggers a tick immediately; the automationId is only used for log correlation.
      type: "scheduler-wake";
      automationId: string;
    };
