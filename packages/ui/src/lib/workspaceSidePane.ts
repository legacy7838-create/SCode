/* eslint-disable max-lines -- Side pane tab state centrally maintains the open, reuse, close, and
 * ordering rules for Browser/Git/CodeViewer/Treemapping/Whiteboard; splitting it requires migrating
 * the existing in-memory restore logic in step.
 */
import { createUuid, type BrowserTabResidencyState } from "@zcode/shared";
import { inferMediaPreview, isPptxPreviewPath, type CodeViewerSource } from "@/lib/codeViewer.js";
import { normalizeCodeViewerSource } from "@/lib/codeViewerSource.js";

export interface BrowserSidePaneTab {
  id: string;
  type: "browser";
  /** Conversation ownership frozen when the tab was opened; null means draft state. */
  ownerTaskId?: string | null;
  /** Workspace isolation key (workspaceIdentity || workspacePath). */
  workspaceKey?: string | null;
  remoteSessionId?: string | null;
  faviconUrl?: string | null;
  initialUrl?: string | null;
  /**
   * A popup triggered by an Agent-controlled page; the persistent display preferences of a human
   * browser must not be applied to it.
   */
  agentOpened?: boolean;
  openedAt?: number;
  title?: string | null;
  residency?: BrowserTabResidencyState;
  residencyGeneration?: number;
}

export type BrowserSidePaneMetadata = Partial<Pick<BrowserSidePaneTab, "faviconUrl" | "title">>;

export const BROWSER_USE_OPERATION_INDICATOR_DURATION_MS = 5_000;

export interface GitSidePaneTab {
  id: "git";
  type: "git";
  ownerTaskId?: string | null;
  workspaceKey?: string | null;
  openedAt?: number;
}

export interface CodeViewerSidePaneTab {
  id: string;
  type: "code-viewer";
  ownerTaskId?: string | null;
  workspaceKey?: string | null;
  openedAt?: number;
  source: CodeViewerSource;
  sourceKey: string | null;
}

export type TreemappingSidePaneSource =
  | { kind: "current" }
  | { kind: "message"; messageId: string; turnIndex?: number };

export interface TreemappingSidePaneTab {
  id: "treemapping";
  type: "treemapping";
  ownerTaskId?: string | null;
  workspaceKey?: string | null;
  openedAt?: number;
  source?: TreemappingSidePaneSource;
}

export interface WhiteboardSidePaneTab {
  id: string;
  type: "whiteboard";
  ownerTaskId?: string | null;
  workspaceKey?: string | null;
  boardId: string;
  openedAt?: number;
  title: string;
}

export interface ModelTrajectorySidePaneTab {
  id: string;
  type: "model-trajectory";
  ownerTaskId?: string | null;
  workspaceKey?: string | null;
  openedAt?: number;
  /** Target task/session id; model-io matches on that id. */
  taskId: string;
  title?: string | null;
}

export interface DeveloperToolsSidePaneTab {
  id: "developer-tools";
  type: "developer-tools";
  ownerTaskId?: string | null;
  workspaceKey?: string | null;
  openedAt?: number;
}

export interface TerminalSidePaneTab {
  id: string;
  type: "terminal";
  ownerTaskId?: string | null;
  workspaceKey?: string | null;
  openedAt?: number;
  title: string;
  cwd?: string;
  remoteSessionId?: string | null;
}

/** The browser-use controlled browser view (renderer `<webview>` + main CDP). */
export interface BrowserUseSidePaneTab {
  id: string;
  type: "browser-use";
  ownerTaskId?: string | null;
  workspaceKey?: string | null;
  remoteSessionId?: string | null;
  sessionId: string;
  /** The opaque IAB tab identity assigned by main, which is also the webview attach key. */
  tabId: string;
  browserId?: string;
  browserGeneration?: number;
  openedAt?: number;
  title?: string | null;
  faviconUrl?: string | null;
  residency?: BrowserTabResidencyState;
  residencyGeneration?: number;
  /** The UI indication deadline of the most recent agent browser-use operation. */
  browserUseOperationUntil?: number;
  /**
   * The monotonic version of the model layout command; the target view rebuilds its ResizeObserver
   * baseline from it.
   */
  browserUseResizeBaselineVersion?: number;
}

export interface OpenBackgroundBashSideTabRequest {
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  rootSessionId: string;
  sessionId: string;
  workId: string;
  title: string;
}

export interface BackgroundBashSidePaneTab extends OpenBackgroundBashSideTabRequest {
  id: string;
  type: "bash-output";
  workspaceKey: string;
  ownerTaskId: string;
  openedAt?: number;
}

export interface SubagentSessionSidePaneTab {
  id: string;
  type: "subagent-session";
  ownerTaskId?: string | null;
  openedAt?: number;
  workspaceKey: string;
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  rootSessionId: string;
  parentSessionId: string;
  childSessionId: string;
  subagentType: string;
  title: string;
}

export interface SubagentDirectorySidePaneTab {
  id: string;
  type: "subagent-directory";
  ownerTaskId?: string | null;
  openedAt?: number;
  workspaceKey: string;
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  rootSessionId: string;
  parentSessionId: string;
}

export interface SelectionSideChatPaneTab {
  id: string;
  type: "selection-side-chat";
  ownerTaskId?: string | null;
  openedAt?: number;
  workspaceKey: string;
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  parentSessionId: string;
  childSessionId: string;
  ordinal: number;
}

export interface PlanDetailSidePaneTab {
  id: string;
  type: "plan-detail";
  ownerTaskId?: string | null;
  openedAt?: number;
  workspaceKey: string;
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  parentSessionId: string;
  toolCallId: string;
  markdown: string;
  planFilePath?: string;
}

export interface OpenPlanDetailSideTabRequest {
  parentSessionId: string;
  toolCallId: string;
  markdown: string;
  planFilePath?: string;
}

/**
 * The detail tab of a workflow run.
 *
 * The identity is the **run** (`runId`), not the tool call that started it: one CreateWorkflow
 * starts only one run, but the run is the key shared by the engine, the journal, and
 * `cancelBackgroundWork {workId}` (`workId ≡ taskId ≡ runId`). `toolCallId` still has to be carried
 * along — the static causal graph lives in the display of that tool call row, and the detail page
 * finds the graph by it in the parent session projection.
 *
 * ## This tab deliberately has **no GC**; do not add any
 *
 * Two reclaim rules that look natural are both wrong:
 *
 * - **Do not close it when a run is evicted by `WORKFLOW_RUNS_LIMITS.maxRuns` (8 entries).** The
 *   event log on the detail page reads the **journal**, not the `workflowRuns` projection. An
 *   evicted run loses only its live overlay state; its event log stays **complete** — which is
 *   exactly the case where a user keeps this tab around (revisiting how a finished run went).
 *   Closing it automatically means destroying by hand the only persistent view of a completed run.
 *   Eviction degrades into nothing more than the “no longer tracked live” empty state inside the
 *   detail page, and the wording must stay honest: what is lost is the live state, the run itself
 *   has not disappeared.
 * - **Do not close it on a parent session edit / retry.** The run identity does not become invalid
 *   because the conversation was rewritten; at most that tool call row is no longer in the window —
 *   which likewise degrades into “nothing to draw”, not “this tab should disappear”.
 *
 * Visibility is already narrowed by `parentSessionId` (same as plan-detail), so the tab cannot leak
 * into another conversation. The reclaiming in `syncSubagentSessionSidePaneTabs` only applies to
 * subagent-session; do not extend it here.
 */
export interface WorkflowRunSidePaneTab {
  id: string;
  type: "workflow-run";
  ownerTaskId?: string | null;
  openedAt?: number;
  workspaceKey: string;
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  parentSessionId: string;
  toolCallId: string;
  runId: string;
  /**
   * Display name frozen at open time, used only as a title fallback when the projection is absent
   * (run evicted / cold start).
   */
  workflowName?: string;
  /**
   * Landing: expand this stop, list everything, scroll the section header to the top. Absent means
   * stay where it is.
   */
  focusPhaseId?: string;
}

export interface OpenWorkflowRunSideTabRequest {
  parentSessionId: string;
  toolCallId: string;
  runId: string;
  workflowName?: string;
  /**
   * Landing: on the detail page, expand this stop, list everything, scroll to the section header.
   * Absent means stay where it is.
   */
  phaseId?: string;
  /**
   * After “Configure” is accepted the panel follows the workflow: swap the tab showing that run
   * **in place** for the new run's tab — same position, keeping its name and ownership. When no
   * such tab exists (it was closed), do nothing: the panel does not reopen for this.
   */
  replaceRunId?: string;
}

/**
 * The workflow run directory tab of one conversation.
 *
 * The identity is the **conversation** (`parentSessionId`): a conversation has only one run
 * directory, so repeated clicks on the footer row idempotently focus the same tab — structurally
 * identical to `subagent-directory`.
 *
 * This tab carries no run data at all: the directory page reads a page of journal by
 * `parentSessionId` itself (the single source of truth for the run directory). Freezing a summary
 * into the tab would make “open a restored tab after a restart” show a stale list, yet that is
 * exactly the moment this tab exists for.
 */
export interface WorkflowRunDirectorySidePaneTab {
  id: string;
  type: "workflow-directory";
  ownerTaskId?: string | null;
  openedAt?: number;
  workspaceKey: string;
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  parentSessionId: string;
}

export interface OpenWorkflowRunDirectorySideTabRequest {
  parentSessionId: string;
}

/**
 * A transcript tab of a dwf actor instance.
 *
 * The identity is the **actor session**: an instance has one real durable session, so
 * `actorSessionId` is the tab identity. `runId` / `siteId` / `ordinal` are carried along for the
 * title, search, and troubleshooting — they are the keys of the journal, while the session id is
 * minted by the run service from `(runId, actorRef)` and must not be reverse-resolved by the
 * renderer.
 *
 * ## Why a **separate type** instead of a variant flag on `subagent-session`
 *
 * `syncSubagentSessionSidePaneTabs` deletes subagent tabs whose `childSessionId` is not in
 * `validChildSessionIds`, and an actor session is **never** in that set (it is not a child session
 * of a subagent). Reusing that type means: every update of the parent session's subagent projection
 * reclaims this tab once. The only fix would be to teach that reclaiming about variant flags — the
 * same amount of work, only with the invariant hidden inside the reclaiming logic.
 *
 * Two other places would clash as well: subagent tab visibility is narrowed by `rootSessionId` (an
 * actor tab narrows by `parentSessionId`, same as workflow-run), and
 * `lastActiveSubagentTabByRootRef` remembers the active tab per `rootSessionId` — an actor tab has
 * no root session, nor should it have one.
 *
 * ## GC: same as `workflow-run`, **none**; do not add any
 *
 * An actor session keeps existing after the run ends (that is exactly the durable-audit gained by
 * persisting it to storage). Being evicted by the 8-run cap, a parent session edit/retry, and run
 * settlement — none of the three should close a transcript that is still readable. Visibility is
 * already narrowed by `parentSessionId`, so it cannot leak into another conversation either.
 */
export interface WorkflowActorSessionSidePaneTab {
  id: string;
  type: "workflow-actor-session";
  ownerTaskId?: string | null;
  openedAt?: number;
  workspaceKey: string;
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  parentSessionId: string;
  runId: string;
  /**
   * Actor session id: the session read by the nested read-only SessionPane. **May be absent** —
   * when the tab is opened from a pill that has not started yet there is no session; the panel
   * looks it up in the live projection by the slot, and finding it heals the state. The identity is
   * not here, it is in (runId, siteId, ordinal).
   */
  actorSessionId?: string;
  /**
   * Actor site id and ordinal: together with runId they are the tab identity, and never take part
   * in naming.
   */
  siteId: string;
  ordinal: number;
  /**
   * The name written in the script (`agent("reviewer")`); absent when the analysis cannot get the
   * literal, and the title falls back to a localized string.
   */
  actorName?: string;
}

export interface OpenWorkflowActorSessionSideTabRequest {
  parentSessionId: string;
  runId: string;
  /** Session id already known at open time; absent for a slot that has not started. */
  actorSessionId?: string;
  siteId: string;
  ordinal: number;
  actorName?: string;
}

export interface OpenScopedWorkflowActorSessionSideTabRequest extends OpenWorkflowActorSessionSideTabRequest {
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
}

/**
 * A **script transcript** tab of a workflow run: every call to `files.*` / `git.*` / `world.run` in
 * the script is replayed as one tool card.
 *
 * At the same logical level as an actor transcript (both answer "what a participant of the run
 * did"), but the workspace has no session, so it is its own type rather than a variant of the actor
 * tab: the panel does not embed a SessionPane, it runs two journal queries and draws the cards
 * itself. The identity is **(workspace, parent session, run)** — one tab per run, whichever site it
 * was opened from; `focusPhaseId` is only the landing spot (scroll to the first card of that stop),
 * recomputed on every open.
 *
 * GC: same as `workflow-actor-session`, **none** — journal rows keep existing after the run ends,
 * and this replay is exactly what exists for post-hoc auditing. Visibility is narrowed by
 * `parentSessionId`.
 */
export interface WorkflowWorkspaceSidePaneTab {
  id: string;
  type: "workflow-workspace";
  ownerTaskId?: string | null;
  openedAt?: number;
  workspaceKey: string;
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  parentSessionId: string;
  /**
   * Id of the tool call that started this run: the static graph (phase names, step labels) hangs
   * off that row, by the same path as for a workflow-run tab.
   */
  toolCallId: string;
  runId: string;
  /**
   * Display name frozen at open time, used only as a title fallback when the projection is absent.
   */
  workflowName?: string;
  /**
   * Landing: scroll to the first card of this stop; a stop that has not been reached yet lands at
   * the end. Absent means stay where it is.
   */
  focusPhaseId?: string;
}

export interface OpenWorkflowWorkspaceSideTabRequest {
  parentSessionId: string;
  toolCallId: string;
  runId: string;
  workflowName?: string;
  phaseId?: string;
}

export interface OpenScopedWorkflowWorkspaceSideTabRequest extends OpenWorkflowWorkspaceSideTabRequest {
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
}

/**
 * A full-size view tab of a dwf **artifact**.
 *
 * ⚠ Terminology: the artifact here is an output the script publishes to the user through
 * `artifact.*` (a file / a piece of markdown / a dashboard projected from the journal), **not** the
 * “script top-level return value” that the engine internally calls `RunSettlement.artifact`.
 *
 * The identity is **(run, artifact id)**, without a version: republishing the same artifact is a
 * new version of the same thing, so clicking it again should **focus the already open tab and move
 * it to the latest version** rather than open v1 / v2 side by side. `version` is therefore only the
 * initial landing spot at open time (neither the notification chip nor the hub chip carries a
 * version, so absent means the latest), and the version stepper in the header is the real version
 * navigation.
 *
 * ## GC: same as `workflow-run`, **none**; do not add any
 *
 * The artifact bytes are copied into the store at publish time (publishing pins them by
 * convention), so an artifact of a run that was evicted by the 8-run cap — or even of a
 * conversation rewritten end to end by an edit — is still **fully readable**, which is exactly the
 * case where a user keeps this tab around. Visibility is already narrowed by `parentSessionId`, so
 * the tab cannot leak into another conversation.
 */
export interface WorkflowArtifactSidePaneTab {
  id: string;
  type: "workflow-artifact";
  ownerTaskId?: string | null;
  openedAt?: number;
  workspaceKey: string;
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  parentSessionId: string;
  runId: string;
  /** Artifact id (a compile-time literal in the script, `[A-Za-z0-9_.-]` ≤ 64). */
  artifactId: string;
  /**
   * Initial version at open time; absent means the latest. **Not part of the tab identity** — see
   * the paragraph on the type.
   */
  version?: number;
  /**
   * Display name frozen at open time, used only as a title fallback when metadata is absent (cold
   * restore / old CLI).
   */
  title?: string;
}

export interface OpenWorkflowArtifactSideTabRequest {
  parentSessionId: string;
  runId: string;
  artifactId: string;
  version?: number;
  title?: string;
  /**
   * contentType of the latest version (carried whenever the surface summary can obtain it).
   * `useAppPanels.handleOpenWorkflowArtifact` uses it to decide whether an html artifact opens a
   * browser tab directly or an artifact tab; absent always opens an artifact tab.
   */
  contentType?: string;
  /**
   * Workspace-relative original path. Only surfaces that have already merged the journal (the run
   * side pane) can obtain it; when absent, `handleOpenWorkflowArtifact` looks it up in the journal
   * itself to fill it in — the summary deliberately does not carry it (state frame size).
   */
  sourcePath?: string;
}

export interface OpenScopedWorkflowArtifactSideTabRequest extends OpenWorkflowArtifactSideTabRequest {
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
}

export interface OpenScopedWorkflowRunSideTabRequest extends OpenWorkflowRunSideTabRequest {
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
}

export interface OpenScopedWorkflowRunDirectorySideTabRequest extends OpenWorkflowRunDirectorySideTabRequest {
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
}

export interface OpenScopedPlanDetailSideTabRequest extends OpenPlanDetailSideTabRequest {
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
}

export interface OpenSelectionSideChatRequest {
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  parentSessionId: string;
  childSessionId: string;
  /**
   * When the active child is known not to exist, the host atomically replaces the corresponding old
   * tab.
   */
  replacesChildSessionId?: string;
}

export interface OpenSubagentSideTabRequest {
  rootSessionId?: string;
  parentSessionId: string;
  childSessionId: string;
  subagentType: string;
  title: string;
}

export interface OpenSubagentDirectorySideTabRequest {
  rootSessionId?: string;
  parentSessionId: string;
}

export interface OpenScopedSubagentDirectorySideTabRequest extends OpenSubagentDirectorySideTabRequest {
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
}

export interface SyncSubagentSessionTabsRequest {
  rootSessionId: string;
  parentSessionId: string;
  validChildSessionIds: readonly string[];
}

export interface OpenScopedSubagentSideTabRequest extends OpenSubagentSideTabRequest {
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
}

export type WorkspaceSidePaneTab =
  | BackgroundBashSidePaneTab
  | BrowserSidePaneTab
  | GitSidePaneTab
  | CodeViewerSidePaneTab
  | TreemappingSidePaneTab
  | WhiteboardSidePaneTab
  | ModelTrajectorySidePaneTab
  | DeveloperToolsSidePaneTab
  | TerminalSidePaneTab
  | BrowserUseSidePaneTab
  | SubagentSessionSidePaneTab
  | SubagentDirectorySidePaneTab
  | SelectionSideChatPaneTab
  | PlanDetailSidePaneTab
  | WorkflowRunSidePaneTab
  | WorkflowRunDirectorySidePaneTab
  | WorkflowActorSessionSidePaneTab
  | WorkflowWorkspaceSidePaneTab
  | WorkflowArtifactSidePaneTab;

/**
 * The page and CDP lifecycle of Browser/browser-use depends on the `<webview>` staying attached to
 * the DOM. The panel must stay mounted in the background even when collapsed or switched to another
 * conversation; only explicitly closing the tab can destroy the page state.
 */
export function shouldMountSidePaneContent(
  isVisible: boolean,
  tabs: readonly WorkspaceSidePaneTab[],
): boolean {
  return (
    isVisible ||
    tabs.some(
      (tab) => tab.type === "browser" || tab.type === "browser-use" || tab.type === "bash-output",
    )
  );
}

export function shouldMountBrowserTabGuest(
  tab: BrowserSidePaneTab | BrowserUseSidePaneTab,
): boolean {
  return tab.residency !== "suspended" && tab.residency !== "suspend-pending";
}

export interface WorkspaceSidePaneState {
  tabs: WorkspaceSidePaneTab[];
  activeTabId: string;
}

export function normalizeWorkspaceSidePaneState(
  current: WorkspaceSidePaneState | null,
): WorkspaceSidePaneState | null {
  if (!current) {
    return null;
  }

  // Treemapping currently needs to be hidden from the sidebar. Older versions may have changed the treemapping tab
  // It is written into the workspace-level side pane memory, where unified filtering is performed at the state boundary to prevent the entry from continuing to appear after recovery.
  const filteredTabs = current.tabs.filter((tab) => tab.type !== "treemapping");
  if (filteredTabs.length === 0) {
    return null;
  }

  // The auxiliary dialogue tab (HMR/old memory state of the same window) created before introducing `ordinal` does not have this
  // Field, directly participating in getNextSelectionSideChatOrdinal will get NaN/undefined and cause the title
  // Number conflict. Here, the minimum available number is backfilled by parent grouping at the state boundary, keeping the existing number unchanged.
  let migratedOrdinal = false;
  const tabs = filteredTabs.map((tab, index, allTabs) => {
    if (tab.type !== "selection-side-chat" || Number.isInteger(tab.ordinal)) {
      return tab;
    }
    // The tabs in allTabs that have been backfilled in this iteration are replaced in situ, and the integer ordinal is naturally involved in the occupancy determination.
    const used = new Set(
      allTabs.flatMap((candidate) =>
        candidate.type === "selection-side-chat" &&
        candidate.workspaceKey === tab.workspaceKey &&
        candidate.parentSessionId === tab.parentSessionId &&
        Number.isInteger(candidate.ordinal)
          ? [candidate.ordinal]
          : [],
      ),
    );
    let ordinal = 1;
    while (used.has(ordinal)) ordinal += 1;
    migratedOrdinal = true;
    const migrated: SelectionSideChatPaneTab = { ...tab, ordinal };
    allTabs[index] = migrated;
    return migrated;
  });

  const activeTabId =
    current.activeTabId === "" || tabs.some((tab) => tab.id === current.activeTabId)
      ? current.activeTabId
      : tabs[tabs.length - 1]!.id;
  if (
    !migratedOrdinal &&
    tabs.length === current.tabs.length &&
    activeTabId === current.activeTabId
  ) {
    return current;
  }

  return {
    tabs,
    activeTabId,
  };
}

function createBrowserSidePaneTab(options?: {
  tabId?: string;
  initialUrl?: string | null;
  ownerTaskId?: string | null;
  workspaceKey?: string | null;
  remoteSessionId?: string | null;
  agentOpened?: boolean;
}): BrowserSidePaneTab {
  return {
    id: options?.tabId ?? `browser:${createUuid()}`,
    type: "browser",
    ...(options?.ownerTaskId !== undefined ? { ownerTaskId: options.ownerTaskId } : {}),
    ...(options?.workspaceKey !== undefined ? { workspaceKey: options.workspaceKey } : {}),
    // human tab never writes remoteSessionId in the past, but stampSidePaneTabsOwnership only adds
    // ownerTaskId undefined tab - all tabs are created with ownerTaskId (open link/terminal URL/popup/share)
    // This field is permanently missing under remote mode. The attach side renderer will use workspaceRemoteSessionId to freeze the main
    // The owner and close sides are compared according to the null value on the tab. After the scope is judged to be mismatched, the tab can no longer be closed. Freeze upon creation.
    ...(options?.remoteSessionId ? { remoteSessionId: options.remoteSessionId } : {}),
    faviconUrl: null,
    initialUrl: options?.initialUrl ?? null,
    ...(options?.agentOpened ? { agentOpened: true } : {}),
    openedAt: Date.now(),
    title: null,
  };
}

function createGitSidePaneTab(): GitSidePaneTab {
  return { id: "git", type: "git", openedAt: Date.now() };
}

function createModelTrajectorySidePaneTab(options: {
  taskId: string;
  title?: string | null;
}): ModelTrajectorySidePaneTab {
  return {
    // Reuse the same tab for the same task to avoid opening multiple copies of the same track repeatedly.
    id: `model-trajectory:${options.taskId}`,
    type: "model-trajectory",
    openedAt: Date.now(),
    taskId: options.taskId,
    title: options.title ?? null,
  };
}

function createDeveloperToolsSidePaneTab(): DeveloperToolsSidePaneTab {
  return {
    id: "developer-tools",
    type: "developer-tools",
    openedAt: Date.now(),
  };
}

function createTerminalSidePaneTab(options: {
  title: string;
  cwd?: string;
  remoteSessionId?: string | null;
}): TerminalSidePaneTab {
  return {
    id: `terminal:${createUuid()}`,
    type: "terminal",
    openedAt: Date.now(),
    title: options.title,
    ...(options.cwd ? { cwd: options.cwd } : {}),
    ...(options.remoteSessionId ? { remoteSessionId: options.remoteSessionId } : {}),
  };
}

function encodeSidePaneTabIdPart(value: string): string {
  return encodeURIComponent(value);
}

function createSubagentSessionSidePaneTab(options: {
  workspaceKey: string;
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  rootSessionId?: string;
  parentSessionId: string;
  childSessionId: string;
  subagentType: string;
  title: string;
}): SubagentSessionSidePaneTab {
  const rootSessionId = options.rootSessionId ?? options.parentSessionId;
  return {
    id: [
      "subagent-session",
      encodeSidePaneTabIdPart(options.workspaceKey),
      encodeSidePaneTabIdPart(rootSessionId),
      encodeSidePaneTabIdPart(options.childSessionId),
    ].join(":"),
    type: "subagent-session",
    openedAt: Date.now(),
    workspaceKey: options.workspaceKey,
    workspacePath: options.workspacePath,
    ...(options.workspaceIdentity ? { workspaceIdentity: options.workspaceIdentity } : {}),
    ...(options.remoteSessionId ? { remoteSessionId: options.remoteSessionId } : {}),
    rootSessionId,
    parentSessionId: options.parentSessionId,
    childSessionId: options.childSessionId,
    subagentType: options.subagentType,
    title: options.title.trim(),
  };
}

function createSubagentDirectorySidePaneTab(options: {
  workspaceKey: string;
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  rootSessionId?: string;
  parentSessionId: string;
}): SubagentDirectorySidePaneTab {
  const rootSessionId = options.rootSessionId ?? options.parentSessionId;
  return {
    id: [
      "subagent-directory",
      encodeSidePaneTabIdPart(options.workspaceKey),
      encodeSidePaneTabIdPart(rootSessionId),
      encodeSidePaneTabIdPart(options.parentSessionId),
    ].join(":"),
    type: "subagent-directory",
    openedAt: Date.now(),
    workspaceKey: options.workspaceKey,
    workspacePath: options.workspacePath,
    ...(options.workspaceIdentity ? { workspaceIdentity: options.workspaceIdentity } : {}),
    ...(options.remoteSessionId ? { remoteSessionId: options.remoteSessionId } : {}),
    rootSessionId,
    parentSessionId: options.parentSessionId,
  };
}

function createSelectionSideChatPaneTab(
  options: OpenSelectionSideChatRequest & {
    workspaceKey: string;
    ordinal: number;
  },
): SelectionSideChatPaneTab {
  return {
    id: [
      "selection-side-chat",
      encodeSidePaneTabIdPart(options.workspaceKey),
      encodeSidePaneTabIdPart(options.parentSessionId),
      encodeSidePaneTabIdPart(options.childSessionId),
    ].join(":"),
    type: "selection-side-chat",
    openedAt: Date.now(),
    workspaceKey: options.workspaceKey,
    workspacePath: options.workspacePath,
    ...(options.workspaceIdentity ? { workspaceIdentity: options.workspaceIdentity } : {}),
    ...(options.remoteSessionId ? { remoteSessionId: options.remoteSessionId } : {}),
    parentSessionId: options.parentSessionId,
    childSessionId: options.childSessionId,
    ordinal: options.ordinal,
  };
}

function createPlanDetailSidePaneTab(
  options: OpenScopedPlanDetailSideTabRequest & { workspaceKey: string },
): PlanDetailSidePaneTab {
  return {
    id: [
      "plan-detail",
      encodeSidePaneTabIdPart(options.workspaceKey),
      encodeSidePaneTabIdPart(options.parentSessionId),
      encodeSidePaneTabIdPart(options.toolCallId),
    ].join(":"),
    type: "plan-detail",
    openedAt: Date.now(),
    workspaceKey: options.workspaceKey,
    workspacePath: options.workspacePath,
    ...(options.workspaceIdentity ? { workspaceIdentity: options.workspaceIdentity } : {}),
    ...(options.remoteSessionId ? { remoteSessionId: options.remoteSessionId } : {}),
    parentSessionId: options.parentSessionId,
    toolCallId: options.toolCallId,
    markdown: options.markdown,
    ...(options.planFilePath ? { planFilePath: options.planFilePath } : {}),
  };
}

function createWorkflowRunSidePaneTab(
  options: OpenScopedWorkflowRunSideTabRequest & { workspaceKey: string },
): WorkflowRunSidePaneTab {
  return {
    // Structured ID: The same run will always be the same tab in the same workspace + session, and repeated clicks are idempotent.
    id: [
      "workflow-run",
      encodeSidePaneTabIdPart(options.workspaceKey),
      encodeSidePaneTabIdPart(options.parentSessionId),
      encodeSidePaneTabIdPart(options.runId),
    ].join(":"),
    type: "workflow-run",
    openedAt: Date.now(),
    workspaceKey: options.workspaceKey,
    workspacePath: options.workspacePath,
    ...(options.workspaceIdentity ? { workspaceIdentity: options.workspaceIdentity } : {}),
    ...(options.remoteSessionId ? { remoteSessionId: options.remoteSessionId } : {}),
    parentSessionId: options.parentSessionId,
    toolCallId: options.toolCallId,
    runId: options.runId,
    ...(options.workflowName ? { workflowName: options.workflowName } : {}),
    ...(options.phaseId ? { focusPhaseId: options.phaseId } : {}),
  };
}

function createWorkflowRunDirectorySidePaneTab(
  options: OpenScopedWorkflowRunDirectorySideTabRequest & { workspaceKey: string },
): WorkflowRunDirectorySidePaneTab {
  return {
    // Structured ID: There is only one run directory for a conversation, so repeated clicks on the footer row focus the same tab idempotently.
    id: [
      "workflow-directory",
      encodeSidePaneTabIdPart(options.workspaceKey),
      encodeSidePaneTabIdPart(options.parentSessionId),
    ].join(":"),
    type: "workflow-directory",
    openedAt: Date.now(),
    workspaceKey: options.workspaceKey,
    workspacePath: options.workspacePath,
    ...(options.workspaceIdentity ? { workspaceIdentity: options.workspaceIdentity } : {}),
    ...(options.remoteSessionId ? { remoteSessionId: options.remoteSessionId } : {}),
    parentSessionId: options.parentSessionId,
  };
}

function createWorkflowActorSessionSidePaneTab(
  options: OpenScopedWorkflowActorSessionSideTabRequest & { workspaceKey: string },
): WorkflowActorSessionSidePaneTab {
  return {
    // Structured ID: The same slot is always the same tab in the same workspace + conversation, and repeated clicks are idempotent.
    // The identity is (runId, siteId@ordinal) instead of the session id: the tab can be opened before the session exists (uninitiated
    // pills), they must be opened from both ends without session and session and must fall into the same tab; runId is in id, and the two run
    // Instances with the same name still do not collide.
    id: [
      "workflow-actor-session",
      encodeSidePaneTabIdPart(options.workspaceKey),
      encodeSidePaneTabIdPart(options.parentSessionId),
      encodeSidePaneTabIdPart(options.runId),
      encodeSidePaneTabIdPart(`${options.siteId}@${options.ordinal}`),
    ].join(":"),
    type: "workflow-actor-session",
    openedAt: Date.now(),
    workspaceKey: options.workspaceKey,
    workspacePath: options.workspacePath,
    ...(options.workspaceIdentity ? { workspaceIdentity: options.workspaceIdentity } : {}),
    ...(options.remoteSessionId ? { remoteSessionId: options.remoteSessionId } : {}),
    parentSessionId: options.parentSessionId,
    runId: options.runId,
    ...(options.actorSessionId ? { actorSessionId: options.actorSessionId } : {}),
    siteId: options.siteId,
    ordinal: options.ordinal,
    ...(options.actorName ? { actorName: options.actorName } : {}),
  };
}

function createWorkflowWorkspaceSidePaneTab(
  options: OpenScopedWorkflowWorkspaceSideTabRequest & { workspaceKey: string },
): WorkflowWorkspaceSidePaneTab {
  return {
    // Structured id: (workspace, parent session, run). The stage is not in the id - one run and one script transcript.
    // Opening from the plan site or from the verify site is the same tab, but the location is different.
    id: [
      "workflow-workspace",
      encodeSidePaneTabIdPart(options.workspaceKey),
      encodeSidePaneTabIdPart(options.parentSessionId),
      encodeSidePaneTabIdPart(options.runId),
    ].join(":"),
    type: "workflow-workspace",
    openedAt: Date.now(),
    workspaceKey: options.workspaceKey,
    workspacePath: options.workspacePath,
    ...(options.workspaceIdentity ? { workspaceIdentity: options.workspaceIdentity } : {}),
    ...(options.remoteSessionId ? { remoteSessionId: options.remoteSessionId } : {}),
    parentSessionId: options.parentSessionId,
    toolCallId: options.toolCallId,
    runId: options.runId,
    ...(options.workflowName ? { workflowName: options.workflowName } : {}),
    ...(options.phaseId ? { focusPhaseId: options.phaseId } : {}),
  };
}

function createWorkflowArtifactSidePaneTab(
  options: OpenScopedWorkflowArtifactSideTabRequest & { workspaceKey: string },
): WorkflowArtifactSidePaneTab {
  return {
    // Structured id: **without version**. v1 and v2 of the same product are two moments of the same thing, click again
    // (Notification chip / hub chip / side panel card) You should only focus on the same tab and flip to the new version, not two side by side.
    id: [
      "workflow-artifact",
      encodeSidePaneTabIdPart(options.workspaceKey),
      encodeSidePaneTabIdPart(options.parentSessionId),
      encodeSidePaneTabIdPart(options.runId),
      encodeSidePaneTabIdPart(options.artifactId),
    ].join(":"),
    type: "workflow-artifact",
    openedAt: Date.now(),
    workspaceKey: options.workspaceKey,
    workspacePath: options.workspacePath,
    ...(options.workspaceIdentity ? { workspaceIdentity: options.workspaceIdentity } : {}),
    ...(options.remoteSessionId ? { remoteSessionId: options.remoteSessionId } : {}),
    parentSessionId: options.parentSessionId,
    runId: options.runId,
    artifactId: options.artifactId,
    ...(options.version === undefined ? {} : { version: options.version }),
    ...(options.title ? { title: options.title } : {}),
  };
}

function createWhiteboardSidePaneTab(options: {
  boardId: string;
  title: string;
}): WhiteboardSidePaneTab {
  return {
    id: `whiteboard:${options.boardId}`,
    type: "whiteboard",
    boardId: options.boardId,
    openedAt: Date.now(),
    title: options.title,
  };
}

function getCodeViewerTabSourceKey(source: CodeViewerSource): string | null {
  const workspaceScope = source.workspaceIdentity?.trim()
    ? source.workspaceIdentity.trim()
    : (source.workspacePath ?? "");
  const scopedKeyPrefix = workspaceScope ? `${workspaceScope}:` : "";
  // The file tree represents PPTX as a generic `file` source, and the reference is opened using the navigation intent.
  // `pptx` source. The old key directly contains source.type, causing the same workspace path to be split into two tabs.
  // The source type is only the entry representation, not the file identity; only PPTX is normalized here to avoid expanding the semantics of other preview types.
  const resourceType =
    source.type === "pptx" || (source.type === "file" && isPptxPreviewPath(source.path))
      ? "pptx"
      : source.type === "media" || (source.type === "file" && inferMediaPreview(source.path))
        ? "media"
        : source.type;

  if (
    source.type === "file" ||
    source.type === "code-review" ||
    source.type === "image" ||
    source.type === "media" ||
    source.type === "pdf" ||
    source.type === "pptx"
  ) {
    return `${scopedKeyPrefix}${resourceType}:${source.path}`;
  }

  if (source.type === "text" && source.path) {
    return `${scopedKeyPrefix}${source.type}:${source.path}`;
  }

  if (source.type === "patch") {
    // File diff used to only press path to reuse tabs, resulting in different patches generated for the same file in different rounds.
    // will cover each other and look like "the diff panel can only open one tab". Here, the patch content summary is included in the key.
    // This allows different diffs to be kept side by side, and repeated clicks on the same diff can still reuse existing tabs.
    return `${scopedKeyPrefix}patch:${source.path ?? source.title}:${hashCodeViewerContent(source.patch)}`;
  }

  if (source.type === "multi-file-diff") {
    return `${scopedKeyPrefix}multi-file-diff:${source.path ?? source.title}:${hashCodeViewerContent(`${source.beforeContent}\0${source.afterContent}`)}`;
  }

  return null;
}

function hashCodeViewerContent(content: string): string {
  let hash = 0;
  for (let index = 0; index < content.length; index += 1) {
    hash = (hash * 31 + content.charCodeAt(index)) | 0;
  }

  return Math.abs(hash).toString(36);
}

function createCodeViewerSidePaneTab(source: CodeViewerSource): CodeViewerSidePaneTab {
  const normalizedSource = normalizeCodeViewerSource(source);
  const sourceKey = getCodeViewerTabSourceKey(normalizedSource);
  return {
    id: sourceKey ? `code-viewer:${sourceKey}` : `code-viewer:${createUuid()}`,
    type: "code-viewer",
    openedAt: Date.now(),
    source: normalizedSource,
    sourceKey,
  };
}

function findTabIndexById(tabs: WorkspaceSidePaneTab[], tabId: string): number {
  return tabs.findIndex((tab) => tab.id === tabId);
}

function activateSidePaneTab(
  current: WorkspaceSidePaneState | null,
  tab: WorkspaceSidePaneTab,
): WorkspaceSidePaneState {
  if (!current) {
    return {
      tabs: [tab],
      activeTabId: tab.id,
    };
  }

  const existingIndex = findTabIndexById(current.tabs, tab.id);
  if (existingIndex >= 0) {
    const nextTabs = [...current.tabs];
    nextTabs[existingIndex] = tab;
    return {
      tabs: nextTabs,
      activeTabId: tab.id,
    };
  }

  return {
    tabs: [...current.tabs, tab],
    activeTabId: tab.id,
  };
}

export function getActiveSidePaneTab(
  current: WorkspaceSidePaneState | null,
): WorkspaceSidePaneTab | null {
  if (!current) {
    return null;
  }

  return current.tabs.find((tab) => tab.id === current.activeTabId) ?? null;
}

/** Normalizes the draft-state null/undefined, so the side pane can isolate by conversation. */
export function sidePaneOwnerKey(taskId: string | null | undefined): string {
  return taskId ?? "__draft__";
}

const WORKSPACE_GLOBAL_SIDE_PANE_TAB_TYPES = new Set<WorkspaceSidePaneTab["type"]>([
  "git",
  "developer-tools",
  "treemapping",
]);

function isWorkspaceGlobalSidePaneTab(tab: WorkspaceSidePaneTab): boolean {
  return WORKSPACE_GLOBAL_SIDE_PANE_TAB_TYPES.has(tab.type);
}

interface SidePaneVisibilityScope {
  workspaceKey: string | null;
  ownerTaskId: string | null;
}

function sidePaneTabMatchesWorkspace(
  tab: WorkspaceSidePaneTab,
  activeWorkspaceKey: string | null,
): boolean {
  return tab.workspaceKey == null || tab.workspaceKey === activeWorkspaceKey;
}

/**
 * A newly created tab freezes its workspace and conversation ownership when it is committed to the
 * shared side pane state. browser-use carries its own event origin, so a tab that is already tagged
 * must never be overwritten by the current UI scope.
 */
export function stampSidePaneTabsOwnership(
  state: WorkspaceSidePaneState | null,
  ownership: {
    ownerTaskId: string | null;
    workspaceKey: string | null;
    remoteSessionId?: string | null;
  },
): WorkspaceSidePaneState | null {
  if (!state) return state;
  let changed = false;
  const tabs = state.tabs.map((tab) => {
    if (tab.ownerTaskId !== undefined) return tab;
    changed = true;
    return {
      ...tab,
      ownerTaskId: ownership.ownerTaskId,
      workspaceKey: tab.workspaceKey ?? ownership.workspaceKey,
      ...((tab.type === "browser" || tab.type === "browser-use") && ownership.remoteSessionId
        ? { remoteSessionId: ownership.remoteSessionId }
        : {}),
    } as WorkspaceSidePaneTab;
  });
  return changed ? { ...state, tabs } : state;
}

function getVisibleSidePaneTabsByScope(
  tabs: WorkspaceSidePaneTab[],
  scope: SidePaneVisibilityScope,
): WorkspaceSidePaneTab[] {
  const ownerKey = sidePaneOwnerKey(scope.ownerTaskId);
  return tabs.filter((tab) => {
    if (!sidePaneTabMatchesWorkspace(tab, scope.workspaceKey)) return false;
    if (isWorkspaceGlobalSidePaneTab(tab)) return true;
    if (tab.type === "browser-use") return tab.sessionId === scope.ownerTaskId;
    if (
      tab.type === "subagent-session" ||
      tab.type === "subagent-directory" ||
      tab.type === "bash-output"
    ) {
      return tab.rootSessionId === scope.ownerTaskId;
    }
    if (
      tab.type === "selection-side-chat" ||
      tab.type === "plan-detail" ||
      tab.type === "workflow-run" ||
      tab.type === "workflow-actor-session" ||
      tab.type === "workflow-workspace" ||
      tab.type === "workflow-artifact"
    ) {
      return tab.parentSessionId === scope.ownerTaskId;
    }
    return sidePaneOwnerKey(tab.ownerTaskId) === ownerKey;
  });
}

function resolveActiveTabForOwner(
  state: WorkspaceSidePaneState | null,
  scope: SidePaneVisibilityScope,
  preferredTabId?: string | null,
): string | null {
  if (!state) return null;
  const visibleTabs = getVisibleSidePaneTabsByScope(state.tabs, scope);
  if (visibleTabs.length === 0) return null;
  if (preferredTabId && visibleTabs.some((tab) => tab.id === preferredTabId)) {
    return preferredTabId;
  }
  if (visibleTabs.some((tab) => tab.id === state.activeTabId)) {
    return state.activeTabId;
  }
  return visibleTabs.at(-1)?.id ?? null;
}

/**
 * Resolves the active tab and the collapsed state together when the conversation scope switches.
 *
 * When the target conversation has no preferredTabId, the collapsed state of the previous
 * conversation must not be carried over, and it must not simply be overwritten with “expand when a
 * visible tab exists”. Otherwise a user who collapses A, switches to B, and switches back to A
 * would still be auto-expanded by A's visible tab. The caller now passes the current conversation's
 * explicit preference; only when there is no preference does the default apply: expand when there
 * are tabs, collapse when there are none.
 */
export function resolveSidePaneScopeState(
  state: WorkspaceSidePaneState | null,
  scope: SidePaneVisibilityScope,
  preferredTabId?: string | null,
  collapsedPreference?: boolean,
): {
  sidePaneState: WorkspaceSidePaneState | null;
  isSidePaneCollapsed: boolean;
} {
  const activeTabId = resolveActiveTabForOwner(state, scope, preferredTabId);
  return {
    sidePaneState:
      state && state.activeTabId !== (activeTabId ?? "")
        ? { ...state, activeTabId: activeTabId ?? "" }
        : state,
    isSidePaneCollapsed: activeTabId === null ? true : (collapsedPreference ?? false),
  };
}

export function restoreSidePaneTab(
  current: WorkspaceSidePaneState | null,
  tab: WorkspaceSidePaneTab,
): WorkspaceSidePaneState {
  return activateSidePaneTab(current, {
    ...tab,
    openedAt: tab.openedAt ?? Date.now(),
  });
}

function activateBrowserSidePane(
  current: WorkspaceSidePaneState | null,
  options?: {
    tabId?: string;
    initialUrl?: string | null;
    forceNew?: boolean;
    ownerTaskId?: string | null;
    workspaceKey?: string | null;
    remoteSessionId?: string | null;
    agentOpened?: boolean;
  },
): WorkspaceSidePaneState {
  if (!options?.forceNew && !options?.tabId && !options?.initialUrl) {
    const ownerKey = sidePaneOwnerKey(options?.ownerTaskId);
    const existingBrowserTab = current?.tabs.find(
      (tab): tab is BrowserSidePaneTab =>
        tab.type === "browser" && sidePaneOwnerKey(tab.ownerTaskId) === ownerKey,
    );
    if (existingBrowserTab) {
      return activateSidePaneTab(current, existingBrowserTab);
    }
  }

  return activateSidePaneTab(current, createBrowserSidePaneTab(options));
}

export function openBrowserSidePane(
  current: WorkspaceSidePaneState | null,
  options?: {
    tabId?: string;
    initialUrl?: string | null;
    ownerTaskId?: string | null;
    workspaceKey?: string | null;
    remoteSessionId?: string | null;
    activate?: boolean;
    agentOpened?: boolean;
  },
): WorkspaceSidePaneState {
  const next = activateBrowserSidePane(current, {
    ...options,
    forceNew: true,
  });
  if (options?.activate !== false) return next;
  return { ...next, activeTabId: current?.activeTabId ?? "" };
}

/**
 * Claims the browser tab for the same URL under the same workspace/owner.
 *
 * The caller (`useAppPanels`) needs to know the id of the landing tab **first** in order to send it
 * a navigation request, so lookup and opening are split into two steps: this locates it, and
 * `openOrActivateBrowserSidePaneByUrl` lands on the same criterion. Both share it, so “looked up A,
 * opened B” cannot happen.
 */
export function findBrowserSidePaneTabByUrl(
  current: WorkspaceSidePaneState | null,
  options: {
    initialUrl: string;
    ownerTaskId?: string | null;
    workspaceKey?: string | null;
  },
): BrowserSidePaneTab | undefined {
  const ownerKey = sidePaneOwnerKey(options.ownerTaskId);
  return current?.tabs.find(
    (tab): tab is BrowserSidePaneTab =>
      tab.type === "browser" &&
      tab.initialUrl === options.initialUrl &&
      sidePaneOwnerKey(tab.ownerTaskId) === ownerKey &&
      sidePaneTabMatchesWorkspace(tab, options.workspaceKey ?? null),
  );
}

/**
 * URL key reuse: the same URL in the same workspace/session only activates an existing tab.
 *
 * Two users: the share link from share handover, and the direct open of an html artifact. Both are
 * the same sentence — “take me to this address”, not “open another browser”. On reuse **no** field
 * of the tab is changed (`initialUrl` is the key); to make the webview fetch the bytes again, the
 * caller sends another navigation request.
 */
export function openOrActivateBrowserSidePaneByUrl(
  current: WorkspaceSidePaneState | null,
  options: {
    initialUrl: string;
    /**
     * Tab id used when creating a new tab; absent means one is generated now. Ignored when an
     * existing tab is hit.
     */
    tabId?: string;
    ownerTaskId?: string | null;
    workspaceKey?: string | null;
    remoteSessionId?: string | null;
  },
): WorkspaceSidePaneState {
  const existing = findBrowserSidePaneTabByUrl(current, options);
  if (existing) return activateSidePaneTab(current, existing);
  return activateBrowserSidePane(current, {
    initialUrl: options.initialUrl,
    ...(options.tabId ? { tabId: options.tabId } : {}),
    ownerTaskId: options.ownerTaskId,
    workspaceKey: options.workspaceKey,
    ...(options.remoteSessionId ? { remoteSessionId: options.remoteSessionId } : {}),
  });
}

/** Opens or updates a controlled browser-use tab; ready replay is idempotent per tabId. */
function openBrowserUseSidePane(
  current: WorkspaceSidePaneState | null,
  options: {
    workspaceKey: string;
    sessionId: string;
    tabId: string;
    browserId?: string;
    browserGeneration?: number;
    remoteSessionId?: string;
    title?: string;
    activate?: boolean;
  },
): WorkspaceSidePaneState {
  const id = `browser-use:${options.tabId}`;
  const existing = current?.tabs.find(
    (tab): tab is BrowserUseSidePaneTab => tab.type === "browser-use" && tab.id === id,
  );
  const remoteSessionId = options.remoteSessionId ?? existing?.remoteSessionId;
  const tab: BrowserUseSidePaneTab = {
    id,
    type: "browser-use",
    ownerTaskId: options.sessionId,
    workspaceKey: options.workspaceKey,
    ...(remoteSessionId ? { remoteSessionId } : {}),
    sessionId: options.sessionId,
    tabId: options.tabId,
    ...(options.browserId ? { browserId: options.browserId } : {}),
    ...(options.browserGeneration !== undefined
      ? { browserGeneration: options.browserGeneration }
      : {}),
    openedAt: existing?.openedAt ?? Date.now(),
    ...((options.title ?? existing?.title)
      ? { title: options.title ?? existing?.title ?? null }
      : {}),
    ...(existing?.faviconUrl !== undefined ? { faviconUrl: existing.faviconUrl } : {}),
    ...(existing?.residency !== undefined ? { residency: existing.residency } : {}),
    ...(existing?.residencyGeneration !== undefined
      ? { residencyGeneration: existing.residencyGeneration }
      : {}),
    ...(existing?.browserUseOperationUntil !== undefined
      ? { browserUseOperationUntil: existing.browserUseOperationUntil }
      : {}),
    ...(existing?.browserUseResizeBaselineVersion !== undefined
      ? {
          browserUseResizeBaselineVersion: existing.browserUseResizeBaselineVersion,
        }
      : {}),
  };

  if (options.activate !== false) {
    return activateSidePaneTab(current, tab);
  }
  if (!current) {
    return { tabs: [tab], activeTabId: "" };
  }
  const existingIndex = findTabIndexById(current.tabs, tab.id);
  if (existingIndex >= 0) {
    const tabs = [...current.tabs];
    tabs[existingIndex] = tab;
    return { ...current, tabs };
  }
  return { ...current, tabs: [...current.tabs, tab] };
}

interface BrowserUseSidePaneScope {
  workspaceKey: string;
  remoteSessionId?: string;
  ownerTaskId: string | null;
}

/**
 * ready/show events may only activate within their origin workspace + session; background events
 * only mount the guest.
 */
export function applyBrowserUseSidePaneEvent(
  current: WorkspaceSidePaneState | null,
  options: {
    workspaceKey: string;
    remoteSessionId?: string;
    sessionId: string;
    tabId: string;
    browserId?: string;
    browserGeneration?: number;
  },
  activeScope: BrowserUseSidePaneScope,
): { state: WorkspaceSidePaneState; shouldReveal: boolean } {
  const shouldReveal =
    options.workspaceKey === activeScope.workspaceKey &&
    (options.remoteSessionId ?? "") === (activeScope.remoteSessionId ?? "") &&
    options.sessionId === activeScope.ownerTaskId;
  return {
    state: openBrowserUseSidePane(current, {
      ...options,
      activate: shouldReveal,
    }),
    shouldReveal,
  };
}

/**
 * visibility only selects a shell that ready has already created; late events must not rebuild a
 * closed tab.
 */
export function applyBrowserUseSidePaneVisibilityEvent(
  current: WorkspaceSidePaneState | null,
  options: {
    workspaceKey: string;
    remoteSessionId?: string;
    sessionId: string;
    tabId: string;
    browserId?: string;
    browserGeneration?: number;
  },
  activeScope: BrowserUseSidePaneScope,
): {
  state: WorkspaceSidePaneState | null;
  shouldReveal: boolean;
  didMatch: boolean;
} {
  const target = current?.tabs.find(
    (tab): tab is BrowserUseSidePaneTab =>
      tab.type === "browser-use" &&
      tab.tabId === options.tabId &&
      tab.workspaceKey === options.workspaceKey &&
      (tab.remoteSessionId ?? "") === (options.remoteSessionId ?? "") &&
      tab.sessionId === options.sessionId &&
      (options.browserId === undefined || tab.browserId === options.browserId) &&
      (options.browserGeneration === undefined ||
        tab.browserGeneration === options.browserGeneration),
  );
  if (!target) {
    // The old visibility path reuses ready's open helper. After main has closed the tab, it is in the queue
    // The late visible=true will rebuild the zombie shell without main authority in the renderer, and then click to close it.
    // fail. visibility is a selection signal that can only hit existing shells with exactly the same scope/generation.
    return { state: current, shouldReveal: false, didMatch: false };
  }

  const shouldReveal =
    options.workspaceKey === activeScope.workspaceKey &&
    (options.remoteSessionId ?? "") === (activeScope.remoteSessionId ?? "") &&
    options.sessionId === activeScope.ownerTaskId;
  return {
    state: shouldReveal ? setActiveSidePaneTab(current, target.id) : current,
    shouldReveal,
    didMatch: true,
  };
}

export function applyBrowserTabResidencyEvent(
  current: WorkspaceSidePaneState | null,
  event: {
    tabId: string;
    workspaceKey?: string;
    remoteSessionId?: string;
    sessionId?: string;
    browserId?: string;
    browserGeneration?: number;
    generation: number;
    residency: Extract<
      BrowserTabResidencyState,
      "live-visible" | "live-background" | "suspended" | "restoring"
    >;
  },
): WorkspaceSidePaneState | null {
  if (!current) return current;
  const index = current.tabs.findIndex(
    (tab) =>
      (tab.type === "browser" && tab.id === event.tabId) ||
      (tab.type === "browser-use" && tab.tabId === event.tabId),
  );
  if (index < 0) return current;
  const target = current.tabs[index] as BrowserSidePaneTab | BrowserUseSidePaneTab;
  if (event.workspaceKey !== undefined && target.workspaceKey !== event.workspaceKey)
    return current;
  if (
    Object.hasOwn(event, "remoteSessionId") &&
    (target.remoteSessionId ?? "") !== (event.remoteSessionId ?? "")
  ) {
    return current;
  }
  if (
    event.sessionId !== undefined &&
    (target.type === "browser-use"
      ? target.sessionId !== event.sessionId
      : (target.ownerTaskId ?? "unscoped") !== event.sessionId)
  ) {
    return current;
  }
  if ((target.residencyGeneration ?? 0) > event.generation) return current;
  const tabs = [...current.tabs];
  tabs[index] = {
    ...target,
    ...(target.type === "browser-use" && event.browserId ? { browserId: event.browserId } : {}),
    ...(target.type === "browser-use" && event.browserGeneration !== undefined
      ? { browserGeneration: event.browserGeneration }
      : {}),
    residency: event.residency,
    residencyGeneration: event.generation,
  };
  return { ...current, tabs };
}

export function openCodeViewerSidePane(
  current: WorkspaceSidePaneState | null,
  source: CodeViewerSource,
  ownerTaskId?: string | null,
): WorkspaceSidePaneState {
  // When the same file/picture is clicked repeatedly in the message, the entire right panel cannot be replaced.
  // The content the user just viewed in other panes will be discarded directly. Here, press the stable sourceKey to reuse the existing code viewer tab.
  // It not only avoids repeatedly opening a row of tabs with the same name, but also refreshes to the latest source when opening it again.
  const nextTab = createCodeViewerSidePaneTab(source);
  if (!current || nextTab.sourceKey === null) {
    return activateSidePaneTab(current, nextTab);
  }

  const ownerKey = sidePaneOwnerKey(ownerTaskId);
  const matchedTab = current.tabs.find(
    (tab): tab is CodeViewerSidePaneTab =>
      tab.type === "code-viewer" &&
      tab.sourceKey === nextTab.sourceKey &&
      sidePaneOwnerKey(tab.ownerTaskId) === ownerKey,
  );
  return activateSidePaneTab(
    current,
    matchedTab ? { ...matchedTab, source: nextTab.source } : nextTab,
  );
}

/**
 * Opens a group of code preview tabs in one go.
 *
 * When auto-opening generated artifacts, openCodeViewerSidePane must not be called one at a time:
 * committing them one by one makes the right panel pass through several intermediate states, and
 * the last one unexpectedly becomes active. Here the single-file sourceKey/owner rules are reused
 * to converge in one batch, and finally one tab is activated in the order the caller specified.
 */
export function openCodeViewerSidePanes(
  current: WorkspaceSidePaneState | null,
  sources: readonly CodeViewerSource[],
  ownerTaskId?: string | null,
  activeIndex = 0,
): WorkspaceSidePaneState {
  if (sources.length === 0) {
    return current ?? { tabs: [], activeTabId: "" };
  }

  let next: WorkspaceSidePaneState | null = current;
  const openedTabIds: string[] = [];
  const seenSourceKeys = new Set<string>();

  for (const source of sources) {
    const normalizedSource = normalizeCodeViewerSource(source);
    const sourceKey = getCodeViewerTabSourceKey(normalizedSource);
    // sourceKey is a workspace-scoped stable identity; duplicate paths in the same batch are only opened once.
    if (sourceKey !== null && seenSourceKeys.has(sourceKey)) continue;
    if (sourceKey !== null) seenSourceKeys.add(sourceKey);

    next = openCodeViewerSidePane(next, normalizedSource, ownerTaskId);
    const activeTab = getActiveSidePaneTab(next);
    if (activeTab?.type === "code-viewer") {
      openedTabIds.push(activeTab.id);
    }
  }

  if (!next || openedTabIds.length === 0) {
    return next ?? { tabs: [], activeTabId: "" };
  }

  const safeIndex = Math.min(Math.max(activeIndex, 0), openedTabIds.length - 1);
  return {
    ...next,
    activeTabId: openedTabIds[safeIndex]!,
  };
}

export function activateGitSidePane(
  current: WorkspaceSidePaneState | null,
): WorkspaceSidePaneState {
  return activateSidePaneTab(current, createGitSidePaneTab());
}

export function openWhiteboardSidePane(
  current: WorkspaceSidePaneState | null,
  options: {
    boardId: string;
    title: string;
  },
): WorkspaceSidePaneState {
  return activateSidePaneTab(current, createWhiteboardSidePaneTab(options));
}

export function openModelTrajectorySidePane(
  current: WorkspaceSidePaneState | null,
  options: {
    taskId: string;
    title?: string | null;
  },
): WorkspaceSidePaneState {
  return activateSidePaneTab(current, createModelTrajectorySidePaneTab(options));
}

export function activateDeveloperToolsSidePane(
  current: WorkspaceSidePaneState | null,
): WorkspaceSidePaneState {
  return activateSidePaneTab(current, createDeveloperToolsSidePaneTab());
}

export function openTerminalSidePane(
  current: WorkspaceSidePaneState | null,
  options: { title: string; cwd?: string; remoteSessionId?: string | null },
): WorkspaceSidePaneState {
  return activateSidePaneTab(current, createTerminalSidePaneTab(options));
}

export function openSubagentSessionSidePane(
  current: WorkspaceSidePaneState | null,
  options: {
    workspaceKey: string;
    workspacePath: string;
    workspaceIdentity?: string;
    remoteSessionId?: string;
    rootSessionId?: string;
    parentSessionId: string;
    childSessionId: string;
    subagentType: string;
    title: string;
  },
): WorkspaceSidePaneState {
  const nextTab = createSubagentSessionSidePaneTab(options);
  const existing = current?.tabs.find(
    (tab): tab is SubagentSessionSidePaneTab =>
      tab.type === "subagent-session" && tab.id === nextTab.id,
  );
  const nextTitle = options.title.trim();
  return activateSidePaneTab(
    current,
    existing
      ? {
          ...existing,
          workspacePath: options.workspacePath,
          ...(options.workspaceIdentity ? { workspaceIdentity: options.workspaceIdentity } : {}),
          ...(options.remoteSessionId ? { remoteSessionId: options.remoteSessionId } : {}),
          rootSessionId: options.rootSessionId ?? options.parentSessionId,
          parentSessionId: options.parentSessionId,
          subagentType: options.subagentType,
          // During HMR, the memory tab of the old structure may be reused; if the new entry does not have a title, the known title will be retained.
          // But never fall back to the old type + ordinal display rules.
          title: nextTitle || existing.title || "",
        }
      : nextTab,
  );
}

export function openSubagentDirectorySidePane(
  current: WorkspaceSidePaneState | null,
  options: {
    workspaceKey: string;
    workspacePath: string;
    workspaceIdentity?: string;
    remoteSessionId?: string;
    rootSessionId?: string;
    parentSessionId: string;
  },
): WorkspaceSidePaneState {
  const nextTab = createSubagentDirectorySidePaneTab(options);
  const existing = current?.tabs.find(
    (tab): tab is SubagentDirectorySidePaneTab =>
      tab.type === "subagent-directory" && tab.id === nextTab.id,
  );
  return activateSidePaneTab(current, existing ? { ...existing, ...nextTab } : nextTab);
}

export function syncSubagentSessionSidePaneTabs(
  current: WorkspaceSidePaneState | null,
  options: SyncSubagentSessionTabsRequest,
): WorkspaceSidePaneState | null {
  if (!current) return null;
  const validChildSessionIds = new Set(options.validChildSessionIds);
  const removedTabs = current.tabs.filter(
    (tab) =>
      tab.type === "subagent-session" &&
      tab.rootSessionId === options.rootSessionId &&
      tab.parentSessionId === options.parentSessionId &&
      !validChildSessionIds.has(tab.childSessionId),
  );
  if (removedTabs.length === 0) return current;
  const removedIds = new Set(removedTabs.map((tab) => tab.id));
  const tabs = current.tabs.filter((tab) => !removedIds.has(tab.id));
  if (tabs.length === 0) return null;
  if (!removedIds.has(current.activeTabId)) return { ...current, tabs };
  const directory = tabs.find(
    (tab) => tab.type === "subagent-directory" && tab.rootSessionId === options.rootSessionId,
  );
  if (directory) return { tabs, activeTabId: directory.id };
  const removedIndex = current.tabs.findIndex((tab) => tab.id === current.activeTabId);
  const previous = tabs[Math.max(0, Math.min(removedIndex - 1, tabs.length - 1))];
  return { tabs, activeTabId: previous?.id ?? tabs.at(-1)!.id };
}

export function openSelectionSideChatPane(
  current: WorkspaceSidePaneState | null,
  options: OpenSelectionSideChatRequest & { workspaceKey: string },
): WorkspaceSidePaneState {
  const existing = current?.tabs.find(
    (tab): tab is SelectionSideChatPaneTab =>
      tab.type === "selection-side-chat" &&
      tab.workspaceKey === options.workspaceKey &&
      tab.parentSessionId === options.parentSessionId &&
      tab.childSessionId === options.childSessionId,
  );
  const ordinal =
    existing?.ordinal ??
    getNextSelectionSideChatOrdinal(
      current?.tabs ?? [],
      options.workspaceKey,
      options.parentSessionId,
    );
  const nextTab = createSelectionSideChatPaneTab({ ...options, ordinal });
  return activateSidePaneTab(current, existing ? { ...existing, ...nextTab } : nextTab);
}

function getNextSelectionSideChatOrdinal(
  tabs: readonly WorkspaceSidePaneTab[],
  workspaceKey: string,
  parentSessionId: string,
): number {
  const used = new Set(
    tabs.flatMap((tab) =>
      tab.type === "selection-side-chat" &&
      tab.workspaceKey === workspaceKey &&
      tab.parentSessionId === parentSessionId
        ? [tab.ordinal]
        : [],
    ),
  );
  let ordinal = 1;
  while (used.has(ordinal)) ordinal += 1;
  return ordinal;
}

export function getActiveSelectionSideChatTab(
  current: WorkspaceSidePaneState | null,
  scope: { workspaceKey: string; parentSessionId: string },
): SelectionSideChatPaneTab | null {
  const active = getActiveSidePaneTab(current);
  return active?.type === "selection-side-chat" &&
    active.workspaceKey === scope.workspaceKey &&
    active.parentSessionId === scope.parentSessionId
    ? active
    : null;
}

export function openPlanDetailSidePane(
  current: WorkspaceSidePaneState | null,
  options: OpenScopedPlanDetailSideTabRequest & { workspaceKey: string },
): WorkspaceSidePaneState {
  const nextTab = createPlanDetailSidePaneTab(options);
  const existing = current?.tabs.find(
    (tab): tab is PlanDetailSidePaneTab => tab.type === "plan-detail" && tab.id === nextTab.id,
  );
  // The same toolCall only retains one tab; click again to refresh the fallback with the current text of the card.
  // The details component's live text remains authoritative of the parent conversation projection.
  return activateSidePaneTab(current, existing ? { ...existing, ...nextTab } : nextTab);
}

/**
 * Opens or reuses a workflow run detail tab.
 *
 * The reuse rule is structurally identical to plan-detail (idempotent on the structured id), and
 * deliberately there is **no GC** either: the event log reads the journal, while the `workflowRuns`
 * projection keeps only the most recent 8 runs, so an evicted run still has a complete readable
 * event log — which is exactly the case where a user keeps this tab around. A missing projection
 * degrades into the empty state of the detail page; the tab is not closed.
 */
export function openWorkflowRunSidePane(
  current: WorkspaceSidePaneState | null,
  options: OpenScopedWorkflowRunSideTabRequest & { workspaceKey: string },
): WorkspaceSidePaneState {
  const nextTab = createWorkflowRunSidePaneTab(options);
  const existing = current?.tabs.find(
    (tab): tab is WorkflowRunSidePaneTab => tab.type === "workflow-run" && tab.id === nextTab.id,
  );
  if (existing === undefined) return activateSidePaneTab(current, nextTab);
  // The drop point is recalculated every time (the same rule as the script transcript tab): if the phaseId is requested, it will be dropped to it, if not, the key will be deleted explicitly;
  // `openedAt` is refreshed every time it is opened, and the panel will be re-rolled accordingly if clicked again on the same site.
  const merged: WorkflowRunSidePaneTab = { ...existing, ...nextTab };
  if (nextTab.focusPhaseId === undefined) delete merged.focusPhaseId;
  return activateSidePaneTab(current, merged);
}

/**
 * In-place replacement after “Configure” is accepted: the old run's tab is replaced by the new
 * run's tab, with position, name, and ownership unchanged; only if it was the active tab does the
 * new tab become active. When the new run's tab is already open, close the old one and focus the
 * existing one (do not end up with two). If the old tab is not there (the user closed it), return
 * as-is — replacing is not opening; the same holds when the run in the result is the one being
 * replaced (an in-place revision has no successor): this tab is already it.
 */
export function replaceWorkflowRunSidePane(
  current: WorkspaceSidePaneState | null,
  options: OpenScopedWorkflowRunSideTabRequest & { workspaceKey: string; replaceRunId: string },
): WorkspaceSidePaneState | null {
  if (current === null) return current;
  const nextTab = createWorkflowRunSidePaneTab(options);
  const replaceRunId = options.replaceRunId;
  const index = current.tabs.findIndex(
    (tab) =>
      tab.type === "workflow-run" &&
      tab.workspaceKey === nextTab.workspaceKey &&
      tab.parentSessionId === nextTab.parentSessionId &&
      tab.runId === replaceRunId,
  );
  const previous = current.tabs[index];
  if (index < 0 || previous?.type !== "workflow-run") return current;
  // Revisions that take effect locally (only the concurrency limit is changed, and run is still running) have no successors.
  // The runId in the result is the replaced one. The id of the tab is only cast by runId, so if you don't block it here, the one below
  // "New tab is already open" will recognize itself and close the tab, leaving only an activeTabId pointing to the tab that no longer exists.
  if (nextTab.id === previous.id) return current;
  const wasActive = current.activeTabId === previous.id;
  const existingIndex = findTabIndexById(current.tabs, nextTab.id);
  if (existingIndex >= 0) {
    const tabs = current.tabs.filter((_, tabIndex) => tabIndex !== index);
    return { tabs, activeTabId: wasActive ? nextTab.id : current.activeTabId };
  }
  const replaced: WorkflowRunSidePaneTab = {
    ...nextTab,
    ...(previous.ownerTaskId === undefined ? {} : { ownerTaskId: previous.ownerTaskId }),
    ...(nextTab.workflowName === undefined && previous.workflowName !== undefined
      ? { workflowName: previous.workflowName }
      : {}),
  };
  const tabs = [...current.tabs];
  tabs[index] = replaced;
  return { tabs, activeTabId: wasActive ? replaced.id : current.activeTabId };
}

/**
 * Opens or reuses the run directory tab of a conversation. The identity is the conversation, so
 * repeated clicks on the footer row only focus.
 *
 * There is likewise **no GC** (the same reasoning chain as workflow-run): the directory page
 * re-reads a page of journal on every mount, so a restored old tab never shows a stale list, and
 * therefore there is nothing to reclaim.
 */
export function openWorkflowRunDirectorySidePane(
  current: WorkspaceSidePaneState | null,
  options: OpenScopedWorkflowRunDirectorySideTabRequest & { workspaceKey: string },
): WorkspaceSidePaneState {
  const nextTab = createWorkflowRunDirectorySidePaneTab(options);
  const existing = current?.tabs.find(
    (tab): tab is WorkflowRunDirectorySidePaneTab =>
      tab.type === "workflow-directory" && tab.id === nextTab.id,
  );
  return activateSidePaneTab(current, existing ? { ...existing, ...nextTab } : nextTab);
}

/**
 * Opens or reuses an actor transcript tab.
 *
 * The reuse rule is structurally identical to workflow-run (idempotent on the structured id), and
 * likewise there is **no GC**: the actor session stays readable after the run ends, which is
 * exactly what persisting it as a real durable session buys. See the paragraph on the type.
 *
 * When merging, keys absent from the new request do not overwrite the old values: opening first
 * from a pill that has not started (no session id) and later from a started pill (with a session
 * id) fills in the session; conversely, opening once more without a session does not wipe the known
 * session id.
 */
export function openWorkflowActorSessionSidePane(
  current: WorkspaceSidePaneState | null,
  options: OpenScopedWorkflowActorSessionSideTabRequest & { workspaceKey: string },
): WorkspaceSidePaneState {
  const nextTab = createWorkflowActorSessionSidePaneTab(options);
  const existing = current?.tabs.find(
    (tab): tab is WorkflowActorSessionSidePaneTab =>
      tab.type === "workflow-actor-session" && tab.id === nextTab.id,
  );
  return activateSidePaneTab(current, existing ? { ...existing, ...nextTab } : nextTab);
}

/**
 * Opens or reuses a run's script transcript tab.
 *
 * The landing spot is **recomputed every time**: clicking a script pill again means “take me to
 * that stop”, so a request carrying phaseId lands there and one without it does not land (the key
 * is explicitly deleted, same handling of version as in `openWorkflowArtifactSidePane`). `openedAt`
 * is refreshed on every open, and the panel uses it to scroll again when the same stop is clicked
 * again.
 */
export function openWorkflowWorkspaceSidePane(
  current: WorkspaceSidePaneState | null,
  options: OpenScopedWorkflowWorkspaceSideTabRequest & { workspaceKey: string },
): WorkspaceSidePaneState {
  const nextTab = createWorkflowWorkspaceSidePaneTab(options);
  const existing = current?.tabs.find(
    (tab): tab is WorkflowWorkspaceSidePaneTab =>
      tab.type === "workflow-workspace" && tab.id === nextTab.id,
  );
  if (existing === undefined) return activateSidePaneTab(current, nextTab);
  const merged: WorkflowWorkspaceSidePaneTab = { ...existing, ...nextTab };
  if (nextTab.focusPhaseId === undefined) delete merged.focusPhaseId;
  return activateSidePaneTab(current, merged);
}

/**
 * Opens or reuses a full-size tab of an artifact.
 *
 * On reuse the old tab's version is **not** carried over: clicking a chip again means “show me this
 * artifact”, and a chip never carries a version, so a `version` absent from the merged result means
 * back to the latest. Conversely, if the request explicitly carries a version (for example, if some
 * place later wants to jump to a specific version), that version is the landing spot.
 */
export function openWorkflowArtifactSidePane(
  current: WorkspaceSidePaneState | null,
  options: OpenScopedWorkflowArtifactSideTabRequest & { workspaceKey: string },
): WorkspaceSidePaneState {
  const nextTab = createWorkflowArtifactSidePaneTab(options);
  const existing = current?.tabs.find(
    (tab): tab is WorkflowArtifactSidePaneTab =>
      tab.type === "workflow-artifact" && tab.id === nextTab.id,
  );
  if (existing === undefined) return activateSidePaneTab(current, nextTab);
  // **Discard the version** on the old tab when merging: missing keys in `...nextTab` will not overwrite the old value, which happens to be
  // The semantics of "chip does not carry a version number ⇒ return to the latest version" will be quietly destroyed (the old tab stops at v1, click again
  // Still stuck at v1). Explicitly delete the key so that absence is really absence.
  const merged: WorkflowArtifactSidePaneTab = { ...existing, ...nextTab };
  if (nextTab.version === undefined) delete merged.version;
  return activateSidePaneTab(current, merged);
}

export function isSidePaneTabVisibleForParent(
  tab: WorkspaceSidePaneTab,
  parentSessionId: string | null,
): boolean {
  if (tab.type === "browser-use") {
    return tab.sessionId === parentSessionId;
  }
  // Tabs belonging to a conversation (not the workspace global) are narrowed by parentSessionId.
  if (
    tab.type === "selection-side-chat" ||
    tab.type === "plan-detail" ||
    tab.type === "workflow-run" ||
    tab.type === "workflow-directory" ||
    tab.type === "workflow-actor-session" ||
    tab.type === "workflow-workspace" ||
    tab.type === "workflow-artifact"
  ) {
    return tab.parentSessionId === parentSessionId;
  }
  if (
    tab.type === "subagent-session" ||
    tab.type === "subagent-directory" ||
    tab.type === "bash-output"
  ) {
    return tab.rootSessionId === parentSessionId;
  }
  return true;
}

export function getVisibleSidePaneTabs(
  tabs: WorkspaceSidePaneTab[],
  scope: SidePaneVisibilityScope,
): WorkspaceSidePaneTab[];
export function getVisibleSidePaneTabs(
  current: WorkspaceSidePaneState | null,
  parentSessionId: string | null,
): WorkspaceSidePaneTab[];
export function getVisibleSidePaneTabs(
  input: WorkspaceSidePaneTab[] | WorkspaceSidePaneState | null,
  scopeOrParent: SidePaneVisibilityScope | string | null,
): WorkspaceSidePaneTab[] {
  if (Array.isArray(input)) {
    return getVisibleSidePaneTabsByScope(input, scopeOrParent as SidePaneVisibilityScope);
  }
  const parentSessionId = scopeOrParent as string | null;
  return input?.tabs.filter((tab) => isSidePaneTabVisibleForParent(tab, parentSessionId)) ?? [];
}

function selectSidePaneTabsForParent(
  current: WorkspaceSidePaneState | null,
  parentSessionId: string | null,
  preferredTabId?: string | null,
): WorkspaceSidePaneState | null {
  if (!current) return null;
  const visibleTabs = getVisibleSidePaneTabs(current, parentSessionId);
  if (visibleTabs.length === 0) {
    return current.activeTabId === "" ? current : { ...current, activeTabId: "" };
  }
  const preferred = preferredTabId
    ? visibleTabs.find((tab) => tab.id === preferredTabId)
    : undefined;
  const currentActive = visibleTabs.find((tab) => tab.id === current.activeTabId);
  const nextActive =
    currentActive ??
    preferred ??
    visibleTabs.findLast(
      (tab) =>
        tab.type === "subagent-session" ||
        tab.type === "subagent-directory" ||
        tab.type === "selection-side-chat" ||
        tab.type === "plan-detail" ||
        tab.type === "workflow-run" ||
        tab.type === "workflow-actor-session" ||
        tab.type === "workflow-workspace" ||
        tab.type === "workflow-artifact",
    ) ??
    visibleTabs.at(-1);
  return nextActive && nextActive.id !== current.activeTabId
    ? { ...current, activeTabId: nextActive.id }
    : current;
}

export function closeVisibleOtherSidePaneTabs(
  current: WorkspaceSidePaneState | null,
  tabId: string,
  parentSessionId: string | null,
): WorkspaceSidePaneState | null {
  if (!current) return null;
  const visibleTabs = getVisibleSidePaneTabs(current, parentSessionId);
  const target = visibleTabs.find((tab) => tab.id === tabId);
  if (!target) return current;
  const closingIds = new Set(visibleTabs.filter((tab) => tab.id !== tabId).map((tab) => tab.id));
  return {
    tabs: current.tabs.filter((tab) => !closingIds.has(tab.id)),
    activeTabId: target.id,
  };
}

export function closeVisibleSidePaneTabs(
  current: WorkspaceSidePaneState | null,
  parentSessionId: string | null,
): WorkspaceSidePaneState | null {
  if (!current) return null;
  const closingIds = new Set(getVisibleSidePaneTabs(current, parentSessionId).map((tab) => tab.id));
  const tabs = current.tabs.filter((tab) => !closingIds.has(tab.id));
  return tabs.length === 0 ? null : { tabs, activeTabId: "" };
}

export function closeSidePaneTabForParent(
  current: WorkspaceSidePaneState | null,
  tabId: string,
  parentSessionId: string | null,
  preferredTabId?: string | null,
): WorkspaceSidePaneState | null {
  const next = closeSidePaneTab(current, tabId);
  return selectSidePaneTabsForParent(next, parentSessionId, preferredTabId);
}

export function closeSidePaneTab(
  current: WorkspaceSidePaneState | null,
  tabId: string,
): WorkspaceSidePaneState | null {
  if (!current) {
    return null;
  }

  const closingIndex = findTabIndexById(current.tabs, tabId);
  if (closingIndex < 0) {
    return current;
  }

  const nextTabs = current.tabs.filter((tab) => tab.id !== tabId);
  if (nextTabs.length === 0) {
    return null;
  }

  if (current.activeTabId !== tabId) {
    return {
      tabs: nextTabs,
      activeTabId: current.activeTabId,
    };
  }

  const fallbackIndex = Math.min(closingIndex, nextTabs.length - 1);
  return {
    tabs: nextTabs,
    activeTabId: nextTabs[fallbackIndex]!.id,
  };
}

export function setActiveSidePaneTab(
  current: WorkspaceSidePaneState | null,
  tabId: string,
): WorkspaceSidePaneState | null {
  if (!current || !current.tabs.some((tab) => tab.id === tabId)) {
    return current;
  }

  return {
    ...current,
    activeTabId: tabId,
  };
}

export function updateBrowserSidePaneTab(
  current: WorkspaceSidePaneState | null,
  tabId: string,
  patch: BrowserSidePaneMetadata,
): WorkspaceSidePaneState | null {
  if (!current) {
    return current;
  }

  let didUpdate = false;
  const nextTabs = current.tabs.map((tab) => {
    if (tab.id !== tabId) {
      return tab;
    }
    if (tab.type === "browser" || tab.type === "browser-use") {
      didUpdate = true;
      return { ...tab, ...patch };
    }
    return tab;
  });

  return didUpdate
    ? {
        ...current,
        tabs: nextTabs,
      }
    : current;
}

/**
 * Matches the live state fully by workspace/session/browser generation/tab, so a stale run never
 * writes across.
 */
export function markBrowserUseSidePaneTabOperation(
  current: WorkspaceSidePaneState | null,
  options: {
    workspaceKey: string;
    sessionId: string;
    browserId: string;
    browserGeneration: number;
    tabId: string;
    operationUntil: number;
    resetsResizeBaseline?: boolean;
  },
): WorkspaceSidePaneState | null {
  if (!current) return current;
  let didUpdate = false;
  const tabs = current.tabs.map((tab) => {
    if (
      tab.type !== "browser-use" ||
      tab.workspaceKey !== options.workspaceKey ||
      tab.sessionId !== options.sessionId ||
      (tab.browserId !== undefined && tab.browserId !== options.browserId) ||
      (tab.browserGeneration !== undefined &&
        tab.browserGeneration !== options.browserGeneration) ||
      tab.tabId !== options.tabId
    ) {
      return tab;
    }
    didUpdate = true;
    return {
      ...tab,
      browserUseOperationUntil: options.operationUntil,
      ...(options.resetsResizeBaseline
        ? {
            browserUseResizeBaselineVersion: (tab.browserUseResizeBaselineVersion ?? 0) + 1,
          }
        : {}),
    };
  });
  return didUpdate ? { ...current, tabs } : current;
}

export function reorderSidePaneTab(
  current: WorkspaceSidePaneState | null,
  activeTabId: string,
  overTabId: string,
): WorkspaceSidePaneState | null {
  if (!current || activeTabId === overTabId) {
    return current;
  }

  const activeIndex = findTabIndexById(current.tabs, activeTabId);
  const overIndex = findTabIndexById(current.tabs, overTabId);
  if (activeIndex < 0 || overIndex < 0) {
    return current;
  }

  const nextTabs = [...current.tabs];
  const [movedTab] = nextTabs.splice(activeIndex, 1);
  if (!movedTab) {
    return current;
  }

  nextTabs.splice(overIndex, 0, movedTab);
  return {
    ...current,
    tabs: nextTabs,
  };
}

export function toggleBrowserSidePane(
  current: WorkspaceSidePaneState | null,
  ownerTaskId?: string | null,
  remoteSessionId?: string | null,
): WorkspaceSidePaneState | null {
  const ownerKey = sidePaneOwnerKey(ownerTaskId);
  const activeTab = getActiveSidePaneTab(current);
  if (activeTab?.type === "browser" && sidePaneOwnerKey(activeTab.ownerTaskId) === ownerKey) {
    return closeSidePaneTab(current, activeTab.id);
  }

  return activateBrowserSidePane(current, {
    ownerTaskId,
    ...(remoteSessionId ? { remoteSessionId } : {}),
  });
}

export function toggleGitSidePane(
  current: WorkspaceSidePaneState | null,
): WorkspaceSidePaneState | null {
  const activeTab = getActiveSidePaneTab(current);
  if (activeTab?.type === "git") {
    return closeSidePaneTab(current, activeTab.id);
  }

  return activateGitSidePane(current);
}

export function closeCodeViewerSidePane(
  current: WorkspaceSidePaneState | null,
): WorkspaceSidePaneState | null {
  const activeTab = getActiveSidePaneTab(current);
  return activeTab?.type === "code-viewer" ? closeSidePaneTab(current, activeTab.id) : current;
}

export function closeGitSidePane(
  current: WorkspaceSidePaneState | null,
): WorkspaceSidePaneState | null {
  return closeSidePaneTab(current, "git");
}

export function openBackgroundBashSidePane(
  current: WorkspaceSidePaneState | null,
  target: OpenBackgroundBashSideTabRequest,
): WorkspaceSidePaneState {
  const workspaceKey = target.workspaceIdentity?.trim() || target.workspacePath;
  const id =
    "bash-output:" +
    [
      workspaceKey,
      target.remoteSessionId ?? "",
      target.rootSessionId,
      target.sessionId,
      target.workId,
    ]
      .map(encodeSidePaneTabIdPart)
      .join(":");
  const existing = current?.tabs.find((tab) => tab.id === id);
  return activateSidePaneTab(
    current,
    existing ?? {
      ...target,
      id,
      type: "bash-output",
      workspaceKey,
      ownerTaskId: target.rootSessionId,
      openedAt: Date.now(),
    },
  );
}
