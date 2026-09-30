import { SessionEventType } from "@zcode/contracts";
import type { WorkspaceHookReviewFlow, WorkspaceHookReviewFlowRegistry } from "@zcode/core";
import type { WorkspaceHookReviewHostPort } from "./workspace-hook-review-types.js";
import type { WorkspaceHookReviewTelemetry } from "./workspace-hook-review-telemetry.js";

/**
 * Supervise a review flow until it terminates: follow the supersede chain, and on timeout backfill
 * telemetry and ReviewSettled.
 *
 * This logic is the **only** place that awaits flow.result: when nobody awaits it, once its 10-minute deadline expires it silently settles as timed_out inside the registry,
 * the frontend receives no ReviewSettled, the panel keeps rendering it as pending,
 * and every later click is then rejected by registry.validate as workspace_hooks_review_superseded
 * (measured: 9 consecutive clicks, all rejected, with no automatic reopen).
 *
 * Factored into its own module so that requestReview and the reopen-after-revoke path can share it: every entry point that opens a flow must
 * hand it over to this supervisor, otherwise the same unattended orphan flows are produced.
 */
export async function superviseWorkspaceHookReviewFlow(input: {
  flow: WorkspaceHookReviewFlow;
  host: WorkspaceHookReviewHostPort;
  registry: WorkspaceHookReviewFlowRegistry;
  sessionId: string;
  telemetry: WorkspaceHookReviewTelemetry;
}): Promise<void> {
  let flow = input.flow;
  while (true) {
    const outcome = await flow.result;
    if (outcome.reasonCode === "workspace_hooks_review_superseded") {
      const current = input.registry.getCurrentFlow(input.sessionId);
      if (!current || current === flow) return;
      flow = current;
      continue;
    }
    if (outcome.reasonCode === "workspace_hooks_interaction_timeout") {
      input.telemetry.timeout(flow.request);
      await input.host.emit({
        type: SessionEventType.WorkspaceHookReviewSettled,
        payload: {
          interactionId: flow.request.interactionId,
          state: "timed_out",
          reasonCode: outcome.reasonCode,
        },
      });
    }
    return;
  }
}
