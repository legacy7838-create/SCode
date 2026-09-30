import { useEffect, useMemo, useRef, useState } from "react";
import type {
  ZCodePluginReferenceCatalogEntry,
  ZCodePluginsReferenceCatalogResult,
} from "@zcode/shared";
import { useWorkspaceServicesResolution } from "@/hooks/useWorkspaceServices.js";
import { logger } from "@/logger.js";

interface PluginReferenceCatalogState {
  entries: ZCodePluginReferenceCatalogEntry[];
  authority: "session" | "workspace" | null;
  loading: boolean;
  error: string | null;
}

const EMPTY_STATE: PluginReferenceCatalogState = {
  entries: [],
  authority: null,
  loading: false,
  error: null,
};

interface ScopedPluginReferenceCatalogState {
  scope: object | null;
  value: PluginReferenceCatalogState;
}

const EMPTY_SCOPED_STATE: ScopedPluginReferenceCatalogState = {
  scope: null,
  value: EMPTY_STATE,
};

interface PluginReferenceCatalogOptions {
  preferredRemoteSessionId?: string;
  /**
   * Explicit retry generation; the catalog is re-queried when the menu reopens, and closing the
   * menu does not clear what has already loaded.
   */
  refreshRevision?: number;
  /**
   * Only not-yet-settled requests for the same Session within the current runtime are coalesced;
   * released immediately once settled.
   */
  dedupeSessionRequest?: boolean;
  suppressErrorLog?: boolean;
}

let sessionCatalogRequests = new WeakMap<
  object,
  Map<string, Promise<ZCodePluginsReferenceCatalogResult>>
>();

function releaseSessionCatalogRequest(
  services: object,
  serviceCache: Map<string, Promise<ZCodePluginsReferenceCatalogResult>>,
  requestKey: string,
  request: Promise<ZCodePluginsReferenceCatalogResult>,
): void {
  // A successful Promise used to linger forever and keep impersonating the new runtime's Session authority
  // after the Agent runtime was replaced. The cache may only serve as an in-flight single-flight guard during mount;
  // when an old request settles or the component unmounts, it must not delete the newer request already stored under the same key.
  if (serviceCache.get(requestKey) !== request) return;
  serviceCache.delete(requestKey);
  if (serviceCache.size === 0) {
    sessionCatalogRequests.delete(services);
  }
}

function releaseSessionCatalogRequestWhenSettled(
  services: object,
  serviceCache: Map<string, Promise<ZCodePluginsReferenceCatalogResult>>,
  requestKey: string,
  request: Promise<ZCodePluginsReferenceCatalogResult>,
): void {
  const release = () => releaseSessionCatalogRequest(services, serviceCache, requestKey, request);
  void request.then(release, release);
}

/**
 * The catalog of references available in a Plugin conversation. The authority is determined by
 * sessionId: null (a freshly created draft) → the workspace's current catalog; non-null (an
 * existing Session) → the session-owned catalog frozen when that Session was created. Async results
 * are validated by `workspaceKey + sessionId + runtime restart generation + request sequence`: once
 * the key changes or a new request has been issued, returns from an old workspace/session/process
 * generation are discarded outright and must not be backfilled into the new target.
 */
export function usePluginReferenceCatalog(
  workspacePath: string,
  workspaceIdentity: string | undefined,
  sessionId: string | null,
  enabled: boolean,
  options?: PluginReferenceCatalogOptions,
): PluginReferenceCatalogState {
  const resolution = useWorkspaceServicesResolution(
    workspacePath,
    options?.preferredRemoteSessionId,
    workspaceIdentity,
  );
  const [scopedState, setScopedState] =
    useState<ScopedPluginReferenceCatalogState>(EMPTY_SCOPED_STATE);
  const [runtimeRevision, setRuntimeRevision] = useState(0);
  const requestSeqRef = useRef(0);
  // Identity/isolation semantics unified as workspaceKey = workspaceIdentity?.trim() || workspacePath.
  const workspaceKey = workspaceIdentity?.trim() || workspacePath;
  const remoteSessionId =
    resolution.remoteSessionId ?? options?.preferredRemoteSessionId ?? undefined;
  // The remote attachment is also an authority boundary. When the same workspace/session
  // switches remote runtimes, the catalog Promise frozen by the old process must not be reused.
  const requestKey = `${workspaceKey}|${remoteSessionId ?? "local"}|${sessionId ?? "draft"}|runtime:${runtimeRevision}|refresh:${options?.refreshRevision ?? 0}`;
  const services = resolution.services;
  const rpcReady = resolution.rpcReady;

  useEffect(() => {
    if (!enabled || !workspacePath || !sessionId || !rpcReady) return;
    const subscription = services.zcodeAgentService.onAgentRuntimeRestarted((event) => {
      if (event.workspaceKey !== workspaceKey) return;
      // After a runtime restart the workspace/session/attachment may all stay unchanged; explicitly bump the generation
      // so the old authority's first frame is invalidated and the new runtime must re-run the RPC.
      setRuntimeRevision((current) => current + 1);
    });
    return () => subscription.dispose();
  }, [enabled, rpcReady, services, sessionId, workspaceKey, workspacePath]);
  // A fresh request identity is created whenever the Picker reopens, the workspace/session/remote attachment
  // changes, or the services instance reconnects. Rendering only accepts results from the same scope, so even the
  // first frame before the effect issues the new request never briefly leaks the previous authority's catalog.
  const requestScope = useMemo(
    () => ({}),
    [enabled, remoteSessionId, requestKey, rpcReady, services, workspacePath],
  );

  useEffect(() => {
    if (!enabled || !workspacePath || !rpcReady) {
      return;
    }
    const seq = ++requestSeqRef.current;
    let cancelled = false;
    setScopedState({
      scope: requestScope,
      value: { entries: [], authority: null, loading: true, error: null },
    });
    const params = {
      workspacePath,
      ...(workspaceIdentity ? { workspaceIdentity } : {}),
      ...(remoteSessionId ? { remoteSessionId } : {}),
      ...(sessionId ? { sessionId } : {}),
    };
    let request: Promise<ZCodePluginsReferenceCatalogResult>;
    let requestServiceCache: Map<string, Promise<ZCodePluginsReferenceCatalogResult>> | undefined;
    if (options?.dedupeSessionRequest && sessionId) {
      let serviceCache = sessionCatalogRequests.get(services);
      if (!serviceCache) {
        serviceCache = new Map();
        sessionCatalogRequests.set(services, serviceCache);
      }
      const cached = serviceCache.get(requestKey);
      request = cached ?? services.pluginManagementService.getPluginReferenceCatalog(params);
      requestServiceCache = serviceCache;
      if (!cached) {
        serviceCache.set(requestKey, request);
        releaseSessionCatalogRequestWhenSettled(services, serviceCache, requestKey, request);
      }
    } else {
      request = services.pluginManagementService.getPluginReferenceCatalog(params);
    }
    request
      .then((result) => {
        if (cancelled || seq !== requestSeqRef.current) return;
        setScopedState({
          scope: requestScope,
          value: {
            entries: result.plugins,
            authority: result.authority,
            loading: false,
            error: null,
          },
        });
      })
      .catch((error: unknown) => {
        if (cancelled || seq !== requestSeqRef.current) return;
        const message = error instanceof Error ? error.message : String(error);
        // Fail closed: on a query failure the Picker shows an error state instead of falling back to another authority's data.
        if (!options?.suppressErrorLog) {
          logger.warn("[usePluginReferenceCatalog] failed to fetch the plugin reference catalog", {
            error: message,
            requestKey,
          });
        }
        setScopedState({
          scope: requestScope,
          value: {
            entries: [],
            authority: null,
            loading: false,
            error: message,
          },
        });
      });
    return () => {
      cancelled = true;
      if (requestServiceCache) {
        releaseSessionCatalogRequest(services, requestServiceCache, requestKey, request);
      }
    };
    // requestKey already covers every combination change of workspaceKey and sessionId.
  }, [
    enabled,
    options?.dedupeSessionRequest,
    options?.suppressErrorLog,
    remoteSessionId,
    requestKey,
    requestScope,
    rpcReady,
    services,
    sessionId,
    workspaceIdentity,
    workspacePath,
  ]);

  if (!enabled || !workspacePath || !rpcReady || scopedState.scope !== requestScope) {
    return EMPTY_STATE;
  }
  return scopedState.value;
}
