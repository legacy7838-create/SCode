import { useCallback, useMemo } from "react";
import { TID_V4_ROW, TID_V4_SUBAGENT_OPEN_SIDE_PANE, testId } from "@zcode/shared";
import { ToolCallBlock } from "@/ToolCallBlocks.js";
import { getAgentPrimaryText } from "@/ToolCallBlocks/renderers/agentHelpers.js";
import type { ConversationAssistantWorkRenderItem } from "@/v4/conversationAssistantWorkItems.js";
import type { ConversationRowRenderContext } from "@/v4/conversationRowContext.js";
import { toolCallRowToLegacyNode } from "@/v4/toolCallRowAdapter.js";
import { runUserAction } from "@/lib/userActionTelemetry.js";

function openSubagentSessionFromSummary({
  backgrounded: _backgrounded = false,
  childSessionId,
  context,
  subagentType,
  title,
}: {
  backgrounded?: boolean;
  childSessionId?: string;
  context: ConversationRowRenderContext;
  subagentType: string;
  title: string;
}): boolean {
  const parentSessionId = context.sessionId;
  const onOpenSubagentSession = context.onOpenSubagentSession;
  if (!childSessionId || !parentSessionId || !onOpenSubagentSession) {
    return false;
  }

  onOpenSubagentSession({
    rootSessionId: context.rootSessionId ?? parentSessionId,
    parentSessionId,
    childSessionId,
    subagentType,
    title,
  });
  return true;
}

export function ConversationAgentToolCallRow({
  item,
  context,
}: {
  item: Extract<ConversationAssistantWorkRenderItem, { kind: "agentToolCall" }>;
  context: ConversationRowRenderContext;
}) {
  const toolCallNode = useMemo(() => toolCallRowToLegacyNode(item.row), [item.row]);
  const childSessionId = item.subagentRow.childSessionId;
  const subagentType = item.subagentRow.subagentType;
  // Reuse the same title resolver with the Agent summary row to ensure that the right tab and the visible title clicked by the user are word-for-word consistent.
  const title = getAgentPrimaryText(toolCallNode.toolCall, "");
  const canOpenChildSession = Boolean(
    childSessionId && context.sessionId && context.onOpenSubagentSession,
  );
  const handleOpenChildSession = useCallback(() => {
    runUserAction({
      input: { featureId: "conversation.subagent", action: "open_side_pane", trigger: "button" },
      operation: () =>
        openSubagentSessionFromSummary({ childSessionId, context, subagentType, title }),
      completed: { resultSource: "local_commit" },
      failureStage: "subagent_open",
    });
  }, [childSessionId, context, subagentType, title]);
  const agentSummaryAction = useMemo(
    () =>
      canOpenChildSession && childSessionId
        ? {
            onActivate: handleOpenChildSession,
            testId: testId(TID_V4_SUBAGENT_OPEN_SIDE_PANE, childSessionId),
          }
        : undefined,
    [canOpenChildSession, childSessionId, handleOpenChildSession],
  );

  // The Agent tool line and the ordinary tool line belong to the same workflow, and you cannot add additional px-4 to the matching shell.
  // Otherwise, there will be left and right indent differences with the unpaired toolCall line.
  return (
    <div
      data-row-id={item.row.rowId}
      data-conversation-selectable="true"
      data-testid={testId(TID_V4_ROW, String(item.row.rowId))}
    >
      <ToolCallBlock
        toolCallNode={toolCallNode}
        workspacePath={context.workspacePath}
        theme={context.theme}
        codePreviewSettings={context.codePreviewSettings}
        showTodoToolCalls={context.messageStreamShowTodos === true}
        onOpenCodeViewer={context.onOpenCodeViewer}
        onOpenFileLink={context.onOpenFileLink}
        onOpenBrowserUrl={context.onOpenBrowserUrl}
        onOpenAutomationsMain={context.onOpenAutomationsMain}
        agentSummaryAction={agentSummaryAction}
        authoritativeAgentType={subagentType}
      />
    </div>
  );
}
