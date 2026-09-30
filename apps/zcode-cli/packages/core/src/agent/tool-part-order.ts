import type { ToolPart } from "@zcode/contracts";

export function selectToolPartsForHistory(parts: ToolPart[]): ToolPart[] {
  // If the early execution fails or the recovery is interrupted, another part will be created; the same statement will only restore the last newly created record, and the late update of the old part will not affect the selection.
  // The physical order of the selected records is preserved, and the original parts are still available for UI and file read state recovery.
  const latestByCallId = new Map(parts.map((part) => [part.callID, part]));
  const latestParts = parts.filter((part) => latestByCallId.get(part.callID) === part);
  if (latestParts.some((part) => part.declarationIndex === undefined)) {
    // Older records or mixed versions may be missing declaration sequence numbers, and the entire set retains its original sequence.
    return latestParts;
  }
  // Read-only tools may be shipped first; provider calls/results should share the same declaration order without changing the original parts of the UI.
  return latestParts.sort((left, right) => left.declarationIndex! - right.declarationIndex!);
}
