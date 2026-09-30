import { memo, type ReactNode } from "react";
import { cn } from "@/components/lib/utils.js";

export const DesktopWindowFrame = memo(function DesktopWindowFrameComponent({
  title: _title,
  children,
  actions: _actions,
  tabBar: _tabBar,
  isDesktop = false,
  isMacDesktop = false,
  isWindowsDesktop = false,
  headerTestId: _headerTestId,
  showHeader: _showHeader = isDesktop,
}: {
  title: string;
  children: ReactNode;
  topBar?: ReactNode;
  actions?: ReactNode;
  /** Tab bar slot, rendered behind the title in the header */
  tabBar?: ReactNode;
  isDesktop?: boolean;
  isMacDesktop?: boolean;
  isWindowsDesktop?: boolean;
  headerTestId?: string;
  showHeader?: boolean;
}) {
  const isLinuxDesktop = isDesktop && !isMacDesktop && !isWindowsDesktop;
  const usesOpaqueRootSurface = !isDesktop || isWindowsDesktop || isLinuxDesktop;

  return (
    <div
      className={cn(
        // The 100vh of the mobile browser will count the address bar area into the page height.
        // The input box at the bottom of the remote control page is easily squeezed out of the visible area. The dynamic viewport height can be retracted and retracted according to the browser chrome, and the desktop visual remains unchanged.
        "flex h-dvh flex-col overflow-hidden border-border text-foreground",
        // The opaque background color of Linux BrowserWindow will restore the outermost layer to a right angle.
        // The shell 16px forms concentric circles with the inner 12px panel and 4px inset. Linux compositor when dragging/zooming natively
        // The overflow fillet may be temporarily lost, and an additional clip-path with the same radius is used to fix the composite cropping; both are reset to zero when maximized.
        isLinuxDesktop &&
          "rounded-[16px] [clip-path:inset(0_round_16px)] platform-linux-window-maximized:rounded-none platform-linux-window-maximized:[clip-path:inset(0)]",
        // Web/Windows/Linux do not have macOS vibrancy as a transparent bottom layer.
        // If you continue to use a translucent alt background, abnormal gray blocks will be mixed with the background color of the browser or system window.
        usesOpaqueRootSurface ? "bg-background-win-alt" : "bg-background-alt",
      )}
      data-desktop-window-frame="true"
    >
      <div className="relative flex-1 min-h-0 w-full">{children}</div>
    </div>
  );
});
