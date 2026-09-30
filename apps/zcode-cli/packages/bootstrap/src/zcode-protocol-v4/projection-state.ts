// ProductProjection state factory and derivation rules.
// This file only contains pure functions: initial snapshot, availability/inputRouting derivation, revision progression determination.
import type {
  ActionAvailability,
  ConversationDelta,
  ConversationSnapshot,
  GoalState,
  InputRouting,
  SessionActionAvailability,
  SessionControl,
  StatePatch,
} from "@zcode/shared/zcode-protocol-v4";

/**
 * The traceId sentinel for synthetic events during cold recovery.
 * A synthetic event is a "view rebuild" and not an authoritative user action: synthetic config events such as ModelSelected
 * update the projection config, but must not claim seed authority (configModelTouchedByEvent) --
 * otherwise the model of the last history turn would override the runtime truth written back by resume (including a draft-state selection).
 */
export const HYDRATION_TRACE_ID = "hydrate-trace";

export function createInitialConversationSnapshot(
  sessionId: string,
  logEpoch: string,
): ConversationSnapshot {
  return {
    protocolVersion: 1,
    sessionId,
    logEpoch,
    seq: 0,
    revision: 0,
    control: {
      // draft ruling: Session entity exists but no input has been made.
      phase: "draft",
      sessionEnded: false,
      canStop: false,
      stopState: "idle",
      stopTargetKind: "unknown",
      activeWorks: [],
      lastError: null,
      apiRetry: null,
    },
    availability: computeAvailability({
      phase: "draft",
      goalStatus: null,
      compacting: false,
      goalVerifying: false,
      queueLength: 0,
      autoDrain: true,
    }),
    inputRouting: computeInputRouting(
      {
        phase: "draft",
        goalStatus: null,
        compacting: false,
        goalVerifying: false,
        queueLength: 0,
        autoDrain: true,
      },
      "queue",
    ),
    meta: { title: "", titleSource: "default" },
    // Mode initial value = core default collaboration mode ("build" fallback of session-mode-port getMode).
    // Although the SessionCreated event has mode, the draft semantics require no visible delta (no bump revision);
    // When the persistence preference is not build, the first SessionModeChanged shall prevail (TODO: draft period is exempt from revision seed channel).
    config: {
      provider: "",
      model: "",
      thought: "",
      thoughtLevels: [],
      followupMode: "queue",
      mode: "build",
    },
    modelTransition: null,
    usage: {
      contextWindow: null,
      cumulative: {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      },
    },
    queue: { items: [], autoDrain: true },
    pendingInteractions: [],
    pendingCommands: [],
    backgroundWorks: [],
    subagents: { revision: 0, childSessionIds: [], running: [], endedTotal: 0 },
    goal: null,
    plan: null,
    // Soft access control: initially no pending review status; after report by activate(), it will be written by projection.
    workspaceHookAdmission: null,
    rows: { window: [], totalCount: 0, firstRowId: null },
  };
}

const ALLOWED: ActionAvailability = { allowed: true };

function denied(reasonCode: string): ActionAvailability {
  return { allowed: false, reasonCode };
}

// guard derived input face (same origin as projection). compacting/goalVerifying is not a separate phase
// (phase closed enumeration), passed in after being derived from activeWorks/goal.status.
// queueLength/autoDrain for held derivation.
interface AvailabilityContext {
  phase: SessionControl["phase"];
  goalStatus: GoalState["status"] | null;
  compacting: boolean;
  goalVerifying: boolean;
  queueLength: number;
  autoDrain: boolean;
}

// The verdict table is aligned with the evaluate of packages/formal-proof/src/model.ts one by one
// (gold test formal-proof-consistency endorsement); reasonCode = product-protocol guard id.
export function computeAvailability(context: AvailabilityContext): SessionActionAvailability {
  const { phase, goalStatus, compacting } = context;
  const running = phase === "running" || phase === "prewarming";
  const compact = compacting
    ? // formal-proof: duplicateCompactRejected - running/queued compact operation lock deduplication.
      denied("compactOperationLock")
    : phase === "draft"
      ? // formal-proof: idleCannotCompact - No compressible context.
        denied("idleCannotCompact")
      : // When running/goal verifier, the command enters typed FIFO, and when completed, it is executed immediately or enters the held queue.
        ALLOWED;
  return {
    fork: compacting
      ? denied("compactOperationLock")
      : phase === "draft"
        ? denied("forkTargetNotStable")
        : ALLOWED,
    compact,
    switchModelConfig: ALLOWED,
    setFollowupMode: ALLOWED,
    queueEdit: ALLOWED,
    sendQueuedNow: compacting
      ? denied("compactOperationLock")
      : running
        ? ALLOWED
        : denied("sendQueuedNowRequiresRunning"),
    // Independent pauseGoal changes the target product state; during the verifier/notSatisfied period, the underlying target is still active.
    // Therefore, suspension is also allowed, and the provider abort controller cannot be required to currently exist.
    pauseGoal:
      goalStatus === "active" || goalStatus === "verifying" || goalStatus === "notSatisfied"
        ? ALLOWED
        : denied(goalStatus === null ? "noGoalToPause" : "goalNotActive"),
    // The reverse operation of resumeGoal = stopPausesActiveGoalTarget: only paused can be resumed.
    resumeGoal:
      goalStatus === "paused"
        ? ALLOWED
        : denied(goalStatus === null ? "noGoalToResume" : "goalNotPaused"),
  };
}

export function computeInputRouting(
  context: AvailabilityContext,
  followupMode: "queue" | "guide",
): InputRouting {
  // formal-proof: compactingAcceptsFutureInput
  // —— compact is a maintenance step, and the input is the future intention → join the queue without interrupting compact.
  if (context.compacting) {
    return { mode: "enqueue", reasonCode: "compactingAcceptsFutureInput" };
  }
  // goal verifier is completion-blocking active work, but not ordinary
  // assistant active turn; only watching phase=running will try steer in guide mode,
  // Core does not have steerable activeTurn at this time, causing user input to neither enter the queue nor enter the history.
  if (context.goalVerifying) {
    return { mode: "enqueue", reasonCode: "goalVerifierAcceptsFutureInput" };
  }
  if (context.phase === "running" || context.phase === "prewarming") {
    return { mode: followupMode === "guide" ? "guide" : "enqueue" };
  }
  // When completed + queue>0 + autoDrain=false, the input will not be queued silently;
  // The client presents the clear/keep selection, and the disposition goes up with the command.
  const completed =
    context.phase === "completedSuccess" || context.phase === "completedInterrupted";
  if (completed && context.queueLength > 0 && !context.autoDrain) {
    return { mode: "choice", reasonCode: "heldQueueInputRequiresChoice" };
  }
  return { mode: "startNow" };
}

// revision progression rule (closed definition): row structure changes + changes in area A (except usage/pendingCommands) +1 each.
// `workflowRuns` is **intentionally not listed** and falls under the exemption category of usage/pendingCommands: it is high-frequency derived data
// (approximately 5 migrations per node), comes with a monotonic revision field, and does not have any command
// baseRevision CAS read it - inclusion will cause run to jitter on every node migration during conversation revision,
// CAS false failed.
const REVISION_BEARING_PATCH_KEYS: ReadonlyArray<keyof StatePatch> = [
  "control",
  "availability",
  "inputRouting",
  "meta",
  "config",
  "queue",
  "pendingInteractions",
  "backgroundWorks",
  "subagents",
  "goal",
  "plan",
];

export function deltaBumpsRevision(delta: ConversationDelta): boolean {
  switch (delta.op) {
    case "row.appended":
    case "row.upserted":
    case "row.removed":
      return true;
    case "row.delta":
      return false;
    case "state.updated":
      return REVISION_BEARING_PATCH_KEYS.some((key) => delta.patch[key] !== undefined);
    // Key-level increments are exempt from the same exemption as integer `workflowRuns` patches (see note above): they express changes to that key,
    // Changing the encoding should not change the accounting rules - inclusion will cause a running run to shake the conversation revision every time the node is migrated.
    case "workflowRun.updated":
    case "workflowRun.removed":
      return false;
  }
}
