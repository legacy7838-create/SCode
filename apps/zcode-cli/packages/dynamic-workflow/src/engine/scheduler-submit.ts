/**
 * scheduler.ts has hit oxlint's max-lines limit (400 lines), so Boundary B's two upward reports
 * (a submit_result arriving, a turn ending) plus their repair / nudge budgets and the submit normalization are split into this file;
 * the public surface is still exported from scheduler.ts.
 *
 * The free functions reach the scheduler's live node table and its two settlement entry points through the {@link SubmitSeam}; submitAttempted / turnEnded on
 * AskScheduler are only thin delegations.
 */

import type { AskNode, SchedulerHost } from "./scheduler-types.js";
import type { InstanceRef, Violation } from "./types.js";
import { REPAIR_ATTEMPTS, WorkflowError } from "./types.js";

/** The minimal seam the scheduler exposes to report handling: look up a live node, settle it by result. */
export interface SubmitSeam {
  readonly host: SchedulerHost;
  /** Looks up a live node by instance (one that has already left liveNodes returns undefined). */
  liveNode(instance: InstanceRef): AskNode | undefined;
  settleOk(node: AskNode, artifact: unknown): void;
  settleFailed(node: AskNode, error: WorkflowError): void;
}

export function handleSubmitAttempted(
  seam: SubmitSeam,
  instance: InstanceRef,
  payload: unknown,
): void {
  const node = seam.liveNode(instance);
  if (node === undefined || node.settled) return;
  // untyped ask does not provide a submit_result; even if it is received, it will not be settled against it.
  if (!node.spec.typed) return;

  const { value, violations } = normalizeSubmit(seam.host, node.spec.schema, payload);
  if (violations.length === 0) {
    seam.host.driver.respondToSubmit(instance, { kind: "accept" });
    seam.settleOk(node, value);
    return;
  }
  if (node.repairsRemaining > 0) {
    node.repairsRemaining--;
    const attempt = REPAIR_ATTEMPTS - node.repairsRemaining;
    seam.host.driver.respondToSubmit(instance, { kind: "reject", violations });
    seam.host.record({ type: "node-repairing", instance, attempt, violations });
    return;
  }
  seam.host.driver.cancelAsk(instance);
  seam.settleFailed(
    node,
    new WorkflowError(
      "ValidationFailed",
      "submit_result failed schema validation repeatedly and the repair budget is exhausted.",
      { violations },
    ),
  );
}

/**
 * Lenient normalization of the submit payload: validate the raw value first; only when the raw value fails **and** it is a string, do one JSON.parse
 * and validate again, and on success take the parsed value (it is what gets returned **and** journaled).
 *
 * Found in practice (GLM-5.3 through the Anthropic-compatible endpoint): a real model often serializes the `result` argument of submit_result into a
 * JSON string (such as `"{\"title\":...}"`) instead of a JSON object, so the validator correctly reports "expected object, got string" and, after 3 repairs,
 * the run fails. The parseStructuredResponse of the legacy script-workflow tolerated this long ago with lenient JSON parsing;
 * the same tolerance is added here, but schema-aware:
 *   1. The raw value passes as-is → use the raw value, never parse (this preserves legal string results, such as a `string | null` schema, where `"42"` must stay `"42"`).
 *   2. The raw value fails and is a string → one JSON.parse (not recursive, not double-parsed, following the legacy single-extraction precedent) and then validate; if it passes, take the parsed value.
 *   3. Otherwise → fall back to the raw value + the original violation and hand it to the model for repair.
 * The engine is a pure package, JSON.parse is purely deterministic and does no I/O, so it is safe to put it here.
 */
function normalizeSubmit(
  host: SchedulerHost,
  schema: unknown,
  payload: unknown,
): { value: unknown; violations: Violation[] } {
  const direct = host.validate(schema, payload);
  if (direct.length === 0) return { value: payload, violations: [] };
  if (typeof payload === "string") {
    try {
      const parsed = JSON.parse(payload);
      const after = host.validate(schema, parsed);
      if (after.length === 0) return { value: parsed, violations: [] };
      // Bug: The parsing is successful but the parsed value is still not out of date. It was reported before parsing.
      // `direct` violation ("$: expected object, got string"), the model is actually facing a decoded object, and there is no way to fix it.
      // It can only be repeatedly requoted/double-encoded/degenerated into "{}", exhausting the repair budget. Repair violations must describe the values that the model can modify,
      // Therefore, `after` (path-level violation on the object after parsing) is returned here, and the single parsing contract remains unchanged.
      return { value: parsed, violations: after };
    } catch {
      // Non-JSON string: JSON.parse throws, falling back to the original value is a violation, and the model is repaired.
    }
  }
  return { value: payload, violations: direct };
}

export function handleTurnEnded(seam: SubmitSeam, instance: InstanceRef, finalText: string): void {
  const node = seam.liveNode(instance);
  if (node === undefined || node.settled) return;
  if (!node.spec.typed) {
    seam.settleOk(node, finalText);
    return;
  }
  if (node.nudgesRemaining > 0) {
    node.nudgesRemaining--;
    seam.host.driver.respondToSubmit(instance, { kind: "nudge" });
    seam.host.record({ type: "node-nudged", instance });
    return;
  }
  seam.host.driver.cancelAsk(instance);
  seam.settleFailed(
    node,
    new WorkflowError(
      "ResultNotSubmitted",
      "The typed ask ended without a submit_result call, so there is no result.",
      { finalText },
    ),
  );
}
