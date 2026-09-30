import { useEffect } from "react";
import type { IPlatformService } from "@zcode/shared";
import { logger } from "@/logger.js";
import { resolveTheme, type Theme } from "@/useTheme.js";

export function useDesktopNativeThemeSync({
  enabled,
  isDesktop,
  platform,
  theme,
}: {
  enabled: boolean;
  isDesktop?: boolean;
  platform: IPlatformService;
  theme: Theme;
}) {
  useEffect(() => {
    if (!enabled || !isDesktop) {
      return;
    }

    let disposed = false;
    const titleBarTheme = theme === "system" ? "system" : resolveTheme(theme);

    // The native window theme will affect macOS vibrancy; do not write nativeTheme during the startup loading phase.
    // To prevent RootStartupLoading from being overwritten by the application theme in advance when observing the window shell, synchronize again after entering the main interface.
    platform.setTitleBarTheme(titleBarTheme).catch((error) => {
      if (disposed) {
        return;
      }
      logger.error("[Root] failed to sync the title bar theme", { titleBarTheme, error });
    });

    return () => {
      disposed = true;
    };
  }, [enabled, isDesktop, platform, theme]);
}
