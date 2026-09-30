// ============================================================
// Tool card renderer registry: tool identity → specific renderer component
// ============================================================
// Detached from ToolCallBlocks.tsx: This table grows linearly with the type of tool, and is stacked with the renderContext assembly.
// ToolCallBlocks.tsx crosses oxlint max-lines(400) (rows.ts → toolDisplay.ts is the same precedent).
// This file only does pure shunting, does not contain JSX, does not touch the context assembly, and ToolCallBlocks.tsx relies on it in one direction.

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
import { CuaToolCallBlock, isCuaToolCall } from "@/ToolCallBlocks/renderers/cua.js";
import { CuaGroupToolCallBlock } from "@/ToolCallBlocks/renderers/cua-group.js";
import { GoalToolCallBlock } from "@/ToolCallBlocks/renderers/goal.js";
import { NodeReplToolCallBlock } from "@/ToolCallBlocks/renderers/node-repl.js";
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
  if (context.toolCallNode.toolCall.kind === "cuaGroup") {
    return CuaGroupToolCallBlock;
  }
  if (isCuaToolCall(context.toolCallNode.toolCall)) {
    return CuaToolCallBlock;
  }

  const identity = resolveToolCallIdentity(context.toolCallNode.toolCall);

  // The two tools of the reusable workflow are divided first according to **tool name**, deliberately ranked before family. Two reasons:
  // They are not in the known tool list of shared today (identity returns unknown, which will fall into the raw JSON trap);
  // Once they are registered in the `workflow` family in the future, the bottom line of the branch below will render them into CreateWorkflow cards.
  // Determine first by name so that both worlds can be established.
  if (isSaveWorkflowToolCall(context.toolCallNode.toolCall)) {
    return SaveWorkflowToolCallBlock;
  }
  if (isListSavedWorkflowsToolCall(context.toolCallNode.toolCall)) {
    return ListSavedWorkflowsToolCallBlock;
  }

  // The three tools of the observation workflow are classified by name and ranked before family: they are not in the known tool list (identity
  // Return unknown → raw JSON backend card), and the backend of workflow family is CreateWorkflow card——
  // Determine first by name so that both worlds "before registration/after registration" can be established (the same reason for workflowToolNames).
  if (isGetWorkflowRunToolCall(context.toolCallNode.toolCall)) {
    return GetWorkflowRunToolCallBlock;
  }
  if (isListWorkflowRunsToolCall(context.toolCallNode.toolCall)) {
    return ListWorkflowRunsToolCallBlock;
  }
  if (isEvalWorkflowSnippetToolCall(context.toolCallNode.toolCall)) {
    return EvalWorkflowSnippetToolCallBlock;
  }
  // ResumeWorkflowRun restores the entry of the same model and flows by name (the reason is the same as above: it is not in the known tool list, and workflow family
  // The bottom line is the CreateWorkflow card - to recover the card, you must claim your name before the family).
  if (isResumeWorkflowRunToolCall(context.toolCallNode.toolCall)) {
    return ResumeWorkflowRunToolCallBlock;
  }
  // The same models in the model catalog are distributed by name: do not claim by name,
  // The backend card will spread the `<models>` text starting with providerId on the model side into the chat area as it is.
  if (isListModelsToolCall(context.toolCallNode.toolCall)) {
    return ListModelsToolCallBlock;
  }

  // Upgrade Q&A The two tools of the same model are distributed by name, and they are also ranked before family: they are not in the known tool list (identity returns
  // unknown → raw JSON card), and the workflow family card is the CreateWorkflow card - first determine the order by name
  // Both worlds "before registration/after registration" are established. `escalate` (subagent question) and `ResolveWorkflowQuestion`
  // (Answer from the main agent) The cards have completely different faces, and each one recognizes its own name.
  if (isEscalateToolCall(context.toolCallNode.toolCall)) {
    return EscalateToolCallBlock;
  }
  if (isResolveWorkflowQuestionToolCall(context.toolCallNode.toolCall)) {
    return ResolveWorkflowQuestionToolCallBlock;
  }

  // The host Node REPL is also registered with MCP and therefore also carries the mcp_tool presentation.
  // If the generic MCP offload is executed first, it will eat up specialized interactions such as code, error stacks, and artifacts.
  // Keep the Node REPL renderer by trusted tool identity first, and then let the rest of the MCP use the common display.
  if (identity.family === "node-repl") {
    return NodeReplToolCallBlock;
  }
  if (readMcpToolPresentation(context)) {
    return McpToolCallBlock;
  }

  // The current tool name is already a fixed set. If you continue to scan kind/title with regular expressions,
  // Write in TodoWrite will be treated as file writing. Here, the fixed tool identity is first parsed, and then divided by family;
  // The tool form of ZCode historical projection is uniformly handled by the identity resolver.
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
      // Distributed by tool name within the family (`message` family has the same precedent for RespondToCoordinator):
      // The two tool interfaces of the workflow are completely different - one is the script/graph, and the other is the result submitted by the actor.
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
