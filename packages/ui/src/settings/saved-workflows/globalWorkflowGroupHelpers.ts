// Pure logic for global workflow groups. Split files with components to hold max-lines 400,
// It is also convenient for single testing of these judgments without React.
import { resolveWorkspaceKey, type ZCodeSavedWorkflowRun } from "@zcode/shared";
import type { ZCodeAgentSavedWorkflowTarget } from "@zcode/services";
import type { AutomationWorkspaceOption } from "@/settings/automationWorkspaceOptions.js";
import type { SavedWorkflowProjectTarget } from "@/settings/saved-workflows/savedWorkflowContract.js";
import type { SavedWorkflowRunProject } from "@/settings/saved-workflows/SavedWorkflowRunHistoryPanel.js";

/**
 * RPC carrier constant for the global tier: no workspace, so the services layer picks the local
 * runtime itself.
 */
export const GLOBAL_SAVED_WORKFLOW_TARGET: ZCodeAgentSavedWorkflowTarget = { scope: "global" };

/**
 * Takes the last path segment (across `/` and `\\`), serving as a fallback label for run rows of
 * projects that are not open.
 */
function basenameOfPath(path: string): string {
  return (
    path
      .replace(/[\\/]+$/u, "")
      .split(/[\\/]/u)
      .filter(Boolean)
      .pop() ?? path
  );
}

/**
 * Landing spot for "Revise" / "Create via conversation": the active local project, or the first
 * local project when it is not among the candidates; null when there is neither.
 */
export function resolveGlobalActionTarget(
  localProjects: readonly AutomationWorkspaceOption[],
  activeProjectKey: string | null,
): SavedWorkflowProjectTarget | null {
  const active = localProjects.find((project) => resolveWorkspaceKey(project) === activeProjectKey);
  const target = active ?? localProjects[0];
  if (!target) return null;
  return {
    workspacePath: target.workspacePath,
    ...(target.workspaceIdentity ? { workspaceIdentity: target.workspaceIdentity } : {}),
  };
}

/** Which open local project a run row's cwd hits (compared literally as absolute paths). */
export function findProjectByCwd(
  localProjects: readonly AutomationWorkspaceOption[],
  cwd: string | undefined,
): AutomationWorkspaceOption | null {
  if (!cwd) return null;
  return localProjects.find((project) => project.workspacePath === cwd) ?? null;
}

/**
 * The project column of each row in the detail page's run history (the global tier spans cwds):
 * when the cwd hits an open project → that project's label plus an available "View instances";
 * otherwise fall back to `basename(cwd)`, put the full path in the title, and do not offer "View
 * instances"; old rows with no cwd draw no project column.
 */
export function buildGlobalRunProjectResolver(
  localProjects: readonly AutomationWorkspaceOption[],
): (run: ZCodeSavedWorkflowRun) => SavedWorkflowRunProject | null {
  return (run) => {
    if (!run.cwd) return null;
    const project = findProjectByCwd(localProjects, run.cwd);
    if (project) {
      return { label: project.label, title: run.cwd, canOpen: true };
    }
    return { label: basenameOfPath(run.cwd), title: run.cwd, canOpen: false };
  };
}
