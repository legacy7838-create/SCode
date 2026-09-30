import type {
  ConversationRow,
  TurnHeaderRow,
  UserInputRow,
  WorkflowLaunchMeta,
} from "@zcode/shared/zcode-protocol-v4";

/**
 * The rules for a hub direct-launch turn in the transcript.
 *
 * Launch metadata in turnHeader wins (the live projection is authoritative), falling back to the
 * same data on the user-visible row (cold-recovery hydration also writes to the userInput row).
 * When the metadata is present, that turn's workflowLaunch user row is **not** visible input — its
 * body is a canonical English sentence aimed at the model, and the turn is presented by the run
 * card; when both are absent it falls back to normal rendering (that sentence becomes a bubble).
 */
export function resolveWorkflowLaunchMeta(
  header: TurnHeaderRow | undefined,
  userInputs: readonly UserInputRow[],
): WorkflowLaunchMeta | undefined {
  if (header?.origin !== "workflowLaunch") return undefined;
  return (
    header.workflowLaunch ??
    userInputs.find((row) => row.workflowLaunch !== undefined)?.workflowLaunch
  );
}

/**
 * The user row of a launch turn: when the metadata is present the run card speaks for it, so it
 * enters neither the visible input nor the stream.
 */
export function isWorkflowLaunchUserInputRow(row: ConversationRow): boolean {
  return row.kind === "userInput" && row.origin === "workflowLaunch";
}
