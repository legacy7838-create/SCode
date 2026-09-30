import type { Dispatch, SetStateAction } from "react";
import type { IPlatformService, RemoteWorkspaceSessionEntry } from "@zcode/shared";
import { stripRemoteTargetSecrets } from "@zcode/shared";
import type { IServiceAccessor } from "@zcode/services";
import { toast } from "@/components/ui/toast.js";
import {
  buildRemoteWorkspaceSessionMutation,
  buildRemoteWorkspaceIdentity,
  createRemoteTargetFromSnapshot,
  resolveRemoteWorkspaceSessionIdentity,
} from "@/lib/remoteWorkspaceHistory.js";
import { logger } from "@/logger.js";
import {
  bindRemoteWorkspaceIdentity,
  bindRemoteWorkspacePath,
} from "@/store/remoteWorkspaceSessionStore.js";
import { refreshRemotePinnedTasksForSession } from "@/store/remotePinnedTaskStore.js";
import { refreshRemoteTimelineTasksForSession } from "@/store/remoteTimelineTaskStore.js";

/**
 * Binds the canonical workspacePath/workspaceIdentity finally settled by the UI back to the logical
 * session in main/host.
 */
export type BindRemoteWorkspaceSessionContextFn = (params: {
  sessionId: string;
  workspacePath: string;
  workspaceIdentity: string;
}) => Promise<void>;

type ManualReconnectRemoteWorkspaceParams = {
  sessionEntry: RemoteWorkspaceSessionEntry;
  activateTabByPath: (workspacePath: string, options?: { workspaceIdentity?: string }) => boolean;
  setReconnectingRemoteWorkspaceKeys: Dispatch<SetStateAction<string[]>>;
  loadCredential: IServiceAccessor["credentialService"]["load"];
  connectRemoteWorkspaceTarget: (
    target: Parameters<IPlatformService["connectRemote"]>[0],
    requestId?: string,
    context?: Parameters<IPlatformService["connectRemote"]>[2],
  ) => Promise<string>;
  resolveRemoteWorkspaceCanonicalPath: (
    sessionId: string,
    workspacePath: string,
  ) => Promise<string>;
  disposeRemoteWorkspaceSession: (sessionId: string) => Promise<void>;
  bindRemoteWorkspaceSessionContext: BindRemoteWorkspaceSessionContextFn;
  bindRemoteWorkspacePath: typeof bindRemoteWorkspacePath;
  bindRemoteWorkspaceIdentity: typeof bindRemoteWorkspaceIdentity;
  upsertWorkspaceTab: (
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
  getRemoteSessions: () => RemoteWorkspaceSessionEntry[];
  logger: Pick<typeof logger, "warn">;
  toast: typeof toast;
  shouldKeepReconnectedWorkspace?: (
    context: Pick<RemoteWorkspaceSessionEntry, "workspacePath" | "workspaceIdentity">,
  ) => boolean;
  onWorkspaceActivated?: (target: { workspacePath: string; workspaceIdentity: string }) => void;
  options?: ReconnectRemoteWorkspaceOptions;
};

export interface SshReconnectCredentials {
  password: string | null;
  privateKeyPassphrase: string | null;
}

export interface ReconnectRemoteWorkspaceOptions {
  activateWorkspaceAfterReconnect?: boolean;
  showErrorToast?: boolean;
  requestId?: string;
  throwOnFailure?: boolean;
  /**
   * After the shared Host is ready, siblings attach by reusing the initiator's credentials; reading
   * their own stored credentials again is forbidden.
   */
  sshCredentialsOverride?: SshReconnectCredentials;
  /**
   * logical connect has returned, which means the shared SSH Host is ready; workspace
   * initialization may still proceed or fail.
   */
  onSshHostReady?: (credentials: SshReconnectCredentials) => void;
}

export async function reconnectRemoteWorkspaceHistoryEntry({
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
  upsertWorkspaceTab,
  commitRemoteWorkspaceSessionMutation,
  getRemoteSessions,
  logger,
  toast,
  shouldKeepReconnectedWorkspace,
  onWorkspaceActivated,
  options,
}: ManualReconnectRemoteWorkspaceParams): Promise<void> {
  const activateWorkspaceAfterReconnect = options?.activateWorkspaceAfterReconnect ?? true;
  const showErrorToast = options?.showErrorToast ?? true;
  const fallbackWorkspaceIdentity = resolveRemoteWorkspaceSessionIdentity(sessionEntry);
  const reconnectWorkspaceKey = fallbackWorkspaceIdentity?.trim() || sessionEntry.workspacePath;

  setReconnectingRemoteWorkspaceKeys((currentKeys) =>
    currentKeys.includes(reconnectWorkspaceKey)
      ? currentKeys
      : [...currentKeys, reconnectWorkspaceKey],
  );

  let reconnectTarget = createRemoteTargetFromSnapshot(sessionEntry.target, {
    password: null,
    privateKeyPassphrase: null,
  });
  let resolvedWorkspacePath = sessionEntry.workspacePath;
  let resolvedWorkspaceIdentity = fallbackWorkspaceIdentity;
  try {
    const sshCredentials = options?.sshCredentialsOverride ?? {
      password:
        sessionEntry.target.kind === "ssh" && sessionEntry.target.passwordCredentialKey
          ? await loadCredential(sessionEntry.target.passwordCredentialKey)
          : null,
      privateKeyPassphrase:
        sessionEntry.target.kind === "ssh" && sessionEntry.target.privateKeyPassphraseCredentialKey
          ? await loadCredential(sessionEntry.target.privateKeyPassphraseCredentialKey)
          : null,
    };
    reconnectTarget = createRemoteTargetFromSnapshot(sessionEntry.target, sshCredentials);
    const sessionId = await connectRemoteWorkspaceTarget(reconnectTarget, options?.requestId, {
      workspacePath: sessionEntry.workspacePath,
      workspaceIdentity: fallbackWorkspaceIdentity,
      connectTrigger: "reconnect",
    });
    if (reconnectTarget.kind === "ssh") {
      // Workspace initialization such as Host ready and provider/task must be notified in stages.
      // Sibling can reuse the initiator credential to create attachments from now on, without waiting or re-reading the credential.
      options?.onSshHostReady?.(sshCredentials);
    }
    resolvedWorkspacePath = await resolveRemoteWorkspaceCanonicalPath(
      sessionId,
      sessionEntry.workspacePath,
    );
    resolvedWorkspaceIdentity = buildRemoteWorkspaceIdentity(
      resolvedWorkspacePath,
      reconnectTarget,
    );

    if (
      resolvedWorkspacePath !== sessionEntry.workspacePath ||
      resolvedWorkspaceIdentity !== fallbackWorkspaceIdentity
    ) {
      // connect only carries the path/identity in the history record, and the logical session descriptor of main also stops at this set of values;
      // If the results of realpath normalization are different, tab will use the new value and descriptor will still be the old value.
      // When the mobile phone remote control bridge compares the descriptor with the path/identity of the tab, it will be rejected by REMOTE_WORKSPACE_IDENTITY_MISMATCH.
      // Binding failure indicates that the session and tab cannot be aligned: the session is recycled and the failure library is exited, leaving no semi-connected workspace.
      // This time await must be placed before the reserved verification below: there can be no asynchronous gap between the verification and upsertWorkspaceTab.
      // Otherwise, if the user removes the tab while bind is waiting for ready ACK, the verification result has expired, and the workspace will be added back.
      try {
        await bindRemoteWorkspaceSessionContext({
          sessionId,
          workspacePath: resolvedWorkspacePath,
          workspaceIdentity: resolvedWorkspaceIdentity,
        });
      } catch (error) {
        await disposeRemoteWorkspaceSession(sessionId);
        throw error;
      }
    }

    // During the manual reconnection process, the user may click Reconnect and then immediately remove the remote tab.
    // If the retention verification is not performed again before the database is successfully dropped, the workspace just removed by the user will be added back.
    if (
      shouldKeepReconnectedWorkspace &&
      !shouldKeepReconnectedWorkspace({
        workspacePath: resolvedWorkspacePath,
        workspaceIdentity: resolvedWorkspaceIdentity,
      })
    ) {
      logger.warn(
        "[Root] remote workspace was removed during reconnect, skipping restore and disposing session",
        {
          workspacePath: resolvedWorkspacePath,
        },
      );
      await disposeRemoteWorkspaceSession(sessionId);
      return;
    }
    bindRemoteWorkspacePath(resolvedWorkspacePath, sessionId);
    bindRemoteWorkspaceIdentity(resolvedWorkspaceIdentity, sessionId);
    upsertWorkspaceTab(resolvedWorkspacePath, {
      remoteSessionId: sessionId,
      remoteTarget: stripRemoteTargetSecrets(reconnectTarget),
      workspaceIdentity: resolvedWorkspaceIdentity,
      localWorkspacePath: sessionEntry.localWorkspacePath,
    });
    if (activateWorkspaceAfterReconnect) {
      // In the past, sidebar reconnection would first activate the disconnected tab with only identity and no remoteSessionId.
      // The conversation provider returned null due to remote-waiting, resulting in a black screen on the right side during the connection.
      // You must first bind services and silently backfill the tab's session metadata, and then activate the tab and draft at once.
      const activated = activateTabByPath(resolvedWorkspacePath, {
        workspaceIdentity: resolvedWorkspaceIdentity,
      });
      if (activated) {
        onWorkspaceActivated?.({
          workspacePath: resolvedWorkspacePath,
          workspaceIdentity: resolvedWorkspaceIdentity,
        });
      }
    }
    await commitRemoteWorkspaceSessionMutation(
      buildRemoteWorkspaceSessionMutation({
        remoteSessions: getRemoteSessions(),
        workspacePath: resolvedWorkspacePath,
        localWorkspacePath: sessionEntry.localWorkspacePath,
        workspaceIdentity: resolvedWorkspaceIdentity,
        target: reconnectTarget,
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
    const message = error instanceof Error ? error.message : String(error);
    logger.warn("[Root] failed to manually reconnect remote workspace", {
      workspacePath: resolvedWorkspacePath,
      error: message,
    });
    await commitRemoteWorkspaceSessionMutation(
      buildRemoteWorkspaceSessionMutation({
        remoteSessions: getRemoteSessions(),
        workspacePath: resolvedWorkspacePath,
        workspaceIdentity: resolvedWorkspaceIdentity,
        target: reconnectTarget,
        lastConnectionStatus: "failed",
        lastConnectionError: message,
        touchOpenedAt: false,
      }),
    );
    if (showErrorToast) {
      toast(message);
    }
    if (options?.throwOnFailure) {
      // The reconnect button on the desktop needs to swallow exceptions and provide feedback through toast/status drop.
      // However, web remote control on the mobile phone uses RPC semantics, and the failure must be clearly returned to the mobile phone.
      throw error;
    }
  } finally {
    setReconnectingRemoteWorkspaceKeys((currentKeys) =>
      currentKeys.filter((key) => key !== reconnectWorkspaceKey),
    );
  }
}
