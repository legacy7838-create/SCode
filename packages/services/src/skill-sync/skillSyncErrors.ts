import { SKILL_SYNC_SIZE_LIMIT_ERROR_CODE, type SkillSyncSizeLimitErrorData } from "@zcode/shared";

// The original error only carried the byte count concatenated text, and the UI could not reliably differentiate between export content, archive and decompression stages across RPCs.
// Unified and transparent transmission of stable code and structured data allows the UI to display actionable errors in the current language.
interface SkillSyncSizeLimitError extends Error {
  code: typeof SKILL_SYNC_SIZE_LIMIT_ERROR_CODE;
  data: SkillSyncSizeLimitErrorData;
}

export function createSkillSyncSizeLimitError(
  data: SkillSyncSizeLimitErrorData,
): SkillSyncSizeLimitError {
  const error = new Error(
    `skill sync size limit exceeded: ${data.actualBytes}/${data.maxBytes} (${data.phase})`,
  ) as SkillSyncSizeLimitError;
  error.name = "SkillSyncSizeLimitError";
  error.code = SKILL_SYNC_SIZE_LIMIT_ERROR_CODE;
  error.data = data;
  return error;
}
