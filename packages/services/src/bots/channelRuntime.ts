import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { BotConfig, BotProviderCallbackResult, BotRuntimeInfo } from "@zcode/shared";
import { getAppConfigDir } from "../paths.js";

export const BOT_RUNTIME_LOCK_RETRY_MS = 10_000;
export const BOT_RUNTIME_LOCK_LEASE_MS = 30_000;
const BOT_RUNTIME_LOCK_HEARTBEAT_MS = 10_000;
const BOT_RUNTIME_LOCK_CLEANUP_RETRY_DELAYS_MS = [100, 250, 500] as const;

export interface BotRuntimeLogger {
  debug(traceId: string | undefined, message: string): void;
  info(traceId: string | undefined, message: string): void;
  warn(traceId: string | undefined, message: string): void;
}

export interface BotRuntimeStatusSink {
  getRuntimeStatus(botId: string): BotRuntimeInfo | undefined;
  setRuntimeStatus(status: BotRuntimeInfo): void;
}

export function createBotConnectionFingerprint(parts: readonly string[]): string {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

export function assertBotCallbackSucceeded(
  provider: string,
  result: BotProviderCallbackResult,
): void {
  if (result.ok) {
    return;
  }
  // Bugfix: provider callback uses return value to express recoverable business failure and does not necessarily reject.
  // The external consumption cursor can only be submitted after ok=true, otherwise the instantaneous failure will be incorrectly acknowledged and the message will be lost permanently.
  throw new Error(`${provider} callback failed: status=${result.status ?? "unknown"}`);
}

export function createLatestRuntimeRefreshQueue() {
  let generation = 0;
  let queue: Promise<void> = Promise.resolve();

  return {
    enqueue(reconcile: (isLatest: () => boolean) => Promise<void>): Promise<void> {
      const currentGeneration = ++generation;
      const result = queue
        .catch(() => undefined)
        .then(() => reconcile(() => currentGeneration === generation));
      // Bugfix: Configuration saving will trigger fire-and-forget refresh continuously. The serial queue has to wait for the next round
      // The connection is released in the previous round, but the latest subsequent configuration cannot be permanently blocked due to the failure of the previous round.
      queue = result.catch(() => undefined);
      return result;
    },
    invalidate(): void {
      generation += 1;
    },
  };
}

interface BotRuntimeLockOwner {
  pid: number;
  botId: string;
  nonce: string;
  createdAt: number;
}

interface BotRuntimeLock {
  release(): Promise<void>;
}
function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

export function isBotRuntimeLockConflictError(error: unknown): boolean {
  return (
    isNodeError(error) &&
    (error.code === "EEXIST" ||
      error.code === "ENOTEMPTY" ||
      error.code === "EISDIR" ||
      error.code === "EPERM")
  );
}

function isBotRuntimeLockCleanupRetryable(error: unknown): boolean {
  return (
    isNodeError(error) &&
    (error.code === "EPERM" ||
      error.code === "EBUSY" ||
      error.code === "ENOTEMPTY")
  );
}

async function removeBotRuntimeLockPath(lockPath: string): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rm(lockPath, { recursive: true, force: true });
      return;
    } catch (error) {
      const delay = BOT_RUNTIME_LOCK_CLEANUP_RETRY_DELAYS_MS[attempt];
      if (!isBotRuntimeLockCleanupRetryable(error) || delay === undefined) {
        throw error;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, delay));
    }
  }
}

function getBotRuntimeLockPath(namespace: string, lockKey: string): string {
  const lockHash = createHash("sha256").update(lockKey.trim()).digest("hex");
  return join(getAppConfigDir(), "bots-runtime-locks", namespace, `${lockHash}.lock`);
}

async function readBotRuntimeLockOwner(lockPath: string): Promise<BotRuntimeLockOwner | null> {
  try {
    const raw = JSON.parse(
      await readFile(join(lockPath, "owner.json"), "utf-8"),
    ) as Partial<BotRuntimeLockOwner>;
    return typeof raw.pid === "number" &&
      typeof raw.botId === "string" &&
      typeof raw.nonce === "string"
      ? {
          pid: raw.pid,
          botId: raw.botId,
          nonce: raw.nonce,
          createdAt: typeof raw.createdAt === "number" ? raw.createdAt : 0,
        }
      : null;
  } catch {
    return null;
  }
}

async function readBotRuntimeLockLeaseAt(lockPath: string, nonce: string): Promise<number> {
  try {
    return (await stat(join(lockPath, `lease-${nonce}`))).mtimeMs;
  } catch {
    return 0;
  }
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return isNodeError(error) && error.code === "EPERM";
  }
}

async function acquireBotRuntimeLock(
  namespace: string,
  lockKey: string,
  botId: string,
): Promise<BotRuntimeLock | null> {
  const lockPath = getBotRuntimeLockPath(namespace, lockKey);
  const owner: BotRuntimeLockOwner = {
    pid: process.pid,
    botId,
    nonce: randomBytes(8).toString("hex"),
    createdAt: Date.now(),
  };
  const leasePath = join(lockPath, `lease-${owner.nonce}`);
  await mkdir(dirname(lockPath), {
    recursive: true,
  });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const pendingLockPath = `${lockPath}.${owner.nonce}.pending`;
    try {
      // Bugfix: The lock directory and owner file must be visible to the outside world as a complete state.
      // First write the owner in the only temporary directory, and then perform atomic rename to prevent competitors from misjudging the uninitialized lock as stale.
      await mkdir(pendingLockPath);
      await writeFile(join(pendingLockPath, "owner.json"), `${JSON.stringify(owner)}\n`);
      await writeFile(join(pendingLockPath, `lease-${owner.nonce}`), "");
      try {
        await rename(pendingLockPath, lockPath);
      } catch (error) {
        // Bugfix: Windows returns EPERM when renaming a temporary lock directory to an existing lock directory; here only rename conflicts are regarded as lock competition.
        // Avoid misjudgment of the permission of mkdir/writeFile as a takeover lock.
        if (!isBotRuntimeLockConflictError(error)) {
          throw error;
        }
        // EPERM could also simply be a directory permission error; the conflicting takeover branch is entered only if the official lock path does exist.
        if (!(await stat(lockPath).catch(() => undefined))) {
          throw error;
        }
        const currentOwner = await readBotRuntimeLockOwner(lockPath);
        if (currentOwner) {
          const leaseAt = await readBotRuntimeLockLeaseAt(
            lockPath,
            currentOwner.nonce,
          );
          const leaseAge = Date.now() - leaseAt;
          if (
            isProcessAlive(currentOwner.pid) &&
            leaseAt > 0 &&
            leaseAge < BOT_RUNTIME_LOCK_LEASE_MS
          ) {
            return null;
          }
        }
        // Bugfix: Stale directories may be temporarily occupied by Windows file handles; give up after a limited retry to avoid silent residue.
        await removeBotRuntimeLockPath(lockPath);
        continue;
      }
      let heartbeatWriting = false;
      const heartbeat = setInterval(() => {
        if (heartbeatWriting) return;
        heartbeatWriting = true;
        const now = new Date();
        void utimes(leasePath, now, now)
          .catch(() => undefined)
          .finally(() => {
            heartbeatWriting = false;
          });
      }, BOT_RUNTIME_LOCK_HEARTBEAT_MS);
      heartbeat.unref();
      return {
        async release() {
          clearInterval(heartbeat);
          const currentOwner = await readBotRuntimeLockOwner(lockPath);
          if (
            currentOwner?.pid === owner.pid &&
            currentOwner.botId === owner.botId &&
            currentOwner.nonce === owner.nonce
          ) {
            await removeBotRuntimeLockPath(lockPath);
          }
        },
      };
    } finally {
      await removeBotRuntimeLockPath(pendingLockPath);
    }
  }
  return null;
}

export async function acquireTelegramPollingLock(
  token: string,
  botId: string,
): Promise<BotRuntimeLock | null> {
  return acquireBotRuntimeLock("telegram-polling", token, botId);
}

export async function acquireWeixinPollingLock(
  token: string,
  botId: string,
): Promise<BotRuntimeLock | null> {
  return acquireBotRuntimeLock("weixin-polling", token, botId);
}

export function acquireFeishuWebSocketLock(
  bot: Pick<BotConfig, "id" | "provider" | "feishuAppId">,
): Promise<BotRuntimeLock | null> {
  return acquireBotRuntimeLock(`${bot.provider}-websocket`, bot.feishuAppId?.trim() ?? "", bot.id);
}

export function waitFor(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    let settled = false;
    const cleanup = () => {
      clearTimeout(timeout);
      signal.removeEventListener("abort", onAbort);
    };
    const finish = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    };
    const onAbort = () => finish();
    const timeout = setTimeout(finish, ms);
    // Bugfix: The runtime will reuse the same signal for a long time; the listener must be removed each time the wait is completed to avoid continuous accumulation during retries.
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export async function waitForAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return;
  }
  await new Promise<void>((resolve) => {
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}
