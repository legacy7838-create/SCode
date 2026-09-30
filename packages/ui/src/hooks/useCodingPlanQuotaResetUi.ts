/* eslint-disable max-lines -- The quota reset hook centralizes scope-sharing requests, polling,
 * idempotent write-off, and reconciliation against server history.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { IUsageStatsService } from "@zcode/services";
import type {
  CodingPlanResetScopeRequest,
  CodingPlanResetStatusSnapshot,
  CodingPlanResetType,
  ZCodeAccountAccess,
  ZCodeProviderAccountAccess,
} from "@zcode/shared";
import { toast } from "@/components/ui/toast.js";
import { useOptionalBaseWorkspaceServices } from "@/hooks/useWorkspaceServices.js";
import { useStableAccountAccess } from "@/hooks/useStableAccountAccess.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import {
  requestCodingPlanResetOpportunityWhenDue,
  subscribeCodingPlanQuotaResetPolling,
} from "@/lib/codingPlanQuotaResetCoordinator.js";
import {
  CODING_PLAN_QUOTA_RESET_DONE_DISPLAY_MS,
  CODING_PLAN_QUOTA_RESET_TYPES,
  applyCodingPlanQuotaResetStatus,
  completeCodingPlanQuotaResetEntitlementRefresh,
  failCodingPlanQuotaResetManualUse,
  resolveCodingPlanQuotaResetStatusVisible,
  startCodingPlanQuotaResetManualUse,
  type CodingPlanQuotaResetUiEntries,
  type CodingPlanQuotaResetUiEntry,
} from "@/lib/codingPlanQuotaResetUi.js";
import type {
  CodingPlanQuotaResetAutomaticObservation,
  CodingPlanQuotaResetAutoPlayReservation,
  CodingPlanQuotaResetAutoPlayReservationAttempt,
  CodingPlanQuotaResetAutoPlayedSlot,
} from "@/store/codingPlanQuotaResetState.js";
import { useZCodeStoreWithDefault } from "@/store/StoreProvider.js";

const STATUS_FRESHNESS_MS = 1_500;
const USE_STATUS_RETRY_DELAYS_MS = [0, 250, 750, 1_500] as const;
const EMPTY_ENTRIES: Record<string, CodingPlanQuotaResetUiEntries> = {};
const EMPTY_PLAYED: Record<string, CodingPlanQuotaResetAutoPlayedSlot> = {};
const EMPTY_AUTOMATIC_OBSERVATIONS: Record<
  string,
  {
    fiveHour: CodingPlanQuotaResetAutomaticObservation | null;
    week: CodingPlanQuotaResetAutomaticObservation | null;
  }
> = {};
const NOOP_SET_ENTRY = (
  _sourceKey: string,
  _resetType: CodingPlanResetType,
  _entry: CodingPlanQuotaResetUiEntry | null,
) => {};
const NOOP_RESERVE_AUTO_PLAY = async (
  _sourceKey: string,
  _resetType: CodingPlanResetType,
  _completedAt: number,
): Promise<CodingPlanQuotaResetAutoPlayReservationAttempt> => ({
  status: "blocked",
});
const NOOP_COMMIT_AUTO_PLAY = (_reservation: CodingPlanQuotaResetAutoPlayReservation): boolean =>
  false;
const NOOP_RELEASE_AUTO_PLAY = async (
  _reservation: CodingPlanQuotaResetAutoPlayReservation,
): Promise<void> => {};

function entryKeyForType(resetType: CodingPlanResetType): keyof CodingPlanQuotaResetUiEntries {
  return resetType === "WEEK" ? "week" : "fiveHour";
}

function latestUsedAtForType(
  snapshot: CodingPlanResetStatusSnapshot,
  resetType: CodingPlanResetType,
): number | null {
  return (
    (resetType === "WEEK"
      ? snapshot.latestWeekResetHistory?.usedAt
      : snapshot.latestFiveHourResetHistory?.usedAt) ?? null
  );
}

// Replace only the target type's slot and leave the other type untouched; the explicit branch avoids the type-narrowing problem of computed keys on a union.
function withEntry(
  entries: CodingPlanQuotaResetUiEntries,
  resetType: CodingPlanResetType,
  entry: CodingPlanQuotaResetUiEntry | null,
): CodingPlanQuotaResetUiEntries {
  return resetType === "WEEK" ? { ...entries, week: entry } : { ...entries, fiveHour: entry };
}

// You cannot use "the store has completed status before the component is mounted" to determine whether to log in again; the settings page may be in the same authentication session.
// Write the state first so a Composer mounting later can still display it. Suppress only when the first observed record for the same used_at belongs to the previous
// auth session. The return value is memoized so the suppressed state does not create a fresh object on every render and trigger an effect/setNow loop.
function suppressAutomaticAnimationFromPreviousAuthEpoch(
  entry: CodingPlanQuotaResetUiEntry | null,
  observation: CodingPlanQuotaResetAutomaticObservation | null,
  authSessionSeq: number,
): CodingPlanQuotaResetUiEntry | null {
  if (
    observation !== null &&
    observation.authSessionSeq !== authSessionSeq &&
    entry?.status === "completed" &&
    entry.startedAt === null &&
    entry.observedAt !== null &&
    entry.completedAt === observation.completedAt
  ) {
    return { ...entry, observedAt: null };
  }
  return entry;
}

interface CachedResetStatus {
  fetchedAt: number;
  snapshot: CodingPlanResetStatusSnapshot;
}

interface SharedManualResetAttempt {
  startedAt: number;
  baselineUsedAt: number | null;
  completedAt: number | null;
}

const statusInflightByService = new WeakMap<
  IUsageStatsService,
  Map<string, Promise<CodingPlanResetStatusSnapshot>>
>();
const statusCacheByService = new WeakMap<IUsageStatsService, Map<string, CachedResetStatus>>();
const historyReadInflightByService = new WeakMap<IUsageStatsService, Map<string, Promise<void>>>();
const historyReadCompletedByService = new WeakMap<IUsageStatsService, Set<string>>();
const manualResetAttemptByService = new WeakMap<
  IUsageStatsService,
  Map<string, SharedManualResetAttempt>
>();

function buildScopeKey(scope: CodingPlanResetScopeRequest): string {
  return JSON.stringify([scope.preferredProviderId, scope.accountAccess]);
}

// Manual redemption attempts are isolated by scope + reset type: manual resets of the five-hour and weekly quotas never interfere with each other.
function buildManualAttemptKey(
  scope: CodingPlanResetScopeRequest,
  resetType: CodingPlanResetType,
): string {
  return `${buildScopeKey(scope)}::${resetType}`;
}

function getServiceMap<T>(
  owner: WeakMap<IUsageStatsService, Map<string, T>>,
  service: IUsageStatsService,
): Map<string, T> {
  const existing = owner.get(service);
  if (existing) {
    return existing;
  }
  const created = new Map<string, T>();
  owner.set(service, created);
  return created;
}

async function requestCodingPlanResetStatus(params: {
  service: IUsageStatsService;
  scope: CodingPlanResetScopeRequest;
  force: boolean;
  authSessionSeq: number;
}): Promise<CodingPlanResetStatusSnapshot> {
  const scopeKey = `${params.authSessionSeq}::${buildScopeKey(params.scope)}`;
  const cache = getServiceMap(statusCacheByService, params.service);
  const cached = cache.get(scopeKey);
  if (!params.force && cached && Date.now() - cached.fetchedAt < STATUS_FRESHNESS_MS) {
    return cached.snapshot;
  }

  const inflight = getServiceMap(statusInflightByService, params.service);
  const existing = inflight.get(scopeKey);
  if (existing) {
    return existing;
  }

  const request = params.service
    .getCodingPlanResetStatus(params.scope)
    .then((snapshot) => {
      cache.set(scopeKey, { fetchedAt: Date.now(), snapshot });
      return snapshot;
    })
    .finally(() => {
      inflight.delete(scopeKey);
      if (inflight.size === 0) {
        statusInflightByService.delete(params.service);
      }
    });
  inflight.set(scopeKey, request);
  return request;
}

function startSharedManualResetAttempt(params: {
  service: IUsageStatsService;
  scope: CodingPlanResetScopeRequest;
  startedAt: number;
  resetType: CodingPlanResetType;
  authSessionSeq: number;
}): void {
  const attemptKey = buildManualAttemptKey(params.scope, params.resetType);
  const cached = statusCacheByService
    .get(params.service)
    ?.get(`${params.authSessionSeq}::${buildScopeKey(params.scope)}`)?.snapshot;
  const baselineUsedAt = cached ? latestUsedAtForType(cached, params.resetType) : null;
  getServiceMap(manualResetAttemptByService, params.service).set(attemptKey, {
    startedAt: params.startedAt,
    baselineUsedAt,
    completedAt: null,
  });
}

function clearSharedManualResetAttempt(
  service: IUsageStatsService,
  scope: CodingPlanResetScopeRequest,
  resetType: CodingPlanResetType,
): void {
  const attempts = manualResetAttemptByService.get(service);
  if (!attempts) {
    return;
  }
  attempts.delete(buildManualAttemptKey(scope, resetType));
  if (attempts.size === 0) {
    manualResetAttemptByService.delete(service);
  }
}

function resolveSharedManualResetStartedAt(params: {
  service: IUsageStatsService;
  scope: CodingPlanResetScopeRequest;
  snapshot: CodingPlanResetStatusSnapshot;
  resetType: CodingPlanResetType;
}): number | null {
  const attempts = manualResetAttemptByService.get(params.service);
  const attemptKey = buildManualAttemptKey(params.scope, params.resetType);
  const attempt = attempts?.get(attemptKey);
  if (!attempt) {
    return null;
  }

  const latestUsedAt = latestUsedAtForType(params.snapshot, params.resetType);
  if (latestUsedAt === null || latestUsedAt === attempt.baselineUsedAt) {
    return null;
  }
  if (attempt.completedAt === null) {
    attempt.completedAt = latestUsedAt;
    return attempt.startedAt;
  }
  if (attempt.completedAt === latestUsedAt) {
    return attempt.startedAt;
  }

  // The shared attempt only belongs to the first used_at that changed. Later differing history belongs to a new automatic/operational reset,
  // Manual markers must be cleared, retaining the original automatic Tooltip and trigger fireworks.
  clearSharedManualResetAttempt(params.service, params.scope, params.resetType);
  return null;
}

function markHistoryReadOnce(params: {
  service: IUsageStatsService;
  scope: CodingPlanResetScopeRequest;
  usedAt: number;
}): Promise<void> {
  // Contract (bigmodelUsageQuotaProvider):
  // history/read is the user's full-scope shared cursor, and the request does not include target scope; after any entry is reported
  // the server also clears unread for every scope at once. Therefore the key is only by usedAt — sending once for the same
  // usedAt on the same service is contract-compliant deduplication; splitting by scope would instead cause duplicate POSTs.
  const historyKey = String(params.usedAt);
  let completed = historyReadCompletedByService.get(params.service);
  if (!completed) {
    completed = new Set<string>();
    historyReadCompletedByService.set(params.service, completed);
  }
  if (completed.has(historyKey)) {
    return Promise.resolve();
  }

  const inflight = getServiceMap(historyReadInflightByService, params.service);
  const existing = inflight.get(historyKey);
  if (existing) {
    return existing;
  }

  const request = params.service
    .markCodingPlanResetHistoryRead(params.scope)
    .then(() => {
      completed?.add(historyKey);
    })
    .finally(() => {
      inflight.delete(historyKey);
      if (inflight.size === 0) {
        historyReadInflightByService.delete(params.service);
      }
    });
  inflight.set(historyKey, request);
  return request;
}

function createIdempotencyKey(): string {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }

  const bytes = new Uint8Array(16);
  globalThis.crypto?.getRandomValues(bytes);
  if (bytes.some((value) => value !== 0)) {
    bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
    bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
    const hex = Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }

  // Even on very old WebViews without Web Crypto, retries of the same failure must stay stable; this key is only for idempotency, it carries no authentication.
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function wait(delayMs: number): Promise<void> {
  if (delayMs <= 0) {
    return Promise.resolve();
  }
  return new Promise((resolve) => window.setTimeout(resolve, delayMs));
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export interface CodingPlanQuotaResetTypeController {
  entry: CodingPlanQuotaResetUiEntry | null;
  /** The manual reset opportunity issued by the server is visible. */
  opportunityVisible: boolean;
  /** Manual use, status reconciliation in progress. */
  processing: boolean;
  /** The server `used_at` has been received. */
  done: boolean;
  statusVisible: boolean;
  /**
   * Start the manual write-off; on failure the promise rejects so the Action can restore
   * interaction.
   */
  reset: () => Promise<void>;
}

// The five-hour fields stay flattened at the top level for existing callers; the weekly quota is exposed through the `week` sub-controller.
export interface CodingPlanQuotaResetUiController extends CodingPlanQuotaResetTypeController {
  enabled: boolean;
  week: CodingPlanQuotaResetTypeController;
  /** The Composer requests a temporary playback reservation; this stage does not write played. */
  reserveAutomaticCompletion: (
    resetType: CodingPlanResetType,
    completedAt: number,
  ) => Promise<CodingPlanQuotaResetAutoPlayReservationAttempt>;
  /** Commit played while the component is still valid and about to be shown. */
  commitAutomaticCompletion: (reservation: CodingPlanQuotaResetAutoPlayReservation) => boolean;
  /** Release the reservation when the component goes invalid before the commit. */
  releaseAutomaticCompletion: (
    reservation: CodingPlanQuotaResetAutoPlayReservation,
  ) => Promise<void>;
}

export function useCodingPlanQuotaResetUi({
  sourceKey,
  preferredProviderId,
  accountAccess,
  enabled: requestedEnabled = true,
  onEntitlementRefresh,
}: {
  sourceKey: string | null | undefined;
  preferredProviderId?: string | null;
  accountAccess?: ZCodeProviderAccountAccess | ZCodeAccountAccess | null;
  enabled?: boolean;
  onEntitlementRefresh?: () => void | Promise<void>;
}): CodingPlanQuotaResetUiController {
  const { intl } = useZCodeIntl();
  const services = useOptionalBaseWorkspaceServices();
  const usageStatsService = services?.usageStatsService;
  const stableAccountAccess = useStableAccountAccess(accountAccess);
  const scope = useMemo<CodingPlanResetScopeRequest | null>(() => {
    const normalizedProviderId = preferredProviderId?.trim();
    if (!normalizedProviderId || !stableAccountAccess) {
      return null;
    }
    return {
      preferredProviderId: normalizedProviderId,
      accountAccess: stableAccountAccess,
    };
  }, [preferredProviderId, stableAccountAccess]);
  const enabled = Boolean(requestedEnabled && sourceKey?.trim() && usageStatsService && scope);
  const entriesBySource = useZCodeStoreWithDefault(
    (state) => state.codingPlanQuotaResetUiBySource,
    EMPTY_ENTRIES,
  );
  const setEntry = useZCodeStoreWithDefault(
    (state) => state.setCodingPlanQuotaResetUiEntry,
    NOOP_SET_ENTRY,
  );
  const reserveAutoPlay = useZCodeStoreWithDefault(
    (state) => state.reserveCodingPlanQuotaResetAutoPlay,
    NOOP_RESERVE_AUTO_PLAY,
  );
  const commitAutoPlay = useZCodeStoreWithDefault(
    (state) => state.commitCodingPlanQuotaResetAutoPlay,
    NOOP_COMMIT_AUTO_PLAY,
  );
  const releaseAutoPlay = useZCodeStoreWithDefault(
    (state) => state.releaseCodingPlanQuotaResetAutoPlay,
    NOOP_RELEASE_AUTO_PLAY,
  );
  const observationsBySource = useZCodeStoreWithDefault(
    (state) => state.codingPlanQuotaResetAutomaticObservationsBySource,
    EMPTY_AUTOMATIC_OBSERVATIONS,
  );
  const playedBySource = useZCodeStoreWithDefault(
    (state) => state.codingPlanQuotaResetAutoPlayedBySource,
    EMPTY_PLAYED,
  );
  const authSessionSeq = useZCodeStoreWithDefault((state) => state.authSessionSeq, 0);
  const authSessionSeqRef = useRef(authSessionSeq);
  authSessionSeqRef.current = authSessionSeq;
  const storedEntries = sourceKey ? entriesBySource[sourceKey] : undefined;
  const storedObservations = sourceKey ? observationsBySource[sourceKey] : undefined;
  const fiveHourObservation = storedObservations?.fiveHour ?? null;
  const weekObservation = storedObservations?.week ?? null;
  const fiveHourEntry = useMemo(
    () =>
      suppressAutomaticAnimationFromPreviousAuthEpoch(
        enabled ? (storedEntries?.fiveHour ?? null) : null,
        fiveHourObservation,
        authSessionSeq,
      ),
    [authSessionSeq, enabled, fiveHourObservation, storedEntries?.fiveHour],
  );
  const weekEntry = useMemo(
    () =>
      suppressAutomaticAnimationFromPreviousAuthEpoch(
        enabled ? (storedEntries?.week ?? null) : null,
        weekObservation,
        authSessionSeq,
      ),
    [authSessionSeq, enabled, storedEntries?.week, weekObservation],
  );
  const automaticObservationsRef = useRef({
    FIVE_HOUR: fiveHourObservation,
    WEEK: weekObservation,
  });
  automaticObservationsRef.current = {
    FIVE_HOUR: fiveHourObservation,
    WEEK: weekObservation,
  };
  // Cross-window played records go through a ref: applyStatusForType only reads the latest value, so merging played never rebuilds the callback identity.
  const playedBySourceRef = useRef(playedBySource);
  playedBySourceRef.current = playedBySource;
  const entriesRef = useRef<CodingPlanQuotaResetUiEntries>({
    fiveHour: fiveHourEntry,
    week: weekEntry,
  });
  const initialRefreshCompletedAt = (entry: CodingPlanQuotaResetUiEntry | null): number | null =>
    entry?.status === "completed" && !entry.quotaOverridePending ? entry.completedAt : null;
  // The five-hour and weekly quotas each record their own entitlement-refresh dedup key; while a completion is still under optimistic override,
  // a newly mounted entry must keep trying to refresh the real entitlement.
  const lastEntitlementRefreshRef = useRef<
    Record<CodingPlanResetType, { sourceKey: string | null; completedAt: number | null }>
  >({
    FIVE_HOUR: {
      sourceKey: sourceKey ?? null,
      completedAt: initialRefreshCompletedAt(fiveHourEntry),
    },
    WEEK: {
      sourceKey: sourceKey ?? null,
      completedAt: initialRefreshCompletedAt(weekEntry),
    },
  });
  const [now, setNow] = useState(() => Date.now());
  // onEntitlementRefresh is usually passed by callers as an inline arrow (a new identity on every render).
  // Keeping it in the useCallback deps would cascade into rebuilding refreshStatus and restart the polling effect on every
  // parent render; the dense re-renders when the settings page switches personal/team plans would fire several /opportunity
  // requests for the same scope (/status has a 1.5s freshness cache, but opportunity only merges in-flight calls).
  // Stored in a ref, the polling identity only changes with enabled/scope/sourceKey/service, while execution still reads the latest callback.
  const onEntitlementRefreshRef = useRef(onEntitlementRefresh);

  useEffect(() => {
    onEntitlementRefreshRef.current = onEntitlementRefresh;
  }, [onEntitlementRefresh]);

  useEffect(() => {
    entriesRef.current = { fiveHour: fiveHourEntry, week: weekEntry };
  }, [fiveHourEntry, weekEntry]);

  const applyStatusForType = useCallback(
    async (
      snapshot: CodingPlanResetStatusSnapshot,
      resetType: CodingPlanResetType,
    ): Promise<CodingPlanQuotaResetUiEntry | null> => {
      if (
        !sourceKey ||
        !usageStatsService ||
        !scope ||
        authSessionSeqRef.current !== authSessionSeq
      ) {
        return null;
      }
      const key = entryKeyForType(resetType);
      const previous = entriesRef.current[key];
      const manualStartedAt = resolveSharedManualResetStartedAt({
        service: usageStatsService,
        scope,
        snapshot,
        resetType,
      });
      let next = applyCodingPlanQuotaResetStatus(
        previous,
        snapshot,
        Date.now(),
        manualStartedAt,
        resetType,
      );
      // Once a backfilled old completion is held as completed by the sticky rule, createCompletedEntry renews observedAt
      // back to now; it is cleared again only when the first observed record belongs to a previous auth epoch. Other entries in the same session mounting later are not silenced.
      next = suppressAutomaticAnimationFromPreviousAuthEpoch(
        next,
        automaticObservationsRef.current[resetType],
        authSessionSeq,
      );
      // The automatic completion notice for this used_at already played in another window (this window received the cross-window already-played broadcast first).
      // Only suppress a completion "newly entering" this window; the same completion held by stickiness is not suppressed — otherwise the played record written when this
      // window played it itself would clear its own observedAt on repeated reconciliation, wrongly killing a normal short notice.
      // When suppressed, the completed state still drives the 100% optimistic override and entitlement refresh; only the tooltip/confetti is skipped.
      const playedUsedAt = playedBySourceRef.current[sourceKey]?.[key] ?? null;
      const isNewCompletionInWindow =
        previous?.status !== "completed" || previous.completedAt !== next?.completedAt;
      if (
        playedUsedAt !== null &&
        isNewCompletionInWindow &&
        next?.status === "completed" &&
        next.startedAt === null &&
        next.observedAt !== null &&
        next.completedAt === playedUsedAt
      ) {
        next = { ...next, observedAt: null };
      }
      entriesRef.current = withEntry(entriesRef.current, resetType, next);
      setEntry(sourceKey, resetType, next, authSessionSeq);

      const completedAt = next?.status === "completed" ? next.completedAt : null;
      const isNewCompletion = completedAt !== null && completedAt !== previous?.completedAt;
      // has_unread_history is a single cursor shared by both types; marking it read after either type completes clears it, and
      // used_at is unique per type, so repeated marking has no side effects.
      // Marking read must happen before the entitlement refresh. Reporting only after the refresh finishes would delay clearing the server-side cursor, during which
      // other windows polling could replay the automatic completion notice.
      if (snapshot.hasUnreadHistory && completedAt !== null) {
        void markHistoryReadOnce({
          service: usageStatsService,
          scope,
          usedAt: completedAt,
        }).catch((error) => {
          logger.warn("[coding-plan-reset] history read failed", {
            sourceKey,
            resetType,
            error: toErrorMessage(error),
          });
        });
      }

      const refreshState = lastEntitlementRefreshRef.current[resetType];
      const entitlementAlreadyRefreshed =
        refreshState.sourceKey === sourceKey && refreshState.completedAt === completedAt;
      const refreshEntitlement = onEntitlementRefreshRef.current;
      if (completedAt !== null && !entitlementAlreadyRefreshed && refreshEntitlement) {
        try {
          await refreshEntitlement();
          // On refresh failure it must not be recorded as completed early; otherwise later polls for the same used_at would never correct the real quota.
          if (authSessionSeqRef.current !== authSessionSeq) {
            return entriesRef.current[key];
          }
          lastEntitlementRefreshRef.current[resetType] = {
            sourceKey,
            completedAt,
          };
          next = completeCodingPlanQuotaResetEntitlementRefresh(next, completedAt);
          entriesRef.current = withEntry(entriesRef.current, resetType, next);
          setEntry(sourceKey, resetType, next, authSessionSeq);
        } catch (error) {
          logger.warn("[coding-plan-reset] entitlement refresh failed", {
            sourceKey,
            resetType,
            error: toErrorMessage(error),
          });
        }
      }

      if (isNewCompletion) {
        logger.info("[coding-plan-reset] completed", {
          sourceKey,
          resetType,
          completedAt,
        });
      }
      return next;
    },
    [authSessionSeq, scope, setEntry, sourceKey, usageStatsService],
  );

  const applyStatus = useCallback(
    async (snapshot: CodingPlanResetStatusSnapshot): Promise<CodingPlanQuotaResetUiEntries> => {
      // A single /status snapshot reconciles both the five-hour and weekly quotas, avoiding duplicate polling.
      for (const resetType of CODING_PLAN_QUOTA_RESET_TYPES) {
        await applyStatusForType(snapshot, resetType);
      }
      return entriesRef.current;
    },
    [applyStatusForType],
  );

  const refreshStatus = useCallback(
    async (force = false): Promise<CodingPlanQuotaResetUiEntries> => {
      if (!enabled || !usageStatsService || !scope) {
        return entriesRef.current;
      }
      const previous = entriesRef.current;
      const snapshot = await requestCodingPlanResetStatus({
        service: usageStatsService,
        scope,
        force,
        authSessionSeq,
      });
      const next = await applyStatus(snapshot);
      // /opportunity is the scope-level grant endpoint; one call evaluates both five-hour and weekly eligibility. The backend caps grants for "already holds an
      // unconsumed opportunity of the same type", so repeated calls do not stack — therefore "an available opportunity already exists" no longer blocks this call;
      // otherwise one type holding an opportunity would starve grants for the other (a weekly opportunity can sit for days, during which the five-hour one never issues).
      // Two situations still must be skipped, unrelated to the grant cap:
      // - a manual redemption is in flight: the /use reconciliation loop fires 4 times within 250ms~1.5s, and inserting /opportunity would hit the grant lock and trigger 429;
      // - this round just completed: history/read and a forced entitlement refresh are running within the completion cycle, so a grant now would be rejected by next_try_at.
      const anyTypeResetInFlight = CODING_PLAN_QUOTA_RESET_TYPES.some((resetType) => {
        const key = entryKeyForType(resetType);
        const entry = next[key];
        const previousEntry = previous[key];
        const justCompleted =
          entry?.status === "completed" &&
          entry.completedAt !== null &&
          entry.completedAt !== previousEntry?.completedAt;
        return (
          entry?.status === "processing" || previousEntry?.status === "processing" || justCompleted
        );
      });
      if (anyTypeResetInFlight) {
        return next;
      }

      try {
        // /status only queries already-granted opportunities; /opportunity must be called too, or the backend never runs the eligibility check.
        // Eligibility is still entirely decided server-side; the client triggers the check whenever it is not redeeming and not just-completed, merging concurrent
        // requests by service + scope. /opportunity is a scope-level request covering both five-hour and weekly opportunities in one call.
        const result = await requestCodingPlanResetOpportunityWhenDue({
          service: usageStatsService,
          authSessionSeq,
          scope,
        });
        if (result === null) {
          return next;
        }
        if (!result.granted) {
          return next;
        }
        const confirmedSnapshot = await requestCodingPlanResetStatus({
          service: usageStatsService,
          scope,
          force: true,
          authSessionSeq,
        });
        return applyStatus(confirmedSnapshot);
      } catch (error) {
        logger.warn("[coding-plan-reset] opportunity request failed", {
          sourceKey,
          error: toErrorMessage(error),
        });
        return next;
      }
    },
    [applyStatus, authSessionSeq, enabled, scope, sourceKey, usageStatsService],
  );

  // When each of the four UI entries kept its own 60-second timer, only in-flight calls at the exact same instant were merged;
  // staggered mounts and timer ticks still amplified /status and /opportunity. Instead there is a single Coordinator keyed by
  // auth session + service + scope; entries only subscribe, sharing one visibility listener and one polling owner.
  useEffect(() => {
    if (!enabled || !usageStatsService || !scope) {
      return;
    }
    return subscribeCodingPlanQuotaResetPolling({
      service: usageStatsService,
      authSessionSeq,
      scope,
      refresh: () => refreshStatus(false),
    });
  }, [authSessionSeq, enabled, refreshStatus, scope, usageStatsService]);

  // available countdown: start a 1-second ticker while either type is available; refresh now when entries change so the countdown/window is based on the latest time.
  useEffect(() => {
    if (!enabled) {
      return;
    }
    setNow(Date.now());
    const anyAvailable = fiveHourEntry?.status === "available" || weekEntry?.status === "available";
    if (!anyAvailable) {
      return;
    }
    const ticker = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(ticker);
  }, [enabled, fiveHourEntry, weekEntry]);

  // completed short-notice window: schedule a refresh at the nearest not-yet-expired expiry across the two types, stopping automatically once each expires.
  useEffect(() => {
    if (!enabled) {
      return;
    }
    const completed = [fiveHourEntry, weekEntry].filter(
      (candidate): candidate is CodingPlanQuotaResetUiEntry =>
        candidate?.status === "completed" && candidate.observedAt !== null,
    );
    if (completed.length === 0) {
      return;
    }
    const nowMs = Date.now();
    const nextBoundary = completed
      .map((entry) => (entry.observedAt ?? 0) + CODING_PLAN_QUOTA_RESET_DONE_DISPLAY_MS)
      .filter((boundary) => boundary > nowMs)
      .sort((left, right) => left - right)[0];
    if (nextBoundary === undefined) {
      return;
    }
    const timer = window.setTimeout(() => setNow(Date.now()), nextBoundary - nowMs);
    return () => window.clearTimeout(timer);
  }, [enabled, fiveHourEntry, weekEntry, now]);

  const reset = useCallback(
    async (resetType: CodingPlanResetType) => {
      if (!enabled || !sourceKey || !usageStatsService || !scope) {
        return;
      }
      const key = entryKeyForType(resetType);
      if (entriesRef.current[key]?.status !== "available") {
        return;
      }
      // Cross-entry double-redemption guard: when a manual redemption attempt for the same scope + type already exists (started by another entry in this window),
      // this entry may still show available based on a stale poll. Force a reconciliation first: if the other /use is still in flight, or after reconciliation this entry
      // is no longer available (the quota was already redeemed), never /use again — a second click would carry a new idempotency key and redeem twice.
      // Still available after reconciliation means the attempt belongs to an earlier redemption and a new opportunity has been granted, so a fresh redemption proceeds.
      // Multi-window / remote entries do not share this attempt; cross-window concurrency is backstopped by server-side per-opportunity redemption.
      const priorAttempt = manualResetAttemptByService
        .get(usageStatsService)
        ?.get(buildManualAttemptKey(scope, resetType));
      if (priorAttempt) {
        const reconciled = await refreshStatus(true);
        if (priorAttempt.completedAt === null || reconciled[key]?.status !== "available") {
          return;
        }
      }
      const current = entriesRef.current[key];
      if (!current || current.status !== "available") {
        return;
      }
      const idempotencyKey = current.idempotencyKey ?? createIdempotencyKey();
      const startedAt = Date.now();
      const processing = startCodingPlanQuotaResetManualUse(current, idempotencyKey, startedAt);
      if (!processing) {
        return;
      }
      // The manual reset's completion history is polled separately by the Composer, the settings page, and the Usage page.
      // The attempt must be shared by service + scope + type; it cannot rely only on the initiating entry's own processing state.
      startSharedManualResetAttempt({
        service: usageStatsService,
        scope,
        startedAt,
        resetType,
        authSessionSeq,
      });
      entriesRef.current = withEntry(entriesRef.current, resetType, processing);
      setEntry(sourceKey, resetType, processing, authSessionSeq);

      let useAccepted = false;
      try {
        await usageStatsService.useCodingPlanReset({
          ...scope,
          idempotencyKey,
          resetType,
        });
        useAccepted = true;

        for (const delayMs of USE_STATUS_RETRY_DELAYS_MS) {
          await wait(delayMs);
          const confirmed = await refreshStatus(true);
          if (confirmed[key]?.status === "completed") {
            return;
          }
        }
        throw new Error("coding_plan_reset_status_not_confirmed");
      } catch (error) {
        if (!useAccepted) {
          clearSharedManualResetAttempt(usageStatsService, scope, resetType);
        }
        const message = toErrorMessage(error);
        const failed = failCodingPlanQuotaResetManualUse(entriesRef.current[key], message);
        entriesRef.current = withEntry(entriesRef.current, resetType, failed);
        setEntry(sourceKey, resetType, failed, authSessionSeq);
        logger.warn("[coding-plan-reset] manual reset failed", {
          sourceKey,
          resetType,
          error: message,
        });
        toast(intl.formatMessage({ id: "codingPlan.quotaReset.failed" }), {
          variant: "warning",
        });
        throw error;
      }
    },
    [authSessionSeq, enabled, intl, refreshStatus, scope, setEntry, sourceKey, usageStatsService],
  );

  const resetFiveHour = useCallback(() => reset("FIVE_HOUR"), [reset]);
  const resetWeek = useCallback(() => reset("WEEK"), [reset]);
  const reserveAutomaticCompletion = useCallback(
    async (
      resetType: CodingPlanResetType,
      completedAt: number,
    ): Promise<CodingPlanQuotaResetAutoPlayReservationAttempt> => {
      if (!enabled || !sourceKey) {
        return { status: "blocked" };
      }
      try {
        return await reserveAutoPlay(sourceKey, resetType, completedAt);
      } catch (error) {
        logger.warn("[coding-plan-reset] autoplay reservation failed", {
          sourceKey,
          resetType,
          completedAt,
          error: toErrorMessage(error),
        });
        return { status: "retry", retryAfterMs: 500 };
      }
    },
    [enabled, reserveAutoPlay, sourceKey],
  );

  const commitAutomaticCompletion = useCallback(
    (reservation: CodingPlanQuotaResetAutoPlayReservation): boolean => commitAutoPlay(reservation),
    [commitAutoPlay],
  );

  const releaseAutomaticCompletion = useCallback(
    async (reservation: CodingPlanQuotaResetAutoPlayReservation): Promise<void> => {
      try {
        await releaseAutoPlay(reservation);
      } catch (error) {
        logger.warn("[coding-plan-reset] autoplay reservation release failed", {
          sourceKey: reservation.sourceKey,
          resetType: reservation.resetType,
          completedAt: reservation.completedAt,
          error: toErrorMessage(error),
        });
      }
    },
    [releaseAutoPlay],
  );

  const buildTypeController = (
    entry: CodingPlanQuotaResetUiEntry | null,
    resetFn: () => Promise<void>,
  ): CodingPlanQuotaResetTypeController => ({
    entry,
    opportunityVisible:
      entry?.status === "available" &&
      entry.opportunityCount > 0 &&
      (entry.opportunityExpiresAt ?? 0) > now,
    processing: entry?.status === "processing",
    done: entry?.status === "completed",
    statusVisible: enabled && resolveCodingPlanQuotaResetStatusVisible(entry, now),
    reset: resetFn,
  });

  return {
    enabled,
    ...buildTypeController(fiveHourEntry, resetFiveHour),
    week: buildTypeController(weekEntry, resetWeek),
    reserveAutomaticCompletion,
    commitAutomaticCompletion,
    releaseAutomaticCompletion,
  };
}
