/* eslint-disable max-lines -- The Feishu provider centrally carries auth, message parsing, card sending and reaction typing adaptation; it will be split by capability later. */
import type {
  BotInboundAttachment,
  BotConfig,
  BotInboundMessage,
  BotOutboundMessage,
  BotProvider,
  SelectionPrompt,
} from "@zcode/shared";
import type {
  BotProviderAdapter,
  BotStreamingReplyCardHandle,
  BotStreamingReplyCardState,
  BotTransientInteractionCardHandle,
} from "./types.js";
import { formatBotMessage } from "../messages.js";
import { fetchBotProviderJson } from "#src/bots/providers/providerRequest.js";

interface FeishuProviderDeps {
  loadCredential(key: string): Promise<string | null>;
  onDeliveryResult?(bot: BotConfig, error: string | undefined): void;
}

export interface FeishuWebSocketClient {
  close(): void;
  /** Terminal state after the SDK's automatic reconnect attempts are exhausted. */
  terminated: Promise<void>;
}

const FEISHU_APP_ID_PATTERN = /^cli_[0-9a-fA-F]{16}$/;
const FEISHU_WEBSOCKET_START_TIMEOUT_MS = 20_000;
const FEISHU_WEBSOCKET_READY_POLL_MS = 100;
// Reason for fix: Feishu Card JSON 2.0 allows up to 200 components or elements. Reserve 20 elements for
// The difference between the status line and the server count prevents long tasks from being shut down in the entire round after being rejected by 11310 during the update phase.
export const FEISHU_STREAMING_CARD_TAGGED_ELEMENT_BUDGET = 180;
const WEBSOCKET_OPEN_READY_STATE = 1;

interface FeishuAccessTokenResponse {
  code?: number;
  msg?: string;
  tenant_access_token?: string;
}

interface FeishuSendMessageResponse {
  code?: number;
  msg?: string;
  error?: {
    log_id?: string;
  };
  data?: {
    message_id?: string;
  };
}

interface FeishuReactionResponse {
  code?: number;
  msg?: string;
  data?: {
    reaction_id?: string;
  };
}

const FEISHU_ATTACHMENT_DOWNLOAD_TIMEOUT_MS = 30_000;

interface FeishuAppInfoResponse {
  code?: number;
  msg?: string;
  data?: {
    app?: {
      app_name?: string;
      primary_language?: string;
      i18n?: Array<{
        i18n_key?: string;
        name?: string;
      }>;
    };
  };
}

interface FeishuUserInfoResponse {
  code?: number;
  msg?: string;
  data?: {
    user?: {
      name?: string;
      en_name?: string;
      nickname?: string;
    };
  };
}

const accessTokenCache = new Map<string, { token: string; expiresAt: number }>();
const typingReactionIds = new Map<string, string>();
const userDisplayNameCache = new Map<string, { name: string | null; expiresAt: number }>();
const FEISHU_ELICITATION_FORM_FIELD_NAME = "answer";
const FEISHU_ELICITATION_FORM_VALUE_PREFIX = "__form__:";
const FEISHU_ELICITATION_CUSTOM_OPTION_ID = "__custom__";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readPlanApprovalContent(message: BotOutboundMessage): string | null {
  const schema = message.elicitation?.schema;
  if (!isRecord(schema) || schema.interaction !== "plan_approval") {
    return null;
  }
  return typeof schema.plan === "string" && schema.plan.trim() ? schema.plan.trim() : null;
}

function formatSelectionCommand(selection: SelectionPrompt, optionId: string): string {
  if (selection.action === "permission.respond") {
    return optionId;
  }
  if (selection.action === "elicitation.respond") {
    return selection.token ? `/elicitation ${selection.token} ${optionId}` : `/elicitation ${optionId}`;
  }
  if (selection.action === "model.provider.set") {
    return `/model provider ${optionId}`;
  }
  if (selection.action === "model.set") {
    return `/model model ${optionId}`;
  }
  return `/${selection.action.replace(".set", "")} ${optionId}`;
}

function readElicitationAnswerValues(
  message: BotOutboundMessage,
  questionIndex: number,
): string[] {
  return message.elicitation?.answers?.[String(questionIndex)] ?? [];
}

function formatElicitationAnswerLabel(
  message: BotOutboundMessage,
  questionIndex: number,
): string {
  const question = message.elicitation?.questions[questionIndex];
  const values = readElicitationAnswerValues(message, questionIndex);
  if (!question || values.length === 0) {
    return "";
  }
  const labels = values.map((value) => {
    const option = question.options.find((item) => item.value === value);
    return option?.label ?? value;
  });
  return labels.join(", ");
}

function formatFeishuPlainText(content: string): Record<string, string> {
  return { tag: "plain_text", content };
}

function buildFeishuElicitationFormCommand(token: string, value?: unknown): string {
  const suffix =
    value === undefined
      ? FEISHU_ELICITATION_FORM_VALUE_PREFIX
      : `${FEISHU_ELICITATION_FORM_VALUE_PREFIX}${encodeURIComponent(JSON.stringify(value))}`;
  return `/elicitation ${token} ${suffix}`;
}

function readFeishuElicitationCustomValues(
  message: BotOutboundMessage,
  question: NonNullable<BotOutboundMessage["elicitation"]>["questions"][number],
  questionIndex: number,
): string[] {
  const optionValues = new Set(question.options.map((option) => option.value));
  return readElicitationAnswerValues(message, questionIndex).filter(
    (value) => !optionValues.has(value),
  );
}

function buildFeishuElicitationChoiceButton(params: {
  message: BotOutboundMessage;
  question: NonNullable<BotOutboundMessage["elicitation"]>["questions"][number];
  option: NonNullable<BotOutboundMessage["elicitation"]>["questions"][number]["options"][number];
  selectedValues: readonly string[];
}): Record<string, unknown> {
  const selected = params.selectedValues.includes(params.option.value);
  const marker = params.question.multiSelect
    ? selected
      ? "☑"
      : "☐"
    : selected
      ? "●"
      : "○";
  return buildFeishuButtonElement({
    text: `${marker} ${params.option.label}`,
    type: selected ? "primary" : "default",
    command: buildFeishuElicitationOptionCommand(
      params.message,
      params.option.value,
    ),
    originalText: params.message.text,
  });
}

function buildFeishuElicitationOptionCommand(
  message: BotOutboundMessage,
  optionId: string,
): string {
  const token = message.selection?.token;
  return token
    ? formatSelectionCommand(
        {
          id: message.selection?.id ?? "",
          token,
          title: message.selection?.title ?? message.text,
          action: "elicitation.respond",
          options: [],
        },
        optionId,
      )
    : optionId;
}

function isFeishuElicitationCustomExpanded(
  message: BotOutboundMessage,
  questionIndex: number,
): boolean {
  return (
    message.elicitation?.expandedCustomAnswerQuestionIndexes?.includes(
      questionIndex,
    ) ?? false
  );
}

function buildFeishuElicitationCustomButton(
  message: BotOutboundMessage,
  question: NonNullable<BotOutboundMessage["elicitation"]>["questions"][number],
  questionIndex: number,
): Record<string, unknown> {
  const customValues = readFeishuElicitationCustomValues(
    message,
    question,
    questionIndex,
  );
  const expanded = isFeishuElicitationCustomExpanded(message, questionIndex);
  const selected = expanded || customValues.length > 0;
  const marker =
    question.multiSelect ? (selected ? "☑" : "☐") : selected ? "●" : "○";
  const customLabel = formatBotMessage(message.locale, "elicitationCustomOption");
  return buildFeishuButtonElement({
    text: `${marker} ${customLabel}`,
    type: selected ? "primary" : "default",
    command: buildFeishuElicitationOptionCommand(
      message,
      FEISHU_ELICITATION_CUSTOM_OPTION_ID,
    ),
    originalText: message.text,
  });
}

function buildFeishuElicitationForm(
  message: BotOutboundMessage,
  question: NonNullable<BotOutboundMessage["elicitation"]>["questions"][number],
  questionIndex: number,
): Record<string, unknown> | null {
  const selection = message.selection;
  if (!selection?.token) {
    return null;
  }
  const customExpanded = isFeishuElicitationCustomExpanded(
    message,
    questionIndex,
  );
  const shouldShowInput = question.options.length === 0 || customExpanded;
  const shouldShowSubmit = question.multiSelect || shouldShowInput;
  if (!shouldShowSubmit) {
    return null;
  }
  const customValues = readFeishuElicitationCustomValues(
    message,
    question,
    questionIndex,
  );
  const formElements: Array<Record<string, unknown>> = [];
  if (shouldShowInput) {
    formElements.push({
      tag: "input",
      name: FEISHU_ELICITATION_FORM_FIELD_NAME,
      required: question.options.length === 0,
      width: "fill",
      input_type: "multiline_text",
      rows: 2,
      auto_resize: true,
      max_rows: 5,
      placeholder: formatFeishuPlainText(
        formatBotMessage(message.locale, "elicitationCustomPlaceholder"),
      ),
      default_value: customValues.join(", "),
    });
  }
  formElements.push({
    tag: "button",
    text: formatFeishuPlainText(
      formatBotMessage(message.locale, "elicitationSubmitOption"),
    ),
    type: "primary",
    form_action_type: "submit",
    name: "submit",
    behaviors: [
      {
        type: "callback",
        value: {
          command: buildFeishuElicitationFormCommand(selection.token),
          zcodeCardText: message.text,
        },
      },
    ],
  });
  return {
    tag: "form",
    name: `elicitation_form_${questionIndex}`,
    direction: "vertical",
    vertical_spacing: "8px",
    elements: formElements,
  };
}

function buildFeishuElicitationAnswerElements(
  message: BotOutboundMessage,
): Array<Record<string, unknown>> {
  const elicitation = message.elicitation;
  if (!elicitation) {
    return [];
  }
  const total = elicitation.questions.length;
  const isCompleted =
    elicitation.status === "completed" || elicitation.status === "cancelled";
  const elements: Array<Record<string, unknown>> = [];
  elicitation.questions.forEach((question, index) => {
    // Reason for fix: The multi-select value of the current question is only a draft that has not yet been submitted. If you also put it into the history area above,
    // The same question will appear as "Answered" and "To be answered" at the same time. In progress, only questions that have been submitted before will be accumulated.
    if (!isCompleted && index >= elicitation.currentQuestionIndex) {
      return;
    }
    const answer = formatElicitationAnswerLabel(message, index);
    if (!answer) {
      return;
    }
    elements.push(
      {
        tag: "markdown",
        content: formatFeishuCardMarkdownContent(
          `#### ${index + 1}/${total} ${question.question}`,
        ),
      },
      {
        tag: "markdown",
        content: formatFeishuCardMarkdownContent(answer),
      },
    );
  });
  return elements;
}

function buildFeishuElicitationCardPayload(message: BotOutboundMessage): Record<string, unknown> {
  const elicitation = message.elicitation;
  const selection = message.selection;
  if (!elicitation) {
    return buildFeishuInteractiveCardPayload(message);
  }
  const currentQuestion =
    elicitation.questions[elicitation.currentQuestionIndex] ?? elicitation.questions[0];
  const isCompleted = elicitation.status === "completed" || elicitation.status === "cancelled";
  const answerElements = buildFeishuElicitationAnswerElements(message);
  const planApprovalContent = readPlanApprovalContent(message);
  const elements: Array<Record<string, unknown>> = [];
  if (isCompleted && planApprovalContent) {
    // Reason for repair: When the card is retained after the Plan interaction is completed, the old final state branch only renders the approval answer, causing the plan text to disappear.
    // The read-only final state still requires the complete plan to be retained so that users can review the content they approved or canceled in the chat history.
    elements.push({
      tag: "markdown",
      content: formatFeishuCardMarkdownContent(planApprovalContent),
    });
    if (answerElements.length > 0) {
      elements.push({ tag: "hr" });
    }
  }
  elements.push(...answerElements);
  if (!isCompleted && currentQuestion) {
    if (answerElements.length > 0) {
      elements.push({ tag: "hr" });
    }
    if (!planApprovalContent) {
      elements.push({
        tag: "markdown",
        content: formatFeishuCardMarkdownContent(
          `#### ${formatBotMessage(message.locale, "elicitationQuestionTitle")}`,
        ),
      });
    }
    // Reason for fix: ExitPlanMode is not a normal Q&A. If the plan text remains only in the streaming message, the approval card will lose context;
    // So plan approvals use their own body, while AskUserQuestion continues to use the general "ask" structure.
    const contentParts = planApprovalContent
      ? [planApprovalContent]
      : [
          currentQuestion.header && currentQuestion.header !== currentQuestion.question
            ? `**${currentQuestion.header}**`
            : null,
          currentQuestion.question,
        ];
    elements.push({
      tag: "markdown",
      content: formatFeishuCardMarkdownContent(
        contentParts
          .filter((part): part is string => typeof part === "string" && part.length > 0)
          .join("\n\n"),
      ),
    });
    if (planApprovalContent) {
      elements.push(
        { tag: "hr" },
        {
          tag: "markdown",
          content: formatFeishuCardMarkdownContent(
            `**${formatBotMessage(message.locale, "planApprovalTitle")}**`,
          ),
        },
      );
    }
    const selectedValues = readElicitationAnswerValues(
      message,
      elicitation.currentQuestionIndex,
    );
    for (const option of currentQuestion.options) {
      const displayOption = planApprovalContent
        ? {
            ...option,
            label: formatBotMessage(message.locale, "planApprovalApprove"),
            description: formatBotMessage(message.locale, "planApprovalApproveDescription"),
          }
        : option;
      elements.push(
        buildFeishuElicitationChoiceButton({
          message,
          question: currentQuestion,
          option: displayOption,
          selectedValues,
        }),
      );
    }
    elements.push(
      buildFeishuElicitationCustomButton(
        message,
        currentQuestion,
        elicitation.currentQuestionIndex,
      ),
    );
    const form = buildFeishuElicitationForm(
      message,
      currentQuestion,
      elicitation.currentQuestionIndex,
    );
    if (form) {
      elements.push(form);
    }
    const shouldShowCancel =
      currentQuestion.multiSelect ||
      currentQuestion.options.length === 0 ||
      isFeishuElicitationCustomExpanded(message, elicitation.currentQuestionIndex);
    if (selection && shouldShowCancel) {
      const customExpanded = isFeishuElicitationCustomExpanded(
        message,
        elicitation.currentQuestionIndex,
      );
      elements.push(
        ...(selection.showCancel === false
          ? []
          : [
              buildFeishuButtonElement({
                text:
                  selection.cancelLabel ??
                  formatBotMessage(message.locale, "selectionCancelOption"),
                type: "default",
                command:
                  customExpanded && currentQuestion.options.length > 0
                    ? buildFeishuElicitationOptionCommand(
                        message,
                        FEISHU_ELICITATION_CUSTOM_OPTION_ID,
                      )
                    : "/cancel",
                originalText: message.text,
              }),
            ]),
      );
    }
  } else if (elicitation.status === "cancelled") {
    elements.push({
      tag: "markdown",
      content: formatFeishuCardMarkdownContent(
        formatBotMessage(message.locale, "elicitationCancelledCard"),
      ),
    });
  }
  return {
    schema: "2.0",
    config: { wide_screen_mode: true },
    body: { elements },
  };
}

function getFeishuDomainProvider(bot: Pick<BotConfig, "provider">): "feishu" | "lark" {
  return bot.provider === "lark" ? "lark" : "feishu";
}

function readFeishuPayloadProvider(payload: Record<string, unknown>): BotProvider {
  return readString(payload, "zcodeProvider") === "lark" ? "lark" : "feishu";
}

function getFeishuBaseUrl(bot: Pick<BotConfig, "provider">): string {
  return getFeishuDomainProvider(bot) === "lark"
    ? "https://open.larksuite.com"
    : "https://open.feishu.cn";
}

function readString(record: Record<string, unknown> | null | undefined, key: string): string {
  const value = record?.[key];
  return typeof value === "string" ? value : "";
}

function readFeishuCallbackEvent(payload: Record<string, unknown>): Record<string, unknown> {
  const event = isRecord(payload.event) ? payload.event : null;
  return event ?? payload;
}

function readFeishuChatType(value: string): "private" | "group" {
  return value === "group" || value === "group_chat" ? "group" : "private";
}

function parseJsonRecord(value: unknown): Record<string, unknown> | null {
  if (isRecord(value)) {
    return value;
  }
  if (typeof value !== "string") {
    return null;
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function stripFeishuMentions(text: string): string {
  return text
    .replace(/<at\b[^>]*>.*?<\/at>/giu, "")
    .replace(/@\S+/gu, "")
    .trim();
}

function readFeishuPostLocaleContent(content: Record<string, unknown>): unknown {
  const post = isRecord(content.post) ? content.post : null;
  const zhCn = isRecord(content.zh_cn) ? content.zh_cn : isRecord(post?.zh_cn) ? post.zh_cn : null;
  const enUs = isRecord(content.en_us) ? content.en_us : isRecord(post?.en_us) ? post.en_us : null;
  return content.content ?? zhCn?.content ?? enUs?.content;
}

function readFeishuPostLocaleTitle(content: Record<string, unknown>): string {
  const post = isRecord(content.post) ? content.post : null;
  const zhCn = isRecord(content.zh_cn) ? content.zh_cn : isRecord(post?.zh_cn) ? post.zh_cn : null;
  const enUs = isRecord(content.en_us) ? content.en_us : isRecord(post?.en_us) ? post.en_us : null;
  return readString(content, "title") || readString(zhCn, "title") || readString(enUs, "title");
}

function formatFeishuPostToken(token: unknown): string {
  if (typeof token === "string") {
    return token;
  }
  if (Array.isArray(token)) {
    return token.map(formatFeishuPostToken).filter(Boolean).join("");
  }
  if (!isRecord(token)) {
    return "";
  }
  const tag = readString(token, "tag");
  if (tag === "at") {
    return "";
  }
  const nested = token.content ?? token.children ?? token.elements;
  const nestedText = Array.isArray(nested) ? formatFeishuPostToken(nested) : "";
  const text =
    readString(token, "text") ||
    readString(token, "un_escape_text") ||
    readString(token, "name") ||
    nestedText;
  if (tag === "a") {
    const href = readString(token, "href");
    if (href && href !== text) {
      return text ? `${text} ${href}` : href;
    }
  }
  return text;
}

function readFeishuPostText(content: Record<string, unknown> | null): string {
  if (!content) {
    return "";
  }
  const postContent = readFeishuPostLocaleContent(content);
  const lines = Array.isArray(postContent)
    ? postContent
        .map((line) => formatFeishuPostToken(line).trim())
        .filter(Boolean)
    : [];
  const title = readFeishuPostLocaleTitle(content).trim();
  const body = lines.join("\n").trim();
  if (title && body) {
    return `${title}\n${body}`;
  }
  return body || title;
}

function inferFeishuAttachmentKind(msgType: string): BotInboundAttachment["kind"] {
  if (msgType === "image") return "image";
  if (msgType === "audio") return "audio";
  if (msgType === "media" || msgType === "video") return "video";
  return "file";
}

function defaultFeishuMimeType(kind: BotInboundAttachment["kind"]): string {
  if (kind === "image") return "image/jpeg";
  if (kind === "audio") return "audio/mpeg";
  if (kind === "video") return "video/mp4";
  return "application/octet-stream";
}

function readFeishuAttachment(
  msgType: string,
  content: Record<string, unknown> | null,
): BotInboundAttachment | null {
  if (!content) {
    return null;
  }
  const providerFileId =
    readString(content, "image_key") ||
    readString(content, "file_key") ||
    readString(content, "media_key") ||
    readString(content, "audio_key") ||
    readString(content, "key");
  if (!providerFileId) {
    return null;
  }
  const kind = inferFeishuAttachmentKind(msgType);
  const filename =
    readString(content, "file_name") ||
    readString(content, "filename") ||
    `${msgType}-${providerFileId.slice(0, 8)}`;
  const mimeType =
    readString(content, "mime_type") ||
    readString(content, "mimeType") ||
    defaultFeishuMimeType(kind);
  return {
    id: providerFileId,
    kind,
    filename,
    mimeType,
    ...(typeof content.size === "number" ? { sizeBytes: content.size } : {}),
    providerFileId,
  };
}

function readFeishuTextMessage(botId: string, payload: Record<string, unknown>): BotInboundMessage | null {
  const provider = readFeishuPayloadProvider(payload);
  // Bugfix: Feishu node-sdk's WebSocket EventDispatcher may flatten the event field to the top level under different events/versions.
  // Previously, only payload.event.message was readable. When a long connection did receive a message, it would also be parsed into 0 inbound messages.
  const event = isRecord(payload.event) ? payload.event : payload;
  const message = isRecord(event?.message) ? event.message : null;
  const sender = isRecord(event?.sender) ? event.sender : null;
  const senderId = isRecord(sender?.sender_id) ? sender.sender_id : null;
  const content = parseJsonRecord(message?.content);
  const msgType = readString(message, "message_type") || readString(message, "msg_type");
  const attachment = readFeishuAttachment(msgType, content);
  // Bugfix: Rich text/link messages that look like ordinary text in the Feishu client will be pushed with message_type=post.
  // Previously, only content.text was read, and the post message was parsed into empty text and discarded directly, so the user side behaved like "a normal message was sent but the app did not respond."
  const rawText =
    readString(content, "text") ||
    readFeishuPostText(content) ||
    readString(event, "text_without_at_bot") ||
    readString(event, "text");
  const text = stripFeishuMentions(rawText);
  const userId =
    readString(senderId, "open_id") ||
    readString(senderId, "user_id") ||
    readString(senderId, "union_id") ||
    readString(event, "open_id") ||
    readString(event, "user_id") ||
    readString(event, "union_id");
  const chatId = readString(message, "chat_id") || readString(event, "open_chat_id");
  const messageId = readString(message, "message_id");
  if ((!text && !attachment) || !userId) {
    return null;
  }
  const chatType = readFeishuChatType(readString(message, "chat_type") || readString(event, "chat_type"));
  return {
    botId,
    text,
    ...(attachment ? { attachments: [attachment] } : {}),
    actor: {
      provider,
      botId,
      providerUserId: userId,
      chatType,
      chatId: chatType === "group" && chatId ? chatId : undefined,
      providerMessageId: messageId || undefined,
    },
  };
}

function readFeishuCardAction(botId: string, payload: Record<string, unknown>): BotInboundMessage | null {
  const provider = readFeishuPayloadProvider(payload);
  const event = readFeishuCallbackEvent(payload);
  const action = isRecord(event.action) ? event.action : null;
  const value = isRecord(action?.value) ? action.value : null;
  const formValue = isRecord(action?.form_value) ? action.form_value : null;
  const behavior = Array.isArray(action?.behaviors) ? action.behaviors.find(isRecord) : null;
  const behaviorValue = isRecord(behavior?.value) ? behavior.value : null;
  const rawCommand =
    readString(value, "command") ||
    readString(value, "text") ||
    readString(behaviorValue, "command") ||
    readString(behaviorValue, "text");
  const submittedAnswer = formValue?.[FEISHU_ELICITATION_FORM_FIELD_NAME];
  const command =
    rawCommand && rawCommand.includes(FEISHU_ELICITATION_FORM_VALUE_PREFIX)
      ? buildFeishuElicitationFormCommand(
          rawCommand.split(/\s+/u)[1] ?? "",
          submittedAnswer,
        )
      : rawCommand;
  const operator = isRecord(event.operator) ? event.operator : null;
  const operatorId = isRecord(operator?.operator_id) ? operator.operator_id : null;
  const openId =
    readString(operatorId, "open_id") ||
    readString(operator, "open_id") ||
    readString(event, "open_id") ||
    readString(event, "user_id") ||
    readString(payload, "open_id") ||
    readString(payload, "user_id");
  const context = isRecord(event.context) ? event.context : null;
  const contextChatType = readString(context, "chat_type") || readString(event, "chat_type") || readString(payload, "chat_type");
  const chatId = readString(context, "open_chat_id") || readString(context, "chat_id");
  const message = isRecord(event.message) ? event.message : null;
  const header = isRecord(payload.header) ? payload.header : null;
  const providerMessageId =
    readString(event, "event_id") ||
    readString(header, "event_id") ||
    readString(payload, "uuid") ||
    readString(payload, "event_id") ||
    readString(context, "open_message_id") ||
    readString(context, "message_id") ||
    readString(message, "message_id") ||
    readString(action, "value_id");
  if (!command || !openId) {
    return null;
  }
  // Bugfix: The context.open_chat_id of Feishu card callback may also exist in the private chat button.
  // Previously, when using the chatId to determine whether a group chat existed, the card button in the private chat would be mistakenly rejected as "only supports private chat".
  const chatType = readFeishuChatType(contextChatType);
  return {
    botId,
    text: command,
    actor: {
      provider,
      botId,
      providerUserId: openId,
      chatType,
      chatId: chatType === "group" && chatId ? chatId : undefined,
      ...(providerMessageId ? { providerMessageId } : {}),
    },
  };
}

function readFeishuCardUpdateToken(payload: unknown): string {
  if (!isRecord(payload)) {
    return "";
  }
  const event = readFeishuCallbackEvent(payload);
  const action = isRecord(event.action) ? event.action : null;
  const context = isRecord(event.context) ? event.context : null;
  // Bugfix: Card JSON 2.0 callback's updated token is not always on the old action.token.
  // When the new version of the button is triggered by behaviors.callback, Feishu/Lark may put the token on the event or context; missing the read will cause card/update to be silently skipped and the button to remain in the original card.
  return (
    readString(event, "token") ||
    readString(event, "card_update_token") ||
    readString(event, "update_token") ||
    readString(payload, "token") ||
    readString(payload, "card_update_token") ||
    readString(payload, "update_token") ||
    readString(action, "token") ||
    readString(action, "card_update_token") ||
    readString(action, "update_token") ||
    readString(context, "token") ||
    readString(context, "card_update_token") ||
    readString(context, "update_token")
  );
}

function readFeishuCardUpdateOpenIds(payload: unknown): string[] {
  if (!isRecord(payload)) {
    return [];
  }
  const event = readFeishuCallbackEvent(payload);
  const operator = isRecord(event.operator) ? event.operator : null;
  const operatorId = isRecord(operator?.operator_id) ? operator.operator_id : null;
  const openId =
    readString(operatorId, "open_id") ||
    readString(operator, "open_id") ||
    readString(event, "open_id") ||
    readString(payload, "open_id");
  return openId ? [openId] : [];
}

function readFeishuCardOriginalText(payload: unknown): string | null {
  if (!isRecord(payload)) {
    return null;
  }
  const event = readFeishuCallbackEvent(payload);
  const action = isRecord(event.action) ? event.action : null;
  const value = isRecord(action?.value) ? action.value : null;
  const behavior = Array.isArray(action?.behaviors) ? action.behaviors.find(isRecord) : null;
  const behaviorValue = isRecord(behavior?.value) ? behavior.value : null;
  return (
    readString(value, "zcodeCardText") ||
    readString(value, "cardText") ||
    readString(behaviorValue, "zcodeCardText") ||
    readString(behaviorValue, "cardText") ||
    null
  );
}

function formatFeishuCardMarkdownContent(text: string): string {
  const lines: Array<{ text: string; hardBreak: boolean }> = [];
  let inCodeFence = false;
  for (const line of text.split("\n")) {
    if (line.trimStart().startsWith("```")) {
      inCodeFence = !inCodeFence;
    }
    if (!inCodeFence && /^-{3,}$/.test(line.trim())) {
      if (lines.length > 0 && lines.at(-1)?.text !== "") {
        lines.push({ text: "", hardBreak: false });
      }
      lines.push({ text: "---", hardBreak: false }, { text: "", hardBreak: false });
      continue;
    }
    lines.push({ text: line, hardBreak: !inCodeFence });
  }
  return lines
    .map((line, index) => {
      if (!line.text || !line.hardBreak || index >= lines.length - 1 || !lines[index + 1]?.text) {
        return line.text;
      }
      // Bugfix: Card JSON 2.0's markdown processes single line breaks according to standard Markdown, and will fold /status multi-line text into one line.
      // In the Feishu channel, ordinary single line breaks are converted into hard breaks, and the original text used by other bots is retained in the business layer.
      return `${line.text}  `;
    })
    .join("\n");
}

function buildFeishuButtonElement(params: {
  text: string;
  type: "default" | "primary";
  command: string;
  originalText: string;
}): Record<string, unknown> {
  return {
    tag: "button",
    text: {
      tag: "plain_text",
      content: params.text,
    },
    type: params.type,
    // Bugfix: Card JSON 2.0 no longer supports the legacy action/actions container.
    // The button must be directly used as the body.elements component and return the business value through behaviors.callback, otherwise Feishu will return HTTP 400.
    behaviors: [
      {
        type: "callback",
        value: {
          command: params.command,
          zcodeCardText: params.originalText,
        },
      },
    ],
  };
}

function buildFeishuInteractiveCardPayload(
  message: BotOutboundMessage,
): Record<string, unknown> {
  const selection = message.selection;
  const elements: Array<Record<string, unknown>> = [
    {
      tag: "markdown",
      content: formatFeishuCardMarkdownContent(message.text),
    },
  ];
  if (selection) {
    elements.push(
      ...selection.options.map((option, index) =>
        buildFeishuButtonElement({
          text: option.label || String(index + 1),
          type: "primary",
          command: formatSelectionCommand(selection, option.id),
          originalText: message.text,
        }),
      ),
      ...(selection.showCancel === false
        ? []
        : [
            buildFeishuButtonElement({
              text:
                selection.cancelLabel ??
                formatBotMessage(message.locale, "selectionCancelOption"),
              type: "default",
              // Bugfix: Feishu's structured tab should not reuse the 0 cancellation semantics of WeChat's plain text menu.
              command: "/cancel",
              originalText: message.text,
            }),
          ]),
    );
  }
  return {
    schema: "2.0",
    config: { wide_screen_mode: true },
    body: { elements },
  };
}

function formatFeishuStreamingStatus(state: BotStreamingReplyCardState): string {
  // Bugfix: The streaming card status line is generated by the provider and must read the locale passed by the BotService.
  // Otherwise, Running/Completed will be permanently displayed in the Chinese environment.
  const locale = state.locale;
  const status = state.status;
  if (status === "completed") {
    return formatBotMessage(locale, "streamingStatusCompleted");
  }
  if (status === "error") {
    return formatBotMessage(locale, "streamingStatusFailed");
  }
  return formatBotMessage(locale, "streamingStatusRunning");
}

function buildFeishuStreamingToolPanel(
  toolSummaries: readonly string[],
  options: { expanded: boolean; title: string },
): Record<string, unknown> | null {
  const summaries = toolSummaries
    .map((summary) => summary.trim())
    .filter((summary) => summary.length > 0);
  if (summaries.length === 0) {
    return null;
  }
  return {
    tag: "collapsible_panel",
    // Bugfix: Users need to be able to see a summary of the current tool when the streaming card is running; it will be automatically folded after the task is completed to reduce the space occupied by the final message.
    expanded: options.expanded,
    // Bugfix: Tool summaries were previously just bare collapsible panels, with no clear visual boundary between them and the main text.
    // The folding panel of Feishu Card JSON 2.0 supports background and borders. Here, it is used as a <tools> container to host header/content.
    background_color: "grey-50",
    border: {
      color: "grey",
      corner_radius: "8px",
    },
    padding: "8px 8px 8px 8px",
    header: {
      title: {
        tag: "plain_text",
        content: `🛠️ ${options.title} (${summaries.length})`,
      },
      vertical_align: "center",
      padding: "8px 8px 8px 8px",
      icon: {
        tag: "standard_icon",
        token: "down-small-ccm_outlined",
        color: "grey",
        size: "16px 16px",
      },
      icon_position: "right",
      icon_expanded_angle: -180,
    },
    elements: [
      {
        tag: "markdown",
        content: formatFeishuCardMarkdownContent(summaries.join("\n")),
      },
    ],
  };
}

function buildFeishuStreamingCardPayload(state: BotStreamingReplyCardState): Record<string, unknown> {
  const elements: Array<Record<string, unknown>> = [];
  for (const block of state.blocks) {
    if (block.type === "message") {
      const text = block.text.trim();
      if (text) {
        elements.push({
          tag: "markdown",
          content: formatFeishuCardMarkdownContent(text),
        });
      }
      continue;
    }
    const toolPanel = buildFeishuStreamingToolPanel(block.summaries, {
      expanded: block.expanded ?? state.status === "running",
      title:
        block.title?.trim() ||
        formatBotMessage(state.locale, "streamingToolSummaries"),
    });
    if (toolPanel) {
      elements.push(toolPanel);
    }
  }
  if (elements.length === 0) {
    elements.push({
      tag: "markdown",
      content: " ",
    });
  }
  if (state.status !== "sealed") {
    elements.push({
      tag: "markdown",
      content: formatFeishuCardMarkdownContent(`_${formatFeishuStreamingStatus(state)}_`),
    });
  }
  return {
    schema: "2.0",
    config: { wide_screen_mode: true },
    body: { elements },
  };
}

function countTaggedElements(value: unknown): number {
  if (Array.isArray(value)) {
    return value.reduce((total, item) => total + countTaggedElements(item), 0);
  }
  if (!value || typeof value !== "object") {
    return 0;
  }
  const record = value as Record<string, unknown>;
  return (typeof record.tag === "string" ? 1 : 0) +
    Object.values(record).reduce<number>(
      (total, item) => total + countTaggedElements(item),
      0,
    );
}

export function countFeishuCardTaggedElements(
  state: BotStreamingReplyCardState,
): number {
  return countTaggedElements(buildFeishuStreamingCardPayload(state));
}

export function splitFeishuStreamingCardStates(
  state: BotStreamingReplyCardState,
): BotStreamingReplyCardState[] {
  const blockGroups: BotStreamingReplyCardState["blocks"][] = [];
  let current: BotStreamingReplyCardState["blocks"] = [];
  for (const block of state.blocks) {
    const candidate = [...current, block];
    // Always budget for status lines so that running/completed switches do not change existing segment boundaries.
    const candidateState = { ...state, blocks: candidate, status: "running" as const };
    if (
      current.length > 0 &&
      countFeishuCardTaggedElements(candidateState) >
        FEISHU_STREAMING_CARD_TAGGED_ELEMENT_BUDGET
    ) {
      blockGroups.push(current);
      current = [block];
    } else {
      current = candidate;
    }
  }
  blockGroups.push(current);
  return blockGroups.map((blocks, index) => ({
    ...state,
    blocks,
    status: index === blockGroups.length - 1 ? state.status : "sealed",
  }));
}

function splitFeishuText(text: string): string[] {
  const limit = 1900;
  const chunks: string[] = [];
  for (let index = 0; index < text.length; index += limit) {
    chunks.push(text.slice(index, index + limit));
  }
  return chunks.length > 0 ? chunks : [text];
}

async function readTenantAccessToken(
  bot: BotConfig,
  deps: FeishuProviderDeps,
  signal?: AbortSignal,
): Promise<string | null> {
  if (!bot.feishuAppId || !bot.credentialRef) {
    return null;
  }
  const appSecret = await deps.loadCredential(bot.credentialRef);
  if (!appSecret) {
    return null;
  }
  const cacheKey = `${getFeishuDomainProvider(bot)}:${bot.feishuAppId}:${bot.credentialRef}`;
  const cached = accessTokenCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now() + 60_000) {
    return cached.token;
  }
  const response = await fetchBotProviderJson<FeishuAccessTokenResponse>(`${getFeishuBaseUrl(bot)}/open-apis/auth/v3/tenant_access_token/internal`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      app_id: bot.feishuAppId,
      app_secret: appSecret,
    }),
    signal,
  });
  if (!response.ok) {
    throw new Error(`Feishu tenant_access_token failed: HTTP ${response.status}`);
  }
  const payload = response.payload ?? {};
  if (payload.code !== 0 || !payload.tenant_access_token) {
    throw new Error(payload.msg || "Feishu tenant_access_token failed.");
  }
  accessTokenCache.set(cacheKey, {
    token: payload.tenant_access_token,
    expiresAt: Date.now() + 90 * 60_000,
  });
  return payload.tenant_access_token;
}

function resolveFeishuReceiveIdType(receiveId: string): "chat_id" | "open_id" {
  return receiveId.startsWith("oc_") ? "chat_id" : "open_id";
}

function createFeishuMessageError(
  operation: string,
  status: number,
  payload: FeishuSendMessageResponse | undefined,
  responseLogId?: string,
  receiveIdType?: string,
): Error {
  const details = [
    typeof payload?.code === "number" ? `code=${payload.code}` : null,
    payload?.msg ? `msg=${payload.msg}` : null,
    payload?.error?.log_id || responseLogId
      ? `log_id=${payload?.error?.log_id ?? responseLogId}`
      : null,
    receiveIdType ? `receive_id_type=${receiveIdType}` : null,
  ].filter((detail): detail is string => Boolean(detail));
  // Reason for fix: Feishu's HTTP 400 will carry business error code, reason and troubleshooting log_id in the response body.
  // The old implementation first throws errors based on HTTP status, causing the parsed information to be permanently lost and unable to distinguish between permissions, current limits, and card errors.
  return new Error(
    `Feishu ${operation} failed: HTTP ${status}${details.length > 0 ? `, ${details.join(", ")}` : ""}`,
  );
}

async function sendFeishuInteractiveCard(
  bot: BotConfig,
  token: string,
  receiveId: string,
  card: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<string | null> {
  const response = await fetchBotProviderJson<FeishuSendMessageResponse>(
    `${getFeishuBaseUrl(bot)}/open-apis/im/v1/messages?receive_id_type=${resolveFeishuReceiveIdType(receiveId)}`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        receive_id: receiveId,
        msg_type: "interactive",
        content: JSON.stringify(card),
      }),
      signal,
    },
  );
  const payload = response.payload ?? {};
  // HTTP success may also carry business rejection, and the error code and request ID must be retained.
  if (!response.ok || payload.code !== 0) {
    throw createFeishuMessageError(
      "send interactive message",
      response.status,
      payload,
      response.responseLogId,
      resolveFeishuReceiveIdType(receiveId),
    );
  }
  return payload.data?.message_id ?? null;
}

async function updateFeishuInteractiveMessage(
  bot: BotConfig,
  token: string,
  handle: BotStreamingReplyCardHandle,
  card: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<void> {
  const response = await fetchBotProviderJson<FeishuSendMessageResponse>(
    `${getFeishuBaseUrl(bot)}/open-apis/im/v1/messages/${encodeURIComponent(handle.providerMessageId)}`,
    {
      method: "PATCH",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        msg_type: "interactive",
        content: JSON.stringify(card),
      }),
      signal,
    },
  );
  const payload = response.payload ?? {};
  // HTTP success may also carry business rejection, and the error code and request ID must be retained.
  if (!response.ok || payload.code !== 0) {
    throw createFeishuMessageError(
      "update streaming card",
      response.status,
      payload,
      response.responseLogId,
    );
  }
}

async function deleteFeishuInteractiveMessage(
  bot: BotConfig,
  token: string,
  handle: BotTransientInteractionCardHandle,
): Promise<void> {
  const response = await fetchBotProviderJson<FeishuSendMessageResponse>(
    `${getFeishuBaseUrl(bot)}/open-apis/im/v1/messages/${encodeURIComponent(handle.providerMessageId)}`,
    {
      method: "DELETE",
      headers: {
        authorization: `Bearer ${token}`,
      },
    },
  );
  if (!response.ok) {
    throw new Error(`Feishu recall interaction card failed: HTTP ${response.status}`);
  }
  const payload = response.payload ?? {};
  if (payload.code !== 0) {
    throw new Error(payload.msg || "Feishu recall interaction card failed.");
  }
}

function resolveFeishuAppDisplayName(payload: FeishuAppInfoResponse): string | null {
  const app = payload.data?.app;
  const appName = app?.app_name?.trim();
  if (appName) {
    return appName;
  }
  const primaryLanguage = app?.primary_language?.trim();
  const primaryI18nName = app?.i18n
    ?.find((item) => item.i18n_key === primaryLanguage)
    ?.name?.trim();
  if (primaryI18nName) {
    return primaryI18nName;
  }
  return app?.i18n?.find((item) => item.name?.trim())?.name?.trim() ?? null;
}

async function fetchFeishuAppDisplayName(
  bot: BotConfig,
  token: string,
  appId: string,
): Promise<string | null> {
  const response = await fetchBotProviderJson<FeishuAppInfoResponse>(`${getFeishuBaseUrl(bot)}/open-apis/application/v6/applications/${appId}?lang=zh_cn`, {
    headers: {
      authorization: `Bearer ${token}`,
    },
  });
  if (!response.ok) {
    throw new Error(`Feishu get application info failed app=${appId}: HTTP ${response.status}`);
  }
  const payload = response.payload ?? {};
  if (payload.code !== 0) {
    throw new Error(payload.msg || `Feishu get application info failed app=${appId}.`);
  }
  return resolveFeishuAppDisplayName(payload);
}

async function readFeishuAppDisplayName(bot: BotConfig, deps: FeishuProviderDeps): Promise<string | null> {
  if (!bot.feishuAppId) {
    return null;
  }
  const token = await readTenantAccessToken(bot, deps);
  if (!token) {
    return null;
  }
  let appIdError: unknown;
  try {
    const appName = await fetchFeishuAppDisplayName(bot, token, bot.feishuAppId);
    if (appName?.trim()) {
      return appName;
    }
  } catch (error) {
    appIdError = error;
  }
  try {
    // Bugfix: After Feishu/Lark scan code creation, the app_id path may be temporarily unreadable due to permissions or synchronization delays; the me path is more suitable for reading the current application name.
    return await fetchFeishuAppDisplayName(bot, token, "me");
  } catch (error) {
    throw appIdError ?? error;
  }
}

function resolveFeishuUserIdType(userId: string): "open_id" | "union_id" | "user_id" {
  if (userId.startsWith("ou_")) {
    return "open_id";
  }
  if (userId.startsWith("on_")) {
    return "union_id";
  }
  return "user_id";
}

function resolveFeishuUserDisplayName(payload: FeishuUserInfoResponse): string | null {
  const user = payload.data?.user;
  return user?.name?.trim() || user?.en_name?.trim() || user?.nickname?.trim() || null;
}

async function readFeishuUserDisplayName(
  bot: BotConfig,
  deps: FeishuProviderDeps,
  userId: string,
): Promise<string | null> {
  const trimmedUserId = userId.trim();
  if (!trimmedUserId) {
    return null;
  }
  const cacheKey = `${getFeishuDomainProvider(bot)}:${bot.feishuAppId ?? ""}:${bot.credentialRef ?? ""}:${trimmedUserId}`;
  const cached = userDisplayNameCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.name;
  }
  const token = await readTenantAccessToken(bot, deps);
  if (!token) {
    return null;
  }
  const userIdType = resolveFeishuUserIdType(trimmedUserId);
  const response = await fetchBotProviderJson<FeishuUserInfoResponse>(
    `${getFeishuBaseUrl(bot)}/open-apis/contact/v3/users/${encodeURIComponent(trimmedUserId)}?user_id_type=${userIdType}`,
    {
      headers: {
        authorization: `Bearer ${token}`,
      },
    },
  );
  if (!response.ok) {
    throw new Error(`Feishu get user info failed user=${trimmedUserId}: HTTP ${response.status}`);
  }
  const payload = response.payload ?? {};
  if (payload.code !== 0) {
    throw new Error(payload.msg || `Feishu get user info failed user=${trimmedUserId}.`);
  }
  const name = resolveFeishuUserDisplayName(payload);
  // Bugfix: Feishu message events only stably carry sender_id and do not carry sender name.
  // The address book query results are cached here to avoid requesting the contact API for each message sent continuously by the same user.
  userDisplayNameCache.set(cacheKey, {
    name,
    expiresAt: Date.now() + 10 * 60_000,
  });
  return name;
}

function getFeishuTypingReactionKey(bot: BotConfig, messageId: string): string {
  return `${bot.id}:${messageId}`;
}

async function addFeishuTypingReaction(
  bot: BotConfig,
  deps: FeishuProviderDeps,
  messageId: string,
): Promise<void> {
  const token = await readTenantAccessToken(bot, deps);
  if (!token) {
    return;
  }
  const key = getFeishuTypingReactionKey(bot, messageId);
  if (typingReactionIds.has(key)) {
    return;
  }
  const response = await fetchBotProviderJson<FeishuReactionResponse>(
    `${getFeishuBaseUrl(bot)}/open-apis/im/v1/messages/${messageId}/reactions`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        reaction_type: {
          emoji_type: "Typing",
        },
      }),
    },
  );
  if (!response.ok) {
    throw new Error(`Feishu add typing reaction failed: HTTP ${response.status}`);
  }
  const payload = response.payload ?? {};
  if (payload.code !== 0) {
    throw new Error(payload.msg || "Feishu add typing reaction failed.");
  }
  if (payload.data?.reaction_id) {
    typingReactionIds.set(key, payload.data.reaction_id);
  }
}

async function deleteFeishuTypingReaction(
  bot: BotConfig,
  deps: FeishuProviderDeps,
  messageId: string,
): Promise<void> {
  const key = getFeishuTypingReactionKey(bot, messageId);
  const reactionId = typingReactionIds.get(key);
  if (!reactionId) {
    return;
  }
  const token = await readTenantAccessToken(bot, deps);
  if (!token) {
    return;
  }
  const response = await fetchBotProviderJson<FeishuReactionResponse>(
    `${getFeishuBaseUrl(bot)}/open-apis/im/v1/messages/${messageId}/reactions/${reactionId}`,
    {
      method: "DELETE",
      headers: {
        authorization: `Bearer ${token}`,
      },
    },
  );
  if (!response.ok) {
    throw new Error(`Feishu delete typing reaction failed: HTTP ${response.status}`);
  }
  const payload = response.payload ?? {};
  if (payload.code !== 0) {
    throw new Error(payload.msg || "Feishu delete typing reaction failed.");
  }
  typingReactionIds.delete(key);
}

async function readFeishuAppSecret(bot: BotConfig, deps: FeishuProviderDeps): Promise<string | null> {
  if (!bot.feishuAppId || !bot.credentialRef) {
    return null;
  }
  return deps.loadCredential(bot.credentialRef);
}

export function createFeishuWebSocketEventHandlers(params: {
  bot: BotConfig;
  onPayload: (payload: unknown) => Promise<BotOutboundMessage | undefined>;
}) {
  const { bot, onPayload } = params;
  return {
    "im.message.receive_v1": async (payload: unknown) => {
      await onPayload({ botId: bot.id, zcodeProvider: bot.provider, ...(isRecord(payload) ? payload : { payload }) });
    },
    // Bugfix: We use Typing reaction to simulate the input state, and Feishu will push the reaction it created back to the long connection.
    // The business does not need to handle this event, but when the handler is not registered, the SDK will continue to print warn to interfere with troubleshooting.
    "im.message.reaction.created_v1": async () => undefined,
    "card.action.trigger": async (payload: unknown) => {
      const callbackPayload = {
        botId: bot.id,
        zcodeProvider: bot.provider,
        zcodeFeishuSynchronousCardAction: true,
        ...(isRecord(payload) ? payload : { payload }),
      };
      // Reason for repair: The synchronous response after Feishu clicks is the card status that the client can reliably adopt. The transport layer can no longer be accessed from
      // zcodeCardText spells the simplified card and cannot rely on bypass PATCH after returning undefined; it must consume the business layer
      // The complete outbound has been advanced and the next question card is generated using the same elicitation state.
      const message = await onPayload(callbackPayload);
      if (!message) {
        return undefined;
      }
      return {
        card: {
          type: "raw",
          data: message.elicitation
            ? buildFeishuElicitationCardPayload(message)
            : buildFeishuInteractiveCardPayload(message),
        },
      };
    },
  };
}

export async function startFeishuBotWebSocket(params: {
  bot: BotConfig;
  deps: FeishuProviderDeps;
  onPayload: (payload: unknown) => Promise<BotOutboundMessage | undefined>;
  signal?: AbortSignal;
  onConnectionStateChange?: (state: "reconnecting" | "connected") => void;
}): Promise<FeishuWebSocketClient> {
  const { bot, deps, onPayload, signal, onConnectionStateChange } = params;
  const appId = bot.feishuAppId;
  if (!appId || !FEISHU_APP_ID_PATTERN.test(appId)) {
    throw new Error("Invalid Feishu App ID.");
  }
  const appSecret = await readFeishuAppSecret(bot, deps);
  if (!appSecret) {
    throw new Error("Feishu App ID and App Secret are required.");
  }
  if (signal?.aborted) {
    throw new Error("Feishu WebSocket startup aborted.");
  }
  // The full source code of the SDK will be resident on the Host; it will only be loaded when the long connection is actually started. Cards and HTTP paths do not bear this overhead.
  const Lark = await import("@larksuiteoapi/node-sdk");
  // The channel may be deactivated during loading and late arriving modules cannot re-create the connection.
  if (signal?.aborted) {
    throw new Error("Feishu WebSocket startup aborted.");
  }
  const eventDispatcher = new Lark.EventDispatcher({});
  eventDispatcher.register(createFeishuWebSocketEventHandlers({ bot, onPayload }));
  return new Promise<FeishuWebSocketClient>((resolve, reject) => {
    let startupSettled = false;
    let lifecycleSettled = false;
    let clientClosed = false;
    let connectionUnavailable = false;
    let startupTimer: ReturnType<typeof setTimeout> | undefined;
    let connectionPoll: ReturnType<typeof setInterval> | undefined;
    let resolveTerminated: (() => void) | undefined;
    let rejectTerminated: ((error: unknown) => void) | undefined;
    const terminated = new Promise<void>((resolveLifecycle, rejectLifecycle) => {
      resolveTerminated = resolveLifecycle;
      rejectTerminated = rejectLifecycle;
    });
    const finishLifecycle = (error?: unknown) => {
      if (lifecycleSettled) return;
      lifecycleSettled = true;
      if (connectionPoll) clearInterval(connectionPoll);
      if (error) {
        rejectTerminated?.(error);
      } else {
        resolveTerminated?.();
      }
    };
    const fail = (error: unknown) => {
      if (startupSettled) return;
      startupSettled = true;
      if (startupTimer) clearTimeout(startupTimer);
      signal?.removeEventListener("abort", handleAbort);
      closeClient();
      reject(error);
    };
    function handleAbort() {
      fail(new Error("Feishu WebSocket startup aborted."));
    }
    function closeClient() {
      if (clientClosed) return;
      clientClosed = true;
      finishLifecycle();
      wsClient.close();
    }
    const wsClient = new Lark.WSClient({
      appId,
      appSecret,
      domain: getFeishuDomainProvider(bot) === "lark" ? Lark.Domain.Lark : Lark.Domain.Feishu,
      loggerLevel: Lark.LoggerLevel.info,
    });
    // Reason for fix: The current Feishu SDK does not support the onReady callback, and start() will also return before the connection is completed.
    // It is necessary to observe the real WebSocket held by the SDK to avoid triggering a 20-second timeout and being actively closed after the connection has been OPEN.
    connectionPoll = setInterval(() => {
      const sdkClient = wsClient as unknown as {
        isConnecting?: boolean;
        wsConfig?: {
          getWSInstance?(): { readyState?: number } | null;
        };
      };
      const connected =
        sdkClient.wsConfig?.getWSInstance?.()?.readyState ===
        WEBSOCKET_OPEN_READY_STATE;
      if (!connected) {
        if (!startupSettled || clientClosed) return;
        if (!connectionUnavailable) {
          connectionUnavailable = true;
          onConnectionStateChange?.("reconnecting");
        }
        if (sdkClient.isConnecting === false) {
          const error = new Error("Feishu WebSocket reconnect exhausted.");
          finishLifecycle(error);
          closeClient();
        }
        return;
      }
      if (startupSettled) {
        if (connectionUnavailable) {
          connectionUnavailable = false;
          onConnectionStateChange?.("connected");
        }
        return;
      }
      startupSettled = true;
      if (startupTimer) clearTimeout(startupTimer);
      signal?.removeEventListener("abort", handleAbort);
      resolve({ close: closeClient, terminated });
    }, FEISHU_WEBSOCKET_READY_POLL_MS);
    startupTimer = setTimeout(() => {
      fail(
        new Error(
          `Feishu WebSocket startup timed out after ${FEISHU_WEBSOCKET_START_TIMEOUT_MS}ms.`,
        ),
      );
    }, FEISHU_WEBSOCKET_START_TIMEOUT_MS);
    signal?.addEventListener("abort", handleAbort, { once: true });
    if (signal?.aborted) {
      handleAbort();
      return;
    }
    // Feishu does not require a public network callback address; here, the local machine actively establishes a long connection to receive events, adapting to the home network/NAT environment.
    void wsClient.start({ eventDispatcher }).catch((error: unknown) => {
      if (!startupSettled) {
        fail(error);
        return;
      }
      finishLifecycle(error);
      closeClient();
    });
  });
}

export function createFeishuBotProvider(deps: FeishuProviderDeps): BotProviderAdapter {
  async function trackDelivery<T>(
    bot: BotConfig,
    signal: AbortSignal | undefined,
    write: () => Promise<T>,
  ): Promise<T> {
    try {
      const result = await write();
      if (!signal?.aborted) deps.onDeliveryResult?.(bot, undefined);
      return result;
    } catch (error) {
      // Active cancellation does not mean Feishu refuses delivery, nor does it overwrite existing diagnoses; task timeouts are still handled by the watcher.
      if (!signal?.aborted)
        deps.onDeliveryResult?.(bot, error instanceof Error ? error.message : String(error));
      throw error;
    }
  }
  const sendCard = (...args: Parameters<typeof sendFeishuInteractiveCard>) =>
    trackDelivery(args[0], args[4], () => sendFeishuInteractiveCard(...args));
  const updateCard = (...args: Parameters<typeof updateFeishuInteractiveMessage>) =>
    trackDelivery(args[0], args[4], () => updateFeishuInteractiveMessage(...args));
  return {
    splitStreamingReplyCardStates: splitFeishuStreamingCardStates,
    async test(bot) {
      if (!bot.enabled) {
        return { ok: false, message: "Feishu bot is disabled." };
      }
      if (!bot.feishuAppId || !bot.credentialRef) {
        return {
          ok: false,
          message: "Feishu App ID and App Secret are required.",
        };
      }
      const token = await readTenantAccessToken(bot, deps);
      return token
        ? { ok: true, message: "Feishu app credentials are valid." }
        : { ok: false, message: "Feishu app credentials are missing." };
    },

    async resolveName(bot) {
      // Bugfix: The Feishu creation wizard could only use hand-filled/default names before, which could easily be inconsistent with the real robot name.
      // Feishu robot capabilities are linked to self-built applications. Here, the name in the application information is read as the bot display name.
      return readFeishuAppDisplayName(bot, deps);
    },

    async resolveActorDisplayName(bot, actor) {
      return readFeishuUserDisplayName(bot, deps, actor.providerUserId);
    },

    async send(bot, message) {
      const token = await readTenantAccessToken(bot, deps);
      if (!token) {
        return;
      }
      const receiveId = message.providerUserId;
      if (message.selection) {
        await sendCard(
          bot,
          token,
          receiveId,
          message.elicitation
            ? buildFeishuElicitationCardPayload(message)
            : buildFeishuInteractiveCardPayload(message),
        );
        return;
      }
      for (const text of splitFeishuText(message.text)) {
        // Bugfix: Feishu's normal text message will display Markdown as it is, which is inconsistent with Telegram's Markdown reply.
        // Instead, use the markdown element of the interactive card to carry ordinary replies, and continue to reuse the same card structure for selected messages.
        await sendCard(
          bot,
          token,
          receiveId,
          buildFeishuInteractiveCardPayload({
            ...message,
            text,
            selection: undefined,
          }),
        );
      }
    },

    async createStreamingReplyCard(bot, state, signal) {
      const token = await readTenantAccessToken(bot, deps, signal);
      if (!token) {
        return null;
      }
      const providerMessageId = await sendCard(
        bot,
        token,
        state.providerUserId,
        buildFeishuStreamingCardPayload(state),
        signal,
      );
      return providerMessageId ? { providerMessageId } : null;
    },

    async updateStreamingReplyCard(bot, handle, state, signal) {
      const token = await readTenantAccessToken(bot, deps, signal);
      if (!token) {
        return;
      }
      await updateCard(
        bot,
        token,
        handle,
        buildFeishuStreamingCardPayload(state),
        signal,
      );
    },

    async createTransientInteractionCard(bot, message) {
      const token = await readTenantAccessToken(bot, deps);
      if (!token) {
        return null;
      }
      const providerMessageId = await sendCard(
        bot,
        token,
        message.providerUserId,
        message.elicitation
          ? buildFeishuElicitationCardPayload(message)
          : buildFeishuInteractiveCardPayload(message),
      );
      return providerMessageId ? { providerMessageId } : null;
    },

    async updateTransientInteractionCard(bot, handle, message) {
      const token = await readTenantAccessToken(bot, deps);
      if (!token) {
        return;
      }
      await updateCard(
        bot,
        token,
        handle,
        message.elicitation
          ? buildFeishuElicitationCardPayload(message)
          : buildFeishuInteractiveCardPayload(message),
      );
    },

    async deleteTransientInteractionCard(bot, handle) {
      const token = await readTenantAccessToken(bot, deps);
      if (!token) {
        return;
      }
      await deleteFeishuInteractiveMessage(bot, token, handle);
    },

    async sendTyping(bot, target) {
      if (!target.providerMessageId) {
        return;
      }
      // Bugfix: Feishu/Lark normal commands will not enter the long task stream. Previously, only startTyping/stopTyping was implemented.
      // Therefore, /status, /project and other commands do not have any processing feedback. Only Typing reaction is added here, and deletion is explicitly closed by BotService after the synchronization reply is sent.
      await addFeishuTypingReaction(bot, deps, target.providerMessageId);
    },

    async startTyping(bot, target) {
      if (!target.providerMessageId) {
        return;
      }
      // Bugfix: Feishu does not have native typing status and can only be simulated using typing reaction.
      // Reaction will not disappear automatically, so the reaction_id must be recorded and deleted when the task is completed or the permission is entered.
      await addFeishuTypingReaction(bot, deps, target.providerMessageId);
    },

    async stopTyping(bot, target) {
      if (!target.providerMessageId) {
        return;
      }
      await deleteFeishuTypingReaction(bot, deps, target.providerMessageId);
    },

    async acknowledgeCallback(bot, payload, text, message, signal) {
      const token = await readTenantAccessToken(bot, deps, signal);
      const cardUpdateToken = readFeishuCardUpdateToken(payload);
      const openIds = readFeishuCardUpdateOpenIds(payload);
      const originalText = readFeishuCardOriginalText(payload);
      if (!token || !cardUpdateToken || (!text?.trim() && !message?.elicitation)) {
        return;
      }
      // Bugfix: Feishu card button will not disappear automatically like Telegram inline keyboard after clicking.
      // Use the card update token carried by the callback to update the original card as the processing result to prevent old options from remaining in the chat and being clicked repeatedly.
      // Delayed update of non-shared cards also requires open_ids, otherwise Feishu will return 300090 and the old cards will continue to remain in the session.
      // Bugfix: The original question text should be retained and the button should be removed after the user selects it; card updates that only rely on WebSocket callback return are unstable.
      // Therefore, even if the button value contains the original text, card/update must continue to be called, but the updated copy will give priority to the original text.
      const response = await fetchBotProviderJson<FeishuSendMessageResponse>(`${getFeishuBaseUrl(bot)}/open-apis/interactive/v1/card/update`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        signal,
        body: JSON.stringify({
          token: cardUpdateToken,
          // Bugfix: Card JSON 2.0 root node does not accept open_ids; inserting open_ids into card will trigger
          // "unknown property: open_ids" and causes the original card to be unable to remove options after the button is clicked.
          ...(openIds.length > 0 ? { open_ids: openIds } : {}),
          // Reason for fix: Creating a new question and then withdrawing the old card will show obvious traces of withdrawal in the Feishu session.
          // The callback token is the authoritative in-situ update capability corresponding to this click. The same card is reused for both question and answer advancement and final state.
          card: message?.elicitation
            ? buildFeishuElicitationCardPayload(message)
            : buildFeishuInteractiveCardPayload({
                botId: bot.id,
                provider: bot.provider,
                providerUserId: "",
                // Bugfix: After clicking the Feishu button, the business result will send another message; the original card only needs to remove the option button.
                // Previously, when the original card was changed to the result copy, additional status changes would appear on the Feishu side, which was not in line with the user's expectation of "options disappearing".
                text: originalText?.trim() || (text ?? ""),
              }),
        }),
      });
      if (!response.ok) {
        throw new Error(`Feishu update interactive card failed: HTTP ${response.status}`);
      }
      const result = response.payload ?? {};
      if (result.code !== 0) {
        throw new Error(result.msg || "Feishu update interactive card failed.");
      }
      return message?.elicitation ? { handled: true } : undefined;
    },

    async downloadAttachment(bot, attachment, actor) {
      const token = await readTenantAccessToken(bot, deps);
      if (!token || !attachment.providerFileId || !actor?.providerMessageId) {
        return null;
      }
      const controller = new AbortController();
      const timeout = setTimeout(
        () => controller.abort(),
        FEISHU_ATTACHMENT_DOWNLOAD_TIMEOUT_MS,
      );
      try {
        const response = await fetch(
          `${getFeishuBaseUrl(bot)}/open-apis/im/v1/messages/${encodeURIComponent(actor.providerMessageId)}/resources/${encodeURIComponent(attachment.providerFileId)}?type=${attachment.kind === "image" ? "image" : attachment.kind === "video" ? "media" : attachment.kind}`,
          {
            headers: {
              authorization: `Bearer ${token}`,
            },
            signal: controller.signal,
          },
        );
        if (!response.ok) {
          throw new Error(`Feishu attachment download failed: HTTP ${response.status}`);
        }
        return {
          attachment,
          data: new Uint8Array(await response.arrayBuffer()),
        };
      } catch (error) {
        if ((error as { name?: unknown })?.name === "AbortError") {
          // Bugfix: The Feishu resource interface occasionally does not return for a long time. The bot callback must be used to give the user a failure prompt within a predictable time.
          throw new Error("Feishu attachment download timed out.");
        }
        throw error;
      } finally {
        clearTimeout(timeout);
      }
    },

    parseCallback(payload): BotInboundMessage[] {
      if (!isRecord(payload)) {
        return [];
      }
      const botId = readString(payload, "botId");
      if (!botId) {
        return [];
      }
      const message = readFeishuTextMessage(botId, payload) ?? readFeishuCardAction(botId, payload);
      return message ? [message] : [];
    },
  };
}
