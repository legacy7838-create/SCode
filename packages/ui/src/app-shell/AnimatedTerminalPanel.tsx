import { useCallback, useEffect, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import type { RefObject } from "react";
import type { PanelImperativeHandle } from "react-resizable-panels";
import type { IServiceAccessor } from "@zcode/services";
import { Terminal } from "@/Terminal.js";
import { ScopedErrorBoundary } from "@/ErrorBoundary.js";
import { cn } from "@/components/lib/utils.js";
import { ResizableHandle, ResizablePanel } from "@/components/ui/resizable.js";

export function AnimatedTerminalPanel({
  services,
  workspaceAbsPath,
  workspaceIdentity,
  openWorkspaceKeys,
  isVisible,
  isWindowsDesktop,
  frameClassName = "rounded-xl border border-border",
  panelRef,
  panelElementRef,
  onClose,
  onOpenBrowserUrl,
}: {
  services: IServiceAccessor;
  workspaceAbsPath: string;
  workspaceIdentity?: string;
  openWorkspaceKeys?: string[];
  isVisible: boolean;
  isWindowsDesktop?: boolean;
  frameClassName?: string;
  panelRef: RefObject<PanelImperativeHandle | null>;
  panelElementRef: RefObject<HTMLDivElement | null>;
  onClose: () => void;
  onOpenBrowserUrl: (url: string) => void;
}) {
  const [hasRenderedTerminal, setHasRenderedTerminal] = useState(isVisible);
  const [isTerminalPanelResizing, setIsTerminalPanelResizing] = useState(false);
  const isDragCollapsible = !isVisible;
  const isResizeDisabled = !isVisible;
  const workspaceKey = workspaceIdentity?.trim() || workspaceAbsPath;

  const finishTerminalPanelResize = useCallback(() => {
    setIsTerminalPanelResizing(false);
  }, []);

  const handleTerminalPanelResizeStart = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (!isVisible || (event.pointerType === "mouse" && event.button !== 0)) {
        return;
      }

      // Continuous ResizeObserver callbacks will be generated when the terminal panel is dragged.
      // Explicitly mark the drag window, let TerminalSession resize at low frequency during dragging, and then flush the final size after letting go.
      setIsTerminalPanelResizing(true);
    },
    [isVisible],
  );

  useEffect(() => {
    if (isVisible) {
      // A session should not be created in advance before Terminal is expanded for the first time, otherwise even if the user has never opened the terminal,
      // The xterm and backend terminal processes will also be created in vain. Here it is changed to render after the first expansion.
      // Subsequent collapse only hides but does not uninstall, so as to retain the session and avoid repeated initialization.
      setHasRenderedTerminal(true);
    }
  }, [isVisible]);

  useEffect(() => {
    if (!isVisible) {
      setIsTerminalPanelResizing(false);
    }
  }, [isVisible]);

  useEffect(() => {
    if (!isTerminalPanelResizing) {
      return;
    }

    window.addEventListener("pointerup", finishTerminalPanelResize);
    window.addEventListener("pointercancel", finishTerminalPanelResize);
    window.addEventListener("blur", finishTerminalPanelResize);
    return () => {
      window.removeEventListener("pointerup", finishTerminalPanelResize);
      window.removeEventListener("pointercancel", finishTerminalPanelResize);
      window.removeEventListener("blur", finishTerminalPanelResize);
    };
  }, [finishTerminalPanelResize, isTerminalPanelResizing]);

  return (
    <>
      {isVisible ? (
        <ResizableHandle
          data-workspace-terminal-resize-handle="true"
          className={cn(
            "aria-[orientation=horizontal]:h-1 aria-[orientation=horizontal]:w-full aria-[orientation=horizontal]:mx-0 aria-[orientation=horizontal]:translate-y-0 aria-[orientation=horizontal]:[mask-image:none] aria-[orientation=horizontal]:[-webkit-mask-image:none] hover:bg-transparent data-[separator=hover]:bg-transparent data-[separator=active]:bg-transparent focus-visible:bg-transparent after:pointer-events-none after:absolute after:rounded-full after:bg-foreground-subtlest/50 after:opacity-0 after:transition-opacity after:content-[''] after:inset-x-[var(--workspace-panel-radius,var(--radius-xl))] after:h-0.5 hover:after:opacity-100 data-[separator=hover]:after:opacity-100 data-[separator=active]:after:opacity-100 focus-visible:after:opacity-100",
            isTerminalPanelResizing && "after:opacity-100",
          )}
          onPointerCancel={finishTerminalPanelResize}
          onPointerDown={handleTerminalPanelResizeStart}
          onPointerUp={finishTerminalPanelResize}
        />
      ) : null}
      <ResizablePanel
        id="terminal"
        panelRef={panelRef}
        elementRef={panelElementRef}
        defaultSize="0px"
        minSize="140px"
        maxSize="50%"
        collapsedSize="0px"
        // Previously, when the terminal panel was dragged to the minimum height, it would directly enter collapsed, which shared the same trigger condition as manual closing.
        // Here, folding is only allowed when the terminal is explicitly closed, the original switch animation is retained, and "drag to minimum and automatically collapsed" is removed.
        collapsible={isDragCollapsible}
        // Although the ResizableHandle is not rendered after collapsing, the library will still treat the edge of the collapsed panel as a draggable hotspot.
        // Disable the resize target that hides the terminal panel to prevent users from dragging the terminal out from the edge.
        disabled={isResizeDisabled}
        className={cn(
          "transition-opacity duration-200 ease-out",
          isVisible ? "opacity-100" : "pointer-events-none opacity-0",
        )}
      >
        <div
          data-workspace-terminal-frame="true"
          className={cn("h-full overflow-hidden bg-background", frameClassName)}
        >
          {hasRenderedTerminal ? (
            <div aria-hidden={!isVisible} className="h-full">
              {/* The terminal is not rendered before it is expanded for the first time to avoid meaningless initialization;
                  Keep it mounted after the first expansion, and only hide it but not uninstall it when you collapse it, so that you can directly reuse the existing session the next time you expand it. */}
              <ScopedErrorBoundary
                scope="workspace-terminal"
                resetKeys={[workspaceKey]}
                variant="panel"
                className="h-full"
              >
                <Terminal
                  services={services}
                  cwd={workspaceAbsPath}
                  workspaceIdentity={workspaceIdentity}
                  openWorkspaceKeys={openWorkspaceKeys}
                  isVisible={isVisible}
                  isPanelResizing={isTerminalPanelResizing}
                  isWindowsDesktop={isWindowsDesktop}
                  onClose={onClose}
                  onOpenBrowserUrl={onOpenBrowserUrl}
                />
              </ScopedErrorBoundary>
            </div>
          ) : null}
        </div>
      </ResizablePanel>
    </>
  );
}
