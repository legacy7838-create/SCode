/**
 * usePlatform — provides IPlatformService through a React Context
 *
 * Platform actions (native dialogs, window lifecycle, and so on) are reached through this hook
 * instead of calling window.zcode directly.
 */
import { createContext, useContext, useCallback, type ReactNode } from "react";
import type { IPlatformService, RemoteTarget } from "@zcode/shared";

const PlatformContext = createContext<IPlatformService | null>(null);

export function PlatformProvider({
  platform,
  children,
}: {
  platform: IPlatformService;
  children: ReactNode;
}) {
  return <PlatformContext.Provider value={platform}>{children}</PlatformContext.Provider>;
}

export function usePlatform(): IPlatformService {
  const ctx = useOptionalPlatform();
  if (!ctx) {
    throw new Error("usePlatform must be used within a PlatformProvider");
  }
  return ctx;
}

export function useOptionalPlatform(): IPlatformService | null {
  const ctx = useContext(PlatformContext);
  return ctx;
}

/** Convenience hook for picking a directory */
export function useSelectDirectory() {
  const platform = usePlatform();
  return useCallback(() => platform.selectDirectory(), [platform]);
}

/** Convenience hook for connecting to a remote */
export function useConnectRemote() {
  const platform = usePlatform();
  return useCallback(
    async (options: RemoteTarget, requestId?: string) => {
      const result = await platform.connectRemote(options, requestId);
      if (!result.success) {
        throw new Error(result.error || "Connection failed");
      }
    },
    [platform],
  );
}
