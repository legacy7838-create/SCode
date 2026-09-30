import { useEffect, useRef, useState } from "react";
import type { AppSettings } from "@zcode/shared";
import type { useOnboardingRecordService } from "@/hooks/useOnboardingRecordService.js";
import { logger } from "@/logger.js";

/**
 * Onboarding trigger decision: needsOnboarding=true when the current user has no entry in the local
 * record. Settings backfill (restoring preferences after switching accounts) only happens once
 * userId changes at runtime; manual edits are written back to the record by each entry point
 * (updateRecordPreferences), so the record always equals that user's latest preferences.
 *
 * Returns [needsOnboarding, markOnboarded]: null means the async decision is still in flight;
 * markOnboarded sets the decision to false once onboarding saves successfully (the record is on
 * disk, so it will not trigger again in this session).
 */
export function useOnboardingTrigger(options: {
  onboardingRecord: ReturnType<typeof useOnboardingRecordService>;
  userId: string | null;
  hasStoredOccupation: boolean;
  loadDeviceMid: () => string;
  update: (patch: Partial<AppSettings>) => Promise<void>;
}): [boolean | null, () => void] {
  const { onboardingRecord, userId, hasStoredOccupation, loadDeviceMid, update } = options;
  // null means asynchronous determination is in progress (whether to trigger is determined based on local usage records).
  const [needsOnboarding, setNeedsOnboarding] = useState<boolean | null>(null);
  // The userId of the last determination is recorded, and backfilling only occurs after the identity actually changes (see backfilling conditions below).
  const lastSyncedUserIdRef = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    let cancelled = false;
    const fallback = () => !hasStoredOccupation;
    // When the service is unavailable (old test double / unregistered host), the old settings judgment will be returned, and the behavior will not be rolled back.
    if (!onboardingRecord) {
      setNeedsOnboarding(fallback());
      return;
    }
    // shouldOnboard uses RPC, and the call will hang when the host does not bring onboarding-record channel.
    // Rendering null during the previous determination would block the entire main interface into a permanent black screen. Add a timeout and return to settings for judgment.
    // Ensure that the main interface waits at most 3 seconds under any circumstances.
    const timeout = setTimeout(() => {
      if (!cancelled) {
        logger.warn(
          "[occupation-onboarding] shouldOnboard timed out, falling back to settings check",
        );
        setNeedsOnboarding(fallback());
      }
    }, 3000);
    // Login redirection: The boot (null entry) when not logged in is handed over to the currently logged in user, and the same person will not be booted repeatedly.
    // It must be determined after await is completed, otherwise shouldOnboard will misjudge the need for guidance when reading the file before claiming.
    onboardingRecord
      .claimAnonymousRecord()
      .catch((cause: unknown) => {
        logger.warn("[occupation-onboarding] failed to claim anonymous onboarding record", {
          error: String(cause),
        });
      })
      .then(() => onboardingRecord.shouldOnboard(loadDeviceMid()))
      .then(
        (result) => {
          if (!cancelled) setNeedsOnboarding(result);
          // Change the account to restore the user preferences: settings do not distinguish between users. After A completes the answer, B triggers the guidance and the settings will be changed to
          // B's answer; when switching back to A, press record to fill in the most recent answer. If synchronization fails, only logs will be left.
          // Only backfill when "last time was another non-empty identity" (A→B straight cut, B→logout). null→id no backfill: start OAuth
          // Recovery and running login share this sequence and are indistinguishable. It is better to have less backfilling - manual modifications have been written back by each entrance.
          // record (record=latest preference), the missing backfill only affects edge scenarios such as "logging in to the old account after entering the apikey state".
          const previousUserId = lastSyncedUserIdRef.current;
          lastSyncedUserIdRef.current = userId;
          if (!cancelled && !result && previousUserId != null && previousUserId !== userId) {
            void onboardingRecord
              .syncSettingsFromRecord()
              .then((patch) => {
                if (cancelled || !patch) return;
                return update(patch);
              })
              .catch((cause: unknown) => {
                logger.warn("[occupation-onboarding] failed to sync preferences from record", {
                  error: String(cause),
                });
              });
          }
        },
        (cause) => {
          logger.warn("[occupation-onboarding] shouldOnboard check failed", {
            error: String(cause),
          });
          if (!cancelled) setNeedsOnboarding(fallback());
        },
      )
      .finally(() => clearTimeout(timeout));
    return () => {
      cancelled = true;
      clearTimeout(timeout);
    };
    // Does not rely on hasStoredOccupation (corresponding to settings?.onboardingOccupation): this field will be rewritten if saved successfully.
    // If the record writing fails, the boot will be restarted on the spot; re-triggering due to missing records will be reserved for the next startup as agreed.
  }, [onboardingRecord, userId, loadDeviceMid]);
  return [needsOnboarding, () => setNeedsOnboarding(false)];
}
