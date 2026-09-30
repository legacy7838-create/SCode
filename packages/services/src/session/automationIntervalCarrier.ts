import type {
  ZCodeAutomationIntervalUnit,
  ZCodeAutomationScheduleRule,
  ZCodeAutomationUpdateParams,
} from "@zcode/shared";

/** Controlled ceiling for the session-side custom repeat carrier; do not tighten the domain ceiling of historical scheduleRules from the admin page. */
const MAX_SESSION_AUTOMATION_INTERVAL = 200;

/** Session-side custom repeat carrier failed its pairing, range or mutual-exclusion validation. */
export class InvalidAutomationIntervalCarrierError extends Error {
  constructor(message: string) {
    super(`Invalid custom recurrence input: ${message}`);
    this.name = "InvalidAutomationIntervalCarrierError";
  }
}

/**
 * Validates the interval carrier shared by the session Cron tool and the UI.
 *
 * intervalUnit + interval is controlled input, so the service layer must validate it again, so that
 * old clients or internal calls cannot bypass contract/protocol and persist an interval beyond UI
 * semantics. `scheduleRule: null` is the explicit clearing semantics of update and must not be
 * mixed with the carrier either, otherwise it is impossible to tell a new rule from a cleared one.
 */
export function assertValidAutomationIntervalCarrier(input: {
  intervalUnit?: ZCodeAutomationIntervalUnit;
  interval?: number;
  scheduleRule?: ZCodeAutomationScheduleRule | null;
  relativeDelayMinutes?: number;
  recurring?: boolean;
  maxRuns?: number | null;
}): void {
  const { intervalUnit, interval, scheduleRule, relativeDelayMinutes, recurring, maxRuns } = input;
  if ((intervalUnit === undefined) !== (interval === undefined)) {
    throw new InvalidAutomationIntervalCarrierError(
      "intervalUnit and interval must be submitted together or both omitted",
    );
  }
  if (
    interval !== undefined &&
    (!Number.isInteger(interval) || interval < 1 || interval > MAX_SESSION_AUTOMATION_INTERVAL)
  ) {
    throw new InvalidAutomationIntervalCarrierError(
      "interval must be an integer between 1 and 200",
    );
  }
  if (intervalUnit !== undefined && relativeDelayMinutes !== undefined) {
    throw new InvalidAutomationIntervalCarrierError(
      "intervalUnit is a recurring carrier and cannot be submitted with a one-off relativeDelayMinutes",
    );
  }
  if (intervalUnit !== undefined && scheduleRule !== undefined) {
    throw new InvalidAutomationIntervalCarrierError(
      "The intervalUnit carrier cannot be submitted with a direct scheduleRule",
    );
  }
  // The true semantics of carrier is an infinite loop; if recurring=false or maxRuns is enabled, the repository will
  // Ending as a one-time/limited task after first dispatch, leaving scheduleRule with conflicting data in lifecycle mode.
  if (intervalUnit !== undefined && recurring === false) {
    throw new InvalidAutomationIntervalCarrierError(
      "The intervalUnit carrier must use recurring=true",
    );
  }
  if (intervalUnit !== undefined && typeof maxRuns === "number") {
    throw new InvalidAutomationIntervalCarrierError(
      "The intervalUnit carrier cannot be submitted with a finite maxRuns",
    );
  }
}

/** A carrier update must atomically switch to unbounded recurrence, so the scheduleRule cannot drift out of sync with the lifecycle mode. */
export function forceIntervalCarrierRecurring(
  params: ZCodeAutomationUpdateParams,
): ZCodeAutomationUpdateParams {
  return { ...params, recurring: true, maxRuns: null };
}
