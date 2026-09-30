import type {
  BrowserViewportSize,
  BrowserViewScreenshotSurfacePreparePayload,
  BrowserViewScreenshotSurfaceReleasePayload,
  BrowserViewSurfaceScaleMode,
} from "@zcode/shared";

const VIEWPORT_TOLERANCE_PX = 1;

export interface BrowserScreenshotActivityLease {
  readonly invalidated?: AbortSignal;
  markPrepared?(): void;
  release(): void;
}

export interface BrowserScreenshotSurfaceLease {
  readonly invalidated?: AbortSignal;
  surfaceScale: number;
  webContentsId: number;
  viewport: BrowserViewportSize;
  release(): void;
}

export interface BrowserScreenshotSurfaceCoordinator {
  prepare(input: {
    requestId: string;
    windowId: number;
    workspaceKey: string;
    sessionId: string;
    browserId: string;
    browserGeneration: number;
    tabId: string;
    webContentsId: number;
    viewport: BrowserViewportSize;
    viewportMode?: BrowserViewScreenshotSurfacePreparePayload["viewportMode"];
    /** recording uses the real 100% renderer surface; retains the current preview ratio when normal screenshots are missing. */
    surfaceScaleMode?: BrowserViewSurfaceScaleMode;
    signal: AbortSignal;
    /** recording can explicitly request a longer but still bounded activity watchdog; normal screenshots continue to use the default value. */
    activityTimeoutMs?: number;
  }): Promise<BrowserScreenshotSurfaceLease>;
}

export type BrowserScreenshotSurfacePrepareInput = Parameters<
  BrowserScreenshotSurfaceCoordinator["prepare"]
>[0];

export interface BrowserScreenshotPendingRequest {
  input: BrowserScreenshotSurfacePrepareInput;
  group: BrowserScreenshotPreparationGroup;
  resolve: (lease: BrowserScreenshotSurfaceLease) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  abortListener: () => void;
}

export interface BrowserScreenshotPreparationGroup {
  key: string;
  payload: BrowserViewScreenshotSurfacePreparePayload;
  windowId: number;
  requests: Set<BrowserScreenshotPendingRequest>;
  prepareSent: boolean;
  ready: boolean;
  released: boolean;
  senderWebContentsId?: number;
  readySurfaceScale?: number;
  readyViewport?: BrowserViewportSize;
  leaseReleases: Set<() => void>;
  invalidationController: AbortController;
  activityLease?: BrowserScreenshotActivityLease;
  activityAbortListener?: () => void;
  activityTimer?: ReturnType<typeof setTimeout>;
  activityTimeoutMs?: number;
}

export function sameBrowserScreenshotViewport(
  expected: BrowserViewportSize,
  actual: BrowserViewportSize,
): boolean {
  return (
    Math.abs(expected.width - actual.width) <= VIEWPORT_TOLERANCE_PX &&
    Math.abs(expected.height - actual.height) <= VIEWPORT_TOLERANCE_PX
  );
}

export function releaseBrowserScreenshotResourceOnce(callback: () => void): () => void {
  let released = false;
  return () => {
    if (released) return;
    released = true;
    callback();
  };
}

export function toBrowserScreenshotSurfacePreparePayload(
  input: BrowserScreenshotSurfacePrepareInput,
  timeoutMs: number,
): BrowserViewScreenshotSurfacePreparePayload {
  return {
    requestId: input.requestId,
    workspaceKey: input.workspaceKey,
    sessionId: input.sessionId,
    browserId: input.browserId,
    browserGeneration: input.browserGeneration,
    tabId: input.tabId,
    webContentsId: input.webContentsId,
    viewport: input.viewport,
    ...(input.viewportMode ? { viewportMode: input.viewportMode } : {}),
    ...(input.surfaceScaleMode ? { surfaceScaleMode: input.surfaceScaleMode } : {}),
    timeoutMs,
  };
}

export function toBrowserScreenshotSurfaceReleasePayload(
  payload: BrowserViewScreenshotSurfacePreparePayload,
): BrowserViewScreenshotSurfaceReleasePayload {
  const {
    surfaceScaleMode: _surfaceScaleMode,
    timeoutMs: _timeoutMs,
    viewport: _viewport,
    viewportMode: _viewportMode,
    ...releasePayload
  } = payload;
  return releasePayload;
}
