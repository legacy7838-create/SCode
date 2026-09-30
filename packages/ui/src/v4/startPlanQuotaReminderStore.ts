import { logger } from "@/logger.js";

const PREFIX = "zcode:start-plan-reminder:v1:";
interface RecordEntry {
  expiresAt: number;
  owner: object | null;
}

/** 10% reminds the unique owner of the record; the displayed facts are persisted, and the current displayed instance only remains in memory. */
function createStartPlanQuotaReminderStore(
  options: {
    storage?: () => Storage | null;
  } = {},
) {
  const entries = new Map<string, RecordEntry>();
  const listeners = new Set<() => void>();
  let version = 0;
  function storage(): Storage | null {
    try {
      return options.storage
        ? options.storage()
        : typeof window === "undefined"
          ? null
          : window.localStorage;
    } catch {
      return null;
    }
  }
  function emit() {
    version += 1;
    for (const listener of listeners) listener();
  }
  // Fix: The device time may have exceeded the server cycle and must share the snapshot time with the candidate bucket.
  function read(key: string, referenceTime: number): RecordEntry | undefined {
    const cached = entries.get(key);
    if (cached && cached.expiresAt > referenceTime) return cached;
    entries.delete(key);
    try {
      const expiresAt = Number(storage()?.getItem(PREFIX + key));
      if (Number.isFinite(expiresAt) && expiresAt > referenceTime) {
        const entry = { expiresAt, owner: null };
        entries.set(key, entry);
        return entry;
      }
    } catch {
      /* The current Renderer's memory record can still be used when storage is corrupted or disabled. */
    }
    return undefined;
  }
  function prune(referenceTime: number) {
    for (const [key, entry] of entries) if (entry.expiresAt <= referenceTime) entries.delete(key);
    try {
      const target = storage();
      if (!target) return;
      for (let index = target.length - 1; index >= 0; index--) {
        const key = target.key(index);
        if (key?.startsWith(PREFIX) && !(Number(target.getItem(key)) > referenceTime))
          target.removeItem(key);
      }
    } catch {
      /* Failure to clean up does not affect display and memory deduplication. */
    }
  }
  return {
    isHidden(key: string, owner: object, referenceTime: number): boolean {
      const entry = read(key, referenceTime);
      return Boolean(entry && entry.owner !== owner);
    },
    markShown(key: string, expiresAt: number, owner: object, referenceTime: number): void {
      if (
        !key ||
        !Number.isFinite(expiresAt) ||
        !Number.isFinite(referenceTime) ||
        expiresAt <= referenceTime ||
        read(key, referenceTime)
      )
        return;
      prune(referenceTime);
      entries.set(key, { expiresAt, owner });
      try {
        storage()?.setItem(PREFIX + key, String(expiresAt));
      } catch {
        logger.debug("start plan reminder persistence unavailable");
      }
      logger.debug("start plan bucket reminder shown", { key });
      emit();
    },
    dismiss(key: string): void {
      // Displayed facts are not re-evaluated by the wall clock on shutdown; only the current display owner is released here.
      const entry = entries.get(key);
      if (!entry || entry.owner === null) return;
      entry.owner = null;
      logger.debug("start plan bucket reminder dismissed", { key });
      emit();
    },
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getSnapshot: () => version,
  };
}

export const startPlanQuotaReminderStore = createStartPlanQuotaReminderStore();
