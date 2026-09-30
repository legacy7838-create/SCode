import {
  SessionEventType,
  createChildTraceContext,
  createMessageId,
  createPartId,
  createTurnId,
} from "../deps.js";
import type {
  MessageId,
  SyntheticUserMessageSource,
  TraceContext,
  TurnInputIntentMetadata,
  WorkflowLaunchMeta,
} from "../deps.js";
import { buildUserContentFromTurn } from "../helpers/index.js";
import { realUserRuntimeMetadata } from "../../agent/message-history.js";
import type { AgentRuntimeInternal } from "../internal.js";
import type { ControlOnlyTurnRuntimeCommand } from "../command-queue.js";
import { buildProjectionAnchor } from "./projection-anchor.js";
import { maybeStartGoalSummaryTitleGeneration } from "./goal-summary-title.js";
import { maybeStartSessionTitleGeneration } from "./session-title.js";

/**
 * The shared boundary of a controlOnly user turn (used by both the external /goal query and a workflow started directly by the hub).
 *
 * Neither entry goes through the ordinary `executeTurn`, yet both have to persist a **user-visible, role=user** message,
 * feed it into the runtime history (the model sees it on its next turn), and then add a complete turn boundary with
 * no model output (`TurnStarted{executionKind:"controlOnly"}` + `TurnComplete{response:""}`) -- otherwise the live
 * ProductProjection never receives the TurnStarted, the query only shows up after a cold restore, and a 0ms control turn
 * gets misdisplayed by the modelChange marker as "worked for 1 second". The only substantive difference is **how** that
 * message is persisted (a real user prompt vs a synthetic user message carrying `workflowLaunch` metadata) plus the title
 * and the follow-up side effects, each injected by the `persistMessage` callback and the `afterTurnBoundary` callback.
 */
export async function emitControlOnlyUserTurn(
  this: AgentRuntimeInternal,
  options: {
    messageId: MessageId;
    /** The first-input title seed of `ensureSessionPersisted` (/goal uses the normalized objective, startup uses the workflow name). */
    titleInput: string;
    /** The visible text that goes into the runtime history (the model reads it on its next turn). */
    historyText: string;
    /** `TurnStarted.input` (the degraded rendering for old clients / the TUI). */
    turnInput: string;
    traceContext: TraceContext;
    inputId?: string;
    inputSource?: SyntheticUserMessageSource;
    workflowLaunch?: WorkflowLaunchMeta;
    intent?: TurnInputIntentMetadata;
    /** Persists this user message (real or synthetic) -- the only substantive difference between the two paths. */
    persistMessage: () => Promise<void>;
    /** Optional side effect after the session's first write and before turnNumber advances (title sidecar and the like). */
    afterTurnBoundary?: () => void;
  },
): Promise<void> {
  const { messageId, traceContext } = options;
  // The /goal entry may be written into the runtime history earlier than the first turn; if you addUser first,
  // Subsequent lazy context init will rebuild messageHistory and flush this real user query.
  await this.ensureContextInitialized(traceContext);
  await this.ensureSessionPersisted(options.titleInput, traceContext);
  // This type of entry itself does not use ordinary submitPrompt, but it carries the user's true intention. Write here at the same time
  // Runtime history and session store make model context, desktop continuous, and mobile phone replayable snapshot
  // Use the same visible user intent.
  this.messageHistory.addUser(
    buildUserContentFromTurn(options.historyText, []),
    realUserRuntimeMetadata(),
  );
  await options.persistMessage();
  // In the past, if you did not enter the entrance of executeTurn, only the transcript would be dropped into the library, but the live ProductProjection could not be received.
  // TurnStarted, causing the query to wait for cold recovery before appearing. Here is a complete set of model-free output for this real user input.
  // turn boundary; subsequent (goal continuation/notification driven round) will still open another turn and will not generate a second user bubble.
  const turnId = createTurnId();
  const turnTraceContext = createChildTraceContext(traceContext, {
    turnId,
    attributes: { turnNumber: this.turnNumber },
  });
  await this.appendEvent(
    this.createEvent(
      SessionEventType.TurnStarted,
      {
        turnNumber: this.turnNumber,
        input: options.turnInput,
        messageId,
        ...(options.inputId ? { inputId: options.inputId } : {}),
        // It can be seen that the query needs to be turned independently to be displayed in real time, but it does not execute the Agent itself. The status is missing
        // At this time, the modelChange marker will cause the UI to display the 0ms control round as "worked for 1 second" and briefly overwrite it.
        // session running/activeWorks.
        executionKind: "controlOnly",
        ...(options.inputSource ? { inputSource: options.inputSource } : {}),
        ...(options.workflowLaunch ? { workflowLaunch: options.workflowLaunch } : {}),
        ...(options.intent ? { intent: options.intent } : {}),
      },
      turnTraceContext,
    ),
    turnTraceContext,
  );
  await this.appendEvent(
    this.createEvent(
      SessionEventType.TurnComplete,
      {
        response: "",
        tokenCount: 0,
        toolCallCount: 0,
        duration: 0,
        resultType: "success",
        ...(options.inputId ? { inputId: options.inputId } : {}),
      },
      turnTraceContext,
    ),
    turnTraceContext,
  );
  options.afterTurnBoundary?.();
  this.turnNumber += 1;
  this.messageHistory.setCacheMiss();
}

/**
 * Persists the user message of the launch turn of a workflow started directly by the hub.
 *
 * It is a **synthetic but semantically a genuine user action** message: `synthetic: true` plus a new
 * `source: "workflow_launch"`, yet it carries `origin: "real_user"` / `kind: "user_prompt"` and is fully visible
 * to the ui/provider/transcript sides -- the user clicked "Run" in the hub, and that is his real intent; the GUI
 * simply draws the run card at the end of the turn with `metadata.workflowLaunch` instead of showing this text. The
 * metadata also enters the message metadata (the cold-restore source) and the TurnStarted payload (the live projection
 * source, written by the caller), the very same copy in both places.
 */
export async function persistWorkflowLaunchUserMessage(
  this: AgentRuntimeInternal,
  options: {
    messageID: MessageId;
    text: string;
    meta: WorkflowLaunchMeta;
    traceContext: TraceContext;
  },
): Promise<void> {
  this.latestConversationMessageId = options.messageID;
  if (!this.sessionStore) return;

  const created = Date.now();
  await this.persistMessage(
    {
      id: options.messageID,
      sessionID: this.sessionId,
      role: "user",
      time: { created },
      agent: this.config.agentName ?? "zcode-agent",
      // Cold recovery source: transcript-hydration source === "workflow_launch" + metadata.workflowLaunch
      // Rebuild the boot card line.
      metadata: { workflowLaunch: options.meta },
      modelSelection: this.getSessionModelSelection(),
      semantics: {
        // Real user action: It is not the system reminder of agent_runtime. The model will read it with real user prompt in the next round.
        origin: "real_user",
        kind: "user_prompt",
        source: "workflow_launch",
        uiVisibility: "visible",
        providerVisibility: "visible",
        transcriptVisibility: "visible",
      },
      anchor: buildProjectionAnchor(options.traceContext, "realUser"),
      source: "workflow_launch",
      system: this.config.systemPrompt,
      synthetic: true,
      tools: Object.fromEntries(this.getTools().map((tool) => [tool.name, true])),
      visibility: "user-visible",
    },
    options.traceContext,
  );
  await this.persistPart(
    {
      id: createPartId(),
      sessionID: this.sessionId,
      messageID: options.messageID,
      type: "text",
      text: options.text,
      synthetic: true,
      time: { start: created, end: created },
      metadata: { source: "workflow_launch", visibility: "user-visible" },
    },
    options.traceContext,
  );
}

/**
 * Runs one queued controlOnly turn ({@link ControlOnlyTurnRuntimeCommand}): persisted exactly like the hub launch turn --
 * a synthetic `workflow_launch` user message plus metadata plus a complete turn boundary, only the timing is decided by the queue.
 */
export async function runControlOnlyTurnCommand(
  this: AgentRuntimeInternal,
  command: ControlOnlyTurnRuntimeCommand,
): Promise<void> {
  const messageId = createMessageId();
  await emitControlOnlyUserTurn.call(this, {
    messageId,
    titleInput: command.titleInput,
    historyText: command.text,
    turnInput: command.text,
    traceContext: command.traceContext,
    ...(command.inputId === undefined ? {} : { inputId: command.inputId }),
    inputSource: "workflow_launch",
    workflowLaunch: command.workflowLaunch,
    persistMessage: () =>
      persistWorkflowLaunchUserMessage.call(this, {
        messageID: messageId,
        text: command.text,
        meta: command.workflowLaunch,
        traceContext: command.traceContext,
      }),
  });
}

export async function recordExternalUserPrompt(
  this: AgentRuntimeInternal,
  input: string,
  options?: {
    goalSummaryTargetID?: string;
    traceContext?: TraceContext;
    intent?: TurnInputIntentMetadata;
  },
): Promise<MessageId> {
  const traceContext = options?.traceContext ?? this.rootTraceContext;
  const canonicalInput = options?.intent?.text?.trim() || input;
  const messageId = createMessageId();
  await emitControlOnlyUserTurn.call(this, {
    messageId,
    titleInput: canonicalInput,
    historyText: input,
    turnInput: input,
    traceContext,
    inputId: options?.intent?.sourceCommandId,
    intent: options?.intent,
    // The /goal command itself does not use the ordinary submitPrompt, but the objective of the goal set for the first time is the user’s real
    // query; automatic continuation reminder is still marked as model-only by runtime.
    persistMessage: () =>
      this.persistUserPrompt(messageId, input, undefined, traceContext, {
        intent: options?.intent,
        sessionInputId: options?.intent?.queueItemId,
        executionKind: "controlOnly",
      }),
    afterTurnBoundary: () => {
      // The first query must start the title sidecar when turnNumber is still 0, otherwise the first round of gate will
      // It misjudges it as a subsequent turn and only generates the goal summaryTitle while retaining the first_input session title.
      const titleGenerationStarted = maybeStartSessionTitleGeneration.call(
        this,
        canonicalInput,
        messageId,
        traceContext,
        { goalSummaryTargetID: options?.goalSummaryTargetID },
      );
      if (!titleGenerationStarted && options?.goalSummaryTargetID) {
        maybeStartGoalSummaryTitleGeneration.call(
          this,
          canonicalInput,
          options.goalSummaryTargetID,
          { traceContext },
        );
      }
    },
  });
  return messageId;
}
