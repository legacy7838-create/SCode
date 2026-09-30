import type { GitRepositorySummary } from "@zcode/shared";
import type {
  BackgroundWorkSummary,
  GoalState,
  PlanState,
  RunningSubagentSummary,
  ToolCallRow,
  WorkflowRunState,
} from "@zcode/shared/zcode-protocol-v4";
import { workflowRunStepCounts } from "@zcode/shared/zcode-protocol-v4";
import { extractPlanToolCallContent, getPlanDirectoryTitle } from "@/lib/planToolCall.js";

export interface ConversationStatusPanelGitModel {
  branchName: string | null;
  headRefType: GitRepositorySummary["headRefType"];
  dirtyFileCount: number;
  added: number;
  removed: number;
  ahead: number;
  behind: number;
  isClean: boolean;
}

export interface ConversationStatusPanelPlanModel {
  items: PlanState["items"];
  displayItems: PlanState["items"];
  completedCount: number;
  waitingCount: number;
  totalCount: number;
}

export interface ConversationStatusPanelSessionPlanItem {
  rowId: number;
  toolCallId: string;
  markdown: string;
  title?: string;
  planFilePath?: string;
}

export interface ConversationStatusPanelSessionPlansModel {
  items: ConversationStatusPanelSessionPlanItem[];
}

export interface ConversationStatusPanelRunningSubagent extends RunningSubagentSummary {
  controlWorkId?: string;
  cancellable?: boolean;
}

/**
 * One row of the Workflows section.
 *
 * The fields fall into three clusters, because each of the three kinds of fact can be absent on its
 * own: `status` / `nodesSettled` / `nodesTotal` come from the `workflowRuns` projection; `title` /
 * `startedAt` are static metadata of the background work; `workId` / `cancellable` are the
 * preconditions for Stop and appear only while the background work is still running. **Absence is
 * expressed by the field not existing, rather than by 0 or an empty string** — the rendering layer
 * uses that to decide whether the row has a status word / step count, whether it has a duration,
 * and whether it can be stopped; a fake 0/0 would render as "no steps ran at all". The reason for
 * the clustering is spelled out in `buildRunningWorkflowRuns`.
 */
export interface ConversationStatusPanelWorkflowRun {
  /** Identity and React key; skewed fallback rows substitute workId (the two are ≡ anyway). */
  runId: string;
  /**
   * Absent means the row is not clickable (there is no details-page tab to open), which is the same
   * thing as the run having no toolCallId in the projection.
   */
  toolCallId?: string;
  /** A status word exists only when a run backs it; fallback rows do not have one. */
  status?: "pending" | "running";
  nodesSettled?: number;
  nodesTotal?: number;
  /**
   * The display name. **`title ≡ workId` means "unnamed"**, and the rendering layer swaps in the
   * i18n fallback name based on that: core's `workflowTaskSubject` fallback chain ends at taskId (≡
   * runId ≡ workId), while the projection copies a non-empty description into the title verbatim —
   * so "the title happens to equal the id" is the only reliable signal for unnamed. The model does
   * not do this substitution (i18n does not belong to the model layer); it only guarantees that the
   * title is passed through verbatim.
   */
  title?: string;
  startedAt?: number;
  /**
   * The control handle the stop button needs; it appears only while the work is still running
   * (finished work has nothing to cancel).
   */
  workId?: string;
  cancellable?: boolean;
}

/**
 * The intent of "open the details page of which run". The host fills in the session and workspace
 * identity; the panel is unaware of scope (it goes through the same handler as the tool card; there
 * is no second open path).
 *
 * It lives in the model file rather than in the component: the composer badge's direct-open check
 * (`resolveSoleRunningWorkflowRunTarget`) and the panel row produce the same shape, the component
 * layer takes its types from the model, and the model does not depend back on the component.
 */
export interface ConversationStatusPanelWorkflowRunTarget {
  runId: string;
  toolCallId: string;
  workflowName?: string;
}

/**
 * Panel row → open intent. No `toolCallId` means null (there is no details-page tab to open). The
 * name is only attached when it really exists: `title ≡ runId` is what an unnamed run falls back to
 * (core's workflowTaskSubject lands on taskId), and freezing the runId into the tab label is worse
 * than the generic fallback name. The panel row and the composer badge's direct open share this one
 * conversion.
 */
export function workflowRunOpenTarget(
  run: ConversationStatusPanelWorkflowRun,
): ConversationStatusPanelWorkflowRunTarget | null {
  if (!run.toolCallId) return null;
  return {
    runId: run.runId,
    toolCallId: run.toolCallId,
    ...(run.title && run.title !== run.runId ? { workflowName: run.title } : {}),
  };
}

export interface ConversationStatusPanelModel {
  hasContent: boolean;
  git: ConversationStatusPanelGitModel | null;
  goal: GoalState | null;
  sessionPlans: ConversationStatusPanelSessionPlansModel | null;
  plan: ConversationStatusPanelPlanModel | null;
  runningBashWorks: BackgroundWorkSummary[];
  runningSubagentWorks: ConversationStatusPanelRunningSubagent[];
  runningWorkflowRuns: ConversationStatusPanelWorkflowRun[];
}

interface BuildConversationStatusPanelModelInput {
  isOfficeMode?: boolean;
  gitSummary?: GitRepositorySummary | null;
  gitDirtyFileCount?: number;
  gitWorktreeChangeSummary?: { added: number; removed: number } | null;
  goal?: GoalState | null;
  sessionPlans?: readonly ToolCallRow[];
  workspacePath?: string;
  plan?: PlanState | null;
  backgroundWorks?: readonly BackgroundWorkSummary[];
  runningSubagents?: readonly RunningSubagentSummary[];
  workflowRuns?: readonly WorkflowRunState[];
}

function buildGitModel({
  gitSummary,
  gitDirtyFileCount = 0,
  gitWorktreeChangeSummary,
}: Pick<
  BuildConversationStatusPanelModelInput,
  "gitSummary" | "gitDirtyFileCount" | "gitWorktreeChangeSummary"
>): ConversationStatusPanelGitModel | null {
  if (!gitSummary?.isGitAvailable || !gitSummary.isRepository) {
    return null;
  }
  const added = gitWorktreeChangeSummary?.added ?? 0;
  const removed = gitWorktreeChangeSummary?.removed ?? 0;
  // Before v4, Git model was created as long as it was a Git repository, resulting in clean repo
  // Also hang up the status card in the upper right corner; the old ChatView only displays Git Tools when there are row-level changes in the worktree.
  if (added + removed <= 0) {
    return null;
  }
  const isClean =
    !gitSummary.isDirty &&
    gitDirtyFileCount === 0 &&
    added === 0 &&
    removed === 0 &&
    gitSummary.ahead === 0;

  return {
    branchName: gitSummary.branchName,
    headRefType: gitSummary.headRefType,
    dirtyFileCount: gitDirtyFileCount,
    added,
    removed,
    ahead: gitSummary.ahead,
    behind: gitSummary.behind,
    isClean,
  };
}

function buildPlanModel(plan: PlanState | null | undefined) {
  if (!plan || plan.items.length === 0) {
    return null;
  }
  const completed = plan.items.filter((item) => item.status === "completed");
  return {
    items: plan.items,
    // Regrouping by status will cause the Todo to jump from its original position to the end of the list when it is completed, destroying TodoWrite
    // The authoritative order of snapshots. The original array is completely retained here, and only the renderer is responsible for scrolling and state styles.
    displayItems: plan.items,
    completedCount: completed.length,
    waitingCount: plan.items.length - completed.length,
    totalCount: plan.items.length,
  };
}

function buildSessionPlansModel(
  rows: readonly ToolCallRow[] | undefined,
  workspacePath: string | undefined,
): ConversationStatusPanelSessionPlansModel | null {
  if (!rows?.length) return null;
  const items = rows
    .filter(
      (row) =>
        row.toolName === "ExitPlanMode" &&
        (row.status === "success" || row.status === "error" || row.status === "cancelled"),
    )
    .toSorted((left, right) => right.rowId - left.rowId)
    .flatMap((row) => {
      const content = extractPlanToolCallContent(row, workspacePath ?? "");
      if (!content.markdown) return [];
      const title = getPlanDirectoryTitle(content.markdown);
      return [
        {
          rowId: row.rowId,
          toolCallId: row.toolCallId,
          markdown: content.markdown,
          ...(title ? { title } : {}),
          ...(content.planFilePath ? { planFilePath: content.planFilePath } : {}),
        },
      ];
    });
  return items.length > 0 ? { items } : null;
}

/**
 * The Workflows section: active runs and workflow background works are joined by **workId ≡
 * runId**.
 *
 * That equation is not a guess; it is an existing fact written into the schema (the kind comment on
 * `backgroundWorkSummarySchema` and the "workflow" comment on `backgroundResultOriginMetaSchema`);
 * so the join matches on the primary key directly and does not need the Agent row's "prefer not to
 * show duplicated identities" disambiguation.
 *
 * Either side can be absent on its own, and absence is handled by clustering on **field meaning**
 * rather than by cutting on the work's status all at once:
 * - `title` / `startedAt` are static metadata and are taken whatever the work's status. If they
 *   were dropped as soon as the work reaches resultPending, the row of a run that is still running
 *   would flash over to the i18n fallback name and lose its duration — a purely visual failure.
 * - `workId` / `cancellable` are the preconditions for Stop and are given **only while the work is
 *   still running**: a finished work has nothing to cancel, and leaving the button there is a Stop
 *   that does nothing when clicked.
 * - Run present, work entirely absent: it still becomes a row (the status word and the step count
 *   are facts of the projection itself), just with no title / duration / Stop.
 * - Work present, run absent: the CLI is old enough not to emit the `workflowRuns` projection key.
 *   It degrades to a row with only title / duration / Stop, **appended after the run-backed rows**
 *   — it has no position in start order, and inserting it in the middle would amount to fabricating
 *   an order. The entire reason for this fallback is: **the cancel entry point must never disappear
 *   under any skew**; so a fallback row only takes running works — the one with neither a run nor a
 *   still-running work has nothing actionable, and showing it would just be a dead row.
 */
function buildRunningWorkflowRuns(
  runs: readonly WorkflowRunState[] | undefined,
  workflowWorkByWorkId: ReadonlyMap<string, BackgroundWorkSummary>,
): ConversationStatusPanelWorkflowRun[] {
  const rows: ConversationStatusPanelWorkflowRun[] = [];
  const joinedWorkIds = new Set<string>();
  for (const run of runs ?? []) {
    // pending is also an active state: the run has started, but the first node has not been distributed yet. Hiding it is equivalent to letting the user
    // I see a blank window between "Workflow started" and "Panel appears".
    if (run.status !== "pending" && run.status !== "running") continue;
    const work = workflowWorkByWorkId.get(run.runId);
    if (work) joinedWorkIds.add(run.runId);
    // Counting has the same origin as the chat compact card (the only implementation is workflowRunStepCounts in @zcode/shared: inside the table + outside the table).
    const steps = workflowRunStepCounts(run);
    rows.push({
      runId: run.runId,
      ...(run.toolCallId ? { toolCallId: run.toolCallId } : {}),
      status: run.status,
      nodesSettled: steps.settled,
      nodesTotal: steps.total,
      ...(work ? { title: work.title, startedAt: work.startedAt } : {}),
      ...(work?.status === "running"
        ? {
            workId: work.workId,
            // The default is to stop, which is the same as Agent line `!== false`: being able to stop without giving a button is worse than the other way around.
            cancellable: work.cancellable !== false,
          }
        : {}),
    });
  }
  // Order = projection runs Order = startup order, models are not sorted; reordering causes panel rows to jump each time the projection is updated.
  for (const [workId, work] of workflowWorkByWorkId) {
    if (joinedWorkIds.has(workId) || work.status !== "running") continue;
    rows.push({
      runId: workId,
      workId,
      title: work.title,
      startedAt: work.startedAt,
      cancellable: work.cancellable !== false,
    });
  }
  return rows;
}

/**
 * Composer badge direct open: when the running state of this conversation is **exactly** one
 * workflow run that has a details page to open, return its open intent; otherwise null, and the
 * badge falls back to the expanding capsule.
 *
 * Every condition has a reason: zero terminals / subagents — the badge is their only entry point,
 * and a direct open would hide them; exactly one workflow — with two or more, which one to pick is
 * the user's business; carrying a `toolCallId` — fallback rows (work present, run absent) and runs
 * from old CLIs have no details page to open, which is the same thing as the panel row being "not
 * clickable", so falling back to the capsule keeps Stop reachable. The input is exactly the product
 * of `buildConversationStatusPanelModel`: the badge and the capsule share one source of truth for
 * the running state.
 */
export function resolveSoleRunningWorkflowRunTarget(
  model: Pick<
    ConversationStatusPanelModel,
    "runningBashWorks" | "runningSubagentWorks" | "runningWorkflowRuns"
  >,
): ConversationStatusPanelWorkflowRunTarget | null {
  if (model.runningBashWorks.length > 0 || model.runningSubagentWorks.length > 0) return null;
  if (model.runningWorkflowRuns.length !== 1) return null;
  return workflowRunOpenTarget(model.runningWorkflowRuns[0]!);
}

export function buildConversationStatusPanelModel(
  input: BuildConversationStatusPanelModelInput,
): ConversationStatusPanelModel {
  const git = input.isOfficeMode ? null : buildGitModel(input);
  const goal = input.goal ?? null;
  const sessionPlans = buildSessionPlansModel(input.sessionPlans, input.workspacePath);
  const plan = buildPlanModel(input.plan);
  const runningBashWorks: BackgroundWorkSummary[] = [];
  const workflowWorkByWorkId = new Map<string, BackgroundWorkSummary>();
  const subagentControlByChildSessionId = new Map<string, BackgroundWorkSummary | null>();
  for (const work of input.backgroundWorks ?? []) {
    if (work.kind === "workflow") {
      // "workflow" (workflow run) was once listed under Terminals with bash, which was a recorded error that preserved the stop entry;
      // Now it has its own Workflows partition, so just enter the workflow join table by workId ≡ runId.
      // Staying in runningBashWorks means letting the same run appear once in both partitions.
      //
      // This branch is closed before the running gate: the title and start time are still valid for the completed work (see
      // The clustering description of buildRunningWorkflowRuns), the judgment of status is left there to be done by field. workId is
      // If the primary key is repeated, the upstream is damaged and no disambiguation is performed.
      workflowWorkByWorkId.set(work.workId, work);
      continue;
    }
    if (work.status !== "running") continue;
    if (work.kind === "bash") {
      runningBashWorks.push(work);
    } else if (work.kind === "subagent" && work.childSessionId) {
      // After directory projection takes over Agent display, the workId/cancellable of the old backgroundWorks
      // It is not associated back, causing the Stop entrance to disappear. Accepts only unique childSessionId exact matches; duplicates or
      // It is better not to display the control when the identity is missing than to guess and stop the wrong task by title and time.
      const existing = subagentControlByChildSessionId.get(work.childSessionId);
      subagentControlByChildSessionId.set(
        work.childSessionId,
        existing === undefined ? work : null,
      );
    }
  }
  const runningSubagentWorks: ConversationStatusPanelRunningSubagent[] = (
    input.runningSubagents ?? []
  ).map((subagent) => {
    const controlWork = subagentControlByChildSessionId.get(subagent.childSessionId);
    if (!controlWork) return subagent;
    return {
      ...subagent,
      controlWorkId: controlWork.workId,
      cancellable: controlWork.cancellable !== false,
    };
  });
  const projectedChildSessionIds = new Set(
    runningSubagentWorks.map((subagent) => subagent.childSessionId),
  );
  for (const [childSessionId, controlWork] of subagentControlByChildSessionId) {
    if (!controlWork || projectedChildSessionIds.has(childSessionId)) continue;
    // backgroundWorks already has the exact childSessionId running fact, but
    // The short window for subagents cold/live projection handover may be temporarily missing; the old model will control the Agent
    // Entirely hidden. Here only the authoritative work with unique identity is used to complete the same control, and duplicate identities still refuse to guess.
    runningSubagentWorks.push({
      agentId: controlWork.workId,
      childSessionId,
      controlWorkId: controlWork.workId,
      subagentType: "subagent",
      title: controlWork.title,
      status: controlWork.blocked ? "blocked" : "running",
      startedAt: controlWork.startedAt,
      cancellable: controlWork.cancellable !== false,
    });
  }

  const runningWorkflowRuns = buildRunningWorkflowRuns(input.workflowRuns, workflowWorkByWorkId);

  return {
    git,
    goal,
    sessionPlans,
    plan,
    runningBashWorks,
    runningSubagentWorks,
    runningWorkflowRuns,
    hasContent: Boolean(
      git ||
      goal ||
      sessionPlans ||
      plan ||
      runningBashWorks.length > 0 ||
      runningSubagentWorks.length > 0 ||
      runningWorkflowRuns.length > 0,
    ),
  };
}
