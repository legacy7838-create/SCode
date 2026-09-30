import { Cron } from "croner";
import type { ZCodeAutomation, ZCodeAutomationScheduleRule } from "@zcode/shared";
import { isValidCronExpr } from "#src/session/automationCronValidation.js";

export { isValidCronExpr } from "#src/session/automationCronValidation.js";

const ONE_SHOT_MISSED_RUN_GRACE_MS = 60 * 1_000;
// One-time fixed month and day cron identification window "the target has just passed". Models are often stale about the "now" moment (the temporal context remains at
// session/round start), by the time a relative request is self-calculated into an absolute cron, the target minute is often several minutes to tens of minutes in the past. Expiration within window
// The goal is to treat the model as a miscalculation, rather than the user really wanting to make the appointment to the next year: <1min will be executed immediately, and the rest will be rejected before writing the library and prompted to use it instead.
// delayMinutes. Take 30min to cover the real clock drift; only keep the next year semantics if the window is exceeded (e.g. created after the target month).
const ONE_SHOT_STALE_TARGET_WINDOW_MS = 30 * 60 * 1_000;
const FIXED_CALENDAR_CRON = /^\d+\s+\d+\s+\d+\s+\d+\s+\*$/;

/** Used to tell whether a directly submitted scheduleRule only updates display fields; anchorAt is ignored during the comparison. */
export function scheduleRuleDefinition(rule: ZCodeAutomationScheduleRule): string {
  return JSON.stringify([
    rule.unit,
    rule.interval,
    rule.hour,
    rule.minute,
    rule.weekdays ? [...rule.weekdays].sort((a, b) => a - b) : null,
    rule.monthDays ? [...rule.monthDays].sort((a, b) => a - b) : null,
    rule.months ? [...rule.months].sort((a, b) => a - b) : null,
    rule.monthlyMode ?? null,
  ]);
}

/** A one-off fixed-calendar task used a target time that just passed and can no longer be safely caught up on. */
class StaleOneShotAutomationScheduleError extends Error {
  constructor(targetAt: number) {
    super(
      `The target time of this one-off scheduled task (${new Date(targetAt).toLocaleString()}) has already passed; use delayMinutes for relative times, and confirm a future time before retrying an absolute one`,
    );
    this.name = "StaleOneShotAutomationScheduleError";
  }
}

/**
 * Purely one-shot tasks (non-recurring and running at most once). A relative delay means one definite
 * target moment, not an interval-style repeat rule: once the window is missed the task must reach a
 * terminal state, and no new execution promise may be derived from the compatibility scheduleRule
 * (e.g. the minute rule that delayMinutes falls back to).
 */
export function isOneShotAutomation(
  automation: Pick<ZCodeAutomation, "recurring" | "maxRuns">,
): boolean {
  return !automation.recurring && (automation.maxRuns ?? 1) <= 1;
}

/**
 * Next-fire computation for cron expressions (local time zone). Scheduled tasks only use croner to
 * "parse + compute the next time", never for actual scheduling — the scheduling loop is driven by
 * the scheduler's own polling of automation_runs / claimDue.
 */

/**
 * Computes the next fire time of a cron expression (millisecond timestamp).
 * @param from Base time in ms; defaults to the current time. Returns the next run strictly later than from; null when there is no future fire.
 */
export function computeNextRunAt(cronExpr: string, from?: number): number | null {
  const cron = new Cron(cronExpr);
  const next = cron.nextRun(from === undefined ? undefined : new Date(from));
  return next ? next.getTime() : null;
}

/**
 * Collapses "in a few minutes" into a one-shot rule anchored to the server's real clock. cronExpr is
 * only there for compatibility display; the real nextRunAt is computed from the scheduleRule with its
 * second-level anchorAt, so a five-field cron cannot fire a whole minute early or late.
 */
export function buildRelativeDelaySchedule(
  delayMinutes: number,
  from = Date.now(),
): Pick<ZCodeAutomation, "cronExpr" | "scheduleRule"> {
  const target = new Date(from + delayMinutes * 60 * 1_000);
  return {
    cronExpr: `${target.getMinutes()} ${target.getHours()} ${target.getDate()} ${target.getMonth() + 1} *`,
    scheduleRule: {
      unit: "minute",
      interval: delayMinutes,
      hour: target.getHours(),
      minute: target.getMinutes(),
      anchorAt: from,
    },
  };
}

/**
 * First fire time of a newly created task. A one-shot fixed month/day cron that just missed its
 * target minute rolls its next occurrence to the following year; only a tool call crossing the
 * minute by less than a minute is caught up immediately, and an already stale target must be
 * rejected and recomputed.
 */
export function computeInitialAutomationNextRunAt(
  automation: Pick<ZCodeAutomation, "cronExpr" | "recurring" | "scheduleRule">,
  from = Date.now(),
): number | null {
  const nextRunAt = computeAutomationNextRunAt(automation, from);
  if (
    automation.recurring ||
    automation.scheduleRule ||
    !FIXED_CALENDAR_CRON.test(automation.cronExpr.trim())
  ) {
    return nextRunAt;
  }

  const cron = new Cron(automation.cronExpr);
  const previousRun = cron.previousRuns(1, new Date(from))[0]?.getTime();
  const targetAge =
    previousRun !== undefined &&
    from >= previousRun &&
    from - previousRun <= ONE_SHOT_STALE_TARGET_WINDOW_MS
      ? from - previousRun
      : undefined;
  const rolledToNextCalendarOccurrence =
    nextRunAt === null || nextRunAt - from > ONE_SHOT_STALE_TARGET_WINDOW_MS;
  if (targetAge !== undefined && rolledToNextCalendarOccurrence) {
    if (targetAge < ONE_SHOT_MISSED_RUN_GRACE_MS) return from;

    // Treating any time in the past as "just a minute" will cause the model to miscalculate
    // Relative times are executed immediately after they are created. If more than one minute has elapsed, it is no longer safe to infer that the user still wants to execute, and must refuse before writing to the library.
    throw new StaleOneShotAutomationScheduleError(from - targetAge);
  }
  return nextRunAt;
}

function atTime(date: Date, hour: number, minute: number): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(), hour, minute, 0, 0);
}

function firstWeekdayOfMonth(year: number, month: number, weekday: number): Date {
  const first = new Date(year, month, 1);
  return new Date(year, month, 1 + ((weekday - first.getDay() + 7) % 7));
}

/** Next run of a custom repeat rule; every computation uses local calendar time. */
export function computeScheduleRuleNextRunAt(
  rule: ZCodeAutomationScheduleRule,
  from = Date.now(),
): number | null {
  const interval = Math.max(1, Math.floor(rule.interval));
  const anchor = new Date(rule.anchorAt);

  if (rule.unit === "minute") {
    const step = interval * 60 * 1_000;
    // Minute intervals start at the time of creation/modification and cannot hit the next wall clock tick early like `*/N` cron does.
    // Always deriving from a fixed anchor also prevents the scheduler from accumulating drift from round to round after late dispatch.
    const steps = Math.max(1, Math.floor((from - rule.anchorAt) / step) + 1);
    return rule.anchorAt + steps * step;
  }

  if (rule.unit === "hourly") {
    const base = new Date(anchor);
    base.setMinutes(rule.minute, 0, 0);
    const step = interval * 60 * 60 * 1_000;
    const steps = Math.max(0, Math.floor((from - base.getTime()) / step) + 1);
    return base.getTime() + steps * step;
  }

  if (rule.unit === "daily") {
    for (let index = 0; index < 36_600; index += 1) {
      const date = new Date(
        anchor.getFullYear(),
        anchor.getMonth(),
        anchor.getDate() + index * interval,
      );
      const candidate = atTime(date, rule.hour, rule.minute).getTime();
      if (candidate > from) return candidate;
    }
    return null;
  }

  if (rule.unit === "weekly") {
    const anchorWeek = new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate());
    anchorWeek.setDate(anchorWeek.getDate() - ((anchorWeek.getDay() + 6) % 7));
    const weekdays = [...(rule.weekdays?.length ? rule.weekdays : [1])].sort();
    for (let week = 0; week < 5_220; week += interval) {
      for (const weekday of weekdays) {
        const dayOffset = (weekday + 6) % 7;
        const date = new Date(
          anchorWeek.getFullYear(),
          anchorWeek.getMonth(),
          anchorWeek.getDate() + week * 7 + dayOffset,
        );
        const candidate = atTime(date, rule.hour, rule.minute).getTime();
        if (candidate > from) return candidate;
      }
    }
    return null;
  }

  if (rule.unit === "monthly") {
    // 1200 is both a legal monthly interval and a search boundary; the old strictly less than only checks offset=0,
    // If the current month candidate has expired, null will be returned incorrectly. Boundaries are included to calculate the next round 100 years later.
    for (let offset = 0; offset <= 1_200; offset += interval) {
      const month = new Date(anchor.getFullYear(), anchor.getMonth() + offset, 1);
      const candidates =
        rule.monthlyMode === "weekday"
          ? [firstWeekdayOfMonth(month.getFullYear(), month.getMonth(), rule.weekdays?.[0] ?? 1)]
          : [...(rule.monthDays?.length ? rule.monthDays : [1])]
              .sort((left, right) => left - right)
              .map((day) => new Date(month.getFullYear(), month.getMonth(), day))
              .filter((date) => date.getMonth() === month.getMonth());
      for (const date of candidates) {
        const candidate = atTime(date, rule.hour, rule.minute).getTime();
        if (candidate > from) return candidate;
      }
    }
    return null;
  }

  // yearly: The month takes priority from rule.months (1-12 → 0-indexed), and the default fallback is to the anchor month (compatible with old records);
  // The date is taken as monthDays[0] or the anchor day. Overflow guard: For example, 2/30 or 2/29 in a non-leap year will be rolled to the next month, skipping the year to avoid accidental triggering.
  const targetMonth =
    rule.months?.[0] != null ? (((rule.months[0] - 1) % 12) + 12) % 12 : anchor.getMonth();
  const targetDay = rule.monthDays?.[0] ?? anchor.getDate();
  for (let offset = 0; offset < 400; offset += interval) {
    const date = new Date(anchor.getFullYear() + offset, targetMonth, targetDay);
    if (date.getMonth() !== targetMonth) continue;
    const candidate = atTime(date, rule.hour, rule.minute).getTime();
    if (candidate > from) return candidate;
  }
  return null;
}

/** Recognizes an "every N minutes" cron display expression as a product schedule rule anchored at the creation time. */
export function inferMinuteIntervalScheduleRule(
  cronExpr: string,
  anchorAt: number,
): ZCodeAutomationScheduleRule | undefined {
  const match = /^\*\/([1-9]\d*)\s+\*\s+\*\s+\*\s+\*$/.exec(cronExpr.trim());
  if (!match) return undefined;
  return {
    unit: "minute",
    interval: Number(match[1]),
    hour: new Date(anchorAt).getHours(),
    minute: new Date(anchorAt).getMinutes(),
    anchorAt,
  };
}

/**
 * Parses the five cron fields. Only standard 5-field cron is supported (minute hour day-of-month
 * month day-of-week); returns the plain numeric parse of each field, splitting the range fields
 * (dow/dom/month) on commas and returning undefined for wildcard fields. Failures fall back to
 * undefined and the caller decides the degradation strategy.
 */
function parseCronFields(cronExpr: string): {
  minute?: number;
  hour?: number;
  monthDays?: number[];
  months?: number[];
  weekdays?: number[];
} {
  const parts = cronExpr.trim().split(/\s+/);
  // The parts[i] type under noUncheckedIndexedAccess contains undefined; deconstruct and extract the first 5 segments. Standard 5-segment cron is required to parse.
  // When the number of segments is insufficient, an empty object is returned, and the caller falls back to the default value of anchorAt (to avoid treating "0 9" as a valid cron).
  const [minuteToken, hourToken, domToken, monthToken, dowToken] = parts;
  if (parts.length < 5 || minuteToken === undefined) return {};
  const parseSingle = (token: string): number | undefined => {
    if (token === "*" || token === "?") return undefined;
    const value = Number(token);
    return Number.isInteger(value) ? value : undefined;
  };
  // Range fields support comma lists (such as "1,3,5"); ignore non-numeric tokens (such as "*/2", "1#1"),
  // These step size/sequence number expressions have exceeded the carrier scenario (carrier is used only when the step size exceeds the limit), and are directly downgraded to the default value.
  const parseList = (token: string): number[] | undefined => {
    if (token === "*" || token === "?") return undefined;
    const values = token
      .split(",")
      .map((piece) => Number(piece))
      .filter((value) => Number.isInteger(value));
    return values.length > 0 ? values : undefined;
  };
  return {
    minute: parseSingle(minuteToken),
    hour: hourToken === undefined ? undefined : parseSingle(hourToken),
    monthDays: domToken === undefined ? undefined : parseList(domToken),
    months: monthToken === undefined ? undefined : parseList(monthToken),
    weekdays: dowToken === undefined ? undefined : parseList(dowToken),
  };
}

/**
 * Normalizes the session-side custom repeat carrier (intervalUnit + interval) into the
 * authoritative scheduleRule.
 *
 * Every cron field has a step ceiling (minute 59, hour 24, day-of-month 31, month 12), so "every 50
 * hours", "every 40 days" and "every 13 months" cannot be expressed directly with a five-field cron.
 * Every "every N units" request on the session side carries its real interval in the controlled
 * carrier intervalUnit+interval, with cronExpr kept only as a legal compatibility display; this
 * function parses the compatibility cron fields into the hour/minute/weekdays/monthDays/months that
 * scheduleRule needs, while the real interval is handed in by the carrier. anchorAt is supplied by
 * the caller (service) as the real creation/modification time, and the scheduling engine advances from it.
 *
 * When a compatibility cron field is missing (e.g. a '* * * * *' placeholder), it falls back to safe
 * defaults (weekday=[1], monthDays=[1], months=anchor month) so the scheduling engine can still
 * compute the next round instead of silently returning null.
 */
export function buildIntervalScheduleRule(
  intervalUnit: ZCodeAutomationScheduleRule["unit"],
  interval: number,
  cronExpr: string,
  anchorAt: number,
): ZCodeAutomationScheduleRule {
  const fields = parseCronFields(cronExpr);
  const anchor = new Date(anchorAt);
  const minute = fields.minute ?? anchor.getMinutes();
  const hour = fields.hour ?? anchor.getHours();
  const monthDays = fields.monthDays ?? [anchor.getDate()];
  // cron's month/dow is a mixture of 1-based/0-based, unified to scheduleRule semantics (see engine implementation).
  const months = fields.months ?? [anchor.getMonth() + 1];
  const weekdays = fields.weekdays ?? [1];

  switch (intervalUnit) {
    case "minute":
      // Minute interval scheduling is entirely driven by anchorAt, hour/minute is only for display; anchor hours and minutes are reserved for card display.
      return {
        unit: "minute",
        interval,
        hour: anchor.getHours(),
        minute: anchor.getMinutes(),
        anchorAt,
      };
    case "hourly":
      // The hourly branch of the engine only uses rule.minute to align minutes; hour does not participate in the calculation (see computeScheduleRuleNextRunAt).
      return { unit: "hourly", interval, hour: 0, minute, anchorAt };
    case "daily":
      return { unit: "daily", interval, hour, minute, anchorAt };
    case "weekly":
      return { unit: "weekly", interval, hour, minute, weekdays, anchorAt };
    case "monthly":
      return {
        unit: "monthly",
        interval,
        hour,
        minute,
        monthDays,
        monthlyMode: "date",
        anchorAt,
      };
    case "yearly":
      return { unit: "yearly", interval, hour, minute, months, monthDays, anchorAt };
    default: {
      // Invalid units must be rejected in the normalization layer to avoid silently generating error rules before being written to the database.
      const exhaustive: never = intervalUnit;
      throw new Error(`Unsupported intervalUnit: ${String(exhaustive)}`);
    }
  }
}

export function computeAutomationNextRunAt(
  automation: Pick<ZCodeAutomation, "cronExpr" | "scheduleRule">,
  from?: number,
): number | null {
  return automation.scheduleRule
    ? computeScheduleRuleNextRunAt(automation.scheduleRule, from)
    : computeNextRunAt(automation.cronExpr, from);
}
