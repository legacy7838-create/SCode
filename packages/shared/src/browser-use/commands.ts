/* eslint-disable max-lines -- The Zod discriminated union of BrowserCommand must stay a single source of runtime truth; splitting it would let the protocol methods drift from the schema. */
import { z } from "zod";
import { browserViewportInputSchema } from "./command-metadata.js";

export {
  browserClientModeSchema,
  browserCommandContextSchema,
  browserCommandMethodSchema,
  browserErrorCodeSchema,
  browserPageStateSchema,
} from "./command-metadata.js";
export type {
  BrowserClientMode,
  BrowserCommandContext,
  BrowserCommandMethod,
  BrowserErrorCode,
  BrowserPageState,
} from "./command-metadata.js";

export const browserMouseButtonSchema = z.enum(["left", "right", "middle"]);
export type BrowserMouseButton = z.infer<typeof browserMouseButtonSchema>;

/** Keyboard modifiers; the executor maps these to the `modifiers` bitmask of CDP dispatchMouse/KeyEvent. */
export const browserKeyModifierSchema = z.enum([
  "Alt",
  "Control",
  "ControlOrMeta",
  "Meta",
  "Shift",
]);
export type BrowserKeyModifier = z.infer<typeof browserKeyModifierSchema>;

/** A point in viewport coordinates (used by the cua coordinate path / elementInfo / drag; same coordinate system as CDP Input). */
export const browserPointSchema = z.object({ x: z.number(), y: z.number() }).strict();
export type BrowserPoint = z.infer<typeof browserPointSchema>;

const browserRecordingDurationSchema = z.number().int().nonnegative().max(90_000);
const browserRecordingSelectorSchema = z.string().trim().min(1).max(2_000);

/** The built-in WebView recording only accepts a restricted action DSL; the recording entry point must not be used to execute arbitrary page scripts. */
export const browserRecordingActionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("wait"), durationMs: browserRecordingDurationSchema }).strict(),
  z
    .object({
      type: z.literal("click"),
      selector: browserRecordingSelectorSchema.optional(),
      x: z.number().optional(),
      y: z.number().optional(),
      button: browserMouseButtonSchema.optional(),
      doubleClick: z.boolean().optional(),
      delayAfterMs: browserRecordingDurationSchema.optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("type"),
      selector: browserRecordingSelectorSchema,
      text: z.string().max(100_000),
      delayAfterMs: browserRecordingDurationSchema.optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("hover"),
      selector: browserRecordingSelectorSchema.optional(),
      x: z.number().optional(),
      y: z.number().optional(),
      durationMs: browserRecordingDurationSchema.optional(),
      delayAfterMs: browserRecordingDurationSchema.optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("move"),
      x: z.number(),
      y: z.number(),
      durationMs: browserRecordingDurationSchema.optional(),
      delayAfterMs: browserRecordingDurationSchema.optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("scroll"),
      deltaX: z.number().optional(),
      deltaY: z.number(),
      durationMs: browserRecordingDurationSchema.optional(),
      delayAfterMs: browserRecordingDurationSchema.optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("scrollTo"),
      selector: browserRecordingSelectorSchema.optional(),
      x: z.number().optional(),
      y: z.number().optional(),
      durationMs: browserRecordingDurationSchema.optional(),
      delayAfterMs: browserRecordingDurationSchema.optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("wheel"),
      deltaX: z.number().optional(),
      deltaY: z.number(),
      times: z.number().int().min(1).max(100).optional(),
      intervalMs: browserRecordingDurationSchema.optional(),
      delayAfterMs: browserRecordingDurationSchema.optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("drag"),
      path: z.array(browserPointSchema).min(2).max(200),
      durationMs: browserRecordingDurationSchema.optional(),
      delayAfterMs: browserRecordingDurationSchema.optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("waitFor"),
      selector: browserRecordingSelectorSchema,
      state: z.enum(["attached", "detached", "visible", "hidden"]).optional(),
      timeoutMs: z.number().int().positive().max(30_000).optional(),
      delayAfterMs: browserRecordingDurationSchema.optional(),
    })
    .strict(),
]);
export type BrowserRecordingAction = z.infer<typeof browserRecordingActionSchema>;

export const browserRecordingOptionsSchema = z
  .object({
    viewport: browserViewportInputSchema.optional(),
    fps: z.number().int().min(1).max(60).optional(),
    jpegQuality: z.number().int().min(1).max(100).optional(),
    maxDurationMs: z.number().int().min(1_000).max(90_000).optional(),
    settleMs: browserRecordingDurationSchema.optional(),
    showCursor: z.boolean().optional(),
    actions: z.array(browserRecordingActionSchema).max(500).optional(),
  })
  .strict();
export type BrowserRecordingOptions = z.infer<typeof browserRecordingOptionsSchema>;

const browserRecordingOutputPathSchema = z
  .string()
  .trim()
  .min(1)
  .max(2_000)
  .refine((value) => !/^[/\\]/u.test(value) && !/^[A-Za-z]:[/\\]/u.test(value), {
    message: "recording outputPath must be relative to the workspace",
  })
  .refine(
    (value) =>
      !value
        .split(/[\\/]+/u)
        .some((segment) => segment === ".." || segment === "." || segment.length === 0),
    { message: "recording outputPath cannot escape the workspace" },
  )
  .refine((value) => value.toLowerCase().endsWith(".webm"), {
    message: "recording outputPath must end with .webm",
  });

/** The terminable operations of a Playwright locator that can cross process boundaries. The builder itself only composes selectors inside the agent. */
export const browserPlaywrightLocatorOperationSchema = z.enum([
  "allTextContents",
  "click",
  "count",
  "dblclick",
  "downloadMedia",
  "evaluate",
  "fill",
  "getAttribute",
  "innerText",
  "isEnabled",
  "isVisible",
  "press",
  "selectOption",
  "setChecked",
  "textContent",
  "waitFor",
]);
export type BrowserPlaywrightLocatorOperation = z.infer<
  typeof browserPlaywrightLocatorOperationSchema
>;

export const browserPlaywrightModifierSchema = z.enum([
  "Alt",
  "Control",
  "ControlOrMeta",
  "Meta",
  "Shift",
]);
export type BrowserPlaywrightModifier = z.infer<typeof browserPlaywrightModifierSchema>;

const browserPlaywrightTimeoutSchema = z.number().int().positive().optional();
const browserPlaywrightSelectOptionSchema = z
  .object({
    value: z.string().optional(),
    label: z.string().optional(),
    index: z.number().int().nonnegative().optional(),
  })
  .strict()
  .refine(
    (selection) =>
      selection.value !== undefined ||
      selection.label !== undefined ||
      selection.index !== undefined,
    "Select option requires value, label, or index",
  );

/**
 * Public Playwright operations use a backend-agnostic message shape, distinguished by
 * `name` and `operation`, so extension/CDP adapters can reuse the very same contract.
 */
export const browserPlaywrightActionSchema = z.discriminatedUnion("name", [
  z.object({ name: z.literal("domSnapshot") }).strict(),
  z
    .object({
      name: z.literal("elementInfo"),
      x: z.number(),
      y: z.number(),
      includeNonInteractable: z.boolean().optional(),
    })
    .strict(),
  z
    .object({
      name: z.literal("elementScreenshot"),
      x: z.number(),
      y: z.number(),
      includeNonInteractable: z.boolean().optional(),
    })
    .strict(),
  z
    .object({
      name: z.literal("evaluate"),
      expression: z.string().min(1),
      expressionKind: z.enum(["string", "function"]),
      arg: z.unknown().optional(),
      timeoutMs: browserPlaywrightTimeoutSchema,
    })
    .strict(),
  z
    .object({
      name: z.literal("waitForLoadState"),
      state: z.enum(["load", "domcontentloaded", "networkidle"]).optional(),
      timeoutMs: browserPlaywrightTimeoutSchema,
    })
    .strict(),
  z
    .object({
      name: z.literal("waitForURL"),
      url: z.string().min(1),
      waitUntil: z.enum(["load", "domcontentloaded", "networkidle", "commit"]).optional(),
      timeoutMs: browserPlaywrightTimeoutSchema,
    })
    .strict(),
  z
    .object({
      name: z.literal("waitForEvent"),
      event: z.enum(["download", "filechooser"]),
      timeoutMs: browserPlaywrightTimeoutSchema,
    })
    .strict(),
  z
    .object({
      name: z.literal("downloadPath"),
      downloadId: z.string().min(1),
      timeoutMs: browserPlaywrightTimeoutSchema,
    })
    .strict(),
  z
    .object({
      name: z.literal("fileChooserSetFiles"),
      fileChooserId: z.string().min(1),
      files: z.array(z.string()).min(1),
      timeoutMs: browserPlaywrightTimeoutSchema,
    })
    .strict(),
  z
    .object({
      name: z.literal("locator"),
      selector: z.string().min(1),
      operation: browserPlaywrightLocatorOperationSchema,
      value: z.unknown().optional(),
      arg: z.unknown().optional(),
      expression: z.string().min(1).optional(),
      expressionKind: z.enum(["string", "function"]).optional(),
      attribute: z.string().min(1).optional(),
      checked: z.boolean().optional(),
      replace: z.boolean().optional(),
      force: z.boolean().optional(),
      button: browserMouseButtonSchema.optional(),
      modifiers: z.array(browserPlaywrightModifierSchema).optional(),
      state: z.enum(["attached", "detached", "visible", "hidden"]).optional(),
      selections: z.array(browserPlaywrightSelectOptionSchema).min(1).optional(),
      timeoutMs: browserPlaywrightTimeoutSchema,
    })
    .strict(),
]);
export type BrowserPlaywrightAction = z.infer<typeof browserPlaywrightActionSchema>;

/**
 * The unified command surface: the backend only understands this one discriminated union type.
 *
 * tabId (optional): part of the agent object model, used to address a specific controlled tab
 * (including a tab opened by the human). When omitted it applies to the session's default
 * view. The manager side resolves it with `command.tabId ?? key` into the controlled view key.
 */
export const browserCommandSchema = z.discriminatedUnion("method", [
  z
    .object({
      method: z.literal("navigate"),
      url: z.string().min(1),
      tabId: z.string().optional(),
    })
    .strict(),
  z.object({ method: z.literal("back"), tabId: z.string().optional() }).strict(),
  z.object({ method: z.literal("forward"), tabId: z.string().optional() }).strict(),
  z.object({ method: z.literal("reload"), tabId: z.string().optional() }).strict(),
  z
    .object({
      method: z.literal("snapshot"),
      maxElements: z.number().int().positive().optional(),
      includeHidden: z.boolean().optional(),
      tabId: z.string().optional(),
    })
    .strict(),
  z
    .object({
      method: z.literal("click"),
      // Choose one of two options: ref (snapshot handle) and coordinates (x, y): ref uses dom_cua positioning, (x, y) uses cua visual coordinate positioning.
      ref: z.string().min(1).optional(),
      x: z.number().optional(),
      y: z.number().optional(),
      button: browserMouseButtonSchema.optional(),
      doubleClick: z.boolean().optional(),
      modifiers: z.array(browserKeyModifierSchema).optional(),
      tabId: z.string().optional(),
    })
    .strict(),
  z
    .object({
      method: z.literal("fill"),
      ref: z.string().min(1),
      value: z.string(),
      tabId: z.string().optional(),
    })
    .strict(),
  z
    .object({
      method: z.literal("type"),
      ref: z.string().min(1).optional(),
      text: z.string(),
      tabId: z.string().optional(),
    })
    .strict(),
  z
    .object({
      method: z.literal("press"),
      key: z.string().min(1),
      ref: z.string().min(1).optional(),
      modifiers: z.array(browserKeyModifierSchema).optional(),
      tabId: z.string().optional(),
    })
    .strict(),
  // CUA key combination input: keys is a key combination, which must retain the key-by-key down/up sequence and cannot be compressed into the last key + bitmask.
  z
    .object({
      method: z.literal("cuaKeypress"),
      keys: z.array(z.string().min(1)).min(1),
      tabId: z.string().optional(),
    })
    .strict(),
  z
    .object({
      method: z.literal("scroll"),
      ref: z.string().min(1).optional(),
      x: z.number().optional(),
      y: z.number().optional(),
      tabId: z.string().optional(),
    })
    .strict(),
  // CUA scroll input: The viewport anchor point and scroll delta are two different sets of coordinates and can carry modifiers.
  z
    .object({
      method: z.literal("cuaScroll"),
      x: z.number(),
      y: z.number(),
      scrollX: z.number(),
      scrollY: z.number(),
      modifiers: z.array(browserKeyModifierSchema).optional(),
      tabId: z.string().optional(),
    })
    .strict(),
  // DOM CUA scrolling input: nodeId scrolls from the center of the viewport by default; scrolls from the center of the node when it exists.
  z
    .object({
      method: z.literal("domCuaScroll"),
      nodeId: z.string().min(1).optional(),
      scrollX: z.number(),
      scrollY: z.number(),
      tabId: z.string().optional(),
    })
    .strict(),
  z
    .object({
      method: z.literal("screenshot"),
      ref: z.string().min(1).optional(),
      fullPage: z.boolean().optional(),
      // Region screenshot: CDP Page.captureScreenshot clip (viewport CSS px). Mutually exclusive with fullPage.
      clip: z
        .object({
          x: z.number(),
          y: z.number(),
          width: z.number().positive(),
          height: z.number().positive(),
        })
        .strict()
        .optional(),
      tabId: z.string().optional(),
    })
    .strict(),
  z.object({ method: z.literal("getState"), tabId: z.string().optional() }).strict(),
  // hover: Move the mouse to the element (ref) or coordinates (x, y) to trigger the hover state (cua move / dom_cua move after positioning).
  z
    .object({
      method: z.literal("hover"),
      ref: z.string().min(1).optional(),
      x: z.number().optional(),
      y: z.number().optional(),
      modifiers: z.array(browserKeyModifierSchema).optional(),
      tabId: z.string().optional(),
    })
    .strict(),
  // select: Select one or more options for <select> (matched by value or visible text).
  z
    .object({
      method: z.literal("select"),
      ref: z.string().min(1),
      values: z.array(z.string()).min(1),
      tabId: z.string().optional(),
    })
    .strict(),
  // check: Set checkbox/radio checked state (checked defaults to true).
  z
    .object({
      method: z.literal("check"),
      ref: z.string().min(1),
      checked: z.boolean().optional(),
      tabId: z.string().optional(),
    })
    .strict(),
  // Drag: Drag from the starting point (fromRef or from{x,y}) to the end point (toRef or to{x,y}), and use CDP Input to synthesize mouse dragging.
  z
    .object({
      method: z.literal("drag"),
      fromRef: z.string().min(1).optional(),
      toRef: z.string().min(1).optional(),
      from: browserPointSchema.optional(),
      to: browserPointSchema.optional(),
      modifiers: z.array(browserKeyModifierSchema).optional(),
      tabId: z.string().optional(),
    })
    .strict(),
  // CUA drag input: The complete path is a public contract, and the backend must be sent point by point instead of just taking the first and last.
  z
    .object({
      method: z.literal("cuaDrag"),
      path: z.array(browserPointSchema).min(1),
      modifiers: z.array(browserKeyModifierSchema).optional(),
      tabId: z.string().optional(),
    })
    .strict(),
  // elementInfo: Give the viewport coordinates (x, y), check back the information of the element hit at that point (role/name/rect/selector), and open up the visual ↔ structure.
  z
    .object({
      method: z.literal("elementInfo"),
      x: z.number(),
      y: z.number(),
      tabId: z.string().optional(),
    })
    .strict(),
  // evaluate: Execute JS expressions in the page scope and return JSON serializable results.
  z
    .object({
      method: z.literal("evaluate"),
      expression: z.string().min(1),
      tabId: z.string().optional(),
    })
    .strict(),
  // getDialog: Read the current JS pop-up window (alert/confirm/prompt/beforeunload) information, if not, return dialog=null.
  z.object({ method: z.literal("getDialog"), tabId: z.string().optional() }).strict(),
  // handleDialog: accept/cancel the current JS pop-up window; prompt can have promptText.
  z
    .object({
      method: z.literal("handleDialog"),
      accept: z.boolean(),
      promptText: z.string().optional(),
      tabId: z.string().optional(),
    })
    .strict(),
  z
    .object({
      method: z.literal("waitFor"),
      selector: z.string().min(1).optional(),
      text: z.string().min(1).optional(),
      textGone: z.string().min(1).optional(),
      timeoutMs: z.number().int().positive().optional(),
      tabId: z.string().optional(),
    })
    .strict(),
  // PlaywrightAPI.waitForTimeout: Fixed wait only accepts non-negative integers, 0 means giving up a timer tick.
  z
    .object({
      method: z.literal("playwrightWaitForTimeout"),
      timeoutMs: z.number().int().nonnegative(),
      tabId: z.string().optional(),
    })
    .strict(),
  z
    .object({
      method: z.literal("playwright"),
      action: browserPlaywrightActionSchema,
      tabId: z.string().optional(),
    })
    .strict(),
  z.object({ method: z.literal("capabilities"), tabId: z.string().optional() }).strict(),
  z.object({ method: z.literal("browserVisibilityGet") }).strict(),
  z.object({ method: z.literal("browserVisibilitySet"), visible: z.boolean() }).strict(),
  browserViewportInputSchema
    .extend({
      method: z.literal("browserViewportSet"),
      tabId: z.string().optional(),
    })
    .strict(),
  z.object({ method: z.literal("browserViewportReset"), tabId: z.string().optional() }).strict(),
  z
    .object({
      method: z.literal("recordingStart"),
      options: browserRecordingOptionsSchema.optional(),
      tabId: z.string().optional(),
    })
    .strict(),
  z
    .object({
      method: z.literal("recordingStatus"),
      recordingId: z.string().trim().min(1),
      outputPath: browserRecordingOutputPathSchema.optional(),
      tabId: z.string().optional(),
    })
    .strict(),
  z
    .object({
      method: z.literal("recordingCancel"),
      recordingId: z.string().trim().min(1),
      tabId: z.string().optional(),
    })
    .strict(),
  // The backend activation step of tabs.get(id): verify and update the scope selected tab; the renderer determines foreground display or background recording.
  z.object({ method: z.literal("activateTab"), tabId: z.string().min(1) }).strict(),
  z.object({ method: z.literal("newTab") }).strict(),
  z.object({ method: z.literal("listUserTabs") }).strict(),
  z.object({ method: z.literal("claimTab"), tabId: z.string().min(1) }).strict(),
  z
    .object({
      method: z.literal("finalizeTabs"),
      keep: z.array(
        z.object({ tabId: z.string().min(1), status: z.enum(["handoff", "deliverable"]) }).strict(),
      ),
    })
    .strict(),
  z.object({ method: z.literal("markDeliverable"), tabId: z.string().min(1) }).strict(),
  z.object({ method: z.literal("markHandoff"), tabId: z.string().min(1) }).strict(),
  z.object({ method: z.literal("nameSession"), name: z.string().trim().min(1) }).strict(),
  z
    .object({
      method: z.literal("finalize"),
      tabId: z.string().optional(),
      deliverable: z.boolean().optional(),
    })
    .strict(),
  z.object({ method: z.literal("turnEnded"), turnId: z.string().min(1).optional() }).strict(),
  z.object({ method: z.literal("closeSession") }).strict(),
  z.object({ method: z.literal("cancelRequest"), requestId: z.string().min(1) }).strict(),
  // close: Close the specified controlled tab (tabId default = current tab). Manager layer processing: detach + notify renderer to uninstall webview.
  z.object({ method: z.literal("close"), tabId: z.string().optional() }).strict(),
  // list: Enumerate all controlled tab summaries under the current session window. The manager layer intercepts processing and returns result.tabs.
  z.object({ method: z.literal("list") }).strict(),
]);
export type BrowserCommand = z.infer<typeof browserCommandSchema>;
