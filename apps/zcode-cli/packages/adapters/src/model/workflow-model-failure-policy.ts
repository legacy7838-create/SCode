/**
 * The model-side failure policy table for workflows.
 *
 * The classifier (failure-classifier.ts) answers "should the main conversation retry automatically";
 * this table answers "should the workflow stop and call for a human". The two tables answer in opposite
 * ways for 3008/3009/3010 (concurrency limits), which is precisely why this module exists: workflow
 * subagents and tool-side requests hold an unbounded retry budget (`modelRetryBudget`), and on them
 * only **deterministic errors that a human has to resolve** are worth stopping the run for; everything
 * else (including unknown business codes the classifier deems non-retryable, TLS, 5xx) retries in place,
 * using the stall notification as the escape hatch.
 *
 * The runner (the retry gate of the attempt loop) and the bootstrap driver (which maps a reject into
 * stopRun / askFailed) share the **same** function: a failure the runner judges retryable will never
 * reach the driver as a stop; a failure the runner judges stop is always judged stop by the policy
 * table at the driver (same function, same input).
 */

import { ModelErrorCode, ModelFailureReason } from "@zcode/contracts";
import type { ClassifiedModelFailure } from "./failure-classifier.js";
import { isRetryableFailure } from "./failure-classifier.js";
import type { ModelRetryBudget } from "@zcode/contracts";
import { isUnboundedRetryBudget } from "./retry-budget.js";

/** The decision key for `ProviderStop`: the notification copy table picks its sentence by this key (not by reason). */
export type WorkflowProviderStopKind =
  | "auth"
  | "not_configured"
  | "model_unavailable"
  | "invalid_request"
  | "quota"
  | "other";

/**
 * A quota-class business code (one row of the Stop set). It is deliberately maintained **separately**
 * from TERMINAL_RATE_LIMIT_MAPPING in failure-provider-business-codes.ts: that table decides that the
 * main conversation does not retry automatically, this one decides that a workflow stops and waits for
 * the quota to reset / be recharged. 1005 is invalid_request in the classifier, so here the quota
 * check has to be decided by code first, and only then by reason.
 */
export const WORKFLOW_QUOTA_PROVIDER_CODES: ReadonlySet<string> = new Set([
  "1005",
  "1308",
  "1310",
  "1313",
  "1316",
  "1317",
  "1318",
  "1319",
  "1320",
  "1321",
  "2056",
  "20097",
  "insufficient_quota",
  "credit_balance_exhausted",
  "organization_spend_limit_exceeded",
  "project_spend_limit_exceeded",
  "organization_usage_limit_exceeded",
  "exceeded_current_quota_error",
]);

/** The family of ModelErrorCode meaning "the provider is not configured / the selection is invalid" (reason is not necessarily provider_not_configured). */
const NOT_CONFIGURED_ERROR_CODES: ReadonlySet<string> = new Set([
  ModelErrorCode.ProviderNotFound,
  ModelErrorCode.ProviderNotConfigured,
  ModelErrorCode.ModelConfigMissing,
  ModelErrorCode.InvalidModelSelection,
  ModelErrorCode.ModelRequestAuthMissing,
]);

export type WorkflowModelFailurePolicy =
  | { decision: "retry" }
  | { decision: "stop"; kind: WorkflowProviderStopKind }
  /** core only routes an already-compressed failure here: the node failed with `ContextLimit`, the script can catch it, and if uncaught the node is errored. */
  | { decision: "context_exceeded" }
  | { decision: "cancelled" };

/**
 * The policy table itself. Its input is the classifier's result (reading only code / reason / retryable)
 * plus the provider business code. The order matters: cancellation comes first (it is not an error);
 * quota is decided by **code**, ahead of reason (1005's reason is invalid_request); the rest are
 * decided by reason / code; anything outside the table = retry.
 */
export function resolveWorkflowModelFailurePolicy(
  failure: Pick<ClassifiedModelFailure, "code" | "reason" | "retryable">,
  providerCode: string | undefined,
): WorkflowModelFailurePolicy {
  if (failure.reason === ModelFailureReason.Cancelled) return { decision: "cancelled" };
  if (providerCode !== undefined && WORKFLOW_QUOTA_PROVIDER_CODES.has(providerCode)) {
    return { decision: "stop", kind: "quota" };
  }
  if (failure.reason === ModelFailureReason.AuthFailed) return { decision: "stop", kind: "auth" };
  if (
    failure.reason === ModelFailureReason.ProviderNotConfigured ||
    NOT_CONFIGURED_ERROR_CODES.has(failure.code)
  ) {
    return { decision: "stop", kind: "not_configured" };
  }
  if (failure.code === ModelErrorCode.ModelNotFound) {
    return { decision: "stop", kind: "model_unavailable" };
  }
  if (failure.reason === ModelFailureReason.ContextExceeded)
    return { decision: "context_exceeded" };
  // "Invalid request" only recognizes the provider's rejection of the request (3001, HTTP 400/422). `invalid_model_response`
  // It was also marked as invalid_request by the classifier, but that was a **response** parsing failure - it's probably better to ask again and return it to retry.
  if (
    failure.reason === ModelFailureReason.InvalidRequest &&
    failure.code !== ModelErrorCode.InvalidModelResponse
  ) {
    return { decision: "stop", kind: "invalid_request" };
  }
  return { decision: "retry" };
}

/**
 * The replacement point for the runner's retry gate: a bounded budget keeps reading the classifier's
 * `retryable` (not a single word changes for the main conversation); an unbounded budget (workflow
 * traffic) reads the policy table instead — `retry` means retryable, `stop` / `context_exceeded` do not retry.
 * Cancellation is short-circuited separately by the caller before this point (both runners already do that).
 */
export function retryAllowedByFailurePolicy(
  failure: ClassifiedModelFailure,
  retryBudget: ModelRetryBudget | undefined,
  providerCode: string | undefined,
): boolean {
  if (!isUnboundedRetryBudget(retryBudget)) return isRetryableFailure(failure);
  return resolveWorkflowModelFailurePolicy(failure, providerCode).decision === "retry";
}

/** The facts the driver reads out of an adapter error: the policy verdict plus the fields `ProviderStopDetails` is built from. */
export interface WorkflowModelFailureInspection {
  policy: WorkflowModelFailurePolicy;
  /** A value of contracts `ModelFailureReason`. */
  reason: string;
  providerCode?: string;
  providerId?: string;
  modelId?: string;
  /** The message of the adapter error (under a mapped business code it is the provider's original text). */
  rawMessage?: string;
  /** The reset moment for a quota-class failure when the provider supplied Retry-After (epoch ms). */
  resetAt?: number;
}

/**
 * Read an adapter error **by shape** (`AiSdkModelAdapterError`: `name` + `context.reason` …), either
 * directly or one `cause` level down; two class definitions may exist between bootstrap and adapters
 * (the dist boundary), but the shape will not drift.
 * Returns undefined when it is not a model-layer error (the driver classifies it as a DriverError as before).
 */
export function inspectWorkflowModelFailure(
  error: unknown,
): WorkflowModelFailureInspection | undefined {
  const direct = readAdapterError(error);
  const found =
    direct ?? readAdapterError((error as { cause?: unknown } | undefined)?.cause ?? undefined);
  if (found === undefined) return undefined;
  const { context, code, message } = found;
  const reason = stringValue(context.reason);
  if (reason === undefined) return undefined;
  const providerCode = codeValue(context.providerCode);
  const policy = resolveWorkflowModelFailurePolicy(
    {
      code: code as ClassifiedModelFailure["code"],
      reason: reason as ClassifiedModelFailure["reason"],
      retryable: context.retryable === true,
    },
    providerCode,
  );
  const retryAfterMs = context.retryAfterMs;
  const inspection: WorkflowModelFailureInspection = { policy, reason };
  if (providerCode !== undefined) inspection.providerCode = providerCode;
  const providerId = stringValue(context.providerId);
  if (providerId !== undefined) inspection.providerId = providerId;
  const modelId = stringValue(context.modelId);
  if (modelId !== undefined) inspection.modelId = modelId;
  if (message.length > 0) inspection.rawMessage = message;
  if (
    policy.decision === "stop" &&
    policy.kind === "quota" &&
    typeof retryAfterMs === "number" &&
    Number.isFinite(retryAfterMs) &&
    retryAfterMs > 0
  ) {
    inspection.resetAt = Date.now() + retryAfterMs;
  }
  return inspection;
}

function readAdapterError(
  error: unknown,
): { context: Record<string, unknown>; code: string; message: string } | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const candidate = error as {
    name?: unknown;
    code?: unknown;
    context?: unknown;
    message?: unknown;
  };
  if (candidate.name !== "AiSdkModelAdapterError") return undefined;
  const context =
    typeof candidate.context === "object" && candidate.context !== null
      ? (candidate.context as Record<string, unknown>)
      : {};
  return {
    context,
    code: typeof candidate.code === "string" ? candidate.code : "",
    message: typeof candidate.message === "string" ? candidate.message : "",
  };
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** A provider business code may be a number (verbatim from the response body) or a string; normalize it to a string key. */
function codeValue(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return String(Math.trunc(value));
  return stringValue(value);
}
