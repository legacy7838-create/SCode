// The workflow-run query surface of createAgentConversationTransport. Reason for splitting: The main file is affected by
// eslint max-lines(400) constraint, the main file and branch increment superposition exceeds the limit,
// Split the two read-only queries of dwf journal into this file according to the query surface boundary (the closure dependency is passed in explicitly, and the behavior remains unchanged).
import type { IZCodeAgentService } from "@zcode/services";
import type {
  V4ConversationWorkflowRunArtifactDataParams,
  V4ConversationWorkflowRunArtifactDataResult,
  V4ConversationWorkflowRunArtifactReadParams,
  V4ConversationWorkflowRunArtifactReadResult,
  V4ConversationWorkflowRunArtifactsParams,
  V4ConversationWorkflowRunArtifactsResult,
  V4ConversationWorkflowRunEventsParams,
  V4ConversationWorkflowRunNodeResultParams,
  V4ConversationWorkflowRunNodeResultResult,
  V4ConversationWorkflowRunWorkspaceParams,
  V4ConversationWorkflowRunWorkspaceResult,
  V4ConversationWorkflowRunEventsResult,
  V4ConversationWorkflowRunsParams,
  V4ConversationWorkflowRunsResult,
} from "@zcode/shared/zcode-protocol-v4";

export function createWorkflowRunTransportMethods(input: {
  agentService: Pick<
    IZCodeAgentService,
    | "conversationWorkflowRunEventsV4"
    | "conversationWorkflowRunsV4"
    | "conversationWorkflowRunArtifactsV4"
    | "conversationWorkflowRunArtifactDataV4"
    | "conversationWorkflowRunArtifactReadV4"
    | "conversationWorkflowRunWorkspaceV4"
    | "conversationWorkflowRunNodeResultV4"
  >;
  ensureHandshake: () => Promise<unknown>;
  workspace: { workspacePath: string; workspaceIdentity?: string };
}) {
  const { agentService, ensureHandshake, workspace } = input;
  return {
    async workflowRunEvents(
      params: V4ConversationWorkflowRunEventsParams,
    ): Promise<V4ConversationWorkflowRunEventsResult> {
      await ensureHandshake();
      return agentService.conversationWorkflowRunEventsV4({
        ...workspace,
        sessionId: params.sessionId,
        runId: params.runId,
        ...(params.afterSequence !== undefined ? { afterSequence: params.afterSequence } : {}),
        ...(params.limit !== undefined ? { limit: params.limit } : {}),
      });
    },
    async workflowRuns(
      params: V4ConversationWorkflowRunsParams,
    ): Promise<V4ConversationWorkflowRunsResult> {
      await ensureHandshake();
      return agentService.conversationWorkflowRunsV4({
        ...workspace,
        sessionId: params.sessionId,
        ...(params.limit !== undefined ? { limit: params.limit } : {}),
      });
    },
    // Three readings of the dwf user interface product.
    // ⚠ Terminology: artifact = the output that a script publishes to the user, not the top-level return value of run.
    async workflowRunArtifacts(
      params: V4ConversationWorkflowRunArtifactsParams,
    ): Promise<V4ConversationWorkflowRunArtifactsResult> {
      await ensureHandshake();
      return agentService.conversationWorkflowRunArtifactsV4({
        ...workspace,
        sessionId: params.sessionId,
        runId: params.runId,
      });
    },
    async workflowRunArtifactData(
      params: V4ConversationWorkflowRunArtifactDataParams,
    ): Promise<V4ConversationWorkflowRunArtifactDataResult> {
      await ensureHandshake();
      return agentService.conversationWorkflowRunArtifactDataV4({
        ...workspace,
        sessionId: params.sessionId,
        runId: params.runId,
        artifactId: params.artifactId,
        ...(params.afterSequence !== undefined ? { afterSequence: params.afterSequence } : {}),
        ...(params.limit !== undefined ? { limit: params.limit } : {}),
      });
    },
    async workflowRunArtifactRead(
      params: V4ConversationWorkflowRunArtifactReadParams,
    ): Promise<V4ConversationWorkflowRunArtifactReadResult> {
      await ensureHandshake();
      return agentService.conversationWorkflowRunArtifactReadV4({
        ...workspace,
        sessionId: params.sessionId,
        runId: params.runId,
        artifactId: params.artifactId,
        version: params.version,
        offset: params.offset,
        limit: params.limit,
      });
    },
    // Two readings of the dwf script transcript.
    async workflowRunWorkspace(
      params: V4ConversationWorkflowRunWorkspaceParams,
    ): Promise<V4ConversationWorkflowRunWorkspaceResult> {
      await ensureHandshake();
      return agentService.conversationWorkflowRunWorkspaceV4({
        ...workspace,
        sessionId: params.sessionId,
        runId: params.runId,
      });
    },
    async workflowRunNodeResult(
      params: V4ConversationWorkflowRunNodeResultParams,
    ): Promise<V4ConversationWorkflowRunNodeResultResult> {
      await ensureHandshake();
      return agentService.conversationWorkflowRunNodeResultV4({
        ...workspace,
        sessionId: params.sessionId,
        runId: params.runId,
        siteId: params.siteId,
        ordinal: params.ordinal,
        ...(params.maxBytes !== undefined ? { maxBytes: params.maxBytes } : {}),
      });
    },
  };
}
