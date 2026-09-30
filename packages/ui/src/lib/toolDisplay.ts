import type { TaskChatToolCall as ChatToolCall } from "@/lib/taskChatMessageTypes.js";
import {
  getToolCallCodeContentPreview,
  getToolCallCodePreview,
  type CodeViewerSource,
  type ImageCodeViewerSource,
  type PatchCodeViewerSource,
  type TextCodeViewerSource,
} from "@/lib/codeViewer.js";
import { isAbsoluteFilePath, joinFilePath } from "@/lib/path.js";
import { getToolCallErrorText } from "@/lib/toolError.js";
import {
  isFileContentWriteToolCall,
  isFileDiffToolCall,
  resolveToolCallIdentity,
  type ToolCallIdentity,
} from "@/lib/toolIdentity.js";

export type ToolInlinePreview =
  | { type: "none" }
  | { type: "text"; source: TextCodeViewerSource }
  | { type: "patch"; source: PatchCodeViewerSource }
  | { type: "image"; source: ImageCodeViewerSource };

export interface ToolPlanResult {
  plan: string;
  planFilePath?: string;
}

export interface ToolDisplayModel {
  inlinePreview: ToolInlinePreview;
  planResult: ToolPlanResult | null;
  viewerSource: CodeViewerSource | null;
  viewerLabelId: "codeViewer.viewCode" | "codeViewer.viewDiff";
  showSummaryFileLink: boolean;
  showInput: boolean;
  showOutput: boolean;
  showKind: boolean;
}

interface ToolDisplayContext {
  toolCall: ChatToolCall;
  identity: ToolCallIdentity;
  preview: CodeViewerSource | null;
  contentPreview: TextCodeViewerSource | null;
  errorText?: string;
}

interface ToolDisplayStrategy {
  matches(context: ToolDisplayContext): boolean;
  build(context: ToolDisplayContext): Partial<ToolDisplayModel>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function extractToolPlanResultFromValue(
  value: unknown,
  workspacePath: string,
): ToolPlanResult | null {
  if (!isRecord(value)) {
    return null;
  }

  const rawPlan = value["plan"];
  if (typeof rawPlan !== "string" || rawPlan.trim().length === 0) {
    return null;
  }

  const rawPlanFilePath = value["planFilePath"];
  const planFilePath =
    typeof rawPlanFilePath === "string" && rawPlanFilePath.trim().length > 0
      ? isAbsoluteFilePath(rawPlanFilePath)
        ? rawPlanFilePath
        : joinFilePath(workspacePath, rawPlanFilePath)
      : undefined;

  return {
    plan: rawPlan.trim(),
    planFilePath,
  };
}

function toInlinePreview(context: ToolDisplayContext, preferPatch: boolean): ToolInlinePreview {
  if (preferPatch && context.preview?.type === "patch") {
    return {
      type: "patch",
      source: context.preview,
    };
  }

  if (context.preview?.type === "image") {
    return {
      type: "image",
      source: context.preview,
    };
  }

  if (context.preview?.type === "text") {
    return {
      type: "text",
      source: context.preview,
    };
  }

  if (context.contentPreview) {
    return {
      type: "text",
      source: context.contentPreview,
    };
  }

  return { type: "none" };
}

const diffToolStrategy: ToolDisplayStrategy = {
  matches(context) {
    return isFileDiffToolCall(context.toolCall, context.identity);
  },
  build(context) {
    const inlinePreview = toInlinePreview(context, true);
    const hasInlinePreview = inlinePreview.type !== "none";

    return {
      inlinePreview,
      showInput: !hasInlinePreview,
      showOutput: Boolean(context.errorText),
      showKind: !hasInlinePreview,
    };
  },
};

const readToolStrategy: ToolDisplayStrategy = {
  matches(context) {
    return context.identity.family === "file-read";
  },
  build(context) {
    const inlinePreview = toInlinePreview(context, false);
    const hasInlinePreview = inlinePreview.type !== "none";

    return {
      inlinePreview,
      // The title of the reading tool usually already contains the target file, and an additional matching file name is added to the summary line.
      // The same file will be displayed twice. Only the title and text preview are retained here to prevent read-only operations from appearing like "clicking on another file".
      showSummaryFileLink: false,
      showInput: !hasInlinePreview,
      showOutput: Boolean(context.errorText),
      showKind: !hasInlinePreview,
    };
  },
};

const writeToolStrategy: ToolDisplayStrategy = {
  matches(context) {
    return isFileContentWriteToolCall(context.toolCall, context.identity);
  },
  build(context) {
    const inlinePreview = toInlinePreview(context, false);
    const hasInlinePreview = inlinePreview.type !== "none";

    return {
      inlinePreview,
      showInput: !hasInlinePreview,
      // The successful output of the Write tool is often just a structured confirmation result, and continuing to render will result in an extra piece of meaningless Result.
      // The written content is already carried by inlinePreview/file summary; here only errors are retained in case of failure to avoid repeated display of results.
      showOutput: Boolean(context.errorText),
      showKind: !hasInlinePreview,
    };
  },
};

const genericImageStrategy: ToolDisplayStrategy = {
  matches(context) {
    return context.preview?.type === "image";
  },
  build(context) {
    const inlinePreview = toInlinePreview(context, false);
    const hasInlinePreview = inlinePreview.type !== "none";

    return {
      inlinePreview,
      showInput: !hasInlinePreview,
      showOutput: Boolean(context.errorText),
      showKind: !hasInlinePreview,
    };
  },
};

const executeToolStrategy: ToolDisplayStrategy = {
  matches(context) {
    return context.identity.family === "shell";
  },
  build(context) {
    return {
      inlinePreview: { type: "none" },
      showInput: false,
      showOutput: context.toolCall.output !== undefined || Boolean(context.errorText),
      showKind: false,
    };
  },
};

const searchToolStrategy: ToolDisplayStrategy = {
  matches(context) {
    return context.identity.family === "search";
  },
  build(context) {
    // The input of search/fetch tools is usually just query, path or filter conditions.
    // What users really care about is the result of the hit. In the previous general presentation, Parameters and Result were expanded together.
    // The search results are squeezed to the bottom and difficult to scan; only result/error are kept here to avoid invalid input information from occupying the main view.
    // At the same time, the search range itself is already reflected in the title or results. Adding an additional matched directory/file name to the summary line will duplicate the noise.
    return {
      inlinePreview: { type: "none" },
      showSummaryFileLink: false,
      showInput: false,
      showOutput: context.toolCall.output !== undefined || Boolean(context.errorText),
      showKind: false,
    };
  },
};

const goalToolStrategy: ToolDisplayStrategy = {
  matches(context) {
    return context.identity.family === "goal";
  },
  build(context) {
    // The input of the Goal tool is the state change parameter given by the model to the runtime, not the result that the user wants to read.
    // Previously, the universal fallback would spread out Parameters, Result, and the entire package of raw at the same time, and the goal status would be drowned out by the noise.
    return {
      inlinePreview: { type: "none" },
      showSummaryFileLink: false,
      showInput: false,
      showOutput: context.toolCall.output !== undefined || Boolean(context.errorText),
      showKind: false,
    };
  },
};

const nodeReplToolStrategy: ToolDisplayStrategy = {
  matches(context) {
    return context.identity.family === "node-repl";
  },
  build() {
    // Display semantics are normalized from title/result/error by dedicated renderer; general Parameters, Result
    // and kind would expose tool implementation details and duplicate the dedicated results area, so are all closed here.
    return {
      inlinePreview: { type: "none" },
      showSummaryFileLink: false,
      showInput: false,
      showOutput: false,
      showKind: false,
    };
  },
};

const TOOL_DISPLAY_STRATEGIES: ToolDisplayStrategy[] = [
  diffToolStrategy,
  readToolStrategy,
  writeToolStrategy,
  executeToolStrategy,
  searchToolStrategy,
  goalToolStrategy,
  nodeReplToolStrategy,
  genericImageStrategy,
];

export function buildToolDisplayModel(
  toolCall: ChatToolCall,
  workspacePath: string,
): ToolDisplayModel {
  const preview = getToolCallCodePreview(toolCall, workspacePath);
  const contentPreview = getToolCallCodeContentPreview(toolCall, workspacePath);
  const errorText = getToolCallErrorText(toolCall);
  const identity = resolveToolCallIdentity(toolCall);
  // The plan the user wants to see comes from tool result, not tool input.
  // EnterPlanMode type of input may also have a plan/todo structure; if you read input in detail here,
  // The same plan will be mistaken for result rendering, and the responsibilities of the real plan event on top will be mixed again.
  const planResult = extractToolPlanResultFromValue(toolCall.output, workspacePath);
  const context: ToolDisplayContext = {
    toolCall,
    identity,
    preview,
    contentPreview,
    errorText,
  };

  const defaultModel: ToolDisplayModel = {
    inlinePreview: { type: "none" },
    planResult,
    viewerSource: preview,
    viewerLabelId: preview?.type === "patch" ? "codeViewer.viewDiff" : "codeViewer.viewCode",
    showSummaryFileLink: Boolean(preview?.path),
    showInput: planResult ? false : toolCall.input !== undefined,
    showOutput: toolCall.output !== undefined || Boolean(errorText),
    showKind: true,
  };

  const matchedStrategy = TOOL_DISPLAY_STRATEGIES.find((strategy) => strategy.matches(context));

  // Before tool display, rely on `kind === "edit"` to fork directly, and the preview extraction layer can already recognize read/replace/image.
  // But the rendering layer cannot eat it at all, and in the end there is only a bunch of scattered special effects. This converges into "general model + kind strategy enhancement",
  // When adding a dedicated display for execute/search/fetch in the future, you only need to add a strategy and no longer rewrite the main rendering skeleton.
  const model = matchedStrategy
    ? {
        ...defaultModel,
        ...matchedStrategy.build(context),
      }
    : defaultModel;

  // The result of exiting plan mode will also contain structured fields such as markdown plan and allowedPrompts.
  // Previously, the general JSON Result was used here. The chat area was difficult to read, and the same plan would be repeatedly rendered elsewhere.
  // Now, priority is given to displaying `plan` as a dedicated result block of the current tool, and only falling back to the general output area when an error occurs.
  if (planResult) {
    return {
      ...model,
      showInput: false,
      showOutput: Boolean(errorText),
    };
  }

  if (errorText) {
    return {
      ...model,
      // When edit/write fails, Parameters will continue to be displayed, which will put the whole oldString/newString JSON on top.
      // Instead, the real error report is squeezed below and can't even be seen at all. The failure state is first converged into the error information view to prevent users from continuing to read invalid parameters.
      inlinePreview: { type: "none" },
      showInput: false,
      showOutput: true,
      showKind: false,
    };
  }

  return model;
}
