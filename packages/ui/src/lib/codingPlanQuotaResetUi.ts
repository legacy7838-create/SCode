import type {
  CodingPlanResetStatusSnapshot,
  CodingPlanResetType,
  UsageQuotaLimit,
} from "@zcode/shared";
// The length of time the "Limit has been reset" prompt will stay after completion, and then the prompt will be automatically closed (the limit bar remains at 100%).
export const CODING_PLAN_QUOTA_RESET_DONE_DISPLAY_MS = 2_600;
// Automatic/operational resets synthesize a short "Resetting" duration on the Composer trigger, then switch to "Reset".
// There is no processing signal in the backend, so the look and feel of "Processing→Reset" is only restored once on the client side.
export const CODING_PLAN_QUOTA_RESET_AUTOMATIC_PROCESSING_MS = 1_000;
const FIVE_HOURS_MS = 5 * 60 * 60 * 1_000;
const WEEK_MS = 7 * 24 * 60 * 60 * 1_000;

// After completion, optimistically rewrite the "next reset time" cycle: five hours for the five-hour quota, and seven days for the weekly quota.
function resolveCodingPlanQuotaResetDurationMs(resetType: CodingPlanResetType): number {
  return resetType === "WEEK" ? WEEK_MS : FIVE_HOURS_MS;
}

// available: The server has issued an available five-hour reset opportunity.
// processing: The user has initiated manual write-off and is waiting for use + status reconciliation.
// completed: status has been returned to the server used_at; automatic/operational reset will not be processed.
export type CodingPlanQuotaResetUiStatus = "available" | "processing" | "completed";

export interface CodingPlanQuotaResetUiEntry {
  status: CodingPlanQuotaResetUiStatus;
  /** Remaining reset opportunities; reset to zero for processing/completed. */
  opportunityCount: number;
  /** Expiry moment of the earliest reset opportunity; only meaningful for available. */
  opportunityExpiresAt: number | null;
  /** Start moment of the local manual write-off; null for automatic/operational resets. */
  startedAt: number | null;
  /** Server-side latest_{five_hour,week}_reset_history.used_at. */
  completedAt: number | null;
  /**
   * Time the client first observed the current completedAt; used only for the brief toast and its
   * animation.
   */
  observedAt: number | null;
  /** The quota may be temporarily overridden to 100% until an entitlement refresh succeeds. */
  quotaOverridePending: boolean;
  nextResetAt: number | null;
  /**
   * Idempotency key that a retry of the same failure must reuse; cleared after a successful
   * reconciliation.
   */
  idempotencyKey: string | null;
  error: string | null;
}

export interface CodingPlanQuotaResetCelebrationState {
  sourceKey: string | null;
  /**
   * Confetti has already been fired by the trigger for this used_at; the same completion must not
   * replay across repeated renders/polls.
   */
  celebratedCompletedAt: number | null;
}

/** Independently tracked reset state for the five-hour and weekly quotas under the same source. */
export interface CodingPlanQuotaResetUiEntries {
  fiveHour: CodingPlanQuotaResetUiEntry | null;
  week: CodingPlanQuotaResetUiEntry | null;
}

/**
 * The five-hour and weekly quotas share one reset state machine, distinguished by type only when
 * the opportunity/history fields are read.
 */
export const CODING_PLAN_QUOTA_RESET_TYPES = [
  "FIVE_HOUR",
  "WEEK",
] as const satisfies readonly CodingPlanResetType[];

export function advanceCodingPlanQuotaResetCelebration(
  previous: CodingPlanQuotaResetCelebrationState | null,
  input: {
    sourceKey: string | null;
    completedAt: number | null;
    /**
     * Brief-toast window for automatic/operational completions (startedAt is null); a manual reset
     * fires its own confetti from the button and the trigger does not take part.
     */
    automaticCompletion: boolean;
  },
): {
  state: CodingPlanQuotaResetCelebrationState;
  shouldCelebrate: boolean;
} {
  // Manual write-off will also go through processing, and "seen processing" can no longer be used as a basis for triggers.
  // Otherwise, manual reset will superimpose the button and trigger animations. The trigger only recognizes the new used_at that is autocompleted,
  // Clear the track when switching sources to avoid repeating flowers or missing automatic reset animations between Team/personal packages.
  const sourceChanged = previous?.sourceKey !== input.sourceKey;
  const celebratedCompletedAt = sourceChanged ? null : (previous?.celebratedCompletedAt ?? null);
  const shouldCelebrate = Boolean(
    input.sourceKey &&
    input.automaticCompletion &&
    input.completedAt !== null &&
    input.completedAt !== celebratedCompletedAt,
  );

  return {
    state: {
      sourceKey: input.sourceKey,
      celebratedCompletedAt: shouldCelebrate ? input.completedAt : celebratedCompletedAt,
    },
    shouldCelebrate,
  };
}

function createAvailableEntry(
  opportunityCount: number,
  opportunityExpiresAt: number,
  idempotencyKey: string | null,
): CodingPlanQuotaResetUiEntry {
  return {
    status: "available",
    opportunityCount,
    opportunityExpiresAt,
    startedAt: null,
    completedAt: null,
    observedAt: null,
    quotaOverridePending: false,
    nextResetAt: null,
    idempotencyKey,
    error: null,
  };
}

function createCompletedEntry(
  previous: CodingPlanQuotaResetUiEntry | null,
  completedAt: number,
  observedAt: number,
  manualStartedAt: number | null,
  nextResetMs: number,
): CodingPlanQuotaResetUiEntry {
  const isSameCompletion = previous?.status === "completed" && previous.completedAt === completedAt;
  return {
    status: "completed",
    opportunityCount: 0,
    opportunityExpiresAt: null,
    // Manual click and completion history may be observed by different portals. Only relies on the processing of the current source
    // This will cause Composer to misjudge the manual reset initiated on the settings page as an automatic reset, and display the Tooltip and fireworks repeatedly.
    // When the same completion history is reconciled repeatedly, the original classification must be retained and cannot be degraded to automatic completion in the next poll.
    startedAt: isSameCompletion
      ? previous.startedAt
      : previous?.status === "processing"
        ? previous.startedAt
        : manualStartedAt,
    completedAt,
    // Automatic/operational resets may not be discovered by polling until up to 60 seconds after used_at.
    // Short reminders must be counted from the time of first observation; repeated polling of the same used_at cannot be renewed.
    observedAt: isSameCompletion ? (previous.observedAt ?? observedAt) : observedAt,
    quotaOverridePending: isSameCompletion ? previous.quotaOverridePending : true,
    nextResetAt: completedAt + nextResetMs,
    idempotencyKey: null,
    error: null,
  };
}

/**
 * Applies the server-side status to the UI state shared across windows.
 *
 * Stale history with has_unread_history=false must not enter completed on first mount, otherwise
 * the client would wrongly overwrite a reset from hours ago with the current 100% remaining quota.
 *
 * resetType decides whether the five-hour or the weekly opportunity/history is read.
 * has_unread_history is a single cursor shared by both reset types, so only the type whose used_at
 * is newest "owns" the unread flag: otherwise one weekly reset would misjudge stale five-hour
 * history as just completed, and vice versa.
 */
export function applyCodingPlanQuotaResetStatus(
  previous: CodingPlanQuotaResetUiEntry | null,
  status: CodingPlanResetStatusSnapshot,
  now: number,
  manualStartedAt: number | null = null,
  resetType: CodingPlanResetType = "FIVE_HOUR",
): CodingPlanQuotaResetUiEntry | null {
  const availableResets =
    resetType === "WEEK" ? status.availableWeekResets : status.availableFiveHourResets;
  const latestUsedAt =
    (resetType === "WEEK"
      ? status.latestWeekResetHistory?.usedAt
      : status.latestFiveHourResetHistory?.usedAt) ?? null;
  const otherUsedAt =
    (resetType === "WEEK"
      ? status.latestFiveHourResetHistory?.usedAt
      : status.latestWeekResetHistory?.usedAt) ?? null;
  // Shared has_unread_history only belongs to the latest category of used_at; when equal, it belongs to the current type.
  // It is guaranteed that at least one type can enter the completion state when there is new history, and two types will not be preempted at the same time.
  const ownsUnread =
    status.hasUnreadHistory &&
    latestUsedAt !== null &&
    (otherUsedAt === null || latestUsedAt >= otherUsedAt);
  const validOpportunities = availableResets
    .filter((item) => Number.isFinite(item.expireAt) && item.expireAt > now)
    .sort((left, right) => left.expireAt - right.expireAt);
  // Sticky completion status and shared manual track attribution of the same used_at only take effect when there are "no new opportunities".
  // The backend may issue opportunities again during the same reset cycle (used_at remains unchanged); if the completion status continues to take priority, new opportunities
  // It will be permanently swallowed by the UI, and the user must log in again (clear the window memory state) to see the entrance. When a valid opportunity arrives, it is deemed
  // Enter a new cycle and return to AVAILABLE. ownsUnread (newly discovered unread completion) is not affected: completion prompt
  // The balance correction is broadcast first, and then gives way in the next round after history/read; processing reconciliation is also not affected: opportunity
  // Manual /use confirmation loop must still see completed when balance >0.
  const hasValidOpportunity = validOpportunities.length > 0;
  const shouldComplete = Boolean(
    latestUsedAt !== null &&
    (ownsUnread ||
      previous?.status === "processing" ||
      ((manualStartedAt !== null ||
        (previous?.status === "completed" && previous.completedAt === latestUsedAt)) &&
        !hasValidOpportunity)),
  );
  if (shouldComplete && latestUsedAt !== null) {
    return createCompletedEntry(
      previous,
      latestUsedAt,
      now,
      manualStartedAt,
      resolveCodingPlanQuotaResetDurationMs(resetType),
    );
  }

  // Status polling during manual use may still read the pre-consumer snapshot. Keep processing at this time,
  // Only the server used_at can confirm success, and it cannot be rolled back to clickable again by the old opportunity.
  if (previous?.status === "processing") {
    return previous;
  }

  const earliest = validOpportunities[0];
  if (earliest) {
    return createAvailableEntry(
      validOpportunities.length,
      earliest.expireAt,
      previous?.status === "available" ? previous.idempotencyKey : null,
    );
  }

  return null;
}

export function startCodingPlanQuotaResetManualUse(
  entry: CodingPlanQuotaResetUiEntry | null,
  idempotencyKey: string,
  now: number,
): CodingPlanQuotaResetUiEntry | null {
  if (!entry || entry.status !== "available") {
    return entry;
  }

  return {
    ...entry,
    status: "processing",
    // During processing, the opportunity snapshot before the click is retained. After failure, the idempotent key can be recovered and reused without loss.
    opportunityCount: entry.opportunityCount,
    opportunityExpiresAt: entry.opportunityExpiresAt,
    startedAt: now,
    completedAt: null,
    observedAt: null,
    quotaOverridePending: false,
    nextResetAt: null,
    idempotencyKey: entry.idempotencyKey ?? idempotencyKey,
    error: null,
  };
}

export function failCodingPlanQuotaResetManualUse(
  entry: CodingPlanQuotaResetUiEntry | null,
  error: string,
): CodingPlanQuotaResetUiEntry | null {
  if (!entry || entry.status !== "processing") {
    return entry;
  }

  return {
    ...entry,
    status: "available",
    // Failure recovery must retain the number of opportunities and expiration time before clicking, otherwise the entrance will disappear.
    // Users also cannot retry the same write-off using the original idempotent key.
    opportunityCount: entry.opportunityCount,
    opportunityExpiresAt: entry.opportunityExpiresAt,
    startedAt: null,
    completedAt: null,
    observedAt: null,
    quotaOverridePending: false,
    nextResetAt: null,
    error,
  };
}

/**
 * Merges the opportunity badge presentation of the five-hour and weekly quotas: one gift badge with
 * the counts added up, and a countdown taken from the earliest-expiring visible opportunity; once a
 * tier expires or is hidden it falls back to the remaining tier automatically. This only affects
 * the badge presentation — the reset buttons stay independent per type.
 */
export function mergeCodingPlanQuotaResetOpportunityBadges(
  items: ReadonlyArray<{
    count: number;
    expiresAt: number | null;
    visible: boolean;
  }>,
): { count: number; expiresAt: number | null; visible: boolean } {
  const visibleItems = items.filter((item) => item.visible && item.count > 0);
  return {
    count: visibleItems.reduce((sum, item) => sum + item.count, 0),
    expiresAt:
      visibleItems
        .map((item) => item.expiresAt)
        .filter((value): value is number => value !== null)
        .sort((left, right) => left - right)[0] ?? null,
    visible: visibleItems.length > 0,
  };
}

export function completeCodingPlanQuotaResetEntitlementRefresh(
  entry: CodingPlanQuotaResetUiEntry | null,
  completedAt: number,
): CodingPlanQuotaResetUiEntry | null {
  if (
    entry?.status !== "completed" ||
    entry.completedAt !== completedAt ||
    !entry.quotaOverridePending
  ) {
    return entry;
  }
  return { ...entry, quotaOverridePending: false };
}

export function resolveCodingPlanQuotaResetLimit(
  limit: UsageQuotaLimit | null | undefined,
  entry: CodingPlanQuotaResetUiEntry | null,
): UsageQuotaLimit | null {
  if (!limit) {
    return null;
  }
  if (entry?.status !== "completed") {
    return limit;
  }
  if (!entry.quotaOverridePending) {
    // After the reset, the quota pool has no active window (the new window will start from the next prompt), and the real value will be refreshed.
    // The quota may be missing nextResetTime. The entitlement refresh is almost the same tick as the completion, and the optimistic rewrite only survives for a few hundred
    // milliseconds, the "reset time" will flash and then disappear. During the completion state, continue to use completedAt + cycle to show the details;
    // Once the server gives the real window (the user has sent a new message), it immediately gives way. The percentage will no longer be overwritten and will be subject to refresh.
    return limit.nextResetTime == null && entry.nextResetAt !== null
      ? { ...limit, nextResetTime: entry.nextResetAt }
      : limit;
  }

  return {
    ...limit,
    // The percentage of the quota interface indicates the used proportion; the UI completion state coverage is 0% used, that is, 100% remaining.
    percentage: 0,
    nextResetTime: entry.nextResetAt ?? limit.nextResetTime,
  };
}

// available is carried by the gift logo + "Reset" button, so the toolbar Tooltip is not opened.
// Manual reset is already displayed by the button itself loading and plays fireworks after success; if displayed again here
// processing/completed Tooltip, will form repeated feedback. Only automatic/operational completions (startedAt is empty) retain short prompts.
export function resolveCodingPlanQuotaResetStatusVisible(
  entry: CodingPlanQuotaResetUiEntry | null,
  now: number,
  doneDisplayMs: number = CODING_PLAN_QUOTA_RESET_DONE_DISPLAY_MS,
): boolean {
  if (entry?.status !== "completed" || entry.startedAt !== null || entry.observedAt === null) {
    return false;
  }
  return now - entry.observedAt < doneDisplayMs;
}

// Composition phase for automatic/operational reset prompts on Composer triggers:
// - Processing: "Resetting" is displayed about 1 second after the first observation, restoring the look and feel of server-side processing (there is no processing signal in the backend).
// - completed: It is then switched to "reset" and remains until the user hovers the trigger to view the balance panel and is closed by the component.
// Returns null if dismissed=true (discarded by hover) or not automatically completed (manually startedAt is not empty/not completed/not observed).
export type CodingPlanQuotaResetAutomaticPhase = "processing" | "completed";

export function resolveCodingPlanQuotaResetAutomaticPhase(
  entry: CodingPlanQuotaResetUiEntry | null,
  now: number,
  dismissed: boolean,
  processingMs: number = CODING_PLAN_QUOTA_RESET_AUTOMATIC_PROCESSING_MS,
): CodingPlanQuotaResetAutomaticPhase | null {
  if (dismissed) {
    return null;
  }
  if (entry?.status !== "completed" || entry.startedAt !== null || entry.observedAt === null) {
    return null;
  }
  return now - entry.observedAt < processingMs ? "processing" : "completed";
}

/**
 * Clears a catch-up confetti arm that is no longer valid: when the armed used_at is no longer the
 * effective automatic completion (observedAt was cleared by cross-window suppression, or a newer
 * used_at replaced it) the arm must be cleared, otherwise hovering the panel in another window
 * would still fire confetti from the "already reset" position, violating "play once across multiple
 * windows".
 */
export function pruneCodingPlanQuotaResetConfettiArms(
  arms: Record<CodingPlanResetType, number | null>,
  automaticCompletedAtByType: Record<CodingPlanResetType, number | null>,
): Record<CodingPlanResetType, number | null> {
  let changed = false;
  const next = { ...arms };
  for (const resetType of CODING_PLAN_QUOTA_RESET_TYPES) {
    const armed = next[resetType];
    if (armed !== null && automaticCompletedAtByType[resetType] !== armed) {
      next[resetType] = null;
      changed = true;
    }
  }
  return changed ? next : arms;
}
