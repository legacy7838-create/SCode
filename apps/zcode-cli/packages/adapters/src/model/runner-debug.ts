import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ModelTextResult } from "@zcode/contracts";
import { ZCODE_RUNTIME_ENV_KEY, normalizeZCodeRuntimeEnv } from "@zcode/shared";
import { redactAnthropicRequestMetadata } from "./anthropic-request-metadata.js";
import type { EnvRecord } from "./model-execution.js";
import { sanitizeModelIODebugRecord } from "./runner-debug-redaction.js";
import { getGenerateTextResultMetadata } from "./runner-diagnostics.js";
import {
  normalizeReasoning,
  normalizeSources,
  normalizeToolResults,
  normalizeUsage,
} from "./runner-normalization.js";
import { stringMetadata } from "./runner-record.js";
import type {
  AiSdkGenerateTextOptions,
  AiSdkGenerateTextResult,
  AiSdkModelTextRequest,
  AiSdkStreamTextOptions,
  AiSdkStreamTextResult,
  ResolvedAiSdkModel,
} from "./runner-runtime.js";

// The maximum number of model-io session files retained in the rollout directory of the production environment. Delete the oldest if exceeded.
const MAX_ROLLOUT_FILES = 3;
// The hard upper limit of the model-io file for a single session in the production environment. The diagnostic log cannot affect the agent main process due to unlimited growth.
const MAX_ROLLOUT_SESSION_BYTES = 64 * 1024 * 1024;
// Development mode retains more context, but still avoids the infinite expansion of a single debug file.
const MAX_DEBUG_SESSION_BYTES = 256 * 1024 * 1024;
// When the baseline is written after the cache is missing or the file exceeds the limit, only the most recent context is retained to avoid writing huge records again after restarting a long session.
const MAX_ROLLOUT_BASELINE_MESSAGES = 64;
const MAX_DEBUG_BASELINE_MESSAGES = 256;
const FINGERPRINT_STRING_LIMIT = 512;

interface ModelIOCollectionState {
  count: number;
  firstFingerprint?: string;
  lastFingerprint?: string;
  sampleFingerprints?: string[];
}

interface ModelIORequestCompactionState {
  bodyMessages?: ModelIOCollectionState;
  messages?: ModelIOCollectionState;
  sdkMessages?: ModelIOCollectionState;
}

interface ModelIOCompactionState {
  request?: ModelIORequestCompactionState;
}

const modelIOCompactionStates = new Map<string, ModelIOCompactionState>();

export function shouldRecordModelIO(env: EnvRecord): boolean {
  // Both the development state and the production state are recorded (falling into the debug / rollout directory respectively); only the test state (ZCODE_RUNTIME_ENV=test) is not written.
  // Avoid disk side effects caused by single testing. If not set, it will be processed according to production (recorded to rollout, with upper limit of number of strips).
  return normalizeRuntimeEnv(env) !== "test";
}

// Determine whether the current development state is used to select the download directory (debug vs rollout).
// Look directly at ZCODE_RUNTIME_ENV === "development"; this variable has been injected when the dev desktop/CLI starts.
export function isDevelopmentModelIOEnv(env: EnvRecord): boolean {
  return normalizeRuntimeEnv(env) === "development";
}

export function recordGenerateTextDebug(input: {
  attempt: number;
  debugDir?: string;
  error?: unknown;
  isDev: boolean;
  modelIoFullRetentionEnabled: boolean;
  normalizedToolCalls: ModelTextResult["toolCalls"];
  options: AiSdkGenerateTextOptions;
  recordModelIO: boolean;
  request: AiSdkModelTextRequest;
  requestId: string;
  resolved: ResolvedAiSdkModel;
  result?: AiSdkGenerateTextResult;
  startedAt: number;
}): void {
  if (!input.recordModelIO) {
    return;
  }

  const completedAt = Date.now();
  const resultWithMetadata = getGenerateTextResultMetadata(input.result);
  const metadata = input.request.metadata ?? {};
  const requestBody =
    input.resolved.rawRequestBodyCapture?.body ??
    resultWithMetadata?.request?.body ??
    (input.error
      ? buildFallbackRequestBodyFromOptions({
          options: input.options,
          resolved: input.resolved,
          stream: false,
        })
      : undefined);

  writeModelIODebugRecord(
    {
      completedAt: new Date(completedAt).toISOString(),
      durationMs: completedAt - input.startedAt,
      error: input.error ? serializeError(input.error) : undefined,
      requestId: input.requestId,
      attempt: input.attempt,
      model: {
        modelId: input.resolved.modelId,
        providerId: input.resolved.providerId,
      },
      request: {
        body: redactAnthropicRequestMetadata(requestBody),
        headers: input.options.headers,
        maxOutputTokens: input.options.maxOutputTokens,
        messages: input.request.messages,
        providerOptions: input.request.providerOptions,
        sdkMessages: input.options.messages,
        temperature: input.request.temperature,
        toolChoice: input.request.toolChoice,
        toolNames: input.request.tools?.map((toolContract) => toolContract.name) ?? [],
      },
      response: input.result
        ? {
            body: resultWithMetadata?.response?.body,
            finishReason: input.result.finishReason,
            headers: resultWithMetadata?.response?.headers,
            modelId: resultWithMetadata?.response?.modelId,
            providerMetadata: input.result.providerMetadata,
            // The running results already have reasoning, but model-io only recorded text in the past.
            // As a result, the call trace cannot obtain response.reasoningText, and the thinking process is never displayed.
            reasoningText: modelIOReasoningText(input.result.reasoning),
            responseId: resultWithMetadata?.response?.id,
            text: input.result.text,
            toolCalls: input.normalizedToolCalls,
            toolResults: normalizeToolResults(input.result, input.normalizedToolCalls),
            sources: normalizeSources(input.result),
            usage: normalizeUsage(input.result.totalUsage ?? input.result.usage),
          }
        : undefined,
      sessionId: stringMetadata(metadata.sessionId),
      querySource: stringMetadata(metadata.querySource),
      startedAt: new Date(input.startedAt).toISOString(),
      traceId: stringMetadata(metadata.traceId),
      turnId: stringMetadata(metadata.turnId),
      type: "model_io",
    },
    input.debugDir,
    input.isDev,
    input.modelIoFullRetentionEnabled,
  );
}

/**
 * Model I/O record for streaming requests.
 *
 * Background (bug: the desktop agent in dev mode always streams, so model-io stayed empty): writing model-io only inside
 * the non-streaming `runGenerateText` means every turn (`streamText`) from the desktop/protocol side, where
 * `modelStreaming: "on"` is the default, never persists anything even when ZCODE_RUNTIME_ENV=development. The streaming path must record too.
 *
 * Key difference from the generate path: the aggregate fields of StreamTextResult, such as text/toolResults/sources/response, are **promises**,
 * which may only be awaited after fullStream has been drained, while normalization expects toolResults/sources to be arrays —
 * so the aggregate promises are resolved first and a synthesized object is worked on afterwards. toolCalls simply reuses the
 * assembler's normalized snapshot. No failure may affect the model request path.
 */
export async function recordStreamTextDebug(input: {
  attempt: number;
  debugDir?: string;
  error?: unknown;
  isDev: boolean;
  modelIoFullRetentionEnabled: boolean;
  normalizedToolCalls: ModelTextResult["toolCalls"];
  options: AiSdkStreamTextOptions;
  recordModelIO: boolean;
  request: AiSdkModelTextRequest;
  requestId: string;
  resolved: ResolvedAiSdkModel;
  result?: AiSdkStreamTextResult;
  startedAt: number;
}): Promise<void> {
  if (!input.recordModelIO) {
    return;
  }

  try {
    // The complete aggregation result is parsed in the successful path; only the request/response metadata is read in the failed path, and it must be time-limited——
    // The AI SDK's aggregation promise never settles after the stream is aborted (user Stop / idle timeout).
    const aggregate = input.result
      ? input.error
        ? await resolveFailedStreamModelIOAggregate(input.result, input.request.abortSignal)
        : await resolveStreamModelIOAggregate(input.result)
      : undefined;
    const completedAt = Date.now();
    const metadata = input.request.metadata ?? {};
    const requestBody =
      input.resolved.rawRequestBodyCapture?.body ??
      aggregate?.requestBody ??
      (input.error
        ? buildFallbackRequestBodyFromOptions({
            options: input.options,
            resolved: input.resolved,
            stream: true,
          })
        : undefined);
    const syntheticResult = {
      toolResults: aggregate?.toolResults,
      sources: aggregate?.sources,
    } as unknown as AiSdkGenerateTextResult;

    writeModelIODebugRecord(
      {
        completedAt: new Date(completedAt).toISOString(),
        durationMs: completedAt - input.startedAt,
        error: input.error ? serializeError(input.error) : undefined,
        requestId: input.requestId,
        attempt: input.attempt,
        model: {
          modelId: input.resolved.modelId,
          providerId: input.resolved.providerId,
        },
        request: {
          body: redactAnthropicRequestMetadata(requestBody),
          headers: input.options.headers,
          maxOutputTokens: input.options.maxOutputTokens,
          messages: input.request.messages,
          providerOptions: input.request.providerOptions,
          sdkMessages: input.options.messages,
          temperature: input.request.temperature,
          toolChoice: input.request.toolChoice,
          toolNames: input.request.tools?.map((toolContract) => toolContract.name) ?? [],
        },
        response: aggregate
          ? {
              body: aggregate.responseBody,
              finishReason: aggregate.finishReason,
              headers: aggregate.responseHeaders,
              modelId: aggregate.responseModelId,
              providerMetadata: aggregate.providerMetadata,
              reasoningText: modelIOReasoningText(aggregate.reasoning),
              responseId: aggregate.responseId,
              text: aggregate.text,
              // The assembler is the sole owner of streaming parameter normalization;
              // model-io reuses its snapshots to avoid secondary parsing, repeated warns, and diagnostic result drift.
              toolCalls: input.normalizedToolCalls,
              toolResults: normalizeToolResults(syntheticResult, input.normalizedToolCalls),
              sources: normalizeSources(syntheticResult),
              usage: normalizeUsage(aggregate.usage),
            }
          : undefined,
        sessionId: stringMetadata(metadata.sessionId),
        querySource: stringMetadata(metadata.querySource),
        startedAt: new Date(input.startedAt).toISOString(),
        traceId: stringMetadata(metadata.traceId),
        turnId: stringMetadata(metadata.turnId),
        type: "model_io",
      },
      input.debugDir,
      input.isDev,
      input.modelIoFullRetentionEnabled,
    );
  } catch {
    // Model I/O debug logging must never affect the model request path.
  }
}

function buildFallbackRequestBodyFromOptions(input: {
  options: AiSdkGenerateTextOptions | AiSdkStreamTextOptions;
  resolved: ResolvedAiSdkModel;
  stream: boolean;
}): Record<string, unknown> {
  const options = input.options as Record<string, unknown>;
  return removeUndefined({
    // The failed path often cannot get the raw request.body exposed by the AI ​​SDK. Record entry here
    // A complete payload snapshot of the AI SDK to facilitate troubleshooting the messages/tools structure of provider 400.
    bodySource: "ai_sdk_options",
    experimental_include: options.experimental_include,
    frequencyPenalty: options.frequencyPenalty,
    maxOutputTokens: options.maxOutputTokens,
    messages: options.messages,
    model: input.resolved.modelId,
    presencePenalty: options.presencePenalty,
    providerOptions: options.providerOptions,
    seed: options.seed,
    stopSequences: options.stopSequences,
    stream: input.stream,
    temperature: options.temperature,
    toolChoice: options.toolChoice,
    tools: options.tools,
    topK: options.topK,
    topP: options.topP,
  });
}

interface StreamModelIOAggregate {
  finishReason?: unknown;
  providerMetadata?: unknown;
  reasoning?: unknown;
  requestBody?: unknown;
  responseBody?: unknown;
  responseHeaders?: unknown;
  responseId?: unknown;
  responseModelId?: unknown;
  sources?: unknown;
  text?: unknown;
  toolResults?: unknown;
  usage?: Parameters<typeof normalizeUsage>[0];
}

// The aggregate fields of StreamTextResult are all promises, which are resolved one by one with best-effort (failure fallback is undefined).
async function resolveStreamModelIOAggregate(
  result: AiSdkStreamTextResult,
): Promise<StreamModelIOAggregate> {
  const streamResult = result as unknown as {
    text?: Promise<unknown>;
    reasoning?: Promise<unknown>;
    finishReason?: Promise<unknown>;
    totalUsage?: Promise<unknown>;
    usage?: Promise<unknown>;
    toolResults?: Promise<unknown>;
    sources?: Promise<unknown>;
    providerMetadata?: Promise<unknown>;
    request?: Promise<unknown>;
    response?: Promise<unknown>;
  };

  const [
    text,
    reasoning,
    finishReason,
    totalUsage,
    usage,
    toolResults,
    sources,
    providerMetadata,
    request,
    response,
  ] = await Promise.all([
    settleModelIOValue(streamResult.text),
    settleModelIOValue(streamResult.reasoning),
    settleModelIOValue(streamResult.finishReason),
    settleModelIOValue(streamResult.totalUsage),
    settleModelIOValue(streamResult.usage),
    settleModelIOValue(streamResult.toolResults),
    settleModelIOValue(streamResult.sources),
    settleModelIOValue(streamResult.providerMetadata),
    settleModelIOValue(streamResult.request),
    settleModelIOValue(streamResult.response),
  ]);

  const requestRecord = (request ?? undefined) as { body?: unknown } | undefined;
  const responseRecord = (response ?? undefined) as
    | { id?: unknown; modelId?: unknown; headers?: unknown; body?: unknown }
    | undefined;

  return {
    text,
    reasoning,
    finishReason,
    usage: (totalUsage ?? usage) as StreamModelIOAggregate["usage"],
    toolResults,
    sources,
    providerMetadata,
    requestBody: requestRecord?.body,
    responseBody: responseRecord?.body,
    responseHeaders: responseRecord?.headers,
    responseId: responseRecord?.id,
    responseModelId: responseRecord?.modelId,
  };
}

function modelIOReasoningText(reasoning: unknown): string | undefined {
  if (!Array.isArray(reasoning)) {
    return undefined;
  }

  const text = normalizeReasoning(reasoning)
    ?.map((part) => part.text)
    .filter((part) => part.trim().length > 0)
    .join("\n\n");
  return text && text.length > 0 ? text : undefined;
}

// After the stream is aborted midway, the AI SDK's request/response aggregation promise neither resolves nor rejects.
// (It will be settled only when the stream is read normally or an error is reported at the stream level). Infinite await will hang the catch of runner-stream.
// turn will never end, activeAbortController will never be released, and the session will reject all new prompts from now on.
// The diagnostic record is best-effort: if the caller has aborted, the aggregation will be skipped directly, and other failures will wait for a time limit.
const FAILED_STREAM_AGGREGATE_TIMEOUT_MS = 1_000;

async function resolveFailedStreamModelIOAggregate(
  result: AiSdkStreamTextResult,
  abortSignal?: AbortSignal,
): Promise<StreamModelIOAggregate> {
  if (abortSignal?.aborted) {
    // User Stop: Let the failed path be completed immediately, and the request body is covered by the fallback snapshot.
    return {};
  }
  const streamResult = result as unknown as {
    request?: Promise<unknown>;
    response?: Promise<unknown>;
  };
  const [request, response] = await Promise.all([
    settleModelIOValueWithTimeout(streamResult.request, FAILED_STREAM_AGGREGATE_TIMEOUT_MS),
    settleModelIOValueWithTimeout(streamResult.response, FAILED_STREAM_AGGREGATE_TIMEOUT_MS),
  ]);
  const requestRecord = (request ?? undefined) as { body?: unknown } | undefined;
  const responseRecord = (response ?? undefined) as
    | { id?: unknown; modelId?: unknown; headers?: unknown; body?: unknown }
    | undefined;

  return {
    requestBody: requestRecord?.body,
    responseBody: responseRecord?.body,
    responseHeaders: responseRecord?.headers,
    responseId: responseRecord?.id,
    responseModelId: responseRecord?.modelId,
  };
}

async function settleModelIOValue<T>(value: Promise<T> | T | undefined): Promise<T | undefined> {
  try {
    return await value;
  } catch {
    return undefined;
  }
}

// User stop/v4 sendQueuedNow preemption will abort the current streaming request; at this time
// The request/response aggregation promise of AI SDK StreamTextResult never settles - the stream is abandoned midway,
// The aggregation will not resolve until the fullStream is closed, and the iterator is finally closed (runner-stream.ts)
// It is ranked after this await, forming a loop waiting. settleModelIOValue only supports reject and does not support "no settle".
// As a result, the catch of runStreamText never ends: TurnCancelled cannot be thrown, turn never closes,
// record.activeAbortController is not released, and the UI stop (canStop) is permanently invalid.
// (e2e recurrence: conversation-session-v4-vertical-slice/v4-sendnow).
// Model-io records of failed paths must have bounded waits: timeouts are treated as "value not available" and will never block error propagation.
async function settleModelIOValueWithTimeout<T>(
  value: Promise<T> | T | undefined,
  timeoutMs: number,
): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<undefined>((resolve) => {
      timer = setTimeout(() => resolve(undefined), timeoutMs);
      if (typeof timer === "object" && "unref" in timer) {
        timer.unref();
      }
    });
    return await Promise.race([settleModelIOValue(value), timeout]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

// Normalized ZCODE_RUNTIME_ENV; returns undefined when not set, and is handled by the caller according to production.
function normalizeRuntimeEnv(env: EnvRecord): string | undefined {
  return normalizeZCodeRuntimeEnv(env[ZCODE_RUNTIME_ENV_KEY]);
}

function writeModelIODebugRecord(
  record: Record<string, unknown>,
  debugDir?: string,
  isDev?: boolean,
  modelIoFullRetentionEnabled = false,
): void {
  try {
    // model-I/O diagnosis directly persists the request/response headers of the AI SDK,
    // During idle time, the Provider's JWT, Coding Plan Key and ticket will therefore be written to files named by session.
    // Network telemetry desensitization is reused at the unified disk boundary to ensure that generate/stream and subsequent callers will not miss out.
    const sanitizedRecord = sanitizeModelIODebugRecord(record);
    const development = isDev ?? false;
    const dir = debugDir ?? getModelIOBaseDir(isDev ?? false);
    mkdirSync(dir, { recursive: true });
    const sessionSegment =
      sanitizeFileSegment(stringMetadata(sanitizedRecord.sessionId)) || "no-session";
    const fileName = `model-io-${sessionSegment}.jsonl`;
    const filePath = join(dir, fileName);
    const fileExists = existsSync(filePath);
    if (modelIoFullRetentionEnabled) {
      // Full retention still passes the unified desensitization boundary, but rotation, quota reset, production cropping and context compression are skipped.
      // This is a diagnostic mode explicitly selected by the user; the compaction state is updated so that the next bounded write after shutdown can be smoothly continued.
      appendFileSync(filePath, `${stringifyDebugRecord(sanitizedRecord)}\n`, "utf8");
      modelIOCompactionStates.set(filePath, buildModelIOCompactionState(sanitizedRecord));
      return;
    }
    // The production state (rollout) sets a capacity limit to avoid maxing out the disk during long-term operation; the development state (debug) also retains a higher single file limit.
    // Each previous model request in the same session will create a new complete context file, forming a repeated triangle;
    // Now it is changed to one session and one JSONL file, new requests are appended to the same file, and only new sessions participate in the elimination.
    if (!development && !fileExists) {
      rotateModelIOFiles(dir, MAX_ROLLOUT_FILES - 1);
    }
    const existingBytes = fileExists ? readFileSize(filePath) : 0;
    const maxSessionBytes = development ? MAX_DEBUG_SESSION_BYTES : MAX_ROLLOUT_SESSION_BYTES;
    const resetForSizeLimit = existingBytes >= maxSessionBytes;
    const preparedRecord = prepareModelIORecordForWrite(sanitizedRecord, development);
    const previousState =
      fileExists && !resetForSizeLimit ? modelIOCompactionStates.get(filePath) : undefined;
    const compacted = compactModelIORecord(preparedRecord, previousState, {
      maxBaselineMessages: development
        ? MAX_DEBUG_BASELINE_MESSAGES
        : MAX_ROLLOUT_BASELINE_MESSAGES,
      preserveFullBodyMessages: Boolean(preparedRecord.error),
    });
    const recordToWrite = resetForSizeLimit
      ? {
          ...compacted,
          modelIOReset: {
            maxFileBytes: maxSessionBytes,
            previousFileBytes: existingBytes,
            reason: "session_file_size_limit",
          },
        }
      : compacted;
    const line = `${stringifyDebugRecord(recordToWrite)}\n`;
    if (resetForSizeLimit) {
      // If the entire history JSONL is read and expanded synchronously before each append, the rollout of a long session
      // When the file reaches the GB level, it will natively crash during the UTF-8 conversion/V8 string allocation stage. When the limit is exceeded, it will be reset directly to
      // The current bounded baseline ensures that diagnostic logs will not threaten the agent's main process.
      writeFileSync(filePath, line, "utf8");
    } else {
      appendFileSync(filePath, line, "utf8");
    }
    modelIOCompactionStates.set(filePath, buildModelIOCompactionState(preparedRecord));
  } catch {
    // Model I/O debug logging must never affect the model request path.
  }
}

// Ensure that the number of model-io-*.jsonl files in the directory does not exceed maxFiles (maxFiles-1 is passed when leaving space for this new session file).
function rotateModelIOFiles(dir: string, maxFiles: number): void {
  let files: string[];
  try {
    files = readdirSync(dir).filter(
      (name) => name.startsWith("model-io-") && name.endsWith(".jsonl"),
    );
  } catch {
    return; // The directory has just been created/failed to read, no need to eliminate it
  }

  let removeCount = files.length - maxFiles;
  if (removeCount <= 0) {
    return;
  }

  const oldestFirst = files
    .map((name) => {
      try {
        return { name, mtimeMs: statSync(join(dir, name)).mtimeMs };
      } catch {
        return { name, mtimeMs: 0 };
      }
    })
    .sort((left, right) => left.mtimeMs - right.mtimeMs)
    .map((entry) => entry.name);
  for (const name of oldestFirst) {
    if (removeCount <= 0) break;
    const filePath = join(dir, name);
    try {
      rmSync(filePath, { force: true });
      modelIOCompactionStates.delete(filePath);
      removeCount -= 1;
    } catch {
      // Failure to delete a single file does not block writing
    }
  }
}

// Only the file name safe characters are retained, the rest are folded into -, and the length is limited to avoid reaching the Windows path length limit.
function sanitizeFileSegment(value?: string): string {
  if (!value) {
    return "";
  }
  return value
    .replace(/[^a-zA-Z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

// The storage profile rollback removed the custom CLI root module, and legacy imports will prevent adapters from being built.
// Historical semantics are maintained here: in development mode, write ~/.zcode/cli/debug, in production mode, write ~/.zcode/cli/rollout.
function getModelIOBaseDir(isDev: boolean): string {
  return join(homedir(), ".zcode", "cli", isDev ? "debug" : "rollout");
}

function stringifyDebugRecord(record: Record<string, unknown>): string {
  return JSON.stringify(record);
}

function readFileSize(filePath: string): number {
  try {
    return statSync(filePath).size;
  } catch {
    return 0;
  }
}

function prepareModelIORecordForWrite(
  record: Record<string, unknown>,
  isDev: boolean,
): Record<string, unknown> {
  if (isDev) {
    return record;
  }

  const request = asRecord(record.request);
  const response = asRecord(record.response);
  return {
    ...record,
    request: request ? prepareProductionRequestRecord(request, Boolean(record.error)) : request,
    response: response ? prepareProductionResponseRecord(response) : response,
  };
}

function prepareProductionRequestRecord(
  request: Record<string, unknown>,
  hasError: boolean,
): Record<string, unknown> {
  const next = { ...request };
  // Production rollout only keeps canonical request.messages. sdkMessages and provider body.messages
  // Usually it is a duplicate copy of the same context. A long session will amplify the diagnostic file and single stringify several times.
  delete next.sdkMessages;
  const body = asRecord(next.body);
  if (body && !hasError) {
    const nextBody = { ...body };
    delete nextBody.messages;
    next.body = nextBody;
  }
  return next;
}

function prepareProductionResponseRecord(
  response: Record<string, unknown>,
): Record<string, unknown> {
  const next = { ...response };
  // response.body is less valuable than text/toolCalls/usage/finishReason in production troubleshooting, and may contain the provider original package.
  delete next.body;
  return next;
}

function compactModelIORecord(
  record: Record<string, unknown>,
  previousState: ModelIOCompactionState | undefined,
  options: { maxBaselineMessages: number; preserveFullBodyMessages?: boolean },
): Record<string, unknown> {
  const request = asRecord(record.request);
  if (!request) {
    return record;
  }

  return {
    ...record,
    request: compactModelIORequest(request, previousState?.request, options),
  };
}

function compactModelIORequest(
  request: Record<string, unknown>,
  previousState: ModelIORequestCompactionState | undefined,
  options: { maxBaselineMessages: number; preserveFullBodyMessages?: boolean },
): Record<string, unknown> {
  const next = { ...request };
  compactMessageCollection(
    next,
    previousState?.messages,
    {
      collectionKey: "messages",
      countKey: "messageCount",
      kindKey: "messagesKind",
      offsetKey: "messageOffset",
    },
    options,
  );
  compactMessageCollection(
    next,
    previousState?.sdkMessages,
    {
      collectionKey: "sdkMessages",
      countKey: "sdkMessageCount",
      kindKey: "sdkMessagesKind",
      offsetKey: "sdkMessageOffset",
    },
    options,
  );

  const body = asRecord(next.body);
  if (body) {
    const nextBody = { ...body };
    const bodyMessageKeys = {
      collectionKey: "messages",
      countKey: "bodyMessageCount",
      kindKey: "bodyMessagesKind",
      offsetKey: "bodyMessageOffset",
    };
    if (options.preserveFullBodyMessages && Array.isArray(nextBody.messages)) {
      // Provider 400 and other failure troubleshooting require exact request payload; if the failure record continues
      // Doing delta according to the previous model-io will throw the most critical complete messages out of the export package.
      next[bodyMessageKeys.countKey] = nextBody.messages.length;
      next[bodyMessageKeys.kindKey] = "full";
      next[bodyMessageKeys.offsetKey] = 0;
    } else {
      compactMessageCollection(
        nextBody,
        previousState?.bodyMessages,
        bodyMessageKeys,
        options,
        next,
      );
    }
    next.body = nextBody;
  }

  return next;
}

function compactMessageCollection(
  target: Record<string, unknown>,
  previousState: ModelIOCollectionState | undefined,
  keys: {
    collectionKey: string;
    countKey: string;
    kindKey: string;
    offsetKey: string;
  },
  options: { maxBaselineMessages: number },
  metadataTarget: Record<string, unknown> = target,
): void {
  const currentMessages = target[keys.collectionKey];
  if (!Array.isArray(currentMessages)) {
    return;
  }

  metadataTarget[keys.countKey] = currentMessages.length;
  if (canStoreDeltaFromState(currentMessages, previousState)) {
    // Subsequent model-io only records new messages relative to the previous request to avoid gradient duplication of the complete history within the same session.
    // previousState comes from the in-process cache and no longer reads and expands the entire history JSONL synchronously for append.
    target[keys.collectionKey] = currentMessages.slice(previousState.count);
    metadataTarget[keys.kindKey] = "delta";
    metadataTarget[keys.offsetKey] = previousState.count;
    return;
  }

  const maxBaselineMessages = Math.max(1, options.maxBaselineMessages);
  if (currentMessages.length > maxBaselineMessages) {
    const offset = currentMessages.length - maxBaselineMessages;
    target[keys.collectionKey] = currentMessages.slice(offset);
    metadataTarget[keys.kindKey] = "tail";
    metadataTarget[keys.offsetKey] = offset;
    return;
  }

  metadataTarget[keys.kindKey] = "full";
  metadataTarget[keys.offsetKey] = 0;
}

function canStoreDeltaFromState(
  currentMessages: unknown[],
  previousState: ModelIOCollectionState | undefined,
): previousState is ModelIOCollectionState {
  if (!previousState || previousState.count <= 0 || currentMessages.length < previousState.count) {
    return false;
  }
  const firstFingerprint = fingerprintValue(currentMessages[0]);
  const lastFingerprint = fingerprintValue(currentMessages[previousState.count - 1]);
  return (
    firstFingerprint === previousState.firstFingerprint &&
    lastFingerprint === previousState.lastFingerprint &&
    hasSameSampleFingerprints(currentMessages, previousState)
  );
}

function buildModelIOCompactionState(record: Record<string, unknown>): ModelIOCompactionState {
  const request = asRecord(record.request);
  if (!request) {
    return {};
  }

  return {
    request: buildRequestCompactionState(request),
  };
}

function buildRequestCompactionState(
  request: Record<string, unknown>,
): ModelIORequestCompactionState {
  const body = asRecord(request.body);
  return {
    bodyMessages: buildCollectionState(body?.messages),
    messages: buildCollectionState(request.messages),
    sdkMessages: buildCollectionState(request.sdkMessages),
  };
}

function buildCollectionState(value: unknown): ModelIOCollectionState | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  return {
    count: value.length,
    firstFingerprint: fingerprintValue(value[0]),
    lastFingerprint: fingerprintValue(value[value.length - 1]),
    sampleFingerprints: fingerprintCollectionSamples(value),
  };
}

function hasSameSampleFingerprints(
  currentMessages: unknown[],
  previousState: ModelIOCollectionState,
): boolean {
  const previousSamples = previousState.sampleFingerprints;
  if (!previousSamples) {
    return true;
  }
  const currentSamples = fingerprintCollectionSamples(currentMessages, previousState.count);
  return (
    currentSamples.length === previousSamples.length &&
    currentSamples.every((fingerprint, index) => fingerprint === previousSamples[index])
  );
}

function fingerprintCollectionSamples(value: unknown[], count = value.length): string[] {
  if (count <= 0) {
    return [];
  }
  // Constant-level sampling of the first/middle/last position avoids stringifying the entire history into a giant string, while reducing the probability that intermediate historical changes are misjudged as delta.
  const lastIndex = count - 1;
  const indexes = new Set([
    0,
    Math.floor(lastIndex * 0.25),
    Math.floor(lastIndex * 0.5),
    Math.floor(lastIndex * 0.75),
    lastIndex,
  ]);
  return [...indexes].map((index) => fingerprintValue(value[index]));
}

function fingerprintValue(value: unknown, depth = 0): string {
  if (value === null || value === undefined) {
    return String(value);
  }
  if (typeof value === "string") {
    return [
      "string",
      String(value.length),
      value.slice(0, FINGERPRINT_STRING_LIMIT),
      value.slice(-FINGERPRINT_STRING_LIMIT),
    ].join(":");
  }
  if (typeof value !== "object") {
    return `${typeof value}:${String(value)}`;
  }
  if (depth >= 3) {
    return Array.isArray(value) ? `array:${value.length}` : "object";
  }
  if (Array.isArray(value)) {
    return [
      "array",
      String(value.length),
      fingerprintValue(value[0], depth + 1),
      fingerprintValue(value[value.length - 1], depth + 1),
    ].join(":");
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const sampledKeys = keys.slice(0, 12);
  return [
    "object",
    String(keys.length),
    ...sampledKeys.map((key) => `${key}=${fingerprintValue(record[key], depth + 1)}`),
  ].join(":");
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function removeUndefined<T extends Record<string, unknown>>(value: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(value).filter(([, entryValue]) => entryValue !== undefined),
  ) as Partial<T>;
}

function serializeError(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
    };
  }

  return {
    name: "UnknownError",
    message: String(error),
  };
}
