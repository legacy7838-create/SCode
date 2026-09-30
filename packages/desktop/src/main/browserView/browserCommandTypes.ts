/**
 * The minimal abstraction of a controlled view: the executor only depends on these members, which
 * makes it unit-testable with a stub (no real Electron webContents needed). The production
 * implementation comes from browserGuestManager, backed by a `<webview>` guest's webContents plus
 * webContents.debugger.
 */
export interface ControlledViewWebContents {
  loadURL(url: string): Promise<void>;
  getURL(): string;
  getTitle(): string;
  canGoBack(): boolean;
  canGoForward(): boolean;
  goBack(): void;
  goForward(): void;
  reload(): void;
  /**
   * Executes a script in the page context and returns the value of its last expression
   * (structured-cloned). browserGuestManager wires this to `guest.executeJavaScript(script, true)`
   * (userGesture=true, matching element-picker).
   */
  executeJavaScript(script: string): Promise<unknown>;
}

export interface ControlledViewCdp {
  /** Pass-through for `webContents.debugger.sendCommand`; sessionId targets cross-process iframe/OOPIF sessions. */
  send(method: string, params?: unknown, sessionId?: string): Promise<unknown>;
}

export interface ControlledView {
  webContents: ControlledViewWebContents;
  cdp: ControlledViewCdp;
  /**
   * A viewport screenshot already composited by the host compositor. Only used for plain
   * screenshots with no clip and not fullPage; the Desktop production implementation reads the
   * guest surface directly from the main process, sidestepping CDP's tiling of small surfaces on
   * Windows.
   */
  captureViewportScreenshot?: () => Promise<string | undefined>;
  /**
   * A freely-sized guest's visible surface keeps the host backing scale, while the screenshot
   * target is still computed in CSS px. The executor reads CDP layout metrics and validates the
   * actual raster only when this flag is set.
   */
  normalizeScreenshotToCssPixels?: boolean;
  /**
   * High-quality downsampling provided by the host image engine. The core executor does not depend
   * on Electron directly; the Desktop production wiring uses nativeImage, while tests and other
   * hosts can inject an equivalent implementation.
   */
  resizeScreenshotToCssPixels?: (
    base64Png: string,
    target: { height: number; width: number },
  ) => Promise<string | undefined> | string | undefined;
}

export interface BrowserPoint {
  cx: number;
  cy: number;
}
