import type { OffPeakPort, OffPeakTaskSummary } from "@zcode/contracts";
import {
  zcodeOffPeakCreateResultSchema,
  zcodeOffPeakListResultSchema,
  zcodeProtocolMethods,
  type ZCodeOffPeakTaskProtocolSnapshot,
} from "@zcode/shared";
import type {
  ZCodeProtocolAgentServerContext,
  ZCodeProtocolSessionRecord,
} from "./server-types.js";

const OFF_PEAK_CREATE_FROM_OFF_PEAK_RUN_ERROR =
  "Cannot create an idle-time task while running an idle-time task.";
const OFF_PEAK_CREATE_IN_BOUND_SESSION_ERROR =
  "This session already has a pending idle-time task. Wait for it to finish (or cancel it in Automations) before creating another one here.";
const OFF_PEAK_CREATE_BOUND_SESSION_CHECK_ERROR =
  "Cannot verify whether this session already has a pending idle-time task; try again later.";

const OFF_PEAK_TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled"]);

/**
 * The Off-Peak protocol port. The trade-offs against automation-port:
 * - It only guards against "an off-peak turn recursively creating itself" (activeOffPeakTaskId); it
 *   does not consult activeAutomationId — the cron auto turn lets OffPeakCreate through (a scheduled
 *   turn derives an off-peak task on a timer).
 * - Creation inside a session is bound to the current session (aligning with CronCreate targetTaskId),
 *   and dispatch resumes this session to execute it.
 *   The binding guard only rejects when "this session already has a non-terminal off-peak task" (two
 *   unattended prompts fighting over the same session); once the task has finished another one may be
 *   created, which differs from cron's permanent one-session-one-task rejection. The decision reuses
 *   the minimal offPeak/list snapshot (including sessionId/status) and fails closed when the query
 *   fails. The authority for amplification protection is still the server-side ticket quota
 *   (POST /ticket 3103).
 * - runtimeModel/mode/thoughtLevel are not injected: the defaults are resolved on the host side
 *   (yolo / the last of allowed_models / the highest reasoning tier), since the session's runtime
 *   state is unrelated to the off-peak allowlist.
 * - The session title is not frozen: what gets bound is the user's working session, and a task should
 *   not rewrite its title.
 */
export function createProtocolOffPeakPort(
  context: ZCodeProtocolAgentServerContext,
  resolveOwnSession?: () => ZCodeProtocolSessionRecord | undefined,
): OffPeakPort {
  return {
    async create(input, createContext) {
      const activeSession =
        resolveOwnSession?.() ??
        (createContext?.sessionId ? context.sessions.get(createContext.sessionId) : undefined);
      if (activeSession?.activeOffPeakTaskId?.trim()) {
        // This turn has been dispatched by the idle time task; creating another idle time task within the idle time round = recursive self-derivation, directly rejected.
        // This judgment is the third level of depth besides turn denylist and handler offPeakTurn.
        throw new Error(OFF_PEAK_CREATE_FROM_OFF_PEAK_RUN_ERROR);
      }
      const boundSessionId = createContext?.sessionId ?? activeSession?.app.sessionId;
      if (boundSessionId) {
        let bound: boolean;
        try {
          const listed = await context.requestClient(
            zcodeProtocolMethods.offPeakList,
            {},
            zcodeOffPeakListResultSchema,
          );
          bound = listed.tasks.some(
            (task) =>
              task.sessionId === boundSessionId && !OFF_PEAK_TERMINAL_STATUSES.has(task.status),
          );
        } catch (error) {
          context.logger?.warn("Failed to check bound idle-time tasks before OffPeakCreate", {
            errorMessage: error instanceof Error ? error.message : String(error),
            event: "offpeak.create.bound_session_check.failed",
            sessionId: boundSessionId,
          });
          // Unknown cannot be equated to unbound: temporary host/database failure cannot reopen "same session dual tasks".
          throw new Error(OFF_PEAK_CREATE_BOUND_SESSION_CHECK_ERROR);
        }
        if (bound) throw new Error(OFF_PEAK_CREATE_IN_BOUND_SESSION_ERROR);
      }
      const result = await context.requestClient(
        zcodeProtocolMethods.offPeakCreate,
        {
          title: input.title,
          prompt: input.prompt,
          ...(input.permissionMode ? { permissionMode: input.permissionMode } : {}),
          ...(input.model ? { model: input.model } : {}),
          ...(input.thoughtLevel ? { thoughtLevel: input.thoughtLevel } : {}),
          // Bind the current session; the workspace is still injected from the current session by the host (symmetric automation/create).
          ...(boundSessionId ? { boundSessionId } : {}),
        },
        zcodeOffPeakCreateResultSchema,
      );
      if (!result.ok) {
        // The failure classification is transparently transmitted to the handler for translation as it is, and is prohibited from being downgraded to a message string at the port layer.
        return {
          ok: false,
          failureStage: result.failureStage,
          errorCategory: result.errorCategory,
          errorCode: result.errorCode,
        };
      }
      return { ok: true, task: toOffPeakTaskSummary(result.task) };
    },
    async list() {
      const result = await context.requestClient(
        zcodeProtocolMethods.offPeakList,
        {},
        zcodeOffPeakListResultSchema,
      );
      return result.tasks.map(toOffPeakTaskSummary);
    },
  };
}

function toOffPeakTaskSummary(input: ZCodeOffPeakTaskProtocolSnapshot): OffPeakTaskSummary {
  return {
    offPeakTaskId: input.offPeakTaskId,
    title: input.title,
    status: input.status,
    queuePosition: input.queuePosition,
    sessionId: input.sessionId,
    createdAt: input.createdAt,
  };
}
