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
  /** 标签栏插槽，渲染在 header 内标题后面 */
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
        // 手机浏览器的 100vh 会把地址栏区域算进页面高度，
        // 远控页底部输入框容易被挤到可视区外。动态视口高度能跟随浏览器 chrome 收放，桌面端视觉不变。
        "flex h-dvh flex-col overflow-hidden border-border text-foreground",
        // Tauri 桌面窗口是不透明直角窗口；Linux 下不再对最外层做圆角裁切，保持直角（与窗口一致）。
        // Web/Windows/Linux 都没有 macOS vibrancy 作为透明底层兜底，
        // 如果继续走半透明 alt 背景，会和浏览器或系统窗口底色混出异常灰块。
        usesOpaqueRootSurface ? "bg-background-win-alt" : "bg-background-alt",
      )}
      data-desktop-window-frame="true"
    >
      <div className="relative flex-1 min-h-0 w-full">{children}</div>
    </div>
  );
});
