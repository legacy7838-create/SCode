import type {
  Logger,
  WorkspaceHookBundleSnapshot,
  WorkspaceHookReasonCode,
  WorkspaceHookSecurityRevision,
} from "@zcode/contracts";
import type { WorkspaceHookTrustCoordinator } from "./workspace-hook-trust-coordinator.js";
import {
  emitWorkspaceHookTelemetry,
  type WorkspaceHookTelemetryEvent,
  type WorkspaceHookTelemetryFields,
} from "./workspace-hook-telemetry.js";
import type { WorkspaceHookSnapshotEvaluation } from "./workspace-hook-trust-types.js";

export type WorkspaceHookActivationSource = "startup" | "resume" | "clear" | "compact";

export interface WorkspaceHookDispatchInput {
  /** Compatibility assertion for callers that hold a bundle target. Runtime registrations omit it. */
  bundleDigest?: string;
  hookDeclarationDigest: string;
  reviewItemId: string;
}

export type WorkspaceHookDispatchDecision =
  | { allowed: true }
  | {
      allowed: false;
      reasonCode: WorkspaceHookReasonCode;
      skipLifecycle?: boolean;
    };

// Soft access control: After the access layer completes the evaluation, it reports the pending status through this port.
// pendingCount = configuredEnabled && admissionClass === Number of claims "pending".
// pendingCount === 0 must also be reported (for the projection layer to clear the prompt bar).
export interface WorkspaceHookAdmissionState {
  pendingCount: number;
  bundleDigest: string;
  workspaceIdentity?: string;
}

export type WorkspaceHookAdmissionStateCallback = (state: WorkspaceHookAdmissionState) => void;

export interface WorkspaceHookRuntimeAdmissionPort {
  activate(source: WorkspaceHookActivationSource, signal?: AbortSignal): Promise<void>;
  evaluateDispatch(input: WorkspaceHookDispatchInput): WorkspaceHookDispatchDecision;
  getCurrentSnapshot(): WorkspaceHookBundleSnapshot;
  replaceSnapshot(snapshot: WorkspaceHookBundleSnapshot): void;
  invalidate(reasonCode: WorkspaceHookReasonCode): void;
}

export interface WorkspaceHookRuntimeAdmissionOptions {
  coordinator: WorkspaceHookTrustCoordinator;
  enabled?: boolean;
  logger?: Logger;
  ready: Promise<void>;
  /** Soft access control: activate() calls back after completing the evaluation and reports the pending status */
  onAdmissionStateChanged?: WorkspaceHookAdmissionStateCallback;
  snapshot: WorkspaceHookBundleSnapshot;
}

export class WorkspaceHookRuntimeAdmission implements WorkspaceHookRuntimeAdmissionPort {
  private readonly coordinator: WorkspaceHookTrustCoordinator;
  private readonly enabled: boolean;
  private readonly logger?: Logger;
  private readonly ready: Promise<void>;
  private readonly onAdmissionStateChanged?: WorkspaceHookAdmissionStateCallback;
  private snapshot: WorkspaceHookBundleSnapshot;
  private readonly entriesByReviewItemId = new Map<string, string>();
  private evaluation?: WorkspaceHookSnapshotEvaluation;
  private validatedRevision?: WorkspaceHookSecurityRevision;
  private invalidatedReason?: WorkspaceHookReasonCode;
  private readonly emittedTelemetry = new Set<string>();
  private activated = false;
  private bootstrapFailed = false;

  constructor(options: WorkspaceHookRuntimeAdmissionOptions) {
    this.coordinator = options.coordinator;
    this.enabled = options.enabled ?? true;
    this.logger = options.logger;
    this.ready = options.ready;
    this.onAdmissionStateChanged = options.onAdmissionStateChanged;
    this.snapshot = options.snapshot;
    this.indexSnapshot(options.snapshot);
  }

  async activate(source: WorkspaceHookActivationSource, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    if (!this.enabled) {
      if (!this.activated) {
        this.activated = true;
        this.emitTelemetryOnce("workspace_hook.feature_disabled", {
          workspaceIdentity: this.snapshot.workspaceIdentity,
          reasonCode: "workspace_hooks_feature_disabled",
          source,
        });
        // When the function is turned off, pendingCount = 0, and the clearing status is reported.
        this.emitAdmissionState();
      }
      return;
    }
    if (!this.activated) {
      try {
        await waitForWorkspaceHookAdmission(this.ready, signal);
      } catch (error) {
        if (signal?.aborted) throw signal.reason ?? error;
        // Trust store bootstrap failure cannot expand the execution surface; the main task and other source Hooks can still continue.
        this.bootstrapFailed = true;
      }
      this.activated = true;
    }
    this.safeRefreshEvaluation();
    // Soft access control: without waiting for review, directly report pending status for projection layer/use
    this.emitAdmissionState();
  }

  evaluateDispatch(input: WorkspaceHookDispatchInput): WorkspaceHookDispatchDecision {
    if (!this.matchesSnapshot(input)) {
      this.emitTelemetryOnce("workspace_hook.snapshot_mismatch", {
        workspaceIdentity: this.snapshot.workspaceIdentity,
        reasonCode: "workspace_hooks_snapshot_mismatch",
        bundleDigest: input.bundleDigest,
        declarationDigest: input.hookDeclarationDigest,
      });
      return {
        allowed: false,
        reasonCode: "workspace_hooks_snapshot_mismatch",
      };
    }
    if (this.invalidatedReason) {
      return { allowed: false, reasonCode: this.invalidatedReason };
    }
    if (!this.activated) {
      return { allowed: false, reasonCode: "workspace_hooks_pending_trust" };
    }
    if (!this.enabled) {
      return { allowed: false, reasonCode: "workspace_hooks_feature_disabled" };
    }
    if (this.bootstrapFailed) {
      this.emitTelemetryOnce("workspace_hook.trust_store_failure", {
        workspaceIdentity: this.snapshot.workspaceIdentity,
        reasonCode: "workspace_hooks_trust_store_corrupt",
      });
      return {
        allowed: false,
        reasonCode: "workspace_hooks_trust_store_corrupt",
      };
    }
    if (
      !this.validatedRevision ||
      !this.coordinator.validateSecurityRevision(
        this.snapshot.workspaceIdentity,
        this.validatedRevision,
      )
    ) {
      // Lazy refresh only updated evaluation and missed admission status - external writing to Trust store
      // (such as Settings pretrust) After bump revision, banner pendingCount stays at the old value until the next
      // activate. It must be resent after refreshing (pendingCount === 0 will also be sent, used to clear the prompt bar).
      this.refreshEvaluation();
      this.emitAdmissionState();
    }
    const item = this.evaluation?.items.find(
      (candidate) => candidate.reviewItemId === input.reviewItemId,
    );
    if (!item || item.hookDeclarationDigest !== input.hookDeclarationDigest) {
      this.emitTelemetryOnce("workspace_hook.snapshot_mismatch", {
        workspaceIdentity: this.snapshot.workspaceIdentity,
        bundleDigest: this.snapshot.bundleDigest,
        declarationDigest: input.hookDeclarationDigest,
        reasonCode: "workspace_hooks_snapshot_mismatch",
      });
      return {
        allowed: false,
        reasonCode: "workspace_hooks_snapshot_mismatch",
      };
    }
    if (item.effectiveRunnable) return { allowed: true };
    const reasonCode = item.reasonCode ?? "workspace_hooks_blocked_untrusted";
    if (reasonCode === "workspace_hooks_blocked_by_policy") {
      this.emitTelemetryOnce("workspace_hook.policy_blocked", {
        workspaceIdentity: this.snapshot.workspaceIdentity,
        bundleDigest: this.snapshot.bundleDigest,
        declarationDigest: item.hookDeclarationDigest,
        reasonCode,
      });
    }
    return {
      allowed: false,
      reasonCode,
      ...(!item.configuredEnabled ? { skipLifecycle: true } : {}),
    };
  }

  getCurrentSnapshot(): WorkspaceHookBundleSnapshot {
    return this.snapshot;
  }

  replaceSnapshot(snapshot: WorkspaceHookBundleSnapshot): void {
    if (snapshot.workspaceIdentity !== this.snapshot.workspaceIdentity) {
      // Invariant: The caller can only replace the current snapshot with a snapshot of the same workspaceIdentity. across identities
      // The substitution means that the caller confused the workspace boundaries - this is a programming error rather than a runtime condition, so the error is thrown
      // Instead of silent no-op or returning soft results (fail-loud). The caller must:
      //   1. Complete its own write submission before calling (this runtime does not roll back external writes);
      //   2. Wrap this call with try/catch - the thrown exception must not bubble up to the turn level.
      // The only current caller: the toggle path of workspace-hook-review-controller.ts,
      // Its writeCommitted logic already meets the above conditions. The new caller must handle this exception separately at the call point.
      throw new Error("Cannot replace a Workspace Hook snapshot across workspace identities");
    }
    this.snapshot = snapshot;
    this.entriesByReviewItemId.clear();
    this.indexSnapshot(snapshot);
    this.evaluation = undefined;
    this.validatedRevision = undefined;
    this.invalidatedReason = undefined;
    if (this.activated) {
      this.refreshEvaluation();
      this.emitAdmissionState();
    }
  }

  invalidate(reasonCode: WorkspaceHookReasonCode): void {
    this.invalidatedReason = reasonCode;
    this.evaluation = undefined;
    this.validatedRevision = undefined;
  }

  private indexSnapshot(snapshot: WorkspaceHookBundleSnapshot): void {
    for (const entry of snapshot.hooks) {
      this.entriesByReviewItemId.set(entry.reviewItemId, entry.hookDeclarationDigest);
    }
  }

  private matchesSnapshot(input: WorkspaceHookDispatchInput): boolean {
    return (
      (input.bundleDigest === undefined || input.bundleDigest === this.snapshot.bundleDigest) &&
      this.entriesByReviewItemId.get(input.reviewItemId) === input.hookDeclarationDigest
    );
  }

  // Soft access control: report pending status. pendingCount = configuredEnabled && admissionClass === "pending".
  private emitAdmissionState(): void {
    if (!this.onAdmissionStateChanged) return;
    const evaluation = this.evaluation;
    const pendingCount = evaluation
      ? evaluation.items.filter(
          (item) => item.configuredEnabled && item.admissionClass === "pending",
        ).length
      : 0;
    this.onAdmissionStateChanged({
      pendingCount,
      bundleDigest: this.snapshot.bundleDigest,
      ...(this.snapshot.workspaceIdentity
        ? { workspaceIdentity: this.snapshot.workspaceIdentity }
        : {}),
    });
  }

  private emitTelemetryOnce(
    event: WorkspaceHookTelemetryEvent,
    fields: WorkspaceHookTelemetryFields,
  ): void {
    const key = [
      event,
      fields.reasonCode,
      fields.bundleDigest,
      fields.declarationDigest,
      fields.source,
    ].join(":");
    if (this.emittedTelemetry.has(key)) return;
    this.emittedTelemetry.add(key);
    emitWorkspaceHookTelemetry(this.logger, event, fields);
  }

  private refreshEvaluation(): void {
    if (!this.enabled || this.bootstrapFailed || this.invalidatedReason) return;
    const evaluation = this.coordinator.evaluateSnapshot({ snapshot: this.snapshot });
    this.evaluation = evaluation;
    this.validatedRevision = { ...evaluation.securityRevision };
  }

  /**
   * refreshEvaluation calls coordinator.evaluateSnapshot,
   * The latter will throw an error when the persistent state is malformed (zod parse fails). This exception cannot bubble up directly activate →
   * runSessionStartHooks → the entire turn, causing the user/plugin Hook to also fail and retry each round.
   * (The comments in the file itself also say "The main task and other source Hooks can still continue").
   *
   * Compare the evaluateDispatch path to the try/catch of resolveHookRunAdmission.
   * The activate path must also have the same background: capture post-bootstrapFailed=true——fail-closed,
   * When evaluateDispatch hits this flag, it returns workspace_hooks_trust_store_corrupt and refuses to execute.
   * refreshEvaluation itself is also short-circuited by this flag and will not be retried. turn continues to advance, non-workspace Hooks are not affected.
   */
  private safeRefreshEvaluation(): void {
    if (!this.enabled || this.bootstrapFailed || this.invalidatedReason) return;
    try {
      this.refreshEvaluation();
    } catch {
      this.bootstrapFailed = true;
      this.evaluation = undefined;
      this.validatedRevision = undefined;
    }
  }
}

function waitForWorkspaceHookAdmission<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      cleanup();
      reject(signal.reason ?? new Error("Workspace Hook admission aborted"));
    };
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    signal.addEventListener("abort", onAbort, { once: true });
    void promise.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error: unknown) => {
        cleanup();
        reject(error);
      },
    );
  });
}

export function createWorkspaceHookRuntimeAdmission(
  options: WorkspaceHookRuntimeAdmissionOptions,
): WorkspaceHookRuntimeAdmission {
  return new WorkspaceHookRuntimeAdmission(options);
}
