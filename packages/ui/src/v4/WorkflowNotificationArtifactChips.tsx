import { TID_CHAT_WORKFLOW_ARTIFACT_CHIP } from "@zcode/shared";
import type { WorkflowNotificationMeta } from "@zcode/shared/zcode-protocol-v4";
import { WorkflowArtifactStrip } from "@/components/workflow-timeline/WorkflowArtifactStrip.js";

/**
 * The artifact strip at the tail of a terminal-state notification's collapsible header: small
 * artifact pills, ≤ 3 of them plus `+N`.
 *
 * ⚠ Terminology: the artifacts on the strip are the outputs a script publishes for the user via
 * `artifact.*`, which are not the same thing as the `result` in the same notification (the script's
 * top-level return value).
 *
 * A missing payload (batch turns / old transcripts / old CLIs) ⇒ the whole block is absent and the
 * notification row is pixel-identical to today's. A missing callback (a cold restore that cannot
 * correlate it, a read-only session) ⇒ the pills are disabled rather than hidden: "what this run
 * delivered" is a fact, whether it can be opened is a capability. Events stop at the strip level —
 * the whole header is the collapse toggle and the pills are not part of it.
 */
export function WorkflowNotificationArtifactChips({
  artifacts,
  truncated,
  onOpenArtifact,
}: {
  artifacts: NonNullable<Extract<WorkflowNotificationMeta, { kind: "terminal" }>["artifacts"]>;
  /**
   * The emitting side was cut down (over 8, or filtered) — so "+N" may under-report; use "…" rather
   * than a number.
   */
  truncated?: boolean;
  onOpenArtifact?: (artifactId: string) => void;
}) {
  return (
    <WorkflowArtifactStrip
      artifacts={artifacts}
      moreTestId="workflow-notification-artifacts-more"
      pillTestId={TID_CHAT_WORKFLOW_ARTIFACT_CHIP}
      size="sm"
      variant="link"
      testId="workflow-notification-artifacts"
      {...(truncated === undefined ? {} : { truncated })}
      {...(onOpenArtifact === undefined ? {} : { onOpenArtifact })}
    />
  );
}
