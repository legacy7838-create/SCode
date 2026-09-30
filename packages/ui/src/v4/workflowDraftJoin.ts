import type { ConversationRow, ToolCallRow } from "@zcode/shared/zcode-protocol-v4";
import type { WorkflowDraftPosition } from "@/ToolCallBlocks/shared.js";
import {
  isPlainRecord,
  readWorkflowAmendTarget,
} from "@/ToolCallBlocks/renderers/createWorkflowInput.js";
import { isAmendWorkflowToolCall, isCreateWorkflowToolCall } from "@/lib/workflowToolNames.js";

/**
 * The join table from workflow tool rows to draft position (draft number and whether it has been
 * superseded), built in one pass over the row window.
 *
 * A script that fails to compile is not a failure: nothing ran, the diagnostics went back to the
 * model, and the model resubmits once it has fixed them. The card has to say "which draft is this"
 * and "is there a newer draft after it", and neither fact lives on a single row — both can only be
 * read out of the row order. That reading is implemented in this one place, and the card only reads
 * its result.
 *
 * Rules:
 * - Lineage: the tool name, plus the predecessor `run_id` for an amend. Creates are counted between
 *   creates, and each run's amends are counted from 1 on their own;
 * - Draft number: 1 + the number of rows in the same lineage and the same round that failed to
 *   compile (`ok === false`) since the last one that compiled (`display.ok === true`); rows with no
 *   display (streaming, awaiting confirmation, rejected, cancelled) are neither counted nor do they
 *   reset the count; a new round counts from 1;
 * - Superseded: a later row of the same lineage still exists in the window (in the same round or in
 *   a later one).
 *
 * The row window is bounded: when earlier drafts slide out of the window, the draft number reads
 * low. Draft numbers are for display only and have no other reader.
 */
export function buildWorkflowDraftByToolCallId(
  rows: readonly ConversationRow[] | undefined,
): ReadonlyMap<string, WorkflowDraftPosition> {
  const byToolCallId = new Map<string, WorkflowDraftPosition>();
  // Lineage → toolCallId of the most recent line in this lineage (used to mark it as being replaced when the following line appears).
  const latestByLineage = new Map<string, string>();
  // "Pedigree + Round" → The number of consecutive failures since the last compilation.
  const failuresByLineageTurn = new Map<string, number>();

  for (const row of rows ?? []) {
    if (row.kind !== "toolCall") continue;
    const lineage = workflowDraftLineage(row);
    if (lineage === undefined) continue;

    const previous = latestByLineage.get(lineage);
    if (previous !== undefined) {
      const position = byToolCallId.get(previous);
      if (position !== undefined) byToolCallId.set(previous, { ...position, superseded: true });
    }
    latestByLineage.set(lineage, row.toolCallId);

    const turnKey = `${lineage}\u0000${row.turnId}`;
    const failures = failuresByLineageTurn.get(turnKey) ?? 0;
    byToolCallId.set(row.toolCallId, { ordinal: failures + 1, superseded: false });

    const compiled = readCompiled(row);
    if (compiled === false) failuresByLineageTurn.set(turnKey, failures + 1);
    if (compiled === true) failuresByLineageTurn.set(turnKey, 0);
  }
  return byToolCallId;
}

function workflowDraftLineage(row: ToolCallRow): string | undefined {
  if (isAmendWorkflowToolCall(row)) {
    return `amend\u0000${readWorkflowAmendTarget(row.input) ?? ""}`;
  }
  return isCreateWorkflowToolCall(row) ? "create" : undefined;
}

/**
 * Whether this row compiled: `true` / `false` is read from display, and with no display it is
 * `undefined`. The canonical location of display is `output.display`; a top-level `display` is the
 * compatibility channel for old snapshots (same precedence as `toolCallRowToLegacyNode` — once the
 * two readings diverge, the card and the draft number end up telling different stories).
 */
function readCompiled(row: ToolCallRow): boolean | undefined {
  const display: unknown = row.output?.display ?? row.display;
  if (!isPlainRecord(display) || display.kind !== "create_workflow") return undefined;
  return typeof display.ok === "boolean" ? display.ok : undefined;
}
