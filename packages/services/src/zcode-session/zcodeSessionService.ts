/* eslint-disable max-lines -- zcodeSessionService aggregates desktop-continuous session operations, the draft lifecycle, and the task index sync boundary; splitting it requires separate design work. */
import type { IZCodeAgentService } from "#src/zcode-agent/zcodeAgent.js";
import type { ZCodeTaskIndexSyncer } from "#src/zcode-agent/zcodeTaskIndexSyncer.js";
import { createServiceLogger } from "#src/logger/serviceLogger.js";
import {
  createSessionTraceId,
  type ZCodeSessionStateSnapshot,
  type ZCodeWorkspaceTaskListChanged,
} from "@zcode/shared";
import type {
  IZCodeSessionService,
  ZCodeSessionCreateParams,
  ZCodeSessionEventsParams,
  ZCodeSessionListParams,
  ZCodeSessionMessagesParams,
  ZCodeSessionReadParams,
  ZCodeSessionReadWorkspacePresentationParams,
  ZCodeSessionResumeParams,
  ZCodeSessionSetModeParams,
  ZCodeSessionSetModelParams,
  ZCodeSessionSetThoughtLevelParams,
  ZCodeTaskTarget,
  ZCodeSessionWorkspaceTarget,
} from "#src/zcode-session/zcodeSession.js";
import { formatModelPickerValue } from "#src/zcode-agent/zcodeConfigOptions.js";
import { createZCodeSessionApiRetryRuntimeTracker } from "#src/zcode-session/zcodeSessionApiRetry.js";
import { appendWorkspaceToFilesystemMcpServers } from "#src/session/mcpWorkspaceScope.js";
import { repairEmptyImportedClaudeSessionSnapshot } from "#src/zcode-session/importedClaudeSessionRepair.js";
import { createZCodeDeferredDraftRegistry } from "#src/zcode-session/zcodeSessionDraftRegistry.js";
import type { CuaProductMcpServerResolver } from "#src/cua-permission-broker/index.js";

const logger = createServiceLogger("zcode-session-service");

interface CreateZCodeSessionServiceOptions {
  agentService: IZCodeAgentService;
  /**
   * Background task index sqlite syncer. Once injected, the syncer is notified whenever a session is
   * created/resumed/sent a prompt or subscribes to events, so it can maintain the shadow subscription and
   * sqlite still converges with the runtime state on the desktop-continuous path; additionally, after
   * every operation that mutates session state it proactively syncs the latest snapshot to sqlite and
   * broadcasts workspace_task_list_changed, so the sidebar list immediately sees the first_input title
   * and the updatedAt ordering refresh.
   */
  taskIndexSyncer?: ZCodeTaskIndexSyncer;
  cuaProductMcpServerResolver?: CuaProductMcpServerResolver;
}

export function createZCodeSessionService({
  agentService,
  taskIndexSyncer,
  cuaProductMcpServerResolver,
}: CreateZCodeSessionServiceOptions): IZCodeSessionService {
  const { withApiRetryRuntime } = createZCodeSessionApiRetryRuntimeTracker();
  const deferredDraftSessions = createZCodeDeferredDraftRegistry();

  function notifySyncer(
    target: ZCodeTaskTarget,
    options?: {
      includeSnapshot?: boolean;
    },
  ): void {
    if (!taskIndexSyncer) {
      return;
    }
    taskIndexSyncer.ensureSessionSubscription(
      {
        workspacePath: target.workspacePath,
        workspaceIdentity: target.workspaceIdentity,
        sessionId: target.sessionId,
      },
      options,
    );
  }

  function getSessionSnapshotDiagnostics(snapshot: ZCodeSessionStateSnapshot) {
    // Log diagnosis cannot assume that test mocks or future partial snapshots must have all messages/pendingRequestIds.
    // The reason is that the business results of readSession have been verified by the agent layer, and only the observation fields are recorded in the service layer; if an error is thrown in the log reading, it will be interrupted in turn.
    // desktop-continuous snapshot recovery. Here we only perform short array statistics on diagnostic values, and do not modify the snapshot body returned to the UI.
    const messages = Array.isArray(snapshot.messages) ? snapshot.messages : [];
    const pendingRequestIds = Array.isArray(snapshot.runtime.pendingRequestIds)
      ? snapshot.runtime.pendingRequestIds
      : [];
    return {
      activeTurnId: snapshot.runtime.activeTurnId ?? null,
      eventSeq: snapshot.runtime.eventSeq,
      messageCount: messages.length,
      pendingRequestCount: pendingRequestIds.length,
      sessionStatus: snapshot.session.status,
      stateRevision: snapshot.runtime.stateRevision,
    };
  }

  function readSnapshotAvailableThoughtLevels(
    snapshot: ZCodeSessionStateSnapshot,
  ): Set<string> | null {
    const thoughtLevel = snapshot.settings.thoughtLevel;
    if (!thoughtLevel.enabled) {
      return new Set();
    }
    const available = Array.isArray(thoughtLevel.available)
      ? (thoughtLevel.available as readonly unknown[])
      : [];
    if (available.length === 0) {
      return null;
    }
    const values = available
      .map((option) => {
        if (typeof option === "string") {
          return option.trim();
        }
        if (typeof option === "object" && option !== null && "value" in option) {
          const value = (option as { value?: unknown }).value;
          return typeof value === "string" ? value.trim() : "";
        }
        return "";
      })
      .filter((value) => value.length > 0);
    return values.length > 0 ? new Set(values) : null;
  }

  function canReplayThoughtLevelFromResumeSnapshot(params: {
    snapshot: ZCodeSessionStateSnapshot;
    thoughtLevel: string;
  }): boolean {
    const availableThoughtLevels = readSnapshotAvailableThoughtLevels(params.snapshot);
    return availableThoughtLevels === null || availableThoughtLevels.has(params.thoughtLevel);
  }

  // zcodeSessionService is the desktop-continuous main path and must be
  // Broadcast snapshot, otherwise sqlite will always stay at the "New session" written when creatingSession, and the sidebar will not receive it.
  // workspace_task_list_changed. Old write path (send/steer/fork/compact/rewind pass-through)
  // Deleted, only the life cycle and configuration ops such as createSession/resumeSession/setModel and so on call this method.
  async function broadcastSnapshot(
    snapshot: ZCodeSessionStateSnapshot,
    tag: string,
    options: {
      modelOverride?: string;
      thoughtLevelOverride?: string;
      moveGroupedTaskToTop?: boolean;
      /** Design correction: required, every emission point must declare its change category. */
      broadcastReason: ZCodeWorkspaceTaskListChanged["reason"];
    },
  ): Promise<void> {
    if (!taskIndexSyncer) {
      return;
    }
    try {
      // Check the log (the list on the left is refreshed with the input box operation): Confirm which life cycle op (setModel/createSession/resumeSession) triggered the snapshot broadcast.
      logger.debug(
        undefined,
        `[list-refresh-trace] broadcastSnapshot tag=${tag} taskId=${snapshot.session.sessionId}`,
      );
      await taskIndexSyncer.syncSnapshotAndBroadcast(snapshot, options);
    } catch (error) {
      logger.warn(
        undefined,
        `[zcode-session-service] ${tag} syncSnapshotAndBroadcast failed taskId=${snapshot.session.sessionId}`,
        error,
      );
    }
  }

  async function repairEmptyImportedClaudeSession(
    snapshot: ZCodeSessionStateSnapshot,
    params: ZCodeSessionResumeParams | ZCodeSessionReadParams,
  ): Promise<ZCodeSessionStateSnapshot> {
    return withApiRetryRuntime(
      await repairEmptyImportedClaudeSessionSnapshot({
        agentService,
        snapshot,
        target: params,
      }),
    );
  }

  async function withResolvedMcpServers<
    T extends ZCodeSessionCreateParams | ZCodeSessionResumeParams,
  >(params: T): Promise<T> {
    const mcpServers = appendWorkspaceToFilesystemMcpServers(
      params.mcpServers,
      params.workspacePath,
    );
    const resolvedMcpServers = cuaProductMcpServerResolver
      ? await cuaProductMcpServerResolver.resolveMcpServers(mcpServers, {
          workspacePath: params.workspacePath,
        })
      : mcpServers;
    if (resolvedMcpServers === params.mcpServers) {
      return params;
    }
    // The desktop-continuous session path bypasses the legacy task adapter and will not be executed before.
    // The workspace injection of the filesystem MCP causes the same MCP to lack the current project authorization when launching a direct session.
    // Only the temporary parameters sent to the runtime are changed here, and user configurations are not written back to avoid contaminating MCP settings across workspaces;
    // product CUA broker socket/token also only injects runtime parameters.
    return { ...params, mcpServers: resolvedMcpServers };
  }

  return {
    async initializeWorkspace(params: ZCodeSessionWorkspaceTarget) {
      const result = await agentService.initialize(params);
      // The v4 ingestion of task index (sessions-index/workspace-config) is
      // workspace-level resident subscription. v4 command path (createSession/sendText goes to v4/command)
      // Instead of going through the session operation entrance of this service, the subscription must be established in the workspace pre-spot.
      // Otherwise, the final state/title/configuration directory of a pure v4 session will never be able to enter sqlite and workspace broadcasts.
      if (result.available && taskIndexSyncer) {
        taskIndexSyncer.ensureWorkspaceSubscription({
          workspacePath: params.workspacePath,
          workspaceIdentity: params.workspaceIdentity,
        });
      }
      return result;
    },

    getWorkspaceRuntimeIdentity(params: ZCodeSessionWorkspaceTarget) {
      return agentService.getWorkspaceRuntimeIdentity(params);
    },

    readWorkspacePresentation(params: ZCodeSessionReadWorkspacePresentationParams) {
      return agentService.readWorkspacePresentation(params);
    },

    async createSession(params: ZCodeSessionCreateParams) {
      const startedAt = Date.now();
      const sessionTraceId = params.sessionTraceId ?? createSessionTraceId();
      const agentParams = await withResolvedMcpServers({ ...params, sessionTraceId });
      logger.info(
        sessionTraceId,
        "[zcode-session-service] createSession assigned a session trace",
        {
          persistence: agentParams.persistence,
          workspaceIdentity: agentParams.workspaceIdentity,
          workspacePath: agentParams.workspacePath,
        },
      );
      const snapshot = await agentService.createSession(agentParams);
      logger.info(sessionTraceId, "[zcode-session-service] createSession agent returned", {
        durationMs: Date.now() - startedAt,
        mcpServerCount: agentParams.mcpServers?.length ?? 0,
        persistence: agentParams.persistence,
        snapshotTraceId: snapshot.session.traceId ?? null,
        sessionId: snapshot.session.sessionId,
        workspaceIdentity: agentParams.workspaceIdentity,
        workspacePath: agentParams.workspacePath,
      });
      if (agentParams.persistence === "deferred") {
        // The draft session before sending is only used to allow toolbar and agent runtime to share the same state.
        // This type of empty session cannot enter the app's task index sqlite, otherwise a session without user input will appear in the sidebar/search.
        // At the same time, this draft is recorded, and subsequent state changes such as setModel must also be blocked from the task index.
        deferredDraftSessions.remember(agentParams, snapshot);
        return snapshot;
      }
      // The desktop-continuous path does not go through the ZCode task adapter, and the task index of sqlite depends entirely on it.
      // The syncer's shadow subscription is refreshed. Ensure immediately after createSession is successful to ensure subsequent runtime
      // The subscription is in place before the first event arrives.
      notifySyncer({
        workspacePath: snapshot.session.workspace.workspacePath,
        workspaceIdentity: snapshot.session.workspace.workspaceIdentity,
        sessionId: snapshot.session.sessionId,
      });
      // Immediately synchronize the initial snapshot to sqlite + broadcast, so that the UI list can see the new session row for the first time.
      // Desktop-continuous initialization will not go through legacy createTask, and grouped top order must be written synchronously here.
      const snapshotWithRuntime = withApiRetryRuntime(snapshot);
      const broadcastStartedAt = Date.now();
      await broadcastSnapshot(snapshotWithRuntime, "createSession", {
        moveGroupedTaskToTop: true,
        // The first broadcast follows the old semantics of task_meta_changed (low frequency, once for one task);
        // The semantics of task_created (insert-active) need to be changed together with optimistic insertion and deduplication.
        broadcastReason: "task_meta_changed",
      });
      logger.info(
        sessionTraceId,
        "[zcode-session-service] createSession task index sync completed",
        {
          broadcastDurationMs: Date.now() - broadcastStartedAt,
          durationMs: Date.now() - startedAt,
          sessionId: snapshot.session.sessionId,
          workspaceIdentity: params.workspaceIdentity,
          workspacePath: params.workspacePath,
        },
      );
      return snapshotWithRuntime;
    },

    async resumeSession(params: ZCodeSessionResumeParams) {
      const startedAt = Date.now();
      const { broadcastSnapshot: shouldBroadcastSnapshot = true, ...resumeParams } = params;
      const agentParams = await withResolvedMcpServers(resumeParams);
      let snapshot = await repairEmptyImportedClaudeSession(
        withApiRetryRuntime(await agentService.resumeSession(agentParams)),
        agentParams,
      );
      const requestedThoughtLevelOverride = agentParams.thoughtLevel?.trim();
      let thoughtLevelOverride = requestedThoughtLevelOverride;
      if (
        requestedThoughtLevelOverride &&
        snapshot.settings.thoughtLevel.current !== requestedThoughtLevelOverride
      ) {
        if (
          !canReplayThoughtLevelFromResumeSnapshot({
            snapshot,
            thoughtLevel: requestedThoughtLevelOverride,
          })
        ) {
          // When restoring the historical task, the model has been switched back to the task-local model, but the old task config
          // It is still possible to pass the thoughtLevel of a previous model, such as the GLM-5-Turbo, into max.
          // snapshot.settings.thoughtLevel.available is the current model capability fact source. If it is not supported, it cannot be replayed to the agent.
          thoughtLevelOverride = undefined;
          logger.warn(
            undefined,
            "[zcode-session-service] resumeSession skipped an unsupported task thought level",
            {
              availableThoughtLevels: Array.from(
                readSnapshotAvailableThoughtLevels(snapshot) ?? [],
              ),
              requestedThoughtLevel: requestedThoughtLevelOverride,
              sessionId: agentParams.sessionId,
              snapshotThoughtLevel: snapshot.settings.thoughtLevel.current ?? null,
              workspaceIdentity: agentParams.workspaceIdentity ?? null,
              workspacePath: agentParams.workspacePath,
            },
          );
        }
      }
      if (thoughtLevelOverride && snapshot.settings.thoughtLevel.current !== thoughtLevelOverride) {
        logger.info(
          undefined,
          "[zcode-session-service] resumeSession replayed the task thought level",
          {
            requestedThoughtLevel: thoughtLevelOverride,
            sessionId: agentParams.sessionId,
            snapshotThoughtLevel: snapshot.settings.thoughtLevel.current ?? null,
            workspaceIdentity: agentParams.workspaceIdentity ?? null,
            workspacePath: agentParams.workspacePath,
          },
        );
        // When opening a historical task, the snapshot returned by resume may still contain the latest thinking intensity of the workspace draft state.
        // Here, the task-local thoughtLevel is explicitly replayed for the same session, and then the modified snapshot is broadcast;
        // Otherwise, syncer/UI will write the draft's high back to the active task that was originally max.
        snapshot = await repairEmptyImportedClaudeSession(
          withApiRetryRuntime(
            await agentService.setThoughtLevel({
              workspacePath: agentParams.workspacePath,
              workspaceIdentity: agentParams.workspaceIdentity,
              sessionId: agentParams.sessionId,
              thoughtLevel: thoughtLevelOverride,
            }),
          ),
          agentParams,
        );
      }
      const agentDurationMs = Date.now() - startedAt;
      notifySyncer(agentParams, { includeSnapshot: shouldBroadcastSnapshot });
      const broadcastStartedAt = Date.now();
      const modelOverride = agentParams.model
        ? formatModelPickerValue(agentParams.model)
        : undefined;
      const syncOptions =
        modelOverride || thoughtLevelOverride
          ? {
              ...(modelOverride ? { modelOverride } : {}),
              ...(thoughtLevelOverride ? { thoughtLevelOverride } : {}),
            }
          : undefined;
      if (shouldBroadcastSnapshot) {
        // The open/restore task is snapshot convergence and does not change the pin/archive/unread ownership;
        // The default task_meta_changed will trigger a global membership re-pull every time a task is clicked.
        await broadcastSnapshot(snapshot, "resumeSession", {
          ...syncOptions,
          broadcastReason: "task_status_changed",
        });
      } else if (modelOverride && taskIndexSyncer) {
        await taskIndexSyncer.syncTaskModel(
          {
            workspacePath: agentParams.workspacePath,
            workspaceIdentity: agentParams.workspaceIdentity,
            sessionId: agentParams.sessionId,
          },
          modelOverride,
        );
      }
      logger.info(undefined, "[zcode-session-service] resumeSession history recovery completed", {
        agentDurationMs,
        broadcastDurationMs: shouldBroadcastSnapshot ? Date.now() - broadcastStartedAt : 0,
        broadcastSnapshot: shouldBroadcastSnapshot,
        durationMs: Date.now() - startedAt,
        mcpServerCount: agentParams.mcpServers?.length ?? 0,
        sessionId: agentParams.sessionId,
        snapshot: getSessionSnapshotDiagnostics(snapshot),
        workspaceIdentity: agentParams.workspaceIdentity ?? null,
        workspacePath: agentParams.workspacePath,
      });
      return snapshot;
    },

    listSessions(params: ZCodeSessionListParams) {
      return agentService.listSessions(params);
    },

    async readSession(params: ZCodeSessionReadParams) {
      const startedAt = Date.now();
      const snapshot = await repairEmptyImportedClaudeSession(
        withApiRetryRuntime(await agentService.readSession(params)),
        params,
      );
      logger.info(
        undefined,
        "[zcode-session-service] readSession history snapshot read completed",
        {
          deliveryKind: params.deliveryKind,
          durationMs: Date.now() - startedAt,
          messageLimit: params.messageLimit ?? null,
          sessionId: params.sessionId,
          snapshot: getSessionSnapshotDiagnostics(snapshot),
          workspaceIdentity: params.workspaceIdentity ?? null,
          workspacePath: params.workspacePath,
        },
      );
      return snapshot;
    },

    readSessionMessages(params: ZCodeSessionMessagesParams) {
      return agentService.readSessionMessages(params);
    },

    readSessionEvents(params: ZCodeSessionEventsParams) {
      return agentService.readSessionEvents(params);
    },

    promoteDeferredDraftSession(params: ZCodeTaskTarget) {
      const wasDeferredDraft = deferredDraftSessions.has(params);
      deferredDraftSessions.forget(params);
      if (!wasDeferredDraft) {
        return Promise.resolve();
      }
      // The mobile replayable is first consumed by the task facade and the deferred draft needs to be cleared here.
      // And notify the task index to synchronize, so as to avoid skipping synchronization according to deferred rules when the desktop subsequently controls the same task.
      notifySyncer(params);
      logger.info(
        undefined,
        "[zcode-session-service] deferred draft session was promoted to a task",
        {
          sessionId: params.sessionId,
          workspaceIdentity: params.workspaceIdentity ?? null,
          workspacePath: params.workspacePath,
        },
      );
      return Promise.resolve();
    },

    closeSession(params: ZCodeTaskTarget) {
      deferredDraftSessions.forget(params);
      return agentService.closeSession(params).then(() => undefined);
    },

    async closeDeferredDraftSession(params: ZCodeTaskTarget) {
      try {
        const closed = await agentService.closeSession({
          ...params,
          expectedPersistence: "deferred",
        });
        if (closed) {
          deferredDraftSessions.forget(params);
        }
        return closed;
      } catch (error) {
        // Old Agents will reject expectedPersistence. A safe downgrade is to keep the old session and create a new draft,
        // You cannot fall back to unconditional close, otherwise the active task that has just been promoted by other clients may be closed.
        logger.warn(
          undefined,
          "[zcode-session-service] failed to conditionally close the deferred draft, keeping the old session",
          {
            error: error instanceof Error ? error.message : String(error),
            sessionId: params.sessionId,
            workspaceIdentity: params.workspaceIdentity ?? null,
            workspacePath: params.workspacePath,
          },
        );
        return false;
      }
    },

    async setModel(params: ZCodeSessionSetModelParams) {
      const isDeferredDraft = deferredDraftSessions.has(params);
      if (!isDeferredDraft) {
        notifySyncer(params);
      }
      const snapshot = withApiRetryRuntime(await agentService.setModel(params));
      if (isDeferredDraft) {
        // The deferred draft only exists in the runtime memory, and setModel returns an empty snapshot with no message.
        // If the task index is subscribed/written here, the list will leave "Session not found" dirty sessions that cannot be resumed after the process is restarted.
        return snapshot;
      }
      await broadcastSnapshot(snapshot, "setModel", {
        modelOverride: formatModelPickerValue(params.model),
        // Cutting models are pure configuration changes, and task_model_changed must be used for broadcast;
        // Previously, it fell to the default task_meta_changed, and the UI would misjudge it as an ownership-related change.
        // Trigger global membership re-pull + refresh of all lists on the left.
        broadcastReason: "task_model_changed",
      });
      return snapshot;
    },

    async setThoughtLevel(params: ZCodeSessionSetThoughtLevelParams) {
      return withApiRetryRuntime(await agentService.setThoughtLevel(params));
    },

    async setMode(params: ZCodeSessionSetModeParams) {
      return withApiRetryRuntime(await agentService.setMode(params));
    },

    // onDynamicSessionEvent (old session/subscribe subscription interface on renderer side) has been deleted.
    // The session events of v4 UI go through the conversation frame channel of agentService. This service no longer sends messages to
    // agentService.onDynamicSessionEvent establishes any subscriptions.
  };
}
