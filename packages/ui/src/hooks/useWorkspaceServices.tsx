import type { IServiceAccessor } from "@zcode/services";
import { Event, ProxyChannel, type IChannel } from "@zcode/rpc";
import { useMemo } from "react";
import { useOptionalServices, useServices } from "@/hooks/useServices.js";
import {
  useRemoteWorkspaceSessionStore,
  type RemoteWorkspaceSession,
} from "@/store/remoteWorkspaceSessionStore.js";
import { useResolvedRemoteWorkspaceSessionId } from "@/hooks/useResolvedRemoteWorkspaceSessionId.js";
import { useTabStore } from "@/store/TabStoreProvider.js";
import { isWorkspaceTab } from "@/store/tabStore.js";
import { REMOTE_WORKSPACE_DISCONNECTED_ERROR_CODE } from "@/lib/remoteWorkspaceServiceError.js";

let disconnectedRemoteServices: IServiceAccessor | null = null;

interface WorkspaceServiceTargetTab {
  workspacePath: string;
  workspaceIdentity?: string | null;
  remoteSessionId?: string | null;
  remoteTarget?: unknown;
}

function createDisconnectedRemoteServices(): IServiceAccessor {
  const createDisconnectedError = () => {
    const error = new Error(REMOTE_WORKSPACE_DISCONNECTED_ERROR_CODE) as Error & {
      code: string;
    };
    error.code = REMOTE_WORKSPACE_DISCONNECTED_ERROR_CODE;
    return error;
  };
  const disconnectedChannel: IChannel = {
    call: () => Promise.reject(createDisconnectedError()),
    listen: () => Event.None,
  };
  // The disconnected proxy used to keep its own whitelist of plain events; once onAgentRuntimeRestarted was added it was misclassified as an
  // RPC method returning a Promise, and disposing the subscription crashed on Promise.dispose. Reuse the real RPC proxy's
  // event-classification contract here: commands are explicitly rejected, plain/dynamic events uniformly return an empty subscription, so the two rule sets cannot drift apart again.
  const serviceProxy = ProxyChannel.toService<object>(disconnectedChannel);

  return new Proxy(Object.create(null), {
    get() {
      return serviceProxy;
    },
  }) as IServiceAccessor;
}

function getDisconnectedRemoteServices(): IServiceAccessor {
  if (!disconnectedRemoteServices) {
    disconnectedRemoteServices = createDisconnectedRemoteServices();
  }
  return disconnectedRemoteServices;
}

function resolveWorkspaceServicesForTarget(params: {
  currentContextServices: IServiceAccessor;
  resolvedRemoteSessionId: string | null;
  baseServices: IServiceAccessor | null;
  sessionsById: Record<string, Pick<RemoteWorkspaceSession, "services">>;
  isRemoteTarget: boolean;
}): IServiceAccessor {
  const resolvedServices = params.resolvedRemoteSessionId
    ? (params.sessionsById[params.resolvedRemoteSessionId]?.services ?? null)
    : params.isRemoteTarget
      ? getDisconnectedRemoteServices()
      : params.baseServices;

  if (params.isRemoteTarget && !resolvedServices) {
    return getDisconnectedRemoteServices();
  }

  return resolvedServices ?? params.currentContextServices;
}

function resolveBaseWorkspaceServices(
  contextServices: IServiceAccessor,
  registeredBaseServices: IServiceAccessor | null,
): IServiceAccessor {
  return registeredBaseServices ?? contextServices;
}

function hasRemoteWorkspaceMetadata(tab: WorkspaceServiceTargetTab | null | undefined): boolean {
  return Boolean(
    tab?.workspaceIdentity?.trim() || tab?.remoteSessionId?.trim() || tab?.remoteTarget,
  );
}

function resolveWorkspaceServiceIsRemoteTarget(params: {
  workspacePath: string | null | undefined;
  workspaceIdentity?: string | null;
  preferredRemoteSessionId?: string | null;
  activeWorkspacePath?: string | null;
  activeWorkspaceIdentity?: string | null;
  activeTab?: WorkspaceServiceTargetTab | null;
  workspaceTabs?: readonly WorkspaceServiceTargetTab[];
}): boolean {
  if (params.workspaceIdentity?.trim() || params.preferredRemoteSessionId?.trim()) {
    return true;
  }

  const workspacePath = params.workspacePath?.trim();
  if (!workspacePath) {
    return false;
  }

  if (params.activeWorkspacePath === params.workspacePath) {
    if (params.activeWorkspaceIdentity?.trim()) {
      return true;
    }

    // In logs the remote SSH workspace had already been restored as a tab, but the draft warm-up entry once only received
    // workspacePath, so /mnt/... was treated as a local workspace, went through base services, and spawned a local agent on Windows.
    // Cover such path-only calls with the current tab's remote metadata here, so a remote target does not wrongly fall back to the local host.
    if (
      params.activeTab?.workspacePath === params.workspacePath &&
      hasRemoteWorkspaceMetadata(params.activeTab)
    ) {
      return true;
    }
  }

  const matchingTabs = (params.workspaceTabs ?? []).filter(
    (tab) => tab.workspacePath === params.workspacePath,
  );
  return matchingTabs.length === 1 && hasRemoteWorkspaceMetadata(matchingTabs[0]);
}

export function useBaseWorkspaceServices(): IServiceAccessor {
  const contextServices = useServices();
  const registeredBaseServices = useRemoteWorkspaceSessionStore((state) => state.baseServices);

  // The App wraps another ServiceProvider around the currently active workspace.
  // After activating a remote tab, useServices() reads the remote host; but local shards in
  // cross-workspace queries like timeline/search/workspace must keep querying the local host.
  // Prefer the root services registered at renderer startup here, so a remote connection cannot pollute the local task list.
  return resolveBaseWorkspaceServices(contextServices, registeredBaseServices);
}

export function useOptionalBaseWorkspaceServices(): IServiceAccessor | null {
  const contextServices = useOptionalServices();
  const registeredBaseServices = useRemoteWorkspaceSessionStore((state) => state.baseServices);

  // App-global capabilities like the usage entitlement used to take their service from the current
  // workspace's ServiceProvider; a remote tab got the disconnected proxy before its attachment was ready, producing invalid RPCs. The base host is the
  // app-global authority; when Web/SSR has not registered base services, keep the original context/null fallback semantics.
  return registeredBaseServices ?? contextServices;
}

interface WorkspaceServicesResolution {
  services: IServiceAccessor;
  remoteSessionId: string | null;
  isRemoteTarget: boolean;
  connectionKind: "local-ready" | "remote-waiting" | "remote-ready";
  rpcReady: boolean;
}

export function useWorkspaceServicesResolution(
  workspacePath: string | null | undefined,
  preferredRemoteSessionId?: string | null,
  workspaceIdentity?: string | null,
  remoteTarget?: unknown,
): WorkspaceServicesResolution {
  const currentContextServices = useServices();
  const resolvedRemoteSessionId = useResolvedRemoteWorkspaceSessionId(
    workspacePath,
    preferredRemoteSessionId,
    workspaceIdentity,
    remoteTarget,
  );
  const isRemoteTarget = useTabStore((state) =>
    resolveWorkspaceServiceIsRemoteTarget({
      workspacePath,
      workspaceIdentity,
      preferredRemoteSessionId,
      activeWorkspacePath: state.activeWorkspacePath,
      activeWorkspaceIdentity: state.activeWorkspaceIdentity,
      activeTab: (() => {
        const activeTab = state.activeTabId
          ? state.tabs.find((tab) => tab.id === state.activeTabId)
          : null;
        return activeTab && isWorkspaceTab(activeTab) ? activeTab : null;
      })(),
      workspaceTabs: state.tabs.filter(isWorkspaceTab),
    }),
  );
  const resolvedServices = useRemoteWorkspaceSessionStore((state) =>
    resolveWorkspaceServicesForTarget({
      currentContextServices,
      resolvedRemoteSessionId,
      baseServices: state.baseServices,
      sessionsById: state.sessionsById,
      isRemoteTarget,
    }),
  );
  const connectionKind = isRemoteTarget
    ? resolvedRemoteSessionId
      ? "remote-ready"
      : "remote-waiting"
    : "local-ready";

  // After a remote SSH host disconnects, falling back to baseServices while resolvedRemoteSessionId is empty would make
  // a remote task like /root be queried by the local host and report "task does not exist". A remote target without a session must stay disconnected,
  // with the disconnected proxy above returning a recoverable error, instead of misrouting the request to the local workspace.
  // During startup reconnection, having only tab metadata while the real remote services are not yet registered counts as remote-waiting;
  // callers must pause workspace RPC. The disconnected proxy remains only as a final out-of-bounds guard, and an expected waiting state must not be treated as a failure to retry.
  return useMemo(
    () => ({
      services: resolvedServices,
      remoteSessionId: resolvedRemoteSessionId,
      isRemoteTarget,
      connectionKind,
      rpcReady: connectionKind !== "remote-waiting",
    }),
    [connectionKind, isRemoteTarget, resolvedRemoteSessionId, resolvedServices],
  );
}

export function useWorkspaceServices(
  workspacePath: string | null | undefined,
  preferredRemoteSessionId?: string | null,
  workspaceIdentity?: string | null,
  remoteTarget?: unknown,
): IServiceAccessor {
  return useWorkspaceServicesResolution(
    workspacePath,
    preferredRemoteSessionId,
    workspaceIdentity,
    remoteTarget,
  ).services;
}
