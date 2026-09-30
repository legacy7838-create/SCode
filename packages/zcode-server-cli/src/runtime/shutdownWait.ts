import { DataRootLock } from "./lock.js";
import type { ServerLayout } from "./paths.js";
import { readPersistedStatusDetailed } from "./statusSnapshot.js";
import { describeLockInspection } from "./uninstallGuard.js";

export async function waitForServerStopped(
  layout: ServerLayout,
  minUpdatedAt = 0,
  requireFreshSnapshot = false,
): Promise<void> {
  const deadline = Date.now() + 6_000;
  while (Date.now() < deadline) {
    const persisted = await readPersistedStatusDetailed(layout);
    if (persisted.state === "invalid" || persisted.state === "unreadable") {
      throw new Error("Cannot verify Server shutdown status");
    }
    const lockInspection = await new DataRootLock(layout.lockFile).inspect();
    if (lockInspection.state === "invalid" || lockInspection.state === "unreadable") {
      throw new Error(`Cannot verify Server shutdown (${describeLockInspection(lockInspection)})`);
    }
    const lockReleased = lockInspection.state === "missing" || lockInspection.state === "stale";
    const stopped =
      persisted.status?.state === "stopped" || persisted.status?.state === "uninstalled";
    const freshSnapshot = persisted.status !== null && persisted.status.updatedAt > minUpdatedAt;
    // The stopped disk was released earlier than lock.release, and the stale stopped snapshot cannot be used as a basis for immediate registration of new services.
    // The migration must confirm both the new snapshot and the lock being released; only an offline uninstall without any snapshots is allowed to continue with the missing lock alone.
    if (
      lockReleased &&
      ((stopped && (!requireFreshSnapshot || freshSnapshot)) ||
        (!requireFreshSnapshot && persisted.state === "missing"))
    )
      return;
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for Server shutdown (${layout.statusFile})`);
}
