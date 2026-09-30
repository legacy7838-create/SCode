import { createHash } from "node:crypto";
import type { Logger, WorkspaceHookReasonCode } from "@zcode/contracts";

export type WorkspaceHookTelemetryEvent =
  | "workspace_hook.feature_disabled"
  | "workspace_hook.review_request_created"
  | "workspace_hook.trust_selected"
  | "workspace_hook.review_timeout"
  | "workspace_hook.review_superseded"
  | "workspace_hook.snapshot_mismatch"
  | "workspace_hook.policy_blocked"
  | "workspace_hook.trust_store_failure"
  | "workspace_hook.toggle_failure"
  | "workspace_hook.config_rebuild_failure"
  // revoke requires special observation: when troubleshooting "panel failure after revoke", you must be able to judge from the log
  // Check whether the revocation is successful and distinguish whether the subsequent failure belongs to revocation or authorization, otherwise the positioning will be slow.
  | "workspace_hook.revoked"
  | "workspace_hook.stale_response";

export interface WorkspaceHookTelemetryFields {
  workspaceIdentity?: string;
  bundleDigest?: string;
  declarationDigest?: string;
  reasonCode?: WorkspaceHookReasonCode;
  source?: string;
  action?: string;
  generation?: number;
  /**
   * The errorMessage passed in by the caller has to be forwarded: otherwise the original error is
   * silently dropped at emit time and the log keeps only the reasonCode, so a real investigation
   * cannot locate the true cause.
   * It carries only the domain error's own short message - never the command, script contents or
   * the Trust payload.
   */
  errorMessage?: string;
  /**
   * Diagnostics for how many Trust records reached the store: when the store writes fewer than the
   * declared-and-selected set (decisionAccepted did not throw), the log cannot tell whether the
   * request carried too few items or the write stage lost records.
   *
   * requestItemCount / requestEnabledCount record how many entries the review request actually
   * carried; grantedRecordCount records how many were really written this time. If the three do
   * not line up, records were silently lost.
   */
  requestItemCount?: number;
  requestEnabledCount?: number;
  grantedRecordCount?: number;
  /** The number of declarations revoke actually revoked (kept separate from grantedRecordCount so the two meanings are not conflated). */
  revokedCount?: number;
}

const MAX_TELEMETRY_ERROR_MESSAGE_LENGTH = 300;

/**
 * Workspace Hook observability uniformly reuses the existing Logger Port. Only a stable reason,
 * the generation and a summary are sent - never the command, script contents, paths or the
 * Trust payload.
 */
export function emitWorkspaceHookTelemetry(
  logger: Logger | undefined,
  event: WorkspaceHookTelemetryEvent,
  fields: WorkspaceHookTelemetryFields = {},
): void {
  if (!logger) return;
  logger.info("Workspace Hook Trust telemetry", {
    event,
    module: "workspace_hook_trust",
    ...(fields.workspaceIdentity
      ? { workspaceIdentityDigest: workspaceIdentitySummary(fields.workspaceIdentity) }
      : {}),
    ...(fields.bundleDigest ? { bundleDigest: digestSummary(fields.bundleDigest) } : {}),
    ...(fields.declarationDigest
      ? { declarationDigest: digestSummary(fields.declarationDigest) }
      : {}),
    ...(fields.reasonCode ? { reasonCode: fields.reasonCode } : {}),
    ...(fields.source ? { source: fields.source } : {}),
    ...(fields.action ? { action: fields.action } : {}),
    ...(fields.generation === undefined ? {} : { generation: fields.generation }),
    ...(fields.errorMessage
      ? { errorMessage: fields.errorMessage.slice(0, MAX_TELEMETRY_ERROR_MESSAGE_LENGTH) }
      : {}),
    ...(fields.requestItemCount === undefined ? {} : { requestItemCount: fields.requestItemCount }),
    ...(fields.requestEnabledCount === undefined
      ? {}
      : { requestEnabledCount: fields.requestEnabledCount }),
    ...(fields.grantedRecordCount === undefined
      ? {}
      : { grantedRecordCount: fields.grantedRecordCount }),
    ...(fields.revokedCount === undefined ? {} : { revokedCount: fields.revokedCount }),
  });
}

export function digestSummary(value: string): string {
  return value.length <= 12 ? value : value.slice(0, 12);
}

/**
 * A short SHA-256 digest of the workspace identity.
 *
 * The identity in this implementation is simply the absolute path, and the plain-text requirement
 * says telemetry must not upload the full workspace path and must not record the source path, so
 * any text that is to enter telemetry (including a domain error's message) must first pass
 * through this redaction, rather than relying on downstream filtering.
 */
export function workspaceIdentitySummary(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}
