import type { ZCodeTaskMode } from "./zcode-task-types-core.js";
import type { ZCodeAutomationBotDeliveryTarget } from "./bots.js";
import type { ModelSelection } from "./model-selection.js";

// ---- Scheduled task (Automation) domain type ----
// automation/automation_runs save tasks-index.sqlite.
// Here is the camelCase field type reused across services / cli / desktop / ui; the sqlite column name is snake_case.

/** Max number of scheduled task definitions a single local task index may keep; every lifecycle state counts. */
export const AUTOMATION_CREATE_LIMIT = 20;
export const AUTOMATION_CREATE_LIMIT_ERROR_CODE = "AUTOMATION_CREATE_LIMIT_REACHED";

export function isAutomationCreateLimitError(error: unknown): boolean {
  const message = typeof error === "string" ? error : error instanceof Error ? error.message : "";
  return message.includes(AUTOMATION_CREATE_LIMIT_ERROR_CODE);
}

/** Lifecycle of a whole automation. */
export type ZCodeAutomationLifecycleStatus = "active" | "completed" | "failed" | "paused";

/** Dispatch info state of the current round of a single automation (for UI/diagnostics). */
export type ZCodeAutomationDispatchStatus =
  | "idle"
  | "claimed"
  | "dispatched"
  | "failed_to_dispatch";

/** Workspace location; always `local` in this iteration, `remote` reserved for later. */
export type ZCodeAutomationLocationKind = "local" | "remote";

/** Trigger source: scheduled or run-now. */
export type ZCodeAutomationTrigger = "schedule" | "manual";

/** Custom recurrence rule; cronExpr is kept for compatible display, this field is authoritative for scheduling. */
export interface ZCodeAutomationScheduleRule {
  unit: "minute" | "hourly" | "daily" | "weekly" | "monthly" | "yearly";
  interval: number;
  hour: number;
  minute: number;
  anchorAt: number;
  weekdays?: number[];
  monthDays?: number[];
  /** Used by yearly: months 1-12 in human numbering. Defaults to the month of anchorAt (for old records that lack this field). */
  months?: number[];
  monthlyMode?: "date" | "weekday";
}

/**
 * The `unit` enum for the session-side long-interval carrier. Same value set as scheduleRule.unit, but the
 * carrier is a controlled input (the model cannot write a full scheduleRule), normalized by the service
 * layer into the authoritative scheduleRule.
 */
export type ZCodeAutomationIntervalUnit = ZCodeAutomationScheduleRule["unit"];

/** Dispatch result of a single run (scheduler is authoritative, drives retries). skipped=missed the trigger window. */
export type ZCodeAutomationRunDispatchStatus =
  | "claimed"
  | "dispatched"
  | "failed_to_dispatch"
  | "skipped";

/** Run outcome after a single run produced a session (written back by the session runtime, display only). */
export type ZCodeAutomationRunOutcome = "running" | "succeeded" | "failed" | "stopped";

/** One scheduled task definition plus its scheduling state. */
export interface ZCodeAutomation {
  automationId: string;
  title: string;
  /** 5-field cron, local time zone. */
  cronExpr: string;
  prompt: string;
  /** Absent means the Select stage keeps following the Workspace preference; present pins a structured model intent. */
  modelSelection?: ModelSelection;
  /** Permission mode; passed through to createTask on dispatch, defaults to the workspace default. */
  mode?: ZCodeTaskMode;
  /** workspaceIdentity?.trim() || workspacePath */
  workspaceKey: string;
  workspacePath: string;
  workspaceIdentity?: string;
  /** A cron created inside a session is bound to the current task; every later trigger is delivered back to that task instead of creating a new session. */
  targetTaskId?: string;
  locationKind: ZCodeAutomationLocationKind;
  /** true=unbounded loop; false=bounded count (paired with maxRuns). */
  recurring: boolean;
  maxRuns?: number;
  /** Cutoff time for custom recurrence (end of the locally selected day, millisecond timestamp). */
  endAt?: number;
  scheduleRule?: ZCodeAutomationScheduleRule;
  /** Whether the read-only schedule from a session source has been explicitly deleted and re-created by the user on the management page. */
  scheduleEditedByUser?: boolean;
  runCount: number;
  enabled: boolean;
  lifecycleStatus: ZCodeAutomationLifecycleStatus;
  nextRunAt?: number;
  lastRunAt?: number;
  dispatchStatus: ZCodeAutomationDispatchStatus;
  dispatchAttempts: number;
  retryAt?: number;
  lastError?: string;
  createdAt: number;
  updatedAt: number;
}

/** Parse result of parseAutomationRunId; scheduledAt only exists for `schedule` triggers. */
export interface ZCodeAutomationRunIdParts {
  automationId: string;
  trigger: ZCodeAutomationTrigger;
  /** The theoretical trigger time of this round embedded in the runId (Unix milliseconds). */
  scheduledAt?: number;
}

/**
 * The only parse entry point for the runId contract (see ZCodeAutomationRun.runId); the desktop host/scheduler
 * and CLI telemetry do not each guess the format from the string. Any input matching neither of the two
 * declared formats returns null.
 */
export function parseAutomationRunId(runId: string): ZCodeAutomationRunIdParts | null {
  const separatorIndex = runId.indexOf(":");
  if (separatorIndex <= 0) return null;
  const automationId = runId.slice(0, separatorIndex);
  const rest = runId.slice(separatorIndex + 1);
  if (rest.startsWith("manual:")) {
    return rest.length > "manual:".length ? { automationId, trigger: "manual" } : null;
  }
  const scheduledAt = Number(rest);
  if (!Number.isSafeInteger(scheduledAt) || scheduledAt <= 0) return null;
  return { automationId, trigger: "schedule", scheduledAt };
}

/** Run history / runId idempotency ledger for a single trigger. */
export interface ZCodeAutomationRun {
  /** automationId:scheduledAt / automationId:manual:uuid */
  runId: string;
  automationId: string;
  workspaceKey: string;
  scheduledAt?: number;
  trigger: ZCodeAutomationTrigger;
  /** Fixed once Select becomes Submission; a dispatch retry of the same run must not re-read the Workspace preference. */
  modelSelection?: ModelSelection;
  dispatchStatus: ZCodeAutomationRunDispatchStatus;
  outcome?: ZCodeAutomationRunOutcome;
  /** Backfilled after a successful dispatch, used for history navigation. */
  sessionId?: string;
  error?: string;
  attempts: number;
  createdAt: number;
  updatedAt: number;
}

/** Input for creating an automation (the caller injects workspace from the session context). */
export interface ZCodeAutomationCreateParams {
  title: string;
  cronExpr: string;
  /** Creation-time only: the service layer converts it to cronExpr based on the real current time, nothing is written to the database. */
  relativeDelayMinutes?: number;
  prompt: string;
  modelSelection?: ModelSelection;
  mode?: ZCodeTaskMode;
  workspacePath: string;
  workspaceIdentity?: string;
  /** Injected by the runtime when created inside the current session, not controllable by the model. */
  targetTaskId?: string;
  /** Injected by the Host when a Bot session creates it; only used by the scheduler to push the final state, never part of the UI display model. */
  botDeliveryTarget?: ZCodeAutomationBotDeliveryTarget;
  recurring: boolean;
  maxRuns?: number;
  endAt?: number;
  scheduleRule?: ZCodeAutomationScheduleRule;
  /**
   * Session-side custom recurrence carrier. Every N minutes/hours/days/weeks/months/years is submitted as a
   * paired intervalUnit + interval, and the real interval is carried by the authoritative scheduleRule that the
   * service layer normalizes to; cronExpr is only kept as a legal compatible display.
   * Mutually exclusive with scheduleRule and relativeDelayMinutes. undefined=no carrier used.
   */
  intervalUnit?: ZCodeAutomationIntervalUnit;
  /** Integer interval of 1–200, must be paired with intervalUnit. */
  interval?: number;
}

/** Mutable fields of an automation edit. */
export interface ZCodeAutomationUpdateParams {
  title?: string;
  cronExpr?: string;
  prompt?: string;
  /** undefined=no change; null=clear, falling back to the Workspace preference. */
  modelSelection?: ModelSelection | null;
  /** undefined=no change; null=clear, falling back to the workspace default permission mode. */
  mode?: ZCodeTaskMode | null;
  recurring?: boolean;
  /** undefined=usually no change; the domain layer clears an old cap automatically when recurring=true; an explicit null requires recurring=true at the same time. */
  maxRuns?: number | null;
  /** undefined=no change; null=never ends. */
  endAt?: number | null;
  /** undefined=no change; null=reverts to a plain cron. */
  scheduleRule?: ZCodeAutomationScheduleRule | null;
  /**
   * Session-side custom recurrence carrier (same as on the create side). intervalUnit + interval are submitted as
   * a pair, and the service layer normalizes them into the authoritative scheduleRule (anchorAt is reset to the
   * time of this edit). undefined=no change.
   */
  intervalUnit?: ZCodeAutomationIntervalUnit;
  /** Integer interval of 1–200, must be paired with intervalUnit. */
  interval?: number;
  /** Only written by the management page when the user actually edits the schedule; undefined=keep the original source state. */
  scheduleEditedByUser?: boolean;
}
