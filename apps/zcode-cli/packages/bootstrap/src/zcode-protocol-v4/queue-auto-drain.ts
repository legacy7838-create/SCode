import type { GoalStatus } from "@zcode/contracts";

/**
 * The only automatic promotion gate for the ordinary queue. Fail-open does not open a bypass here: the verifier still first
 * persists the target as complete, and then shares this single decision with an explicit pass.
 */
export function shouldAutoDrainV4QueueHead(input: {
  autoDrain: boolean;
  dispatchState: "queued" | "reserved" | "promoting";
  sessionBusy: boolean;
  targetStatus: GoalStatus | null;
}): boolean {
  return (
    input.autoDrain &&
    input.dispatchState === "queued" &&
    !input.sessionBusy &&
    (input.targetStatus === null || input.targetStatus === "complete")
  );
}
