import type {
  AssistantTextRow,
  ConversationRow,
  TurnHeaderRow,
  UserInputRow,
} from "@zcode/shared/zcode-protocol-v4";
import type { ConversationCuaGroupRenderItem } from "@/v4/conversationCuaGroups.js";

export type AssistantWorkRow = Exclude<ConversationRow, TurnHeaderRow | UserInputRow>;

export type ConversationTurnFlowItem =
  | { kind: "userInput"; row: UserInputRow }
  | { kind: "assistantHistory"; rows: AssistantWorkRow[] }
  | { kind: "assistantText"; row: AssistantTextRow; latest: boolean }
  | { kind: "assistantWork"; rows: AssistantWorkRow[] }
  | ConversationCuaGroupRenderItem;

function isUserInputRow(row: ConversationRow): row is UserInputRow {
  return row.kind === "userInput";
}

function isAssistantTextRow(row: ConversationRow): row is AssistantTextRow {
  return row.kind === "assistantText";
}

function isAssistantWorkRow(row: ConversationRow): row is AssistantWorkRow {
  return row.kind !== "turnHeader" && row.kind !== "userInput";
}

function appendGroupedAssistantFlowItem(
  items: ConversationTurnFlowItem[],
  kind: "assistantHistory" | "assistantWork",
  row: AssistantWorkRow,
): void {
  const previous = items.at(-1);
  if (previous?.kind === kind) {
    previous.rows.push(row);
    return;
  }
  items.push({ kind, rows: [row] });
}

export function buildConversationFlowItems(options: {
  orderedRows: readonly ConversationRow[];
  assistantHistoryRows: readonly AssistantWorkRow[];
  assistantFollowingRows: readonly AssistantWorkRow[];
  assistantTailRows: readonly AssistantWorkRow[];
  /** The last text of the current visual work segment's external display. */
  visibleAssistantTextRow?: AssistantTextRow;
  /** The only final text of the entire product turn that can be linked to action. */
  latestAssistantTextRow?: AssistantTextRow;
  timelineOnly: boolean;
}): ConversationTurnFlowItem[] {
  const historyRowIds = new Set(options.assistantHistoryRows.map((row) => row.rowId));
  const followingRowIds = new Set(options.assistantFollowingRows.map((row) => row.rowId));
  const tailRowIds = new Set(options.assistantTailRows.map((row) => row.rowId));
  const items: ConversationTurnFlowItem[] = [];

  for (const row of options.orderedRows) {
    if (isUserInputRow(row)) {
      items.push({ kind: "userInput", row });
      continue;
    }
    if (!isAssistantWorkRow(row)) continue;
    // The tail boundary has been split from assistant flow into assistantTailRows; if it is added back
    // flowItems, the renderer will render it before the scheduled task card, file summary and message action bar.
    // Only the real flow is retained here; the boundary is unified by TurnGroup after all turn-local affiliated UIs.
    if (tailRowIds.has(row.rowId)) continue;
    if (
      isAssistantTextRow(row) &&
      (row.rowId === options.visibleAssistantTextRow?.rowId || !historyRowIds.has(row.rowId)) &&
      !followingRowIds.has(row.rowId) &&
      !tailRowIds.has(row.rowId) &&
      !options.timelineOnly
    ) {
      items.push({
        kind: "assistantText",
        row,
        latest: row.rowId === options.latestAssistantTextRow?.rowId,
      });
      continue;
    }
    appendGroupedAssistantFlowItem(
      items,
      historyRowIds.has(row.rowId) && !options.timelineOnly ? "assistantHistory" : "assistantWork",
      row,
    );
  }

  return items;
}
