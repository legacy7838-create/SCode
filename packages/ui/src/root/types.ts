import type { IPlatformService, UserInfo } from "@zcode/shared";
import type { IServiceAccessor } from "@zcode/services";
import type { ReactNode } from "react";
import type { CreateTaskRequest } from "@/app-shell/types.js";

export interface RootProps {
  services: IServiceAccessor;
  platform: IPlatformService;
  /** If passed in from the main process, the project selection page will be skipped. */
  initialWorkspaceAbsPath?: string;
  /** app-owned workspace displays categories; defaults to real projects. */
  initialWorkspacePurpose?: import("@zcode/shared").WorkspacePurpose;
  /** The exact active local workspace is not available when the desktop is started; it is only used for this renderer life cycle. */
  unavailableWorkspacePath?: string;
  /** The identity isolation key of the initial workspace, the remote workspace needs to be transparently transmitted */
  initialWorkspaceIdentity?: string;
  /** The task to be opened initially is transparently transmitted when entering from the global task list. */
  initialTaskId?: string;
  /** Electron renderer passes true to enable self-drawn title bar */
  isDesktop?: boolean;
  /** macOS desktop needs to reserve a safe area for the traffic light button */
  isMacDesktop?: boolean;
  /** Windows desktop needs to display more accurate Explorer copy */
  isWindowsDesktop?: boolean;
  /** Whether to restore the last closed tab, true for the first window, false for the new window */
  restoreSession?: boolean;
  /** Whether to allow access to local settings service, remote window false */
  supportsSettings?: boolean;
  /** Whether to allow switching/opening new workspaces in the current shell */
  allowOpenWorkspace?: boolean;
  /** Whether to give priority to using the server directory browser. Web normal mode cannot rely on the system directory selection box. */
  preferDirectoryBrowser?: boolean;
  /** Whether to support the Electron embedded browser side pane, which is only supported on the desktop by default. */
  supportsEmbeddedBrowser?: boolean;
  /** Whether to enable remote workspace capability. Web normal mode only supports local server workspace at first. */
  allowRemoteWorkspace?: boolean;
  /** The loading that continues to be displayed before the initial workspace of the non-desktop entrance is injected. It is not used on the desktop side. */
  initialWorkspaceLoadingFallback?: ReactNode;
  /** Assistant code-comment card grayscale; turned off by default, retains the original directive when turned off. */
  assistantCodeCommentCardsEnabled?: boolean;
}

export interface WorkspaceSettingsLayerProps {
  workspaceScopedServices?: IServiceAccessor;
  isDesktop?: boolean;
  isMacDesktop?: boolean;
  isWindowsDesktop?: boolean;
  windowsWindowControlsRightPaddingPx?: number;
  captionWorkspacePath?: string | null;
  onBack?: () => void;
  onCreateTask?: (request?: CreateTaskRequest) => void;
  onOpenWorkspace?: () => void;
  allowOpenWorkspace?: RootProps["allowOpenWorkspace"];
  onLogin?: () => void;
  onLogout?: () => void;
  user?: UserInfo | null;
}
