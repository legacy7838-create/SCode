import { z } from "zod";
import { browserErrorCodeSchema, browserPageStateSchema } from "./commands.js";
import { browserViewportSizeSchema } from "./command-metadata.js";
import { browserBackendTypeSchema } from "./backend.js";
import { browserSnapshotSchema, browserSnapshotElementSchema } from "./snapshot.js";

/**
 * Summary of a controlled tab (returned by the list command): the agent uses tabId to
 * address a specific tab (including a tab opened by the human).
 */
export const browserTabSummarySchema = z
  .object({
    tabId: z.string(),
    url: z.string(),
    title: z.string(),
    /** The guest's real current CSS viewport; must be returned in both normal and free-size modes. */
    viewport: browserViewportSizeSchema,
    /**
     * The most recently visible/activated built-in browser tab on the main side. It lets the
     * agent bind to and read the current page after the user manually changed the address,
     * instead of mistakenly reading the session's default tab.
     */
    active: z.boolean().optional(),
    lifecycle: z.enum(["active", "deliverable", "handoff"]).optional(),
  })
  .strict();
export type BrowserTabSummary = z.infer<typeof browserTabSummarySchema>;

/** A user IAB tab not yet claimed by the current browser session; ordinary Tab commands cannot run on it before it is claimed. */
export const browserUserTabInfoSchema = z
  .object({
    id: z.string().min(1),
    lastOpened: z.string().optional(),
    tabGroup: z.string().optional(),
    title: z.string().optional(),
    url: z.string().optional(),
  })
  .strict();
export type BrowserUserTabInfo = z.infer<typeof browserUserTabInfoSchema>;

/** JS dialog information (returned by getDialog). */
export const browserDialogSchema = z
  .object({
    type: z.enum(["alert", "confirm", "prompt", "beforeunload"]),
    message: z.string(),
    defaultPrompt: z.string().optional(),
  })
  .strict();
export type BrowserDialog = z.infer<typeof browserDialogSchema>;

/** UI/client metadata of a browser command; it never automatically becomes a model image block. */
export const browserResponseMetaSchema = z
  .object({
    browserUse: z.literal(true),
    backendType: browserBackendTypeSchema,
    browserId: z.string().min(1),
    browserGeneration: z.number().int().nonnegative(),
    openTabIds: z.array(z.string()),
    tabId: z.string().optional(),
    currentUrl: z.string().optional(),
    lifecycle: z.enum(["active", "deliverable", "handoff", "closed"]).optional(),
  })
  .strict();
export type BrowserResponseMeta = z.infer<typeof browserResponseMetaSchema>;

export const browserRecordingArtifactSchema = z
  .object({
    path: z.string().min(1),
    mimeType: z.literal("video/webm"),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    fps: z.number().positive(),
    durationMs: z.number().nonnegative(),
    frameCount: z.number().int().nonnegative(),
  })
  .strict();
export type BrowserRecordingArtifact = z.infer<typeof browserRecordingArtifactSchema>;

export const browserRecordingJobSchema = z
  .object({
    id: z.string().min(1),
    status: z.enum(["running", "completed", "failed", "cancelled"]),
    phase: z.enum(["preparing", "capturing", "finalizing", "completed", "failed", "cancelled"]),
    progress: z.number().min(0).max(1),
    startedAt: z.number().nonnegative(),
    updatedAt: z.number().nonnegative(),
    artifact: browserRecordingArtifactSchema.optional(),
    error: z.string().optional(),
  })
  .strict();
export type BrowserRecordingJob = z.infer<typeof browserRecordingJobSchema>;

/**
 * The unified result of a browser command (same source in all three places: the agent
 * BrowserControlPort / the protocol result / the main executor). Screenshots go through
 * image; navigate/getState return state; snapshot returns snapshot; list returns tabs;
 * failures return a structured error.
 */
export const browserCommandResultSchema = z
  .object({
    ok: z.boolean(),
    state: browserPageStateSchema.optional(),
    snapshot: browserSnapshotSchema.optional(),
    image: z
      .object({ base64: z.string(), mimeType: z.literal("image/png") })
      .strict()
      .optional(),
    /** Returned by the list command: only the tabs visible in the current window/workspace/session/generation scope. */
    tabs: z.array(browserTabSummarySchema).optional(),
    /** Returned by BrowserUser.openTabs(); strictly separated from the current session's own tabs.list(). */
    userTabs: z.array(browserUserTabInfoSchema).optional(),
    /** The single real tab returned by newTab. */
    tab: browserTabSummarySchema.optional(),
    /** Returned by evaluate: the JSON-serializable result of the page expression. */
    value: z.unknown().optional(),
    /** Returned by elementInfo: information about the element hit by the coordinates (reusing the snapshot element shape; omitted when nothing was hit). */
    element: browserSnapshotElementSchema.optional(),
    /** Returned by getDialog: the current JS dialog information; null when there is no dialog. */
    dialog: browserDialogSchema.nullable().optional(),
    /** An asynchronous WebView recording job; a temporary path on the main side is rewritten into a workspace path once the Host materializes it. */
    recording: browserRecordingJobSchema.optional(),
    error: z
      .object({
        code: browserErrorCodeSchema,
        message: z.string(),
        sideEffect: z.enum(["none", "uncertain"]).optional(),
      })
      .strict()
      .optional(),
    meta: browserResponseMetaSchema.optional(),
    elapsedMs: z.number().nonnegative(),
  })
  .strict();
export type BrowserCommandResult = z.infer<typeof browserCommandResultSchema>;
