import type { ZCodeOffPeakTask } from "@zcode/shared";
import type { IntlInstance } from "@/i18n/IntlProvider.js";
import type { OffPeakTakeNumberAvailabilityStatus } from "@/store/offPeakTaskStore.js";

export type OffPeakCreateBlockReason = "plan" | "quota" | "unavailable";

/**
 * The reason off-peak creation is disabled is a long hint and cannot reuse the single-line layout
 * of the generic short Tooltip.
 */
export const OFF_PEAK_CREATE_TOOLTIP_CLASSNAME =
  "max-w-[220px] [&>span]:break-words [&>span]:whitespace-normal [&>span]:text-wrap-pretty";

/**
 * Creation is only let through once the server has successfully confirmed that a number can be
 * taken; every other eligibility and dependency state fails closed.
 */
export function resolveOffPeakCreateBlockReason({
  availabilityStatus,
  canTakeNumber,
  grayEnabled,
  noPlan,
}: {
  availabilityStatus: OffPeakTakeNumberAvailabilityStatus;
  canTakeNumber: boolean | undefined;
  grayEnabled: boolean;
  noPlan: boolean;
}): OffPeakCreateBlockReason | null {
  if (!grayEnabled) return null;
  if (availabilityStatus === "loading" || availabilityStatus === "error") {
    return "unavailable";
  }
  if (noPlan) return "plan";
  if (availabilityStatus !== "ready") return "unavailable";
  return canTakeNumber === true ? null : "quota";
}

/**
 * Convert the server's absolute resume point into a localized remaining duration expressed only in
 * hours/minutes.
 */
export function formatOffPeakRemainingWait(
  nextTakeAt: number,
  now: number,
  intl: IntlInstance,
): string {
  const remainingMs = nextTakeAt - now;
  if (remainingMs <= 0) {
    return intl.formatMessage({
      id: "offPeak.create.remaining.lessThanMinute",
    });
  }

  // The old Tooltip directly displays the year, month and day, the copy is too long and the user has to convert the waiting time by himself.
  // Round minutes up to avoid displaying 0 minutes or underestimating the server-side recovery point when there are still tens of seconds to wait.
  const totalMinutes = Math.ceil(remainingMs / 60_000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours > 0 && minutes > 0) {
    return intl.formatMessage({ id: "offPeak.create.remaining.hoursMinutes" }, { hours, minutes });
  }
  if (hours > 0) {
    return intl.formatMessage({ id: "offPeak.create.remaining.hours" }, { hours });
  }
  return intl.formatMessage({ id: "offPeak.create.remaining.minutes" }, { minutes });
}

export type OffPeakStatusIconKind =
  | "moon"
  | "pause"
  | "spinner"
  | "success"
  | "warning"
  | "stopped";

interface OffPeakStatusFooterPresentation {
  icon: OffPeakStatusIconKind;
  className: string;
  labelId: string;
  labelValues?: Record<string, string>;
}

/**
 * Only a create-state title that still holds the automatic default is synchronized. After a locale
 * switch it must not overwrite user input, a template draft, or a saved task title.
 */
export function resolveLocalizedOffPeakCreateTitle({
  currentTitle,
  hasInitialTitle,
  isEditing,
  nextDefaultTitle,
  previousDefaultTitle,
  titleTouched,
}: {
  currentTitle: string;
  hasInitialTitle: boolean;
  isEditing: boolean;
  nextDefaultTitle: string;
  previousDefaultTitle: string;
  titleTouched: boolean;
}): string {
  if (isEditing || hasInitialTitle || titleTouched || currentTitle !== previousDefaultTitle) {
    return currentTitle;
  }
  return nextDefaultTitle;
}

/**
 * The single mapping from off-peak card state to icon and copy, so a paused entry carrying a queue
 * position is not mistakenly drawn as the queued moon.
 */
export function resolveOffPeakStatusFooter(
  task: Pick<ZCodeOffPeakTask, "queuePosition" | "status">,
): OffPeakStatusFooterPresentation {
  switch (task.status) {
    case "queued":
      return task.queuePosition
        ? {
            icon: "moon",
            className: "text-idle-task",
            labelId: "offPeak.badge.queuePosition",
            labelValues: { position: String(task.queuePosition) },
          }
        : {
            icon: "moon",
            className: "text-idle-task",
            labelId: "offPeak.status.queued",
          };
    case "paused":
      return task.queuePosition
        ? {
            icon: "pause",
            // Paused and Queued are both queuing states that still require attention, and the design draft uses the same brand of weakly emphasized capsules.
            className: "text-idle-task",
            labelId: "offPeak.badge.pausedPosition",
            labelValues: { position: String(task.queuePosition) },
          }
        : {
            icon: "pause",
            className: "text-idle-task",
            labelId: "offPeak.status.paused",
          };
    case "running":
      return {
        icon: "spinner",
        className: "text-success",
        labelId: "offPeak.status.running",
      };
    case "completed":
      return {
        icon: "success",
        // Completion is a static final state that requires no further attention, and success highlighting will make it more eye-catching than active tasks.
        className: "text-foreground-subtle",
        labelId: "offPeak.status.completed",
      };
    case "failed":
      return {
        icon: "warning",
        className: "text-destructive",
        labelId: "offPeak.status.failed",
      };
    case "cancelled":
      return {
        icon: "stopped",
        className: "text-foreground-subtle",
        labelId: "offPeak.status.cancelled",
      };
  }
}

/**
 * A terminal task will never be scheduled again, so a historical choice that no longer applies must
 * not be shown as a current error to fix.
 */
export function shouldShowOffPeakModelSelectionIssue(
  status: Pick<ZCodeOffPeakTask, "status">["status"],
): boolean {
  return status === "queued" || status === "paused" || status === "running";
}

/**
 * When a failed task still carries the queue position returned by the server, render the
 * de-emphasized position on its own. The main state mapping can only return one footer; the failure
 * state needs to retain the extra queue context, so that it is not overwritten by Failure.
 */
export function resolveFailedOffPeakQueueFooter(
  task: Pick<ZCodeOffPeakTask, "queuePosition" | "status">,
): OffPeakStatusFooterPresentation | null {
  if (task.status !== "failed" || task.queuePosition === undefined) return null;
  return {
    icon: "moon",
    className: "text-idle-task",
    labelId: "offPeak.badge.queuePosition",
    labelValues: { position: String(task.queuePosition) },
  };
}
