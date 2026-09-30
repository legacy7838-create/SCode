import type { ZCodeError, TraceId } from "@zcode/shared";
import { errorAttributionSchema, type ErrorAttribution } from "@zcode/shared/zcode-protocol-v4";

export interface ZCodeUiError extends ZCodeError {
  attribution?: ErrorAttribution;
  detail?: string;
  underlyingErrorMessage?: string;
  underlyingErrorDetail?: string;
}

interface NormalizeZCodeUiErrorOptions {
  fallbackCode?: string;
  fallbackMessage?: string;
  traceId?: TraceId;
  taskId?: string;
}

const GENERIC_ZCODE_UI_ERROR_MESSAGES = new Set([
  "Internal error",
  "Turn execution failed",
  "Compact failed",
  "Rewind failed",
  "ZCode session failed",
]);

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function tryParseJsonString(value: string): unknown | null {
  const trimmed = value.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) {
    return null;
  }

  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

function readValueByPath(record: Record<string, unknown>, path: readonly string[]): unknown {
  let current: unknown = record;
  for (const segment of path) {
    if (!isObjectRecord(current)) {
      return undefined;
    }
    current = current[segment];
  }
  return current;
}

function collectMessageCandidatesFromRecord(record: Record<string, unknown>): string[] {
  const result: string[] = [];
  const push = (value: unknown) => {
    const normalized = normalizeString(value);
    if (!normalized || result.includes(normalized)) {
      return;
    }
    result.push(normalized);
  };

  const messagePaths: Array<readonly string[]> = [
    ["message"],
    ["detail"],
    ["data", "message"],
    ["data", "detail"],
    // ZCode Agent often puts readable reasons in data.details (plural); previously it only recognized detail,
    // This will cause the UI to only see “Internal error” and lose key executable prompts.
    ["data", "details"],
    ["data", "reason"],
    ["data", "error", "message"],
    ["data", "error", "detail"],
    ["data", "error", "details"],
    // zcode-cli places model/network error summaries under data.zcode.error.
    // Previously, the UI only read data.error, causing the already structured provider root cause to still be covered by “Internal error”.
    ["data", "zcode", "error", "message"],
    ["data", "zcode", "error", "detail"],
    ["data", "zcode", "error", "details"],
  ];
  for (const path of messagePaths) {
    push(readValueByPath(record, path));
  }

  return result;
}

function collectMessageCandidates(error: unknown): string[] {
  const result: string[] = [];
  const push = (value: unknown) => {
    const normalized = normalizeString(value);
    if (!normalized || result.includes(normalized)) {
      return;
    }
    result.push(normalized);
  };

  if (error instanceof Error) {
    push(error.message);
  }

  if (typeof error === "string") {
    const parsed = tryParseJsonString(error);
    if (isObjectRecord(parsed)) {
      for (const candidate of collectMessageCandidatesFromRecord(parsed)) {
        push(candidate);
      }
      if (result.length > 0) {
        return result;
      }
    }
    // task_error is usually a JSON string, and the message/detail will be displayed first.
    // Only fall back to the entire original string when the structured field cannot be parsed.
    push(error);
    return result;
  }

  if (isObjectRecord(error)) {
    for (const candidate of collectMessageCandidatesFromRecord(error)) {
      push(candidate);
      const parsed = tryParseJsonString(candidate);
      if (isObjectRecord(parsed)) {
        for (const nestedCandidate of collectMessageCandidatesFromRecord(parsed)) {
          push(nestedCandidate);
        }
      }
    }
    return result;
  }

  push(String(error));
  return result;
}

function readFirstStringFromPaths(
  error: unknown,
  paths: Array<readonly string[]>,
): string | undefined {
  const record = isObjectRecord(error)
    ? error
    : typeof error === "string"
      ? tryParseJsonString(error)
      : null;
  if (!isObjectRecord(record)) {
    return undefined;
  }

  for (const path of paths) {
    const value = normalizeString(readValueByPath(record, path));
    if (value) {
      return value;
    }
  }
  return undefined;
}

function readFirstAttributionFromPaths(error: unknown): ErrorAttribution | undefined {
  const record = isObjectRecord(error)
    ? error
    : typeof error === "string"
      ? tryParseJsonString(error)
      : null;
  if (!isObjectRecord(record)) {
    return undefined;
  }

  const paths: Array<readonly string[]> = [
    ["attribution"],
    ["data", "attribution"],
    ["data", "error", "attribution"],
    ["data", "zcode", "error", "attribution"],
  ];
  for (const path of paths) {
    const parsed = errorAttributionSchema.safeParse(readValueByPath(record, path));
    if (parsed.success) {
      return parsed.data;
    }
  }
  return undefined;
}

export function normalizeZCodeUiError(
  error: unknown,
  options: NormalizeZCodeUiErrorOptions = {},
): ZCodeUiError {
  const candidates = collectMessageCandidates(error);
  // zcode-cli has put the provider/network root cause into detail or data.zcode.error,
  // The outer layer may still retain packaging copy such as "Internal error". The main prompt prioritizes non-generalization candidates to avoid root causes being obscured.
  const primaryMessage =
    candidates.find((candidate) => !GENERIC_ZCODE_UI_ERROR_MESSAGES.has(candidate)) ??
    candidates[0] ??
    options.fallbackMessage ??
    "Internal error";
  const detailMessage = candidates.find(
    (candidate) => candidate !== primaryMessage && !GENERIC_ZCODE_UI_ERROR_MESSAGES.has(candidate),
  );
  const codeFromError = readFirstStringFromPaths(error, [
    ["code"],
    ["providerCode"],
    ["data", "code"],
    ["data", "error", "code"],
    ["data", "zcode", "error", "code"],
    // turn-errors will write the provider business code into summary.code; some links still only fall into context.providerCode.
    ["data", "zcode", "error", "context", "providerCode"],
    ["data", "error", "context", "providerCode"],
    ["context", "providerCode"],
  ]);
  const detailFromError = readFirstStringFromPaths(error, [
    ["detail"],
    ["data", "detail"],
    ["data", "error", "detail"],
    ["data", "zcode", "error", "detail"],
  ]);
  const underlyingErrorMessage = readFirstStringFromPaths(error, [
    ["underlyingErrorMessage"],
    ["data", "underlyingErrorMessage"],
    ["data", "error", "underlyingErrorMessage"],
    ["data", "zcode", "error", "underlyingErrorMessage"],
  ]);
  const underlyingErrorDetail = readFirstStringFromPaths(error, [
    ["underlyingErrorDetail"],
    ["data", "underlyingErrorDetail"],
    ["data", "error", "underlyingErrorDetail"],
    ["data", "zcode", "error", "underlyingErrorDetail"],
  ]);
  const providerCodeFromDetail = detailFromError?.match(/provider_code=([0-9]+)/)?.[1];
  const traceIdFromError = readFirstStringFromPaths(error, [
    ["traceId"],
    ["data", "traceId"],
    ["data", "error", "traceId"],
    ["data", "zcode", "error", "traceId"],
  ]) as TraceId | undefined;
  const taskIdFromError = readFirstStringFromPaths(error, [
    ["taskId"],
    ["data", "taskId"],
    ["data", "error", "taskId"],
    ["data", "zcode", "error", "taskId"],
  ]);
  const attribution = readFirstAttributionFromPaths(error);

  return {
    // Some upstream error outer codes are just PROVIDER_BUSINESS_ERROR,
    // The real GLM/zcode-plan business code is only saved in detail’s provider_code=xxxx.
    // The business code needs to enter the unified error classification layer, otherwise the ChatView quota banner cannot be hit.
    code: providerCodeFromDetail ?? codeFromError ?? options.fallbackCode ?? "UNKNOWN",
    message: primaryMessage,
    detail: detailMessage,
    ...(underlyingErrorMessage ? { underlyingErrorMessage } : {}),
    ...(underlyingErrorDetail ? { underlyingErrorDetail } : {}),
    traceId: options.traceId ?? traceIdFromError,
    taskId: options.taskId ?? taskIdFromError,
    ...(attribution ? { attribution } : {}),
  };
}
