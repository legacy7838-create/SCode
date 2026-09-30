// ============================================================
// Structured details of run final state
// ============================================================
// Extracted from types.ts (that file is equivalent to 400 lines of lint gate): `ProviderStop` error code details and run-level stop observation
// The payload of the event. Vocabulary (RunStatus/RunStopReason/WorkflowErrorCode) is still in types.ts, here only
// "Details" - they do not participate in joint types, and removal does not affect exhaustive consumers.

/**
 * The structured detail of a `ProviderStop`: notifications and
 * GetWorkflowRun pick their wording from it, and never reverse-parse a message. `reason` is a contracts
 * `ModelFailureReason` value (`auth_failed` / `invalid_request` / `rate_limited` ...); since this is a plain package that does not import
 * contracts it is typed as string; `kind` is the decision key of the policy table (auth / not configured / model unavailable / invalid request /
 * quota / fallback), and the wording table is read with it rather than with reason.
 */
export interface ProviderStopDetails {
  kind: "auth" | "not_configured" | "model_unavailable" | "invalid_request" | "quota" | "other";
  reason: string;
  providerId?: string;
  providerLabel?: string;
  modelId?: string;
  providerCode?: string;
  /** The subagent that triggered the stop (`refToString(instance)`) together with its name / birth phase (carried when present). */
  subagent?: string;
  subagentName?: string;
  phase?: string;
  /** The provider's raw text, verbatim (bounded, truncated by the driver). */
  rawMessage?: string;
  /** Quota class: the reset moment the provider gave (epoch ms), present only when it can be parsed. */
  resetAt?: number;
}

/**
 * A run-level stall: the driver has observed this run going
 * `sinceMs` milliseconds with no successful model request at all, and at least one retry was scheduled in between. A purely observational event; the engine only
 * `record()`s it, and core sends one mid-run notification from it. `reason` is the retry reason that held the majority during that window (a `ModelRetryReason`
 * value, an open string), and `cap` is the cap of that provider's bucket at this moment.
 */
export interface RunStallInfo {
  sinceMs: number;
  reason?: string;
  cap?: number;
}
