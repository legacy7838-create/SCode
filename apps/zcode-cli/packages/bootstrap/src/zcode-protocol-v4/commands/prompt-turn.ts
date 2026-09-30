// Native prompt turn runner.
//
// Core admission is only responsible for accepting input and establishing session-scoped reservation; this file no longer owns
// activeAbortController does not wait for projection commit. In this way, any Core after TurnStarted
// The starting/active status will continue to block the second start of the same session.
import { type TurnBackgroundAttribution, type TurnInputIntentMetadata } from "@zcode/contracts";
import type { TurnAttachment } from "@zcode/core";
import type { ZCodeAutomationBotDeliveryTarget } from "@zcode/shared";
import type { SendInputOptions, SendInputResult } from "../../app/types.js";
import { runWithSessionResidencyFinalization } from "../../zcode-protocol/session-residency.js";
import type { V4CommandCoreHost, V4SessionRecordView } from "./types.js";

interface StartPromptTurnParamsBase {
  content: string;
  /** v4 anchor: inputId=queryId=commandId (sourceCommandId reconciles against the authoritative data). */
  inputId: string;
  inputPresentation?: SendInputOptions["inputPresentation"];
  /** Attachment command surface: AttachmentRef has already been mapped to a core TurnAttachment at the handler layer. */
  attachments?: TurnAttachment[];
  browserAmbientContext?: SendInputOptions["browserAmbientContext"];
  intent?: TurnInputIntentMetadata;
  /** A one-shot execution constraint for a standard Selection; it does not rewrite the Session Selection. */
  modelExecution?: SendInputOptions["modelExecution"];
  sharedContextRefs?: SendInputOptions["sharedContextRefs"];
  toolDisallowlist?: readonly string[];
  /** sendQueuedNow already holds the Core promotion lease, so this admission is required to take an idle slot only. */
  requireIdle?: boolean;
  /** The stable push-back address of an inbound Bot turn; exposed to CronCreate only within this turn. */
  botDeliveryTarget?: ZCodeAutomationBotDeliveryTarget;
}

type StartPromptTurnParams = StartPromptTurnParamsBase & TurnBackgroundAttribution;

interface PromptTurnStartResult {
  /** Core admission is complete; it does not wait for TurnStarted or a projection commit. */
  turnStarted: Promise<void>;
  /** The promise of Core's real completion, used only for lifecycle cleanup; it is not part of the ACK boundary. */
  completion?: Promise<unknown>;
  admission: SendInputResult;
  /** Kept for legacy callers; the initial ACK no longer depends on messageId. */
  messageId?: string;
}

export class V4PromptRejectedError extends Error {
  readonly turnStartUncertain = false;

  constructor(
    readonly reasonCode: "restoreWarning" | "activePrompt",
    message: string,
  ) {
    super(message);
    this.name = "V4PromptRejectedError";
  }
}

/**
 * The entry point only performs model/persistence pre-validation, then calls app -> Core admission. When Core returns started,
 * the background lifecycle waits for completion to clean up turn attribution and broadcast state; the RPC itself returns the admission receipt immediately.
 */
export async function startPromptTurn(
  host: V4CommandCoreHost,
  record: V4SessionRecordView,
  params: StartPromptTurnParams,
): Promise<PromptTurnStartResult> {
  const usesExecutionSelection = params.modelExecution?.selectionScope === "execution";
  if (!usesExecutionSelection && record.restoreWarning) {
    // After the app is restarted, cold recovery may run in the provider registry push
    // Previously, when the record was created, a "model cannot be parsed" alarm was raised; when the registry subsequently arrived, the runtime
    // It has been available for service for a long time, but no one came back to clear this one-time mark - the delivery was permanently rejected (the user can only manually cut the model
    // unlocked). Before the gate is re-evaluated by the host's ability: If the target is available, the expired alarm will be cleared, and then the
    // ensureModelReady verifies the current selection; you cannot change models or clear persistent selections here.
    // Still no model available/host not supported → Maintain rejection.
    if (host.hasUsableRuntimeModelTarget?.(record) === true) {
      host.logger?.info?.("v4 restoreWarning cleared by model catalog recovery", {
        sessionId: record.app.sessionId,
        warningType: record.restoreWarning.type,
      });
      record.restoreWarning = undefined;
    }
  }
  if (!usesExecutionSelection && record.restoreWarning) {
    throw new V4PromptRejectedError("restoreWarning", record.restoreWarning.message);
  }
  if (!usesExecutionSelection) {
    await host.ensureModelReady?.(record);
  }
  if (record.persistence === "deferred") record.persistence = "immediate";

  const previousAutomationId = record.activeAutomationId;
  const previousOffPeakTaskId = record.activeOffPeakTaskId;
  const previousBotDeliveryTarget = record.activeBotDeliveryTarget;
  const activeAutomationId = resolveTurnAutomationId(params);
  const activeOffPeakTaskId = resolveTurnOffPeakTaskId(params);
  const turnToolDisallowlist = buildTurnToolDisallowlist(
    params,
    activeAutomationId,
    activeOffPeakTaskId,
  );
  if (activeAutomationId) record.activeAutomationId = activeAutomationId;
  if (activeOffPeakTaskId) {
    // Dispatch round-robin flags at idle times for offpeak-port to reject recursive OffPeakCreate before the tool executes.
    record.activeOffPeakTaskId = activeOffPeakTaskId;
  }
  record.activeBotDeliveryTarget = params.botDeliveryTarget;

  let admission: SendInputResult;
  try {
    admission = await record.app.sendInput(
      {
        text: params.content,
        ...(params.attachments ? { attachments: params.attachments } : {}),
      },
      {
        // Bootstrap controller was once regarded as Core busy truth and was replaced by projection watchdog
        // Clean it up; now Core admission holds the reservation itself, and Stop calls Core execution directly.
        delivery: "start_turn",
        ...(params.intent?.requestedDelivery === "guide"
          ? { queueDelivery: "guide" as const }
          : {}),
        ...(params.browserAmbientContext
          ? { browserAmbientContext: params.browserAmbientContext }
          : {}),
        inputId: params.inputId,
        ...(params.inputPresentation ? { inputPresentation: params.inputPresentation } : {}),
        ...turnBackgroundAttributionOf({
          automationId: activeAutomationId,
          // Attribution uses the parsed id: the resume segment also needs to enter the core loop state when it only relies on the inputId prefix.
          offPeakTaskId: activeOffPeakTaskId,
          offPeakRunType: params.offPeakRunType,
        }),
        intent: params.intent,
        ...(params.modelExecution ? { modelExecution: params.modelExecution } : {}),
        ...(params.sharedContextRefs ? { sharedContextRefs: params.sharedContextRefs } : {}),
        ...(turnToolDisallowlist ? { toolDisallowlist: turnToolDisallowlist } : {}),
        ...(params.requireIdle ? { requireIdle: true } : {}),
        queryId: params.inputId as SendInputOptions["queryId"],
      },
    );
  } catch (error) {
    clearPromptRecordState(
      record,
      previousAutomationId,
      previousOffPeakTaskId,
      previousBotDeliveryTarget,
    );
    await host.afterLegacyStateMutation?.(record, "prompt_failed");
    throw error;
  }

  if (admission.kind === "rejected") {
    clearPromptRecordState(
      record,
      previousAutomationId,
      previousOffPeakTaskId,
      previousBotDeliveryTarget,
    );
    throw new V4PromptRejectedError(
      "activePrompt",
      `Core prompt admission rejected: ${admission.reason}`,
    );
  }

  if (admission.kind === "queued") {
    clearPromptRecordState(
      record,
      previousAutomationId,
      previousOffPeakTaskId,
      previousBotDeliveryTarget,
    );
    return { admission, turnStarted: Promise.resolve() };
  }

  const completion = runWithSessionResidencyFinalization(record, async () => {
    let mutationReason = "prompt_completed";
    try {
      await admission.completion;
    } catch (error) {
      mutationReason = "prompt_failed";
      host.logger?.warn?.("v4 background turn failed", {
        error: error instanceof Error ? error.message : String(error),
        inputId: params.inputId,
        sessionId: record.app.sessionId,
      });
    } finally {
      clearPromptRecordState(
        record,
        previousAutomationId,
        previousOffPeakTaskId,
        previousBotDeliveryTarget,
      );
      await host.afterLegacyStateMutation?.(record, mutationReason);
    }
  });
  void completion.catch(() => undefined);
  host.logger?.info?.("v4 prompt admitted", {
    attachmentCount: params.attachments?.length ?? 0,
    inputId: params.inputId,
    sessionId: record.app.sessionId,
    textLength: params.content.length,
  });
  return { admission, completion, turnStarted: Promise.resolve() };
}

function clearPromptRecordState(
  record: V4SessionRecordView,
  previousAutomationId: string | undefined,
  previousOffPeakTaskId: string | undefined,
  previousBotDeliveryTarget: V4SessionRecordView["activeBotDeliveryTarget"],
): void {
  record.activeAutomationId = previousAutomationId;
  // The same rules of idle wheel identity and automation are restored with the turn, preventing cross-round residuals from accidentally rejecting OffPeakCreate.
  record.activeOffPeakTaskId = previousOffPeakTaskId;
  record.activeBotDeliveryTarget = previousBotDeliveryTarget;
}

function buildTurnToolDisallowlist(
  params: Pick<StartPromptTurnParams, "automationId" | "offPeakTaskId" | "toolDisallowlist">,
  activeAutomationId = params.automationId,
  activeOffPeakTaskId = params.offPeakTaskId,
): readonly string[] | undefined {
  const tools = new Set(params.toolDisallowlist ?? []);
  if (activeAutomationId) {
    // When automation dispatches the missing identity, the subsequent model step will re-expose the Cron writing tool.
    for (const toolName of AUTOMATION_MUTATION_TOOL_NAMES) tools.add(toolName);
  }
  if (activeOffPeakTaskId) {
    // OffPeakCreate (anti-recursive self-derivation) is hidden when the dispatch wheel is idle; OffPeakList is read-only and reserved.
    // The automation round does not add this item - the cron round releases OffPeakCreate (scheduled idle time task).
    for (const toolName of OFF_PEAK_MUTATION_TOOL_NAMES) tools.add(toolName);
  }
  return tools.size > 0 ? [...tools] : undefined;
}

export function resolveTurnAutomationId(
  params: Pick<StartPromptTurnParams, "automationId" | "inputId">,
): string | undefined {
  const explicit = params.automationId?.trim();
  if (explicit) return explicit;
  const inputId = params.inputId.trim();
  if (!inputId.startsWith(AUTOMATION_INPUT_ID_PREFIX)) return undefined;
  const separatorIndex = inputId.indexOf(":");
  const automationId = separatorIndex >= 0 ? inputId.slice(0, separatorIndex) : inputId;
  return automationId.length > AUTOMATION_INPUT_ID_PREFIX.length ? automationId : undefined;
}

function resolveTurnOffPeakTaskId(
  params: Pick<StartPromptTurnParams, "offPeakTaskId" | "inputId">,
): string | undefined {
  const explicit = params.offPeakTaskId?.trim();
  if (explicit) return explicit;
  // Bottom line: the inputId distributed in the continuation is in the shape of `offpeak-<uuid>:resume:<uuid>`; there is no fixed prefix for the first segment of distribution.
  // The main signal must be explicit offPeakTaskId (host dispatch must be passed explicitly).
  const inputId = params.inputId.trim();
  if (!inputId.startsWith(OFF_PEAK_INPUT_ID_PREFIX)) return undefined;
  const separatorIndex = inputId.indexOf(":");
  const offPeakTaskId = separatorIndex >= 0 ? inputId.slice(0, separatorIndex) : inputId;
  return offPeakTaskId.length > OFF_PEAK_INPUT_ID_PREFIX.length ? offPeakTaskId : undefined;
}

export function turnBackgroundAttributionOf(params: {
  automationId?: string;
  offPeakTaskId?: string;
  offPeakRunType?: "init" | "resume";
}): TurnBackgroundAttribution {
  if (params.automationId) return { automationId: params.automationId };
  if (params.offPeakTaskId) {
    return {
      offPeakTaskId: params.offPeakTaskId,
      ...(params.offPeakRunType ? { offPeakRunType: params.offPeakRunType } : {}),
    };
  }
  return {};
}

const AUTOMATION_INPUT_ID_PREFIX = "automation-";
const AUTOMATION_MUTATION_TOOL_NAMES = ["CronCreate", "CronUpdate", "CronDelete"] as const;
// Standalone constant, never merged into AUTOMATION_MUTATION_TOOL_NAMES (cron release OffPeakCreate).
// Same value as core turn-loop-state - idle wheel hides SendMessage / Workflow at the same time (both will be in this round
// Restart the child Agent outside of modelExecution).
const OFF_PEAK_INPUT_ID_PREFIX = "offpeak-";
const OFF_PEAK_MUTATION_TOOL_NAMES = ["OffPeakCreate", "SendMessage", "Workflow"] as const;
