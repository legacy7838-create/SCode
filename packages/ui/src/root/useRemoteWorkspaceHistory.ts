/* eslint-disable max-lines -- remote workspace history currently needs restore, reconnect,
 * persistence and cleanup all consolidated inside a single hook; the same-file collaboration
 * boundary is kept for now, to avoid the state regressions that a temporary split to satisfy lint
 * would introduce.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import type {
  AppSettings,
  BotRemoteWorkspaceReconnectedEvent,
  IPlatformService,
  RemoteSessionClosedEvent,
  RemoteWorkspaceSessionEntry,
} from "@zcode/shared";
import { buildSshRemoteHostKey, createUuid, stripRemoteTargetSecrets } from "@zcode/shared";
import type { IServiceAccessor } from "@zcode/services";
import {
  bindRemoteWorkspaceIdentity,
  bindRemoteWorkspacePath,
  getRemoteWorkspaceSession,
  type RemoteWorkspaceSession,
  unregisterRemoteWorkspaceSession,
} from "@/store/remoteWorkspaceSessionStore.js";
import { useZCodeSessionStore } from "@/store/zcodeSessionStore.js";
import { refreshRemotePinnedTasksForSession } from "@/store/remotePinnedTaskStore.js";
import { refreshRemoteTimelineTasksForSession } from "@/store/remoteTimelineTaskStore.js";
import { toast } from "@/components/ui/toast.js";
import {
  buildRemoteWorkspaceIdentity,
  buildRemoteWorkspaceSessionMutation,
  buildWorkspaceSessionKey,
  createRemoteTargetFromSnapshot,
  getRemoteWorkspaceSessionEntries,
  removeRemoteWorkspaceSessionEntries,
} from "@/lib/remoteWorkspaceHistory.js";
import { getErrorMessage } from "@/lib/errorMessage.js";
import { logger } from "@/logger.js";
import { isWorkspaceTab, type TabStoreState, type WindowTabState } from "@/store/tabStore.js";
import {
  buildRemoteWorkspacePersistPatch,
  restorePersistedRemoteWorkspaceSessions,
} from "@/root/remoteWorkspaceSessionPersistence.js";
import { useReconnectingRemoteWorkspaceLogs } from "@/root/useReconnectingRemoteWorkspaceLogs.js";
import {
  reconnectRemoteWorkspaceHistoryEntry,
  type BindRemoteWorkspaceSessionContextFn,
  type ReconnectRemoteWorkspaceOptions,
  type SshReconnectCredentials,
} from "@/root/reconnectRemoteWorkspaceHistoryEntry.js";
import { useRemoteConnectionEntryVisibility } from "@/hooks/useRemoteConnectionEntryVisibility.js";
import { markRemoteWorkspaceRunningTasksFailed } from "@/lib/remoteWorkspaceSessionRuntime.js";

export { reconnectRemoteWorkspaceHistoryEntry };

async function bindRemoteWorkspaceContextAndGetSession(params: {
  platform: Pick<IPlatformService, "bindRemoteWorkspaceSessionContext">;
  sessionId: string;
  workspacePath: string;
  workspaceIdentity?: string;
}): Promise<RemoteWorkspaceSession> {
  if (!getRemoteWorkspaceSession(params.sessionId)) {
    throw new Error(`Remote workspace session does not exist: ${params.sessionId}`);
  }
  await params.platform.bindRemoteWorkspaceSessionContext?.({
    remoteSessionId: params.sessionId,
    workspacePath: params.workspacePath,
    workspaceIdentity: params.workspaceIdentity,
  });
  // bind will replace attachment/services with the same remoteSessionId from A to B.
  // The object captured before bind still points to A, so the current services must be re-read by sessionId after ready ACK.
  const currentSession = getRemoteWorkspaceSession(params.sessionId);
  if (!currentSession) {
    throw new Error(`Remote workspace session does not exist: ${params.sessionId}`);
  }
  return currentSession;
}

function resolveBotRemoteWorkspaceReconnectedIdentity(params: {
  event: Pick<BotRemoteWorkspaceReconnectedEvent, "workspaceIdentity">;
  resolvedWorkspacePath: string;
  target: BotRemoteWorkspaceReconnectedEvent["target"];
}): string {
  const eventWorkspaceIdentity = params.event.workspaceIdentity.trim();
  if (eventWorkspaceIdentity) {
    // Bugfix: Bot task/stream broadcasts continue to use the workspaceIdentity captured by the bot context.
    // If the identity is recalculated using canonical path, the UI tab will be subscribed to another key, causing the remote results to be filtered out.
    return eventWorkspaceIdentity;
  }
  return buildRemoteWorkspaceIdentity(params.resolvedWorkspacePath, params.target);
}

function shouldPersistRemoteWorkspaceFailure(params: {
  pendingReconnectRequestIds: ReadonlyMap<string, string>;
  sessionEntry: RemoteWorkspaceSessionEntry;
  workspaceKey: string;
}): boolean {
  // Was WSL-only: it deferred writing "failed" while a manual reconnect was in
  // flight, because the old session's close event could arrive after the reconnect
  // and would then overwrite the good outcome. With WSL gone every kind persists
  // immediately, which is the pre-existing SSH behaviour.
  return true;
}
interface RemoteWorkspaceTabStoreReader {
  getState(): {
    tabs: WindowTabState[];
  };
}

interface OpenRemoteWorkspaceFromHistoryParams {
  workspaceKey: string;
  tabStoreApi: RemoteWorkspaceTabStoreReader;
  getRemoteSessions: () => RemoteWorkspaceSessionEntry[];
  inflightReconnectWorkspaceKeys: Set<string>;
  activateTabByPath: (workspacePath: string, options?: { workspaceIdentity?: string }) => boolean;
  setReconnectingRemoteWorkspaceKeys: Dispatch<SetStateAction<string[]>>;
  loadCredential: IServiceAccessor["credentialService"]["load"];
  connectRemoteWorkspaceTarget: (
    target: Parameters<IPlatformService["connectRemote"]>[0],
    requestId?: string,
  ) => Promise<string>;
  resolveRemoteWorkspaceCanonicalPath: (
    sessionId: string,
    workspacePath: string,
  ) => Promise<string>;
  disposeRemoteWorkspaceSession: (sessionId: string) => Promise<void>;
  bindRemoteWorkspaceSessionContext: BindRemoteWorkspaceSessionContextFn;
  addTab: (
    workspacePath: string,
    options?: {
      remoteSessionId?: string;
      remoteTarget?: Parameters<IPlatformService["connectRemote"]>[0];
      workspaceIdentity?: string;
      localWorkspacePath?: string;
    },
  ) => void;
  commitRemoteWorkspaceSessionMutation: (
    mutation: ReturnType<typeof buildRemoteWorkspaceSessionMutation>,
  ) => Promise<RemoteWorkspaceSessionEntry>;
  resetLogsForWorkspaceKey: (workspaceKey: string) => void;
  onWorkspaceActivated?: (target: { workspacePath: string; workspaceIdentity: string }) => void;
  createReconnectRequestId?: () => string;
  pendingReconnectRequestIds?: Map<string, string>;
  reconnectImpl?: typeof reconnectRemoteWorkspaceHistoryEntry;
}

interface ReconnectRemoteWorkspaceByKeyParams {
  workspaceKey: string;
  canUseRemoteWorkspace: boolean;
  getRemoteSessions: () => RemoteWorkspaceSessionEntry[];
  runReconnectRemoteWorkspace: (
    sessionEntry: RemoteWorkspaceSessionEntry,
    options?: ReconnectRemoteWorkspaceOptions,
  ) => Promise<void>;
  options?: ReconnectRemoteWorkspaceOptions;
}

async function reconnectRemoteWorkspaceByKey({
  workspaceKey,
  canUseRemoteWorkspace,
  getRemoteSessions,
  runReconnectRemoteWorkspace,
  options,
}: ReconnectRemoteWorkspaceByKeyParams): Promise<boolean> {
  if (!canUseRemoteWorkspace) {
    throw new Error("Remote workspace is disabled in this mode");
  }

  const sessionEntry = getRemoteSessions().find(
    (entry) => buildWorkspaceSessionKey(entry) === workspaceKey,
  );
  if (!sessionEntry) {
    throw new Error(`Remote workspace is not in this window, cannot reconnect: ${workspaceKey}`);
  }

  await runReconnectRemoteWorkspace(sessionEntry, options);
  return true;
}

function collectSshReconnectGroup(params: {
  selected: RemoteWorkspaceSessionEntry;
  sessions: RemoteWorkspaceSessionEntry[];
  tabs: WindowTabState[];
}): RemoteWorkspaceSessionEntry[] {
  if (params.selected.target.kind !== "ssh") {
    return [params.selected];
  }
  const remoteHostKey = buildSshRemoteHostKey(params.selected.target);
  const disconnectedWorkspaceKeys = new Set(
    params.tabs.flatMap((tab) => {
      if (!isWorkspaceTab(tab) || tab.remoteSessionId) {
        return [];
      }
      return [buildWorkspaceSessionKey(tab)];
    }),
  );
  const reconnectGroup = params.sessions.filter(
    (entry) =>
      entry.target.kind === "ssh" &&
      buildSshRemoteHostKey(entry.target) === remoteHostKey &&
      disconnectedWorkspaceKeys.has(buildWorkspaceSessionKey(entry)),
  );
  const selectedWorkspaceKey = buildWorkspaceSessionKey(params.selected);
  if (!reconnectGroup.some((entry) => buildWorkspaceSessionKey(entry) === selectedWorkspaceKey)) {
    return [params.selected];
  }

  // The order of historical records does not represent the initiator of this reconnection. initiator must be fixed at the first place,
  // Otherwise, sibling may create the shared host first when loading credentials concurrently, causing the entire group to misuse the old credentials.
  return [
    params.selected,
    ...reconnectGroup.filter((entry) => buildWorkspaceSessionKey(entry) !== selectedWorkspaceKey),
  ];
}

async function reconnectRemoteWorkspaceGroup(params: {
  selected: RemoteWorkspaceSessionEntry;
  reconnectGroup: RemoteWorkspaceSessionEntry[];
  reconnectEntry: (
    entry: RemoteWorkspaceSessionEntry,
    options?: ReconnectRemoteWorkspaceOptions,
  ) => Promise<boolean>;
  options?: ReconnectRemoteWorkspaceOptions;
}): Promise<void> {
  const selectedWorkspaceKey = buildWorkspaceSessionKey(params.selected);
  const siblings = params.reconnectGroup.filter(
    (entry) => buildWorkspaceSessionKey(entry) !== selectedWorkspaceKey,
  );

  if (params.selected.target.kind !== "ssh") {
    try {
      await params.reconnectEntry(params.selected, {
        ...params.options,
        throwOnFailure: true,
      });
    } catch (error) {
      if (params.options?.throwOnFailure) {
        throw error;
      }
    }
    return;
  }

  type InitiatorHostGate =
    | { status: "ready"; credentials: SshReconnectCredentials }
    | { status: "skipped" }
    | { status: "failed"; error: unknown };
  let hostReadyCredentials: SshReconnectCredentials | undefined;
  let resolveHostReady!: (result: InitiatorHostGate) => void;
  const hostReadyPromise = new Promise<InitiatorHostGate>((resolve) => {
    resolveHostReady = resolve;
  });

  // Concurrent connections within the group will allow the sibling that completes the credential load first to build a shared host.
  // The initiator is first responsible for building the Host to ready; subsequent provider/task initialization will no longer block the sibling attachment.
  const initiatorPromise = params.reconnectEntry(params.selected, {
    ...params.options,
    throwOnFailure: true,
    onSshHostReady: (credentials) => {
      if (hostReadyCredentials) {
        return;
      }
      hostReadyCredentials = credentials;
      resolveHostReady({ status: "ready", credentials });
    },
  });
  const initiatorFinishedBeforeReady = initiatorPromise.then<InitiatorHostGate, InitiatorHostGate>(
    (didReconnect) => {
      if (hostReadyCredentials) {
        return { status: "ready", credentials: hostReadyCredentials };
      }
      return didReconnect
        ? {
            status: "failed",
            error: new Error("SSH initiator completed without reporting Host ready"),
          }
        : { status: "skipped" };
    },
    (error: unknown) =>
      hostReadyCredentials
        ? { status: "ready", credentials: hostReadyCredentials }
        : { status: "failed", error },
  );
  const hostGate = await Promise.race([hostReadyPromise, initiatorFinishedBeforeReady]);
  if (hostGate.status !== "ready") {
    if (hostGate.status === "failed" && params.options?.throwOnFailure) {
      throw hostGate.error;
    }
    return;
  }

  // Sibling only reuses the initiator credential that hits the ready Host and no longer reads the respective historical credentials;
  // path/provider/task is initialized in parallel with the initiator and maintains independent failure semantics.
  const siblingPromise = Promise.allSettled(
    siblings.map((entry) =>
      params.reconnectEntry(entry, {
        ...params.options,
        activateWorkspaceAfterReconnect: false,
        sshCredentialsOverride: hostGate.credentials,
      }),
    ),
  );
  const [initiatorResult] = await Promise.all([
    initiatorPromise.then(
      () => ({ status: "fulfilled" as const }),
      (error: unknown) => ({ status: "rejected" as const, error }),
    ),
    siblingPromise,
  ]);
  if (initiatorResult.status === "rejected" && params.options?.throwOnFailure) {
    throw initiatorResult.error;
  }
}

function shouldKeepRemoteWorkspaceInTabs(params: {
  tabStoreApi: RemoteWorkspaceTabStoreReader;
  workspacePath: string;
  workspaceIdentity?: string;
}): boolean {
  const reconnectWorkspaceKey = params.workspaceIdentity?.trim() || params.workspacePath;
  return params.tabStoreApi
    .getState()
    .tabs.some(
      (tab): tab is import("@/store/tabStore.js").WorkspaceTabState =>
        isWorkspaceTab(tab) &&
        ((tab.workspaceIdentity?.trim() || tab.workspacePath) === reconnectWorkspaceKey ||
          tab.workspacePath === params.workspacePath),
    );
}

async function cancelPendingRemoteReconnectsForWorkspaceKeys(params: {
  workspaceKeys: string[];
  pendingRequestIds: Map<string, string>;
  cancelPendingRemoteConnection?: (requestId?: string) => Promise<void>;
  logger: Pick<typeof logger, "warn">;
}): Promise<void> {
  const requestIds = params.workspaceKeys.flatMap((workspaceKey) => {
    const requestId = params.pendingRequestIds.get(workspaceKey);
    if (!requestId) {
      return [];
    }

    params.pendingRequestIds.delete(workspaceKey);
    return [requestId];
  });

  if (!params.cancelPendingRemoteConnection || requestIds.length === 0) {
    return;
  }

  await Promise.all(
    requestIds.map(async (requestId) => {
      try {
        await params.cancelPendingRemoteConnection?.(requestId);
      } catch (error) {
        params.logger.warn("[Root] failed to cancel the remote workspace reconnect", {
          requestId,
          error,
        });
      }
    }),
  );
}

async function openRemoteWorkspaceFromHistoryEntry({
  workspaceKey,
  tabStoreApi,
  getRemoteSessions,
  inflightReconnectWorkspaceKeys,
  activateTabByPath,
  setReconnectingRemoteWorkspaceKeys,
  loadCredential,
  connectRemoteWorkspaceTarget,
  resolveRemoteWorkspaceCanonicalPath,
  disposeRemoteWorkspaceSession,
  bindRemoteWorkspaceSessionContext,
  addTab,
  commitRemoteWorkspaceSessionMutation,
  resetLogsForWorkspaceKey,
  createReconnectRequestId,
  pendingReconnectRequestIds,
  reconnectImpl = reconnectRemoteWorkspaceHistoryEntry,
  onWorkspaceActivated,
}: OpenRemoteWorkspaceFromHistoryParams): Promise<void> {
  const sessionEntry = getRemoteSessions().find(
    (entry) => buildWorkspaceSessionKey(entry) === workspaceKey,
  );
  if (!sessionEntry) {
    return;
  }

  if (inflightReconnectWorkspaceKeys.has(workspaceKey)) {
    return;
  }

  const existingWorkspaceTab = tabStoreApi
    .getState()
    .tabs.find(
      (tab): tab is import("@/store/tabStore.js").WorkspaceTabState =>
        isWorkspaceTab(tab) && buildWorkspaceSessionKey(tab) === workspaceKey,
    );
  if (existingWorkspaceTab?.remoteSessionId) {
    activateTabByPath(existingWorkspaceTab.workspacePath, {
      workspaceIdentity: existingWorkspaceTab.workspaceIdentity,
    });
    return;
  }

  // Selecting page remote history and sidebar reconnection both belong to the semantics of "restoring the existing remote workspace".
  // If there is no secondary verification of "the workspace still needs to be retained", the user will still be successfully called back and re-added to the tab after being removed during reconnection.
  // The same shouldKeep judgment is reused here to ensure that the race behavior of the two entries is consistent.
  resetLogsForWorkspaceKey(workspaceKey);
  inflightReconnectWorkspaceKeys.add(workspaceKey);
  const requestId = createReconnectRequestId?.();
  if (requestId) {
    pendingReconnectRequestIds?.set(workspaceKey, requestId);
  }
  try {
    await reconnectImpl({
      sessionEntry,
      activateTabByPath,
      setReconnectingRemoteWorkspaceKeys,
      loadCredential,
      connectRemoteWorkspaceTarget,
      resolveRemoteWorkspaceCanonicalPath,
      disposeRemoteWorkspaceSession,
      bindRemoteWorkspaceSessionContext,
      bindRemoteWorkspacePath,
      bindRemoteWorkspaceIdentity,
      upsertWorkspaceTab: addTab,
      commitRemoteWorkspaceSessionMutation,
      getRemoteSessions,
      logger,
      toast,
      shouldKeepReconnectedWorkspace: ({ workspacePath, workspaceIdentity }) =>
        shouldKeepRemoteWorkspaceInTabs({
          tabStoreApi,
          workspacePath,
          workspaceIdentity,
        }),
      onWorkspaceActivated: (target) => {
        logger.debug(
          "[Root] remote history workspace ready, committing tab and draft activation",
          target,
        );
        onWorkspaceActivated?.(target);
      },
      options: {
        // In the past, the historical entry only backfilled the connected tab, but did not submit tab activation and draft owner.
        // So after the connection is successful, the right side still stays in the old workspace. The shared helper will only perform this commit after the services are ready,
        // Remote-waiting tabs missing remoteSessionId will not be exposed in advance.
        activateWorkspaceAfterReconnect: true,
        showErrorToast: true,
        requestId,
      },
    });
  } finally {
    inflightReconnectWorkspaceKeys.delete(workspaceKey);
    if (requestId && pendingReconnectRequestIds?.get(workspaceKey) === requestId) {
      pendingReconnectRequestIds.delete(workspaceKey);
    }
  }
}

async function selectRemoteWorkspaceProjectFromDialog({
  canUseRemoteWorkspace,
  sessionId,
  path,
  localWorkspacePath,
  loadingMessage,
  getRemoteWorkspaceSession,
  connectionTarget,
  getWorkspaceTabs,
  resolveRemoteWorkspaceCanonicalPath,
  activateTabByPath,
  handleCancelRemoteProject,
  bindRemoteWorkspaceSessionContext,
  commitRemoteWorkspaceSessionMutation,
  getRemoteSessions,
  bindRemoteWorkspacePath,
  bindRemoteWorkspaceIdentity,
  addTab,
  onWorkspaceActivated,
  refreshPinnedTasks,
  refreshTimelineTasks,
}: {
  canUseRemoteWorkspace: boolean;
  sessionId: string;
  path: string;
  localWorkspacePath?: string;
  loadingMessage: string;
  getRemoteWorkspaceSession: (sessionId: string) => RemoteWorkspaceSession | null;
  connectionTarget?: Parameters<IPlatformService["connectRemote"]>[0];
  getWorkspaceTabs: () => WindowTabState[];
  resolveRemoteWorkspaceCanonicalPath: (
    sessionId: string,
    workspacePath: string,
  ) => Promise<string>;
  activateTabByPath: (workspacePath: string, options?: { workspaceIdentity?: string }) => boolean;
  handleCancelRemoteProject: (sessionId: string) => Promise<void>;
  bindRemoteWorkspaceSessionContext: BindRemoteWorkspaceSessionContextFn;
  commitRemoteWorkspaceSessionMutation: (
    mutation: ReturnType<typeof buildRemoteWorkspaceSessionMutation>,
  ) => Promise<RemoteWorkspaceSessionEntry>;
  getRemoteSessions: () => RemoteWorkspaceSessionEntry[];
  bindRemoteWorkspacePath: (workspacePath: string, sessionId: string) => void;
  bindRemoteWorkspaceIdentity: (workspaceIdentity: string, sessionId: string) => void;
  addTab: (
    workspacePath: string,
    options?: {
      remoteSessionId?: string;
      remoteTarget?: Parameters<IPlatformService["connectRemote"]>[0];
      workspaceIdentity?: string;
      localWorkspacePath?: string;
    },
  ) => void;
  onWorkspaceActivated?: (target: { workspacePath: string; workspaceIdentity: string }) => void;
  refreshPinnedTasks: (params: {
    sessionId: string;
    workspacePath: string;
    workspaceIdentity?: string;
  }) => Promise<void>;
  refreshTimelineTasks: (params: {
    sessionId: string;
    workspacePath: string;
    workspaceIdentity?: string;
  }) => Promise<void>;
}): Promise<void> {
  if (!canUseRemoteWorkspace) {
    throw new Error("Remote workspace is disabled in this mode");
  }

  const remoteSession = getRemoteWorkspaceSession(sessionId);
  if (!remoteSession) {
    throw new Error(loadingMessage);
  }
  const remoteTarget = connectionTarget ?? remoteSession.target;
  if (!remoteTarget) {
    // The mobile web relay reuses the remote session store only for service routing and has no local reconnectable target.
    // The remote history directory selection/persistence process must have a target. If it is missing, it will be blocked directly to avoid writing the bridge session without a target into the history.
    throw new Error(`Remote workspace session is missing a connection target: ${sessionId}`);
  }

  const canonicalPath = await resolveRemoteWorkspaceCanonicalPath(sessionId, path);
  const workspaceIdentity = buildRemoteWorkspaceIdentity(canonicalPath, remoteTarget);
  const existingWorkspaceTab = getWorkspaceTabs().find(
    (tab): tab is import("@/store/tabStore.js").WorkspaceTabState =>
      isWorkspaceTab(tab) &&
      tab.workspacePath === canonicalPath &&
      (tab.workspaceIdentity?.trim() || tab.workspacePath) === workspaceIdentity,
  );

  if (
    existingWorkspaceTab?.remoteSessionId &&
    activateTabByPath(canonicalPath, { workspaceIdentity })
  ) {
    onWorkspaceActivated?.({ workspacePath: canonicalPath, workspaceIdentity });
    await handleCancelRemoteProject(sessionId);
    return;
  }

  // The disconnected tab used to be activated by activateTabByPath before the provider/session binding was completed.
  // V4PaneConversationProvider can only get remote-waiting at this time, because rpcReady=false returns null.
  // The right side will be blank first, and the new conversation will appear after the subsequent addTab writes back the remoteSessionId.
  // The disconnected tab and the first connection wait until the service binding is completed and then activated atomically by addTab to avoid exposing the semi-connected workspace.

  // Create a new connection without context, main/host logical session
  // The descriptor stays in the connection root directory "/", and the identity is also built by the host after parsing the target; while tab, remote history and
  // The workspace list visible on the mobile phone uses the canonicalPath/workspaceIdentity calculated here.
  // Mobile phone bridging (attachRemoteWorkspaceSessionHost) requires the two to be congruent, so you must first change canonical after selecting the directory.
  // The context is bound back to main, and then the connected state and tab are submitted. df2db1df7a When moving provider to main/host synchronously
  // Incidentally, I deleted this bind, which caused the directory selected after creating a new connection to be rejected by REMOTE_WORKSPACE_IDENTITY_MISMATCH on the mobile phone.
  // When bind fails, fail-closed: Recycle the session and throw the error back to the connection pop-up window, leaving no session with inconsistent descriptor and tab.
  try {
    await bindRemoteWorkspaceSessionContext({
      sessionId,
      workspacePath: canonicalPath,
      workspaceIdentity,
    });
  } catch (error) {
    await handleCancelRemoteProject(sessionId);
    throw error;
  }

  await commitRemoteWorkspaceSessionMutation(
    buildRemoteWorkspaceSessionMutation({
      remoteSessions: getRemoteSessions(),
      workspacePath: canonicalPath,
      localWorkspacePath,
      workspaceIdentity,
      target: remoteTarget,
      lastConnectionStatus: "connected",
      touchOpenedAt: true,
    }),
  );

  bindRemoteWorkspacePath(canonicalPath, sessionId);
  bindRemoteWorkspaceIdentity(workspaceIdentity, sessionId);
  addTab(canonicalPath, {
    remoteSessionId: sessionId,
    remoteTarget: stripRemoteTargetSecrets(remoteTarget),
    workspaceIdentity,
    localWorkspacePath,
  });
  // startDraft was previously executed after the caller waited for the pinned/timeline refresh to complete.
  // The tab has been cut to the far end but the draft owner is still in the old state, forming a visible blank middle frame.
  // The activation callback must immediately follow addTab and commit the draft state of the same workspaceKey before any list refresh await.
  onWorkspaceActivated?.({ workspacePath: canonicalPath, workspaceIdentity });
  await Promise.all([
    refreshPinnedTasks({
      sessionId,
      workspacePath: canonicalPath,
      workspaceIdentity,
    }),
    refreshTimelineTasks({
      sessionId,
      workspacePath: canonicalPath,
      workspaceIdentity,
    }),
  ]);
}

export function useRemoteWorkspaceHistory({
  intl,
  services,
  platform,
  supportsSettings,
  allowRemoteWorkspace = true,
  ensureConversationWorkspaceOnRestore = false,
  deferInactiveWorkspaceRestore = false,
  unavailableWorkspacePath,
  tabStoreApi,
  activateTabByPath,
  addTab,
  onWorkspaceActivated,
}: {
  intl: ReturnType<typeof import("@/i18n/IntlProvider.js").useZCodeIntl>["intl"];
  services: IServiceAccessor;
  platform: IPlatformService;
  supportsSettings: boolean;
  allowRemoteWorkspace?: boolean;
  ensureConversationWorkspaceOnRestore?: boolean;
  /**
   * Desktop main window only: once input is available, the inactive workspace is added to the
   * sidebar/task data sources.
   */
  deferInactiveWorkspaceRestore?: boolean;
  unavailableWorkspacePath?: string;
  tabStoreApi: ReturnType<typeof import("@/store/TabStoreProvider.js").useTabStoreApi>;
  activateTabByPath: (workspacePath: string, options?: { workspaceIdentity?: string }) => boolean;
  addTab: (
    workspacePath: string,
    options?: {
      remoteSessionId?: string;
      remoteTarget?: Parameters<IPlatformService["connectRemote"]>[0];
      workspaceIdentity?: string;
      localWorkspacePath?: string;
    },
  ) => void;
  onWorkspaceActivated?: (target: { workspacePath: string; workspaceIdentity: string }) => void;
}) {
  const showRemoteConnectionEntry = useRemoteConnectionEntryVisibility();
  const canUseRemoteWorkspace = allowRemoteWorkspace && showRemoteConnectionEntry;
  const allowRemoteWorkspaceRestore = canUseRemoteWorkspace;
  const [remoteWorkspaceSessions, setRemoteWorkspaceSessions] = useState<
    RemoteWorkspaceSessionEntry[]
  >([]);
  const remoteWorkspaceSessionsRef = useRef<RemoteWorkspaceSessionEntry[]>([]);
  const [reconnectingRemoteWorkspaceKeys, setReconnectingRemoteWorkspaceKeys] = useState<string[]>(
    [],
  );
  const inflightReconnectWorkspaceKeysRef = useRef<Set<string>>(new Set());
  const pendingReconnectRequestIdsRef = useRef<Map<string, string>>(new Map());
  const pendingConnectionTargetsBySessionIdRef = useRef<
    Map<string, Parameters<IPlatformService["connectRemote"]>[0]>
  >(new Map());
  // In the previous version, there was a useRef used to initiate a reconnection attempt.
  // After removing the automatic reconnection logic, Vite Fast Refresh will reuse the hook slot of the old fiber.
  // This causes useState in the next layer useReconnectingRemoteWorkspaceLogs to fall on the old useRef slot and trigger React "Should have a queue".
  // Keeping an empty ref is only used to stabilize the hook sequence in hot updates and does not restore any startup reconnection behavior.
  const remoteStartupReconnectRefreshCompatibilityRef = useRef<null>(null);
  void remoteStartupReconnectRefreshCompatibilityRef;
  const {
    logsByWorkspaceKey: reconnectingRemoteWorkspaceLogsByWorkspaceKey,
    resetLogsForWorkspaceKey,
  } = useReconnectingRemoteWorkspaceLogs({
    platform,
    reconnectingWorkspaceKeys: reconnectingRemoteWorkspaceKeys,
    resolveWorkspaceTargetByKey: (workspaceKey) =>
      remoteWorkspaceSessionsRef.current.find(
        (entry) => buildWorkspaceSessionKey(entry) === workspaceKey,
      )?.target ?? null,
    resolveWorkspaceRequestIdByKey: (workspaceKey) =>
      pendingReconnectRequestIdsRef.current.get(workspaceKey) ?? null,
  });

  const syncPersistedWorkspaceSession = useCallback(
    async (nextRemoteSessions: readonly RemoteWorkspaceSessionEntry[]) => {
      setRemoteWorkspaceSessions([...nextRemoteSessions]);
      remoteWorkspaceSessionsRef.current = [...nextRemoteSessions];

      if (!supportsSettings) {
        return;
      }

      await services.settingService.update(
        buildRemoteWorkspacePersistPatch(tabStoreApi.getState(), nextRemoteSessions),
      );
    },
    [services.settingService, supportsSettings, tabStoreApi],
  );

  const commitRemoteWorkspaceSessionMutation = useCallback(
    async (mutation: ReturnType<typeof buildRemoteWorkspaceSessionMutation>) => {
      for (const credentialKey of mutation.credentialKeysToDelete) {
        try {
          await services.credentialService.delete(credentialKey);
        } catch (error) {
          logger.warn("[Root] failed to delete the remote workspace credential", {
            credentialKey,
            error,
          });
        }
      }

      for (const credential of mutation.credentialsToSave) {
        await services.credentialService.save(credential.key, credential.value);
      }

      await syncPersistedWorkspaceSession(mutation.nextRemoteSessions);
      return mutation.entry;
    },
    [services.credentialService, syncPersistedWorkspaceSession],
  );

  const waitForRemoteWorkspaceSessionReady = useCallback(async (sessionId: string) => {
    if (getRemoteWorkspaceSession(sessionId)) {
      return;
    }

    await new Promise<void>((resolve, reject) => {
      const startedAt = Date.now();
      const pollTimer = window.setInterval(() => {
        if (getRemoteWorkspaceSession(sessionId)) {
          window.clearInterval(pollTimer);
          resolve();
          return;
        }

        if (Date.now() - startedAt >= 3000) {
          window.clearInterval(pollTimer);
          reject(
            new Error(
              `Timed out waiting for the remote workspace session to be ready: ${sessionId}`,
            ),
          );
        }
      }, 50);
    });
  }, []);

  const connectRemoteWorkspaceTarget = useCallback(
    async (
      target: Parameters<IPlatformService["connectRemote"]>[0],
      requestId?: string,
      context?: Parameters<IPlatformService["connectRemote"]>[2],
    ) => {
      const result = await platform.connectRemote(target, requestId, context);
      if (!result.success) {
        throw new Error(getErrorMessage(result.error || "Connection failed"));
      }

      if (!result.sessionId) {
        throw new Error("Remote session was not created");
      }

      // A successful remote connection only means that the main/host session has been established.
      // The MessagePort on the renderer side may still be registered in the zustand store in the next shot.
      // If you addTab immediately at this time, it will briefly go to the local services, causing the first screen to read the directory/preheat ZCode Agent to hit the wrong service.
      // Here, wait until the session is actually hung into the store before continuing.
      await waitForRemoteWorkspaceSessionReady(result.sessionId);
      if (!context) {
        // The shared host only returns the masked target to the renderer store; the complete credentials are only temporarily retained until the directory selection process is completed.
        pendingConnectionTargetsBySessionIdRef.current.set(result.sessionId, target);
      }
      return result.sessionId;
    },
    [platform, waitForRemoteWorkspaceSessionReady],
  );

  const resolveRemoteWorkspaceCanonicalPath = useCallback(
    async (sessionId: string, workspacePath: string): Promise<string> => {
      const remoteSession = getRemoteWorkspaceSession(sessionId);
      if (!remoteSession) {
        return workspacePath;
      }

      try {
        // The same directory may be entered via a symbolic link alias (e.g. /dev vs. /home/dev),
        // Previously, directly persisting user input would identify the same workspace as two identities.
        // Here, realpath normalization is performed on the remote host, and then identity calculation and persistence are involved.
        return await remoteSession.services.fileService.resolvePath({
          path: workspacePath,
        });
      } catch {
        return workspacePath;
      }
    },
    [],
  );

  const buildPersistedTabPatch = useCallback(
    (state: TabStoreState) =>
      buildRemoteWorkspacePersistPatch(state, remoteWorkspaceSessionsRef.current),
    [],
  );

  const handleCancelRemoteProject = useCallback(
    async (sessionId: string) => {
      try {
        await platform.disposeRemoteSession(sessionId);
      } finally {
        pendingConnectionTargetsBySessionIdRef.current.delete(sessionId);
        // If the remote directory selection is canceled before confirmation and the session release fails, the front-end status cannot be stuck at "There is still a remote session to be selected".
        // The local mapping is always cleared here to avoid reusing an expired session record when the pop-up window is opened again next time.
        unregisterRemoteWorkspaceSession(sessionId);
      }
    },
    [platform],
  );

  const bindRemoteWorkspaceSessionContext = useCallback<BindRemoteWorkspaceSessionContextFn>(
    async ({ sessionId, workspacePath, workspaceIdentity }) => {
      // bind will replace the renderer attachment with the same remoteSessionId;
      // Reuse bindRemoteWorkspaceContextAndGetSession and wait for ready ACK before returning. After that, the new generation services are read according to sessionId.
      await bindRemoteWorkspaceContextAndGetSession({
        platform,
        sessionId,
        workspacePath,
        workspaceIdentity,
      });
    },
    [platform],
  );

  const runReconnectRemoteWorkspaceEntry = useCallback(
    async (
      sessionEntry: RemoteWorkspaceSessionEntry,
      options?: ReconnectRemoteWorkspaceOptions,
    ): Promise<boolean> => {
      const workspaceKey = buildWorkspaceSessionKey(sessionEntry);
      if (inflightReconnectWorkspaceKeysRef.current.has(workspaceKey)) {
        return false;
      }
      const workspaceTab = tabStoreApi
        .getState()
        .tabs.find(
          (tab): tab is import("@/store/tabStore.js").WorkspaceTabState =>
            isWorkspaceTab(tab) && buildWorkspaceSessionKey(tab) === workspaceKey,
        );
      if (!workspaceTab || workspaceTab.remoteSessionId) {
        return false;
      }

      resetLogsForWorkspaceKey(workspaceKey);
      inflightReconnectWorkspaceKeysRef.current.add(workspaceKey);
      const requestId = createUuid();
      pendingReconnectRequestIdsRef.current.set(workspaceKey, requestId);
      try {
        // During reconnection, only the remoteSessionId of ready is silently backfilled; activation is performed by the reconnect helper
        // Execute after backfilling to prevent active tab from exposing remote-waiting intermediate state.
        const upsertWorkspaceTab = tabStoreApi.getState().ensureWorkspaceTab;
        logger.debug("[Root] remote workspace reconnecting, keeping the current conversation", {
          workspaceKey,
        });
        await reconnectRemoteWorkspaceHistoryEntry({
          sessionEntry,
          activateTabByPath,
          setReconnectingRemoteWorkspaceKeys,
          loadCredential: services.credentialService.load,
          connectRemoteWorkspaceTarget,
          resolveRemoteWorkspaceCanonicalPath,
          disposeRemoteWorkspaceSession: handleCancelRemoteProject,
          bindRemoteWorkspaceSessionContext,
          bindRemoteWorkspacePath,
          bindRemoteWorkspaceIdentity,
          upsertWorkspaceTab,
          commitRemoteWorkspaceSessionMutation,
          getRemoteSessions: () => remoteWorkspaceSessionsRef.current,
          logger,
          toast,
          shouldKeepReconnectedWorkspace: ({ workspacePath, workspaceIdentity }) =>
            shouldKeepRemoteWorkspaceInTabs({
              tabStoreApi,
              workspacePath,
              workspaceIdentity,
            }),
          onWorkspaceActivated: (target) => {
            logger.debug(
              "[Root] remote workspace ready, committing tab and draft activation",
              target,
            );
            onWorkspaceActivated?.(target);
          },
          options: {
            ...options,
            requestId,
          },
        });
        return true;
      } finally {
        inflightReconnectWorkspaceKeysRef.current.delete(workspaceKey);
        if (pendingReconnectRequestIdsRef.current.get(workspaceKey) === requestId) {
          pendingReconnectRequestIdsRef.current.delete(workspaceKey);
        }
      }
    },
    [
      activateTabByPath,
      bindRemoteWorkspaceSessionContext,
      commitRemoteWorkspaceSessionMutation,
      connectRemoteWorkspaceTarget,
      handleCancelRemoteProject,
      onWorkspaceActivated,
      resolveRemoteWorkspaceCanonicalPath,
      resetLogsForWorkspaceKey,
      services.credentialService,
      tabStoreApi,
    ],
  );

  const runReconnectRemoteWorkspace = useCallback(
    async (
      sessionEntry: RemoteWorkspaceSessionEntry,
      options?: ReconnectRemoteWorkspaceOptions,
    ) => {
      const reconnectGroup = collectSshReconnectGroup({
        selected: sessionEntry,
        sessions: remoteWorkspaceSessionsRef.current,
        tabs: tabStoreApi.getState().tabs,
      });
      await reconnectRemoteWorkspaceGroup({
        selected: sessionEntry,
        reconnectGroup,
        reconnectEntry: runReconnectRemoteWorkspaceEntry,
        options,
      });
    },
    [runReconnectRemoteWorkspaceEntry, tabStoreApi],
  );

  useEffect(() => {
    // It turns out that the automatic reconnection effect is started here.
    // Deleting the effect itself will move all subsequent RootInner hooks mounted in Fast Refresh forward.
    // After the old effect slot is reused by useCallback, it is easy to trigger React hook queue misalignment.
    // This empty effect only retains the hook slot; starting recovery will still only generate disconnected tabs and will not initiate a remote connection.
    const preserveRemoteStartupReconnectEffectSlot = true;
    void preserveRemoteStartupReconnectEffectSlot;
  }, []);

  const restorePersistedSession = useCallback(
    async (settings: AppSettings) => {
      const persistedRemoteSessions = getRemoteWorkspaceSessionEntries(settings);
      setRemoteWorkspaceSessions(persistedRemoteSessions);
      remoteWorkspaceSessionsRef.current = persistedRemoteSessions;
      let conversationWorkspacePath: string | undefined;
      if (ensureConversationWorkspaceOnRestore) {
        try {
          conversationWorkspacePath = (await services.fileService.ensureConversationWorkspace())
            .path;
        } catch (error) {
          // If the path creation fails, the real project cannot be recovered; subsequent explicit new dialogs will still use the original retryable error entry.
          logger.warn("[Root] failed to resolve the conversation workspace during restore", {
            error,
          });
        }
      }
      // When starting to restore the remote workspace, only the disconnected tabs in the task list will be restored.
      // Before and after this, there are background effects that automatically initiate SSH/WSL reconnection. Users just opening the application to view the task list will also trigger remote connections and runtime uploads.
      // Now the reconnection entrance is closed until the user clicks "Reconnect" or actively opens it from the remote history to avoid hidden side effects during the startup phase.
      // Web normal mode will also set allowRemoteWorkspaceRestore to false: the remote snapshot in the setting will be retained, but the tab will not be restored/the entry will not be displayed.
      const workspaceRestore = restorePersistedRemoteWorkspaceSessions({
        settings,
        tabStoreApi,
        allowRemoteWorkspaceRestore,
        unavailableWorkspacePath,
        conversationWorkspacePath,
        restoreMode: deferInactiveWorkspaceRestore ? "active-first" : "all",
      });
      return {
        ...(conversationWorkspacePath
          ? { excludedRecentProjectPaths: [conversationWorkspacePath] }
          : {}),
        ...(workspaceRestore?.deferredRestore
          ? { deferredRestore: workspaceRestore.deferredRestore }
          : {}),
      };
    },
    [
      allowRemoteWorkspaceRestore,
      deferInactiveWorkspaceRestore,
      ensureConversationWorkspaceOnRestore,
      services.fileService,
      tabStoreApi,
      unavailableWorkspacePath,
    ],
  );

  const handleSelectRemoteProject = useCallback(
    async (sessionId: string, path: string, localWorkspacePath?: string) => {
      try {
        await selectRemoteWorkspaceProjectFromDialog({
          canUseRemoteWorkspace,
          sessionId,
          path,
          localWorkspacePath,
          loadingMessage: intl.formatMessage({ id: "common.loading" }),
          getRemoteWorkspaceSession,
          connectionTarget: pendingConnectionTargetsBySessionIdRef.current.get(sessionId),
          getWorkspaceTabs: () => tabStoreApi.getState().tabs,
          resolveRemoteWorkspaceCanonicalPath,
          activateTabByPath,
          handleCancelRemoteProject,
          bindRemoteWorkspaceSessionContext,
          commitRemoteWorkspaceSessionMutation,
          getRemoteSessions: () => remoteWorkspaceSessionsRef.current,
          bindRemoteWorkspacePath,
          bindRemoteWorkspaceIdentity,
          addTab,
          onWorkspaceActivated,
          refreshPinnedTasks: refreshRemotePinnedTasksForSession,
          refreshTimelineTasks: refreshRemoteTimelineTasksForSession,
        });
      } finally {
        pendingConnectionTargetsBySessionIdRef.current.delete(sessionId);
      }
    },
    [
      activateTabByPath,
      addTab,
      bindRemoteWorkspaceSessionContext,
      tabStoreApi,
      commitRemoteWorkspaceSessionMutation,
      handleCancelRemoteProject,
      intl,
      onWorkspaceActivated,
      resolveRemoteWorkspaceCanonicalPath,
      canUseRemoteWorkspace,
    ],
  );

  const handleConnectRemote = useCallback(
    async (
      options: Parameters<IPlatformService["connectRemote"]>[0],
      requestId?: string,
      context?: Parameters<IPlatformService["connectRemote"]>[2],
    ) => {
      if (!canUseRemoteWorkspace) {
        throw new Error("Remote workspace is disabled in this mode");
      }

      return connectRemoteWorkspaceTarget(options, requestId, context);
    },
    [canUseRemoteWorkspace, connectRemoteWorkspaceTarget],
  );

  const handleReconnectRemoteWorkspace = useCallback(
    async (workspaceKey: string, options?: ReconnectRemoteWorkspaceOptions) => {
      await reconnectRemoteWorkspaceByKey({
        workspaceKey,
        canUseRemoteWorkspace,
        getRemoteSessions: () => remoteWorkspaceSessionsRef.current,
        runReconnectRemoteWorkspace,
        options: {
          activateWorkspaceAfterReconnect: true,
          showErrorToast: true,
          throwOnFailure: false,
          ...options,
        },
      });
    },
    [canUseRemoteWorkspace, runReconnectRemoteWorkspace],
  );

  const handleOpenRemoteWorkspaceFromHistory = useCallback(
    async (workspaceKey: string) => {
      if (!canUseRemoteWorkspace) {
        return;
      }

      // Both remote history entry and sidebar reconnection may hit the "removed by user during reconnection" race condition.
      // A unified entry is drawn here to ensure that the two paths share the same concurrency protection, preservation verification, and error handling semantics.
      await openRemoteWorkspaceFromHistoryEntry({
        workspaceKey,
        tabStoreApi,
        getRemoteSessions: () => remoteWorkspaceSessionsRef.current,
        inflightReconnectWorkspaceKeys: inflightReconnectWorkspaceKeysRef.current,
        activateTabByPath,
        setReconnectingRemoteWorkspaceKeys,
        loadCredential: services.credentialService.load,
        connectRemoteWorkspaceTarget,
        resolveRemoteWorkspaceCanonicalPath,
        disposeRemoteWorkspaceSession: handleCancelRemoteProject,
        bindRemoteWorkspaceSessionContext,
        addTab,
        commitRemoteWorkspaceSessionMutation,
        createReconnectRequestId: createUuid,
        pendingReconnectRequestIds: pendingReconnectRequestIdsRef.current,
        resetLogsForWorkspaceKey,
        onWorkspaceActivated,
      });
    },
    [
      activateTabByPath,
      addTab,
      bindRemoteWorkspaceSessionContext,
      commitRemoteWorkspaceSessionMutation,
      connectRemoteWorkspaceTarget,
      handleCancelRemoteProject,
      resolveRemoteWorkspaceCanonicalPath,
      resetLogsForWorkspaceKey,
      onWorkspaceActivated,
      services.credentialService,
      tabStoreApi,
      canUseRemoteWorkspace,
    ],
  );

  const handleRemoteWorkspaceSessionClosed = useCallback(
    async (event: RemoteSessionClosedEvent) => {
      const sessionId = event.sessionId.trim();
      if (!sessionId) {
        return;
      }

      const matchedTabs = tabStoreApi
        .getState()
        .tabs.filter(
          (tab): tab is import("@/store/tabStore.js").WorkspaceTabState =>
            isWorkspaceTab(tab) && tab.remoteSessionId === sessionId,
        );
      if (matchedTabs.length === 0) {
        unregisterRemoteWorkspaceSession(sessionId);
        return;
      }

      // After the remote host exits, the remoteSessionId on the tab will not be cleared.
      // The UI therefore continues to display "Connected" and continues to route requests to the expired session.
      // Here, when receiving the session-close event of the main process, it is immediately downgraded to the disconnected state, and the user will only need to manually reconnect in the future.
      tabStoreApi.setState((state) => ({
        tabs: state.tabs.map((tab) =>
          isWorkspaceTab(tab) && tab.remoteSessionId === sessionId
            ? { ...tab, remoteSessionId: undefined }
            : tab,
        ),
      }));
      unregisterRemoteWorkspaceSession(sessionId);

      const matchedWorkspaceKeys = [
        ...new Set(matchedTabs.map((tab) => buildWorkspaceSessionKey(tab))),
      ];
      const reason = [
        "Remote connection was disconnected",
        event.exitCode != null ? `exitCode=${event.exitCode}` : null,
        event.signal ? `signal=${event.signal}` : null,
      ]
        .filter(Boolean)
        .join(" ");
      const zcodeSessionStore = useZCodeSessionStore.getState();
      const failedTaskCount = markRemoteWorkspaceRunningTasksFailed({
        tabs: matchedTabs,
        getWorkspaceState: zcodeSessionStore.getWorkspaceState,
        setTaskRuntimeState: zcodeSessionStore.setTaskRuntimeState,
        reason,
      });

      logger.warn("[Root] remote workspace session closed", {
        sessionId,
        reason: event.reason,
        exitCode: event.exitCode,
        signal: event.signal,
        matchedWorkspaceKeys,
        failedTaskCount,
      });

      for (const workspaceKey of matchedWorkspaceKeys) {
        const sessionEntry = remoteWorkspaceSessionsRef.current.find(
          (entry) => buildWorkspaceSessionKey(entry) === workspaceKey,
        );
        if (!sessionEntry) {
          continue;
        }

        const pendingReconnectRequestId = pendingReconnectRequestIdsRef.current.get(workspaceKey);
        if (
          !shouldPersistRemoteWorkspaceFailure({
            pendingReconnectRequestIds: pendingReconnectRequestIdsRef.current,
            sessionEntry,
            workspaceKey,
          })
        ) {
          logger.info(
            "[Root] skipping failure persistence on WSL workspace session close, waiting for the reconnect result",
            {
              pendingReconnectRequestId,
              sessionId,
              workspaceIdentity: sessionEntry.workspaceIdentity ?? null,
              workspacePath: sessionEntry.workspacePath,
              workspaceKey,
            },
          );
          continue;
        }

        await commitRemoteWorkspaceSessionMutation(
          buildRemoteWorkspaceSessionMutation({
            remoteSessions: remoteWorkspaceSessionsRef.current,
            workspacePath: sessionEntry.workspacePath,
            workspaceIdentity: sessionEntry.workspaceIdentity,
            target: createRemoteTargetFromSnapshot(sessionEntry.target, {
              password: null,
              privateKeyPassphrase: null,
            }),
            lastConnectionStatus: "failed",
            lastConnectionError: reason,
            touchOpenedAt: false,
          }),
        );
      }
    },
    [commitRemoteWorkspaceSessionMutation, tabStoreApi],
  );

  const handleBotRemoteWorkspaceReconnected = useCallback(
    async (event: BotRemoteWorkspaceReconnectedEvent) => {
      if (!canUseRemoteWorkspace) {
        return;
      }

      const sessionId = event.sessionId.trim();
      if (!sessionId) {
        return;
      }

      try {
        await waitForRemoteWorkspaceSessionReady(sessionId);
        const remoteSession = getRemoteWorkspaceSession(sessionId);
        if (!remoteSession) {
          throw new Error(`Remote workspace session does not exist: ${sessionId}`);
        }
        if (!remoteSession.target) {
          // Bugfix: Bot reconnection event comes from main/host and must have a persistent target.
          // The bridging session of Web relay has no target and cannot enter the remote history reconnection branch.
          throw new Error(`Remote workspace session is missing a connection target: ${sessionId}`);
        }

        const resolvedWorkspacePath = await resolveRemoteWorkspaceCanonicalPath(
          sessionId,
          event.workspacePath,
        );
        const resolvedWorkspaceIdentity = resolveBotRemoteWorkspaceReconnectedIdentity({
          event,
          resolvedWorkspacePath,
          target: remoteSession.target,
        });

        bindRemoteWorkspacePath(resolvedWorkspacePath, sessionId);
        bindRemoteWorkspaceIdentity(resolvedWorkspaceIdentity, sessionId);
        // Bugfix: The remote reconnection triggered by Bot occurs in main/host and will not go through the React process of manual reconnection in the sidebar.
        // After receiving the success event of main, the created session is bound back to the tab and remote history, and the UI will change from "not connected" to "connected".
        tabStoreApi.getState().ensureWorkspaceTab(resolvedWorkspacePath, {
          remoteSessionId: sessionId,
          remoteTarget: remoteSession.target,
          workspaceIdentity: resolvedWorkspaceIdentity,
        });
        await commitRemoteWorkspaceSessionMutation(
          buildRemoteWorkspaceSessionMutation({
            remoteSessions: remoteWorkspaceSessionsRef.current,
            workspacePath: resolvedWorkspacePath,
            workspaceIdentity: resolvedWorkspaceIdentity,
            target: remoteSession.target,
            lastConnectionStatus: "connected",
            touchOpenedAt: true,
          }),
        );
        await Promise.all([
          refreshRemotePinnedTasksForSession({
            sessionId,
            workspacePath: resolvedWorkspacePath,
            workspaceIdentity: resolvedWorkspaceIdentity,
          }),
          refreshRemoteTimelineTasksForSession({
            sessionId,
            workspacePath: resolvedWorkspacePath,
            workspaceIdentity: resolvedWorkspaceIdentity,
          }),
        ]);
      } catch (error) {
        logger.warn("[Root] failed to sync UI state after the Bot remote workspace reconnected", {
          sessionId,
          workspacePath: event.workspacePath,
          workspaceIdentity: event.workspaceIdentity,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
    [
      canUseRemoteWorkspace,
      commitRemoteWorkspaceSessionMutation,
      resolveRemoteWorkspaceCanonicalPath,
      tabStoreApi,
      waitForRemoteWorkspaceSessionReady,
    ],
  );

  useEffect(() => {
    return platform.onRemoteSessionClosed((event) => {
      void handleRemoteWorkspaceSessionClosed(event);
    });
  }, [handleRemoteWorkspaceSessionClosed, platform]);

  useEffect(() => {
    return platform.onBotRemoteWorkspaceReconnected((event) => {
      void handleBotRemoteWorkspaceReconnected(event);
    });
  }, [handleBotRemoteWorkspaceReconnected, platform]);

  const handleRemoteWorkspaceTabsClosed = useCallback(
    (workspaceKeys: string[]) => {
      if (workspaceKeys.length === 0) {
        return;
      }

      const workspaceKeySet = new Set(workspaceKeys);

      void (async () => {
        // When closing the disconnected remote tab, there is no remoteSessionId on the tab, but the main process may already be uploading the remote runtime.
        // Here, the reconnection requestId is used to accurately cancel the pending host to prevent the background upload from continuing to run even after the UI has been removed.
        await cancelPendingRemoteReconnectsForWorkspaceKeys({
          workspaceKeys,
          pendingRequestIds: pendingReconnectRequestIdsRef.current,
          cancelPendingRemoteConnection: platform.cancelPendingRemoteConnection
            ? (requestId) =>
                platform.cancelPendingRemoteConnection?.(requestId) ?? Promise.resolve()
            : undefined,
          logger,
        });
        setReconnectingRemoteWorkspaceKeys((currentKeys) =>
          currentKeys.filter((key) => !workspaceKeySet.has(key)),
        );

        const removal = removeRemoteWorkspaceSessionEntries(
          remoteWorkspaceSessionsRef.current,
          workspaceKeys,
        );
        if (
          removal.nextRemoteSessions.length === remoteWorkspaceSessionsRef.current.length &&
          removal.credentialKeysToDelete.length === 0
        ) {
          return;
        }

        // After the user "removes" the remote workspace in the sidebar, just deleting the tab is not enough:
        // remoteWorkspaceSessionsRef is still merged back into setting.json by the persistence patch,
        // Therefore, the same disconnected item will be restored next time it is started. Here explicit removal is treated as deleting the remote history,
        // At the same time, clear the historical exclusive SSH credentials to avoid leaving unreachable credential keys.
        await syncPersistedWorkspaceSession(removal.nextRemoteSessions);
        for (const credentialKey of removal.credentialKeysToDelete) {
          try {
            await services.credentialService.delete(credentialKey);
          } catch (error) {
            logger.warn("[Root] failed to delete the credential of the removed remote workspace", {
              credentialKey,
              error,
            });
          }
        }
      })();
    },
    [platform, services.credentialService, syncPersistedWorkspaceSession],
  );

  const remoteWorkspaceErrorByWorkspaceKey = useMemo(
    () =>
      Object.fromEntries(
        remoteWorkspaceSessions.flatMap((entry) =>
          entry.lastConnectionError?.trim()
            ? [[buildWorkspaceSessionKey(entry), entry.lastConnectionError] as const]
            : [],
        ),
      ),
    [remoteWorkspaceSessions],
  );

  return {
    remoteWorkspaceSessions,
    reconnectingRemoteWorkspaceKeys,
    remoteWorkspaceErrorByWorkspaceKey,
    reconnectingRemoteWorkspaceLogsByWorkspaceKey,
    buildPersistedTabPatch,
    restorePersistedSession,
    handleCancelRemoteProject,
    handleSelectRemoteProject,
    handleConnectRemote,
    handleReconnectRemoteWorkspace,
    handleOpenRemoteWorkspaceFromHistory,
    handleRemoteWorkspaceTabsClosed,
  };
}
