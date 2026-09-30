// ============================================================
// Off-Peak Port - idle-time task creation boundary
// ============================================================
// Alongside its AutomationPort brethren. create returns a discriminant union instead of throwing an error: failure classification
// (Quota 3103/Qualification 3101/Network, etc.) Must be fidelity to the handler across CLI↔host protocol,
// Provides the model with stable, actionable error prompts and prohibits downgrading to message string judgment.

import type { OffPeakCreateInput, OffPeakTaskSummary } from "../tools/off-peak.js";

export type OffPeakCreateFailureStage = "client_validation" | "ticket_request" | "local_persist";

export type OffPeakCreateErrorCategory =
  | "client_validation"
  | "eligibility_3101"
  | "quota_3103"
  | "network"
  | "invalid_response"
  | "local_persist"
  | "unknown";

export type OffPeakCreateOutcome =
  | { ok: true; task: OffPeakTaskSummary }
  | {
      ok: false;
      failureStage: OffPeakCreateFailureStage;
      errorCategory: OffPeakCreateErrorCategory;
      errorCode: string;
    };

export function isOffPeakQuotaFailure(
  outcome: OffPeakCreateOutcome,
): outcome is Extract<OffPeakCreateOutcome, { ok: false }> {
  return !outcome.ok && outcome.errorCategory === "quota_3103";
}

export function isOffPeakEligibilityFailure(
  outcome: OffPeakCreateOutcome,
): outcome is Extract<OffPeakCreateOutcome, { ok: false }> {
  return !outcome.ok && outcome.errorCategory === "eligibility_3101";
}

export interface OffPeakCreateContext {
  /** The session where the current tool is called; as the binding session for idle tasks (resume the session first and align it with CronCreate targetTaskId). */
  sessionId?: string;
}

export interface OffPeakPort {
  create(input: OffPeakCreateInput, context?: OffPeakCreateContext): Promise<OffPeakCreateOutcome>;
  list(): Promise<OffPeakTaskSummary[]>;
}
