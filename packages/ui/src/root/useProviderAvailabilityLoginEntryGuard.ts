import { useCallback, useEffect, useRef, useState } from "react";
import type { UserInfo } from "@zcode/shared";
import type { ModelSelectionView } from "@zcode/services";
import { resolveProviderAvailabilityState } from "@/lib/modelProviderAvailability.js";
import { logger } from "@/logger.js";

interface ProviderAvailabilityLoginEntryGuardResult {
  hasUsableProvider: boolean;
  providerCount: number;
  shouldOpenLoginEntry: boolean;
}

export function useProviderAvailabilityLoginEntryGuard({
  enabled = true,
  user,
  isRestoringOAuthSession,
  providerFamilyDomain,
  modelSelectionView,
  modelSelectionError,
  refreshProviderState,
  readModelSelectionView,
  setLoginEntryOpen,
}: {
  enabled?: boolean;
  user: UserInfo | null;
  isRestoringOAuthSession: boolean;
  providerFamilyDomain: string | null | undefined;
  modelSelectionView: ModelSelectionView | null;
  modelSelectionError?: Error;
  refreshProviderState: () => Promise<void>;
  readModelSelectionView: () => Promise<ModelSelectionView>;
  setLoginEntryOpen: (open: boolean) => void;
}) {
  const [startupCheckCompleted, setStartupCheckCompleted] = useState(!enabled);
  const startupCheckCompletedRef = useRef(false);
  const providerAvailabilityHydrated = modelSelectionView !== null;

  const syncLoginEntryWithProviderAvailability = useCallback(
    async (options: { forceRefresh?: boolean; reason: string }) => {
      if (!enabled) {
        return {
          hasUsableProvider: true,
          providerCount: modelSelectionView?.providers.length ?? 0,
          shouldOpenLoginEntry: false,
        } satisfies ProviderAvailabilityLoginEntryGuardResult;
      }

      if (options.forceRefresh) {
        await refreshProviderState();
      }

      const refreshedView = options.forceRefresh
        ? await readModelSelectionView()
        : modelSelectionView;
      const availability = resolveProviderAvailabilityState({ modelSelectionView: refreshedView });
      const { hasUsableProvider, providerCount } = availability;
      const shouldOpenLoginEntry = !providerFamilyDomain || (!user && !hasUsableProvider);

      // When not logged in and there is no available model configuration, the user must be guided to connect to the account or fill in the API Key.
      // Entrances such as startup check, API Key setting reflow, etc. are unified here to avoid semantic bifurcation after copying and judging everywhere.
      logger.info("[Root] provider availability login entry guard finished its check", {
        reason: options.reason,
        source: availability.source,
        providerCount,
        hasUsableProvider,
        hasUser: Boolean(user),
        hasProviderFamilyDomain: Boolean(providerFamilyDomain),
        shouldOpenLoginEntry,
      });
      setLoginEntryOpen(shouldOpenLoginEntry);
      return {
        hasUsableProvider,
        providerCount,
        shouldOpenLoginEntry,
      } satisfies ProviderAvailabilityLoginEntryGuardResult;
    },
    [
      enabled,
      modelSelectionView,
      providerFamilyDomain,
      refreshProviderState,
      readModelSelectionView,
      setLoginEntryOpen,
      user,
    ],
  );

  useEffect(() => {
    if (!enabled) {
      startupCheckCompletedRef.current = true;
      setStartupCheckCompleted(true);
      return;
    }

    if (modelSelectionError) {
      // The first read failure cannot be disguised as "no Provider", nor can the startup access control be permanently stuck at loading.
      logger.error(
        "[Root] failed to read provider availability, ending the startup gate wait",
        modelSelectionError,
      );
      startupCheckCompletedRef.current = true;
      setStartupCheckCompleted(true);
      return;
    }

    if (
      startupCheckCompletedRef.current ||
      isRestoringOAuthSession ||
      !providerAvailabilityHydrated
    ) {
      return;
    }

    startupCheckCompletedRef.current = true;
    void syncLoginEntryWithProviderAvailability({
      reason: "startup",
    }).finally(() => {
      setStartupCheckCompleted(true);
    });
  }, [
    enabled,
    isRestoringOAuthSession,
    modelSelectionError,
    providerAvailabilityHydrated,
    syncLoginEntryWithProviderAvailability,
  ]);

  return {
    startupCheckCompleted,
    syncLoginEntryWithProviderAvailability,
  };
}
