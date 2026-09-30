import type { TraceContext } from "../tracing/tracer.js";

/**
 * BrowserControlPort -- the browser control port on the agent side.
 *
 * The browser-client library turns every agent.browsers.* call into a BrowserCommand and executes it through this port;
 * the implementation (ProtocolBrowserControlBroker) translates it into a ZCode Protocol
 * interaction/browserExecute reverse request, executed by the app (host->main WebContentsView/CDP).
 *
 * On types: BrowserCommand/BrowserCommandResult are isomorphic to the browser-use contract in @zcode/shared.
 * A structural mirror is defined here (without importing @zcode/shared, to avoid coupling agent contracts' zod v3 to shared's zod v4
 * across packages); the protocol boundary validates at runtime with shared's zod schema, and a round-trip test guarantees the two sides agree.
 */

/** Playwright is the Tab API layer, not a backend family. */
export type BrowserBackendType = "iab" | "extension" | "cdp";

export interface BrowserCapabilityDescriptor {
  id: string;
  description: string;
}

/** A backend descriptor whose handshake completed and which is genuinely reachable; the id is the runtime connection identity and cannot be replaced by the type. */
export interface BrowserBackendDescriptor {
  id: string;
  generation: number;
  type: BrowserBackendType;
  name: string;
  capabilities: {
    browser?: BrowserCapabilityDescriptor[];
    tab?: BrowserCapabilityDescriptor[];
  };
  apiSupportOverrides?: Record<string, boolean>;
  metadata?: Record<string, string>;
}

/** ZCode Protocol uses a wrapped result; BrowserControlPort.list unwraps it and returns the browsers directly. */
export interface BrowserBackendListResult {
  browsers: BrowserBackendDescriptor[];
}

export type BrowserClientMode = "desktop-continuous" | "web-remote-replayable";
export type BrowserSessionContextKind = "live" | "cached";

/** Keeps the same set of CSS px bounds as the Desktop free-size viewport. */
export const BROWSER_VIEWPORT_LIMITS = {
  minWidth: 320,
  maxWidth: 3840,
  minHeight: 320,
  maxHeight: 2160,
} as const;

export interface BrowserViewportSize {
  width: number;
  height: number;
}

/** The full workspace/session isolation context used by backend discovery. */
export interface BrowserDiscoveryContext {
  requestId: string;
  workspaceKey: string;
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  sessionId: string;
  turnId?: string;
  clientMode: BrowserClientMode;
  sessionContext: BrowserSessionContextKind;
}

/** execute carries one more thing than discovery: an exact runtime browser identity. */
export interface BrowserSessionContext extends BrowserDiscoveryContext {
  browserId: string;
  browserGeneration: number;
}

export type BrowserCommandMethod =
  | "navigate"
  | "back"
  | "forward"
  | "reload"
  | "snapshot"
  | "click"
  | "fill"
  | "type"
  | "press"
  | "cuaKeypress"
  | "scroll"
  | "cuaScroll"
  | "domCuaScroll"
  | "hover"
  | "select"
  | "check"
  | "drag"
  | "cuaDrag"
  | "screenshot"
  | "getState"
  | "elementInfo"
  | "evaluate"
  | "getDialog"
  | "handleDialog"
  | "waitFor"
  | "playwright"
  | "playwrightWaitForTimeout"
  | "capabilities"
  | "browserVisibilityGet"
  | "browserVisibilitySet"
  | "browserViewportSet"
  | "browserViewportReset"
  | "recordingStart"
  | "recordingStatus"
  | "recordingCancel"
  | "activateTab"
  | "newTab"
  | "finalize"
  | "finalizeTabs"
  | "listUserTabs"
  | "claimTab"
  | "markDeliverable"
  | "markHandoff"
  | "nameSession"
  | "turnEnded"
  | "closeSession"
  | "cancelRequest"
  | "close"
  | "list";

export type BrowserMouseButton = "left" | "right" | "middle";
export type BrowserKeyModifier = "Alt" | "Control" | "ControlOrMeta" | "Meta" | "Shift";
export type BrowserPlaywrightModifier = BrowserKeyModifier;
export type BrowserPlaywrightLocatorOperation =
  | "allTextContents"
  | "click"
  | "count"
  | "dblclick"
  | "downloadMedia"
  | "evaluate"
  | "fill"
  | "getAttribute"
  | "innerText"
  | "isEnabled"
  | "isVisible"
  | "press"
  | "selectOption"
  | "setChecked"
  | "textContent"
  | "waitFor";
export type BrowserPlaywrightAction =
  | { name: "domSnapshot" }
  | { name: "elementInfo"; x: number; y: number; includeNonInteractable?: boolean }
  | { name: "elementScreenshot"; x: number; y: number; includeNonInteractable?: boolean }
  | {
      name: "evaluate";
      expression: string;
      expressionKind: "string" | "function";
      arg?: unknown;
      timeoutMs?: number;
    }
  | {
      name: "waitForLoadState";
      state?: "load" | "domcontentloaded" | "networkidle";
      timeoutMs?: number;
    }
  | {
      name: "waitForURL";
      url: string;
      waitUntil?: "load" | "domcontentloaded" | "networkidle" | "commit";
      timeoutMs?: number;
    }
  | { name: "waitForEvent"; event: "download" | "filechooser"; timeoutMs?: number }
  | { name: "downloadPath"; downloadId: string; timeoutMs?: number }
  | {
      name: "fileChooserSetFiles";
      fileChooserId: string;
      files: string[];
      timeoutMs?: number;
    }
  | {
      name: "locator";
      selector: string;
      operation: BrowserPlaywrightLocatorOperation;
      value?: unknown;
      arg?: unknown;
      expression?: string;
      expressionKind?: "string" | "function";
      attribute?: string;
      checked?: boolean;
      replace?: boolean;
      force?: boolean;
      button?: BrowserMouseButton;
      modifiers?: BrowserPlaywrightModifier[];
      state?: "attached" | "detached" | "visible" | "hidden";
      selections?: Array<{ value?: string; label?: string; index?: number }>;
      timeoutMs?: number;
    };
export interface BrowserPoint {
  x: number;
  y: number;
}

export type BrowserRecordingAction =
  | { type: "wait"; durationMs: number }
  | {
      type: "click";
      selector?: string;
      x?: number;
      y?: number;
      button?: BrowserMouseButton;
      doubleClick?: boolean;
      delayAfterMs?: number;
    }
  | { type: "type"; selector: string; text: string; delayAfterMs?: number }
  | {
      type: "hover";
      selector?: string;
      x?: number;
      y?: number;
      durationMs?: number;
      delayAfterMs?: number;
    }
  | { type: "move"; x: number; y: number; durationMs?: number; delayAfterMs?: number }
  | {
      type: "scroll";
      deltaX?: number;
      deltaY: number;
      durationMs?: number;
      delayAfterMs?: number;
    }
  | {
      type: "scrollTo";
      selector?: string;
      x?: number;
      y?: number;
      durationMs?: number;
      delayAfterMs?: number;
    }
  | {
      type: "wheel";
      deltaX?: number;
      deltaY: number;
      times?: number;
      intervalMs?: number;
      delayAfterMs?: number;
    }
  | { type: "drag"; path: BrowserPoint[]; durationMs?: number; delayAfterMs?: number }
  | {
      type: "waitFor";
      selector: string;
      state?: "attached" | "detached" | "visible" | "hidden";
      timeoutMs?: number;
      delayAfterMs?: number;
    };

export interface BrowserRecordingOptions {
  viewport?: BrowserViewportSize;
  fps?: number;
  jpegQuality?: number;
  maxDurationMs?: number;
  settleMs?: number;
  showCursor?: boolean;
  actions?: BrowserRecordingAction[];
}

// tabId (optional): The agent object model is used to address the specified controlled tab (including tabs opened by human); the default is used for the session default view.
// Synchronized with @zcode/shared browserCommandSchema variant structure mirroring.
export type BrowserCommand =
  | { method: "navigate"; url: string; tabId?: string }
  | { method: "back"; tabId?: string }
  | { method: "forward"; tabId?: string }
  | { method: "reload"; tabId?: string }
  | { method: "snapshot"; maxElements?: number; includeHidden?: boolean; tabId?: string }
  | {
      method: "click";
      ref?: string;
      x?: number;
      y?: number;
      button?: BrowserMouseButton;
      doubleClick?: boolean;
      modifiers?: BrowserKeyModifier[];
      tabId?: string;
    }
  | { method: "fill"; ref: string; value: string; tabId?: string }
  | { method: "type"; ref?: string; text: string; tabId?: string }
  | { method: "press"; key: string; ref?: string; modifiers?: BrowserKeyModifier[]; tabId?: string }
  | { method: "cuaKeypress"; keys: string[]; tabId?: string }
  | { method: "scroll"; ref?: string; x?: number; y?: number; tabId?: string }
  | {
      method: "cuaScroll";
      x: number;
      y: number;
      scrollX: number;
      scrollY: number;
      modifiers?: BrowserKeyModifier[];
      tabId?: string;
    }
  | { method: "domCuaScroll"; nodeId?: string; scrollX: number; scrollY: number; tabId?: string }
  | {
      method: "hover";
      ref?: string;
      x?: number;
      y?: number;
      modifiers?: BrowserKeyModifier[];
      tabId?: string;
    }
  | { method: "select"; ref: string; values: string[]; tabId?: string }
  | { method: "check"; ref: string; checked?: boolean; tabId?: string }
  | {
      method: "drag";
      fromRef?: string;
      toRef?: string;
      from?: BrowserPoint;
      to?: BrowserPoint;
      modifiers?: BrowserKeyModifier[];
      tabId?: string;
    }
  | {
      method: "cuaDrag";
      path: BrowserPoint[];
      modifiers?: BrowserKeyModifier[];
      tabId?: string;
    }
  | {
      method: "screenshot";
      ref?: string;
      fullPage?: boolean;
      clip?: { x: number; y: number; width: number; height: number };
      tabId?: string;
    }
  | { method: "getState"; tabId?: string }
  | { method: "elementInfo"; x: number; y: number; tabId?: string }
  | { method: "evaluate"; expression: string; tabId?: string }
  | { method: "getDialog"; tabId?: string }
  | { method: "handleDialog"; accept: boolean; promptText?: string; tabId?: string }
  | {
      method: "waitFor";
      selector?: string;
      text?: string;
      textGone?: string;
      timeoutMs?: number;
      tabId?: string;
    }
  | { method: "playwrightWaitForTimeout"; timeoutMs: number; tabId?: string }
  | { method: "playwright"; action: BrowserPlaywrightAction; tabId?: string }
  | { method: "capabilities"; tabId?: string }
  | { method: "browserVisibilityGet" }
  | { method: "browserVisibilitySet"; visible: boolean }
  | { method: "browserViewportSet"; width: number; height: number; tabId?: string }
  | { method: "browserViewportReset"; tabId?: string }
  | { method: "recordingStart"; options?: BrowserRecordingOptions; tabId?: string }
  | {
      method: "recordingStatus";
      recordingId: string;
      outputPath?: string;
      tabId?: string;
    }
  | { method: "recordingCancel"; recordingId: string; tabId?: string }
  | { method: "activateTab"; tabId: string }
  | { method: "newTab" }
  | { method: "listUserTabs" }
  | { method: "claimTab"; tabId: string }
  | {
      method: "finalizeTabs";
      keep: Array<{ tabId: string; status: "handoff" | "deliverable" }>;
    }
  | { method: "markDeliverable"; tabId: string }
  | { method: "markHandoff"; tabId: string }
  | { method: "nameSession"; name: string }
  | { method: "finalize"; tabId?: string; deliverable?: boolean }
  | { method: "turnEnded"; turnId?: string }
  | { method: "closeSession" }
  | { method: "cancelRequest"; requestId: string }
  // close: Close the specified controlled tab; handled by the manager layer.
  | { method: "close"; tabId?: string }
  // list: enumerates the summary of all controlled tabs under the current session window, the manager layer intercepts and processes, and returns tabs.
  | { method: "list" };

export type BrowserErrorCode =
  | "backend_unavailable"
  | "capability_unsupported"
  | "duplicate_request_id"
  | "ref_not_found"
  | "navigation_blocked"
  | "timeout"
  | "renderer_unreachable"
  | "cancelled"
  | "execution_error";

export interface BrowserPageState {
  url: string;
  title: string;
  canGoBack: boolean;
  canGoForward: boolean;
  scrollX?: number;
  scrollY?: number;
  viewportWidth?: number;
  viewportHeight?: number;
}

export interface BrowserSnapshotElement {
  ref: string;
  tag: string;
  role?: string;
  name?: string;
  text?: string;
  value?: string;
  disabled?: boolean;
  checked?: boolean;
  selector: string;
  xpath: string;
  rect: { x: number; y: number; width: number; height: number };
  inViewport: boolean;
  parentRef?: string;
  framePath?: string;
  attributes?: Record<string, string>;
}

export interface BrowserSnapshotDomNode {
  tag: string;
  depth: number;
  inViewport: boolean;
  ref?: string;
  role?: string;
  name?: string;
  text?: string;
  attributes?: Record<string, string>;
}

export interface BrowserSnapshot {
  url: string;
  title: string;
  elements: BrowserSnapshotElement[];
  truncated: boolean;
  dom?: BrowserSnapshotDomNode[];
  domTruncated?: boolean;
}

/** A controlled tab summary (returned by the list command); kept in sync as a mirror of browserTabSummarySchema in @zcode/shared. */
export interface BrowserTabSummary {
  tabId: string;
  url: string;
  title: string;
  /** The guest's real current CSS viewport; both normal and free-size must return it. */
  viewport: BrowserViewportSize;
  /** The currently visible/active built-in browser tab; the agent uses it to read preferentially the page the user is looking at. */
  active?: boolean;
  lifecycle?: "active" | "deliverable" | "handoff";
}

export interface BrowserUserTabInfo {
  id: string;
  lastOpened?: string;
  tabGroup?: string;
  title?: string;
  url?: string;
}

export interface BrowserResponseMeta {
  browserUse: true;
  backendType: BrowserBackendType;
  browserId: string;
  browserGeneration: number;
  openTabIds: string[];
  tabId?: string;
  currentUrl?: string;
  lifecycle?: "active" | "deliverable" | "handoff" | "closed";
}

/** JS dialog information (returned by getDialog). */
export interface BrowserDialog {
  type: "alert" | "confirm" | "prompt" | "beforeunload";
  message: string;
  defaultPrompt?: string;
}

export interface BrowserRecordingArtifact {
  path: string;
  mimeType: "video/webm";
  width: number;
  height: number;
  fps: number;
  durationMs: number;
  frameCount: number;
}

export interface BrowserRecordingJob {
  id: string;
  status: "running" | "completed" | "failed" | "cancelled";
  phase: "preparing" | "capturing" | "finalizing" | "completed" | "failed" | "cancelled";
  progress: number;
  startedAt: number;
  updatedAt: number;
  artifact?: BrowserRecordingArtifact;
  error?: string;
}

export interface BrowserCommandResult {
  ok: boolean;
  state?: BrowserPageState;
  snapshot?: BrowserSnapshot;
  image?: { base64: string; mimeType: "image/png" };
  /** What the list command returns: summaries of all controlled tabs under the current session window. */
  tabs?: BrowserTabSummary[];
  userTabs?: BrowserUserTabInfo[];
  tab?: BrowserTabSummary;
  /** What evaluate returns: the JSON-serializable result of the page expression. */
  value?: unknown;
  /** What elementInfo returns: information about the element under the coordinates (omitted when nothing was hit). */
  element?: BrowserSnapshotElement;
  /** What getDialog returns: the current JS dialog information; null when there is no dialog. */
  dialog?: BrowserDialog | null;
  recording?: BrowserRecordingJob;
  error?: { code: BrowserErrorCode; message: string; sideEffect?: "none" | "uncertain" };
  meta?: BrowserResponseMeta;
  elapsedMs: number;
}

export interface BrowserControlExecuteInput {
  /** The exact runtime backend id; passing only the iab/extension/cdp family is not enough. */
  browserId: string;
  browserGeneration: number;
  sessionId: string;
  turnId?: string;
  command: BrowserCommand;
  traceContext?: TraceContext;
  signal?: AbortSignal;
}

export interface BrowserControlListInput {
  sessionId: string;
  turnId?: string;
  traceContext?: TraceContext;
  signal?: AbortSignal;
}

export interface BrowserControlPort {
  /** Only returns backends whose handshake completed and that are reachable from the current context; faked stubs are not allowed. */
  list(input: BrowserControlListInput): Promise<BrowserBackendDescriptor[]>;
  execute(input: BrowserControlExecuteInput): Promise<BrowserCommandResult>;
  /** At the end of a turn, cancels that turn's unfinished IAB requests; tabs are not cleared across sessions. */
  turnEnded?(input: BrowserControlListInput): Promise<void>;
  /** Releases the browser guest, pending requests and leases when the session closes. */
  closeSession?(input: BrowserControlListInput): Promise<void>;
}
