function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function normalizeErrorCode(value: unknown): string | undefined {
  if (typeof value === "string" || typeof value === "number" || typeof value === "bigint") {
    return String(value);
  }

  return undefined;
}

function getErrorCandidate(error: unknown): unknown {
  if (!isRecord(error) || !("error" in error) || !isRecord(error.error)) {
    return error;
  }

  if ("message" in error.error || "code" in error.error) {
    return error.error;
  }

  return error;
}

export interface NormalizedUnknownError {
  message: string;
  code?: string;
}

export const ZCODE_FILE_LOCK_TIMEOUT_ERROR_CODE = "ZCODE_FILE_LOCK_TIMEOUT" as const;

export function stringifyUnknownValue(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (value === null) {
    return "null";
  }
  if (value === undefined) {
    return "undefined";
  }
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }

  try {
    const serialized = JSON.stringify(value);
    if (serialized !== undefined) {
      return serialized;
    }
  } catch {
    // Some protocol error objects contain circular references.
    // Swallow JSON serialization exceptions here to avoid creating a second error when displaying the original error.
  }

  return String(value);
}

export function normalizeUnknownError(error: unknown): NormalizedUnknownError {
  const candidate = getErrorCandidate(error);
  if (candidate instanceof Error) {
    const errorWithCode = candidate as Error & { code?: unknown };
    return {
      // Some runtime Error.message may be empty strings.
      // Here we fall back in the order of message -> name -> String to ensure the frontend always gets displayable text.
      message: candidate.message || candidate.name || String(candidate),
      code: normalizeErrorCode(errorWithCode.code),
    };
  }

  if (isRecord(candidate)) {
    const code = "code" in candidate ? normalizeErrorCode(candidate.code) : undefined;
    const message =
      "message" in candidate
        ? stringifyUnknownValue(candidate.message)
        : stringifyUnknownValue(candidate);

    return {
      message:
        message !== "undefined" && message.length > 0 ? message : stringifyUnknownValue(candidate),
      code,
    };
  }

  return {
    message: stringifyUnknownValue(candidate),
  };
}

export function isZCodeFileLockTimeoutError(error: unknown): boolean {
  return normalizeUnknownError(error).code === ZCODE_FILE_LOCK_TIMEOUT_ERROR_CODE;
}
