import { randomUUID } from "node:crypto";
import {
  HostResponseTypes,
  hostBotRemoteWorkspaceConnectionStatusResultMessageSchema,
  hostBotRemoteWorkspaceRuntimePortMessageSchema,
  hostBotRemoteWorkspaceReconnectResultMessageSchema,
  type RemoteTarget,
} from "@zcode/shared";
import { type IZCodeTaskService as IZCodeTaskServiceShape } from "../session/zcodeTaskService.js";
import type { ICredentialService } from "../credential/credential.js";
import type { ISettingService } from "../setting/setting.js";
import { type ZCodeAgentAppRuntimePreferences } from "../zcode-agent/zcodeAgent.js";
import {
  createRemoteRuntimeServicesFromPort,
  type RemoteBotWorkspaceRuntimeServices,
} from "#src/bots/botRemoteRuntimeServices.js";

interface ParentPortLike {
  postMessage(message: unknown, transfer?: unknown[]): void;
  on(event: "message", listener: (event: ParentPortMessageEvent) => void): void;
  off?(event: "message", listener: (event: ParentPortMessageEvent) => void): void;
}

interface ParentPortMessageEvent {
  data: unknown;
  ports?: unknown[];
}

export function createBotRemoteWorkspaceService(params: {
  parentPort?: ParentPortLike | null;
  settingService: ISettingService;
  credentialService: ICredentialService;
}) {
  const parentPort = params.parentPort;
  if (!parentPort) {
    return undefined;
  }
  const activeParentPort = parentPort;
  const connectedWorkspaceKeys = new Set<string>();
  const pending = new Map<
    string,
    (result: { ok: boolean; sessionId?: string; error?: string }) => void
  >();
  const pendingRuntimePorts = new Map<
    string,
    (result: { ok: boolean; port?: unknown; error?: string }) => void
  >();
  const pendingConnectionStatus = new Map<
    string,
    (result: { ok: boolean; connected?: boolean; error?: string }) => void
  >();
  const runtimeServicesByWorkspaceKey = new Map<string, RemoteBotWorkspaceRuntimeServices>();
  let latestAppRuntimePreferences: ZCodeAgentAppRuntimePreferences | undefined;
  let appRuntimePreferencesRevision = 0;
  const onMessage = (event: ParentPortMessageEvent) => {
    const result = hostBotRemoteWorkspaceReconnectResultMessageSchema.safeParse(event.data);
    if (result.success) {
      const { requestId } = result.data;
      const resolve = pending.get(requestId);
      if (!resolve) {
        return;
      }
      pending.delete(requestId);
      resolve({
        ok: result.data.ok,
        sessionId: result.data.sessionId,
        error: result.data.error,
      });
      return;
    }

    const connectionStatusResult =
      hostBotRemoteWorkspaceConnectionStatusResultMessageSchema.safeParse(event.data);
    if (connectionStatusResult.success) {
      const { requestId } = connectionStatusResult.data;
      const resolve = pendingConnectionStatus.get(requestId);
      if (!resolve) {
        return;
      }
      pendingConnectionStatus.delete(requestId);
      resolve({
        ok: connectionStatusResult.data.ok,
        connected: connectionStatusResult.data.connected,
        error: connectionStatusResult.data.error,
      });
      return;
    }

    const runtimePortResult = hostBotRemoteWorkspaceRuntimePortMessageSchema.safeParse(event.data);
    if (!runtimePortResult.success) {
      return;
    }
    const { requestId } = runtimePortResult.data;
    const resolve = pendingRuntimePorts.get(requestId);
    if (!resolve) {
      return;
    }
    pendingRuntimePorts.delete(requestId);
    resolve({
      ok: runtimePortResult.data.ok,
      port: event.ports?.[0],
      error: runtimePortResult.data.error,
    });
  };
  activeParentPort.on("message", onMessage);

  async function buildRemoteTargetForWorkspace(target: {
    workspacePath: string;
    workspaceIdentity: string;
  }): Promise<RemoteTarget | null> {
    const settings = await params.settingService.get();
    const workspaceIdentity = target.workspaceIdentity.trim();
    const remoteSessions = (settings.lastWorkspaceSession ?? []).filter(
      (item) => item.kind === "remote",
    );
    const entry =
      // Bugfix: After UI connects, workspacePath may be normalized to realpath, but bot context still retains the old path.
      // Remote identity isolation semantics are based on workspaceIdentity; connection info lookup must first match by identity.
      remoteSessions.find((item) => item.workspaceIdentity === workspaceIdentity) ??
      remoteSessions.find(
        (item) =>
          item.workspacePath === target.workspacePath &&
          item.workspaceIdentity === workspaceIdentity,
      );
    if (!entry || entry.kind !== "remote") {
      return null;
    }
    if (entry.target.kind !== "ssh") {
      return entry.target;
    }
    return {
      kind: "ssh",
      host: entry.target.host,
      port: entry.target.port,
      username: entry.target.username,
      privateKeyPath: entry.target.privateKeyPath,
      password: entry.target.passwordCredentialKey
        ? ((await params.credentialService.load(entry.target.passwordCredentialKey)) ?? undefined)
        : undefined,
      privateKeyPassphrase: entry.target.privateKeyPassphraseCredentialKey
        ? ((await params.credentialService.load(entry.target.privateKeyPassphraseCredentialKey)) ??
          undefined)
        : undefined,
    };
  }

  async function queryMainConnectionStatus(target: {
    workspacePath: string;
    workspaceIdentity: string;
    remoteTarget: RemoteTarget;
  }): Promise<boolean | null> {
    const requestId = `bot-status-${randomUUID()}`;
    const result = await new Promise<{
      ok: boolean;
      connected?: boolean;
      error?: string;
    }>((resolve) => {
      pendingConnectionStatus.set(requestId, resolve);
      activeParentPort.postMessage({
        type: HostResponseTypes.BotRemoteWorkspaceConnectionStatusRequest,
        requestId,
        workspacePath: target.workspacePath,
        workspaceIdentity: target.workspaceIdentity,
        target: target.remoteTarget,
      });
      setTimeout(() => {
        if (pendingConnectionStatus.delete(requestId)) {
          resolve({ ok: false, error: "timed out querying remote workspace connection status." });
        }
      }, 5_000);
    });
    return result.ok ? result.connected === true : null;
  }

  return {
    async isConnected(target: {
      workspacePath: string;
      workspaceIdentity: string;
    }): Promise<boolean> {
      const workspaceKey = target.workspaceIdentity.trim() || target.workspacePath;
      const remoteTarget = await buildRemoteTargetForWorkspace(target);
      if (!remoteTarget) {
        connectedWorkspaceKeys.delete(workspaceKey);
        return false;
      }

      // Bugfix: UI manual reconnection does not go through the bot's /reconnect; relying solely on a local Set would misjudge as disconnected.
      // Each time querying main's live session table, also clean up stale bot markers after remote disconnection.
      const connected = await queryMainConnectionStatus({
        ...target,
        remoteTarget,
      });
      if (connected !== null) {
        if (connected) {
          connectedWorkspaceKeys.add(workspaceKey);
        } else {
          connectedWorkspaceKeys.delete(workspaceKey);
        }
        return connected;
      }

      return connectedWorkspaceKeys.has(workspaceKey);
    },
    async ensureConnected(target: {
      workspacePath: string;
      workspaceIdentity: string;
    }): Promise<{ ok: boolean; message?: string }> {
      const remoteTarget = await buildRemoteTargetForWorkspace(target);
      if (!remoteTarget) {
        return {
          ok: false,
          message: "no connection info found for that remote workspace.",
        };
      }
      const requestId = `bot-reconnect-${randomUUID()}`;
      const result = await new Promise<{
        ok: boolean;
        sessionId?: string;
        error?: string;
      }>((resolve) => {
        pending.set(requestId, resolve);
        activeParentPort.postMessage({
          type: HostResponseTypes.BotRemoteWorkspaceReconnectRequest,
          requestId,
          workspacePath: target.workspacePath,
          workspaceIdentity: target.workspaceIdentity,
          target: remoteTarget,
        });
        setTimeout(() => {
          if (pending.delete(requestId)) {
            resolve({ ok: false, error: "timed out reconnecting the remote workspace." });
          }
        }, 60_000);
      });
      if (result.ok) {
        connectedWorkspaceKeys.add(target.workspaceIdentity.trim() || target.workspacePath);
        return { ok: true };
      }
      return { ok: false, message: result.error ?? "unknown" };
    },
    async getZCodeTaskService(target: {
      workspacePath: string;
      workspaceIdentity: string;
    }): Promise<IZCodeTaskServiceShape | null> {
      return (await getRuntimeServices(target))?.zcodeTaskService ?? null;
    },
    async getModelSelectionService(target: { workspacePath: string; workspaceIdentity: string }) {
      return (await getRuntimeServices(target))?.modelSelectionService ?? null;
    },
    async syncAppRuntimePreferences(preferences: ZCodeAgentAppRuntimePreferences): Promise<void> {
      latestAppRuntimePreferences = preferences;
      appRuntimePreferencesRevision += 1;
      // Fix reason: Remote Bot runtime does not belong to any renderer window, so Root's Agent sync cannot reach it.
      // Here we only update already-cached runtimes to avoid creating new remote Host/Agents for idle Bots when switching settings.
      await Promise.all(
        Array.from(runtimeServicesByWorkspaceKey.values()).map((services) =>
          services.zcodeAgentService.syncAppRuntimePreferences(preferences),
        ),
      );
    },
    dispose(): void {
      // Bugfix: Remove parentPort listener on host dispose to avoid old bot reconnection promises continuing to receive results after window reload.
      activeParentPort.off?.("message", onMessage);
      pending.clear();
      pendingRuntimePorts.clear();
      pendingConnectionStatus.clear();
      runtimeServicesByWorkspaceKey.clear();
      connectedWorkspaceKeys.clear();
    },
  };

  async function getRuntimeServices(target: {
    workspacePath: string;
    workspaceIdentity: string;
  }): Promise<RemoteBotWorkspaceRuntimeServices | null> {
    const workspaceKey = target.workspaceIdentity.trim() || target.workspacePath;
    const cached = runtimeServicesByWorkspaceKey.get(workspaceKey);
    if (cached) {
      return cached;
    }
    const remoteTarget = await buildRemoteTargetForWorkspace(target);
    if (!remoteTarget) {
      return null;
    }
    const requestId = `bot-runtime-${randomUUID()}`;
    const result = await new Promise<{
      ok: boolean;
      port?: unknown;
      error?: string;
    }>((resolve) => {
      pendingRuntimePorts.set(requestId, resolve);
      activeParentPort.postMessage({
        type: HostResponseTypes.BotRemoteWorkspaceRuntimePortRequest,
        requestId,
        workspacePath: target.workspacePath,
        workspaceIdentity: target.workspaceIdentity,
        target: remoteTarget,
      });
      setTimeout(() => {
        if (pendingRuntimePorts.delete(requestId)) {
          resolve({ ok: false, error: "timed out initializing the remote workspace runtime." });
        }
      }, 60_000);
    });
    if (!result.ok || !result.port) {
      throw new Error(result.error ?? "remote workspace runtime failed to initialize.");
    }
    // Bugfix: Bot tasks previously only knew the remote identity but continued calling the local task service.
    // Here we wrap the remote RPC port forwarded by main into a set of runtime services;
    // task wrapper commands go through IZCodeTaskService, and session main state goes through the ZCode session facade.
    const services = createRemoteRuntimeServicesFromPort(result.port);
    // Remote Bot and UI workspace share the same remote Environment. Here we only confirm the remote
    // Model Selection Facade is ready; Desktop no longer injects the full Provider Registry into the remote.
    await services.modelSelectionService.getView();
    while (true) {
      const revision = appRuntimePreferencesRevision;
      const cachedPreferences = latestAppRuntimePreferences;
      const preferences: ZCodeAgentAppRuntimePreferences = cachedPreferences
        ? cachedPreferences
        : await params.settingService.get().then((settings) => ({
            askUserQuestionAutoResolutionEnabled:
              settings.askUserQuestionAutoResolutionEnabled !== false,
            modelIoFullRetentionEnabled: settings.modelIoFullRetentionEnabled === true,
          }));
      await services.zcodeAgentService.syncAppRuntimePreferences(preferences);
      if (revision === appRuntimePreferencesRevision) {
        break;
      }
    }
    // Only cache runtime services after both the remote Registry and App Runtime Preferences are ready.
    runtimeServicesByWorkspaceKey.set(workspaceKey, services);
    return services;
  }
}
