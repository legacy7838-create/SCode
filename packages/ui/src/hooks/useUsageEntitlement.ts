/* eslint-disable max-lines -- The entitlement hook centrally handles caching, the shared in-flight
 * request, polling, and the Team Plan context; a later split must keep the refresh policy
 * consistent.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  UsageEntitlementSnapshot,
  ZCodeAccountAccess,
  ZCodeProviderAccountAccess,
} from "@zcode/shared";
import type { IUsageStatsService } from "@zcode/services";
import { useOptionalBaseWorkspaceServices } from "@/hooks/useWorkspaceServices.js";
import { useStableAccountAccess } from "@/hooks/useStableAccountAccess.js";
import { logger } from "@/logger.js";
import {
  readCachedUsageEntitlementSnapshot,
  writeCachedUsageEntitlementSnapshot,
} from "@/lib/usageEntitlementCache.js";
import {
  hasSharedEntitlementFailure,
  buildEntitlementFreshnessKey,
  beginSharedEntitlementRequest,
  publishSharedEntitlementSnapshot,
  readSharedEntitlementSnapshot,
  recordSharedEntitlementAccess,
  recordSharedEntitlementFailure,
  shouldDeferSharedEntitlementRefresh,
  shouldDeferSharedEntitlementAccess,
  shouldUseSharedEntitlementSnapshot,
  subscribeSharedEntitlementSnapshot,
  USAGE_ENTITLEMENT_ACCESS_REFRESH_MS,
  type UsageEntitlementRefreshReason,
  type UsageEntitlementRequestOptions,
} from "@/lib/usageEntitlementRefreshPolicy.js";

interface UsageEntitlementState {
  snapshot: UsageEntitlementSnapshot | null;
  loading: boolean;
  error: string | null;
}

const INITIAL_STATE: UsageEntitlementState = {
  snapshot: null,
  loading: false,
  error: null,
};

const USAGE_ENTITLEMENT_REFRESH_TIMEOUT_MS = 20_000;

export interface UsageEntitlementRefreshOptions {
  silent?: boolean;
  force?: boolean;
  reason?: UsageEntitlementRefreshReason;
}

const entitlementInflightRequests = new WeakMap<
  IUsageStatsService,
  Map<string, Promise<UsageEntitlementSnapshot>>
>();

function getSharedEntitlementSnapshot(params: {
  usageStatsService: IUsageStatsService;
  options: UsageEntitlementRequestOptions;
  requestKey: string;
}): Promise<UsageEntitlementSnapshot> {
  let serviceRequests = entitlementInflightRequests.get(params.usageStatsService);
  if (!serviceRequests) {
    serviceRequests = new Map();
    entitlementInflightRequests.set(params.usageStatsService, serviceRequests);
  }

  const requestKey = params.requestKey;
  const inflight = serviceRequests.get(requestKey);
  if (inflight) {
    return inflight;
  }

  // The sidebar, toolbar, settings page, and Usage page all read the same
  // Coding Plan entitlement on startup/opening settings. Production logs showed 12 identical quota RPCs in one minute, directly slowing the renderer.
  // Merge in-flight requests per service instance + request parameters here, while each component keeps its own state-update semantics.
  const upstreamRequest = params.usageStatsService.getEntitlementSnapshot({
    ...(params.options.invalidateBalanceCache ? { invalidateBalanceCache: true } : {}),
    includeSubscription: params.options.includeSubscription,
    preferredProviderId: params.options.preferredProviderId,
    accountAccess: params.options.accountAccess,
    allowDisabledPreferredProvider: params.options.allowDisabledPreferredProvider,
    requirePreferredProvider: params.options.requirePreferredProvider,
    allowEnvApiKey: params.options.allowEnvApiKey,
  });
  const request = withUsageEntitlementTimeout(upstreamRequest).finally(() => {
    if (serviceRequests.get(requestKey) !== request) {
      return;
    }
    serviceRequests.delete(requestKey);
    if (serviceRequests.size === 0) {
      entitlementInflightRequests.delete(params.usageStatsService);
    }
  });
  serviceRequests.set(requestKey, request);
  return request;
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message || error.name || String(error);
  }
  if (typeof error === "object" && error !== null && "message" in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string" && message.length > 0) {
      return message;
    }
  }
  return String(error);
}

function createUsageEntitlementTimeoutError(timeoutMs: number): Error {
  return new Error(`usage_entitlement_request_timeout:${timeoutMs}`);
}

function withUsageEntitlementTimeout<T>(
  request: Promise<T>,
  timeoutMs = USAGE_ENTITLEMENT_REFRESH_TIMEOUT_MS,
): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(createUsageEntitlementTimeoutError(timeoutMs));
    }, timeoutMs);
  });

  return Promise.race([request, timeout]).finally(() => {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  });
}

export interface UseUsageEntitlementOptions {
  enabled?: boolean;
  includeSubscription?: boolean;
  preferredProviderId?: string;
  accountAccess?: ZCodeProviderAccountAccess | ZCodeAccountAccess;
  allowDisabledPreferredProvider?: boolean;
  requirePreferredProvider?: boolean;
  allowEnvApiKey?: boolean;
  cacheKey?: string;
  refreshOnMount?: boolean;
  mountRefreshReason?: "initial" | "access";
}

export function useUsageEntitlement(options: UseUsageEntitlementOptions = {}) {
  const services = useOptionalBaseWorkspaceServices();
  return useUsageEntitlementWithService(services?.usageStatsService, options);
}

export function useUsageEntitlementWithService(
  usageStatsService: IUsageStatsService | undefined,
  options: UseUsageEntitlementOptions = {},
) {
  const [state, setState] = useState<UsageEntitlementState>(INITIAL_STATE);
  const requestVersionRef = useRef(0);
  const activeFreshnessKeyRef = useRef<string | null>(null);
  const latestSnapshotRef = useRef<UsageEntitlementSnapshot | null>(null);
  // Web/SSR scenarios may render only the sidebar or the settings entry, without mounting a ServiceProvider.
  // Degrade to an empty snapshot here so a missing service context does not block the entire UI tree behind the Usage banner.
  const enabled = (options.enabled ?? true) && Boolean(usageStatsService);
  const includeSubscription = options.includeSubscription ?? false;
  const preferredProviderId = options.preferredProviderId;
  // Parsing the Provider Settings schema yields an equal-but-new object every time; a reference change must not restart the entitlement request.
  const accountAccess = useStableAccountAccess(options.accountAccess);
  const allowDisabledPreferredProvider = options.allowDisabledPreferredProvider === true;
  const requirePreferredProvider = options.requirePreferredProvider === true;
  const allowEnvApiKey = options.allowEnvApiKey;
  const cacheKey = options.cacheKey?.trim() ?? "";
  const refreshOnMount = options.refreshOnMount ?? false;
  const mountRefreshReason = options.mountRefreshReason ?? "initial";
  const requestOptions = useMemo(
    () =>
      ({
        includeSubscription,
        preferredProviderId,
        accountAccess,
        allowDisabledPreferredProvider,
        requirePreferredProvider,
        allowEnvApiKey,
      }) satisfies UsageEntitlementRequestOptions,
    [
      allowDisabledPreferredProvider,
      accountAccess,
      allowEnvApiKey,
      includeSubscription,
      preferredProviderId,
      requirePreferredProvider,
    ],
  );
  const freshnessKey = useMemo(
    () =>
      buildEntitlementFreshnessKey({
        cacheKey,
        options: requestOptions,
      }),
    [cacheKey, requestOptions],
  );

  const refresh = useCallback(
    async (refreshOptions: UsageEntitlementRefreshOptions = {}) => {
      if (!enabled || !usageStatsService) {
        return;
      }
      const reason = refreshOptions.reason ?? "manual";
      const sharedSnapshot =
        refreshOptions.force === true
          ? null
          : reason === "initial"
            ? shouldUseSharedEntitlementSnapshot({
                freshnessKey,
                intervalMs: Number.POSITIVE_INFINITY,
                now: Date.now(),
                usageStatsService,
              })
            : reason === "access"
              ? shouldUseSharedEntitlementSnapshot({
                  freshnessKey,
                  // Context hovers, the plan card, and opening the Usage page all read the same quota
                  // within a short time. Access refreshes must share the one-minute window so repeated hovers do not amplify the quota RPC.
                  intervalMs: USAGE_ENTITLEMENT_ACCESS_REFRESH_MS,
                  now: Date.now(),
                  usageStatsService,
                })
              : null;
      if (sharedSnapshot) {
        setState({
          snapshot: sharedSnapshot,
          loading: false,
          error: null,
        });
        latestSnapshotRef.current = sharedSnapshot;
        return;
      }
      if (
        refreshOptions.force !== true &&
        reason === "access" &&
        shouldDeferSharedEntitlementAccess({
          freshnessKey,
          now: Date.now(),
          usageStatsService,
        })
      ) {
        setState((current) => ({ ...current, loading: false }));
        return;
      }
      if (
        refreshOptions.force !== true &&
        (reason === "initial" || reason === "access") &&
        shouldDeferSharedEntitlementRefresh({
          freshnessKey,
          now: Date.now(),
          usageStatsService,
        })
      ) {
        setState((current) => ({
          ...current,
          loading: false,
        }));
        return;
      }

      const sharedRequest = beginSharedEntitlementRequest({
        usageStatsService,
        freshnessKey,
        invalidate: reason === "purchase",
      });
      const requestVersion = requestVersionRef.current + 1;
      requestVersionRef.current = requestVersion;
      if (reason === "access") {
        recordSharedEntitlementAccess({
          freshnessKey,
          now: Date.now(),
          usageStatsService,
        });
      }
      logger.debug("[useUsageEntitlement] starting entitlement read", {
        reason,
        includeSubscription,
        preferredProviderId,
        accountAccess,
        cacheKey,
        freshnessKey,
      });
      setState((current) => ({
        snapshot: current.snapshot,
        // When the Plan Card already has a short-TTL cache, entering the provider only needs a background entitlement correction.
        // Keeping loading true would bounce the card from cached back to checking, so every entry looks like a reload.
        loading: refreshOptions.silent && current.snapshot ? false : true,
        error: null,
      }));

      try {
        const snapshot = await getSharedEntitlementSnapshot({
          usageStatsService,
          requestKey: sharedRequest.requestKey,
          options:
            reason === "purchase"
              ? { ...requestOptions, invalidateBalanceCache: true }
              : requestOptions,
        });
        if (requestVersionRef.current !== requestVersion || !sharedRequest.isCurrent()) {
          return;
        }
        publishSharedEntitlementSnapshot({
          usageStatsService,
          freshnessKey,
          snapshot,
        });
        logger.debug("[useUsageEntitlement] entitlement info updated", {
          reason,
          providerId: snapshot.provider?.id ?? null,
          scope: snapshot.context?.scope ?? null,
          organizationId: snapshot.context?.organizationId ?? null,
          projectId: snapshot.context?.projectId ?? null,
          cacheKey,
          freshnessKey,
        });
        latestSnapshotRef.current = snapshot;
        setState({
          snapshot,
          loading: false,
          error: null,
        });
        writeCachedUsageEntitlementSnapshot({ cacheKey, snapshot });
      } catch (error) {
        if (requestVersionRef.current !== requestVersion || !sharedRequest.isCurrent()) {
          return;
        }
        recordSharedEntitlementFailure({
          usageStatsService,
          freshnessKey,
        });
        const message = getErrorMessage(error);
        logger.warn("[useUsageEntitlement] failed to read entitlement info", {
          includeSubscription,
          error: message,
        });
        if (
          !latestSnapshotRef.current?.subscription?.details.length &&
          !(refreshOptions.silent && latestSnapshotRef.current)
        ) {
          latestSnapshotRef.current = null;
        }
        setState((current) => {
          if (
            current.snapshot &&
            (refreshOptions.silent || current.snapshot.subscription?.details.length)
          ) {
            return {
              // Keep the last successful result when a background refresh or a manual refresh of an already confirmed subscription fails; otherwise network jitter would knock the Plan Card from usable back to empty/error.
              snapshot: current.snapshot,
              loading: false,
              error: message,
            };
          }
          return {
            // After switching BigModel/Z.AI, if the new provider's query fails, keeping the old snapshot would make the banner/popover show the previous provider.
            // Clear the snapshot on error so stale branding and quota do not mislead the user.
            snapshot: null,
            loading: false,
            error: message,
          };
        });
      }
    },
    [cacheKey, enabled, freshnessKey, requestOptions, usageStatsService],
  );

  useEffect(() => {
    if (!enabled || !usageStatsService) {
      return;
    }
    return subscribeSharedEntitlementSnapshot({
      usageStatsService,
      freshnessKey,
      listener: (snapshot, error) => {
        latestSnapshotRef.current = snapshot;
        setState({
          snapshot,
          loading: false,
          error: error ?? null,
        });
      },
    });
  }, [enabled, freshnessKey, usageStatsService]);

  useEffect(() => {
    if (!enabled) {
      setState({
        // Queries are temporarily disabled while the Coding Plan lacks an API Key or the provider is switched.
        // Keeping the previous snapshot would let the UI keep showing the old account's plan state and could make key-less entries look queryable.
        snapshot: null,
        loading: false,
        error: null,
      });
      activeFreshnessKeyRef.current = null;
      latestSnapshotRef.current = null;
      return;
    }

    const freshnessKeyChanged = activeFreshnessKeyRef.current !== freshnessKey;
    if (freshnessKeyChanged) {
      // After a Team Plan switches team projects, the old team's active snapshot makes the initial refresh
      // skipped by the freshness policy, so the settings page keeps showing the previous team's usage. When the freshness key changes, the old
      // request and old snapshot must be invalidated first, then a refresh starts from the new team's cached/shared snapshot.
      requestVersionRef.current += 1;
      activeFreshnessKeyRef.current = freshnessKey;
      latestSnapshotRef.current = null;
      setState(INITIAL_STATE);
    }

    const cachedSnapshot = readCachedUsageEntitlementSnapshot({ cacheKey });
    const sharedSnapshot = usageStatsService
      ? readSharedEntitlementSnapshot({ usageStatsService, freshnessKey })
      : null;
    const initialSnapshot = sharedSnapshot ?? cachedSnapshot;
    if (initialSnapshot) {
      // Opening the settings page does not have to wait for the quota API to return before the Coding Plan status turns green.
      // Echo the short-TTL cache under the same provider fingerprint first, then let refresh correct the real entitlement in the background.
      setState({
        snapshot: initialSnapshot,
        loading: false,
        error:
          usageStatsService && hasSharedEntitlementFailure({ usageStatsService, freshnessKey })
            ? "usage_entitlement_refresh_failed"
            : null,
      });
      latestSnapshotRef.current = initialSnapshot;
    }

    if (refreshOnMount) {
      void refresh({
        silent: Boolean(initialSnapshot),
        force: mountRefreshReason === "initial" && !initialSnapshot,
        reason: mountRefreshReason,
      });
    }
  }, [
    cacheKey,
    enabled,
    freshnessKey,
    refresh,
    refreshOnMount,
    mountRefreshReason,
    usageStatsService,
  ]);

  return {
    snapshot: state.snapshot,
    loading: state.loading,
    error: state.error,
    refresh,
  };
}
