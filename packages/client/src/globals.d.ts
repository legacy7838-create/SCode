import type {
  DesktopCommandId,
  DesktopZoomState,
  DesktopWindowChromeState,
  DesktopTitleBarTheme,
  CuaAccessibilitySettingsResult,
  OpenCuaPermissionOnboardingOptions,
  PrepareCuaHelperPermissionDragResult,
  AppSettings,
  BrowserViewOperationPayload,
  BrowserGuestAttachResult,
  BrowserViewScreenshotSurfacePreparePayload,
  BrowserViewScreenshotSurfaceReadyPayload,
  BrowserViewScreenshotSurfaceReleasePayload,
  BrowserViewViewportChangedPayload,
  BrowserViewCloseTabNotification,
  BrowserViewCloseTabRequest,
  BrowserViewResidencyReportPayload,
  BrowserViewResidencyTransitionPayload,
  BrowserViewRestoredTabShell,
  BrowserViewRestoreTabsRequest,
  BrowserViewportSize,
  ChromeBrowserDataImportResult,
  EmbeddedBrowserOpenUrlRequest,
  EditorInfo,
  ApplicationIconInfo,
  ApplicationIconRequest,
  OAuthStateRegistration,
  PostUpdateReleaseNotesPayload,
  RemoteConnectionRuntimeLog,
  RemoteSessionClosedEvent,
  BotRemoteWorkspaceReconnectedEvent,
  RemoteTarget,
  SSHConfigAliasOption,
  RendererTelemetryEventPayload,
  RendererActionTraceBatchV1,
  RendererActionTraceConfigV1,
  RendererHeapSample,
  TelemetryRendererContext,
  TaskNotificationPayload,
  WindowScreenshotResult,
  EmbeddedBrowserDataClearResult,
  WSLDistro,
  UpdateCheckResultPayload,
  UpdateStatePayload,
  OpenInEditorOptions,
} from "@zcode/shared";

/**
 * window.zcode type definitions — only includes platform operations that require main process participation
 *
 * Credential management has been migrated to ICredentialService (via RPC) and no longer goes through this interface.
 */
declare global {
  interface Window {
    zcode: {
      connectRemote(
        options: RemoteTarget,
        requestId?: string,
        context?: {
          workspacePath: string;
          workspaceIdentity?: string;
          connectTrigger?: import("@zcode/shared").RemoteWorkspaceConnectTrigger;
        },
      ): Promise<{ success: boolean; error?: string; sessionId?: string }>;
      /** Cancel the remote connection that has not yet been fully established in the current window */
      cancelPendingRemoteConnection?(requestId?: string): Promise<void>;
      /** Bind the canonical workspace context of the remote logical session */
      bindRemoteWorkspaceSessionContext?(context: {
        remoteSessionId: string;
        workspacePath: string;
        workspaceIdentity?: string;
      }): Promise<BrowserGuestAttachResult>;
      /** Release the remote session in the current window */
      disposeRemoteSession(sessionId: string): Promise<void>;
      /** List available WSL distributions on this machine */
      listWSLDistros(): Promise<WSLDistro[]>;
      /** List aliases in the current machine's SSH config that can be used for quick form filling */
      /** Renderer logs are passed to the main process via IPC for unified storage */
      log(level: "info" | "warn" | "error", args: unknown[]): void;
      /** Open the system directory picker, returning the selected path or null */
      selectDirectory(): Promise<string | null>;
      /** Open the system file picker, returning the selected file path or null */
      selectFile(): Promise<string | null>;
      /** Open the system multi-file picker, returning selected file paths; returns an empty array when cancelled */
      selectFiles?(): Promise<string[]>;
      /** Save a file via the native system Save As dialog */
      saveFile?(
        payload: import("@zcode/shared").SaveFileRequest,
      ): Promise<import("@zcode/shared").SaveFileResult>;
      /** Export the current page's print media layout to PDF (Chromium print engine, vector text) */
      printPageToPdf?(): Promise<import("@zcode/shared").PrintPageToPdfResult>;
      /** Resolve the real local path from a Web File obtained via system drag-and-drop/file input */
      getPathForFile?(file: File): string | null;
      /** Subscribe to remote connection process logs in the current window, returning a disposer */
      onRemoteConnectionLog(handler: (entry: RemoteConnectionRuntimeLog) => void): () => void;
      /** Subscribe to remote workspace session close events, returning a disposer */
      onRemoteSessionClosed(handler: (event: RemoteSessionClosedEvent) => void): () => void;
      /** Subscribe to Bot-triggered remote workspace reconnection success events, returning a disposer */
      onBotRemoteWorkspaceReconnected(
        handler: (event: BotRemoteWorkspaceReconnectedEvent) => void,
      ): () => void;
      /** Check whether a directory is already open in another window */
      activateOrSetWorkspace?(path: string): Promise<{ activated: boolean }>;
      /** Sync workspace paths of all tabs in the current window to the main process */
      syncWindowTabs(paths: string[]): void;
      /** Sync the unread task count of the current window to the main process */
      syncWindowUnreadCount(count: number): void;
      syncActiveTaskSession(sessionId: string | null): void;
      /** Sync application settings that need immediate awareness by the main process */
      syncAppSettings?(patch: Partial<AppSettings>): void;
      /** Register a callback for the main process to request focusing a specified workspace tab, returning a disposer */
      onFocusTab(handler: (path: string) => void): () => void;
      /** Register a callback for the main process to trigger new tab creation, returning a disposer */
      onNewTab(handler: () => void): () => void;
      /** Register a callback for the built-in browser webview to request opening a new page, returning a disposer */
      onOpenBrowserUrl?(handler: (request: EmbeddedBrowserOpenUrlRequest) => void): () => void;
      onBrowserViewReady?(
        handler: (payload: {
          workspaceKey: string;
          remoteSessionId?: string;
          sessionId: string;
          tabId: string;
          browserId: string;
          browserGeneration: number;
        }) => void,
      ): () => void;
      onBrowserViewOperation?(handler: (payload: BrowserViewOperationPayload) => void): () => void;
      onBrowserViewVisibility?(
        handler: (payload: {
          visible: boolean;
          workspaceKey: string;
          remoteSessionId: string | undefined;
          sessionId: string;
          tabId?: string;
          browserId: string;
          browserGeneration: number;
        }) => void,
      ): () => void;
      onBrowserViewViewportChanged?(
        handler: (payload: BrowserViewViewportChangedPayload) => void,
      ): () => void;
      onBrowserViewScreenshotSurfacePrepare?(
        handler: (payload: BrowserViewScreenshotSurfacePreparePayload) => void,
      ): () => void;
      onBrowserViewScreenshotSurfaceRelease?(
        handler: (payload: BrowserViewScreenshotSurfaceReleasePayload) => void,
      ): () => void;
      browserViewScreenshotSurfaceReady?(payload: BrowserViewScreenshotSurfaceReadyPayload): void;
      onBrowserViewCloseTab?(
        handler: (payload: BrowserViewCloseTabNotification) => void,
      ): () => void;
      onBrowserViewSuspend?(
        handler: (payload: BrowserViewResidencyTransitionPayload) => void,
      ): () => void;
      onBrowserViewRestore?(
        handler: (payload: BrowserViewResidencyTransitionPayload) => void,
      ): () => void;
      /** Register a callback for the main process to trigger new task creation, returning a disposer */
      onNewTask(handler: () => void): () => void;
      /** Register a callback for the main process to trigger opening a workspace, returning a disposer */
      onOpenWorkspace?(handler: () => void): () => void;
      /** Register a callback for the main process to directly open a local workspace directory via deep link, returning a disposer */
      onOpenWorkspacePath?(handler: (path: string) => void): () => void;
      /** Register a callback for window fullscreen state changes, returning a disposer */
      onWindowFullscreenChanged(handler: (isFullscreen: boolean) => void): () => void;
      /** Read window maximization state and system native rounded corner capability */
      getDesktopWindowChromeState?(): Promise<DesktopWindowChromeState>;
      /** Subscribe to window maximization state and system native rounded corner capability changes */
      onDesktopWindowChromeStateChanged?(
        handler: (state: DesktopWindowChromeState) => void,
      ): () => void;
      /** Read the current desktop window page zoom level */
      getDesktopZoomLevel?(): Promise<DesktopZoomState>;
      /** Subscribe to current desktop window page zoom level changes */
      onDesktopZoomLevelChanged?(handler: (state: DesktopZoomState) => void): () => void;
      /** Register a callback for jumping to the corresponding task after the user clicks a system notification, returning a disposer */
      onTaskNotificationClick(handler: (taskId: string) => void): () => void;
      /** Open an external URL */
      openExternal(url: string): void;
      /** Query whether there is an available user community entry in the current language */
      canOpenCommunity(): Promise<boolean>;
      /** Open the specified path in the system file manager */
      openInFileManager(path: string): Promise<{ success: boolean; error?: string }>;
      /** Open a local file with the system default application */
      openExternalFile(path: string): Promise<{ success: boolean; error?: string }>;
      /** Open the ZCode Computer Use full permission guide */
      openCuaPermissionOnboarding?(
        options?: OpenCuaPermissionOnboardingOptions,
      ): Promise<CuaAccessibilitySettingsResult>;
      /** Only cancel the onboarding participant initiated by the current renderer with operationId. */
      cancelCuaPermissionOnboarding?(operationId: string): void;
      /** Preheat and cache verified Helper paths so that dragstart can synchronously call startDrag */
      prepareCuaHelperPermissionDrag?(): Promise<PrepareCuaHelperPermissionDragResult>;
      /** Drag Helper.app from the permission overlay to the macOS permission list */
      startCuaHelperPermissionDrag?(): void;
      /** Report OAuth state for deep link routing */
      registerOAuthState(payload: OAuthStateRegistration): void;
      /** Register an OAuth deep link callback, returning a disposer */
      onOAuthCallback(cb: (url: string) => void): () => void;
      /** Register a payment deep link callback, returning a disposer */
      onPaymentCallback(cb: (url: string) => void): () => void;
      /** Notify the main process that the renderer is ready */
      notifyRendererReady(): void;
      /** Sync the current renderer's telemetry context to the main process */
      syncTelemetryContext(context: TelemetryRendererContext): void;
      /** Report business telemetry events uniformly through the main process */
      reportTelemetryEvent(payload: RendererTelemetryEventPayload): Promise<void>;
      /** Read the Desktop Renderer user action Trace grayscale configuration. */
      getRendererActionTraceConfig?(): Promise<RendererActionTraceConfigV1>;
      /** Subscribe to Renderer user action Trace grayscale configuration changes. */
      onRendererActionTraceConfigChanged?(
        callback: (config: RendererActionTraceConfigV1) => void,
      ): () => void;
      /** Send a completed ui_action batch; Main does not return business results. */
      reportRendererActionTraceBatch?(batch: RendererActionTraceBatchV1): void;
      /** The main window renderer's 60-second heap reading; one-way send, Main does not acknowledge. */
      reportRendererHeapSample?(sample: RendererHeapSample): void;
      /** Trigger the system notification corresponding to the task status */
      showTaskNotification(payload: TaskNotificationPayload): void;
      /** Export logs: package ~/.zcode/v2 and external agent logs into a zip and show in Finder */
      exportLogs(): Promise<{
        success: boolean;
        path?: string;
        error?: string;
      }>;
      /** Capture the current window for error feedback with scene screenshots */
      captureWindowScreenshot?(): Promise<WindowScreenshotResult | null>;
      browserViewAttachGuest?(payload: {
        key: string;
        webContentsId: number;
        active?: boolean;
        workspaceKey?: string;
        remoteSessionId?: string;
        sessionId?: string;
        residencyGeneration?: number;
      }): Promise<void>;
      /** Before rebuilding `<webview>`, have main precisely disconnect the old guest's CDP. */
      browserViewDetachGuest?(payload: { key: string; webContentsId: number }): Promise<boolean>;
      browserViewCloseTab?(payload: BrowserViewCloseTabRequest): Promise<void>;
      browserViewReportResidency?(payload: BrowserViewResidencyReportPayload): Promise<void>;
      browserViewSuspendReady?(payload: { tabId: string; generation: number }): Promise<void>;
      browserViewEnsureResident?(payload: BrowserViewCloseTabRequest): Promise<void>;
      browserViewRestoreTabs?(
        payload: BrowserViewRestoreTabsRequest,
      ): Promise<BrowserViewRestoredTabShell[]>;
      /** Renderer freely resizes and writes back to main. */
      browserViewUpdateViewport?(payload: {
        tabId: string;
        viewport: BrowserViewportSize | null;
      }): Promise<void>;
      /** One-time import of built-in browser data from an auto-discovered Chrome Profile. */
      importChromeBrowserData?(
        options?: import("@zcode/shared").ChromeBrowserDataImportOptions,
      ): Promise<ChromeBrowserDataImportResult>;
      /** Clear built-in browser cache or all site data. */
      clearEmbeddedBrowserData?(mode: "cache" | "all"): Promise<EmbeddedBrowserDataClearResult>;
      /** Register a callback for when a new version has finished downloading, returning a disposer */
      onUpdateReady(callback: (version: string) => void): () => void;
      /** Register a callback for "manual check for updates" results, returning a disposer */
      onUpdateCheckResult(callback: (payload: UpdateCheckResultPayload) => void): () => void;
      /** Register a callback for continuous auto-update status changes, returning a disposer */
      onUpdateStateChanged?(callback: (payload: UpdateStatePayload) => void): () => void;
      /** Actively read the current auto-update status */
      getUpdateState?(): Promise<UpdateStatePayload>;
      /** Start downloading the currently discovered update */
      downloadUpdate?(): Promise<void>;
      /** Cancel the currently downloading update */
      cancelUpdateDownload?(): Promise<void>;
      /** Open or focus the standalone update window */
      openUpdateStatusWindow?(): Promise<void>;
      /** Read auto-update preferences */
      getAutoUpdatePreferences?(): Promise<{
        autoDownloadAndInstallUpdates: boolean;
      }>;
      /** Set the "Automatically download and install updates" preference */
      setAutoDownloadAndInstallUpdates?(enabled: boolean): Promise<void>;
      /** Skip the currently discovered update version */
      skipUpdateVersion?(version: string): Promise<void>;
      /** Subscribe to notifications after the main process modifies settings */
      onSettingsChanged?(callback: () => void): () => void;
      /** Query the number of sessions currently running on the desktop */
      getDesktopSessionActivity?(): Promise<{
        runningAgentSessionCount: number;
      }>;
      /** Register a callback for version notes after update installation, returning a disposer */
      onPostUpdateReleaseNotes(
        callback: (payload: PostUpdateReleaseNotesPayload) => void,
      ): () => void;
      /** Mark the current version notes as read */
      acknowledgePostUpdateReleaseNotes(version: string): Promise<void>;
      /** User confirms restart to install update */
      quitAndInstallUpdate(): Promise<void>;
      /** Get the list of installed editors/terminals (with icons) */
      getInstalledEditors(): Promise<EditorInfo[]>;
      /** Get system app icon by compatible bundle id or structured locator */
      getApplicationIcon?(
        request: string | ApplicationIconRequest,
      ): Promise<ApplicationIconInfo | null>;
      /** Open a path with the specified editor */
      openInEditor(
        editorId: string,
        path: string,
        options?: OpenInEditorOptions,
      ): Promise<{ success: boolean; error?: string }>;
      /** Execute desktop window-level commands */
      executeDesktopCommand(command: DesktopCommandId): Promise<void>;
      /** Sync title bar light/dark color */
      setTitleBarTheme(theme: DesktopTitleBarTheme): Promise<void>;
    };
  }
}
