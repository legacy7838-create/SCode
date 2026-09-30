/**
 * `@zcode/rust/cron` — typed wrapper over the `zcode-cron` binary.
 *
 * Spec: docs/specs/rust-native-cron.md
 *
 * This module is a **thin** boundary, deliberately:
 *
 * * The native side is pure. Every export takes primitives and returns primitives, with no
 *   clock read and no I/O, so the `from = Date.now()` default lives *here* rather than in
 *   Rust. That is what makes the Rust side testable with a pinned `from`.
 * * `loadNative` throws when the binary is missing. There is deliberately no `try { native }
 *   catch { croner }` here (umbrella spec invariant 1): the `croner` dependency this replaces
 *   is deleted in the same change, not feature-flagged.
 * * The `StaleOneShotAutomationScheduleError` class stays in TypeScript, so existing `catch`
 *   sites and their user-facing message are unchanged. The native call returns a tagged
 *   outcome and this module re-raises the original class.
 */
import { loadNative } from "./loader.js";

/** The recurrence units, matching `ZCodeAutomationScheduleRule["unit"]`. */
export type ScheduleUnit = "minute" | "hourly" | "daily" | "weekly" | "monthly" | "yearly";

export type MonthlyMode = "date" | "weekday";

/**
 * The authoritative recurrence rule. Structurally identical to
 * `ZCodeAutomationScheduleRule` in `packages/shared/src/automation-types.ts`, which stays the
 * source of truth for the wire shape; this is the form that crosses the FFI boundary.
 */
export interface NativeScheduleRule {
  unit: ScheduleUnit;
  interval: number;
  hour: number;
  minute: number;
  /** Epoch milliseconds. */
  anchorAt: number;
  weekdays?: number[];
  monthDays?: number[];
  /** 1-12, human numbering, as in the TS interface. */
  months?: number[];
  monthlyMode?: MonthlyMode;
}

export interface RelativeDelaySchedule {
  /** Compatibility display only; the `scheduleRule` is authoritative. */
  cronExpr: string;
  scheduleRule: NativeScheduleRule;
}

/**
 * A one-off fixed-calendar task whose target time just passed and can no longer be caught up
 * on. Mirrors the legacy class at `automationCron.ts:37-43`, including its `name`, so the
 * service layer's existing handling is untouched.
 */
export class StaleOneShotAutomationScheduleError extends Error {
  constructor(readonly targetAt: number) {
    super(
      `The target time of this one-off scheduled task (${new Date(targetAt).toLocaleString()}) has already passed; use delayMinutes for relative times, and confirm a future time before retrying an absolute one`,
    );
    this.name = "StaleOneShotAutomationScheduleError";
  }
}

interface NativeCronModule {
  computeNextRunAtJs(cronExpr: string, from: number): number | null;
  computeScheduleRuleNextRunAtJs(ruleJson: string, from: number): number | null;
  computeAutomationNextRunAtJs(
    cronExpr: string,
    ruleJson: string | null,
    from: number,
  ): number | null;
  buildIntervalScheduleRuleJs(
    intervalUnit: string,
    interval: number,
    cronExpr: string,
    anchorAt: number,
  ): string;
  inferMinuteIntervalScheduleRuleJs(cronExpr: string, anchorAt: number): string | null;
  buildRelativeDelayScheduleJs(delayMinutes: number, from: number): string;
  isOneShotAutomationJs(recurring: boolean, maxRuns: number | null): boolean;
  scheduleRuleDefinitionJs(ruleJson: string): string;
  isValidCronExprJs(cronExpr: string): boolean;
  computeInitialAutomationNextRunAtJs(
    cronExpr: string,
    recurring: boolean,
    ruleJson: string | null,
    from: number,
  ): string;
  previousRunAtJs(cronExpr: string, from: number): number | null;
  isFixedCalendarCronJs(cronExpr: string): boolean;
  parseUnit(name: string): string | null;
}

let cached: NativeCronModule | null = null;

function cronModule(): NativeCronModule {
  cached ??= loadNative<NativeCronModule>("zcode-cron");
  return cached;
}

/** `scheduleRule` as the JSON string the boundary expects, or `null` when absent. */
function ruleJson(rule: NativeScheduleRule | null | undefined): string | null {
  if (!rule) return null;
  return JSON.stringify(rule);
}

/** Computes the next fire of a cron expression, strictly later than `from`. */
export function computeNextRunAt(cronExpr: string, from: number = Date.now()): number | null {
  return cronModule().computeNextRunAtJs(cronExpr, from);
}

/** Computes the next fire of a structured rule. */
export function computeScheduleRuleNextRunAt(
  rule: NativeScheduleRule,
  from: number = Date.now(),
): number | null {
  return cronModule().computeScheduleRuleNextRunAtJs(ruleJson(rule)!, from);
}

/**
 * The entry point both schedulers call. A `scheduleRule` is authoritative; the cron expression
 * is the compatibility display and is only consulted when no rule exists.
 */
export function computeAutomationNextRunAt(
  automation: { cronExpr: string; scheduleRule?: NativeScheduleRule | null },
  from: number = Date.now(),
): number | null {
  return cronModule().computeAutomationNextRunAtJs(
    automation.cronExpr,
    ruleJson(automation.scheduleRule),
    from,
  );
}

/** Collapses "in N minutes" into a one-shot rule anchored to the server's real clock. */
export function buildRelativeDelaySchedule(
  delayMinutes: number,
  from: number = Date.now(),
): RelativeDelaySchedule {
  return JSON.parse(cronModule().buildRelativeDelayScheduleJs(delayMinutes, from)) as RelativeDelaySchedule;
}

/** Recognises an `*\/N * * * *` display expression as a product schedule rule. */
export function inferMinuteIntervalScheduleRule(
  cronExpr: string,
  anchorAt: number,
): NativeScheduleRule | undefined {
  const raw = cronModule().inferMinuteIntervalScheduleRuleJs(cronExpr, anchorAt);
  return raw ? (JSON.parse(raw) as NativeScheduleRule) : undefined;
}

/**
 * Normalises the model-authored interval carrier into the authoritative rule.
 *
 * Throws on an unsupported `intervalUnit`, reproducing the legacy message so the existing
 * validation layer keeps working unchanged.
 */
export function buildIntervalScheduleRule(
  intervalUnit: ScheduleUnit,
  interval: number,
  cronExpr: string,
  anchorAt: number,
): NativeScheduleRule {
  return JSON.parse(
    cronModule().buildIntervalScheduleRuleJs(intervalUnit, interval, cronExpr, anchorAt),
  ) as NativeScheduleRule;
}

/**
 * The change-detection key for a rule edit.
 *
 * Byte-identical to the legacy `JSON.stringify` is required: both schedulers compare this
 * string, so a byte difference would silently re-schedule every automation on upgrade.
 */
export function scheduleRuleDefinition(rule: NativeScheduleRule): string {
  return cronModule().scheduleRuleDefinitionJs(ruleJson(rule)!);
}

/** Non-recurring, at most one run. A missing `maxRuns` counts as one. */
export function isOneShotAutomation(automation: {
  recurring: boolean;
  maxRuns?: number | null;
}): boolean {
  return cronModule().isOneShotAutomationJs(automation.recurring, automation.maxRuns ?? null);
}

export function isValidCronExpr(cronExpr: string): boolean {
  return cronModule().isValidCronExprJs(cronExpr);
}

/** Whether an expression is the fixed-calendar form (`M H D M *`). */
export function isFixedCalendarCron(cronExpr: string): boolean {
  return cronModule().isFixedCalendarCronJs(cronExpr);
}

/** The most recent fire strictly before `from`. */
export function previousRunAt(cronExpr: string, from: number = Date.now()): number | null {
  return cronModule().previousRunAtJs(cronExpr, from);
}

type InitialNextRunOutcome =
  | { kind: "At"; nextRunAt: number | null }
  | { kind: "StaleOneShot"; targetAt: number };

/**
 * First fire time of a newly created task.
 *
 * A one-shot fixed-calendar cron that just missed its target minute rolls to the following
 * year. A miss of under a minute is caught up immediately; anything older is refused by
 * re-raising the legacy error, so the service never writes a schedule the user did not ask for.
 */
export function computeInitialAutomationNextRunAt(
  automation: { cronExpr: string; recurring: boolean; scheduleRule?: NativeScheduleRule | null },
  from: number = Date.now(),
): number | null {
  const outcome = JSON.parse(
    cronModule().computeInitialAutomationNextRunAtJs(
      automation.cronExpr,
      automation.recurring,
      ruleJson(automation.scheduleRule),
      from,
    ),
  ) as InitialNextRunOutcome;

  if (outcome.kind === "StaleOneShot") {
    throw new StaleOneShotAutomationScheduleError(outcome.targetAt);
  }
  return outcome.nextRunAt;
}

/** Every export, for callers that want a single namespace object. */
export const nativeCron = {
  computeNextRunAt,
  computeScheduleRuleNextRunAt,
  computeAutomationNextRunAt,
  buildRelativeDelaySchedule,
  inferMinuteIntervalScheduleRule,
  buildIntervalScheduleRule,
  scheduleRuleDefinition,
  isOneShotAutomation,
  isValidCronExpr,
  isFixedCalendarCron,
  previousRunAt,
  computeInitialAutomationNextRunAt,
  StaleOneShotAutomationScheduleError,
};
