import type { ZCodeAutomationScheduleRule } from "@zcode/shared";
import {
  describeCron,
  describeCronBuilder,
  type CronBuilderState,
  type IntlLike,
} from "@/settings/automationFormat.js";

function scheduleRuleToBuilder(rule: ZCodeAutomationScheduleRule): CronBuilderState {
  return {
    frequency: "custom",
    hour: rule.hour,
    minute: rule.minute,
    weekdays: rule.weekdays ?? [1],
    dayOfMonth: rule.monthDays?.[0] ?? 1,
    rawExpr: "",
    customInterval: rule.interval,
    customUnit: rule.unit,
    customWeekdays: rule.weekdays ?? [1],
    customMonthDays: rule.monthDays ?? [1],
    customMonth: rule.months?.[0] ?? new Date(rule.anchorAt).getMonth() + 1,
    customMonthlyMode: rule.monthlyMode ?? "date",
  };
}

/**
 * The card shows the authoritative scheduleRule first; only when legacy data lacks a rule is a
 * summary generated from the compatibility cron.
 */
export function describeAutomationCardSchedule(
  automation: {
    cronExpr: string;
    scheduleRule?: ZCodeAutomationScheduleRule;
    recurring?: boolean;
    maxRuns?: number;
  },
  intl: IntlLike,
): string {
  // Relative time one-time tasks (such as "remind after 4 minutes") are saved as minute scheduleRule for compatibility display.
  // describeCronBuilder will misrepresent this as a recurring task "every 4 minutes". A one-time task ends once it is run and has no frequency.
  // Consistent with the fixed calendar cron one-time tasks, they are uniformly displayed as "Customized", and the real timing is carried by the "Next Run" copy.
  if (automation.recurring === false && (automation.maxRuns ?? 1) <= 1) {
    return intl.formatMessage({ id: "automations.frequency.custom" });
  }
  // Compatible crons with long monthly intervals are fixed as monthly candidates; parsing only cron will misrepresent "every 30 months" as "monthly".
  if (automation.scheduleRule) {
    return describeCronBuilder(scheduleRuleToBuilder(automation.scheduleRule), intl);
  }
  return describeCron(automation.cronExpr, intl);
}
