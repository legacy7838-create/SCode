import { mkdir, writeFile, rename, rm, readdir, stat } from "node:fs/promises";
import { dirname, basename, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { acquireFileLock } from "@zcode/shared/node";
import { isInjectedFsFaultError, maybeThrowInjectedFsFault } from "./fsFaultInjection.js";

const DEFAULT_RENAME_RETRY_DELAYS_MS = [50, 100, 200, 400, 800, 1600, 3200] as const;
const DEFAULT_LOCK_RETRY_DELAYS_MS = [25, 50, 100, 200, 400] as const;
const DEFAULT_LOCK_OWNERLESS_GRACE_MS = 100;
const DEFAULT_LOCK_MAX_WAIT_MS = 8_000;
const DEFAULT_TEMP_FILE_STALE_MS = 60_000;

interface AtomicWriteTextOptions {
  renameRetryDelaysMs?: readonly number[];
  lockRetryDelaysMs?: readonly number[];
  lockOwnerlessGraceMs?: number;
  lockMaxWaitMs?: number;
  tempFileStaleMs?: number;
  useFileLock?: boolean;
  beforeRename?: () => void | Promise<void>;
  runRename?: (renameFile: () => Promise<void>) => Promise<void>;
}

function getErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }

  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

function isRetryableAtomicRenameError(error: unknown): boolean {
  if (isInjectedFsFaultError(error)) {
    return false;
  }
  const code = getErrorCode(error);
  return code === "EPERM" || code === "EBUSY" || code === "EACCES";
}

async function renameWithRetry(
  tempFile: string,
  filePath: string,
  retryDelaysMs: readonly number[] = DEFAULT_RENAME_RETRY_DELAYS_MS,
): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      maybeThrowInjectedFsFault({ operation: "rename", path: filePath });
      await rename(tempFile, filePath);
      return;
    } catch (error) {
      const retryDelayMs = retryDelaysMs[attempt];
      if (retryDelayMs === undefined || !isRetryableAtomicRenameError(error)) {
        throw error;
      }

      await sleep(retryDelayMs);
    }
  }
}

async function cleanupStaleTempFilesForTarget(
  filePath: string,
  excludeTempFile: string,
  staleMs: number,
): Promise<void> {
  const dir = dirname(filePath);
  const targetBasename = basename(filePath);
  const tempPrefix = `${targetBasename}.`;
  const now = Date.now();

  try {
    const entries = await readdir(dir);
    await Promise.all(
      entries.map(async (entry) => {
        if (!entry.startsWith(tempPrefix) || !entry.endsWith(".tmp")) {
          return;
        }

        const tempPath = join(dir, entry);
        if (tempPath === excludeTempFile) {
          return;
        }

        try {
          const info = await stat(tempPath);
          if (now - info.mtimeMs < staleMs) {
            return;
          }
          await rm(tempPath, { force: true });
        } catch {
          // best-effort cleanup
        }
      }),
    );
  } catch {
    // best-effort cleanup
  }
}

/**
 * Implements atomic writes with a temp file plus rename.
 * rename is atomic within the same filesystem, which avoids the data-overwrite risk of
 * concurrent read-modify-write.
 * The temp file is written in the same directory as the target, avoiding cross-volume rename
 * failures on Windows.
 */
export async function atomicWriteText(
  filePath: string,
  content: string,
  options?: AtomicWriteTextOptions,
): Promise<void> {
  const dir = dirname(filePath);
  const tempFile = join(
    dir,
    `${basename(filePath)}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`,
  );
  maybeThrowInjectedFsFault({ operation: "mkdir", path: dir });
  await mkdir(dir, { recursive: true });
  // Multiple windows/host processes on Windows may save the same task JSON at the same time.
  // In-process writeChains cannot cover this write rush, and end up with high EPERM when rename replaces the target file.
  // Here, the lock file in the same directory is used for collaborative serialization between ZCode processes, and rename is retained to retry to handle the short-term occupation of the anti-software/indexer.
  const releaseLock =
    options?.useFileLock === false
      ? null
      : await acquireFileLock(
          filePath,
          options?.lockRetryDelaysMs ?? DEFAULT_LOCK_RETRY_DELAYS_MS,
          options?.lockOwnerlessGraceMs ?? DEFAULT_LOCK_OWNERLESS_GRACE_MS,
          options?.lockMaxWaitMs ?? DEFAULT_LOCK_MAX_WAIT_MS,
        );
  try {
    // Failed rename on older versions or after a crash will leave config.json.*.tmp behind.
    // Only clean up temporary files that exceed the threshold for the same target file to avoid accidentally deleting active temp just created by another process.
    await cleanupStaleTempFilesForTarget(
      filePath,
      tempFile,
      options?.tempFileStaleMs ?? DEFAULT_TEMP_FILE_STALE_MS,
    );
    maybeThrowInjectedFsFault({ operation: "writeFile", path: tempFile });
    await writeFile(tempFile, content, "utf-8");
    await options?.beforeRename?.();
    // Windows Defender, the indexing service, or another window might briefly occupy the target JSON.
    // Causes atomic replacement rename to throw EPERM/EBUSY/EACCES. Here we only do short retries for this type of temporary lock.
    // Still throw the real permission issues as they are to avoid silently losing session snapshots.
    const renameFile = () => renameWithRetry(tempFile, filePath, options?.renameRetryDelaysMs);
    if (options?.runRename) {
      await options.runRename(renameFile);
    } else {
      await renameFile();
    }
  } catch (error) {
    await rm(tempFile, { force: true }).catch(() => {
      // best-effort cleanup
    });
    throw error;
  } finally {
    await releaseLock?.();
  }
}

export async function atomicWriteJson(
  filePath: string,
  data: Record<string, unknown>,
  options?: AtomicWriteTextOptions,
): Promise<void> {
  await atomicWriteText(filePath, JSON.stringify(data, null, 2), options);
}
