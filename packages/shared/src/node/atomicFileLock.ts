import { ZCODE_FILE_LOCK_TIMEOUT_ERROR_CODE } from "../errors.js";
import { mkdir, readFile, readdir, rmdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { createLockInstanceObserver, type ObserveLockInstance } from "./lockInstanceObserver.js";

const MAX_LOCK_METADATA_CLOCK_SKEW_MS = 5 * 60_000;

function getErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }

  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

function isFileExistsError(error: unknown): boolean {
  return getErrorCode(error) === "EEXIST";
}

interface FileLockMetadata {
  createdAt: number | null;
  pid: number | null;
}

function parseLockTimestamp(value: unknown, observedAt: number): number | null {
  return typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= observedAt + MAX_LOCK_METADATA_CLOCK_SKEW_MS
    ? value
    : null;
}

function parseLockMetadata(raw: string, observedAt: number): FileLockMetadata {
  try {
    const parsed = JSON.parse(raw) as { createdAt?: unknown; pid?: unknown };
    return {
      // Non-finite, negative, or clearly future createdAt would make an ownerless lock permanently unable to reach stale.
      // When metadata is invalid, let the caller fall back to the equally validated file mtime.
      createdAt: parseLockTimestamp(parsed.createdAt, observedAt),
      // Passing 0, negative, decimal, or non-finite PID to process.kill may be misjudged as a live process,
      // making a damaged lock permanently unrecoverable. Only positive safe integers usable by the operating system have owner semantics.
      pid:
        typeof parsed.pid === "number" && Number.isSafeInteger(parsed.pid) && parsed.pid > 0
          ? parsed.pid
          : null,
    };
  } catch {
    return { createdAt: null, pid: null };
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return getErrorCode(error) !== "ESRCH";
  }
}

interface LockRemovalAttempt {
  removed: boolean;
  error?: unknown;
}

async function isOwnerFileReclaimable(
  ownerFile: string,
  ownerlessGraceMs: number,
  observeLockInstance: ObserveLockInstance,
): Promise<boolean> {
  const observedAt = Date.now();
  const raw = await readFile(ownerFile, "utf-8");
  const metadata = parseLockMetadata(raw, observedAt);
  let createdAt = metadata.createdAt;
  if (createdAt === null) {
    const ownerStat = await stat(ownerFile);
    createdAt =
      parseLockTimestamp(ownerStat.mtimeMs, observedAt) ??
      observeLockInstance(ownerFile, ownerStat, observedAt);
  }
  const ownerExited = metadata.pid !== null && !isProcessAlive(metadata.pid);
  const ownerlessLockIsStale = metadata.pid === null && observedAt - createdAt >= ownerlessGraceMs;
  return ownerExited || ownerlessLockIsStale;
}

async function removeAbandonedLock(
  lockFile: string,
  ownerlessGraceMs: number,
  observeLockInstance: ObserveLockInstance,
): Promise<LockRemovalAttempt> {
  try {
    const lockStat = await stat(lockFile);
    if (lockStat.isDirectory()) {
      const entries = await readdir(lockFile);
      const owners = entries.filter(
        (entry) => entry.startsWith("owner-") && entry.endsWith(".json"),
      );
      if (owners.length === 1) {
        const ownerFile = join(lockFile, owners[0]!);
        if (!(await isOwnerFileReclaimable(ownerFile, ownerlessGraceMs, observeLockInstance))) {
          return { removed: false };
        }

        // Deleting by unique owner file is equivalent to ownership validation. After the old lock directory is replaced, the new owner's
        // filename is different, so the current rm would not hit the new lock; subsequently rmdir would also refuse to delete because the directory is not empty.
        await rm(ownerFile, { force: true });
        await rmdir(lockFile);
        return { removed: true };
      }

      const observedAt = Date.now();
      const directoryTimestamp =
        parseLockTimestamp(lockStat.mtimeMs, observedAt) ??
        observeLockInstance(lockFile, lockStat, observedAt);
      if (observedAt - directoryTimestamp < ownerlessGraceMs) {
        return { removed: false };
      }
      for (const owner of owners) {
        if (
          !(await isOwnerFileReclaimable(
            join(lockFile, owner),
            ownerlessGraceMs,
            observeLockInstance,
          ))
        ) {
          return { removed: false };
        }
      }

      // A crash after mkdir succeeds but before the owner file is persisted leaves an empty directory; a damaged directory may also
      // contain multiple owners. Only clean entries observed during stale detection; later owner additions would make rmdir fail.
      await Promise.all(entries.map((entry) => rm(join(lockFile, entry), { force: true })));
      await rmdir(lockFile);
      return { removed: true };
    }

    const raw = await readFile(lockFile, "utf-8");
    if (!(await isOwnerFileReclaimable(lockFile, ownerlessGraceMs, observeLockInstance))) {
      return { removed: false };
    }

    // Compatible with single-file locks left over from before the upgrade. The new implementation creates a non-empty directory, and the old path deletion cannot remove the new owner.
    if ((await readFile(lockFile, "utf-8")) !== raw) {
      return { removed: false };
    }
    await rm(lockFile, { force: true });
    return { removed: true };
  } catch (error) {
    if (getErrorCode(error) === "ENOENT" || getErrorCode(error) === "ENOTEMPTY") {
      return { removed: false };
    }
    return { removed: false, error };
  }
}

function createFileLockTimeoutError(
  filePath: string,
  lockFile: string,
  waitedMs: number,
  cause?: unknown,
): NodeJS.ErrnoException {
  const error = new Error(
    `Timed out after ${waitedMs}ms waiting for the ZCode file lock: ${lockFile}`,
  ) as NodeJS.ErrnoException & { cause?: unknown };
  error.code = ZCODE_FILE_LOCK_TIMEOUT_ERROR_CODE;
  error.path = filePath;
  error.syscall = "mkdir";
  error.cause = cause;
  return error;
}

export async function acquireFileLock(
  filePath: string,
  retryDelaysMs: readonly number[],
  ownerlessGraceMs: number,
  maxWaitMs: number,
): Promise<() => Promise<void>> {
  const lockFile = `${filePath}.lock`;
  const token = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const ownerFile = join(lockFile, `owner-${token}.json`);
  const payload = `${JSON.stringify({
    pid: process.pid,
    createdAt: Date.now(),
    token,
  })}\n`;
  const startedAt = Date.now();
  const effectiveOwnerlessGraceMs = Math.min(
    Math.max(ownerlessGraceMs, 0),
    Math.max(Math.floor(maxWaitMs / 2), 0),
  );
  const observeLockInstance = createLockInstanceObserver();
  let lastRemovalError: unknown;

  for (let attempt = 0; ; attempt += 1) {
    let createdLock = false;
    try {
      await mkdir(lockFile);
      createdLock = true;
      const createdLockStat = await stat(lockFile);
      await writeFile(ownerFile, payload, { encoding: "utf-8", flag: "wx" });
      const currentLockStat = await stat(lockFile);
      const currentOwners = (await readdir(lockFile)).filter(
        (entry) => entry.startsWith("owner-") && entry.endsWith(".json"),
      );
      if (
        currentLockStat.dev !== createdLockStat.dev ||
        currentLockStat.ino !== createdLockStat.ino ||
        currentOwners.length !== 1 ||
        currentOwners[0] !== `owner-${token}.json`
      ) {
        throw Object.assign(new Error("ZCode file lock ownership changed during acquire"), {
          code: "EEXIST",
        });
      }
      return async () => {
        // Only delete this writer's unique owner file; when the lock has been taken over, it will not touch the later writer's token.
        await rm(ownerFile, { force: true }).catch(() => {});
        await rmdir(lockFile).catch(() => {
          // best-effort cleanup
        });
      };
    } catch (error) {
      if (createdLock) {
        await rm(ownerFile, { force: true }).catch(() => {});
        await rmdir(lockFile).catch(() => {});
      }
      const lostCreatedLock = createdLock && getErrorCode(error) === "ENOENT";
      if (!isFileExistsError(error) && !lostCreatedLock) {
        throw error;
      }

      // How long the waiter itself has waited cannot prove the current lock is stale, otherwise after the old lock is released it might mistakenly delete
      // the later writer's new lock. Here we only reclaim locks whose owner has exited or has no PID and has exceeded a short grace period,
      // the rest compete until maxWaitMs, preserving explicit permission errors or lock timeouts.
      const elapsedMs = Date.now() - startedAt;
      if (elapsedMs >= maxWaitMs) {
        // The old order would still do a stale reclaim after reaching maxWaitMs.
        // A damaged ownerless lock might happen to cross the grace period during this check, causing a timed-out waiter to exceed
        // the waiting limit and delete the later writer's lock. After reaching the limit, timeout directly to avoid cross-instance mistaken deletion.
        const removalErrorCode = getErrorCode(lastRemovalError);
        if (removalErrorCode === "EACCES" || removalErrorCode === "EPERM") {
          throw lastRemovalError;
        }
        throw createFileLockTimeoutError(filePath, lockFile, elapsedMs, error);
      }
      const removalAttempt = await removeAbandonedLock(
        lockFile,
        effectiveOwnerlessGraceMs,
        observeLockInstance,
      );
      if (removalAttempt.removed) {
        continue;
      }
      if (removalAttempt.error) {
        lastRemovalError = removalAttempt.error;
      }

      const remainingMs = Math.max(maxWaitMs - elapsedMs, 0);
      if (retryDelaysMs.length === 0 || remainingMs === 0) {
        const removalErrorCode = getErrorCode(lastRemovalError);
        if (removalErrorCode === "EACCES" || removalErrorCode === "EPERM") {
          throw lastRemovalError;
        }
        throw createFileLockTimeoutError(filePath, lockFile, elapsedMs, lastRemovalError ?? error);
      }

      const retryDelayMs =
        retryDelaysMs[Math.min(attempt, retryDelaysMs.length - 1)] ?? remainingMs;
      await sleep(Math.min(retryDelayMs, remainingMs));
    }
  }
}
