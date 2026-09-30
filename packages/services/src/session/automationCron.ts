/**
 * Automation schedule computation — Node entrypoint over the `zcode-cron` binary.
 *
 * Spec: docs/specs/rust-native-cron.md
 *
 * The engine itself is Rust (`packages/rust/crates/zcode-cron`). This module is the boundary:
 * it re-exports the native functions with the same names and signatures the old TypeScript
 * engine had, and it keeps the two things that must stay on this side:
 *
 * * **`Date.now()` defaults.** Every native function is pure, so the "now" default lives here
 *   and a test can pin `from`. The engine reads no clock.
 * * **The `StaleOneShotAutomationScheduleError` class**, so the service layer's `catch` sites
 *   and the user-facing message are byte-identical to before.
 *
 * There is **no JavaScript fallback**: `croner` is no longer a dependency, the old engine is
 * deleted, and `loadNative` throws when the binary is missing (umbrella spec invariant 1). A
 * process either has the Rust engine or it does not start.
 */
import {
  buildIntervalScheduleRule as nativeBuildIntervalScheduleRule,
  buildRelativeDelaySchedule as nativeBuildRelativeDelaySchedule,
  computeAutomationNextRunAt as nativeComputeAutomationNextRunAt,
  computeInitialAutomationNextRunAt as nativeComputeInitialAutomationNextRunAt,
  computeNextRunAt as nativeComputeNextRunAt,
  computeScheduleRuleNextRunAt as nativeComputeScheduleRuleNextRunAt,
  inferMinuteIntervalScheduleRule as nativeInferMinuteIntervalScheduleRule,
  isFixedCalendarCron,
  isOneShotAutomation as nativeIsOneShotAutomation,
  previousRunAt as nativePreviousRunAt,
  scheduleRuleDefinition as nativeScheduleRuleDefinition,
  StaleOneShotAutomationScheduleError,
  type MonthlyMode,
  type NativeScheduleRule,
  type ScheduleUnit,
} from "@zcode/rust/cron";
import { isValidCronExpr } from "#src/session/automationCronValidation.js";

// Re-exported so existing call sites keep importing the validator and the error class from
// this module, which is where they lived before the port.
export { isFixedCalendarCron, isValidCronExpr, StaleOneShotAutomationScheduleError };
export type { MonthlyMode, NativeScheduleRule, ScheduleUnit };

/** One-minute grace for a tool call that merely crossed the minute boundary. */
export const ONE_SHOT_MISSED_RUN_GRACE_MS = 60 * 1_000;
/** Window in which a missed one-shot target counts as a model miscalculation, not a real appointment. */
export const ONE_SHOT_STALE_TARGET_WINDOW_MS = 30 * 60 * 1_000;

/**
 * Whether a directly submitted rule only updates display fields.
 *
 * `anchorAt` is excluded on purpose: it is not part of "did the schedule change", and
 * including it would re-arm every automation on any edit.
 */
export function scheduleRuleDefinition(rule: NativeScheduleRule): string {
  return nativeScheduleRuleDefinition(rule);
}

/** A one-off task: non-recurring, at most one run. A missing `maxRuns` counts as one. */
export function isOneShotAutomation(automation: {
  recurring: boolean;
  maxRuns?: number | null;
}): boolean {
  return nativeIsOneShotAutomation(automation);
}

/**
 * Next-fire computation for a 5-field cron expression, in the host's local time zone.
 *
 * The scheduler never uses this to *schedule*; it drives its own 20 s poll of
 * `automation_runs` / `claimDue`. This only answers "when is the next fire".
 */
export function computeNextRunAt(cronExpr: string, from: number = Date.now()): number | null {
  return nativeComputeNextRunAt(cronExpr, from);
}

/** Next fire of a structured rule, in local calendar time. */
export function computeScheduleRuleNextRunAt(
  rule: NativeScheduleRule,
  from: number = Date.now(),
): number | null {
  return nativeComputeScheduleRuleNextRunAt(rule, from);
}

/**
 * Collapses "in a few minutes" into a one-shot rule anchored to the server's real clock.
 *
 * `cronExpr` is compatibility display only: the real next run derives from the rule's
 * second-level `anchorAt`, so a five-field cron cannot fire a minute early or late.
 */
export function buildRelativeDelaySchedule(
  delayMinutes: number,
  from: number = Date.now(),
): { cronExpr: string; scheduleRule: NativeScheduleRule } {
  return nativeBuildRelativeDelaySchedule(delayMinutes, from);
}

/**
 * First fire time of a newly created task.
 *
 * A one-shot fixed-calendar cron that just missed its target minute rolls to the following
 * year. A miss of under a minute is caught up immediately; a stale target is refused by
 * throwing {@link StaleOneShotAutomationScheduleError} before anything is written.
 */
export function computeInitialAutomationNextRunAt(
  automation: { cronExpr: string; recurring: boolean; scheduleRule?: NativeScheduleRule | null },
  from: number = Date.now(),
): number | null {
  return nativeComputeInitialAutomationNextRunAt(automation, from);
}

/** Recognises an "every N minutes" display expression as a product rule anchored at creation. */
export function inferMinuteIntervalScheduleRule(
  cronExpr: string,
  anchorAt: number,
): NativeScheduleRule | undefined {
  return nativeInferMinuteIntervalScheduleRule(cronExpr, anchorAt);
}

/**
 * Normalises the model-authored interval carrier into the authoritative rule.
 *
 * Every cron field has a step ceiling, so "every 50 hours" cannot be expressed as a
 * five-field cron. The carrier carries the real interval; the cron expression is parsed only
 * for the calendar fields, and any missing field falls back to an anchor-derived default so
 * the engine can still compute a next round instead of silently returning null.
 */
export function buildIntervalScheduleRule(
  intervalUnit: ScheduleUnit,
  interval: number,
  cronExpr: string,
  anchorAt: number,
): NativeScheduleRule {
  return nativeBuildIntervalScheduleRule(intervalUnit, interval, cronExpr, anchorAt);
}

/** The entry point both schedulers call. */
export function computeAutomationNextRunAt(
  automation: { cronExpr: string; scheduleRule?: NativeScheduleRule | null },
  from: number = Date.now(),
): number | null {
  return nativeComputeAutomationNextRunAt(automation, from);
}

/** The most recent fire strictly before `from`. Exposed for the one-shot staleness probe. */export function previousRunAt(cronExpr: string, from: number = Date.now()): number | null {
  return nativePreviousRunAt(cronExpr, from);
}
