// Cross-component type contracts for saved workflow hubs.
// Separate files to avoid the loop caused by mutual import between page (Section) and project group (Group).

/**
 * The coordinates of the project a workflow belongs to: used both when sending to a conversation
 * (run / revise / create) and when opening an instance, and never taken from the active project.
 */
export type SavedWorkflowProjectTarget = {
  workspacePath: string;
  workspaceIdentity?: string;
};

/**
 * Run history "View instance": switch to the session that started it and open the instance detail
 * page; the page lists all projects, so it must carry the owning workspace.
 */
export interface SavedWorkflowsOpenRunParams {
  sessionId: string;
  runId: string;
  toolCallId: string;
  workflowName: string;
  workspacePath: string;
  workspaceIdentity?: string;
}

/**
 * Artifact chip in the hub → `workflow-artifact` tab.
 *
 * ⚠ Terminology: artifact = an output a script publishes to the user through `artifact.*`.
 *
 * It carries **one `toolCallId` less** than {@link SavedWorkflowsOpenRunParams}: the artifact tab
 * does not draw the causal graph, so it does not have to go back to that CreateWorkflow tool row.
 * The gate is therefore just `parentSessionId` being present.
 */
export interface SavedWorkflowsOpenArtifactParams {
  sessionId: string;
  runId: string;
  artifactId: string;
  title?: string;
  /**
   * The latest contentType (carried by the chip payload of a run history row). The terminal's
   * `handleOpenWorkflowArtifact` uses it to decide whether an html artifact opens a browser tab
   * directly or opens the artifact tab; when absent (older rows carry no artifact manifest) it
   * opens the artifact tab.
   */
  contentType?: string;
  workspacePath: string;
  workspaceIdentity?: string;
}

/**
 * A group reports its own loading state back to the page; the page uses it to compute the total
 * count, the empty state, and the first-screen spinner.
 */
export interface SavedWorkflowGroupState {
  loaded: boolean;
  empty: boolean;
  /**
   * The number of valid workflows in this group (0 before it loads); the page sums the loaded
   * groups to get the total shown next to the title.
   */
  count: number;
}

/**
 * The two modes of a group: list / single workflow detail. Shared by project groups and the global
 * group.
 */
export type SavedWorkflowGroupMode = { kind: "list" } | { kind: "detail"; name: string };
