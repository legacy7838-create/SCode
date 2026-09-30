import { redactFeedbackText } from "@zcode/shared";
/* eslint-disable max-lines -- Feedback HTTP client centrally maintains new backend protocols, authentication header merging, OSS form direct transmission and response normalization. */
import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { extname } from "node:path";

import type {
  ApiClient,
  ApiRequestInit,
  CreateFeedbackTicketInput,
  FeedbackAttachment,
  FeedbackAttachmentKind,
  FeedbackComment,
  FeedbackCommentAttachment,
  FeedbackDeviceInfo,
  FeedbackListQuery,
  FeedbackListResult,
  FeedbackTicketDetail,
  FeedbackTicketEvent,
  FeedbackTicketFramework,
  FeedbackTicketSeverity,
  FeedbackTicketStatus,
  FeedbackTicketSummary,
  FeedbackTicketType,
} from "@zcode/shared";
import { createServiceLogger, type ServiceLogger } from "#src/logger/serviceLogger.js";
import { withRequestIdHeaderRecord } from "#src/providers/api/requestIdHeaders.js";
import {
  getNetworkErrorCodes,
  isRetryableConnectionEstablishmentError,
} from "#src/providers/api/networkErrorClassifier.js";
import { resolveClientConfigPlatform } from "#src/runtime-tools/clientPlatform.js";

interface FeedbackHttpClientOptions {
  baseUrl: string;
  apiClient: ApiClient;
  getAuthHeaders: () => Promise<Record<string, string>>;
  logger?: ServiceLogger;
}

interface FeedbackUploadProgressEvent {
  uploadedBytes: number;
  totalBytes: number;
}

interface FeedbackUploadFileOptions {
  messageId?: string;
  onUploadProgress?: (event: FeedbackUploadProgressEvent) => void;
  signal?: AbortSignal;
}

interface FeedbackCreateRequestOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

interface FeedbackApiEnvelope<T> {
  code: number;
  msg?: string;
  data: T;
}

interface FeedbackTicketSummaryResponse {
  ticket_id: string;
  device_mid?: string;
  title?: string | null;
  status?: string | null;
  created_at?: number | string | null;
  updated_at?: number | string | null;
}

interface FeedbackTicketDetailResponse extends FeedbackTicketSummaryResponse {
  content?: {
    description?: string | null;
    category?: string | null;
    function?: string | null;
    severity?: string | null;
  } | null;
  environment?: Record<string, unknown> | null;
  attachments?: FeedbackAttachmentResponse[] | null;
  messages?: FeedbackMessageResponse[] | null;
}

interface FeedbackMessageResponse {
  message_id: string;
  ticket_id?: string;
  sender_type?: string | null;
  content?: { text?: string | null } | null;
  attachments?: FeedbackAttachmentResponse[] | null;
  created_at?: number | string | null;
}

interface FeedbackAttachmentResponse {
  attachment_id?: string | number | null;
  id?: string | number | null;
  file_name?: string | null;
  filename?: string | null;
  size?: number | null;
  content_type?: string | null;
  download_url?: string | null;
  preview_url?: string | null;
  created_at?: number | string | null;
}

interface FeedbackUploadCredentialResponse {
  attachment_id: string;
  max_size: number;
  callback: {
    url: string;
    body: string;
    content_type: string;
  };
  oss: {
    host: string;
    path: string;
    policy: string;
    x_oss_signature: string;
    x_oss_signature_version: string;
    x_oss_credential: string;
    x_oss_security_token: string;
    x_oss_date: string;
  };
}

const defaultLogger = createServiceLogger("feedback-http");
const FEEDBACK_MAX_ATTACHMENT_BYTES = 100 * 1024 * 1024;
const FEEDBACK_MAX_LOG_ATTACHMENT_BYTES = 1024 * 1024 * 1024;
const FEEDBACK_CREATE_TIMEOUT_MS = 30_000;

export class FeedbackUploadCanceledError extends Error {
  constructor() {
    super("Feedback upload canceled");
    this.name = "FeedbackUploadCanceledError";
  }
}

async function readResponseError(response: Response): Promise<string> {
  const text = await response.text().catch(() => "");
  try {
    const json = JSON.parse(text) as { msg?: unknown; detail?: unknown };
    if (typeof json.msg === "string" && json.msg.trim()) {
      return json.msg;
    }
    if (typeof json.detail === "string") {
      return json.detail;
    }
  } catch {
    // ignore
  }
  return text || `HTTP ${response.status}`;
}

function mergeFeedbackRequestHeaders(
  authHeaders: Record<string, string>,
  headers: RequestInit["headers"] | undefined,
): Record<string, string> {
  const next = { ...authHeaders };
  if (headers instanceof Headers) {
    headers.forEach((value, key) => {
      next[key] = value;
    });
  } else if (Array.isArray(headers)) {
    for (const [key, value] of headers) {
      next[key] = value;
    }
  } else if (headers) {
    Object.entries(headers).forEach(([key, value]) => {
      next[key] = String(value);
    });
  }
  return withRequestIdHeaderRecord(next);
}

function getHeaderValue(headers: Record<string, string>, name: string): string | undefined {
  const expected = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === expected) {
      return value;
    }
  }
  return undefined;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function getFeedbackMaxAttachmentBytes(kind: FeedbackAttachmentKind): number {
  return kind === "log" ? FEEDBACK_MAX_LOG_ATTACHMENT_BYTES : FEEDBACK_MAX_ATTACHMENT_BYTES;
}

function readEnvelopeCode(value: unknown): number | undefined {
  if (!isObjectRecord(value)) {
    return undefined;
  }
  const { code } = value;
  return typeof code === "number" ? code : undefined;
}

function summarizeStringField(value: unknown): { present: boolean; length?: number } {
  if (typeof value !== "string") {
    return { present: false };
  }
  return { present: true, length: value.length };
}

function summarizeFileNameField(value: unknown): {
  present: boolean;
  length?: number;
  extension?: string;
} {
  const summary = summarizeStringField(value);
  if (typeof value !== "string") {
    return summary;
  }
  const extension = extname(value);
  return extension ? { ...summary, extension } : summary;
}

function summarizeFeedbackCreateBody(body: Record<string, unknown>): Record<string, unknown> {
  const content = isObjectRecord(body.content) ? body.content : {};
  const environment = isObjectRecord(body.environment) ? body.environment : {};
  return {
    fields: Object.keys(body).sort(),
    title: summarizeStringField(body.title),
    hasDeviceMid: typeof body.device_mid === "string" && body.device_mid.length > 0,
    content: {
      fields: Object.keys(content).sort(),
      description: summarizeStringField(content.description),
      category: typeof content.category === "string" ? content.category : undefined,
      function: typeof content.function === "string" ? content.function : undefined,
      severity: typeof content.severity === "string" ? content.severity : undefined,
    },
    contact: summarizeStringField(body.contact),
    environment: {
      fields: Object.keys(environment).sort(),
      appVersion: environment.app_version,
      platform: environment.platform,
      releaseChannel: environment.release_channel,
      osCategory: environment.os_category,
      osVersion: environment.os_version,
      source: environment.source,
    },
  };
}

function summarizeUploadCredentialBody(body: Record<string, unknown>): Record<string, unknown> {
  return {
    fields: Object.keys(body).sort(),
    hasTicketId: typeof body.ticket_id === "string" && body.ticket_id.length > 0,
    hasMessageId: typeof body.message_id === "string" && body.message_id.length > 0,
    fileName: summarizeFileNameField(body.file_name),
    size: typeof body.size === "number" ? body.size : undefined,
  };
}

function summarizeRequestBody(
  path: string,
  method: string,
  body: RequestInit["body"] | null | undefined,
): Record<string, unknown> | undefined {
  if (typeof body !== "string") {
    return undefined;
  }
  try {
    const parsed = JSON.parse(body) as unknown;
    if (!isObjectRecord(parsed)) {
      return { jsonType: typeof parsed };
    }
    // When feedback creation fails, the RPC log only records database errors and lacks HTTP boundary evidence.
    // Only field and value summaries are recorded here, and user feedback text, contact information, tokens, or full device IDs are not written into the log.
    if (method.toUpperCase() === "POST" && path === "/feedback/ticket") {
      return summarizeFeedbackCreateBody(parsed);
    }
    // When the log package exceeds the single attachment limit of the feedback backend, only parameter error is returned;
    // The uploaded credential log needs to record the desensitized file_name/size so that we can locate which attachment was rejected from the client side.
    if (method.toUpperCase() === "POST" && path === "/feedback/attachment/upload-credential") {
      return summarizeUploadCredentialBody(parsed);
    }
    return { fields: Object.keys(parsed).sort() };
  } catch {
    return { unparsable: true, length: body.length };
  }
}

function sanitizeFeedbackLogUrl(url: string): string {
  try {
    const parsed = new URL(url);
    // The ticket details and message path contain the ticket id, and placing the complete URL will reveal the user's ticket ID.
    // The log only retains the target origin and route template, and removes the query parameters. The actual request still uses the original URL.
    const pathname = parsed.pathname.replace(/(\/feedback\/ticket\/)[^/]+(?=\/|$)/, "$1:ticketId");
    return `${parsed.origin}${pathname}`;
  } catch {
    return "<invalid-feedback-url>";
  }
}

export class FeedbackHttpClient {
  constructor(private readonly options: FeedbackHttpClientOptions) {}

  private get apiBaseUrl(): string {
    return this.options.baseUrl.replace(/\/+$/, "");
  }

  private get logger(): ServiceLogger {
    return this.options.logger ?? defaultLogger;
  }

  private async request<T>(
    path: string,
    init?: ApiRequestInit,
    authHeaders?: Record<string, string>,
  ): Promise<T> {
    const headers = mergeFeedbackRequestHeaders(
      authHeaders ?? (await this.options.getAuthHeaders()),
      init?.headers,
    );
    const url = `${this.apiBaseUrl}${path}`;
    const method = init?.method ?? "GET";
    const requestId = getHeaderValue(headers, "x-request-id");
    const logContext = {
      method,
      url: sanitizeFeedbackLogUrl(url),
      requestId,
      hasAuthorization: Boolean(getHeaderValue(headers, "Authorization")),
      hasDeviceMid: Boolean(getHeaderValue(headers, "X-Device-Mid")),
      acceptLanguage: getHeaderValue(headers, "Accept-Language"),
      body: summarizeRequestBody(path, method, init?.body),
    };
    const startedAt = Date.now();
    let requestAttemptCount = 1;
    this.logger.info(undefined, "feedback http request started", logContext);
    let response: Response;
    try {
      response = await requestWithHandshakeRetry(
        () =>
          this.options.apiClient.request(url, {
            ...init,
            headers,
          }),
        ({ attempt, error, nextAttempt }) => {
          requestAttemptCount = nextAttempt;
          this.logger.warn(undefined, "feedback http connect failed, retrying", {
            ...logContext,
            attempt,
            nextAttempt,
            maxAttempts: 3,
            error: getErrorMessage(error),
            errorCodes: getNetworkErrorCodes(error),
          });
        },
      );
    } catch (error) {
      this.logger.warn(undefined, "feedback http request network failure", {
        ...logContext,
        durationMs: Date.now() - startedAt,
        attemptCount: requestAttemptCount,
        error: getErrorMessage(error),
        errorCodes: getNetworkErrorCodes(error),
      });
      throw error;
    }
    const durationMs = Date.now() - startedAt;
    if (!response.ok) {
      const message = await readResponseError(response);
      this.logger.warn(undefined, "feedback http request failed", {
        ...logContext,
        durationMs,
        status: response.status,
        statusText: response.statusText,
        msg: message,
      });
      throw new Error(message);
    }
    if (response.status === 204) {
      this.logger.info(undefined, "feedback http request succeeded", {
        ...logContext,
        durationMs,
        status: response.status,
      });
      return undefined as T;
    }
    let responseJson: unknown;
    try {
      responseJson = await response.json();
    } catch (error) {
      this.logger.warn(undefined, "feedback http response parse failed", {
        ...logContext,
        durationMs,
        status: response.status,
        error: getErrorMessage(error),
      });
      throw error;
    }
    try {
      const result = unwrapFeedbackResponse<T>(responseJson);
      this.logger.info(undefined, "feedback http request succeeded", {
        ...logContext,
        durationMs,
        status: response.status,
        code: readEnvelopeCode(responseJson),
      });
      return result;
    } catch (error) {
      this.logger.warn(undefined, "feedback http request business failure", {
        ...logContext,
        durationMs,
        status: response.status,
        code: readEnvelopeCode(responseJson),
        msg: getErrorMessage(error),
      });
      throw error;
    }
  }

  async create(
    input: CreateFeedbackTicketInput,
    options: FeedbackCreateRequestOptions = {},
  ): Promise<FeedbackTicketDetail> {
    const authHeaders = await this.options.getAuthHeaders();
    const deviceMid = getHeaderValue(authHeaders, "X-Device-Mid");
    if (!deviceMid) {
      throw new Error("Missing feedback device_mid");
    }
    const ticket = await this.request<FeedbackTicketSummaryResponse>(
      "/feedback/ticket",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        // Creating a ticket is the first stage visible to the user and cannot wait indefinitely for network or backend hangs.
        // Timeouts and cancellations are converged to the unified ApiClient to avoid the UI stopping at "Connecting to Feedback Service".
        timeoutMs: options.timeoutMs ?? FEEDBACK_CREATE_TIMEOUT_MS,
        signal: options.signal,
        body: JSON.stringify({
          title: redactFeedbackText(input.title),
          device_mid: deviceMid,
          content: {
            description: redactFeedbackText(input.description),
            category: input.type,
            function: input.module,
            severity: input.severity,
          },
          contact: input.contact,
          environment: toFeedbackEnvironment(input),
        }),
      },
      authHeaders,
    );
    return mapCreatedTicket(ticket, input);
  }

  async list(query: FeedbackListQuery = {}): Promise<FeedbackListResult> {
    const result = await this.request<{ items?: FeedbackTicketSummaryResponse[] }>(
      buildFeedbackListPath(query),
    );
    const mapped = (result.items ?? []).map((item) => mapTicketSummary(item));
    const filtered = mapped.filter((item) => {
      if (query.status && item.status !== query.status) return false;
      if (query.type && item.type !== query.type) return false;
      return true;
    });
    return {
      items: filtered,
      total: filtered.length,
    };
  }

  async get(id: string): Promise<FeedbackTicketDetail> {
    const ticket = await this.request<FeedbackTicketDetailResponse>(
      `/feedback/ticket/${encodeURIComponent(id)}`,
    );
    return mapTicketDetail(ticket);
  }

  async comment(id: string, body: string): Promise<FeedbackComment> {
    const message = await this.request<FeedbackMessageResponse>(
      `/feedback/ticket/${encodeURIComponent(id)}/message`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: { text: redactFeedbackText(body) } }),
      },
    );
    return mapMessageToComment(message, 1);
  }

  async uploadFile(
    ticketId: string,
    kind: FeedbackAttachmentKind,
    filePath: string,
    filename: string,
    contentType: string,
    options?: FeedbackUploadFileOptions,
  ): Promise<FeedbackAttachment> {
    if (options?.signal?.aborted) {
      throw new FeedbackUploadCanceledError();
    }
    const fileStats = await stat(filePath);
    const maxAttachmentBytes = getFeedbackMaxAttachmentBytes(kind);
    if (fileStats.size > maxAttachmentBytes) {
      // Log attachments are allowed to be uploaded up to 1GB; normal feedback attachments remain at a smaller limit.
      // The client verifies first to avoid meaningless requests and return stable errors to the UI.
      throw new Error(`Feedback attachment exceeds max size ${maxAttachmentBytes}`);
    }
    const credential = await this.request<FeedbackUploadCredentialResponse>(
      "/feedback/attachment/upload-credential",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ticket_id: ticketId,
          ...(options?.messageId ? { message_id: options.messageId } : {}),
          file_name: filename,
          size: fileStats.size,
        }),
      },
    );
    if (fileStats.size > credential.max_size) {
      throw new Error(`Feedback attachment exceeds max size ${credential.max_size}`);
    }
    await uploadOssForm(credential, filePath, filename, contentType, {
      size: fileStats.size,
      onUploadProgress: options?.onUploadProgress,
      signal: options?.signal,
    });
    return {
      id: toStableNumericId(credential.attachment_id, 1),
      kind,
      filename,
      size: fileStats.size,
      redacted: false,
      content_type: contentType,
      download_url: null,
      preview_url: null,
      created_at: new Date().toISOString(),
    };
  }
}

function buildFeedbackListPath(query: FeedbackListQuery): string {
  const params = new URLSearchParams();
  // The new feedback list interface supports server-side limit/offset; only on the client side, slice will cause the refresh list to always pull the full amount.
  if (query.limit !== undefined && query.limit >= 0) {
    params.set("limit", String(query.limit));
  }
  if (query.offset !== undefined && query.offset >= 0) {
    params.set("offset", String(query.offset));
  }
  const suffix = params.toString();
  return suffix ? `/feedback/ticket?${suffix}` : "/feedback/ticket";
}

function unwrapFeedbackResponse<T>(value: unknown): T {
  if (!isObjectRecord(value) || !("code" in value)) {
    return value as T;
  }
  const envelope = value as unknown as FeedbackApiEnvelope<T>;
  if (envelope.code !== 0) {
    throw new Error(envelope.msg?.trim() || `Feedback API error ${envelope.code}`);
  }
  return envelope.data;
}

function toFeedbackEnvironment(input: CreateFeedbackTicketInput): Record<string, unknown> {
  const device = input.device ?? {};
  const environment: Record<string, unknown> = {};
  assignDefined(environment, "app_version", device.appVersion);
  // The feedback backend uses the same set of platform keys as client/configs; passing desktop will prevent the feedback from being classified according to the actual system architecture.
  assignDefined(
    environment,
    "platform",
    resolveClientConfigPlatform(device.osPlatform, device.osArch),
  );
  assignDefined(environment, "release_channel", process.env.ZCODE_ENV?.trim() || "stable");
  assignDefined(environment, "os_category", device.osPlatform ?? process.platform);
  assignDefined(environment, "os_version", device.osVersion ?? device.osRelease ?? process.version);
  assignDefined(environment, "build_commit_id", device.buildCommitId);
  assignDefined(environment, "build_time", device.buildTime);
  assignDefined(environment, "electron_version", device.electronVersion);
  assignDefined(environment, "node_version", device.nodeVersion);
  assignDefined(environment, "os_type", device.osType);
  assignDefined(environment, "os_platform", device.osPlatform);
  assignDefined(environment, "os_release", device.osRelease);
  assignDefined(environment, "os_arch", device.osArch);
  assignDefined(environment, "agent_provider", device.agentProvider);
  assignDefined(environment, "agent_framework", device.agentFramework ?? input.framework);
  assignDefined(environment, "agent_model", device.agentModel);
  assignDefined(environment, "agent_model_display", device.agentModelDisplay);
  assignDefined(environment, "source", input.source);
  return environment;
}

function assignDefined(target: Record<string, unknown>, key: string, value: unknown): void {
  if (value === undefined || value === null || value === "") {
    return;
  }
  target[key] = typeof value === "string" ? redactFeedbackText(value) : value;
}

function mapCreatedTicket(
  ticket: FeedbackTicketSummaryResponse,
  input: CreateFeedbackTicketInput,
): FeedbackTicketDetail {
  const createdAt = normalizeFeedbackTime(ticket.created_at);
  const detail: FeedbackTicketDetail = {
    id: ticket.ticket_id,
    title: input.title,
    type: input.type,
    status: mapFeedbackStatus(ticket.status),
    created_at: createdAt,
    updated_at: normalizeFeedbackTime(ticket.updated_at, createdAt),
    description: input.description,
    attachments: [],
    comments: [],
    events: [],
  };
  assignOptionalTicketFields(detail, {
    severity: input.severity,
    module: input.module,
    framework: input.framework,
    reporter: input.reporter ?? null,
    device: input.device ?? null,
  });
  return detail;
}

function mapTicketSummary(ticket: FeedbackTicketSummaryResponse): FeedbackTicketSummary {
  const createdAt = normalizeFeedbackTime(ticket.created_at);
  return {
    id: ticket.ticket_id,
    title: readString(ticket.title) ?? ticket.ticket_id,
    type: "bug",
    status: mapFeedbackStatus(ticket.status),
    created_at: createdAt,
    updated_at: normalizeFeedbackTime(ticket.updated_at, createdAt),
  };
}

function mapTicketDetail(ticket: FeedbackTicketDetailResponse): FeedbackTicketDetail {
  const summary = mapTicketSummary(ticket);
  const type = parseFeedbackTicketType(ticket.content?.category, summary.type);
  const severity = parseFeedbackTicketSeverity(ticket.content?.severity);
  const device = environmentToDeviceInfo(ticket.environment);
  const comments = (ticket.messages ?? []).map((message, index) =>
    mapMessageToComment(message, index + 1),
  );
  const detail: FeedbackTicketDetail = {
    ...summary,
    type,
    description: readString(ticket.content?.description) ?? "",
    attachments: (ticket.attachments ?? []).map((attachment, index) =>
      mapAttachment(attachment, index + 1),
    ),
    comments,
    events: buildDetailEvents(summary.created_at, comments),
  };
  assignOptionalTicketFields(detail, { severity, device });
  return detail;
}

function assignOptionalTicketFields(
  target: FeedbackTicketDetail,
  fields: {
    severity?: FeedbackTicketSeverity;
    module?: FeedbackTicketDetail["module"];
    framework?: FeedbackTicketFramework;
    reporter?: FeedbackTicketDetail["reporter"];
    device?: FeedbackDeviceInfo | null;
  },
): void {
  if (fields.severity) target.severity = fields.severity;
  if (fields.module) target.module = fields.module;
  if (fields.framework) target.framework = fields.framework;
  if (fields.reporter !== undefined) target.reporter = fields.reporter;
  if (fields.device !== undefined) target.device = fields.device;
}

function buildDetailEvents(createdAt: string, comments: FeedbackComment[]): FeedbackTicketEvent[] {
  const events: FeedbackTicketEvent[] = [
    {
      id: 1,
      type: "created",
      summary: "Submitted",
      created_at: createdAt,
    },
  ];
  comments.forEach((comment, index) => {
    events.push({
      id: index + 2,
      type: comment.is_staff ? "staff_replied" : "user_replied",
      summary: comment.is_staff ? "Support replied" : "User added feedback",
      payload: { comment_id: comment.id },
      created_at: comment.created_at,
    });
  });
  return events;
}

function mapMessageToComment(
  message: FeedbackMessageResponse,
  fallbackId: number,
): FeedbackComment {
  const senderType = readString(message.sender_type);
  return {
    id: toStableNumericId(message.message_id, fallbackId),
    // Supplemental message attachments must use the original message_id to request upload credentials, and the numeric presentation ID cannot be reversed to the backend ID.
    message_id: message.message_id,
    body: readString(message.content?.text) ?? "",
    is_staff: senderType === "staff" || senderType === "admin",
    attachments: (message.attachments ?? []).map((attachment, index) =>
      mapAttachmentToCommentAttachment(attachment, index + 1),
    ),
    created_at: normalizeFeedbackTime(message.created_at),
  };
}

function mapAttachment(
  attachment: FeedbackAttachmentResponse,
  fallbackId: number,
): FeedbackAttachment {
  const filename =
    readString(attachment.file_name) ?? readString(attachment.filename) ?? "attachment";
  const contentType = readString(attachment.content_type);
  return {
    id: toStableNumericId(attachment.attachment_id ?? attachment.id, fallbackId),
    kind: inferAttachmentKind(filename, contentType),
    filename,
    size: typeof attachment.size === "number" ? attachment.size : 0,
    redacted: false,
    content_type: contentType ?? null,
    download_url: readString(attachment.download_url) ?? null,
    preview_url: readString(attachment.preview_url) ?? null,
    created_at: normalizeFeedbackTime(attachment.created_at),
  };
}

function mapAttachmentToCommentAttachment(
  attachment: FeedbackAttachmentResponse,
  fallbackId: number,
): FeedbackCommentAttachment {
  const mapped = mapAttachment(attachment, fallbackId);
  return {
    id: mapped.id,
    filename: mapped.filename,
    size: mapped.size,
    content_type: mapped.content_type,
    download_url: mapped.download_url,
    preview_url: mapped.preview_url,
  };
}

function inferAttachmentKind(
  filename: string,
  contentType?: string | null,
): FeedbackAttachmentKind {
  if (contentType?.startsWith("image/")) {
    return "image";
  }
  if (/\.zip$/i.test(filename)) {
    return "log";
  }
  if (/\.(?:png|jpe?g|gif|webp|bmp)$/i.test(filename)) {
    return "image";
  }
  return "other";
}

function mapFeedbackStatus(status: unknown): FeedbackTicketStatus {
  switch (readString(status)) {
    case "closed":
    case "Archived":
      return "Archived";
    case "submitted":
    // Compatible with work orders that still return the old English status in the backend or history cache.
    case "pending":
    case "Submitted":
    default:
      return "Submitted";
  }
}

function parseFeedbackTicketType(value: unknown, fallback: FeedbackTicketType): FeedbackTicketType {
  switch (readString(value)) {
    case "usage":
      return "usage";
    case "feature":
      return "feature";
    case "performance":
      return "performance";
    case "bug":
      return "bug";
    default:
      return fallback;
  }
}

function parseFeedbackTicketSeverity(value: unknown): FeedbackTicketSeverity | undefined {
  switch (readString(value)) {
    case "P1-High":
      return "P1-High";
    case "P2-Medium":
      return "P2-Medium";
    case "P3-Low":
      return "P3-Low";
    default:
      return undefined;
  }
}

function environmentToDeviceInfo(
  environment: Record<string, unknown> | null | undefined,
): FeedbackDeviceInfo | null {
  if (!environment) {
    return null;
  }
  const device: FeedbackDeviceInfo = {};
  assignDeviceString(device, "appVersion", environment.app_version);
  assignDeviceString(device, "buildCommitId", environment.build_commit_id);
  assignDeviceString(device, "buildTime", environment.build_time);
  assignDeviceString(device, "electronVersion", environment.electron_version);
  assignDeviceString(device, "nodeVersion", environment.node_version);
  assignDeviceString(device, "osType", environment.os_type);
  assignDeviceString(device, "osPlatform", environment.os_platform ?? environment.os_category);
  assignDeviceString(device, "osRelease", environment.os_release);
  assignDeviceString(device, "osVersion", environment.os_version);
  assignDeviceString(device, "osArch", environment.os_arch);
  assignDeviceString(device, "agentProvider", environment.agent_provider);
  assignDeviceString(device, "agentFramework", environment.agent_framework);
  assignDeviceString(device, "agentModel", environment.agent_model);
  assignDeviceString(device, "agentModelDisplay", environment.agent_model_display);
  const optionCount = environment.agent_model_option_count;
  if (typeof optionCount === "number") {
    device.agentModelOptionCount = optionCount;
  }
  const preview = environment.agent_model_options_preview;
  if (Array.isArray(preview)) {
    device.agentModelOptionsPreview = preview.filter(
      (item): item is string => typeof item === "string",
    );
  }
  return Object.keys(device).length > 0 ? device : null;
}

function assignDeviceString(
  target: FeedbackDeviceInfo,
  key: keyof FeedbackDeviceInfo,
  value: unknown,
): void {
  const stringValue = readString(value);
  if (stringValue) {
    (target as Record<string, unknown>)[key] = stringValue;
  }
}

function normalizeFeedbackTime(
  value: number | string | null | undefined,
  fallback?: string,
): string {
  if (typeof value === "number" && Number.isFinite(value)) {
    return new Date(value * 1000).toISOString();
  }
  const stringValue = readString(value);
  if (!stringValue) {
    return fallback ?? new Date().toISOString();
  }
  if (/^\d+$/.test(stringValue)) {
    return new Date(Number(stringValue) * 1000).toISOString();
  }
  if (/^\d{4}-\d{2}-\d{2}T/.test(stringValue) && !/(?:Z|[+-]\d{2}:?\d{2})$/.test(stringValue)) {
    return `${stringValue}Z`;
  }
  return stringValue;
}

function toStableNumericId(value: unknown, fallbackId: number): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  const text = readString(value);
  if (!text) {
    return fallbackId;
  }
  let hash = 0;
  for (let index = 0; index < text.length; index += 1) {
    hash = (hash * 31 + text.charCodeAt(index)) >>> 0;
  }
  return hash || fallbackId;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function requestWithHandshakeRetry(
  request: () => Promise<Response>,
  onRetry?: (event: { attempt: number; nextAttempt: number; error: unknown }) => void,
): Promise<Response> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      return await request();
    } catch (error) {
      lastError = error;
      // The Cloudflare/native proxy link occasionally fails the TLS handshake or Undici connection establishment phase.
      // Multiple short retries are allowed when the request has not yet reached the backend stably; even if the request has been received by ApiClient,
      // The feedback interface's own lightweight retry is still retained here to prevent lightweight requests such as "My Feedback" from directly displaying fetch failed.
      if (attempt >= 3 || !isRetryableConnectionEstablishmentError(error)) {
        break;
      }
      onRetry?.({ attempt, nextAttempt: attempt + 1, error });
      await delay(300 * attempt);
    }
  }
  throw lastError;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function uploadOssForm(
  credential: FeedbackUploadCredentialResponse,
  filePath: string,
  filename: string,
  contentType: string,
  options: {
    size: number;
    onUploadProgress?: (event: FeedbackUploadProgressEvent) => void;
    signal?: AbortSignal;
  },
): Promise<void> {
  return new Promise((resolve, reject) => {
    const uploadUrl = new URL(credential.oss.host);
    const requestImpl = uploadUrl.protocol === "https:" ? httpsRequest : httpRequest;
    const boundary = `----zcode-feedback-${randomUUID()}`;
    const fields = buildOssFormFields(credential);
    const fieldBuffers = fields.map(([name, value]) => createMultipartField(boundary, name, value));
    const fileHeader = Buffer.from(
      `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="file"; filename="${escapeMultipartValue(filename)}"\r\n` +
        `Content-Type: ${contentType}\r\n\r\n`,
    );
    const closing = Buffer.from(`\r\n--${boundary}--\r\n`);
    const contentLength =
      fieldBuffers.reduce((total, buffer) => total + buffer.byteLength, 0) +
      fileHeader.byteLength +
      options.size +
      closing.byteLength;
    let uploadedBytes = 0;
    let settled = false;
    let stream: ReturnType<typeof createReadStream> | null = null;

    if (options.signal?.aborted) {
      reject(new FeedbackUploadCanceledError());
      return;
    }

    const req = requestImpl(
      uploadUrl,
      {
        method: "POST",
        headers: {
          "Content-Type": `multipart/form-data; boundary=${boundary}`,
          "Content-Length": String(contentLength),
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk) => {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        });
        response.on("end", () => {
          if (settled) return;
          settled = true;
          const statusCode = response.statusCode ?? 0;
          if (statusCode < 200 || statusCode >= 300) {
            const body = Buffer.concat(chunks).toString("utf8");
            reject(new Error(`OSS upload failed: HTTP ${statusCode}${body ? `: ${body}` : ""}`));
            return;
          }
          options.onUploadProgress?.({
            uploadedBytes: options.size,
            totalBytes: options.size,
          });
          resolve();
        });
      },
    );

    const abortUpload = () => {
      if (settled) return;
      settled = true;
      const error = new FeedbackUploadCanceledError();
      stream?.destroy(error);
      req.destroy(error);
      reject(error);
    };
    options.signal?.addEventListener("abort", abortUpload, { once: true });

    req.on("error", (error) => {
      if (settled) return;
      settled = true;
      reject(options.signal?.aborted ? new FeedbackUploadCanceledError() : error);
    });

    for (const buffer of fieldBuffers) {
      req.write(buffer);
    }
    req.write(fileHeader);

    stream = createReadStream(filePath);
    stream.on("data", (chunk) => {
      stream?.pause();
      uploadedBytes += Buffer.byteLength(chunk);
      // Here, the progress of the file content is reported, and the beginning and end of the multipart form are not included in the user-visible progress.
      options.onUploadProgress?.({
        uploadedBytes: Math.min(uploadedBytes, options.size),
        totalBytes: options.size,
      });
      const canContinue = req.write(chunk, () => {
        if (stream && !stream.destroyed) {
          stream.resume();
        }
      });
      if (!canContinue) {
        req.once("drain", () => {
          if (stream && !stream.destroyed) {
            stream.resume();
          }
        });
      }
    });
    stream.on("error", (error) => {
      req.destroy(error);
    });
    stream.on("end", () => {
      req.write(closing);
      req.end();
    });
  });
}

function buildOssFormFields(credential: FeedbackUploadCredentialResponse): Array<[string, string]> {
  const encodedCallback = Buffer.from(
    JSON.stringify({
      callbackUrl: credential.callback.url,
      callbackBody: credential.callback.body,
      callbackBodyType: credential.callback.content_type,
    }),
    "utf-8",
  ).toString("base64");
  const fields: Array<[string, string]> = [
    ["key", credential.oss.path],
    ["policy", credential.oss.policy],
    ["x-oss-signature", credential.oss.x_oss_signature],
    ["x-oss-signature-version", credential.oss.x_oss_signature_version],
    ["x-oss-credential", credential.oss.x_oss_credential],
    ["x-oss-security-token", credential.oss.x_oss_security_token],
    ["x-oss-date", credential.oss.x_oss_date],
    ["callback", encodedCallback],
    ["success_action_status", "200"],
  ];
  return fields.filter(([, value]) => value);
}

function createMultipartField(boundary: string, name: string, value: string): Buffer {
  return Buffer.from(
    `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="${escapeMultipartValue(name)}"\r\n\r\n` +
      `${value}\r\n`,
  );
}

function escapeMultipartValue(value: string): string {
  return value.replace(/["\r\n]/g, "_");
}
