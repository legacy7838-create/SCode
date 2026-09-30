/**
 * useTokenRefresh — token refresh hook (resident layer)
 *
 * Mounted in the Root or App component, ensuring 401 refreshes work at any time. Listens for the
 * global 401 event and calls oauthService.refreshToken to refresh the token.
 */
import { useCallback } from "react";
import { logger } from "../logger.js";
import { useServices } from "./useServices.js";

export function useTokenRefresh() {
  const { oauthService } = useServices();

  /** Attempts to refresh the token, returns false on failure */
  const tryRefresh = useCallback(async (): Promise<boolean> => {
    try {
      await oauthService.refreshToken();
      logger.info("[useTokenRefresh] token refreshed");
      return true;
    } catch (err) {
      logger.error("[useTokenRefresh] token refresh failed:", err);
      return false;
    }
  }, [oauthService]);

  /** Clears all provider credentials */
  const clearCredentials = useCallback(async () => {
    await oauthService.logoutAll();
  }, [oauthService]);

  return { tryRefresh, clearCredentials };
}
