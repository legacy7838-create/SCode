/* eslint-disable max-lines -- v4 frame ingestion, snapshot upserts and workspace broadcasts for the task index must share the same closure state. */
import { repairSubagentTaskIndex } from "#src/zcode-agent/repairSubagentTaskIndex.js";
import {
  deriveZCodeTaskStatusFromSessionSnapshot,
  generateTraceId,
  getZCodeUserVisibleMessages,
  isZCodeGoalContinuationReminderText,
  isZCodeModelOnlySyntheticUserMessage,
  resolveWorkspaceKey,
  resolveZCodeVisibleSessionTitle,
  ZCODE_AGENT_PROVIDER_NOT_READY_CODE,
  ZCODE_AGENT_PROVIDER,
  type ZCodeTaskGoal,
  type ZCodeTaskMode,
  type ZCodeTaskMeta,
  type ZCodeMessagePart,
  type ZCodeSessionMode,
  type ZCodeSessionStateSnapshot,
  type ZCodeWorkspaceEvent,
  type ZCodeWorkspaceTaskListChanged,
} from "@zcode/shared";
import {
  PROTOCOL_V4_LIMITS,
  sessionsIndexTopic,
  sessionsIndexTopicFrameSchema,
  workspaceConfigTopic,
  workspaceConfigTopicFrameSchema,
  TopicWireFrameAssembler,
  type SessionPhase,
  type SessionSummary,
  type SessionsIndexTopicFrame,
  type SessionsIndexTopicWireCandidate,
  type V4SessionsIndexSubscribeResult,
  type V4WorkspaceConfigSubscribeResult,
  type WorkspaceConfigTopicFrame,
  type WorkspaceConfigTopicWireCandidate,
} from "@zcode/shared/zcode-protocol-v4";
import { Emitter, type Event, type IDisposable } from "@zcode/rpc";
import { createServiceLogger } from "#src/logger/serviceLogger.js";
import { TaskIndexRepo } from "#src/session/taskIndexRepo.js";
import type { ZCodeWorkspaceEventSubscriptionParams } from "#src/session/zcodeTaskListTypes.js";
import type {
  IZCodeAgentService,
  ZCodeAgentSessionTarget,
  ZCodeAgentWorkspaceTarget,
} from "./zcodeAgent.js";
import { ZCODE_AGENT_RUNTIME_UNAVAILABLE_CODE } from "./zcodeAgent.js";
import { formatTaskMetaModelSelectionFromSnapshot } from "./zcodeConfigOptions.js";

const logger = createServiceLogger("zcode-task-index-syncer");

/** Scope of the v4 subscription connectionId: a different generation from the renderer sidebar on the same topic (resubscribe replaces). */
const TASK_INDEX_SUBSCRIBER_SCOPE = "task-index";
const MAX_PENDING_TOPIC_FRAMES = 1_024;
const MAX_PENDING_TOPIC_BYTES = 32 * 1024 * 1024;
const INITIAL_BASELINE_SEED_BATCH_SIZE = 64;
const PROVIDER_NOT_READY_RETRY_MS = 5_000;
const TOPIC_SUBSCRIBE_WARN_INTERVAL_MS = 60_000;

type TopicSubscribeReason =
  | "initial"
  | "runtime-restart"
  | "snapshot-recovery-gap"
  | "recovery-frame-timeout"
  | "resync-ack-mismatch"
  | "resync-failed"
  | "force-recovery-gap"
  | "pre-ack-overflow"
  | "provider-not-ready-wait"
  | "retry";
type TopicRetryKind = "provider-not-ready" | "transient";
type TaskIndexTopicKind = "sessions-index" | "workspace-config";

type WorkspaceEventInput = string | ZCodeWorkspaceEventSubscriptionParams;

interface WorkspaceBroadcastTarget {
  workspacePath: string;
  workspaceIdentity?: string;
  taskId?: string;
}

export interface ZCodeTaskIndexTerminalEvent {
  target: ZCodeAgentSessionTarget;
  /** v4 phase terminal-state mapping: completedSuccess/completedInterrupted → turn.completed; error → turn.failed. */
  kind: "turn.completed" | "turn.failed";
}

export interface ZCodeTaskIndexReadyEvent {
  target: ZCodeAgentSessionTarget;
  /** v4 phase terminal-state mapping: the ready boundary after the agent has converged and can accept the next input. */
  reason: "prompt_completed" | "prompt_failed";
}

export interface ZCodeTaskIndexSyncer {
  /**
   * Idempotently establishes the v4 background ingestion subscriptions (sessions-index + workspace-config)
   * for the given workspace, landing the CLI-authoritative projections of session terminal state /
   * title / config catalog into the task index sqlite and the workspace broadcast.
   * Repeated calls for the same workspace only ever establish it once.
   */
  ensureWorkspaceSubscription(target: ZCodeAgentWorkspaceTarget): void;
  /**
   * Compatibility entry point (the shape of the old shadow subscription API): the session-level
   * activation signal is unified into a workspace-level v4 subscription. options.includeSnapshot has
   * no counterpart under v4 ingestion (the initial sessions-index snapshot only silently fills in
   * missing rows and does not replay terminal states or broadcasts); the parameter is kept only so
   * the calling surface stays untouched.
   */
  ensureSessionSubscription(
    target: ZCodeAgentSessionTarget,
    options?: {
      includeSnapshot?: boolean;
    },
  ): void;
  /**
   * Syncs a session snapshot into sqlite and broadcasts workspace_task_list_changed.
   * On the desktop-continuous path zcodeSessionService calls this after
   * createSession/resumeSession/setModel (the legacy send/steer/fork/compact/rewind write paths are
   * gone, and writes now uniformly go through v4 commands plus sessions-index/workspace events), so
   * sqlite picks up the latest title/updatedAt and the UI list refresh is triggered.
   */
  syncSnapshotAndBroadcast(
    snapshot: ZCodeSessionStateSnapshot,
    options: {
      modelOverride?: string;
      thoughtLevelOverride?: string;
      moveGroupedTaskToTop?: boolean;
      unreadSignal?: ZCodeWorkspaceTaskListChanged["unreadSignal"];
      /**
       * Design correction: required. Changes like switching models (task_model_changed) or snapshot
       * convergence (task_status_changed) must not fall into task_meta_changed — the UI treats the
       * latter as a membership-related change and triggers a global membership refetch plus a full
       * list refresh.
       */
      broadcastReason: ZCodeWorkspaceTaskListChanged["reason"];
    },
  ): Promise<ZCodeTaskMeta>;
  /**
   * Updates only the model record in the task index and does not broadcast historical snapshots.
   * The resume before sending disables snapshot broadcasting so an old terminal state does not
   * overwrite the local streaming UI, but sqlite still needs its model moved from a deleted
   * historical model to the actually usable model used this time.
   */
  syncTaskModel(target: ZCodeAgentSessionTarget, model: string): Promise<ZCodeTaskMeta | null>;
  /**
   * Explicitly triggers one workspace_task_list_changed broadcast.
   * For the adapter's use: after task metadata changes such as archive / rename / pin / delete it
   * must still broadcast. Design correction: reason is required. The former default
   * (task_meta_changed) made every emitter that expressed no opinion silently fall into the
   * heaviest UI refresh semantics (a global membership refetch), which was the root cause of
   * "composer actions / task convergence cause a full refresh of the left-hand list"; every
   * emitter must declare its change category explicitly.
   */
  emitWorkspaceTaskListChanged(
    target: WorkspaceBroadcastTarget,
    meta: ZCodeTaskMeta | undefined,
    reason: ZCodeWorkspaceTaskListChanged["reason"],
    options?: Pick<ZCodeWorkspaceTaskListChanged, "unreadSignal">,
  ): void;
  /**
   * Gets the shared workspace emitter, for the adapter to fire non-task_list_changed events
   * (such as workspace_config_options_update). That way adapter and syncer share one emitter and
   * subscribers only need to subscribe once to receive every event.
   */
  getWorkspaceEmitter(workspace: WorkspaceEventInput): Emitter<ZCodeWorkspaceEvent>;
  /** Subscribes to the workspace-dimensional event stream. adapter.onDynamicWorkspaceEvent forwards straight here. */
  onDynamicWorkspaceEvent(workspace: WorkspaceEventInput): Event<ZCodeWorkspaceEvent>;
  /**
   * Subscribes to session phase terminal-state transitions observed on the v4 sessions-index.
   * This is not a UI stream; it exists only for services-internal state convergence such as the
   * host runtime command queue.
   */
  onSessionTerminalEvent: Event<ZCodeTaskIndexTerminalEvent>;
  /**
   * Subscribes to the prompt ready state after a session converges (phase entering
   * completedSuccess/completedInterrupted/error). The mobile host command queue can only use this
   * event as the boundary for sending the next prompt.
   */
  onSessionReadyEvent: Event<ZCodeTaskIndexReadyEvent>;
  /** Releases every v4 subscription and the workspace emitter; it does not close the injected taskIndexRepo. */
  disposeAll(): void;
}

interface CreateZCodeTaskIndexSyncerOptions {
  agentService: IZCodeAgentService;
  taskIndexRepo: TaskIndexRepo;
}

/** The set of terminal phases (used to decide transitions against the conflated latest state from sessions-index). */
function isTerminalPhase(phase: SessionPhase): boolean {
  return phase === "completedSuccess" || phase === "completedInterrupted" || phase === "error";
}

function resolveTerminalUnreadSignal(
  summary: Pick<SessionSummary, "phase" | "goalStatus">,
): ZCodeWorkspaceTaskListChanged["unreadSignal"] {
  if (summary.phase === "error") {
    return "background_terminal";
  }
  if (
    (summary.phase === "completedSuccess" || summary.phase === "completedInterrupted") &&
    (summary.goalStatus === undefined || summary.goalStatus === "verified")
  ) {
    return "background_terminal";
  }
  return undefined;
}

function taskStatusFromSummaryPhase(phase: SessionPhase): ZCodeTaskMeta["status"] {
  switch (phase) {
    case "running":
    case "prewarming":
      return "running";
    case "completedSuccess":
    case "completedInterrupted":
      return "completed";
    case "error":
      return "error";
    default:
      return undefined;
  }
}

function buildBaselineMetaFromSummary(
  target: ZCodeAgentWorkspaceTarget,
  summary: SessionSummary,
): ZCodeTaskMeta {
  const status = taskStatusFromSummaryPhase(summary.phase);
  return {
    taskId: summary.sessionId,
    traceId: generateTraceId(summary.sessionId),
    title: summary.title,
    ...(summary.titleSource === "custom" ? { titleOverridden: true } : {}),
    workspacePath: target.workspacePath,
    workspaceIdentity: target.workspaceIdentity,
    createdAt: summary.createdAt,
    updatedAt: summary.lastActivityAt,
    mode: "build",
    provider: ZCODE_AGENT_PROVIDER,
    ...(summary.parentSessionId ? { forkedFromTaskId: summary.parentSessionId } : {}),
    ...(status ? { status } : {}),
  };
}

interface WorkspaceIngestState {
  target: ZCodeAgentWorkspaceTarget;
  /** The Agent runtime generation currently attached; null = dormant. */
  runtimeGeneration: number | null;
  /** The sessions-index subscription generation (the frame filtering gate; null = the subscription is being established). */
  indexSubscriptionId: string | null;
  /** The workspace-config subscription generation. */
  configSubscriptionId: string | null;
  /** The two topics change generation independently; recovering a single topic must not invalidate a sibling's late ACK. */
  indexSubscriptionGeneration: number;
  configSubscriptionGeneration: number;
  indexPending: PendingTopicFrames<SessionsIndexTopicWireCandidate> | null;
  configPending: PendingTopicFrames<WorkspaceConfigTopicWireCandidate> | null;
  /** Confirmed watermark accounted per topic independently; a single seq/epoch must not be shared. */
  indexLogEpoch: string | null;
  indexSeq: number;
  configLogEpoch: string | null;
  configSeq: number;
  /** An ACK only proves admission; epoch/seq may only be used as the resume base after the first logical frame is atomically applied. */
  indexHasAppliedBase: boolean;
  configHasAppliedBase: boolean;
  indexRecovery: TopicRecoveryState | null;
  configRecovery: TopicRecoveryState | null;
  indexRecoveryGeneration: number;
  configRecoveryGeneration: number;
  /** Topic-local backoff after a transient runtime restart/recovery RPC failure; the sibling stays alive. */
  indexRetryTimer: ReturnType<typeof setTimeout> | null;
  configRetryTimer: ReturnType<typeof setTimeout> | null;
  indexRetryAttempt: number;
  configRetryAttempt: number;
  /** Rate limits the production warn under a persistent failure; cleared after a successful subscription so the next new failure is immediately visible. */
  indexLastWarnAt: number | null;
  configLastWarnAt: number | null;
  /** The session summary baseline (the diff basis for terminal transitions / title changes). */
  summaries: Map<string, SessionSummary>;
  /** The first frame (snapshot) silently fills in missing rows but does not replay historical terminal events or list broadcasts. */
  seeded: boolean;
  /** The workspace-level frame emitter stays stable across runtime generations and allows only one installed set of listeners. */
  frameListenersInstalled: boolean;
  disposables: IDisposable[];
  indexAssembler: TopicWireFrameAssembler<SessionsIndexTopicFrame>;
  configAssembler: TopicWireFrameAssembler<WorkspaceConfigTopicFrame>;
  assemblyTimer: ReturnType<typeof setTimeout> | null;
}

type TopicDeliveryKind = "initial" | "online" | "recovery";

interface TopicRecoveryState {
  generation: number;
  subscriptionId: string;
  forceSnapshot: boolean;
  ackReceived: boolean;
  frameApplied: boolean;
  upgradeToSnapshot: boolean;
  postRecoveryGapPending: boolean;
  frameDeadline: ReturnType<typeof setTimeout> | null;
}

interface PendingTopicFrames<TFrame> {
  generation: number;
  frames: TFrame[];
  stagedBytes: number;
  recoveryNeeded: boolean;
}

export function createZCodeTaskIndexSyncer(
  options: CreateZCodeTaskIndexSyncerOptions,
): ZCodeTaskIndexSyncer {
  const { agentService, taskIndexRepo } = options;
  // Event ingestion of task index is from the old protocol shadow subscription (session/subscribe +
  // session/event + state.updated) is moved to v4 frame as a whole - provided by sessions-index topic
  // The workspace level conflated latest status of status(phase)/title/lastActivity,
  // The workspace-config topic provides hot updates of the configuration directory; the text search index is migrated during the final state of the phase.
  // Complete snapshot convergence back to the source (the v4 command path no longer has op-driven snapshot synchronization).
  const workspaceIngests = new Map<string, WorkspaceIngestState>();
  // Previously, workspaceEmitters were privately stored in the adapter, and after the syncer was written, there was no broadcast channel for sqlite.
  // The UI never receives workspace_task_list_changed. Change the mention of syncer and adapter on emitter to forwarding,
  // Let the adapter path and desktop-continuous path share the same subscription, and events will no longer be split.
  const workspaceEmitters = new Map<string, Emitter<ZCodeWorkspaceEvent>>();
  const terminalEventEmitter = new Emitter<ZCodeTaskIndexTerminalEvent>();
  const readyEventEmitter = new Emitter<ZCodeTaskIndexReadyEvent>();
  let disposed = false;

  const indexTopicFor = (state: WorkspaceIngestState) =>
    sessionsIndexTopic(resolveWorkspaceKey(state.target));
  const configTopicFor = (state: WorkspaceIngestState) =>
    workspaceConfigTopic(resolveWorkspaceKey(state.target));
  const isProviderNotReadyError = (error: unknown): boolean =>
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === ZCODE_AGENT_PROVIDER_NOT_READY_CODE;
  const isRuntimeUnavailableError = (error: unknown): boolean =>
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === ZCODE_AGENT_RUNTIME_UNAVAILABLE_CODE;
  const logTopicSubscribeFailure = (
    state: WorkspaceIngestState,
    topic: TaskIndexTopicKind,
    reason: TopicSubscribeReason,
    error: unknown,
    retryKind: TopicRetryKind,
  ): void => {
    const message = `task index ${topic} subscription failed reason=${reason} workspace=${state.target.workspacePath}`;
    if (retryKind === "provider-not-ready") {
      // New users who have not yet configured a model are in a normal waiting state; if the two topics of each workspace continue to warn,
      // A log storm will be created before the user performs any operations. debug will not be deployed in production builds.
      logger.debug(undefined, message, error);
      return;
    }

    const lastWarnAt = topic === "sessions-index" ? state.indexLastWarnAt : state.configLastWarnAt;
    const now = Date.now();
    if (lastWarnAt === null || now - lastWarnAt >= TOPIC_SUBSCRIBE_WARN_INTERVAL_MS) {
      if (topic === "sessions-index") state.indexLastWarnAt = now;
      else state.configLastWarnAt = now;
      logger.warn(undefined, message, error);
      return;
    }
    // High-frequency retry details are only used for local troubleshooting and cannot be written to the production log at the same level as the message flow.
    logger.debug(undefined, message, error);
  };
  const createPendingFrames = <TFrame>(generation: number): PendingTopicFrames<TFrame> => ({
    generation,
    frames: [],
    stagedBytes: 0,
    recoveryNeeded: false,
  });
  const discardPendingFrames = <TFrame>(pending: PendingTopicFrames<TFrame> | null): void => {
    if (!pending) return;
    pending.frames.length = 0;
    pending.stagedBytes = 0;
  };
  const frameBytes = (
    frame: SessionsIndexTopicWireCandidate | WorkspaceConfigTopicWireCandidate,
  ): number => new TextEncoder().encode(JSON.stringify(frame)).byteLength;
  const stagePendingFrame = <
    TFrame extends SessionsIndexTopicWireCandidate | WorkspaceConfigTopicWireCandidate,
  >(
    state: WorkspaceIngestState,
    kind: "sessions-index" | "workspace-config",
    pending: PendingTopicFrames<TFrame>,
    frame: TFrame,
  ): void => {
    if (pending.recoveryNeeded) return;
    const bytes = frameBytes(frame);
    if (
      bytes > MAX_PENDING_TOPIC_BYTES ||
      pending.frames.length + 1 > MAX_PENDING_TOPIC_FRAMES ||
      pending.stagedBytes + bytes > MAX_PENDING_TOPIC_BYTES
    ) {
      // The ACK-only initial notification will arrive before the Promise continuation. Before the subscription is created
      // When the temporary buffer exceeds the limit, it can neither accumulate without bounds nor drop frames; at this time, a provable base has not yet been obtained.
      // Therefore, the mark needs to be restored, and after the ACK arrives, only a new generation snapshot subscription will be initiated for the topic.
      discardPendingFrames(pending);
      pending.recoveryNeeded = true;
      logger.warn(
        undefined,
        `task index ${kind} ACK staging overflow; recovery-needed workspace=${resolveWorkspaceKey(state.target)}`,
      );
      return;
    }
    pending.frames.push(frame);
    pending.stagedBytes += bytes;
  };
  const clearIndexPendingState = (state: WorkspaceIngestState): void => {
    discardPendingFrames(state.indexPending);
    state.indexPending = null;
    state.indexAssembler.clear();
  };
  const clearConfigPendingState = (state: WorkspaceIngestState): void => {
    discardPendingFrames(state.configPending);
    state.configPending = null;
    state.configAssembler.clear();
  };
  const clearPendingState = (state: WorkspaceIngestState): void => {
    clearIndexPendingState(state);
    clearConfigPendingState(state);
    if (state.assemblyTimer) clearTimeout(state.assemblyTimer);
    state.assemblyTimer = null;
  };
  const unsubscribeIndex = async (
    state: WorkspaceIngestState,
    subscriptionId: string,
  ): Promise<void> => {
    try {
      await agentService.unsubscribeSessionsIndexV4({
        ...state.target,
        subscriptionId,
        runtimePolicy: "existing-only",
      });
    } catch (error) {
      logger.warn(
        undefined,
        `failed to clean up the task index sessions-index subscription workspace=${state.target.workspacePath}`,
        error,
      );
    }
  };
  const unsubscribeConfig = async (
    state: WorkspaceIngestState,
    subscriptionId: string,
  ): Promise<void> => {
    try {
      await agentService.unsubscribeWorkspaceConfigV4({
        ...state.target,
        subscriptionId,
        runtimePolicy: "existing-only",
      });
    } catch (error) {
      logger.warn(
        undefined,
        `failed to clean up the task index workspace-config subscription workspace=${state.target.workspacePath}`,
        error,
      );
    }
  };
  const clearActiveSubscriptions = (state: WorkspaceIngestState): void => {
    const indexSubscriptionId = state.indexSubscriptionId;
    const configSubscriptionId = state.configSubscriptionId;
    state.indexSubscriptionId = null;
    state.configSubscriptionId = null;
    if (indexSubscriptionId) void unsubscribeIndex(state, indexSubscriptionId);
    if (configSubscriptionId) void unsubscribeConfig(state, configSubscriptionId);
  };

  function getWorkspaceEmitter(workspace: WorkspaceEventInput): Emitter<ZCodeWorkspaceEvent> {
    const key =
      typeof workspace === "string"
        ? workspace
        : resolveWorkspaceKey({
            workspacePath: workspace.workspacePath,
            workspaceIdentity: workspace.workspaceIdentity,
          });
    let emitter = workspaceEmitters.get(key);
    if (!emitter) {
      emitter = new Emitter<ZCodeWorkspaceEvent>();
      workspaceEmitters.set(key, emitter);
    }
    return emitter;
  }

  function emitWorkspaceTaskListChanged(
    target: WorkspaceBroadcastTarget,
    taskMeta: ZCodeTaskMeta | undefined,
    reason: ZCodeWorkspaceTaskListChanged["reason"],
    options?: Pick<ZCodeWorkspaceTaskListChanged, "unreadSignal">,
  ): void {
    // Check the log (the list on the left is refreshed with the input box operation): Confirm which operations are sending task list broadcasts and what the reason is.
    logger.debug(
      undefined,
      `[list-refresh-trace] emitWorkspaceTaskListChanged reason=${reason} taskId=${target.taskId ?? "-"} workspace=${target.workspacePath} hasMeta=${Boolean(taskMeta)}`,
    );
    getWorkspaceEmitter({
      workspacePath: target.workspacePath,
      workspaceIdentity: target.workspaceIdentity,
    }).fire({
      type: "workspace_task_list_changed",
      workspacePath: target.workspacePath,
      workspaceIdentity: target.workspaceIdentity,
      taskId: target.taskId,
      reason,
      ...(taskMeta ? { taskMeta } : {}),
      ...(options?.unreadSignal ? { unreadSignal: options.unreadSignal } : {}),
    });
  }

  async function resyncTaskIndexRowFromAgent(
    target: ZCodeAgentSessionTarget,
    reason: string,
    options?: {
      moveGroupedTaskToTop?: boolean;
      unreadSignal?: ZCodeWorkspaceTaskListChanged["unreadSignal"];
    },
  ): Promise<void> {
    try {
      // task-index is a passive observer and can only read the existing runtime. Call resumeSession
      // The same session will be rematerialized/resume after the user's next prompt has been accepted by Core.
      // Form a second life cycle writer; readSession(existing-only) retains the complete snapshot
      // indexing capabilities without pulling up or modifying the runtime.
      const snapshot = await agentService.readSession({
        ...target,
        runtimePolicy: "existing-only",
      });
      // Back-to-origin convergence is status/text synchronization and does not involve pin/archive/unread ownership (task_status_changed).
      await syncSnapshotAndBroadcast(snapshot, {
        ...(options?.unreadSignal ? { unreadSignal: options.unreadSignal } : {}),
        broadcastReason: "task_status_changed",
        moveGroupedTaskToTop: options?.moveGroupedTaskToTop,
      });
    } catch (error) {
      logger.warn(
        undefined,
        `failed to sync the task index row from the source reason=${reason} taskId=${target.sessionId}`,
        error,
      );
    }
  }

  function sessionTargetFrom(
    workspace: ZCodeAgentWorkspaceTarget,
    sessionId: string,
  ): ZCodeAgentSessionTarget {
    return {
      workspacePath: workspace.workspacePath,
      workspaceIdentity: workspace.workspaceIdentity,
      sessionId,
    };
  }

  function broadcastTargetFrom(target: ZCodeAgentSessionTarget): WorkspaceBroadcastTarget {
    return {
      workspacePath: target.workspacePath,
      workspaceIdentity: target.workspaceIdentity,
      taskId: target.sessionId,
    };
  }

  function emitTerminalAndReady(target: ZCodeAgentSessionTarget, summary: SessionSummary): void {
    const phase = summary.phase;
    const failed = phase === "error";
    // The order maintains the semantics of the old protocol: first turn the final state (close the current input), then prompt ready (release the next one).
    terminalEventEmitter.fire({
      target,
      kind: failed ? "turn.failed" : "turn.completed",
    });
    readyEventEmitter.fire({
      target,
      reason: failed ? "prompt_failed" : "prompt_completed",
    });
  }

  /** Terminal phase transition → sqlite status convergence + broadcast + re-fetch the source text index. */
  function applyTerminalTransition(
    target: ZCodeAgentSessionTarget,
    summary: SessionSummary,
    options?: { moveGroupedTaskToTop?: boolean },
  ): void {
    emitTerminalAndReady(target, summary);
    const failed = summary.phase === "error";
    const unreadSignal = resolveTerminalUnreadSignal(summary);
    logger.debug(undefined, "task terminal unread verdict", {
      goalStatus: summary.goalStatus ?? null,
      phase: summary.phase,
      taskId: target.sessionId,
      unreadSignal: unreadSignal ?? null,
    });
    const updatedAt = Date.now();
    void taskIndexRepo
      .applyAgentPatch({
        workspacePath: target.workspacePath,
        workspaceIdentity: target.workspaceIdentity,
        taskId: target.sessionId,
        // The lastError details of error are not in the sessions-index summary and are left for subsequent back-to-origin snapshots.
        // Write authoritative value (patch without lastError key = retain current value); completed is cleared along the old semantics.
        patch: failed
          ? { status: "error", updatedAt }
          : { status: "completed", lastError: undefined, updatedAt },
      })
      .then((meta) => {
        if (meta) {
          // Previously, only sqlite was updated without broadcasting. The UI monitored workspace_task_list_changed and could not receive notifications.
          // As a result, the spinner does not disappear and the updatedAt sorting does not refresh. Add one more broadcast to allow the list to converge.
          // The final state convergence is a status change, and task_status_changed must be used;
          // Previously, the default task_meta_changed was set, and membership would be globally bumped every time the turn was completed.
          // Version number, all list instances are repulsed, and the performance is "the list on the left flashes when the task ends".
          emitWorkspaceTaskListChanged(
            broadcastTargetFrom(target),
            meta,
            "task_status_changed",
            unreadSignal ? { unreadSignal } : undefined,
          );
        }
        // The final state reads the complete snapshot: v4 command path (createSession/sendText goes to v4/command)
        // Without op driver snapshot synchronization of zcodeSessionService, row missing/text search/lastError
        // It all depends on convergence here; readSession(existing-only) only reads the existing runtime and does not restore the session.
        void resyncTaskIndexRowFromAgent(target, failed ? "phase.error" : "phase.completed", {
          moveGroupedTaskToTop: options?.moveGroupedTaskToTop,
          // When the patch has been broadcast, subsequent snapshots cannot be returned to the source to create completion reminders again;
          // When a row is missing, the same signal is given to the source result to ensure that reminders are neither lost nor repeated.
          ...(meta || !unreadSignal ? {} : { unreadSignal }),
        });
      })
      .catch((error) => {
        logger.warn(
          undefined,
          `failed to sync the v4 terminal phase to the task index taskId=${target.sessionId}`,
          error,
        );
      });
  }

  /** Title change → sqlite title patch; a missing row re-fetches the full snapshot from the source (matching the old first_input semantics). */
  function applyTitleChange(target: ZCodeAgentSessionTarget, title: string): void {
    const updatedAt = Date.now();
    void taskIndexRepo
      .applyAgentPatch({
        workspacePath: target.workspacePath,
        workspaceIdentity: target.workspaceIdentity,
        taskId: target.sessionId,
        patch: { title, updatedAt },
      })
      .then((meta) => {
        if (meta) {
          // Title changes (first message/automatic title generation) are independent of attribution and must be posted for every task,
          // Use exclusive reason to avoid triggering global membership re-pull every time the first/last title is placed.
          emitWorkspaceTaskListChanged(broadcastTargetFrom(target), meta, "task_title_changed");
        } else {
          // The draft session does not prewrite placeholder lines; the first header (old first_input) precedes any
          // When the snapshot upsert arrives, it returns the complete snapshot to the source to avoid relying on empty session placeholder lines.
          // v4 createSession does not go through zcodeSessionService.createSession; first header arrives and
          // There is no row in task index yet, indicating that this is the first time a new session has been logged into the database. When returning to the source, you must also write the grouped top level minimum
          // sort_order, otherwise missing nodes will be added to the end of the list by the client.
          void resyncTaskIndexRowFromAgent(target, "meta.titleUpdated", {
            moveGroupedTaskToTop: true,
          });
        }
      })
      .catch((error) => {
        logger.warn(
          undefined,
          `failed to sync the v4 title change to the task index taskId=${target.sessionId}`,
          error,
        );
      });
  }

  /** Diffs a single summary against the baseline: drafts are skipped; terminal transitions and title changes each converge on their own. */
  function processSummary(
    state: WorkspaceIngestState,
    previous: SessionSummary | undefined,
    next: SessionSummary,
    _deliveryKind: TopicDeliveryKind,
  ): void {
    state.summaries.set(next.sessionId, next);
    // Draft ruling: Pure memory state, no disk placement, and never entering task index sqlite.
    if (next.phase === "draft") {
      return;
    }
    const target = sessionTargetFrom(state.target, next.sessionId);
    const becameVisibleTask = previous === undefined || previous.phase === "draft";
    // Final state migration = non-final state actually observed in baseline → final state. Sessions without baseline (cold recovery hydration,
    // New historical sessions that appear after downgrading) do not play back the final state; active sessions must first be run/prewarming
    // Enter the baseline (gateway fan-out for each event), and the real closure will not be missed.
    const becameTerminal =
      previous !== undefined && !isTerminalPhase(previous.phase) && isTerminalPhase(next.phase);
    if (becameTerminal) {
      applyTerminalTransition(target, next, {
        moveGroupedTaskToTop: becameVisibleTask,
      });
      return;
    }
    if (becameVisibleTask) {
      // v4 warm-up session is promoted from draft, or when a new session appears for the first time in online delta,
      // Not going through zcodeSessionService.createSession. Here is the earliest new task boundary that does not depend on title timing;
      // Immediately write task lines and grouped root minimum sort_order back to the source to prevent out-of-order nodes from falling to the end.
      void resyncTaskIndexRowFromAgent(target, "session.became-visible", {
        moveGroupedTaskToTop: true,
      });
      return;
    }
    const title = next.title.trim();
    if (title && (previous === undefined || previous.title !== next.title)) {
      applyTitleChange(target, title);
    }
  }

  async function seedMissingRowsFromInitialSnapshot(
    state: WorkspaceIngestState,
    summaries: Iterable<SessionSummary>,
  ): Promise<void> {
    const candidates = [...summaries].filter((summary) => summary.phase !== "draft");
    if (candidates.length === 0) return;
    // Pure V4 UI does not go through zcodeSessionService.initializeWorkspace; if the first frame
    // As a silent baseline of "existing sqlite stock", the remote new library will always have 0 rows. Only atoms are done here
    // insert-if-missing, does not broadcast, does not play back the historical final state, and does not overwrite the existing product shell state; subsequently open /
    // When closing, the complete snapshot is used to supplement model, text search and other authoritative fields.
    // Disaster protection: There may be many historical sessions, and the same number of Promises cannot be created at once to crowd out the host event loop.
    // Fixed small batch writing; only one production log will be summarized upon failure to avoid session-by-session errors causing log storms again.
    let failedCount = 0;
    let firstError: unknown;
    for (let offset = 0; offset < candidates.length; offset += INITIAL_BASELINE_SEED_BATCH_SIZE) {
      const batch = candidates.slice(offset, offset + INITIAL_BASELINE_SEED_BATCH_SIZE);
      const results = await Promise.allSettled(
        batch.map((summary) =>
          taskIndexRepo.seedTaskMetaIfMissing(buildBaselineMetaFromSummary(state.target, summary)),
        ),
      );
      for (const result of results) {
        if (result.status === "rejected") {
          failedCount += 1;
          firstError ??= result.reason;
        }
      }
    }
    if (failedCount > 0) {
      logger.warn(
        undefined,
        `initial sessions-index baseline backfill of the task index failed workspace=${resolveWorkspaceKey(state.target)} failed=${failedCount} total=${candidates.length}`,
        firstError,
      );
    }
  }

  function deliveryKindOf(event: unknown): TopicDeliveryKind {
    const deliveryKind = (event as { deliveryKind?: unknown }).deliveryKind;
    return deliveryKind === "initial" || deliveryKind === "recovery" ? deliveryKind : "online";
  }

  function faultDeliveryKindOf(event: unknown): TopicDeliveryKind | undefined {
    const deliveryKind = (event as { fault?: { deliveryKind?: unknown } }).fault?.deliveryKind;
    return deliveryKind === "initial" || deliveryKind === "online" || deliveryKind === "recovery"
      ? deliveryKind
      : undefined;
  }

  function isLiveState(state: WorkspaceIngestState): boolean {
    return !disposed && workspaceIngests.get(resolveWorkspaceKey(state.target)) === state;
  }

  function clearRecoveryDeadline(recovery: TopicRecoveryState | null): void {
    if (!recovery?.frameDeadline) return;
    clearTimeout(recovery.frameDeadline);
    recovery.frameDeadline = null;
  }

  function discardIndexRecovery(state: WorkspaceIngestState): void {
    clearRecoveryDeadline(state.indexRecovery);
    state.indexRecovery = null;
  }

  function discardConfigRecovery(state: WorkspaceIngestState): void {
    clearRecoveryDeadline(state.configRecovery);
    state.configRecovery = null;
  }

  function settleIndexRecovery(state: WorkspaceIngestState, recovery: TopicRecoveryState): void {
    if (state.indexRecovery !== recovery || !recovery.ackReceived) return;
    if (recovery.upgradeToSnapshot) {
      discardIndexRecovery(state);
      if (recovery.forceSnapshot) void subscribeIndexTopic(state, "snapshot-recovery-gap", true);
      else requestIndexRecovery(state, true);
      return;
    }
    if (recovery.frameApplied) {
      const followup = recovery.postRecoveryGapPending;
      discardIndexRecovery(state);
      if (followup) requestIndexRecovery(state, false);
      return;
    }
    if (recovery.frameDeadline) return;
    recovery.frameDeadline = setTimeout(() => {
      recovery.frameDeadline = null;
      if (!isLiveState(state) || state.indexRecovery !== recovery || recovery.frameApplied) return;
      discardIndexRecovery(state);
      if (!recovery.forceSnapshot) requestIndexRecovery(state, true);
      else void subscribeIndexTopic(state, "recovery-frame-timeout", true);
    }, PROTOCOL_V4_LIMITS.logicalFrameAssemblyTimeoutMs);
    recovery.frameDeadline.unref?.();
  }

  function settleConfigRecovery(state: WorkspaceIngestState, recovery: TopicRecoveryState): void {
    if (state.configRecovery !== recovery || !recovery.ackReceived) return;
    if (recovery.upgradeToSnapshot) {
      discardConfigRecovery(state);
      if (recovery.forceSnapshot) void subscribeConfigTopic(state, "snapshot-recovery-gap", true);
      else requestConfigRecovery(state, true);
      return;
    }
    if (recovery.frameApplied) {
      const followup = recovery.postRecoveryGapPending;
      discardConfigRecovery(state);
      if (followup) requestConfigRecovery(state, false);
      return;
    }
    if (recovery.frameDeadline) return;
    recovery.frameDeadline = setTimeout(() => {
      recovery.frameDeadline = null;
      if (!isLiveState(state) || state.configRecovery !== recovery || recovery.frameApplied) return;
      discardConfigRecovery(state);
      if (!recovery.forceSnapshot) requestConfigRecovery(state, true);
      else void subscribeConfigTopic(state, "recovery-frame-timeout", true);
    }, PROTOCOL_V4_LIMITS.logicalFrameAssemblyTimeoutMs);
    recovery.frameDeadline.unref?.();
  }

  function completeIndexRecoveryFrame(
    state: WorkspaceIngestState,
    deliveryKind: TopicDeliveryKind,
  ): void {
    if (deliveryKind !== "recovery" || !state.indexRecovery) return;
    state.indexRecovery.frameApplied = true;
    settleIndexRecovery(state, state.indexRecovery);
  }

  function completeConfigRecoveryFrame(
    state: WorkspaceIngestState,
    deliveryKind: TopicDeliveryKind,
  ): void {
    if (deliveryKind !== "recovery" || !state.configRecovery) return;
    state.configRecovery.frameApplied = true;
    settleConfigRecovery(state, state.configRecovery);
  }

  function requestIndexRecovery(state: WorkspaceIngestState, forceSnapshot = false): void {
    const subscriptionId = state.indexSubscriptionId;
    if (!subscriptionId || !isLiveState(state)) return;
    const active = state.indexRecovery;
    if (active) {
      if (forceSnapshot && !active.forceSnapshot) {
        active.upgradeToSnapshot = true;
        settleIndexRecovery(state, active);
      }
      return;
    }
    const effectiveForceSnapshot =
      forceSnapshot || !state.indexHasAppliedBase || state.indexLogEpoch === null;
    const recovery: TopicRecoveryState = {
      generation: ++state.indexRecoveryGeneration,
      subscriptionId,
      forceSnapshot: effectiveForceSnapshot,
      ackReceived: false,
      frameApplied: false,
      upgradeToSnapshot: false,
      postRecoveryGapPending: false,
      frameDeadline: null,
    };
    state.indexRecovery = recovery;
    const base = effectiveForceSnapshot
      ? null
      : { logEpoch: state.indexLogEpoch!, seq: state.indexSeq };
    void agentService
      .resyncSessionsIndexV4({
        ...state.target,
        subscriptionId,
        base,
        runtimePolicy: "existing-only",
        ...(effectiveForceSnapshot ? { forceSnapshot: true } : {}),
      })
      .then((result) => {
        if (!isLiveState(state) || state.indexRecovery !== recovery) return;
        if (
          state.indexSubscriptionId !== subscriptionId ||
          result.ack.subscriptionId !== subscriptionId
        ) {
          discardIndexRecovery(state);
          void subscribeIndexTopic(state, "resync-ack-mismatch", true);
          return;
        }
        recovery.ackReceived = true;
        recovery.forceSnapshot ||= result.ack.mode === "snapshot";
        settleIndexRecovery(state, recovery);
      })
      .catch((error) => {
        if (!isLiveState(state) || state.indexRecovery !== recovery) return;
        discardIndexRecovery(state);
        logger.warn(
          undefined,
          `task index sessions-index resync failed, falling back to a fresh subscription workspace=${state.target.workspacePath}`,
          error,
        );
        void subscribeIndexTopic(state, "resync-failed", true);
      });
  }

  function requestConfigRecovery(state: WorkspaceIngestState, forceSnapshot = false): void {
    const subscriptionId = state.configSubscriptionId;
    if (!subscriptionId || !isLiveState(state)) return;
    const active = state.configRecovery;
    if (active) {
      if (forceSnapshot && !active.forceSnapshot) {
        active.upgradeToSnapshot = true;
        settleConfigRecovery(state, active);
      }
      return;
    }
    const effectiveForceSnapshot =
      forceSnapshot || !state.configHasAppliedBase || state.configLogEpoch === null;
    const recovery: TopicRecoveryState = {
      generation: ++state.configRecoveryGeneration,
      subscriptionId,
      forceSnapshot: effectiveForceSnapshot,
      ackReceived: false,
      frameApplied: false,
      upgradeToSnapshot: false,
      postRecoveryGapPending: false,
      frameDeadline: null,
    };
    state.configRecovery = recovery;
    const base = effectiveForceSnapshot
      ? null
      : { logEpoch: state.configLogEpoch!, seq: state.configSeq };
    void agentService
      .resyncWorkspaceConfigV4({
        ...state.target,
        subscriptionId,
        base,
        runtimePolicy: "existing-only",
        ...(effectiveForceSnapshot ? { forceSnapshot: true } : {}),
      })
      .then((result) => {
        if (!isLiveState(state) || state.configRecovery !== recovery) return;
        if (
          state.configSubscriptionId !== subscriptionId ||
          result.ack.subscriptionId !== subscriptionId
        ) {
          discardConfigRecovery(state);
          void subscribeConfigTopic(state, "resync-ack-mismatch", true);
          return;
        }
        recovery.ackReceived = true;
        recovery.forceSnapshot ||= result.ack.mode === "snapshot";
        settleConfigRecovery(state, recovery);
      })
      .catch((error) => {
        if (!isLiveState(state) || state.configRecovery !== recovery) return;
        discardConfigRecovery(state);
        logger.warn(
          undefined,
          `task index workspace-config resync failed, falling back to a fresh subscription workspace=${state.target.workspacePath}`,
          error,
        );
        void subscribeConfigTopic(state, "resync-failed", true);
      });
  }

  function handleIndexGap(state: WorkspaceIngestState, deliveryKind: TopicDeliveryKind): void {
    if (deliveryKind === "recovery") {
      const recovery = state.indexRecovery;
      if (!recovery) return;
      if (recovery.forceSnapshot) {
        // If the forced snapshot is still unavailable, it means that the current same-sub stream is no longer verifiable.
        // You cannot continue to guess the splicing, and instead subscribe to the new generation snapshot of the topic.
        discardIndexRecovery(state);
        void subscribeIndexTopic(state, "force-recovery-gap", true);
      } else {
        requestIndexRecovery(state, true);
      }
      return;
    }
    requestIndexRecovery(state);
  }

  function handleConfigGap(state: WorkspaceIngestState, deliveryKind: TopicDeliveryKind): void {
    if (deliveryKind === "recovery") {
      const recovery = state.configRecovery;
      if (!recovery) return;
      if (recovery.forceSnapshot) {
        discardConfigRecovery(state);
        void subscribeConfigTopic(state, "force-recovery-gap", true);
      } else {
        requestConfigRecovery(state, true);
      }
      return;
    }
    requestConfigRecovery(state);
  }

  function applySessionsIndexFrame(
    state: WorkspaceIngestState,
    frame: SessionsIndexTopicFrame,
    deliveryKind: TopicDeliveryKind,
  ): void {
    if (disposed) return;
    if (deliveryKind === "online" && state.indexRecovery && frame.payload.kind === "deltas") {
      if (state.indexRecovery.frameApplied && frame.toSeq > state.indexSeq) {
        state.indexRecovery.postRecoveryGapPending = true;
      }
      return;
    }
    if (frame.payload.kind === "snapshot") {
      if (deliveryKind === "online" && state.indexHasAppliedBase && frame.toSeq <= state.indexSeq) {
        return;
      }
      state.indexLogEpoch = frame.payload.snapshot.logEpoch;
      state.indexSeq = frame.toSeq;
      state.indexHasAppliedBase = true;
      const nextSummaries = new Map<string, SessionSummary>();
      for (const summary of frame.payload.snapshot.sessions) {
        nextSummaries.set(summary.sessionId, summary);
      }
      if (!state.seeded) {
        // First frame = silent baseline: do not play back the historical final state, do not send list broadcasts; only complete missing lines atomically,
        // Prevent remote/newly installed empty sqlite from being stored in pure V4 paths.
        state.summaries = nextSummaries;
        state.seeded = true;
        void seedMissingRowsFromInitialSnapshot(state, nextSummaries.values());
        const generation = state.indexSubscriptionGeneration;
        void repairSubagentTaskIndex({
          target: state.target,
          visibleSessionIds: new Set(nextSummaries.keys()),
          agentService,
          taskIndexRepo,
          isCurrent: () => isLiveState(state) && state.indexSubscriptionGeneration === generation,
          onRemoved: () =>
            emitWorkspaceTaskListChanged(state.target, undefined, "task_meta_changed"),
        }).catch((error) => {
          logger.warn(
            undefined,
            `subagent history list index repair failed workspace=${resolveWorkspaceKey(state.target)}`,
            error,
          );
        });
        completeIndexRecoveryFrame(state, deliveryKind);
        return;
      }
      // Snapshot downgrade: baseline diff post-processing, which is equivalent to re-injecting lost deltas (conflated semantics).
      const previousSummaries = state.summaries;
      state.summaries = new Map();
      for (const summary of nextSummaries.values()) {
        processSummary(state, previousSummaries.get(summary.sessionId), summary, deliveryKind);
      }
      completeIndexRecoveryFrame(state, deliveryKind);
      return;
    }
    if (!state.indexHasAppliedBase) {
      // fresh task-index subscribe never carries base; any delta cannot be used after the initial batch is lost
      // Establish a cold baseline. Only owned snapshots can prove complete status.
      handleIndexGap(state, deliveryKind === "recovery" ? "recovery" : "online");
      return;
    }
    if (frame.toSeq <= state.indexSeq) {
      // Any fully verified recovery can be confirmed if it has been overwritten by a later authoritative snapshot/online
      // The delivery is successful; ordinary duplicate frames are still silently discarded.
      if (deliveryKind === "recovery" && state.indexHasAppliedBase) {
        completeIndexRecoveryFrame(state, deliveryKind);
      }
      return;
    }
    if (frame.fromSeq !== state.indexSeq) {
      handleIndexGap(state, deliveryKind);
      return;
    }
    for (const delta of frame.payload.deltas) {
      if (delta.op === "session.upserted") {
        processSummary(
          state,
          state.summaries.get(delta.session.sessionId),
          delta.session,
          deliveryKind,
        );
        continue;
      }
      // session.removed: sqlite closes the session deletion task deletion operation (adapter deleteTask /
      // The end of the host side of the v4 deleteSession command), only the baseline is maintained here.
      state.summaries.delete(delta.sessionId);
    }
    state.indexSeq = frame.toSeq;
    state.indexHasAppliedBase = true;
    completeIndexRecoveryFrame(state, deliveryKind);
  }

  function applyWorkspaceConfigFrame(
    state: WorkspaceIngestState,
    frame: WorkspaceConfigTopicFrame,
    deliveryKind: TopicDeliveryKind,
  ): void {
    if (disposed) return;
    if (deliveryKind === "online" && state.configRecovery && frame.payload.kind === "deltas") {
      if (state.configRecovery.frameApplied && frame.toSeq > state.configSeq) {
        state.configRecovery.postRecoveryGapPending = true;
      }
      return;
    }
    if (frame.payload.kind === "snapshot") {
      if (
        deliveryKind === "online" &&
        state.configHasAppliedBase &&
        frame.toSeq <= state.configSeq
      ) {
        return;
      }
      state.configLogEpoch = frame.payload.snapshot.logEpoch;
      state.configSeq = frame.toSeq;
      state.configHasAppliedBase = true;
    } else {
      if (!state.configHasAppliedBase) {
        handleConfigGap(state, deliveryKind === "recovery" ? "recovery" : "online");
        return;
      }
      if (frame.toSeq <= state.configSeq) {
        if (deliveryKind === "recovery" && state.configHasAppliedBase) {
          completeConfigRecoveryFrame(state, deliveryKind);
        }
        return;
      }
      if (frame.fromSeq !== state.configSeq) {
        handleConfigGap(state, deliveryKind);
        return;
      }
      state.configSeq = frame.toSeq;
      state.configHasAppliedBase = true;
    }
    const config =
      frame.payload.kind === "snapshot"
        ? frame.payload.snapshot.config
        : frame.payload.deltas.at(-1)?.config;
    if (!config || config.configOptions.length === 0) {
      // Empty directories (subscription seeds without live sessions) are not delivered: downstream useZCodeConfig receives empty
      // configOptions will clear the model directory of the chat toolbar.
      completeConfigRecoveryFrame(state, deliveryKind);
      return;
    }
    // The v4 payload is aligned with the ZCodeConfigOption structure (shared gold test endorsement), zero mapping passthrough,
    // The downstream workspace_config_options_update consumer side (useZCodeConfig, etc.) does not change.
    getWorkspaceEmitter({
      workspacePath: state.target.workspacePath,
      workspaceIdentity: state.target.workspaceIdentity,
    }).fire({
      type: "workspace_config_options_update",
      workspacePath: state.target.workspacePath,
      workspaceIdentity: state.target.workspaceIdentity,
      configOptions: config.configOptions,
    });
    completeConfigRecoveryFrame(state, deliveryKind);
  }

  function markAssemblyFault(
    state: WorkspaceIngestState,
    kind: "sessions-index" | "workspace-config",
    reasonCode: string,
    deliveryKind: TopicDeliveryKind | undefined,
  ): void {
    logger.warn(
      undefined,
      `task index ${kind} physical assembly failed reason=${reasonCode} workspace=${resolveWorkspaceKey(state.target)}`,
    );
    if (kind === "sessions-index") {
      if (deliveryKind === "online" && state.indexRecovery) {
        state.indexRecovery.postRecoveryGapPending ||= state.indexRecovery.frameApplied;
        return;
      }
      // The owned fault of malformed deliveryKind cannot be reduced to online and then stuck and already has flight;
      // Upgrade has been advanced by recovery fault on recovery, otherwise normal same-sub resync is initiated.
      handleIndexGap(state, deliveryKind ?? (state.indexRecovery ? "recovery" : "online"));
    } else {
      if (deliveryKind === "online" && state.configRecovery) {
        state.configRecovery.postRecoveryGapPending ||= state.configRecovery.frameApplied;
        return;
      }
      handleConfigGap(state, deliveryKind ?? (state.configRecovery ? "recovery" : "online"));
    }
  }

  function scheduleAssemblyExpiry(state: WorkspaceIngestState): void {
    if (state.assemblyTimer) clearTimeout(state.assemblyTimer);
    const expiries = [state.indexAssembler.nextExpiryAt, state.configAssembler.nextExpiryAt].filter(
      (value): value is number => value !== null,
    );
    if (expiries.length === 0) {
      state.assemblyTimer = null;
      return;
    }
    const nextExpiryAt = Math.min(...expiries);
    const timer = setTimeout(
      () => {
        state.assemblyTimer = null;
        const now = Date.now();
        for (const event of state.indexAssembler.expire(now)) {
          if (event.kind === "fault") {
            markAssemblyFault(
              state,
              "sessions-index",
              event.fault.reasonCode,
              faultDeliveryKindOf(event),
            );
          }
        }
        for (const event of state.configAssembler.expire(now)) {
          if (event.kind === "fault") {
            markAssemblyFault(
              state,
              "workspace-config",
              event.fault.reasonCode,
              faultDeliveryKindOf(event),
            );
          }
        }
        scheduleAssemblyExpiry(state);
      },
      Math.max(0, nextExpiryAt - Date.now()),
    );
    timer.unref?.();
    state.assemblyTimer = timer;
  }

  function handleSessionsIndexWire(
    state: WorkspaceIngestState,
    wire: SessionsIndexTopicWireCandidate,
  ): void {
    if (disposed || wire.topic !== indexTopicFor(state)) return;
    // ownership must precede assembly; foreign sub must not occupy decoded staging.
    if (state.indexSubscriptionId === null) {
      if (state.indexPending) {
        stagePendingFrame(state, "sessions-index", state.indexPending, wire);
      }
      return;
    }
    if (wire.subscriptionId !== state.indexSubscriptionId) return;
    const events = state.indexAssembler.accept(wire);
    const fault = events.find((event) => event.kind === "fault");
    if (fault?.kind === "fault") {
      state.indexAssembler.abort(wire.topic, wire.subscriptionId);
      markAssemblyFault(
        state,
        "sessions-index",
        fault.fault.reasonCode,
        faultDeliveryKindOf(fault),
      );
    } else {
      for (const event of events) {
        if (event.kind === "complete") {
          applySessionsIndexFrame(state, event.frame, deliveryKindOf(event));
        }
      }
    }
    scheduleAssemblyExpiry(state);
  }

  function handleWorkspaceConfigWire(
    state: WorkspaceIngestState,
    wire: WorkspaceConfigTopicWireCandidate,
  ): void {
    if (disposed || wire.topic !== configTopicFor(state)) return;
    if (state.configSubscriptionId === null) {
      if (state.configPending) {
        stagePendingFrame(state, "workspace-config", state.configPending, wire);
      }
      return;
    }
    if (wire.subscriptionId !== state.configSubscriptionId) return;
    const events = state.configAssembler.accept(wire);
    const fault = events.find((event) => event.kind === "fault");
    if (fault?.kind === "fault") {
      state.configAssembler.abort(wire.topic, wire.subscriptionId);
      markAssemblyFault(
        state,
        "workspace-config",
        fault.fault.reasonCode,
        faultDeliveryKindOf(fault),
      );
    } else {
      for (const event of events) {
        if (event.kind === "complete") {
          applyWorkspaceConfigFrame(state, event.frame, deliveryKindOf(event));
        }
      }
    }
    scheduleAssemblyExpiry(state);
  }

  async function activateIndexSubscribe(
    state: WorkspaceIngestState,
    generation: number,
    pending: PendingTopicFrames<SessionsIndexTopicWireCandidate>,
    result: V4SessionsIndexSubscribeResult,
  ): Promise<void> {
    const stale =
      disposed ||
      generation !== state.indexSubscriptionGeneration ||
      pending.generation !== generation ||
      workspaceIngests.get(resolveWorkspaceKey(state.target)) !== state;
    if (stale) {
      discardPendingFrames(pending);
      // Runtime replacement may reuse subscriptionId; late old ACK cannot
      // Reverse unsubscribe from the same id route that has been taken over by the new generation.
      if (state.indexSubscriptionId !== result.ack.subscriptionId) {
        await unsubscribeIndex(state, result.ack.subscriptionId);
      }
      return;
    }
    if (state.indexPending === pending) state.indexPending = null;
    if (pending.recoveryNeeded) {
      discardPendingFrames(pending);
      await unsubscribeIndex(state, result.ack.subscriptionId);
      if (generation === state.indexSubscriptionGeneration && isLiveState(state)) {
        void subscribeIndexTopic(state, "pre-ack-overflow", false);
      }
      return;
    }
    state.indexSubscriptionId = result.ack.subscriptionId;
    state.indexLogEpoch = result.ack.logEpoch;
    state.indexSeq = 0;
    // epoch/seq0 of subscribe ACK is just admission metadata; initial physical
    // The frame may not be fragmented yet or the verification may fail. Only logical snapshot/delta atoms have base after apply.
    state.indexHasAppliedBase = false;
    discardIndexRecovery(state);
    state.indexRetryAttempt = 0;
    state.indexLastWarnAt = null;
    const frames = pending.recoveryNeeded ? [] : [...pending.frames];
    discardPendingFrames(pending);
    for (const frame of frames) {
      if (frame.subscriptionId === result.ack.subscriptionId) {
        handleSessionsIndexWire(state, frame);
      }
    }
  }

  async function activateConfigSubscribe(
    state: WorkspaceIngestState,
    generation: number,
    pending: PendingTopicFrames<WorkspaceConfigTopicWireCandidate>,
    result: V4WorkspaceConfigSubscribeResult,
  ): Promise<void> {
    const stale =
      disposed ||
      generation !== state.configSubscriptionGeneration ||
      pending.generation !== generation ||
      workspaceIngests.get(resolveWorkspaceKey(state.target)) !== state;
    if (stale) {
      discardPendingFrames(pending);
      if (state.configSubscriptionId !== result.ack.subscriptionId) {
        await unsubscribeConfig(state, result.ack.subscriptionId);
      }
      return;
    }
    if (state.configPending === pending) state.configPending = null;
    if (pending.recoveryNeeded) {
      discardPendingFrames(pending);
      await unsubscribeConfig(state, result.ack.subscriptionId);
      if (generation === state.configSubscriptionGeneration && isLiveState(state)) {
        void subscribeConfigTopic(state, "pre-ack-overflow", false);
      }
      return;
    }
    state.configSubscriptionId = result.ack.subscriptionId;
    state.configLogEpoch = result.ack.logEpoch;
    state.configSeq = 0;
    state.configHasAppliedBase = false;
    discardConfigRecovery(state);
    state.configRetryAttempt = 0;
    state.configLastWarnAt = null;
    const frames = pending.recoveryNeeded ? [] : [...pending.frames];
    discardPendingFrames(pending);
    for (const frame of frames) {
      if (frame.subscriptionId === result.ack.subscriptionId) {
        handleWorkspaceConfigWire(state, frame);
      }
    }
  }

  function scheduleIndexRetry(state: WorkspaceIngestState, retryKind: TopicRetryKind): void {
    if (!isLiveState(state) || state.indexRetryTimer) return;
    const delay =
      retryKind === "provider-not-ready"
        ? PROVIDER_NOT_READY_RETRY_MS
        : Math.min(1_000, 25 * 2 ** Math.min(state.indexRetryAttempt, 5));
    state.indexRetryAttempt += 1;
    const timer = setTimeout(() => {
      state.indexRetryTimer = null;
      if (isLiveState(state)) {
        void subscribeIndexTopic(
          state,
          retryKind === "provider-not-ready" ? "provider-not-ready-wait" : "retry",
          false,
        );
      }
    }, delay);
    timer.unref?.();
    state.indexRetryTimer = timer;
  }

  function scheduleConfigRetry(state: WorkspaceIngestState, retryKind: TopicRetryKind): void {
    if (!isLiveState(state) || state.configRetryTimer) return;
    const delay =
      retryKind === "provider-not-ready"
        ? PROVIDER_NOT_READY_RETRY_MS
        : Math.min(1_000, 25 * 2 ** Math.min(state.configRetryAttempt, 5));
    state.configRetryAttempt += 1;
    const timer = setTimeout(() => {
      state.configRetryTimer = null;
      if (isLiveState(state)) {
        void subscribeConfigTopic(
          state,
          retryKind === "provider-not-ready" ? "provider-not-ready-wait" : "retry",
          false,
        );
      }
    }, delay);
    timer.unref?.();
    state.configRetryTimer = timer;
  }

  async function subscribeIndexTopic(
    state: WorkspaceIngestState,
    reason: TopicSubscribeReason,
    unsubscribeActive: boolean,
  ): Promise<void> {
    if (!isLiveState(state)) return;
    if (state.indexRetryTimer) clearTimeout(state.indexRetryTimer);
    state.indexRetryTimer = null;
    const generation = ++state.indexSubscriptionGeneration;
    const previousSubscriptionId = state.indexSubscriptionId;
    state.indexSubscriptionId = null;
    discardIndexRecovery(state);
    clearIndexPendingState(state);
    if (unsubscribeActive && previousSubscriptionId) {
      await unsubscribeIndex(state, previousSubscriptionId);
      if (!isLiveState(state) || generation !== state.indexSubscriptionGeneration) return;
    }
    const indexPending = createPendingFrames<SessionsIndexTopicWireCandidate>(generation);
    state.indexPending = indexPending;
    try {
      const result = await agentService.subscribeSessionsIndexV4({
        ...state.target,
        visibility: "background",
        subscriberScope: TASK_INDEX_SUBSCRIBER_SCOPE,
        runtimePolicy: "existing-only",
      });
      await activateIndexSubscribe(state, generation, indexPending, result);
    } catch (error) {
      if (isLiveState(state) && state.indexSubscriptionGeneration === generation) {
        clearIndexPendingState(state);
        if (isRuntimeUnavailableError(error)) {
          state.runtimeGeneration = null;
          return;
        }
        const retryKind = isProviderNotReadyError(error) ? "provider-not-ready" : "transient";
        logTopicSubscribeFailure(state, "sessions-index", reason, error, retryKind);
        scheduleIndexRetry(state, retryKind);
      }
    }
  }

  async function subscribeConfigTopic(
    state: WorkspaceIngestState,
    reason: TopicSubscribeReason,
    unsubscribeActive: boolean,
  ): Promise<void> {
    if (!isLiveState(state)) return;
    if (state.configRetryTimer) clearTimeout(state.configRetryTimer);
    state.configRetryTimer = null;
    const generation = ++state.configSubscriptionGeneration;
    const previousSubscriptionId = state.configSubscriptionId;
    state.configSubscriptionId = null;
    discardConfigRecovery(state);
    clearConfigPendingState(state);
    if (unsubscribeActive && previousSubscriptionId) {
      await unsubscribeConfig(state, previousSubscriptionId);
      if (!isLiveState(state) || generation !== state.configSubscriptionGeneration) return;
    }
    const configPending = createPendingFrames<WorkspaceConfigTopicWireCandidate>(generation);
    state.configPending = configPending;
    try {
      const result = await agentService.subscribeWorkspaceConfigV4({
        ...state.target,
        visibility: "background",
        subscriberScope: TASK_INDEX_SUBSCRIBER_SCOPE,
        runtimePolicy: "existing-only",
      });
      await activateConfigSubscribe(state, generation, configPending, result);
    } catch (error) {
      if (isLiveState(state) && state.configSubscriptionGeneration === generation) {
        clearConfigPendingState(state);
        if (isRuntimeUnavailableError(error)) {
          state.runtimeGeneration = null;
          return;
        }
        const retryKind = isProviderNotReadyError(error) ? "provider-not-ready" : "transient";
        logTopicSubscribeFailure(state, "workspace-config", reason, error, retryKind);
        scheduleConfigRetry(state, retryKind);
      }
    }
  }

  function ensureWorkspaceFrameListeners(state: WorkspaceIngestState): void {
    if (!isLiveState(state) || state.frameListenersInstalled) return;
    const workspace = state.target;
    // dormant state skips the first establishment, but goes directly after runtime available
    // resubscribe; if the default listener already exists, the initial of response will follow in the same read
    // The frame is not consumed by anyone. The listener must be installed synchronously before any subscribe and reused across runtime generations.
    state.disposables.push(
      agentService.onDynamicSessionsIndexFrame(workspace)((frame) =>
        handleSessionsIndexWire(state, frame),
      ),
      agentService.onDynamicWorkspaceConfigFrame(workspace)((frame) =>
        handleWorkspaceConfigWire(state, frame),
      ),
    );
    state.frameListenersInstalled = true;
  }

  async function establishWorkspaceSubscriptions(state: WorkspaceIngestState): Promise<void> {
    // First hang frame monitoring and then initiate subscription: the same read on stdio will first resolve response promise and then synchronize fire
    // initial notification, and await continuation has not yet run; therefore the handler must staging,
    // Don't mistake "byte response first" for "subscriptionId has taken effect in the JS state".
    ensureWorkspaceFrameListeners(state);
    await Promise.all([
      subscribeIndexTopic(state, "initial", false),
      subscribeConfigTopic(state, "initial", false),
    ]);
  }

  /**
   * (CLI reconnect resubscribe): after the agent process generation changes, every subscription held in
   * the CLI's memory is lost and no gap frame ever arrives (the subscription goes silently dead);
   * the placeholder early return in ensureWorkspaceSubscription will not resubscribe either. So this
   * resends subscribe per workspaceKey: the frame listener hangs off the persistent workspace-level
   * emitter (the agentService wireClient reconnects automatically across generations), so only the
   * subscriptionId gate needs refreshing; the new snapshot frame converges for an already-seeded
   * baseline via the existing "gap-degraded snapshot" diff path.
   */
  function resubscribeWorkspaceAfterRuntimeRestart(workspaceKey: string): void {
    if (disposed) return;
    const state = workspaceIngests.get(workspaceKey);
    if (!state) return;
    ensureWorkspaceFrameListeners(state);
    // The previous two topics share the Promise.all generation, and transient failure on one side will
    // Undo a new subscription that has been successful on the other side. Now each fresh subscribe + backoff retry.
    void subscribeIndexTopic(state, "runtime-restart", false);
    void subscribeConfigTopic(state, "runtime-restart", false);
  }

  const availableRuntimeGenerationByWorkspaceKey = new Map<string, number>();
  const hasRuntimeLifecycle = Boolean(agentService.onAgentRuntimeLifecycle);

  function suspendWorkspaceAfterRuntimeUnavailable(workspaceKey: string, generation: number): void {
    const state = workspaceIngests.get(workspaceKey);
    if (!state || state.runtimeGeneration !== generation) return;
    state.runtimeGeneration = null;
    state.indexSubscriptionGeneration += 1;
    state.configSubscriptionGeneration += 1;
    state.indexRecoveryGeneration += 1;
    state.configRecoveryGeneration += 1;
    if (state.indexRetryTimer) clearTimeout(state.indexRetryTimer);
    if (state.configRetryTimer) clearTimeout(state.configRetryTimer);
    state.indexRetryTimer = null;
    state.configRetryTimer = null;
    discardIndexRecovery(state);
    discardConfigRecovery(state);
    clearPendingState(state);
    // Calling unsubscribe/retry after the runtime has exited will re-enter getClient.
    // unavailable only clears local ownership; the subscription in the CLI has been destroyed along with the process, and cleanup RPCs will no longer be sent.
    state.indexSubscriptionId = null;
    state.configSubscriptionId = null;
  }

  const runtimeLifecycleDisposable = agentService.onAgentRuntimeLifecycle?.((event) => {
    if (disposed) return;
    if (event.state === "unavailable") {
      if (
        availableRuntimeGenerationByWorkspaceKey.get(event.workspaceKey) ===
        event.runtimeIdentity.generation
      ) {
        availableRuntimeGenerationByWorkspaceKey.delete(event.workspaceKey);
      }
      suspendWorkspaceAfterRuntimeUnavailable(event.workspaceKey, event.runtimeIdentity.generation);
      return;
    }

    availableRuntimeGenerationByWorkspaceKey.set(
      event.workspaceKey,
      event.runtimeIdentity.generation,
    );
    const existing = workspaceIngests.get(event.workspaceKey);
    if (!existing) {
      ensureWorkspaceSubscription({
        workspacePath: event.workspacePath,
        workspaceIdentity: event.workspaceIdentity,
      });
      return;
    }
    if (existing.runtimeGeneration === event.runtimeIdentity.generation) return;
    existing.runtimeGeneration = event.runtimeIdentity.generation;
    resubscribeWorkspaceAfterRuntimeRestart(event.workspaceKey);
  });

  // The old test fixture/host remains restart compatible when there is no lifecycle; production only uses available/unavailable.
  const runtimeRestartedDisposable = hasRuntimeLifecycle
    ? undefined
    : agentService.onAgentRuntimeRestarted?.((event) =>
        resubscribeWorkspaceAfterRuntimeRestart(event.workspaceKey),
      );

  function ensureWorkspaceSubscription(target: ZCodeAgentWorkspaceTarget): void {
    if (disposed) {
      return;
    }
    if (!target.workspacePath) {
      return;
    }
    const key = resolveWorkspaceKey(target);
    if (workspaceIngests.has(key)) {
      return;
    }
    const state: WorkspaceIngestState = {
      target: {
        workspacePath: target.workspacePath,
        workspaceIdentity: target.workspaceIdentity,
      },
      runtimeGeneration: availableRuntimeGenerationByWorkspaceKey.get(key) ?? null,
      indexSubscriptionId: null,
      configSubscriptionId: null,
      indexSubscriptionGeneration: 0,
      configSubscriptionGeneration: 0,
      indexPending: null,
      configPending: null,
      indexLogEpoch: null,
      indexSeq: 0,
      configLogEpoch: null,
      configSeq: 0,
      indexHasAppliedBase: false,
      configHasAppliedBase: false,
      indexRecovery: null,
      configRecovery: null,
      indexRecoveryGeneration: 0,
      configRecoveryGeneration: 0,
      indexRetryTimer: null,
      configRetryTimer: null,
      indexRetryAttempt: 0,
      configRetryAttempt: 0,
      indexLastWarnAt: null,
      configLastWarnAt: null,
      summaries: new Map(),
      seeded: false,
      frameListenersInstalled: false,
      disposables: [],
      indexAssembler: new TopicWireFrameAssembler(sessionsIndexTopicFrameSchema),
      configAssembler: new TopicWireFrameAssembler(workspaceConfigTopicFrameSchema),
      assemblyTimer: null,
    };
    // The placeholders are written to the Map first to avoid repeated subscriptions during concurrent calls during subscription establishment.
    workspaceIngests.set(key, state);
    // When lifecycle is available, the workspace lacking runtime only retains the dormant placeholder; passive observer
    // The CLI must not be started. When the old host does not have a lifecycle, it will continue to use the compatibility behavior of explicit ensure.
    if (!hasRuntimeLifecycle || state.runtimeGeneration !== null) {
      void establishWorkspaceSubscriptions(state);
    }
  }

  async function syncSnapshotAndBroadcast(
    snapshot: ZCodeSessionStateSnapshot,
    options: {
      modelOverride?: string;
      thoughtLevelOverride?: string;
      moveGroupedTaskToTop?: boolean;
      unreadSignal?: ZCodeWorkspaceTaskListChanged["unreadSignal"];
      broadcastReason: ZCodeWorkspaceTaskListChanged["reason"];
    },
  ): Promise<ZCodeTaskMeta> {
    const meta = buildMetaFromSnapshot(snapshot, options);
    // An explicit resume of the old child tab still synchronizes the snapshot; read-only details cannot be rewritten as the main task.
    if (snapshot.session.sessionKind === "subagent_child") return meta;
    // At the same time, index the chat text visible in snapshot.messages.
    // Let the TaskSearchDialog text search hit; the old sqlite row will be naturally backfilled the next time it comes here.
    const searchableText = buildSearchableTextFromSnapshot(snapshot);
    // Desktop-continuous first submits task row and then adds grouped sort_order.
    // sessions-index will expose out-of-order tasks to the Renderer between two writes, causing a jump to the bottom and then back to the top.
    const { meta: persisted, initializedGroupedOrder } = options?.moveGroupedTaskToTop
      ? await taskIndexRepo.syncTaskMetaAtGroupedTop({ meta, searchableText })
      : {
          meta: await taskIndexRepo.syncTaskMeta({ meta, searchableText }),
          initializedGroupedOrder: false,
        };
    // When createSession first comes back, the snapshot has neither title nor user message.
    // The default title will be the "New session" placeholder. Such snapshots "without any user content yet" should not be broadcast to the UI,
    // Otherwise, the sidebar will flash "New session" first, and then change to the real prompt text after sendPrompt is completed.
    // The sqlite row still needs to be written so that the corresponding row can be found when subsequent title updates are performed using applyAgentPatch; that time
    // The broadcast triggered by the title is the first time the user sees this conversation in the list. The title is directly the prompt text and will not flash.
    if (!hasUserVisibleContent(snapshot)) {
      if (initializedGroupedOrder) {
        // When the warm-up session is promoted from draft, the grouped order will be dropped before the first title.
        // Even if there is no task meta that can be broadcast temporarily, the renderer must be notified to repulse the structure;
        // Otherwise, sessions-index has shown that task and structure are still out of order, and the current process will add them to the end.
        emitWorkspaceTaskListChanged(
          {
            workspacePath: persisted.workspacePath,
            workspaceIdentity: persisted.workspaceIdentity,
            taskId: persisted.taskId,
          },
          undefined,
          "task_created",
        );
      }
      return persisted;
    }
    emitWorkspaceTaskListChanged(
      {
        workspacePath: persisted.workspacePath,
        workspaceIdentity: persisted.workspaceIdentity,
        taskId: persisted.taskId,
      },
      persisted,
      // The sessions-index visible frame may be older than the first grouped sort_order drop.
      // The first initialization must use task_created to notify the running grouped structure cache of invalidation;
      // There is no new order for repeated snapshots, and the original status/title semantics of the caller are still retained.
      initializedGroupedOrder ? "task_created" : options.broadcastReason,
      options.unreadSignal ? { unreadSignal: options.unreadSignal } : undefined,
    );
    return persisted;
  }

  async function syncTaskModel(
    target: ZCodeAgentSessionTarget,
    model: string,
  ): Promise<ZCodeTaskMeta | null> {
    const normalizedModel = model.trim();
    if (!normalizedModel) {
      return null;
    }
    try {
      return await taskIndexRepo.updateTaskState({
        workspacePath: target.workspacePath,
        workspaceIdentity: target.workspaceIdentity,
        taskId: target.sessionId,
        patch: { model: normalizedModel },
      });
    } catch (error) {
      logger.warn(
        undefined,
        `failed to sync the task model to the task index taskId=${target.sessionId}`,
        error,
      );
      return null;
    }
  }

  return {
    ensureWorkspaceSubscription,

    ensureSessionSubscription(
      target: ZCodeAgentSessionTarget,
      _options?: {
        includeSnapshot?: boolean;
      },
    ): void {
      if (!target.sessionId || !target.workspacePath) {
        return;
      }
      ensureWorkspaceSubscription({
        workspacePath: target.workspacePath,
        workspaceIdentity: target.workspaceIdentity,
      });
    },

    syncSnapshotAndBroadcast,

    syncTaskModel,

    emitWorkspaceTaskListChanged,

    getWorkspaceEmitter,

    onDynamicWorkspaceEvent(workspace: WorkspaceEventInput) {
      // Task list mounting will call this entry for all restored workspaces. Listening for events does not mean
      // Users using this workspace are prohibited from activating sessions-index or starting the Agent here.
      return getWorkspaceEmitter(workspace).event;
    },

    onSessionTerminalEvent: terminalEventEmitter.event,

    onSessionReadyEvent: readyEventEmitter.event,

    disposeAll(): void {
      disposed = true;
      for (const state of workspaceIngests.values()) {
        state.indexSubscriptionGeneration += 1;
        state.configSubscriptionGeneration += 1;
        state.indexRecoveryGeneration += 1;
        state.configRecoveryGeneration += 1;
        if (state.indexRetryTimer) clearTimeout(state.indexRetryTimer);
        if (state.configRetryTimer) clearTimeout(state.configRetryTimer);
        state.indexRetryTimer = null;
        state.configRetryTimer = null;
        discardIndexRecovery(state);
        discardConfigRecovery(state);
        clearPendingState(state);
        clearActiveSubscriptions(state);
        for (const disposable of state.disposables) {
          try {
            disposable.dispose();
          } catch {
            // Ignore dispose exceptions and ensure all subscriptions are attempted to be released
          }
        }
      }
      workspaceIngests.clear();
      for (const emitter of workspaceEmitters.values()) {
        emitter.dispose();
      }
      workspaceEmitters.clear();
      terminalEventEmitter.dispose();
      readyEventEmitter.dispose();
      runtimeLifecycleDisposable?.dispose();
      runtimeRestartedDisposable?.dispose();
      availableRuntimeGenerationByWorkspaceKey.clear();
    },
  };
}

function buildMetaFromSnapshot(
  snapshot: ZCodeSessionStateSnapshot,
  options?: {
    modelOverride?: string;
    thoughtLevelOverride?: string;
  },
): ZCodeTaskMeta {
  const modelOverride = options?.modelOverride?.trim();
  const thoughtLevelOverride = options?.thoughtLevelOverride?.trim();
  const meta: ZCodeTaskMeta = {
    taskId: snapshot.session.sessionId,
    traceId: snapshot.session.traceId ?? generateTraceId(snapshot.session.sessionId),
    title: deriveTitleFromSnapshot(snapshot),
    workspacePath: snapshot.session.workspace.workspacePath,
    workspaceIdentity: snapshot.session.workspace.workspaceIdentity,
    createdAt: snapshot.session.createdAt,
    updatedAt: snapshot.session.updatedAt,
    mode: fromZCodeMode(snapshot.session.mode),
    // When the user explicitly switches the model or the historical model is unavailable, the session operation has already brought the new available model.
    // In this type of scenario, the task model of SQLite must be overwritten synchronously, otherwise the next recovery will still start from the deleted historical model;
    // Ordinary historical snapshots still give priority to the latest message model to avoid reverse contamination of the index by accidentally contaminated settings.current.
    model: modelOverride || formatTaskMetaModelSelectionFromSnapshot(snapshot),
    // When the historical task is restored, snapshot.settings.thoughtLevel may still be the latest value in the draft state of the same workspace.
    // When the recovery entry has brought task-local thoughtLevel, SQLite must write the entry value to avoid contamination when it is opened next time.
    thoughtLevel: thoughtLevelOverride || snapshot.settings.thoughtLevel.current,
    provider: ZCODE_AGENT_PROVIDER,
    status: deriveZCodeTaskStatusFromSessionSnapshot(snapshot),
    lastError: snapshot.projection.lastError
      ? {
          code: snapshot.projection.lastError.code ?? snapshot.projection.lastError.type,
          ...(snapshot.projection.lastError.detail
            ? { detail: snapshot.projection.lastError.detail }
            : {}),
          // sessions-index terminal resync and task service snapshot must share the same copy
          // lastError attribution, otherwise the error attribution of the hot and cold read paths will drift.
          ...(snapshot.projection.lastError.attribution
            ? { attribution: snapshot.projection.lastError.attribution }
            : {}),
          message: snapshot.projection.lastError.message,
        }
      : undefined,
  };
  if (Object.prototype.hasOwnProperty.call(snapshot.projection, "target")) {
    // The absence of the target field means that this snapshot does not provide goal information and cannot overwrite the old index;
    // Null means that the DB clearly does not have a goal, and the goal in task-index needs to be cleared.
    meta.target = snapshot.projection.target
      ? fromZCodeGoal(snapshot.projection.target)
      : snapshot.projection.target;
  }
  return meta;
}

function deriveTitleFromSnapshot(snapshot: ZCodeSessionStateSnapshot): string {
  return resolveZCodeVisibleSessionTitle({
    title: snapshot.session.title,
    messages: snapshot.messages,
    target: snapshot.projection.target,
  });
}

// When createSession just returns, the snapshot has neither real title nor user message.
// Broadcasting this "blank session" will cause a "New session" placeholder to flash in the sidebar.
// Here it is judged "whether there is content visible to the user". If not, just write sqlite without broadcasting, and then broadcast it after the real title arrives.
function hasUserVisibleContent(snapshot: ZCodeSessionStateSnapshot): boolean {
  const title = snapshot.session.title?.trim() ?? "";
  if (title && !isZCodeGoalContinuationReminderText(title)) {
    return true;
  }
  if (snapshot.projection.target?.objective.trim()) {
    return true;
  }
  return snapshot.messages.some((message) => {
    if (message.info.role !== "user") return false;
    if (isZCodeModelOnlySyntheticUserMessage(message)) return false;
    return message.parts.some((part) => part.type === "text" && part.text.trim().length > 0);
  });
}

const TASK_SEARCH_TEXT_MAX_CHARS = 200_000;

// Global conversation search only indexes the chat text that is visible by default, and does not include thought processes, tool calls, and compaction folding areas.
// Assistant's parts may have both historical text and latest text. Here, only the last text part is taken.
// It is consistent with the range displayed after the UI is collapsed by default.
function buildSearchableTextFromSnapshot(snapshot: ZCodeSessionStateSnapshot): string {
  const parts: string[] = [];
  let total = 0;
  // /goal automatic continuation will persist the internal system-reminder as runtime user turn;
  // This content is a model-only input, not a user-visible query, and cannot be written into the sidebar search text.
  for (const message of getZCodeUserVisibleMessages(snapshot.messages, {
    target: snapshot.projection.target,
  })) {
    const textParts = message.parts.filter(
      (part): part is Extract<ZCodeMessagePart, { type: "text" }> => part.type === "text",
    );
    if (textParts.length === 0) {
      continue;
    }
    const chosen = message.info.role === "assistant" ? textParts.slice(-1) : textParts;
    for (const part of chosen) {
      const content = part.text.trim();
      if (!content) {
        continue;
      }
      parts.push(content);
      total += content.length;
      if (total >= TASK_SEARCH_TEXT_MAX_CHARS) {
        break;
      }
    }
    if (total >= TASK_SEARCH_TEXT_MAX_CHARS) {
      break;
    }
  }
  // Key business logic: Upper limit truncation to prevent long tasks from enlarging tasks-index.sqlite to affect startup and list queries.
  return parts.join("\n").slice(0, TASK_SEARCH_TEXT_MAX_CHARS);
}

function fromZCodeMode(mode: ZCodeSessionMode): ZCodeTaskMode {
  return mode === "build" ? "build" : mode;
}

function fromZCodeGoal(
  goal: NonNullable<ZCodeSessionStateSnapshot["projection"]["target"]>,
): ZCodeTaskGoal {
  return {
    sessionID: goal.sessionId,
    targetID: goal.targetId,
    objective: goal.objective,
    summaryTitle: goal.summaryTitle,
    status: goal.status,
    tokenBudget: goal.tokenBudget,
    tokensUsed: goal.tokensUsed,
    timeUsedSeconds: goal.timeUsedSeconds,
    time: {
      created: goal.createdAt,
      updated: goal.updatedAt,
    },
  };
}
