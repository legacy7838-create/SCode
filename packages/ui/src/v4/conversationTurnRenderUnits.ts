import type {
  AssistantTextRow,
  ConversationRow,
  HookInvocationRow,
  SessionPhase,
  TimelineMarkerRow,
  TurnHeaderRow,
  UserInputRow,
  WorkflowLaunchMeta,
} from "@zcode/shared/zcode-protocol-v4";
import type { AssistantWorkRow, ConversationTurnFlowItem } from "@/v4/conversationTurnFlowItems.js";
import {
  isWorkflowLaunchUserInputRow,
  resolveWorkflowLaunchMeta,
} from "@/v4/workflowLaunchTurn.js";
import {
  buildConversationTurnWorkSegments,
  resolveConversationTurnWorkDurationMs,
  resolveConversationTurnWorkStatus,
} from "@/v4/conversationTurnWorkSegments.js";
import type {
  ConversationTurnWorkSegment,
  ConversationTurnWorkStatus,
} from "@/v4/conversationTurnWorkSegments.js";

export type { AssistantWorkRow, ConversationTurnFlowItem } from "@/v4/conversationTurnFlowItems.js";
export type {
  ConversationTurnWorkSegment,
  ConversationTurnWorkStatus,
} from "@/v4/conversationTurnWorkSegments.js";

export interface ConversationTurnRenderUnit {
  key: string;
  turnId: string;
  header?: TurnHeaderRow;
  visibleUserInputs: UserInputRow[];
  assistantWorkRows: AssistantWorkRow[];
  /**
   * Historical row aggregation of all visual work segments, compatible with copy, preview, and legacy calls only.
   * The actual fold boundaries read workSegments, and the CLI row order must be maintained within each segment.
   */
  assistantHistoryRows: AssistantWorkRow[];
  /** Operate the row after the text anchor point and before the real tail marker; keep the CLI in full order and render in place. */
  assistantFollowingRows: AssistantWorkRow[];
  assistantTailRows: AssistantWorkRow[];
  /** Browser automatic tail screenshot: the completion state is rendered after the file diff summary and before the message action bar. */
  browserTurnEndRows: AssistantWorkRow[];
  /** turn-local Hook product rows; does not enter assistant work/folding, only provides detailed actions at the end of the wheel. */
  hookInvocations: HookInvocationRow[];
  /** All assistant text segments in the entire round, used for copy/preview aggregation, do not represent the rendering position. */
  assistantTextRows: AssistantTextRow[];
  /** Light border (modelChange): Render the wheel top separation before user input. */
  leadingBoundaryRows: TimelineMarkerRow[];
  /** The final text at the end of the completed state; fork/retry/action/preview only hangs this paragraph. */
  latestAssistantTextRow?: AssistantTextRow;
  /** Visible staggered order of user/assistant within the same product turn; adjacent work lines remain grouped. */
  flowItems: ConversationTurnFlowItem[];
  /** The original input and each accepted guide correspond to an independent visual work segment. */
  workSegments?: ConversationTurnWorkSegment[];
  renderRows: ConversationRow[];
  isLastTurn: boolean;
  isRunning: boolean;
  assistantHistoryDefaultOpen: boolean;
  timelineOnly: boolean;
  /** Turn-level aggregated work status is only compatible with old calls; new components consume workSegments[].workStatus. */
  workStatus?: ConversationTurnWorkStatus;
  startedAt?: number;
  /** The hub directly launches the launch metadata of the wheel (see `workflowLaunchTurn.ts` for rules); when present, the wheel is presented by a run card and has no user bubble. */
  workflowLaunch?: WorkflowLaunchMeta;
}

interface BuildConversationTurnRenderUnitsOptions {
  nowMs?: number;
  sessionPhase?: SessionPhase;
}

interface DraftTurnRenderUnit {
  key: string;
  turnId: string;
  header?: TurnHeaderRow;
  userInputs: UserInputRow[];
  assistantWorkRows: AssistantWorkRow[];
  hookInvocations: HookInvocationRow[];
  orderedRows: ConversationRow[];
}

function isAssistantTextRow(row: ConversationRow): row is AssistantTextRow {
  return row.kind === "assistantText";
}

function isTurnHeaderRow(row: ConversationRow): row is TurnHeaderRow {
  return row.kind === "turnHeader";
}

function isUserInputRow(row: ConversationRow): row is UserInputRow {
  return row.kind === "userInput";
}

function isTimelineMarkerRow(row: ConversationRow): row is TimelineMarkerRow {
  return row.kind === "timelineMarker";
}

function isHookInvocationRow(row: ConversationRow): row is HookInvocationRow {
  return row.kind === "hookInvocation";
}

function isVisibleAssistantWorkRow(row: AssistantWorkRow): boolean {
  if (row.kind === "reasoning" && row.text.trim().length === 0) {
    // reasoning_start/reasoning_end may form an empty final state block; only shared
    // The render-unit boundary clips it to prevent the completed state from bypassing the streaming renderer's empty line filtering.
    return false;
  }
  // EnterPlanMode is just an internal mode switching boundary. Put it into "Worked" as a normal tool.
  // A "Tool call executed" message with no user value will be displayed. Only filter in render unit, do not rewrite protocol projection,
  // To retain the running state and recovery semantics shared by desktop continuous / web remote replayable.
  return row.kind !== "toolCall" || row.toolName !== "EnterPlanMode";
}

function isVisibleConversationRow(row: ConversationRow): boolean {
  if (isUserInputRow(row)) return true;
  if (isTurnHeaderRow(row)) return false;
  if (isHookInvocationRow(row)) return false;
  return isVisibleAssistantWorkRow(row);
}

// The placement semantics (lane) are issued by the CLI projection decision (the UI must not infer it by itself based on the marker type).
// lane Default (should not happen) by assistantWork - demote into folding group without losing rows.
function isTurnEndingTimelineMarkerRow(row: AssistantWorkRow): row is TimelineMarkerRow {
  return row.kind === "timelineMarker" && row.lane === "turnTailBoundary";
}

/**
 * The artifact line is the output of the shared projection appended to the end of the wheel (insertDiscoveredArtifacts inserted in this
 * after the last row of productTurn), but it also belongs to AssistantWorkRow and will become the last row of the flow.
 * Therefore, the hidden condition of the folding anchor point "the last line is assistantText" becomes invalid - public projection prohibits actions.
 * The sharing page only has this bottom line - the final reply is rolled into "Worked" and expanded by default throughout the round.
 *
 * It is an additional output and does not belong to the dialogue flow. It can be processed at the end of the round; the same is true for the browserTurnEndRows screenshot of the end of the round.
 * Note that you cannot change it to "get the last assistantText in the flow": that will cause CUA to respond to the text in the middle.
 * Promote to final reply and break up groups with the same assistantResponseId.
 */
function isTurnTrailingArtifactRow(row: AssistantWorkRow): boolean {
  return row.kind === "artifact";
}

function splitTurnTailRows(rows: readonly AssistantWorkRow[]): {
  flowRows: AssistantWorkRow[];
  tailRows: AssistantWorkRow[];
} {
  let tailStart = rows.length;
  while (
    tailStart > 0 &&
    (isTurnEndingTimelineMarkerRow(rows[tailStart - 1]!) ||
      isTurnTrailingArtifactRow(rows[tailStart - 1]!))
  ) {
    tailStart -= 1;
  }
  return {
    flowRows: rows.slice(0, tailStart),
    tailRows: rows.slice(tailStart),
  };
}

function isBrowserTurnEndRow(row: AssistantWorkRow): boolean {
  // Automatically screenshot the completed tool row and persist it after the final text. The old grouping only
  // The timeline boundary is recognized as the end of the wheel, causing the screenshot to be moved into the "Worked" folding area above and invisible.
  return (
    row.kind === "toolCall" &&
    row.display?.kind === "node_repl_images" &&
    row.display.source === "browser_turn_end"
  );
}

function isLightBoundaryMarkerRow(row: AssistantWorkRow): row is TimelineMarkerRow {
  return row.kind === "timelineMarker" && row.lane === "lightBoundary";
}

function isCompletionBlockingWorkRowRunning(row: AssistantWorkRow): boolean {
  switch (row.kind) {
    case "assistantText":
    case "reasoning":
      return row.state === "streaming";
    case "toolCall":
      return (
        row.backgrounded !== true &&
        (row.status === "inputStreaming" ||
          row.status === "pendingApproval" ||
          row.status === "running")
      );
    case "subagent":
      return row.backgrounded !== true && row.status === "running";
    case "timelineMarker":
      return "status" in row.marker && row.marker.status === "running";
    default:
      return false;
  }
}

function resolveTurnRunning(
  draft: DraftTurnRenderUnit,
  options: BuildConversationTurnRenderUnitsOptions,
): boolean {
  if (draft.header) {
    if (draft.header.executionKind === "controlOnly") return false;
    // turnHeader is the projection's authoritative turn boundary; a finalized main turn cannot be
    // The background tool/subagent lines that are still running in the same round are re-pushed to running.
    return draft.header.state === "running";
  }
  if (
    options.sessionPhase === "completedSuccess" ||
    options.sessionPhase === "completedInterrupted" ||
    options.sessionPhase === "error"
  ) {
    // The turnHeader may be cropped when the cold snapshot only retains the tail window; the old fallback will
    // The isolated inputStreaming/running tool row is re-deployed as thinking, and the final state control must take priority.
    return false;
  }
  // Only compatible with older projections that lack a turnHeader; background-only work does not block the main turn from completing.
  return draft.assistantWorkRows.some(isCompletionBlockingWorkRowRunning);
}

function shouldForceOpenAbnormalHistory(
  header: TurnHeaderRow | undefined,
  sessionPhase: SessionPhase | undefined,
): boolean {
  if (header) {
    return header.state === "completedInterrupted" || header.state === "failed";
  }
  return sessionPhase === "completedInterrupted" || sessionPhase === "error";
}

function materializeDraftUnit(
  draft: DraftTurnRenderUnit,
  index: number,
  total: number,
  options: BuildConversationTurnRenderUnitsOptions,
): ConversationTurnRenderUnit {
  const workflowLaunch = resolveWorkflowLaunchMeta(draft.header, draft.userInputs);
  // The user line that launches the wheel is represented by the run card, which takes no visible input or streams.
  const renderedRows =
    workflowLaunch === undefined
      ? draft.orderedRows
      : draft.orderedRows.filter((row) => !isWorkflowLaunchUserInputRow(row));
  const visibleUserInputs = renderedRows.filter(isUserInputRow);
  const visibleAssistantWorkRows = draft.assistantWorkRows.filter(isVisibleAssistantWorkRow);
  const visibleOrderedRows = renderedRows.filter(isVisibleConversationRow);
  const timelineOnly =
    visibleUserInputs.length === 0 &&
    visibleAssistantWorkRows.length > 0 &&
    visibleAssistantWorkRows.every(isTimelineMarkerRow);

  // modelChange is the light border on the top of the wheel, which is rendered before user input and does not enter the workflow.
  const leadingBoundaryRows = timelineOnly
    ? []
    : visibleAssistantWorkRows.filter(isLightBoundaryMarkerRow);
  const leadingBoundaryRowIds = new Set(leadingBoundaryRows.map((row) => row.rowId));
  const bodyRows = timelineOnly
    ? visibleAssistantWorkRows
    : visibleAssistantWorkRows.filter((row) => !isLightBoundaryMarkerRow(row));
  // Browser's automatic screenshot will skip the file diff summary and become the last content block, so it is extracted separately first;
  // The remaining rows are still processed in CLI full order, and only the continuous real tail marker suffixes can be detached from the flow.
  const browserTurnEndRows: AssistantWorkRow[] = [];
  const nonBrowserRows: AssistantWorkRow[] = [];
  if (!timelineOnly) {
    for (const row of bodyRows) {
      if (isBrowserTurnEndRow(row)) {
        browserTurnEndRows.push(row);
      } else {
        nonBrowserRows.push(row);
      }
    }
  }
  // You cannot use filter to extract all turnTailBoundary and force ExitPlanMode into tail.
  // The plan and intermediate markers will be moved from the original tool row to the bottom of the wheel. The remaining rows must remain in the flow.
  const { flowRows, tailRows: assistantTailRows } = timelineOnly
    ? { flowRows: [], tailRows: [] }
    : splitTurnTailRows(nonBrowserRows);

  const isLastTurn = index === total - 1;
  const isRunning = resolveTurnRunning(draft, options);
  const isInterrupted = draft.header
    ? draft.header.state === "completedInterrupted"
    : options.sessionPhase === "completedInterrupted";
  // The old expansion rules only look at running and the final text. Once the abnormal final state is retained, partial assistant text
  // It will be closed as normal completion, hiding the interrupt/failure context. The final state must be authoritative with header; cold recovery
  // The session phase will be rolled back only when the header is missing in the tail window. Desktop continuous and mobile replayable share this boundary.
  const forceOpenHistory = shouldForceOpenAbnormalHistory(draft.header, options.sessionPhase);

  // The final body of the product turn remains the only action target; the visual workpiece only changes the fold boundaries.
  const assistantTextRows = flowRows.filter(isAssistantTextRow);
  const actionAssistantTextRow = assistantTextRows.find(
    (row) => row.actions?.canFork === true || row.actions?.canRetry === true,
  );
  const lastFlowRow = flowRows.at(-1);
  const latestAssistantTextRow =
    actionAssistantTextRow ??
    (!isRunning && lastFlowRow && isAssistantTextRow(lastFlowRow) ? lastFlowRow : undefined);
  const workDurationMs = resolveConversationTurnWorkDurationMs(draft.header, options, isRunning);
  const workStatus = resolveConversationTurnWorkStatus(
    draft.header,
    bodyRows,
    isRunning,
    workDurationMs,
    isInterrupted,
  );
  const browserTurnEndRowIds = new Set(browserTurnEndRows.map((row) => row.rowId));
  const orderedBodyRows = visibleOrderedRows.filter(
    // main's workSegments will rebuild the flow from orderedRows; if here only from
    // bodyRows extracts the screenshot, it will still be stuffed back into the body stream and rendered again at the end of the round, causing duplication and disordered order.
    (row) => !leadingBoundaryRowIds.has(row.rowId) && !browserTurnEndRowIds.has(row.rowId),
  );
  const workSegments = buildConversationTurnWorkSegments({
    key: draft.key,
    header: draft.header,
    orderedRows: orderedBodyRows,
    assistantTailRows,
    latestAssistantTextRow,
    isRunning,
    isLastTurn,
    isInterrupted,
    forceOpenHistory,
    timelineOnly,
    nowMs: options.nowMs,
  });
  const orderedAssistantHistoryRows = workSegments.flatMap(
    (segment) => segment.assistantHistoryRows,
  );
  const assistantFollowingRows = workSegments.flatMap((segment) => segment.assistantFollowingRows);
  const flowItems = workSegments.flatMap((segment) => segment.flowItems);
  const mustOpenHistory = workSegments.at(-1)?.assistantHistoryDefaultOpen ?? false;
  return {
    key: draft.key,
    turnId: draft.turnId,
    ...(draft.header ? { header: draft.header } : {}),
    visibleUserInputs,
    // The light border is already independently carried by leadingBoundaryRows and can no longer be counted as assistant work.
    assistantWorkRows: bodyRows,
    assistantHistoryRows: orderedAssistantHistoryRows,
    assistantFollowingRows,
    assistantTailRows,
    browserTurnEndRows,
    hookInvocations: draft.hookInvocations,
    assistantTextRows,
    leadingBoundaryRows,
    ...(latestAssistantTextRow ? { latestAssistantTextRow } : {}),
    flowItems,
    workSegments,
    // renderRows is a flat view used for search/diagnosis and must also obey the CLI row order.
    renderRows: visibleOrderedRows,
    isLastTurn,
    isRunning,
    assistantHistoryDefaultOpen: mustOpenHistory,
    timelineOnly,
    ...(workStatus ? { workStatus } : {}),
    ...(draft.header ? { startedAt: draft.header.startedAt } : {}),
    ...(workflowLaunch ? { workflowLaunch } : {}),
  };
}

function createDraftUnit(turnId: string): DraftTurnRenderUnit {
  return {
    // The cold snapshot may be truncated from the middle of the assistant/tool line of the same turn and filled in
    // The first visible rowId will change after turnHeader. The virtual list key must only rely on the protocol stable turnId,
    // Otherwise, the supplementary page will reattach the original turn as a new node, losing the height measurement cache and viewport anchor point.
    key: turnId,
    turnId,
    userInputs: [],
    assistantWorkRows: [],
    hookInvocations: [],
    orderedRows: [],
  };
}

function shouldKeepRenderUnit(unit: ConversationTurnRenderUnit): boolean {
  // After the invisible rows are cleared (the projection no longer produces non-renderable markers), any work row can be rendered;
  // "Which markers can be rendered" is no longer a UI decision.
  return (
    unit.visibleUserInputs.length > 0 ||
    unit.assistantWorkRows.length > 0 ||
    unit.hookInvocations.some((row) => row.executions.some((execution) => execution.didExecute)) ||
    unit.leadingBoundaryRows.length > 0 ||
    // Launch the wheel directly: the user row is invisible, no helper content, the wheel is presented by the run card - which of course remains.
    unit.workflowLaunch !== undefined ||
    unit.isRunning
  );
}

function normalizeRenderUnitPosition(
  unit: ConversationTurnRenderUnit,
  index: number,
  total: number,
  options: BuildConversationTurnRenderUnitsOptions,
): ConversationTurnRenderUnit {
  const isLastTurn = index === total - 1;
  const forceOpenHistory = shouldForceOpenAbnormalHistory(unit.header, options.sessionPhase);
  const assistantHistoryDefaultOpen =
    unit.workSegments && unit.workSegments.length > 0
      ? !unit.timelineOnly &&
        (forceOpenHistory ||
          (isLastTurn && unit.workSegments.at(-1)?.workStatus?.state === "running") ||
          (unit.workSegments.length === 1 &&
            unit.latestAssistantTextRow === undefined &&
            unit.assistantWorkRows.length > 0))
      : !unit.timelineOnly &&
        (forceOpenHistory ||
          (isLastTurn && unit.workStatus?.state === "running") ||
          (unit.latestAssistantTextRow === undefined && unit.assistantWorkRows.length > 0));
  const workSegments = unit.workSegments?.map((segment, segmentIndex, segments) =>
    segmentIndex === segments.length - 1
      ? {
          ...segment,
          assistantHistoryDefaultOpen:
            !unit.timelineOnly &&
            (forceOpenHistory ||
              (isLastTurn && segment.workStatus?.state === "running") ||
              (segments.length === 1 &&
                unit.latestAssistantTextRow === undefined &&
                segment.assistantWorkRows.length > 0)),
        }
      : segment,
  );
  if (
    unit.isLastTurn === isLastTurn &&
    unit.assistantHistoryDefaultOpen === assistantHistoryDefaultOpen &&
    workSegments?.at(-1)?.assistantHistoryDefaultOpen ===
      unit.workSegments?.at(-1)?.assistantHistoryDefaultOpen
  ) {
    return unit;
  }
  return {
    ...unit,
    isLastTurn,
    assistantHistoryDefaultOpen,
    ...(workSegments ? { workSegments } : {}),
  };
}

export function buildConversationTurnRenderUnits(
  rows: readonly ConversationRow[],
  options: BuildConversationTurnRenderUnitsOptions = {},
): ConversationTurnRenderUnit[] {
  const units: DraftTurnRenderUnit[] = [];
  const unitByTurnId = new Map<string, DraftTurnRenderUnit>();

  const getOrCreateUnit = (turnId: string) => {
    const existing = unitByTurnId.get(turnId);
    if (existing) {
      return existing;
    }
    const unit = createDraftUnit(turnId);
    units.push(unit);
    unitByTurnId.set(turnId, unit);
    return unit;
  };

  for (const row of rows) {
    const unit = getOrCreateUnit(row.turnId);
    if (isTurnHeaderRow(row)) {
      unit.header = row;
      continue;
    }
    unit.orderedRows.push(row);
    if (isUserInputRow(row)) {
      unit.userInputs.push(row);
      continue;
    }
    if (isHookInvocationRow(row)) {
      unit.hookInvocations.push(row);
      continue;
    }
    unit.assistantWorkRows.push(row);
  }

  const materializedUnits = units.map((unit, index) =>
    materializeDraftUnit(unit, index, units.length, options),
  );
  const keptUnits = materializedUnits.filter(shouldKeepRenderUnit);
  return keptUnits.map((unit, index) =>
    normalizeRenderUnitPosition(unit, index, keptUnits.length, options),
  );
}
