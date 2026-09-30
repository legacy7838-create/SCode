import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  type ReactNode,
} from "react";
import type {
  CommandAck,
  CommandEnvelope,
  V4AttachmentPutParams,
  V4AttachmentPutResult,
  V4ConversationFileChangesParams,
  V4ConversationFileChangesResult,
  V4ConversationFileRewindPreviewParams,
  V4ConversationFileRewindPreviewResult,
  V4ConversationWorkflowRunArtifactDataParams,
  V4ConversationWorkflowRunArtifactDataResult,
  V4ConversationWorkflowRunArtifactReadParams,
  V4ConversationWorkflowRunArtifactReadResult,
  V4ConversationWorkflowRunArtifactsParams,
  V4ConversationWorkflowRunArtifactsResult,
  V4ConversationWorkflowRunNodeResultParams,
  V4ConversationWorkflowRunNodeResultResult,
  V4ConversationWorkflowRunWorkspaceParams,
  V4ConversationWorkflowRunWorkspaceResult,
  V4ConversationWorkflowRunEventsParams,
  V4ConversationWorkflowRunsParams,
  V4ConversationWorkflowRunEventsResult,
  V4ConversationWorkflowRunsResult,
} from "@zcode/shared/zcode-protocol-v4";
import type { IServiceAccessor } from "@zcode/services";
import { ServiceProvider } from "@/hooks/useServices.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { useWorkspaceServicesResolution } from "@/hooks/useWorkspaceServices.js";
import { createAgentConversationTransport } from "@/v4/agentConversationTransport.js";
import type { ConversationAttachmentReadParams, ConversationTransport } from "@/v4/transport.js";
import type { PaneWorkspaceScope } from "@/v4/paneLayoutStore.js";
import { SessionDataLayer } from "@/v4/sessionDataLayer.js";
import { acquireWorkspaceConnection } from "@/v4/workspaceConnectionRegistry.js";
import type { AttachmentUploadOptions } from "@/v4/attachmentUploadTransaction.js";
import { ConversationTelemetryPaneAttachment } from "@/v4/telemetry/ConversationTelemetryAttachment.js";

export interface V4ConversationContextValue {
  layer: SessionDataLayer;
  sendCommand(envelope: CommandEnvelope): Promise<CommandAck>;
  fileChanges(params: V4ConversationFileChangesParams): Promise<V4ConversationFileChangesResult>;
  fileRewindPreview(
    params: V4ConversationFileRewindPreviewParams,
  ): Promise<V4ConversationFileRewindPreviewResult>;
  /**
   * A page of the workflow run event log (the detail page's audit surface); read-only, stateless,
   * and safe to resend after a timeout.
   */
  workflowRunEvents(
    params: V4ConversationWorkflowRunEventsParams,
  ): Promise<V4ConversationWorkflowRunEventsResult>;
  /** The workflow run enumeration (the journal-backed discovery surface after a restart). */
  workflowRuns(params: V4ConversationWorkflowRunsParams): Promise<V4ConversationWorkflowRunsResult>;
  /**
   * The list of a workflow run's **user-facing artifacts** (the durable read path for cold
   * recovery). ⚠ Terminology: artifact = an output the script publishes for the user to see via
   * `artifact.*`, not the run's top-level return value.
   */
  workflowRunArtifacts(
    params: V4ConversationWorkflowRunArtifactsParams,
  ): Promise<V4ConversationWorkflowRunArtifactsResult>;
  /** A page of entries for a preset dashboard (cursor = journal sequence). */
  workflowRunArtifactData(
    params: V4ConversationWorkflowRunArtifactDataParams,
  ): Promise<V4ConversationWorkflowRunArtifactDataResult>;
  /**
   * The bytes of a content artifact, one chunk at a time (≤ 512 KiB); reassembly belongs to the
   * caller's hook.
   */
  workflowRunArtifactRead(
    params: V4ConversationWorkflowRunArtifactReadParams,
  ): Promise<V4ConversationWorkflowRunArtifactReadResult>;
  /**
   * The listing of a dwf script transcript (files.* / git.* / world.run rows, without the body
   * text).
   */
  workflowRunWorkspace(
    params: V4ConversationWorkflowRunWorkspaceParams,
  ): Promise<V4ConversationWorkflowRunWorkspaceResult>;
  /** The bounded body of one workspace node (only fetched when expanded). */
  workflowRunNodeResult(
    params: V4ConversationWorkflowRunNodeResultParams,
  ): Promise<V4ConversationWorkflowRunNodeResultResult>;
  /**
   * High-level put semantics for the UI; the transport internally only uses
   * begin/chunk/commit/abort.
   */
  attachmentPut(
    params: V4AttachmentPutParams,
    options?: AttachmentUploadOptions,
  ): Promise<V4AttachmentPutResult>;
  attachmentRead(
    params: ConversationAttachmentReadParams,
  ): ReturnType<ConversationTransport["attachmentRead"]>;
  attachmentReadRange(
    params: Parameters<ConversationTransport["attachmentReadRange"]>[0],
  ): ReturnType<ConversationTransport["attachmentReadRange"]>;
  onRuntimeRestart(listener: () => void): () => void;
  /**
   * Exists only when the transport exposes runtime liveness (see
   * ConversationTransport.onRuntimeLifecycle). unavailable arrives right at workspace-dispose, and
   * it is the only dependable generation-change signal for rebuilding the draft pre-warm.
   */
  onRuntimeLifecycle?(listener: (state: "available" | "unavailable") => void): () => void;
}

// Export context ontology: static playback view uses static transport itself
// After assembling the value, the Provider is injected directly without parsing the link through the workspace of V4ConversationProvider.
export const V4ConversationContext = createContext<V4ConversationContextValue | null>(null);

interface V4ConversationProviderProps {
  workspacePath: string;
  workspaceIdentity?: string;
  children: ReactNode;
}

function ReadyV4ConversationProvider({
  workspacePath,
  workspaceIdentity,
  children,
  services,
  remoteSessionId,
}: V4ConversationProviderProps & {
  services: IServiceAccessor;
  remoteSessionId: string | null;
}) {
  const { zcodeAgentService } = services;
  const platform = usePlatform();
  const bundle = useMemo(() => {
    const transport = createAgentConversationTransport(zcodeAgentService, {
      workspacePath,
      workspaceIdentity,
      // The remote endpoint was identified by the main workspace resolver but was discarded here
      // remoteSessionId, causing the remote absolute path to be handed over to the local zcode-media. Only local endpoints are injected into the converter.
      ...(remoteSessionId === null && platform.createLocalMediaPreviewUrl
        ? { createLocalMediaPreviewUrl: platform.createLocalMediaPreviewUrl }
        : {}),
    });
    const layer = new SessionDataLayer({ transport });
    return {
      layer,
      sendCommand: (envelope: CommandEnvelope) => transport.sendCommand(envelope),
      fileChanges: (params: V4ConversationFileChangesParams) => transport.fileChanges(params),
      fileRewindPreview: (params: V4ConversationFileRewindPreviewParams) =>
        transport.fileRewindPreview(params),
      workflowRunEvents: (params: V4ConversationWorkflowRunEventsParams) =>
        transport.workflowRunEvents(params),
      workflowRunArtifacts: (params: V4ConversationWorkflowRunArtifactsParams) =>
        transport.workflowRunArtifacts(params),
      workflowRunArtifactData: (params: V4ConversationWorkflowRunArtifactDataParams) =>
        transport.workflowRunArtifactData(params),
      workflowRunArtifactRead: (params: V4ConversationWorkflowRunArtifactReadParams) =>
        transport.workflowRunArtifactRead(params),
      workflowRunWorkspace: (params: V4ConversationWorkflowRunWorkspaceParams) =>
        transport.workflowRunWorkspace(params),
      workflowRunNodeResult: (params: V4ConversationWorkflowRunNodeResultParams) =>
        transport.workflowRunNodeResult(params),
      workflowRuns: (params: V4ConversationWorkflowRunsParams) => transport.workflowRuns(params),
      attachmentPut: (params: V4AttachmentPutParams, options?: AttachmentUploadOptions) =>
        transport.attachmentPut(params, options),
      attachmentRead: (params) => transport.attachmentRead(params),
      attachmentReadRange: (params) => transport.attachmentReadRange(params),
      onRuntimeRestart: (listener: () => void) => transport.onRuntimeRestart(listener),
      ...(transport.onRuntimeLifecycle
        ? {
            onRuntimeLifecycle: (listener: (state: "available" | "unavailable") => void) =>
              transport.onRuntimeLifecycle?.(listener) ?? (() => {}),
          }
        : {}),
    } satisfies V4ConversationContextValue;
  }, [
    platform.createLocalMediaPreviewUrl,
    remoteSessionId,
    workspacePath,
    workspaceIdentity,
    zcodeAgentService,
  ]);

  useEffect(() => {
    return () => {
      bundle.layer.dispose();
    };
  }, [bundle]);

  return (
    <ServiceProvider services={services}>
      <V4ConversationContext.Provider value={bundle}>{children}</V4ConversationContext.Provider>
    </ServiceProvider>
  );
}

/** One host connection plus one SessionDataLayer per workspace. */
export function V4ConversationProvider({
  workspacePath,
  workspaceIdentity,
  children,
}: V4ConversationProviderProps) {
  const resolution = useWorkspaceServicesResolution(workspacePath, undefined, workspaceIdentity);
  if (!resolution.rpcReady) {
    return null;
  }

  return (
    <ReadyV4ConversationProvider
      workspacePath={workspacePath}
      workspaceIdentity={workspaceIdentity}
      services={resolution.services}
      remoteSessionId={resolution.remoteSessionId}
    >
      {children}
    </ReadyV4ConversationProvider>
  );
}

export function useV4Conversation(): V4ConversationContextValue {
  const ctx = useContext(V4ConversationContext);
  if (!ctx) {
    throw new Error("useV4Conversation must be used within a V4ConversationProvider");
  }
  return ctx;
}

/**
 * Whether a conversation context is available. It lets components that **can** render in a host
 * without a conversation (static rendering, replay, completion cards in a transcript) decide
 * whether to mount the data-fetching layer — mounting it requires a context, and without one they
 * draw the cold state.
 */
export function useHasV4Conversation(): boolean {
  return useContext(V4ConversationContext) !== null;
}

interface V4PaneConversationProviderProps {
  /** The primary workspace bound to the pane (the connection routing key). */
  scope: PaneWorkspaceScope;
  children: ReactNode;
}

/**
 * The per-pane data plane: the connection is rented from workspaceConnectionRegistry (panes with
 * the same endpoint+workspaceKey share one transport + SessionDataLayer, with refCount + 30s
 * keep-warm), and the pane's own services are injected into the subtree — hooks such as attachment
 * upload and the sessions-index guard use the pane's accessor instead of mistakenly using the
 * shell's current workspace.
 *
 * A remote target stays in the remote-waiting state while the session store has not yet registered
 * real services, and no child data layer is mounted, so it will neither create a connection with a
 * disconnected proxy nor start a subscription; it also never falls back to base services, and never
 * starts a separate runtime for the pane (a remote-control protection constraint). After a
 * reconnect reaches ready, services get a new reference → the registry keeps the original
 * layer/transport identity and one-directionally activates the latest proxy at the commit stage.
 */
export function V4PaneConversationProvider({ scope, children }: V4PaneConversationProviderProps) {
  const targetResolution = useWorkspaceServicesResolution(
    scope.workspacePath,
    scope.remoteSessionId ?? null,
    scope.workspaceIdentity ?? null,
  );
  const resolvedScope = useMemo<PaneWorkspaceScope>(
    () => ({
      workspacePath: scope.workspacePath,
      ...(scope.workspaceIdentity ? { workspaceIdentity: scope.workspaceIdentity } : {}),
      ...(targetResolution.remoteSessionId
        ? { remoteSessionId: targetResolution.remoteSessionId }
        : {}),
    }),
    [scope.workspaceIdentity, scope.workspacePath, targetResolution.remoteSessionId],
  );
  if (!targetResolution.rpcReady) {
    return null;
  }

  // The remote pane being restored may only have a workspaceIdentity. resolver has parsed out the true
  // If the original scope is still passed to the registry after remoteSessionId, it will be __base__ and the remote endpoint.
  // Each data layer is built, and the final state may fall into the invisible store. After ready, the parsed scope will be used uniformly.
  return (
    <ReadyV4PaneConversationProvider scope={resolvedScope} services={targetResolution.services}>
      {children}
    </ReadyV4PaneConversationProvider>
  );
}

function ReadyV4PaneConversationProvider({
  scope,
  services,
  children,
}: Pick<V4PaneConversationProviderProps, "scope" | "children"> & {
  services: IServiceAccessor;
}) {
  const agentService = services.zcodeAgentService;
  const platform = usePlatform();

  // The same useMemo synchronous connection establishment mode as V4ConversationProvider (renderer has no StrictMode,
  // memo bimodulation does not exist); when dep changes, first create a new lease and then release the old lease in effect cleanup——
  // When the same key is used, refCount does not fall to zero, and keep-warm absorbs cross-key jitter.
  const bundle = useMemo(() => {
    const lease = acquireWorkspaceConnection(
      {
        workspacePath: scope.workspacePath,
        ...(scope.workspaceIdentity ? { workspaceIdentity: scope.workspaceIdentity } : {}),
        ...(scope.remoteSessionId ? { remoteSessionId: scope.remoteSessionId } : {}),
      },
      agentService,
      scope.remoteSessionId ? undefined : platform.createLocalMediaPreviewUrl,
    );
    return {
      lease,
      value: {
        layer: lease.layer,
        sendCommand: (envelope: CommandEnvelope) => lease.transport.sendCommand(envelope),
        fileChanges: (params: V4ConversationFileChangesParams) =>
          lease.transport.fileChanges(params),
        fileRewindPreview: (params: V4ConversationFileRewindPreviewParams) =>
          lease.transport.fileRewindPreview(params),
        workflowRunEvents: (params: V4ConversationWorkflowRunEventsParams) =>
          lease.transport.workflowRunEvents(params),
        workflowRunArtifacts: (params: V4ConversationWorkflowRunArtifactsParams) =>
          lease.transport.workflowRunArtifacts(params),
        workflowRunArtifactData: (params: V4ConversationWorkflowRunArtifactDataParams) =>
          lease.transport.workflowRunArtifactData(params),
        workflowRunArtifactRead: (params: V4ConversationWorkflowRunArtifactReadParams) =>
          lease.transport.workflowRunArtifactRead(params),
        workflowRunWorkspace: (params: V4ConversationWorkflowRunWorkspaceParams) =>
          lease.transport.workflowRunWorkspace(params),
        workflowRunNodeResult: (params: V4ConversationWorkflowRunNodeResultParams) =>
          lease.transport.workflowRunNodeResult(params),
        workflowRuns: (params: V4ConversationWorkflowRunsParams) =>
          lease.transport.workflowRuns(params),
        attachmentPut: (params: V4AttachmentPutParams, options?: AttachmentUploadOptions) =>
          lease.transport.attachmentPut(params, options),
        attachmentRead: (params) => lease.transport.attachmentRead(params),
        attachmentReadRange: (params) => lease.transport.attachmentReadRange(params),
        onRuntimeRestart: (listener: () => void) => lease.transport.onRuntimeRestart(listener),
        ...(lease.transport.onRuntimeLifecycle
          ? {
              onRuntimeLifecycle: (listener: (state: "available" | "unavailable") => void) =>
                lease.transport.onRuntimeLifecycle?.(listener) ?? (() => {}),
            }
          : {}),
      } satisfies V4ConversationContextValue,
    };
  }, [
    agentService,
    platform.createLocalMediaPreviewUrl,
    scope.workspacePath,
    scope.workspaceIdentity,
    scope.remoteSessionId,
  ]);

  useLayoutEffect(() => {
    // acquire occurs in render and is only responsible for stabilizing the lease; store updates and store updates caused by remote proxy replacement
    // Resubscription must wait until commit to avoid synchronously updating existing panes during the rendering phase.
    bundle.lease.activateRemoteService();
  }, [bundle]);

  useEffect(() => {
    return () => {
      bundle.lease.release();
    };
  }, [bundle]);

  return (
    <ServiceProvider services={services}>
      <ConversationTelemetryPaneAttachment services={services} scope={scope}>
        <V4ConversationContext.Provider value={bundle.value}>
          {children}
        </V4ConversationContext.Provider>
      </ConversationTelemetryPaneAttachment>
    </ServiceProvider>
  );
}
