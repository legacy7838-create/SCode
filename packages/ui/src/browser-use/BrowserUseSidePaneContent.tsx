import type { BrowserViewScreenshotSurfacePreparePayload } from "@zcode/shared";
import type { CSSProperties } from "react";
import { UnifiedBrowserView } from "@/browser-use/UnifiedBrowserView.js";
import { cn } from "@/components/lib/utils.js";
import { TabsContent } from "@/components/ui/tabs.js";
import type { BrowserSidePaneMetadata, BrowserUseSidePaneTab } from "@/lib/workspaceSidePane.js";

interface BrowserUseSidePaneContentProps {
  tab: BrowserUseSidePaneTab;
  isPanelVisible: boolean;
  isSelected: boolean;
  isCurrentTask: boolean;
  screenshotSurfaceRequest: BrowserViewScreenshotSurfacePreparePayload | null;
  initialUrl?: string;
  workspacePath: string;
  workspaceIdentity?: string;
  residencyGeneration?: number;
  onUrlChange(url: string): void;
  onPageMetadataChange(metadata: BrowserSidePaneMetadata): void;
}

/**
 * TabsContent dedicated to browser-use: inactive tabs keep a real composited layout only while
 * screenshots are being prepared.
 */
export function BrowserUseSidePaneContent({
  tab,
  isPanelVisible,
  isSelected,
  isCurrentTask,
  screenshotSurfaceRequest,
  initialUrl,
  workspacePath,
  workspaceIdentity,
  residencyGeneration,
  onUrlChange,
  onPageMetadataChange,
}: BrowserUseSidePaneContentProps): React.JSX.Element {
  // Screenshot surface cannot rely on the collapsed ResizablePanel to provide size: when the panel width is 0, Electron
  // The guest will be regarded by Chromium as having no compositor surface, and capturePage will fail directly. put the same portion
  // TabsContent is temporarily docked to the compositing layer within the window and visually isolated with near-transparent opacity; moved completely outside the window
  // Will be regarded as offscreen by Viz and continue to return UnknownVizError. It still does not participate in the right layout and does not uninstall the guest.
  const screenshotSurfaceStyle: CSSProperties | undefined = screenshotSurfaceRequest
    ? {
        position: "fixed",
        left: 0,
        top: 0,
        // When the fixed layer exceeds the window, Fit mistakenly believes that the viewport can be fully displayed; Windows high DPI
        // Chromium will crop the guest raster beyond the visible range, and the native screenshot will be normalized and stretched horizontally.
        // Use the host window as the upper limit, allowing Fit to scale according to the real visible canvas, maintaining the logical viewport and user preferences.
        width: `${screenshotSurfaceRequest.viewport.width}px`,
        height: `${screenshotSurfaceRequest.viewport.height + 48}px`,
        maxWidth: screenshotSurfaceRequest.surfaceScaleMode === "unscaled" ? undefined : "100vw",
        maxHeight: screenshotSurfaceRequest.surfaceScaleMode === "unscaled" ? undefined : "100vh",
        pointerEvents: "none",
        // Opacity=0 will cause Chromium to discard the guest layer; 0.001 will keep the compositor surface, which is visually invisible.
        opacity: 0.001,
      }
    : undefined;

  return (
    <TabsContent
      value={tab.id}
      forceMount
      aria-hidden={!isSelected}
      inert={!isSelected ? true : undefined}
      data-browser-use-tab-id={tab.tabId}
      data-browser-screenshot-surface-state={screenshotSurfaceRequest ? "preparing" : undefined}
      className={cn(
        "h-full min-h-0 bg-background",
        isSelected
          ? "relative z-10 flex"
          : screenshotSurfaceRequest
            ? "pointer-events-none fixed z-0 flex overflow-hidden"
            : "hidden",
      )}
      style={screenshotSurfaceStyle}
    >
      <UnifiedBrowserView
        browserKey={tab.tabId}
        isResidencyRestore={tab.residency === "restoring"}
        isVisible={isPanelVisible && isSelected}
        isSelected={isSelected}
        isCurrentTask={isCurrentTask}
        screenshotSurfaceRequest={screenshotSurfaceRequest}
        initialUrl={initialUrl}
        faviconUrl={tab.faviconUrl}
        workspacePath={workspacePath}
        workspaceIdentity={workspaceIdentity}
        workspaceKey={tab.workspaceKey ?? (workspaceIdentity?.trim() || workspacePath)}
        remoteSessionId={tab.remoteSessionId ?? undefined}
        sessionId={tab.sessionId}
        residencyGeneration={tab.residencyGeneration ?? residencyGeneration}
        browserUseOperationUntil={tab.browserUseOperationUntil}
        browserResizeBaselineVersion={tab.browserUseResizeBaselineVersion}
        onUrlChange={onUrlChange}
        onPageMetadataChange={onPageMetadataChange}
      />
    </TabsContent>
  );
}
