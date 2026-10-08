// ============================================================
// 工具卡 renderer 注册表：tool identity → 具体 renderer 组件
// ============================================================
// 从 ToolCallBlocks.tsx 拆出：这张表随工具种类线性增长，和 renderContext 装配叠在一处后
// ToolCallBlocks.tsx 越过 oxlint max-lines(400)（rows.ts → toolDisplay.ts 是同一先例）。
// 本文件只做纯分流，不含 JSX、不碰 context 装配，ToolCallBlocks.tsx 单向依赖它。

import { EditToolCallBlock } from "@/ToolCallBlocks/renderers/edit.js";
import { AgentToolCallBlock } from "@/ToolCallBlocks/renderers/agent.js";
import { ChangesGroupToolCallBlock } from "@/ToolCallBlocks/renderers/changes-group.js";
import { CreateWorkflowToolCallBlock } from "@/ToolCallBlocks/renderers/create-workflow.js";
import { EscalateToolCallBlock } from "@/ToolCallBlocks/renderers/escalate.js";
import { EvalWorkflowSnippetToolCallBlock } from "@/ToolCallBlocks/renderers/eval-workflow-snippet.js";
import { ExploreToolCallBlock } from "@/ToolCallBlocks/renderers/explore.js";
import { ExecuteToolCallBlock } from "@/ToolCallBlocks/renderers/execute.js";
import { ExecuteGroupToolCallBlock } from "@/ToolCallBlocks/renderers/execute-group.js";
import { FallbackToolCallBlock } from "@/ToolCallBlocks/renderers/fallback.js";
import { GetWorkflowRunToolCallBlock } from "@/ToolCallBlocks/renderers/get-workflow-run.js";
import { ListModelsToolCallBlock } from "@/ToolCallBlocks/renderers/list-models.js";
import { ListSavedWorkflowsToolCallBlock } from "@/ToolCallBlocks/renderers/list-saved-workflows.js";
import { ListWorkflowRunsToolCallBlock } from "@/ToolCallBlocks/renderers/list-workflow-runs.js";
import { ResumeWorkflowRunToolCallBlock } from "@/ToolCallBlocks/renderers/resume-workflow-run.js";
import { ResolveWorkflowQuestionToolCallBlock } from "@/ToolCallBlocks/renderers/resolve-workflow-question.js";
import { SaveWorkflowToolCallBlock } from "@/ToolCallBlocks/renderers/save-workflow.js";
import {
  isEscalateToolCall,
  isEvalWorkflowSnippetToolCall,
  isGetWorkflowRunToolCall,
  isListModelsToolCall,
  isListSavedWorkflowsToolCall,
  isListWorkflowRunsToolCall,
  isResolveWorkflowQuestionToolCall,
  isResumeWorkflowRunToolCall,
  isSaveWorkflowToolCall,
} from "@/lib/workflowToolNames.js";
import { GoalToolCallBlock } from "@/ToolCallBlocks/renderers/goal.js";
import { McpToolCallBlock, readMcpToolPresentation } from "@/ToolCallBlocks/renderers/mcp.js";
import { PlanGuidanceToolCallBlock } from "@/ToolCallBlocks/renderers/plan-guidance.js";
import { ReadToolCallBlock } from "@/ToolCallBlocks/renderers/read.js";
import { ReadSessionContextToolCallBlock } from "@/ToolCallBlocks/renderers/read-session-context.js";
import { RespondToCoordinatorToolCallBlock } from "@/ToolCallBlocks/renderers/respond-to-coordinator.js";
import { SearchToolCallBlock } from "@/ToolCallBlocks/renderers/search.js";
import { SendMessageToolCallBlock } from "@/ToolCallBlocks/renderers/send-message.js";
import { SkillToolCallBlock } from "@/ToolCallBlocks/renderers/skill.js";
import { SubmitResultToolCallBlock } from "@/ToolCallBlocks/renderers/submit-result.js";
import { SwitchModeToolCallBlock } from "@/ToolCallBlocks/renderers/switch-mode.js";
import { TaskOutputToolCallBlock } from "@/ToolCallBlocks/renderers/task-output.js";
import { TaskStopToolCallBlock } from "@/ToolCallBlocks/renderers/task-stop.js";
import { TodoToolCallBlock } from "@/ToolCallBlocks/renderers/todo.js";
import { AskQuestionToolCallBlock } from "@/ToolCallBlocks/renderers/ask-question.js";
import { resolveToolCallIdentity } from "@/lib/toolIdentity.js";
import type { ToolCallBlockRenderContext } from "@/ToolCallBlocks/shared.js";

export function resolveToolCallRenderer(context: ToolCallBlockRenderContext) {
  if (context.toolCallNode.toolCall.kind === "changesGroup") {
    return ChangesGroupToolCallBlock;
  }
  if (context.toolCallNode.toolCall.kind === "executeGroup") {
    return ExecuteGroupToolCallBlock;
  }

  const identity = resolveToolCallIdentity(context.toolCallNode.toolCall);

  if (isSaveWorkflowToolCall(context.toolCallNode.toolCall)) {
    return SaveWorkflowToolCallBlock;
  }
  if (isListSavedWorkflowsToolCall(context.toolCallNode.toolCall)) {
    return ListSavedWorkflowsToolCallBlock;
  }
  if (isGetWorkflowRunToolCall(context.toolCallNode.toolCall)) {
    return GetWorkflowRunToolCallBlock;
  }
  if (isListWorkflowRunsToolCall(context.toolCallNode.toolCall)) {
    return ListWorkflowRunsToolCallBlock;
  }
  if (isEvalWorkflowSnippetToolCall(context.toolCallNode.toolCall)) {
    return EvalWorkflowSnippetToolCallBlock;
  }
  if (isResumeWorkflowRunToolCall(context.toolCallNode.toolCall)) {
    return ResumeWorkflowRunToolCallBlock;
  }
  if (isListModelsToolCall(context.toolCallNode.toolCall)) {
    return ListModelsToolCallBlock;
  }
  if (isEscalateToolCall(context.toolCallNode.toolCall)) {
    return EscalateToolCallBlock;
  }
  if (isResolveWorkflowQuestionToolCall(context.toolCallNode.toolCall)) {
    return ResolveWorkflowQuestionToolCallBlock;
  }

  if (readMcpToolPresentation(context)) {
    return McpToolCallBlock;
  }

  switch (identity.family) {
    case "plan-guidance":
      return PlanGuidanceToolCallBlock;
    case "agent":
      return AgentToolCallBlock;
    case "todo":
      return TodoToolCallBlock;
    case "ask-user-question":
      return AskQuestionToolCallBlock;
    case "message":
      return identity.toolName === "RespondToCoordinator"
        ? RespondToCoordinatorToolCallBlock
        : SendMessageToolCallBlock;
    case "task-control":
      return identity.toolName === "TaskOutput" ? TaskOutputToolCallBlock : TaskStopToolCallBlock;
    case "skill":
      return SkillToolCallBlock;
    case "workflow":
      return identity.toolName === "submit_result"
        ? SubmitResultToolCallBlock
        : CreateWorkflowToolCallBlock;
    case "session-context":
      return ReadSessionContextToolCallBlock;
    case "file-read":
      return ReadToolCallBlock;
    case "file-write":
      return EditToolCallBlock;
    case "explore":
      return ExploreToolCallBlock;
    case "switch-mode":
      return SwitchModeToolCallBlock;
    case "search":
      return SearchToolCallBlock;
    case "shell":
      return ExecuteToolCallBlock;
    case "goal":
      return GoalToolCallBlock;
    default:
      return FallbackToolCallBlock;
  }
}
