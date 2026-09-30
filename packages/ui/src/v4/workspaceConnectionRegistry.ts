// Reuse conversation connection registry by endpoint + workspaceKey (reference counting + keep-warm)
// ——Split-screen multi-pane cross-workspace connection layer.
// Multiple panes of the same endpoint and the same workspace share a transport + a SessionDataLayer
// (Same as session multi-pane, it is closed by per-topic refCount single subscription in the layer and does not trigger the CLI.
// (connectionId, topic) resubscription replacement). Isomorphic to sessionsIndexRegistry, with two more points:
// - 30s keep-warm: Do not dispose immediately when refCount returns to zero (prevent pane closing/opening, layout adjustment jitter);
// - AgentService replacement: the remote entry maintains the layer/transport identity and switches to the latest proxy in one direction;
//   The local __base__ entry is rebuilt with the new service.
import type { IZCodeAgentService } from "@zcode/services";
import { createAgentConversationTransport } from "@/v4/agentConversationTransport.js";
import { remoteAgentServiceGeneration } from "@/lib/remoteAgentServiceGeneration.js";
import { ReplaceableConversationTransport } from "@/v4/replaceableConversationTransport.js";
import { SessionDataLayer } from "@/v4/sessionDataLayer.js";
import type { ConversationTransport } from "@/v4/transport.js";
import { logger } from "@/logger.js";

/**
 * The narrow face of agentService that the registry needs (the dependency surface of the
 * conversation transport, so it is easy to inject in tests).
 */
export type WorkspaceConnectionAgentService = Pick<
  IZCodeAgentService,
  | "helloConversationV4"
  | "initializeConversationV4"
  | "subscribeConversationV4"
  | "resyncConversationV4"
  | "unsubscribeConversationV4"
  | "sendConversationCommandV4"
  | "queryConversationCommandsV4"
  | "conversationRowsRangeV4"
  | "conversationPlansV4"
  | "conversationWorkflowRunEventsV4"
  | "conversationWorkflowRunsV4"
  | "conversationWorkflowRunArtifactsV4"
  | "conversationWorkflowRunArtifactDataV4"
  | "conversationWorkflowRunArtifactReadV4"
  | "conversationWorkflowRunWorkspaceV4"
  | "conversationWorkflowRunNodeResultV4"
  | "conversationFileChangesV4"
  | "conversationFileRewindPreviewV4"
  | "attachmentBeginV4"
  | "attachmentChunkV4"
  | "attachmentCommitV4"
  | "attachmentAbortV4"
  | "attachmentPreviewSourceV4"
  | "attachmentReadV4"
  | "onDynamicConversationFrame"
  | "onDynamicLocalTtftFacts"
  | "onAgentRuntimeRestarted"
>;

interface WorkspaceConnectionScope {
  /** = the primary workspace a pane is bound to (the connection routing key). */
  workspacePath: string;
  workspaceIdentity?: string;
  /** endpoint dimension: the remoteSessionId of a remote shard; absent = the local __base__. */
  remoteSessionId?: string;
}

/** A connection lease held by a pane; release is idempotent. */
/**
 * The inferred return type of useSavedWorkflowLauncher includes a lease, and declaration generation
 * requires a nameable export to be kept. @lintignore
 */
export interface WorkspaceConnectionLease {
  readonly layer: SessionDataLayer;
  readonly transport: ConversationTransport;
  /**
   * Activates the remote service carried by this lease after the React commit; for a local lease
   * this is a no-op.
   */
  activateRemoteService(): void;
  release(): void;
}

interface RegistryEntry {
  key: string;
  agentService: WorkspaceConnectionAgentService;
  agentServiceGeneration: number;
  transport: ConversationTransport;
  replaceableTransport: ReplaceableConversationTransport | null;
  layer: SessionDataLayer;
  refCount: number;
  keepWarmTimer: ReturnType<typeof setTimeout> | null;
  /**
   * An old entry removed from the registry after the local service was replaced: disposed as soon
   * as the last lease is released.
   */
  stale: boolean;
}

const registry = new Map<string, RegistryEntry>();

/**
 * The reserved key of the local endpoint (consistent with sessionsIndexRegistry / the task list
 * shardKey).
 */
const LOCAL_WORKSPACE_CONNECTION_ENDPOINT = "__base__";

/**
 * Delayed release window (ms) after the reference count reaches zero; on the same scale as the
 * SessionDataLayer keep-warm.
 */
const WORKSPACE_CONNECTION_KEEP_WARM_MS = 30_000;

/**
 * Registry entry key = endpoint + workspaceKey (the same workspaceKey with a different endpoint
 * does not share).
 */
function buildWorkspaceConnectionKey(scope: WorkspaceConnectionScope): string {
  const workspaceKey = scope.workspaceIdentity?.trim() || scope.workspacePath;
  return `${scope.remoteSessionId ?? LOCAL_WORKSPACE_CONNECTION_ENDPOINT} ${workspaceKey}`;
}

function disposeEntry(entry: RegistryEntry): void {
  if (entry.keepWarmTimer !== null) {
    clearTimeout(entry.keepWarmTimer);
    entry.keepWarmTimer = null;
  }
  entry.layer.dispose();
}

function releaseEntry(entry: RegistryEntry): void {
  entry.refCount -= 1;
  if (entry.refCount > 0) {
    logger.lifecycle.info("v4 workspace connection lease released", {
      event: "v4.workspace_connection.release",
      key: entry.key,
      module: "ui.v4.workspace_connection_registry",
      refCount: entry.refCount,
      status: "completed",
    });
    return;
  }
  if (entry.stale) {
    // It has been replaced and removed from the registry: no new consumers will hit it again, and it will be cleared immediately.
    disposeEntry(entry);
    logger.lifecycle.info("v4 stale workspace connection disposed", {
      event: "v4.workspace_connection.stale_disposed",
      key: entry.key,
      module: "ui.v4.workspace_connection_registry",
      refCount: 0,
      status: "completed",
    });
    return;
  }
  // Close pane ≠ Stop session: delay unsubscription and prevent repeated connection establishment/unsubscription during layout jitter.
  entry.keepWarmTimer = setTimeout(() => {
    if (registry.get(entry.key) === entry) {
      registry.delete(entry.key);
    }
    entry.layer.dispose();
    logger.lifecycle.info("v4 workspace connection keep-warm expired", {
      event: "v4.workspace_connection.keep_warm_expired",
      key: entry.key,
      module: "ui.v4.workspace_connection_registry",
      refCount: 0,
      status: "completed",
    });
  }, WORKSPACE_CONNECTION_KEEP_WARM_MS);
  logger.lifecycle.info("v4 workspace connection lease released", {
    event: "v4.workspace_connection.release",
    keepWarmMs: WORKSPACE_CONNECTION_KEEP_WARM_MS,
    key: entry.key,
    module: "ui.v4.workspace_connection_registry",
    refCount: 0,
    status: "keep_warm",
  });
}

/**
 * Gets or creates the shared conversation connection for an endpoint+workspace, refCount++. The
 * agentService is resolved by the caller (V4PaneConversationProvider via
 * useWorkspaceServicesResolution); the caller only enters this layer when local-ready /
 * remote-ready. remote-waiting does not create a registry entry with a disconnected proxy, and it
 * is still forbidden to fall back to base services or to spin up a separate runtime for the pane.
 */
export function acquireWorkspaceConnection(
  scope: WorkspaceConnectionScope,
  agentService: WorkspaceConnectionAgentService,
  createLocalMediaPreviewUrl?: (path: string) => string,
): WorkspaceConnectionLease {
  const key = buildWorkspaceConnectionKey(scope);
  const existing = registry.get(key);
  const incomingServiceGeneration = remoteAgentServiceGeneration(agentService);
  const isRemote =
    (scope.remoteSessionId ?? LOCAL_WORKSPACE_CONNECTION_ENDPOINT) !==
    LOCAL_WORKSPACE_CONNECTION_ENDPOINT;
  let entry: RegistryEntry;
  if (existing && (existing.agentService === agentService || isRemote)) {
    existing.refCount += 1;
    if (existing.keepWarmTimer !== null) {
      clearTimeout(existing.keepWarmTimer);
      existing.keepWarmTimer = null;
    }
    entry = existing;
    logger.lifecycle.info("v4 workspace connection reused", {
      event: "v4.workspace_connection.reused",
      isRemote,
      key,
      module: "ui.v4.workspace_connection_registry",
      refCount: entry.refCount,
      serviceGeneration: incomingServiceGeneration,
      status: "completed",
    });
  } else {
    if (existing) {
      // Local __base__ service replacement: old entries are invalid and removed;
      // If no one holds it, it will be cleared immediately. If someone holds it, it will be cleared by its last release.
      registry.delete(key);
      existing.stale = true;
      if (existing.refCount <= 0) {
        disposeEntry(existing);
      }
    }
    const initialTransport = createAgentConversationTransport(agentService, {
      workspacePath: scope.workspacePath,
      ...(scope.workspaceIdentity ? { workspaceIdentity: scope.workspaceIdentity } : {}),
      ...(createLocalMediaPreviewUrl ? { createLocalMediaPreviewUrl } : {}),
    });
    const replaceableTransport = isRemote
      ? new ReplaceableConversationTransport(initialTransport)
      : null;
    const transport = replaceableTransport ?? initialTransport;
    entry = {
      key,
      agentService,
      agentServiceGeneration: incomingServiceGeneration,
      transport,
      replaceableTransport,
      layer: new SessionDataLayer({ transport }),
      refCount: 1,
      keepWarmTimer: null,
      stale: false,
    };
    registry.set(key, entry);
    logger.lifecycle.info("v4 workspace connection created", {
      event: "v4.workspace_connection.created",
      isRemote,
      key,
      module: "ui.v4.workspace_connection_registry",
      refCount: 1,
      serviceGeneration: incomingServiceGeneration,
      status: "completed",
    });
  }

  let released = false;
  return {
    layer: entry.layer,
    transport: entry.transport,
    activateRemoteService: () => {
      if (
        released ||
        !isRemote ||
        entry.stale ||
        entry.agentService === agentService ||
        incomingServiceGeneration <= entry.agentServiceGeneration
      ) {
        return;
      }
      // acquire will be executed in React render; if replace is synchronized here, it will go through
      // runtimeRestart listener updates external stores and initiates RPCs. The lease only captures candidate services,
      // Explicitly activated by the Provider during the commit phase while maintaining one-way generation switching.
      if (!entry.replaceableTransport) {
        throw new Error("remote conversation registry entry is missing a replaceable transport");
      }
      entry.agentService = agentService;
      entry.agentServiceGeneration = incomingServiceGeneration;
      entry.replaceableTransport.replace(
        createAgentConversationTransport(agentService, {
          workspacePath: scope.workspacePath,
          ...(scope.workspaceIdentity ? { workspaceIdentity: scope.workspaceIdentity } : {}),
        }),
      );
    },
    release: () => {
      if (released) return;
      released = true;
      releaseEntry(entry);
    },
  };
}
