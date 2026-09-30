import type { IPlatformService, UpdateStatePayload } from "@zcode/shared";
import { cn } from "@/components/lib/utils.js";
import {
  ArrowLeftIcon,
  ArrowRightIcon,
  MessageCirclePlus,
  PanelLeftClose,
  PanelLeftOpen,
} from "lucide-react";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { UpdateStatusButton } from "@/UpdateStatusButton.js";
import { DesktopTopOverlayActionButton } from "@/DesktopTopOverlayActionButton.js";
import {
  createWindowsCaptionControlsStyle,
  WINDOWS_CAPTION_CONTROLS_RIGHT_INSET_VAR,
} from "@/windowCaptionControls.js";

interface DesktopTopOverlayProps {
  workspaceAbsPath: string;
  isMacDesktop?: boolean;
  isMacFullscreen?: boolean;
  isWindowsDesktop?: boolean;
  isDesktop?: boolean;
  macWindowControlsLeftPaddingPx?: number;
  windowsWindowControlsRightPaddingPx?: number;
  isSidebarVisible: boolean;
  updateReadyVersion: string | null;
  updateState: UpdateStatePayload | null;
  toggleSidebarShortcutLabel: string;
  newTaskShortcutLabel: string;
  goBackShortcutLabel: string;
  goForwardShortcutLabel: string;
  canTaskNavBack: boolean;
  canTaskNavForward: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  showNewTaskButton?: boolean;
  appLogoUrl: string;
  platform: IPlatformService;
  onToggleSidebar: () => void;
  onCreateTask: () => void;
  onGoBack: () => void;
  onGoForward: () => void;
  hideTaskNavigationButtons?: boolean;
  newTaskDisabledReason?: string;
}

export function DesktopTopOverlay({
  workspaceAbsPath: _workspaceAbsPath,
  isMacDesktop,
  isMacFullscreen,
  isWindowsDesktop,
  isDesktop,
  macWindowControlsLeftPaddingPx,
  windowsWindowControlsRightPaddingPx,
  isSidebarVisible,
  updateReadyVersion,
  updateState,
  toggleSidebarShortcutLabel,
  newTaskShortcutLabel,
  goBackShortcutLabel,
  goForwardShortcutLabel,
  canTaskNavBack,
  canTaskNavForward,
  canGoBack: _canGoBack,
  canGoForward: _canGoForward,
  showNewTaskButton,
  appLogoUrl,
  platform,
  onToggleSidebar,
  onCreateTask,
  onGoBack,
  onGoForward,
  hideTaskNavigationButtons = false,
  newTaskDisabledReason,
}: DesktopTopOverlayProps) {
  const { intl } = useZCodeIntl();
  const SidebarToggleIcon = isSidebarVisible ? PanelLeftClose : PanelLeftOpen;
  const isLinuxDesktop = Boolean(isDesktop && !isMacDesktop && !isWindowsDesktop);
  const usesCustomCaptionArea = isWindowsDesktop || isLinuxDesktop;
  const toggleSidebarTitle = intl.formatMessage({
    id: "workspaceSidebar.toggleSidebar",
  });
  const newTaskTitle = intl.formatMessage({ id: "sidebar.newTask" });
  const taskBackTitle = intl.formatMessage({ id: "taskNav.back" });
  const taskForwardTitle = intl.formatMessage({ id: "taskNav.forward" });
  const isNewTaskButtonVisible = showNewTaskButton ?? !isSidebarVisible;
  const macTopOverlayPaddingStyle =
    isMacDesktop && !isMacFullscreen && Number.isFinite(macWindowControlsLeftPaddingPx)
      ? { paddingLeft: `${Math.round(macWindowControlsLeftPaddingPx ?? 96)}px` }
      : undefined;
  const windowsTopOverlayPaddingStyle = isWindowsDesktop
    ? {
        ...createWindowsCaptionControlsStyle(windowsWindowControlsRightPaddingPx),
        paddingRight: WINDOWS_CAPTION_CONTROLS_RIGHT_INSET_VAR,
      }
    : undefined;
  const topOverlayWidthStyle = isSidebarVisible
    ? { width: "var(--workspace-sidebar-panel-width)" }
    : undefined;

  return (
    <div
      style={topOverlayWidthStyle}
      className={cn(
        "@container/topoverlayer pointer-events-none absolute h-14 flex left-0 top-0 z-20 w-fit",
        // The Windows/Linux main panel adds 4px white space and 1px border. The left tool group needs to be offset synchronously to align with the Header center line.
        usesCustomCaptionArea && "top-1 mt-px",
      )}
    >
      <div
        style={{
          ...macTopOverlayPaddingStyle,
          ...windowsTopOverlayPaddingStyle,
        }}
        className={cn(
          "flex items-center",
          isMacDesktop && "h-14",
          usesCustomCaptionArea && "h-12",
          // The Windows/Linux toolset takes into account 4px margin and 1px border, 5px right from the 8px left margin.
          usesCustomCaptionArea && "pl-3 ml-px",
          isMacDesktop &&
            (isMacFullscreen ? (!isSidebarVisible ? "pl-5 pt-1" : "pl-3 pt-1") : "pt-1"),
        )}
      >
        <div
          className={cn(
            // Top floating button Although a single button is no-drag, the outer container itself is still suspended above the window title area.
            // On such overlays, Electron will prioritize hitting the dragging area according to the parent, causing the click to be swallowed by the window dragging.
            // Here, the entire interactive container is marked as no-drag to ensure that expand/collapse and new task can be clicked stably.
            "pointer-events-auto flex items-center gap-1 shrink-0 [app-region:no-drag]",
          )}
        >
          {usesCustomCaptionArea && (
            <DesktopTopOverlayActionButton
              title={toggleSidebarTitle}
              shortcut={toggleSidebarShortcutLabel}
              ariaLabel={toggleSidebarTitle}
              buttonClassName="group relative overflow-hidden rounded-lg"
              onClick={onToggleSidebar}
            >
              <img
                src={appLogoUrl}
                alt="ZCode"
                className="size-5 transition-opacity duration-150 group-hover:opacity-0"
                draggable={false}
              />
              <SidebarToggleIcon className="absolute inset-0 m-auto size-4 opacity-0 transition-opacity duration-150 group-hover:opacity-100" />
            </DesktopTopOverlayActionButton>
          )}

          {isMacDesktop && (
            <DesktopTopOverlayActionButton
              title={toggleSidebarTitle}
              shortcut={toggleSidebarShortcutLabel}
              ariaLabel={toggleSidebarTitle}
              onClick={onToggleSidebar}
            >
              <SidebarToggleIcon className="size-4" />
            </DesktopTopOverlayActionButton>
          )}

          {/* The space in the upper left corner of the remote control mobile terminal is limited, and task forward/reverse will overlap with the main operation here.*/}
          {hideTaskNavigationButtons ? null : (
            <>
              <DesktopTopOverlayActionButton
                title={taskBackTitle}
                shortcut={goBackShortcutLabel}
                ariaLabel={taskBackTitle}
                testId="desktop-top-nav-back"
                disabled={!canTaskNavBack}
                onClick={onGoBack}
              >
                <ArrowLeftIcon className="size-4" />
              </DesktopTopOverlayActionButton>
              <DesktopTopOverlayActionButton
                title={taskForwardTitle}
                shortcut={goForwardShortcutLabel}
                ariaLabel={taskForwardTitle}
                disabled={!canTaskNavForward}
                onClick={onGoForward}
              >
                <ArrowRightIcon className="size-4" />
              </DesktopTopOverlayActionButton>
            </>
          )}

          <div
            aria-hidden={!isNewTaskButtonVisible}
            className={cn(
              "inline-flex overflow-hidden transition-[opacity,width] duration-300 ease-out",
              isNewTaskButtonVisible ? "w-7 opacity-100" : "pointer-events-none w-0 opacity-0",
            )}
          >
            <DesktopTopOverlayActionButton
              title={newTaskDisabledReason ?? newTaskTitle}
              shortcut={newTaskShortcutLabel}
              ariaLabel={newTaskTitle}
              disabled={Boolean(newTaskDisabledReason)}
              onClick={onCreateTask}
            >
              <MessageCirclePlus className="size-4" />
            </DesktopTopOverlayActionButton>
          </div>

          {/* <div className="flex items-center [app-region:no-drag]"> */}
          {/* After the sidebar is collapsed, the update button will be hidden together with the "expanded container width threshold".
                  But the collapsed state itself has been changed to concentrate operations on the top floating layer. If we continue to rely on the sidebar width judgment here,
                  Users will not be able to see the update button when they need the global entry most.
                  Therefore, the expanded state continues to query the container, and the collapsed state is forced to display. */}
          <UpdateStatusButton
            platform={platform}
            version={updateReadyVersion}
            updateState={updateState}
            isMacDesktop={isMacDesktop}
            isWindowsDesktop={isWindowsDesktop}
          />
          {/* </div> */}
        </div>
      </div>
    </div>
  );
}
