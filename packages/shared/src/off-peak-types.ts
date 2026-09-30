import type { ZCodeTaskMode } from "./zcode-task-types-core.js";
import type { ModelSelection } from "./model-selection.js";

// ---- Off-Peak Task field type ----
// off_peak_tasks save tasks-index.sqlite.
// It shares the scheduler process and dispatch pipeline with automation, but the data table, message type, and state machine are all independent.
// It is forbidden to add fields to ZCodeAutomation. sqlite column name snake_case, here is the cross-domain camelCase domain type.

/**
 * The six client execution states (the server admission states queued/ready/active/expired/settled
 * are a separate axis): queued=waiting in line for the server's ready; paused=user pressed Pause so
 * dispatch stopped; running=executing; permission/elicitation wait inside an ordinary session while
 * the aggregate state stays running; completed/failed/cancelled=terminal states.
 */
export type ZCodeOffPeakTaskStatus =
  | "queued"
  | "paused"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

/** Set of terminal states: leaving them is irreversible (a state machine invariant). */
export const OFF_PEAK_TERMINAL_STATUSES = ["completed", "failed", "cancelled"] as const;

export function isOffPeakTerminalStatus(
  status: ZCodeOffPeakTaskStatus,
): status is "completed" | "failed" | "cancelled" {
  return (OFF_PEAK_TERMINAL_STATUSES as readonly string[]).includes(status);
}

/**
 * A stable error marker for an unusable ticket (server 400/3102: the 3h active window expired, a
 * ready ticket older than 5min, settled, or not owned by this user). The zcode-cli adapter layer
 * classifies that business code as a non-retryable failure and embeds this marker in the error
 * message; the host terminal write-back then switches to "re-acquire a ticket under the same
 * task_id → resume to continue" instead of settling as failed. Across processes it can only travel
 * through the error text, so the marker must be globally unique and stable — do not change it; it
 * holds the same value as the identically named constant in
 * apps/zcode-cli/packages/adapters/src/model/offpeak-retry.ts.
 */
export const OFF_PEAK_TICKET_EXPIRED_MARKER = "off-peak-ticket-expired";

/** The Off-Peak Provider belongs to the same Family as the current account; tasks store the exact selection and never silently migrate across Families. */
export const OFF_PEAK_PROVIDER_IDS = {
  zai: "account:zai-offpeak-idle-plan",
  bigmodel: "account:bigmodel-offpeak-idle-plan",
} as const;

export function resolveOffPeakProviderId(
  family: "zai" | "bigmodel",
): (typeof OFF_PEAK_PROVIDER_IDS)[typeof family] {
  return OFF_PEAK_PROVIDER_IDS[family];
}

/** The real Coding Plan shapes of the currently selected connection that Off-Peak may use. */
// zai/bigmodel Team Plan is symmetrized, and zai-team kind is added.
export type OffPeakCodingPlanKind =
  | "zai-personal"
  | "bigmodel-personal"
  | "bigmodel-team"
  | "zai-team";

/**
 * Redacted Coding Plan support boundary. The renderer only consumes this result and never reads the
 * JWT/API Key. `connection_unavailable` covers a missing provider, disabled, expired, and an invalid
 * Team runtime key all at once; none of these cases may fall back to another cached connection.
 */
export type OffPeakCodingPlanUnsupportedReason =
  | "provider_family_unselected"
  | "provider_family_api_key_mode"
  | "provider_identity_mismatch"
  | "connection_unselected"
  | "start_plan_not_supported"
  | "connection_unavailable"
  | "selection_changed"
  | "jwt_missing";

export type OffPeakCodingPlanSupport =
  | {
      supported: true;
      kind: OffPeakCodingPlanKind;
      providerFamily: "zai" | "bigmodel";
      providerId: string;
    }
  | {
      supported: false;
      reason: OffPeakCodingPlanUnsupportedReason;
    };

/**
 * An instantaneous snapshot of the server's ticket-acquisition quota.
 * It is only used to decide whether a new ticket can be created; the real POST /ticket remains the
 * final authority on admission.
 */
export interface OffPeakTakeNumberAvailability {
  canTakeNumber: boolean;
  /** The earliest recovery time the server reports when taking a number is currently impossible, in Unix milliseconds. */
  nextTakeAt?: number;
}

export function isOffPeakTicketExpiredError(message: string | undefined): boolean {
  return Boolean(message?.includes(OFF_PEAK_TICKET_EXPIRED_MARKER));
}

/** One off-peak task: creating it from the form immediately takes a number and queues, and dispatching it has createTask open a new session. */
export interface ZCodeOffPeakTask {
  /** Local primary key, also used as the server-side task_id (stable, spanning multiple tickets). */
  offPeakTaskId: string;
  /** The Snowflake ticket_id returned by the server's number acquisition; updated on every re-acquisition (3h expiry continuation / Continue re-acquisition). */
  serverTicketId?: string;
  /** The form's Task title. */
  title: string;
  /** Host conversation taskId; backfilled after the first successful dispatch (from the form: a new session; created inside a session: bound to that session's first run); non-empty = it has already run. */
  conversationId?: string;
  /**
   * The running session. Backfilled after the first run of a form-created task; a task created
   * inside a session writes the current session id at creation time, and the first run resumes
   * that session instead of creating a new one. Used to resume the same session on
   * continuation/interruption recovery.
   */
  sessionId?: string;
  /** The current title of the bound session (joined from tasks-index when listing; a read-only derived value, never persisted). */
  sessionTitle?: string;
  /** The form's Instructions. */
  prompt: string;
  /** All four permission levels are open, mapping onto the existing ZCodeTaskMode, defaulting to "default" (Ask for approval). */
  permissionMode: ZCodeTaskMode;
  /**
   * The structured Submission selection, frozen when the creation is accepted.
   *
   * Legacy database records may only carry model/thought_level and are temporarily empty when read;
   * such tasks must be kept for the user to repair, but they may not enter scheduling until a
   * complete Selection is filled back in.
   */
  modelSelection?: ModelSelection;
  /** Read-only diagnostic fact recorded when a legacy entry's Selection cannot be recovered reliably. */
  modelSelectionIssue?: {
    code: "repair-required";
    legacyModelId?: string;
    legacyReasoningLevel?: string;
  };
  /** workspaceIdentity?.trim() || workspacePath */
  workspaceKey: string;
  workspacePath: string;
  workspaceIdentity?: string;
  status: ZCodeOffPeakTaskStatus;
  /** Basis for FIFO ordering (the authoritative server order is determined by the order numbers are taken; the local order is only for display/dispatch sorting). */
  queuedAt: number;
  startedAt?: number;
  endedAt?: number;
  failureReason?: string;
  /** Completion notification and status bar display; backfilled by reusing the existing task diff. */
  filesChanged?: number;
  /** The server ack time at which the terminal state was settled; undefined=not settled, the outbox re-reports it. */
  settledAt?: number;
  /**
   * The time the user deleted the local History row.
   * It only controls History visibility; it deletes no task/session and clears no execution field.
   */
  historyDeletedAt?: number;
  // -- Server-side synchronization snapshot (host offPeakTaskSync write / scheduler cross-process read) --
  /** Time the number was successfully taken (POST /ticket ack); undefined=no number taken yet. */
  registeredAt?: number;
  /** Server ready (coarse gate): true = the off-peak window is open and a number was obtained, so the scheduler may claim it for dispatch. */
  schedulable?: boolean;
  /** Position in the queue; the UI shows "#N in queue". */
  queuePosition?: number;
  /** Next poll time (the interval is delivered by the server as next_poll_after). */
  nextPollAt?: number;
  createdAt: number;
  updatedAt: number;
}

/** Input for creating an off-peak task (the workspace is injected by the caller from context; the number is taken in the service layer first and only persisted on success). */
export interface ZCodeOffPeakTaskCreateParams {
  title: string;
  prompt: string;
  permissionMode: ZCodeTaskMode;
  modelSelection: ModelSelection;
  workspacePath: string;
  workspaceIdentity?: string;
  /** Created inside a session: binds the session it was created in, and the first run resumes that session (aligning with CronCreate targetTaskId). Omitted when created from the form. */
  boundSessionId?: string;
}

/** The stable ticket state returned at the creation boundary; it holds the same values as the server-side ticket state but does not expose the server ticket ID. */
export type OffPeakTaskTicketInitialState =
  | "queued"
  | "ready"
  | "active"
  | "expired"
  | "settled"
  | "not_found";

export type OffPeakTaskCreateFailureStage =
  | "client_validation"
  | "ticket_request"
  | "local_persist";

export type OffPeakTaskCreateErrorCategory =
  | "client_validation"
  | "eligibility_3101"
  | "quota_3103"
  | "network"
  | "invalid_response"
  | "local_persist"
  | "unknown";

/**
 * Discriminated union of the creation RPC. Failures keep only a stable category / business code;
 * raw errors or response bodies must never cross the RPC boundary.
 * providerName has already been narrowed on the Host side to an explicitly safe hostname; passing a full URL is not allowed.
 */
export type OffPeakTaskCreateResult =
  | {
      ok: true;
      task: ZCodeOffPeakTask;
      ticketInitialState: OffPeakTaskTicketInitialState;
      queuePosition?: number;
      providerName: string;
    }
  | {
      ok: false;
      failureStage: OffPeakTaskCreateFailureStage;
      errorCategory: OffPeakTaskCreateErrorCategory;
      errorCode: string;
      providerName: string;
    };
