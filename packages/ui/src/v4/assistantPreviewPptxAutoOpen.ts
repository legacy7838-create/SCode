import type { ConversationRow, SessionPhase } from "@zcode/shared/zcode-protocol-v4";

interface AssistantPreviewPptxCompletedTurn {
  turnId: string;
  rowId: number;
  entityId?: string;
}

export interface AssistantPreviewPptxAutoOpenTarget {
  turnId: string;
  key: string;
}

interface AssistantPreviewPptxAutoOpenGateState {
  scopeKey: string;
  armed: boolean;
}

interface AssistantPreviewPptxAutoOpenGateInput {
  enabled: boolean;
  scopeKey: string;
  logEpoch?: string;
  phase?: SessionPhase;
  completedTurn: AssistantPreviewPptxCompletedTurn | null;
}

interface AssistantPreviewPptxAutoOpenGateResult {
  state: AssistantPreviewPptxAutoOpenGateState;
  /** undefined=keep the current target; null=clear; object=publish a new completed target. */
  target?: AssistantPreviewPptxAutoOpenTarget | null;
}

export function createAssistantPreviewPptxAutoOpenGateState(): AssistantPreviewPptxAutoOpenGateState {
  return { scopeKey: "", armed: false };
}

export function resolveLatestCompletedAssistantPreviewTurn(
  rows: readonly ConversationRow[],
): AssistantPreviewPptxCompletedTurn | null {
  const latestHeader = [...rows]
    .reverse()
    .find(
      (row): row is Extract<ConversationRow, { kind: "turnHeader" }> => row.kind === "turnHeader",
    );
  if (!latestHeader || latestHeader.state !== "completedSuccess") {
    return null;
  }

  const latestAssistant = [...rows]
    .reverse()
    .find(
      (row): row is Extract<ConversationRow, { kind: "assistantText" }> =>
        row.kind === "assistantText" && row.turnId === latestHeader.turnId,
    );
  if (!latestAssistant || latestAssistant.state !== "complete") return null;

  return {
    turnId: latestAssistant.turnId,
    rowId: latestAssistant.rowId,
    ...(latestAssistant.entityId ? { entityId: latestAssistant.entityId } : {}),
  };
}

export function advanceAssistantPreviewPptxAutoOpenGate(
  previous: AssistantPreviewPptxAutoOpenGateState,
  input: AssistantPreviewPptxAutoOpenGateInput,
): AssistantPreviewPptxAutoOpenGateResult {
  const scopeChanged = previous.scopeKey !== input.scopeKey;
  const current = scopeChanged ? { scopeKey: input.scopeKey, armed: false } : previous;

  if (!input.enabled) {
    return {
      state: { scopeKey: input.scopeKey, armed: false },
      target: null,
    };
  }

  if (input.phase === "running") {
    return {
      state: { scopeKey: input.scopeKey, armed: true },
      target: null,
    };
  }

  if (input.phase !== "completedSuccess") {
    return {
      state: { scopeKey: input.scopeKey, armed: false },
      ...(scopeChanged || current.armed ? { target: null } : {}),
    };
  }

  // Cold recovery will fall directly on completedSuccess, but the running edge of this renderer is not observed.
  // Only keep the status of armed but final assistant rows that have not yet arrived to avoid relying on phase/row arrival order.
  if (!current.armed || !input.completedTurn) {
    return { state: current };
  }

  const target: AssistantPreviewPptxAutoOpenTarget = {
    turnId: input.completedTurn.turnId,
    key: JSON.stringify([
      input.scopeKey,
      input.logEpoch ?? "",
      input.completedTurn.turnId,
      input.completedTurn.rowId,
      input.completedTurn.entityId ?? "",
    ]),
  };
  return {
    state: { scopeKey: input.scopeKey, armed: false },
    target,
  };
}
