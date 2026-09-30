import { useEffect, useMemo, useRef, useState } from "react";
import type { ZCodeSkillReferenceCatalogEntry } from "@zcode/shared";
import { useWorkspaceServicesResolution } from "@/hooks/useWorkspaceServices.js";
import { logger } from "@/logger.js";

interface ConversationSkillCatalogState {
  skills: ZCodeSkillReferenceCatalogEntry[];
  authority: "session" | "workspace" | null;
  loading: boolean;
  error: string | null;
}

interface ScopedConversationSkillCatalogState {
  scope: object | null;
  value: ConversationSkillCatalogState;
}

const EMPTY_STATE: ConversationSkillCatalogState = {
  skills: [],
  authority: null,
  loading: false,
  error: null,
};

const EMPTY_SCOPED_STATE: ScopedConversationSkillCatalogState = {
  scope: null,
  value: EMPTY_STATE,
};

interface UseSkillsOptions {
  workspacePath: string;
  workspaceIdentity?: string;
  sessionId: string | null;
  enabled: boolean;
  preferredRemoteSessionId?: string;
}

/**
 * The Composer's Skill catalog. A draft without prewarm takes the workspace's current scan as
 * authority; a prewarmed/existing Session takes the corresponding AgentRuntime's frozen snapshot as
 * authority. Whenever the workspace/session/remote attachment/runtime generation changes, stale
 * async results must never be written back.
 */
export function useSkills(options: UseSkillsOptions): ConversationSkillCatalogState {
  const resolution = useWorkspaceServicesResolution(
    options.workspacePath,
    options.preferredRemoteSessionId,
    options.workspaceIdentity,
  );
  const [scopedState, setScopedState] =
    useState<ScopedConversationSkillCatalogState>(EMPTY_SCOPED_STATE);
  const [runtimeRevision, setRuntimeRevision] = useState(0);
  const requestSeqRef = useRef(0);
  const workspaceKey = options.workspaceIdentity?.trim() || options.workspacePath;
  const remoteSessionId =
    resolution.remoteSessionId ?? options.preferredRemoteSessionId ?? undefined;
  const services = resolution.services;
  const rpcReady = resolution.rpcReady;
  const requestKey = `${workspaceKey}|${remoteSessionId ?? "local"}|${options.sessionId ?? "draft"}|runtime:${runtimeRevision}`;

  useEffect(() => {
    if (!options.enabled || !options.sessionId || !rpcReady) return;
    const subscription = services.zcodeAgentService.onAgentRuntimeRestarted((event) => {
      if (event.workspaceKey !== workspaceKey) return;
      // After a runtime rebuild the workspace/session keys stay the same, so the old catalog would still hit.
      // Bump the generation explicitly so the new runtime after a cold recovery must supply Session authority once more.
      setRuntimeRevision((current) => current + 1);
    });
    return () => subscription.dispose();
  }, [options.enabled, options.sessionId, rpcReady, services, workspaceKey]);

  // Isolate rendering by scope identity: even while the effect for a switched key has not run yet, only the empty state is returned, keeping an old Session
  // or a Skill from an old remote attachment from leaking into the new Composer for a frame.
  const requestScope = useMemo(
    () => ({}),
    [options.enabled, remoteSessionId, requestKey, rpcReady, services],
  );

  useEffect(() => {
    if (!options.enabled || !options.workspacePath || !rpcReady) return;
    const seq = ++requestSeqRef.current;
    let cancelled = false;
    setScopedState({
      scope: requestScope,
      value: { skills: [], authority: null, loading: true, error: null },
    });
    const params = {
      workspacePath: options.workspacePath,
      ...(options.workspaceIdentity ? { workspaceIdentity: options.workspaceIdentity } : {}),
      ...(remoteSessionId ? { remoteSessionId } : {}),
      ...(options.sessionId ? { sessionId: options.sessionId } : {}),
    };
    services.zcodeAgentService
      .getSkillReferenceCatalog(params)
      .then((result) => {
        if (cancelled || seq !== requestSeqRef.current) return;
        setScopedState({
          scope: requestScope,
          value: {
            skills: result.skills,
            authority: result.authority,
            loading: false,
            error: null,
          },
        });
      })
      .catch((error: unknown) => {
        if (cancelled || seq !== requestSeqRef.current) return;
        const message = error instanceof Error ? error.message : String(error);
        logger.warn("[useSkills] failed to fetch the chat skill catalog", {
          error: message,
          requestKey,
        });
        setScopedState({
          scope: requestScope,
          value: { skills: [], authority: null, loading: false, error: message },
        });
      });
    return () => {
      cancelled = true;
    };
  }, [
    options.enabled,
    options.sessionId,
    options.workspaceIdentity,
    options.workspacePath,
    remoteSessionId,
    requestKey,
    requestScope,
    rpcReady,
    services,
  ]);

  if (
    !options.enabled ||
    !options.workspacePath ||
    !rpcReady ||
    scopedState.scope !== requestScope
  ) {
    return EMPTY_STATE;
  }
  return scopedState.value;
}
