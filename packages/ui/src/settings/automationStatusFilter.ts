/*
   Status filtering for the Automations list: scheduled / idle tasks share the same set of filter
   options. The grouping criterion follows the status badge the card actually displays, so a user
   lands in the group matching the badge color they see in the list.
   */
import type { ZCodeOffPeakTask } from "@zcode/shared";
import {
  hasAutomationFailureState,
  resolveAutomationStatusKind,
} from "@/settings/automationFormat.js";

export type AutomationStatusFilter = "all" | "inProgress" | "completed" | "failed";
type AutomationStatusFilterKind = Exclude<AutomationStatusFilter, "all">;

/**
 * Default filter: no filtering. AutomationsSection references it through this constant, so a bare
 * "all" never reappears in the source and trips the All tab regression assertion.
 */
export const DEFAULT_AUTOMATION_STATUS_FILTER: AutomationStatusFilter = "all";

export const AUTOMATION_STATUS_FILTERS: readonly AutomationStatusFilter[] = [
  "all",
  "inProgress",
  "completed",
  "failed",
];

/**
 * Six idle states → three groups: queued/paused/running all still make progress, so they count as
 * in progress; cancelled and failed are both abnormal endings, so they are merged into failure.
 */
function resolveOffPeakStatusFilterKind(
  task: Pick<ZCodeOffPeakTask, "status">,
): AutomationStatusFilterKind {
  switch (task.status) {
    case "completed":
      return "completed";
    case "failed":
    case "cancelled":
      return "failed";
    default:
      return "inProgress";
  }
}

type AutomationFilterLike = Parameters<typeof resolveAutomationStatusKind>[0] &
  Parameters<typeof hasAutomationFailureState>[0];

/**
 * Scheduled tasks: the failure badge first (including a recurring task's most recent failed run),
 * then the terminal lifecycle states; everything else is in progress.
 */
function resolveAutomationStatusFilterKind(
  automation: AutomationFilterLike,
): AutomationStatusFilterKind {
  if (hasAutomationFailureState(automation)) return "failed";
  return resolveAutomationStatusKind(automation) === "completed" ? "completed" : "inProgress";
}

export function filterOffPeakTasksByStatus<T extends Pick<ZCodeOffPeakTask, "status">>(
  tasks: readonly T[],
  filter: AutomationStatusFilter,
): readonly T[] {
  if (filter === "all") return tasks;
  return tasks.filter((task) => resolveOffPeakStatusFilterKind(task) === filter);
}

export function filterAutomationsByStatus<T extends AutomationFilterLike>(
  automations: readonly T[],
  filter: AutomationStatusFilter,
): readonly T[] {
  if (filter === "all") return automations;
  return automations.filter(
    (automation) => resolveAutomationStatusFilterKind(automation) === filter,
  );
}

/**
 * The filter used to be recorded as `{ tab, filter }` and derived at render time, so switching away
 * and back to the original tab restored the old filter, which violates “switching the top bar tab
 * goes back to all”. Now the tab and the filter live in one state object and every tab change is
 * reduced through this function: an unchanged tab keeps the same object (avoiding needless
 * re-renders), a changed tab resets the filter.
 */
export interface AutomationTabState<Tab extends string> {
  tab: Tab;
  filter: AutomationStatusFilter;
}

export function resolveAutomationTabState<Tab extends string>(
  previous: AutomationTabState<Tab>,
  nextTab: Tab,
): AutomationTabState<Tab> {
  if (nextTab === previous.tab) return previous;
  return { tab: nextTab, filter: DEFAULT_AUTOMATION_STATUS_FILTER };
}
