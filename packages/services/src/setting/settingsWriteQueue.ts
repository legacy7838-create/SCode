const SETTINGS_WRITE_QUEUE_TIMEOUT_MS = 30_000;
const SETTINGS_WRITE_QUEUE_TIMEOUT_ENV = "ZCODE_SETTING_WRITE_QUEUE_TIMEOUT_MS";

function getSettingsWriteQueueTimeoutMs(): number {
  const rawValue = process.env[SETTINGS_WRITE_QUEUE_TIMEOUT_ENV]?.trim();
  if (!rawValue) {
    return SETTINGS_WRITE_QUEUE_TIMEOUT_MS;
  }
  const parsedValue = Number(rawValue);
  return Number.isFinite(parsedValue) && parsedValue > 0
    ? parsedValue
    : SETTINGS_WRITE_QUEUE_TIMEOUT_MS;
}

export function withSettingsWriteQueueTimeout(
  runUpdate: (enterCommitPhase: () => void) => Promise<void>,
  expireCurrentWrite: () => void,
): Promise<void> {
  const timeoutMs = getSettingsWriteQueueTimeoutMs();
  let timeoutHandle: NodeJS.Timeout | undefined;
  let commitPhaseEntered = false;

  const clearQueueTimeout = () => {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
      timeoutHandle = undefined;
    }
  };

  const enterCommitPhase = () => {
    commitPhaseEntered = true;
    clearQueueTimeout();
  };

  const timeoutPromise = new Promise<void>((_, reject) => {
    timeoutHandle = setTimeout(() => {
      if (commitPhaseEntered) {
        return;
      }
      expireCurrentWrite();
      // Set the write queue to hold the real persistence order, and the Provider layer cannot release the pending here without awaiting it.
      // Timeout is only allowed to occur in the pre-commit phase; after entering rename and submitting, you must wait for the critical section to close to avoid old writes being late and overwriting new settings.
      reject(new Error(`settingService update timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    timeoutHandle.unref?.();
  });

  return Promise.race([runUpdate(enterCommitPhase), timeoutPromise]).finally(clearQueueTimeout);
}
