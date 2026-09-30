import { IMPLICIT_PHASE_ID, UNPHASED_PHASE_ID } from "./types.js";
import type { LaneNameFormatter } from "./lane-name.js";

/**
 * The single policy point for phase display names, isomorphic to lane-name.ts clause by clause (one
 * thing, one set of rules): the author's wording > the localized fallback.
 *
 * The fallback must happen at render time: the projection is a memoized pure function with no
 * language dependency, so baking the copy into it would leave the string stale when the user
 * switches language mid-session. `unphased` is the only phase that cannot get a `name` — it is not
 * a word the author wrote but "the steps before the first marker", so its name is always localized.
 */

/** Everything needed to build a phase display name — no identity beyond the id. */
export interface PhaseNaming {
  id: string;
  /** The name given by `phase("preflight")` in the script; `unphased` has none. */
  name?: string;
}

export function phaseDisplayName(phase: PhaseNaming, formatMessage: LaneNameFormatter): string {
  if (phase.name !== undefined) return phase.name;
  if (phase.id === UNPHASED_PHASE_ID) {
    return formatMessage({ id: "chat.toolCall.workflow.graph.phase.unphased" });
  }
  // Implicit unique module for markup-less scripts (participant-model.ts): the entire script is a stage.
  if (phase.id === IMPLICIT_PHASE_ID) {
    return formatMessage({ id: "chat.toolCall.workflow.graph.phase.workflow" });
  }
  // Can't get here: stages other than `unphased` have the author's original words. When the time id (identity) really appears instead of "ungrouped"——
  // Calling a stage with a name a covert stage is a lie, revealing the ID is at least traceable.
  return phase.id;
}

/**
 * The display phase name is truncated by `boundGraphText` to this many characters (the contracts'
 * `CREATE_WORKFLOW_GRAPH_MAX_NAME_CHARS`), while the runtime name (entry records, an instance's
 * birth stamp) carries the full name (the reducer truncates it to the same bound itself).
 */
export const DISPLAY_PHASE_NAME_BOUND = 128;

/**
 * The only rule correlating a display phase name with a runtime phase name is an exact match; a
 * display name falls back to a prefix match **only when it lands exactly on the bound** — the
 * prefix path opens only when truncation actually happened, otherwise "plan" would wrongly match
 * "plan fix". The timeline entry records, `currentPhase` and instance binding all share it.
 *
 * Missing on either side → false: correlation needs both names, and "nameless" is not a matchable
 * name. Pairing a nameless display phase (`unphased` / implicit `workflow`) with an unstamped
 * instance is a different rule, handled explicitly by `phasesOf`.
 */
export function phaseNameMatches(
  displayName: string | undefined,
  runtimeName: string | undefined,
): boolean {
  if (displayName === undefined || runtimeName === undefined) return false;
  if (displayName === runtimeName) return true;
  return displayName.length >= DISPLAY_PHASE_NAME_BOUND && runtimeName.startsWith(displayName);
}
