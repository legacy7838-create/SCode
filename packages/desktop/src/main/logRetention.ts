import { readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";

export const LOG_RETENTION_DAYS = 14;

const LOG_FILE_NAME_RE = /^(\d{4})-(\d{2})-(\d{2})\.log$/;

function getStartOfLocalDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function parseLogDateFromFileName(fileName: string): Date | null {
  const match = LOG_FILE_NAME_RE.exec(fileName);
  if (!match) {
    return null;
  }

  const [, yearText, monthText, dayText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const parsed = new Date(year, month - 1, day);

  if (
    parsed.getFullYear() !== year ||
    parsed.getMonth() !== month - 1 ||
    parsed.getDate() !== day
  ) {
    return null;
  }

  return parsed;
}

function getLogRetentionCutoffDate(now: Date, retentionDays: number = LOG_RETENTION_DAYS): Date {
  const cutoff = getStartOfLocalDay(now);
  cutoff.setDate(cutoff.getDate() - Math.max(retentionDays - 1, 0));
  return cutoff;
}

function shouldDeleteExpiredLogFile(
  fileName: string,
  now: Date,
  retentionDays: number = LOG_RETENTION_DAYS,
): boolean {
  const fileDate = parseLogDateFromFileName(fileName);
  if (!fileDate) {
    return false;
  }

  return fileDate < getLogRetentionCutoffDate(now, retentionDays);
}

interface LogRetentionCleanupResult {
  deletedFiles: string[];
  failedFiles: string[];
}

export function cleanupExpiredLogFiles(
  logDir: string,
  options?: {
    now?: Date;
    retentionDays?: number;
  },
): LogRetentionCleanupResult {
  const now = options?.now ?? new Date();
  const retentionDays = options?.retentionDays ?? LOG_RETENTION_DAYS;

  try {
    const deletedFiles: string[] = [];
    const failedFiles: string[] = [];
    const entries = readdirSync(logDir, { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isFile()) {
        continue;
      }

      if (!shouldDeleteExpiredLogFile(entry.name, now, retentionDays)) {
        continue;
      }

      const filePath = join(logDir, entry.name);
      try {
        // The main log is currently only segmented by day and has no retention period. Old files will accumulate indefinitely.
        // Here, the logs from 14 days ago are cleared at startup, and the disk growth is controlled at the minimum cost.
        unlinkSync(filePath);
        deletedFiles.push(entry.name);
      } catch {
        failedFiles.push(entry.name);
      }
    }

    return { deletedFiles, failedFiles };
  } catch {
    return { deletedFiles: [], failedFiles: [] };
  }
}
