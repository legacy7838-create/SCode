import { memo, type ReactNode, useEffect, useMemo, useState } from "react";
import { TID_CHAT_TOOL_CALL_BLOCK, testId } from "@zcode/shared";
import { useIsOfficeMode } from "@/hooks/useInterfaceMode.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { mapToolStatus } from "@/lib/mapToolStatus.js";
import { buildToolDisplayModel } from "@/lib/toolDisplay.js";
import type { TaskChatToolCallTreeNode } from "@/lib/toolCallTree.js";
import { getToolCallErrorText } from "@/lib/toolError.js";
import {
  getCompactToolCallStatusMessageId,
  isCompactToolCallRunningState,
} from "@/lib/toolCallSummary.js";
import type { CodeViewerSource } from "@/lib/codeViewer.js";
import { CuaGroupToolCallBlock } from "@/ToolCallBlocks/renderers/cua-group.js";
import { resolveToolCallRenderer } from "@/ToolCallBlocks/resolveRenderer.js";
import { resolveToolCallIdentity } from "@/lib/toolIdentity.js";
import {
  readRawToolCallFileSummaries,
  type ToolCallBlockRenderContext,
} from "@/ToolCallBlocks/shared.js";
import type { MessageFileLinkTarget } from "@/components/ai-elements/message.js";
import type { ConversationCuaGroupEvent } from "@/v4/conversationCuaGroups.js";

const NESTED_TOOLCALL_CONTAINER_CLASS =
  "ml-2 space-y-2 border-border border-l pl-3.5 border-border";
const MAX_TOOL_ENTRANCE_ANIMATION_KEYS = 800;
const TOOL_ENTRANCE_ANIMATION_CLEANUP_MS = 1000;
const toolEntranceAnimationKeys = new Map<string, number>();

function pruneToolEntranceAnimationKeys() {
  if (toolEntranceAnimationKeys.size <= MAX_TOOL_ENTRANCE_ANIMATION_KEYS) {
    return;
  }

  const staleKeys = Array.from(toolEntranceAnimationKeys.entries())
    .sort(([, left], [, right]) => left - right)
    .slice(0, toolEntranceAnimationKeys.size - MAX_TOOL_ENTRANCE_ANIMATION_KEYS)
    .map(([key]) => key);

  for (const key of staleKeys) {
    toolEntranceAnimationKeys.delete(key);
  }
}

function normalizeToolEntranceAnimationKey(key: string) {
  const normalizedKey = key.trim();
  return normalizedKey.length > 0 ? normalizedKey : null;
}

function hasPlayedToolEntranceAnimation(key: string) {
  const normalizedKey = normalizeToolEntranceAnimationKey(key);
  return normalizedKey === null || toolEntranceAnimationKeys.has(normalizedKey);
}

function recordToolEntranceAnimation(key: string) {
  const normalizedKey = normalizeToolEntranceAnimationKey(key);
  if (normalizedKey === null) {
    return;
  }

  toolEntranceAnimationKeys.set(normalizedKey, Date.now());
  pruneToolEntranceAnimationKeys();
}

function canPlayToolEntranceAnimation(key: string, active: boolean) {
  return active && !hasPlayedToolEntranceAnimation(key);
}

function isAgentToolCall(toolCall: TaskChatToolCallTreeNode["toolCall"]): boolean {
  return resolveToolCallIdentity(toolCall).family === "agent";
}

function ToolCallBlockComponent({
  toolCallNode,
  depth = 0,
  workspacePath,
  theme,
  codePreviewSettings,
  showIcon = true,
  cuaAppIconClassName,
  onOpenCodeViewer,
  onOpenFileLink,
  onOpenBrowserUrl,
  onOpenAutomationsMain,
  onOpenPlanDetail,
  onOpenWorkflowRun,
  onResumeWorkflowRun,
  onOpenWorkflowActor,
  onOpenWorkflowWorkspace,
  onOpenWorkflowArtifact,
  workflowRun,
  workflowDraft,
  onLoadFullToolCallFields,
  suppressSourceLabel = false,
  showTodoToolCalls = true,
  disableSummaryContentAnimation = false,
  animateDiffCountOnMount = false,
  agentSummaryAction,
  authoritativeAgentType,
  streamingEntranceActive = false,
  streamingEntranceKeyPrefix = "tool",
  cuaGroupEvents,
  renderCuaAssistantMessage,
  renderCuaReasoning,
}: {
  toolCallNode: TaskChatToolCallTreeNode;
  depth?: number;
  workspacePath: string;
  /** Application theme (store coupling stripping): passed in by the host (v4 SessionPane, etc.), the default is "system". */
  theme?: ToolCallBlockRenderContext["theme"];
  /** Code preview settings (store coupling stripping): passed in by the host and keeping references stable. */
  codePreviewSettings?: ToolCallBlockRenderContext["codePreviewSettings"];
  showIcon?: boolean;
  cuaAppIconClassName?: ToolCallBlockRenderContext["cuaAppIconClassName"];
  onOpenCodeViewer?: (source: CodeViewerSource) => void;
  onOpenFileLink?: (target: MessageFileLinkTarget) => void;
  onOpenBrowserUrl?: (url: string) => void;
  onOpenAutomationsMain?: (automationId?: string) => void;
  onOpenPlanDetail?: ToolCallBlockRenderContext["onOpenPlanDetail"];
  onOpenWorkflowRun?: ToolCallBlockRenderContext["onOpenWorkflowRun"];
  /** Resume of the tool card footer; like workflowRun, it does not transparently transmit to the sub-tool card. */
  onResumeWorkflowRun?: ToolCallBlockRenderContext["onResumeWorkflowRun"];
  /** Pill → sub-agent transcript; also does not pass through to the sub-tool card. */
  onOpenWorkflowActor?: ToolCallBlockRenderContext["onOpenWorkflowActor"];
  /** Script pill → script transcript; also does not pass through to sub-tool cards. */
  onOpenWorkflowWorkspace?: ToolCallBlockRenderContext["onOpenWorkflowWorkspace"];
  /** Product Pill → Product tab; also does not pass through to sub-tool cards. */
  onOpenWorkflowArtifact?: ToolCallBlockRenderContext["onOpenWorkflowArtifact"];
  /**
   * Summary of the workflow run that the tool call is connected to (the host resolves from the workflowRuns projection by toolCallId).
   * Deliberately **not** transparently transmit to the child tool card: the summary is connected according to toolCallId, and the run summary of the parent card is passed to
   * A subcard with a different toolCallId will draw someone else's running status.
   */
  workflowRun?: ToolCallBlockRenderContext["workflowRun"];
  /** The draft position of the compilation feedback (the host presses toolCallId to connect from the row window); same as workflowRun, does not transparently transmit to the sub-tool card. */
  workflowDraft?: ToolCallBlockRenderContext["workflowDraft"];
  onLoadFullToolCallFields?: (toolId: string) => Promise<boolean | void> | boolean | void;
  suppressSourceLabel?: boolean;
  showTodoToolCalls?: boolean;
  disableSummaryContentAnimation?: boolean;
  animateDiffCountOnMount?: boolean;
  agentSummaryAction?: ToolCallBlockRenderContext["agentSummaryAction"];
  authoritativeAgentType?: ToolCallBlockRenderContext["authoritativeAgentType"];
  streamingEntranceActive?: boolean;
  streamingEntranceKeyPrefix?: string;
  cuaGroupEvents?: readonly ConversationCuaGroupEvent[];
  renderCuaAssistantMessage?: (
    event: Extract<ConversationCuaGroupEvent, { kind: "assistantMessage" }>,
  ) => ReactNode;
  renderCuaReasoning?: (
    event: Extract<ConversationCuaGroupEvent, { kind: "reasoning" }>,
  ) => ReactNode;
}) {
  const { toolCall, childToolCalls } = toolCallNode;
  const { intl } = useZCodeIntl();
  const isOfficeMode = useIsOfficeMode();
  const toolEntranceAnimationKey = `${streamingEntranceKeyPrefix}:${toolCall.toolId}`;
  // If tool does not fade in when it appears in a streaming conversation, it will be separated from the fade-in rhythm of the same text.
  // Here, the tool that has been displayed is recorded according to toolId, and the tool will not be played repeatedly when switching tasks or re-hanging the virtual list.
  // The recorded action is placed in the effect to delay execution to prevent React development state re-hanging from swallowing the first animation by mistake.
  const [shouldPlayEntranceAnimation, setShouldPlayEntranceAnimation] = useState(() =>
    canPlayToolEntranceAnimation(toolEntranceAnimationKey, streamingEntranceActive),
  );
  useEffect(() => {
    if (!streamingEntranceActive || shouldPlayEntranceAnimation) {
      return;
    }

    if (canPlayToolEntranceAnimation(toolEntranceAnimationKey, streamingEntranceActive)) {
      setShouldPlayEntranceAnimation(true);
    }
  }, [shouldPlayEntranceAnimation, streamingEntranceActive, toolEntranceAnimationKey]);

  useEffect(() => {
    if (!shouldPlayEntranceAnimation) {
      return;
    }

    const markAnimatedTimer = window.setTimeout(() => {
      recordToolEntranceAnimation(toolEntranceAnimationKey);
    }, 0);
    const cleanupTimer = window.setTimeout(() => {
      setShouldPlayEntranceAnimation(false);
    }, TOOL_ENTRANCE_ANIMATION_CLEANUP_MS);

    return () => {
      window.clearTimeout(markAnimatedTimer);
      window.clearTimeout(cleanupTimer);
    };
  }, [shouldPlayEntranceAnimation, toolEntranceAnimationKey]);
  // Note: The following early return must be placed after all hook calls.
  // Previously, `return null` was used here before useMemo, which caused when a certain toolCall
  // When family switches between todo and non-todo (or showTodoToolCalls changes),
  // The number of hooks executed by this component in this rendering is inconsistent with the last time, and React will throw
  // "Rendered fewer hooks than expected" and causes the entire chat page to crash with a white screen.
  // Repair method: Move the early return down to after all hooks to ensure that the hook calling sequence is stable.
  const identity = resolveToolCallIdentity(toolCall);
  const toolState = mapToolStatus(toolCall.status);
  const displayModel = useMemo(
    () => buildToolDisplayModel(toolCall, workspacePath),
    [toolCall, workspacePath],
  );
  const rawFileSummaries = useMemo(
    () =>
      readRawToolCallFileSummaries(toolCall.raw, {
        toolName: toolCall.toolName,
        kind: toolCall.kind,
        title: toolCall.title,
        input: toolCall.input,
        output: toolCall.output,
        raw: toolCall.raw,
      }),
    [
      toolCall.input,
      toolCall.kind,
      toolCall.output,
      toolCall.raw,
      toolCall.title,
      toolCall.toolName,
    ],
  );
  const isRunning = isCompactToolCallRunningState(toolState);
  const statusLabel = intl.formatMessage({
    id: getCompactToolCallStatusMessageId(toolState, toolCall.status),
  });
  const errorText = getToolCallErrorText(toolCall);
  const isCurrentAgentToolCall = isAgentToolCall(toolCall);
  const isSubAgentToolCall = !isCurrentAgentToolCall && (depth > 0 || toolCall.parentToolUseId);
  const sourceLabel =
    !suppressSourceLabel && isSubAgentToolCall
      ? intl.formatMessage({ id: "chat.toolCall.source.subAgent" })
      : undefined;
  // Previously, in order to avoid "double preview", onOpenCodeViewer was left blank globally.
  // This will cause the edit/read file summary to lose the ability to click, returning to "the file name can be seen but cannot be clicked".
  // Transparent transmission is restored here and historical interaction is maintained; whether to "avoid double preview" should be changed to a more fine-grained switch instead of being disabled across the board.
  const toolPreviewCodeViewer: ToolCallBlockRenderContext["onOpenCodeViewer"] = onOpenCodeViewer;

  const childToolList = useMemo(
    () =>
      childToolCalls.length > 0 ? (
        <div className={NESTED_TOOLCALL_CONTAINER_CLASS}>
          {childToolCalls.map((childToolCallNode) => (
            <ToolCallBlock
              key={childToolCallNode.toolCall.toolId}
              toolCallNode={childToolCallNode}
              depth={depth + 1}
              workspacePath={workspacePath}
              theme={theme}
              codePreviewSettings={codePreviewSettings}
              showIcon={showIcon}
              onOpenCodeViewer={toolPreviewCodeViewer}
              onOpenFileLink={onOpenFileLink}
              onOpenBrowserUrl={onOpenBrowserUrl}
              onOpenAutomationsMain={onOpenAutomationsMain}
              onOpenPlanDetail={onOpenPlanDetail}
              onOpenWorkflowRun={onOpenWorkflowRun}
              onLoadFullToolCallFields={onLoadFullToolCallFields}
              suppressSourceLabel={suppressSourceLabel}
              showTodoToolCalls={showTodoToolCalls}
              disableSummaryContentAnimation={disableSummaryContentAnimation}
              animateDiffCountOnMount={animateDiffCountOnMount}
              streamingEntranceActive={streamingEntranceActive}
              streamingEntranceKeyPrefix={streamingEntranceKeyPrefix}
            />
          ))}
        </div>
      ) : null,
    [
      childToolCalls,
      depth,
      onLoadFullToolCallFields,
      onOpenAutomationsMain,
      onOpenBrowserUrl,
      onOpenPlanDetail,
      onOpenFileLink,
      showIcon,
      showTodoToolCalls,
      streamingEntranceActive,
      streamingEntranceKeyPrefix,
      suppressSourceLabel,
      theme,
      codePreviewSettings,
      toolPreviewCodeViewer,
      workspacePath,
    ],
  );

  const renderContext: ToolCallBlockRenderContext = useMemo(
    () => ({
      isOfficeMode,
      toolCallNode,
      workspacePath,
      theme,
      codePreviewSettings,
      displayModel,
      viewerSource: displayModel.viewerSource,
      rawFileSummaries,
      isRunning,
      statusLabel,
      sourceLabel,
      errorText,
      childToolList,
      showIcon,
      cuaAppIconClassName,
      showTodoToolCalls,
      disableSummaryContentAnimation,
      animateDiffCountOnMount,
      agentSummaryAction,
      authoritativeAgentType,
      onOpenCodeViewer: toolPreviewCodeViewer,
      onOpenFileLink,
      onOpenBrowserUrl,
      onOpenAutomationsMain,
      onOpenPlanDetail,
      // onOpenWorkflowRun was only transparently passed to the sub-tool card before, and never entered the renderContext.
      // So the CreateWorkflow renderer will never receive it - the entrance to "Open the details page" is buried deep.
      // It's not rendered at all. The run state compact card hangs on this callback, so it must be here.
      onOpenWorkflowRun,
      onResumeWorkflowRun,
      onOpenWorkflowActor,
      onOpenWorkflowWorkspace,
      onOpenWorkflowArtifact,
      workflowRun,
      workflowDraft,
      onLoadFullToolCallFields,
    }),
    [
      isOfficeMode,
      agentSummaryAction,
      authoritativeAgentType,
      childToolList,
      codePreviewSettings,
      cuaAppIconClassName,
      displayModel,
      disableSummaryContentAnimation,
      animateDiffCountOnMount,
      errorText,
      isRunning,
      onLoadFullToolCallFields,
      onOpenAutomationsMain,
      onOpenBrowserUrl,
      onOpenPlanDetail,
      onOpenWorkflowRun,
      onResumeWorkflowRun,
      onOpenWorkflowActor,
      onOpenWorkflowWorkspace,
      onOpenWorkflowArtifact,
      onOpenFileLink,
      rawFileSummaries,
      showIcon,
      showTodoToolCalls,
      sourceLabel,
      statusLabel,
      suppressSourceLabel,
      theme,
      toolCallNode,
      toolPreviewCodeViewer,
      workflowRun,
      workflowDraft,
      workspacePath,
    ],
  );

  const ToolCallRenderer = useMemo(() => resolveToolCallRenderer(renderContext), [renderContext]);
  // early return must be after all hooks (see the reason for the crash explained in the comments above)
  if (!showTodoToolCalls && identity.family === "todo") {
    return null;
  }
  return (
    <div
      className="w-full"
      data-testid={testId(TID_CHAT_TOOL_CALL_BLOCK, toolCall.toolId)}
      data-tool-call-id={toolCall.toolId}
      data-tool-name={toolCall.toolName ?? toolCall.kind ?? ""}
      data-status={toolCall.status}
      data-zcode-tool-stream-animate={shouldPlayEntranceAnimation ? "true" : undefined}
    >
      {toolCall.kind === "cuaGroup" ? (
        <CuaGroupToolCallBlock
          {...renderContext}
          events={cuaGroupEvents}
          renderAssistantMessage={renderCuaAssistantMessage}
          renderReasoning={renderCuaReasoning}
        />
      ) : (
        <ToolCallRenderer {...renderContext} />
      )}
    </div>
  );
}

export const ToolCallBlock = memo(ToolCallBlockComponent);
ToolCallBlock.displayName = "ToolCallBlock";
