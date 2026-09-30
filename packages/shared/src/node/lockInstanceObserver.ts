import type { Stats } from "node:fs";

export type ObserveLockInstance = (lockPath: string, lockStat: Stats, observedAt: number) => number;

export function createLockInstanceObserver(): ObserveLockInstance {
  const observations = new Map<string, { firstObservedAt: number; identity: string }>();

  return (lockPath, lockStat, observedAt) => {
    const identity = [lockStat.dev, lockStat.ino, lockStat.birthtimeMs, lockStat.mtimeMs].join(":");
    const previous = observations.get(lockPath);
    if (previous?.identity === identity) {
      return previous.firstObservedAt;
    }

    // Double illegal timestamps can only start counting grace from when the current lock instance is first seen.
    // After the lock is replaced by a later writer, it must be reset and cannot inherit the waiter's waiting time on the old lock.
    observations.set(lockPath, { firstObservedAt: observedAt, identity });
    return observedAt;
  };
}
