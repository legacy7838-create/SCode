import { useCallback } from "react";
import type { ZCodeSavedWorkflowRun } from "@zcode/shared";
import type {
  SavedWorkflowsOpenArtifactParams,
  SavedWorkflowsOpenRunParams,
} from "@/settings/saved-workflows/savedWorkflowContract.js";

/**
 * The project a run-history row belongs to (constant in the project tab; in the global tab it is
 * looked up from `run.cwd`).
 */
interface SavedWorkflowRunOpenTarget {
  workspacePath: string;
  workspaceIdentity?: string;
}

/**
 * The two "open" doors on a run-history row in the hub, and how their arguments are built.
 *
 * ⚠ Terminology: an artifact here is an output a script published for the user to see through
 * `artifact.*`, not the script's top-level return value.
 *
 * Extracted into a hook instead of being written once in each of the two groups: the only
 * difference between the project tab and the global tab is **how the target project is computed**
 * (constant in the former, looked up from `run.cwd` against the opened projects in the latter),
 * while the criteria for the two doors have to agree — written separately, the rule "artifacts need
 * no toolCallId" would very naturally become "same as viewing the instance" in one of them.
 *
 * ```
 *                       parentSessionId?   toolCallId?   project openable?
 *  "View instance"              required      required            required
 *  Artifact chip                required        —                 required
 * ```
 *
 * `toolCallId` exists only for the static cause graph on the run detail page (it hangs off the
 * display of that CreateWorkflow tool row). The artifact tab draws no graph, so artifacts still
 * open for old rows that lack `toolCallId`.
 */
export function useSavedWorkflowRunOpeners(options: {
  /**
   * The project this row belongs to; returning null closes both entries (in the global tab, the
   * project for the cwd is not open).
   */
  resolveTarget: (run: ZCodeSavedWorkflowRun) => SavedWorkflowRunOpenTarget | null;
  onOpenWorkflowRun?: (params: SavedWorkflowsOpenRunParams) => void;
  onOpenWorkflowArtifact?: (params: SavedWorkflowsOpenArtifactParams) => void;
}): {
  handleOpenRun: (run: ZCodeSavedWorkflowRun, workflowName: string) => void;
  handleOpenArtifact: (run: ZCodeSavedWorkflowRun, artifactId: string) => void;
} {
  const { onOpenWorkflowArtifact, onOpenWorkflowRun, resolveTarget } = options;

  const handleOpenRun = useCallback(
    (run: ZCodeSavedWorkflowRun, workflowName: string) => {
      if (!run.parentSessionId || !run.toolCallId) return;
      const target = resolveTarget(run);
      if (!target) return;
      onOpenWorkflowRun?.({
        sessionId: run.parentSessionId,
        runId: run.runId,
        toolCallId: run.toolCallId,
        workflowName,
        workspacePath: target.workspacePath,
        ...(target.workspaceIdentity ? { workspaceIdentity: target.workspaceIdentity } : {}),
      });
    },
    [onOpenWorkflowRun, resolveTarget],
  );

  const handleOpenArtifact = useCallback(
    (run: ZCodeSavedWorkflowRun, artifactId: string) => {
      if (!run.parentSessionId) return;
      const target = resolveTarget(run);
      if (!target) return;
      // chip payload on line (`ZCodeSavedWorkflowRun.artifacts`) with latest version of `contentType`:
      // In the end, it opens the html product directly into a browser tab. The entire `artifacts` of the old row are missing and one missing key is a degeneracy not an error.
      const artifact = run.artifacts?.find((candidate) => candidate.id === artifactId);
      onOpenWorkflowArtifact?.({
        sessionId: run.parentSessionId,
        runId: run.runId,
        artifactId,
        ...(artifact?.title === undefined ? {} : { title: artifact.title }),
        ...(artifact?.contentType === undefined ? {} : { contentType: artifact.contentType }),
        workspacePath: target.workspacePath,
        ...(target.workspaceIdentity ? { workspaceIdentity: target.workspaceIdentity } : {}),
      });
    },
    [onOpenWorkflowArtifact, resolveTarget],
  );

  return { handleOpenArtifact, handleOpenRun };
}
