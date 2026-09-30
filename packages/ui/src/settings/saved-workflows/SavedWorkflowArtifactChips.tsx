import { TID_WORKFLOW_ARTIFACT_CHIP, type ZCodeSavedWorkflowRun } from "@zcode/shared";
import type { ArtifactPillSize } from "@/components/workflow-timeline/WorkflowArtifactPill.js";
import { WorkflowArtifactStrip } from "@/components/workflow-timeline/WorkflowArtifactStrip.js";

/**
 * The artifact strip in the hub: a small pill after the status word of a run history row, regular
 * size for the detail page header's "recent artifacts" strip.
 *
 * ⚠ Terminology: artifact = what a script publishes for the user to look at through `artifact.*`.
 *
 * It is the **same** component as the one in notification rows and the artifact strip under the
 * timeline — one and the same artifact must look the same in all four places. The payload types
 * (legacy `workflows/runs` rows) and v4 notification meta differ, but both sides have the four
 * fields (id / kind / title / version), and the strip reads only those four.
 */
export function SavedWorkflowArtifactChips({
  artifacts,
  onOpenArtifact,
  className,
  size = "sm",
}: {
  artifacts: NonNullable<ZCodeSavedWorkflowRun["artifacts"]>;
  /**
   * Absent means the pill is disabled (an old row has no `parentSessionId`, or the host injected no
   * open capability).
   */
  onOpenArtifact?: (artifactId: string) => void;
  size?: ArtifactPillSize;
  className?: string;
}) {
  return (
    <WorkflowArtifactStrip
      artifacts={artifacts}
      moreTestId="workflow-run-artifact-chips-more"
      pillTestId={TID_WORKFLOW_ARTIFACT_CHIP}
      size={size}
      testId="workflow-run-artifact-chips"
      {...(className === undefined ? {} : { className })}
      {...(onOpenArtifact === undefined ? {} : { onOpenArtifact })}
    />
  );
}
