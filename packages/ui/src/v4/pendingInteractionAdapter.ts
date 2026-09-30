import type {
  ZCodePermissionOption,
  ZCodePermissionRequest,
  ZCodePermissionResponse,
  ZCodeElicitationRequest,
} from "@zcode/shared";
import type {
  PendingInteraction,
  PermissionRequestPayload,
  UserInputRequestPayload,
} from "@zcode/shared/zcode-protocol-v4";

const LEGACY_PERMISSION_RULE_INPUT_KEYS = [
  "command",
  "url",
  "file_path",
  "path",
  "pattern",
] as const;

function permissionKindToResponse(
  kind: string,
  payload: PermissionRequestPayload,
): ZCodePermissionResponse {
  if (kind === "deny" || kind === "rejectOnce" || kind === "rejectAlways") {
    return { decision: "deny" };
  }
  if (kind === "allowAlways") {
    const detail =
      typeof payload.detail === "object" && payload.detail !== null
        ? (payload.detail as Record<string, unknown>)
        : {};
    const ruleContent = LEGACY_PERMISSION_RULE_INPUT_KEYS.map((key) => detail[key]).find(
      (value): value is string => typeof value === "string" && value.trim().length > 0,
    );
    // The option of the old v4 snapshot has no response; if you only fall back to allow, the project-level authorization will
    // Missing persistence rules. The compatible path only generates the original exact and does not recalculate the CLI's AST prefix in the UI.
    return {
      decision: "allow",
      permissionUpdates: [
        {
          behavior: "allow",
          rules: [
            {
              toolName: payload.toolName,
              ...(ruleContent ? { ruleContent } : {}),
            },
          ],
          type: "addRules",
        },
      ],
    };
  }
  return { decision: "allow" };
}

/** v4 permission payload → a ZCodePermissionRequest the legacy PermissionDialog can consume. */
export function pendingPermissionToLegacyRequest(
  sessionId: string,
  interaction: PendingInteraction & { payload: PermissionRequestPayload },
): ZCodePermissionRequest {
  const { payload } = interaction;
  const advertisedOptions = payload.fullAccessOption
    ? [...payload.options, payload.fullAccessOption]
    : payload.options;
  const options: ZCodePermissionOption[] = advertisedOptions.map((option) => ({
    optionId: option.optionId,
    kind: option.kind,
    name: option.label,
    response: option.response ?? permissionKindToResponse(option.kind, payload),
  }));

  return {
    type: "permission_request",
    taskId: sessionId,
    traceId: sessionId,
    requestId: interaction.interactionId,
    description: payload.summary,
    kind: payload.toolName,
    title: payload.toolName,
    options,
    ...(payload.freeText ? { freeText: true } : {}),
    // The subagent source of V4 permission already exists in pendingInteraction,
    // After the old adapter misses the transmission, the PermissionDialog cannot display the source, and the user will mistakenly think that the main Agent is applying for permissions.
    ...(payload.origin ? { origin: payload.origin } : {}),
    // The tool's self-reported confirmation preview uses an independent display channel and is not inserted into raw/detail: the shape of detail is owned
    // The preview parsing of tools is shared, and any change will affect all permission pop-ups.
    ...(payload.display ? { display: payload.display } : {}),
    raw: payload.detail ?? {
      toolCallId: payload.toolCallId,
      toolName: payload.toolName,
    },
  };
}

export interface V4UserInputViewModel {
  interactionId: string;
  prompt: string;
  freeText: boolean;
  sensitive?: boolean;
  options: ReadonlyArray<{ optionId: string; label: string }>;
}

export function pendingUserInputToViewModel(
  interaction: PendingInteraction & { payload: UserInputRequestPayload },
): V4UserInputViewModel {
  return {
    interactionId: interaction.interactionId,
    prompt: interaction.payload.prompt,
    freeText: interaction.payload.freeText,
    sensitive: interaction.payload.sensitive,
    options: interaction.payload.options ?? [],
  };
}

export function pendingUserInputToElicitationRequest(
  sessionId: string,
  interaction: PendingInteraction & { payload: UserInputRequestPayload },
): ZCodeElicitationRequest | null {
  const { payload } = interaction;
  if (!payload.questions || payload.questions.length === 0) {
    return null;
  }
  const firstQuestion = payload.questions[0];
  return {
    type: "elicitation_request",
    taskId: sessionId,
    traceId: payload.traceId ?? sessionId,
    requestId: interaction.interactionId,
    message: firstQuestion?.question ?? payload.prompt,
    header: firstQuestion?.header,
    options: firstQuestion?.options ?? [],
    ...(firstQuestion?.multiSelect ? { multiSelect: true } : {}),
    questions: payload.questions,
    ...(payload.currentQuestionIndex !== undefined
      ? { currentQuestionIndex: payload.currentQuestionIndex }
      : {}),
    ...(payload.answerDrafts ? { answerDrafts: payload.answerDrafts } : {}),
    ...(payload.origin ? { origin: payload.origin } : {}),
    schema: payload.schema ?? payload.input,
  };
}
