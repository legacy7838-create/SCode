import { useCallback } from "react";
import { usePlatform } from "@/hooks/usePlatform.js";
import { logger } from "@/logger.js";

export function useCancelPendingRemoteConnection() {
  const platform = usePlatform();

  return useCallback(
    async (requestId?: string) => {
      try {
        await (platform.cancelPendingRemoteConnection?.(requestId) ?? Promise.resolve());
      } catch (sessionError) {
        logger.warn("[SSHDialog] failed to cancel in-flight remote connection:", sessionError);
      }
    },
    [platform],
  );
}
