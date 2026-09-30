/* eslint-disable max-lines -- The automation service centralizes cron validation, next-run computation, and lifecycle recalculation for scheduled tasks; splitting it would separate schedule-rule semantics from their callers. */
import type {
  ZCodeAutomation,
  ZCodeAutomationCreateParams,
  ZCodeAutomationRun,
  ZCodeAutomationScheduleRule,
  ZCodeAutomationUpdateParams,
} from "@zcode/shared";
import { resolveWorkspaceKey } from "@zcode/shared";
import { AutomationRepo } from "#src/session/automationRepo.js";
import {
  assertValidAutomationIntervalCarrier,
  forceIntervalCarrierRecurring,
} from "#src/session/automationIntervalCarrier.js";
export { InvalidAutomationIntervalCarrierError } from "#src/session/automationIntervalCarrier.js";
import {
  buildIntervalScheduleRule,
  buildRelativeDelaySchedule,
  computeInitialAutomationNextRunAt,
  computeAutomationNextRunAt,
  inferMinuteIntervalScheduleRule,
  isValidCronExpr,
  scheduleRuleDefinition,
} from "#src/session/automationCron.js";

/** Workspace ownership for write/single-read operations; used for cross-workspace isolation checks. */
interface AutomationWorkspaceScope {
  workspacePath: string;
  workspaceIdentity?: string;
}

/** scope → workspaceKey; returns undefined by default (no ownership filter, for scheduler/host use across workspaces). */
function resolveScopeKey(scope?: AutomationWorkspaceScope): string | undefined {
  if (!scope?.workspacePath) return undefined;
  return resolveWorkspaceKey({
    workspacePath: scope.workspacePath,
    workspaceIdentity: scope.workspaceIdentity,
  });
}

/** Invalid cron expression error (lets the management layer surface a displayable message to the UI). */
export class InvalidCronExprError extends Error {
  constructor(cronExpr: string) {
    super(`Invalid cron expression: ${cronExpr}`);
    this.name = "InvalidCronExprError";
  }
}

/** Illegal limited-run-count update error; prevents contradictory state writes that would wrongly end a still-running task. */
class InvalidAutomationMaxRunsUpdateError extends Error {
  constructor(message = "Clearing maxRuns requires setting recurring=true in the same update") {
    super(message);
    this.name = "InvalidAutomationMaxRunsUpdateError";
  }
}

/** Illegal custom schedule rule; a rule must pass domain validation before it can be written to the internal task store. */
class InvalidAutomationScheduleRuleError extends Error {
  constructor(message: string) {
    super(`Invalid scheduled task rule: ${message}`);
    this.name = "InvalidAutomationScheduleRuleError";
  }
}

/** Relative delay is only for one-off tasks, and the schedule rule is produced from the server's real clock. */
class InvalidAutomationRelativeDelayError extends Error {
  constructor(message: string) {
    super(`Invalid relative-delay scheduled task: ${message}`);
    this.name = "InvalidAutomationRelativeDelayError";
  }
}

const MAX_MONTHLY_AUTOMATION_SCHEDULE_INTERVAL = 1_200;
const AUTOMATION_SCHEDULE_RULE_UNITS = new Set([
  "minute",
  "hourly",
  "daily",
  "weekly",
  "monthly",
  "yearly",
]);

function hasOnlyIntegersInRange(values: number[] | undefined, min: number, max: number): boolean {
  return Boolean(
    values?.length &&
    values.every((value) => Number.isInteger(value) && value >= min && value <= max),
  );
}

function assertValidAutomationScheduleRule(rule: ZCodeAutomationScheduleRule): void {
  if (!AUTOMATION_SCHEDULE_RULE_UNITS.has(rule.unit)) {
    throw new InvalidAutomationScheduleRuleError("unit is not supported");
  }
  if (!Number.isInteger(rule.interval) || rule.interval < 1) {
    throw new InvalidAutomationScheduleRuleError("interval must be a positive integer");
  }
  if (rule.unit === "monthly" && rule.interval > MAX_MONTHLY_AUTOMATION_SCHEDULE_INTERVAL) {
    throw new InvalidAutomationScheduleRuleError(
      `monthly interval must not exceed ${MAX_MONTHLY_AUTOMATION_SCHEDULE_INTERVAL}`,
    );
  }
  if (!Number.isInteger(rule.hour) || rule.hour < 0 || rule.hour > 23) {
    throw new InvalidAutomationScheduleRuleError("hour must be an integer between 0 and 23");
  }
  if (!Number.isInteger(rule.minute) || rule.minute < 0 || rule.minute > 59) {
    throw new InvalidAutomationScheduleRuleError("minute must be an integer between 0 and 59");
  }
  if (
    rule.monthlyMode !== undefined &&
    rule.monthlyMode !== "date" &&
    rule.monthlyMode !== "weekday"
  ) {
    throw new InvalidAutomationScheduleRuleError("monthlyMode is not supported");
  }
  if (rule.weekdays && !hasOnlyIntegersInRange(rule.weekdays, 0, 6)) {
    throw new InvalidAutomationScheduleRuleError(
      "weekdays must be a non-empty array of integers between 0 and 6",
    );
  }
  if (rule.unit === "weekly" && !hasOnlyIntegersInRange(rule.weekdays, 0, 6)) {
    throw new InvalidAutomationScheduleRuleError("a weekly rule must contain valid weekdays");
  }
  if (rule.unit === "monthly") {
    if (rule.monthlyMode === "weekday" && !hasOnlyIntegersInRange(rule.weekdays, 0, 6)) {
      throw new InvalidAutomationScheduleRuleError(
        "a monthly weekday rule must contain valid weekdays",
      );
    }
    if (rule.monthlyMode !== "weekday" && !hasOnlyIntegersInRange(rule.monthDays, 1, 31)) {
      throw new InvalidAutomationScheduleRuleError(
        "a monthly date rule must contain valid monthDays",
      );
    }
  }
  if (rule.months && !hasOnlyIntegersInRange(rule.months, 1, 12)) {
    throw new InvalidAutomationScheduleRuleError(
      "months must be a non-empty array of integers between 1 and 12",
    );
  }
  if (rule.monthDays && !hasOnlyIntegersInRange(rule.monthDays, 1, 31)) {
    throw new InvalidAutomationScheduleRuleError(
      "monthDays must be a non-empty array of integers between 1 and 31",
    );
  }
}

/**
 * Automation management service: wraps AutomationRepo and owns cron semantics (validation / next-run computation) plus lifecycle recalculation.
 * The repo is storage only; the cron-related business logic lives here — "compute next_run_at on create", "recompute when cron_expr changes",
 * "recompute lifecycle when recurring/max_runs changes", "recompute on restart" — serving the UI management surface / RPC callers.
 */
export class AutomationService {
  constructor(private readonly repo: AutomationRepo = new AutomationRepo()) {}

  async create(params: ZCodeAutomationCreateParams): Promise<ZCodeAutomation> {
    const createdAt = Date.now();
    const relativeDelayMinutes = params.relativeDelayMinutes;
    if (
      relativeDelayMinutes !== undefined &&
      (!Number.isInteger(relativeDelayMinutes) ||
        relativeDelayMinutes < 1 ||
        relativeDelayMinutes > 525_600)
    ) {
      throw new InvalidAutomationRelativeDelayError(
        "delayMinutes must be an integer between 1 and 525600",
      );
    }
    if (relativeDelayMinutes !== undefined && params.recurring) {
      throw new InvalidAutomationRelativeDelayError(
        "a relative-delay task must set recurring=false",
      );
    }
    if (relativeDelayMinutes !== undefined && params.maxRuns !== undefined) {
      throw new InvalidAutomationRelativeDelayError(
        "a relative-delay task always runs once and cannot set maxRuns",
      );
    }
    if (relativeDelayMinutes !== undefined && params.scheduleRule) {
      throw new InvalidAutomationRelativeDelayError(
        "delayMinutes and scheduleRule cannot be submitted together",
      );
    }
    const intervalUnit = params.intervalUnit;
    const interval = params.interval;
    assertValidAutomationIntervalCarrier({
      intervalUnit,
      interval,
      scheduleRule: params.scheduleRule,
      relativeDelayMinutes,
      recurring: params.recurring,
      maxRuns: params.maxRuns,
    });
    // The carrier is only used for this normalization and cannot be transparently transmitted to the repository to form undefined persistence fields.
    const {
      relativeDelayMinutes: _relativeDelayMinutes,
      intervalUnit: _intervalUnit,
      interval: _interval,
      ...persistedParams
    } = params;
    // When the model only knows the date, it will guess the current time by itself, calculating "3 minutes from now" as two hours from now or in the past.
    // Relative times must be anchored by the domain layer based on the real Date.now(), the model-scaled absolute cron cannot be trusted.
    const relativeNormalizedParams =
      relativeDelayMinutes === undefined
        ? persistedParams
        : {
            ...persistedParams,
            ...buildRelativeDelaySchedule(relativeDelayMinutes, createdAt),
            recurring: false,
          };
    // Customized repeated carrier normalization on the session side: assemble intervalUnit+interval + compatible cron into an authoritative scheduleRule,
    // The real interval is carried by scheduleRule, cronExpr is for display only. The anchor point uses the real creation time of the server (same as relativeDelay).
    const normalizedParams =
      intervalUnit !== undefined && interval !== undefined
        ? {
            ...relativeNormalizedParams,
            // The carrier must loop infinitely to avoid the conflicting state of the old client/internal call writing being completed on first dispatch.
            recurring: true,
            maxRuns: undefined,
            scheduleRule: buildIntervalScheduleRule(
              intervalUnit,
              interval,
              relativeNormalizedParams.cronExpr,
              createdAt,
            ),
          }
        : relativeNormalizedParams;
    if (!isValidCronExpr(normalizedParams.cronExpr)) {
      throw new InvalidCronExprError(normalizedParams.cronExpr);
    }
    // computeScheduleRuleNextRunAt once silently modified interval=0 and returned null if the interval was too large.
    // Make illegal rules still persist as active. It must be rejected at the domain level before writing the library, and you cannot rely on the UI selector to get the answer.
    if (normalizedParams.scheduleRule) {
      assertValidAutomationScheduleRule(normalizedParams.scheduleRule);
    }
    // The standard `*/N` cron will align the wall clock tick at 11:46 creating "every 10 minutes" will be at 11:50
    // Triggered early. Product semantics are timed from the moment of creation, so in the absence of explicit rules, minute anchors are added at the domain level.
    const scheduleRule = normalizedParams.scheduleRule
      ? { ...normalizedParams.scheduleRule, anchorAt: createdAt }
      : inferMinuteIntervalScheduleRule(normalizedParams.cronExpr, createdAt);
    const createParams = scheduleRule ? { ...normalizedParams, scheduleRule } : normalizedParams;
    // The five-segment cron does not include the year; if the one-time fixed month and day task just misses the target minute during the creation process,
    // Normal nextRun will roll to the next year. The first calculation only compensates for minute-to-minute errors less than one minute, and stale targets are rejected before writing to the database.
    const nextRunAt = computeInitialAutomationNextRunAt(createParams, createdAt);
    const endedBeforeFirstRun =
      createParams.endAt !== undefined && (nextRunAt ?? Infinity) > createParams.endAt;
    return this.repo.create(createParams, {
      nextRunAt: endedBeforeFirstRun ? null : nextRunAt,
      ...(endedBeforeFirstRun ? { lifecycleStatus: "completed" as const } : {}),
    });
  }

  async list(scope?: {
    workspacePath?: string;
    workspaceIdentity?: string;
  }): Promise<ZCodeAutomation[]> {
    return this.repo.list(scope);
  }

  async hasTaskBinding(scope: {
    workspacePath: string;
    workspaceIdentity?: string;
    targetTaskId: string;
  }): Promise<boolean> {
    return this.repo.hasTaskBinding(scope);
  }

  async get(
    automationId: string,
    scope?: AutomationWorkspaceScope,
  ): Promise<ZCodeAutomation | null> {
    return this.repo.get(automationId, resolveScopeKey(scope));
  }

  async update(
    automationId: string,
    params: ZCodeAutomationUpdateParams,
    scope?: AutomationWorkspaceScope,
  ): Promise<ZCodeAutomation | null> {
    const workspaceKey = resolveScopeKey(scope);
    const existing = await this.repo.get(automationId, workspaceKey);
    if (!existing) return null;

    if (params.scheduleRule) assertValidAutomationScheduleRule(params.scheduleRule);

    // Customized repeated carrier check on the session side: intervalUnit+interval must be paired and limited to 1–200, and are mutually exclusive with the direct transfer scheduleRule.
    const { intervalUnit, interval, scheduleRule: directScheduleRule, ...restParams } = params;
    // `undefined` means no modification, `null` means clearing existing rules explicitly; the two cannot be confused after destructuring.
    // Merging with `??` will treat `scheduleRule: null` as not passed, causing the user to be unable to restore normal cron scheduling.
    const hasDirectScheduleRule = directScheduleRule !== undefined;
    assertValidAutomationIntervalCarrier({
      intervalUnit,
      interval,
      scheduleRule: hasDirectScheduleRule ? directScheduleRule : undefined,
      recurring: restParams.recurring,
      maxRuns: restParams.maxRuns,
    });
    const hasIntervalCarrier = intervalUnit !== undefined && interval !== undefined;

    // Convert maxRuns=null to undefined and then calculate it based on the one-time task upper limit of 1.
    // Tasks that have been run a limited number of times will be silently changed to completed. Clearing the cap must be done atomically with the toggle infinite loop.
    if (!hasIntervalCarrier && restParams.maxRuns === null && restParams.recurring !== true) {
      throw new InvalidAutomationMaxRunsUpdateError();
    }

    const nextRecurring = hasIntervalCarrier ? true : (restParams.recurring ?? existing.recurring);
    if (nextRecurring && typeof restParams.maxRuns === "number") {
      throw new InvalidAutomationMaxRunsUpdateError(
        "an infinitely recurring task cannot set a finite maxRuns",
      );
    }

    // When limited tasks are only submitted with recurring=true, the old maxRuns will be retained intact by repo.update.
    // Forming the contradictory hidden state of "infinite loop + limited upper limit". The domain layer uniformly fills null, is compatible with old clients and clears the old upper limit atomically;
    // At the same time, the same type of dirty data that already exists in history can be easily repaired.
    const normalizedParams: ZCodeAutomationUpdateParams = hasIntervalCarrier
      ? forceIntervalCarrierRecurring(restParams)
      : nextRecurring &&
          restParams.maxRuns === undefined &&
          (restParams.recurring === true || existing.maxRuns !== undefined)
        ? { ...restParams, maxRuns: null }
        : restParams;

    const options: {
      nextRunAt?: number | null;
      lifecycleStatus?: ZCodeAutomation["lifecycleStatus"];
      resetRetry?: boolean;
    } = {};

    // Change cron_expr: check + recalculate next_run_at with now + clear retry state.
    const cronChanged =
      normalizedParams.cronExpr !== undefined && normalizedParams.cronExpr !== existing.cronExpr;
    if (normalizedParams.cronExpr !== undefined && !isValidCronExpr(normalizedParams.cronExpr)) {
      throw new InvalidCronExprError(normalizedParams.cronExpr);
    }
    const updatedAt = Date.now();
    const effectiveCron = normalizedParams.cronExpr ?? existing.cronExpr;
    // Session-side long interval carrier normalization: assemble intervalUnit+interval + compatible cron into authoritative scheduleRule.
    // The carrier scene must be re-anchored (anchorAt=updatedAt), and the subsequent "rules of explicitScheduleRule remain unchanged and retain the old anchor point"
    // The judgment is meaningless for the carrier - Submitting the carrier means that the user needs to reset the interval and save and retime this time.
    const carrierScheduleRule = hasIntervalCarrier
      ? buildIntervalScheduleRule(intervalUnit, interval, effectiveCron, updatedAt)
      : undefined;
    const effectiveDirectScheduleRule = hasDirectScheduleRule
      ? directScheduleRule
      : carrierScheduleRule;
    const normalizedWithSchedule: ZCodeAutomationUpdateParams =
      effectiveDirectScheduleRule !== undefined
        ? { ...normalizedParams, scheduleRule: effectiveDirectScheduleRule }
        : normalizedParams;
    if (effectiveDirectScheduleRule) {
      assertValidAutomationScheduleRule(effectiveDirectScheduleRule);
    }
    const explicitScheduleRule = effectiveDirectScheduleRule
      ? {
          ...effectiveDirectScheduleRule,
          // The content of the rule remains unchanged, only the original anchor points are retained when saving other fields; the actual modification frequency is re-timed from this save.
          anchorAt:
            existing.scheduleRule &&
            scheduleRuleDefinition(existing.scheduleRule) ===
              scheduleRuleDefinition(effectiveDirectScheduleRule)
              ? existing.scheduleRule.anchorAt
              : updatedAt,
        }
      : effectiveDirectScheduleRule;
    // When cron changes but the caller does not have an explicit scheduleRule, the old rule cannot continue to overwrite the new cron; the minute interval is based on this time
    // Modification time is re-anchored and other cron clears the old rules and restores calendar cron semantics.
    const inferredScheduleRule =
      cronChanged && effectiveDirectScheduleRule === undefined
        ? inferMinuteIntervalScheduleRule(effectiveCron, updatedAt)
        : undefined;
    const effectiveScheduleRule =
      effectiveDirectScheduleRule === undefined
        ? cronChanged
          ? inferredScheduleRule
          : existing.scheduleRule
        : (explicitScheduleRule ?? undefined);
    const updateParams =
      cronChanged && effectiveDirectScheduleRule === undefined
        ? { ...normalizedWithSchedule, scheduleRule: inferredScheduleRule ?? null }
        : effectiveDirectScheduleRule === undefined
          ? normalizedWithSchedule
          : { ...normalizedWithSchedule, scheduleRule: explicitScheduleRule ?? null };
    if (
      cronChanged ||
      normalizedParams.endAt !== undefined ||
      effectiveDirectScheduleRule !== undefined
    ) {
      options.nextRunAt = computeAutomationNextRunAt(
        {
          cronExpr: effectiveCron,
          scheduleRule: effectiveScheduleRule,
        },
        updatedAt,
      );
      options.resetRetry = true;
    }

    const effectiveEndAt =
      normalizedParams.endAt === undefined ? existing.endAt : (normalizedParams.endAt ?? undefined);
    if (
      effectiveEndAt !== undefined &&
      (options.nextRunAt ?? existing.nextRunAt ?? Infinity) > effectiveEndAt
    ) {
      options.nextRunAt = null;
      options.lifecycleStatus = "completed";
    } else if (
      normalizedParams.endAt !== undefined &&
      (existing.lifecycleStatus === "completed" || existing.lifecycleStatus === "failed")
    ) {
      options.lifecycleStatus = "active";
    }

    // Change recurring / max_runs: recalculate the life cycle.
    if (normalizedParams.recurring !== undefined || normalizedParams.maxRuns !== undefined) {
      const nextMaxRuns =
        normalizedParams.maxRuns === undefined
          ? existing.maxRuns
          : (normalizedParams.maxRuns ?? undefined);
      // runCount is the cumulative display number of Card, including manual run; if it is used to recalculate the limited plan,
      // As long as the user has performed it manually, he or she may change the task to completed in advance when editing maxRuns.
      const scheduledRunCount = await this.repo.getScheduledRunCount(automationId, workspaceKey);
      if (scheduledRunCount === null) return null;
      // The same caliber as markDispatched: limited tasks are processed as one-time tasks (upper limit 1) when max_runs is not explicitly set.
      const reachedMax = !nextRecurring && scheduledRunCount >= (nextMaxRuns ?? 1);
      if (reachedMax) {
        options.lifecycleStatus = "completed";
      } else if (
        existing.lifecycleStatus === "completed" ||
        existing.lifecycleStatus === "failed"
      ) {
        // Originally the final state, it became runnable after editing → Resurrected to active and recalculated next_run_at.
        options.lifecycleStatus = "active";
        if (options.nextRunAt === undefined) {
          options.nextRunAt = computeAutomationNextRunAt(
            {
              cronExpr: effectiveCron,
              scheduleRule: effectiveScheduleRule,
            },
            updatedAt,
          );
        }
      }
    }

    return this.repo.update(automationId, updateParams, options, workspaceKey);
  }

  async delete(automationId: string, scope?: AutomationWorkspaceScope): Promise<boolean> {
    return this.repo.delete(automationId, resolveScopeKey(scope));
  }

  /** Pause / resume. */
  async setEnabled(
    automationId: string,
    enabled: boolean,
    scope?: AutomationWorkspaceScope,
  ): Promise<void> {
    return this.repo.setEnabled(automationId, enabled, resolveScopeKey(scope));
  }

  /** Manual re-run of a failed task: back to active, counters cleared, next time recomputed from the cron expression. */
  async restart(automationId: string, scope?: AutomationWorkspaceScope): Promise<void> {
    const workspaceKey = resolveScopeKey(scope);
    const existing = await this.repo.get(automationId, workspaceKey);
    if (!existing) return;
    // completed is the final state after the limited-time plan is naturally exhausted and cannot be resurrected by the old UI/RPC restart;
    // Only failed represents a recoverable exception, allowing the user to manually reschedule the next run.
    if (existing.lifecycleStatus !== "failed") return;
    const nextRunAt = computeAutomationNextRunAt(existing);
    return this.repo.restart(automationId, { nextRunAt }, workspaceKey);
  }

  /** Run now: creates a manual run for the current host to dispatch directly, without touching the original cron schedule. */
  async runNow(
    automationId: string,
    scope?: AutomationWorkspaceScope,
  ): Promise<{ automation: ZCodeAutomation; run: ZCodeAutomationRun } | null> {
    const workspaceKey = resolveScopeKey(scope);
    const existing = await this.repo.get(automationId, workspaceKey);
    if (!existing) return null;
    return this.repo.runNow(automationId, { now: Date.now() }, workspaceKey);
  }

  async listRuns(
    automationId: string,
    scope?: AutomationWorkspaceScope,
  ): Promise<ZCodeAutomationRun[]> {
    return this.repo.listRuns(automationId, resolveScopeKey(scope));
  }
  async deleteRun(runId: string, scope?: AutomationWorkspaceScope): Promise<void> {
    return this.repo.deleteRun(runId, resolveScopeKey(scope));
  }
}
