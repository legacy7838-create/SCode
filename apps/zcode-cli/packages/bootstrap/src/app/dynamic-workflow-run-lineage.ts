// ============================================================
// Dynamic Workflow Run's lineage reading surface (a small slice of the viewing surface)
// ============================================================
// Pointers at both ends of the revision chain: `resumedFrom` points to the predecessor,
// `supersededBy` points to the successor that stopped itself. The three sections of snapshot, list, and details must carry these two keys, and the rules only need to be written once.
// It was removed from dynamic-workflow-run-observation.ts because that file has reached the 400-line limit of oxlint.

import type { RunStatus } from "@zcode/dynamic-workflow";

/** A terminal-state view that sees only the two keys lineage needs: a registry entry's `terminal` and a journal row both satisfy it. */
interface SupersedableSettlement {
  status: RunStatus;
  supersededBy?: string;
}

/**
 * The successor pointer: the in-memory terminal state first, then the journal row; it is only meaningful for
 * stopped(superseded) — on any other status, even if the payload carries this key (which should not happen) it
 * reads as absent, so that a completed run is never drawn as "superseded".
 */
export function supersededByOf(
  entry: { terminal?: SupersedableSettlement } | undefined,
  record: { status?: RunStatus; supersededBy?: string } | undefined,
): string | undefined {
  if (entry?.terminal !== undefined) {
    return entry.terminal.status === "stopped" ? entry.terminal.supersededBy : undefined;
  }
  return record?.status === "stopped" ? record.supersededBy : undefined;
}

/** Present only when both pointers are (an absent one reads as "this end does not exist", whereas an `undefined` value would put a noise key on every row). */
export function lineageFields(
  resumedFrom: string | undefined,
  supersededBy: string | undefined,
): { resumedFrom?: string; supersededBy?: string } {
  return {
    ...(resumedFrom === undefined ? {} : { resumedFrom }),
    ...(supersededBy === undefined ? {} : { supersededBy }),
  };
}
