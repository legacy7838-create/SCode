// Presentation layer schema of zcode-protocol-v4 toolCall.
// Detached from rows.ts: rows.ts triggers oxlint max-lines(400) after the increments on both sides are superimposed.
// This file only contains a pure display union that does not depend on rowBaseFields. rows.ts depends on it in one direction and has no loop.
import { z } from "zod";
import { bashOutputDisplaySchema } from "../bash-output-display.js";
import { timestampSchema } from "./core.js";
import { OFFICIAL_MCP_TOOL_ERROR_CODES } from "../official-mcp-tool-error.js";
import { cuaRequestAccessStatusSchema } from "./cuaPermission.js";
import { toolCallCreateWorkflowDisplaySchema } from "./create-workflow-display.js";
import {
  toolCallEvalWorkflowSnippetDisplaySchema,
  toolCallGetWorkflowRunDisplaySchema,
  toolCallListModelsDisplaySchema,
  toolCallListWorkflowRunsDisplaySchema,
  toolCallSavedWorkflowListDisplaySchema,
  toolCallResumeWorkflowRunDisplaySchema,
} from "./workflow-observation-display.js";

// toolCall's structured display model of final state output (port from feat; CUA tool depends on kind: "cua" branch
// errorCode/suggestedAction/media(screenshot) and other structured content is brought to the renderer). before consume-main
// Missing this union + toolOutputSchema.display field - the protocol layer zod verification will display the entire display issued by the agent
// strip, the UI will never be able to get display?.kind==="cua", and the CUA tool call will degenerate into fallback rendering.
const toolResultDisplaySchema = z.discriminatedUnion("kind", [
  bashOutputDisplaySchema,
  z.object({
    kind: z.literal("file_diff"),
    filePath: z.string().min(1),
    additions: z.number().int().nonnegative(),
    deletions: z.number().int().nonnegative(),
    structuredPatch: z.array(
      z.object({
        oldStart: z.number().int(),
        oldLines: z.number().int(),
        newStart: z.number().int(),
        newLines: z.number().int(),
        lines: z.array(z.string()),
      }),
    ),
    truncated: z.boolean().optional(),
  }),
  z.object({
    kind: z.literal("local_agent_message"),
    status: z.enum(["success", "failed"]),
    error: z.string().optional(),
    message: z.string().optional(),
  }),
  z.object({
    kind: z.literal("task_stop"),
    taskId: z.string().min(1),
    taskType: z.string().min(1),
    command: z.string().min(1).optional(),
    message: z.string().min(1),
    truncated: z.boolean().optional(),
  }),
  z.object({
    kind: z.literal("task_output"),
    retrievalStatus: z.enum(["success", "not_ready", "timeout"]),
    taskStatus: z.string().min(1).max(64).optional(),
    output: z.string().min(1).max(2_000).optional(),
    truncated: z.literal(true).optional(),
  }),
  z.object({
    kind: z.literal("respond_to_coordinator"),
    status: z.enum(["success", "failed"]),
  }),
  z.object({
    kind: z.literal("cua"),
    schemaVersion: z.literal(1),
    toolName: z.string().min(1),
    status: z.enum(["success", "failed"]),
    // The old v1 snapshot once carried ToolCallRow.input repeatedly; it will only continue to be accepted for historical playback.
    input: z.string().optional(),
    structuredContent: z.string().optional(),
    text: z.string().optional(),
    errorCode: z.string().optional(),
    suggestedAction: z.string().optional(),
    permissionStatus: cuaRequestAccessStatusSchema.optional(),
    targetApp: z
      .object({
        schemaVersion: z.literal(1),
        displayName: z.string().trim().min(1).max(512).optional(),
        iconLocators: z
          .array(
            z.discriminatedUnion("kind", [
              z
                .object({
                  kind: z.literal("darwin-bundle-id"),
                  value: z.string().trim().min(1).max(512),
                })
                .strict(),
              z
                .object({
                  kind: z.literal("windows-executable-path"),
                  value: z.string().trim().min(1).max(32_768),
                })
                .strict(),
              z
                .object({
                  kind: z.literal("windows-aumid"),
                  value: z.string().trim().min(1).max(512),
                })
                .strict(),
            ]),
          )
          .max(3),
      })
      .strict()
      .optional(),
    media: z
      .array(
        z.object({
          mimeType: z.string().min(1),
          data: z.string().min(1).max(349_528).optional(),
          artifactUri: z.string().min(1).optional(),
        }),
      )
      .max(4)
      .optional(),
    truncated: z.boolean().optional(),
  }),
  z.object({
    kind: z.literal("mcp_tool"),
    serverName: z.string().min(1).max(256),
    toolName: z.string().min(1).max(256),
    description: z
      .string()
      .min(1)
      .max(4 * 1024)
      .optional(),
    // Same origin as toolCallMcpDisplaySchema: if not declared here, zod will issue the agent as unavailable
    // Silently strip is removed, and the official MCP quota prompt is invalid on the v4 link (same as the pitfall of display strip at the top of this document).
    unavailable: z
      .object({ code: z.enum(OFFICIAL_MCP_TOOL_ERROR_CODES) })
      .strict()
      .optional(),
  }),
  // buildToolOutput inserts the CLI side ToolResultDisplayPayload into toolOutput.display as it is,
  // And this union is strict - create_workflow is not among the members, and the display of CreateWorkflow will be replaced by the entire section.
  // Reject/stripped, the tool card degrades into plain text. The member tables on both sides must be synchronized (same as contracts
  // toolResultDisplayPayloadSchema), so directly reuse the same schema on the toolCall side.
  toolCallCreateWorkflowDisplaySchema,
  // Five display kind + ResumeWorkflowRun recovery cards for observation workflow tools (same as above: with contracts
  // Side synchronization, missing member = whole block stripped).
  toolCallGetWorkflowRunDisplaySchema,
  toolCallListWorkflowRunsDisplaySchema,
  toolCallEvalWorkflowSnippetDisplaySchema,
  toolCallSavedWorkflowListDisplaySchema,
  toolCallListModelsDisplaySchema,
  toolCallResumeWorkflowRunDisplaySchema,
]);
export type ToolResultDisplay = z.infer<typeof toolResultDisplaySchema>;

// toolCall. The final state output is uniformly truncated by head+tail in all files, and truncated.ref is pulled out as needed.
// display is the display payload; when the version is incompatible, it is downgraded to no card to avoid repeated recovery failures for the entire subscription due to the same content.
export const toolOutputSchema = z.object({
  text: z.string(),
  display: toolResultDisplaySchema.optional().catch(undefined),
  truncated: z
    .object({
      totalBytes: z.number(),
      ref: z.string(),
    })
    .optional(),
});
export type ToolOutput = z.infer<typeof toolOutputSchema>;

export const toolProgressSchema = z.object({
  bytes: z.number(),
  previewLine: z.string().optional(),
  updatedAt: timestampSchema,
});
export type ToolProgress = z.infer<typeof toolProgressSchema>;

/**
 * The target application identity of the node_repl cell (Computer Use tool card icon). with CLI contracts
 * `nodeReplCuaAppDisplaySchema` must be in the same set - strict on both sides. One missing field will strip off the entire display.
 */
const toolCallNodeReplCuaAppDisplaySchema = z
  .object({
    appKey: z.string().trim().min(1).max(2_048),
    displayName: z.string().trim().min(1).max(512).optional(),
  })
  .strict();

const toolCallNodeReplImageDisplaySchema = z
  .object({
    kind: z.literal("node_repl_images"),
    // images Optional: CUA’s pure action cell does not have screenshots, but it still needs to carry the app identity. The kind name remains unchanged,
    // Changing the name will cause the entire persisted row to fail validation in this strict union.
    images: z
      .array(
        z
          .object({
            base64: z
              .string()
              .min(1)
              .max(200 * 1024),
            mimeType: z.string().regex(/^image\/[a-z0-9.+-]+$/iu),
          })
          .strict(),
      )
      .min(1)
      .max(2)
      .optional(),
    app: toolCallNodeReplCuaAppDisplaySchema.optional(),
    truncated: z.boolean().optional(),
    source: z.literal("browser_turn_end").optional(),
  })
  .strict();

const toolCallTaskOutputDisplaySchema = z
  .object({
    kind: z.literal("task_output"),
    retrievalStatus: z.enum(["success", "not_ready", "timeout"]),
    taskStatus: z.string().min(1).max(64).optional(),
    output: z.string().min(1).max(2_000).optional(),
    truncated: z.literal(true).optional(),
  })
  .strict();

const toolCallRespondToCoordinatorDisplaySchema = z
  .object({
    kind: z.literal("respond_to_coordinator"),
    status: z.enum(["success", "failed"]),
  })
  .strict();

const toolCallMcpDisplaySchema = z
  .object({
    kind: z.literal("mcp_tool"),
    serverName: z.string().min(1).max(256),
    toolName: z.string().min(1).max(256),
    description: z
      .string()
      .min(1)
      .max(4 * 1024)
      .optional(),
    /**
     * A structured identifier issued by the official Server MCP when it determines that this call is unavailable (limit exhausted/no Coding Plan).
     * The CLI side is only populated when the official source + isError, and the UI prompts above the input box accordingly.
     * mcpToolResultDisplayPayloadSchema must be synchronized with CLI contracts - strict on both sides,
     * Adding one less point will cause the entire row to fail the verification.
     */
    unavailable: z
      .object({ code: z.enum(OFFICIAL_MCP_TOOL_ERROR_CODES) })
      .strict()
      .optional(),
  })
  .strict();

export const toolCallDisplaySchema = z.discriminatedUnion("kind", [
  toolCallNodeReplImageDisplaySchema,
  toolCallTaskOutputDisplaySchema,
  toolCallRespondToCoordinatorDisplaySchema,
  toolCallMcpDisplaySchema,
  toolCallCreateWorkflowDisplaySchema,
  toolCallGetWorkflowRunDisplaySchema,
  toolCallListWorkflowRunsDisplaySchema,
  toolCallEvalWorkflowSnippetDisplaySchema,
  toolCallSavedWorkflowListDisplaySchema,
  toolCallListModelsDisplaySchema,
  toolCallResumeWorkflowRunDisplaySchema,
]);
export type ToolCallDisplay = z.infer<typeof toolCallDisplaySchema>;
