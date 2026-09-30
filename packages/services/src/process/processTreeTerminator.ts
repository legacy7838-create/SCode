/* eslint-disable max-lines -- Windows process tree cleanup needs its cross-stage safety boundaries and deadline maintained in one place. */
import type { ChildProcess } from "node:child_process";
import {
  captureProcessGroupSnapshot,
  captureExitedRootDescendantsSnapshot,
} from "#src/process/processTreeSnapshot.js";
import {
  captureExitedRootDescendantsSnapshotAsync,
  captureProcessTreeSnapshotAsync,
  verifyWindowsProcessIdentityAsync,
} from "#src/process/processTreeSnapshotAsync.js";
import {
  resolveCurrentOwnedIdentities,
  resolveCurrentOwnedIdentitiesAsync,
} from "#src/process/processTreeOwnership.js";
import { waitForProcessTreeTermination } from "#src/process/processTreeWaiter.js";
import { defaultWindowsTaskkillRunner } from "#src/process/windowsTaskkillRunner.js";
import type {
  ProcessIdentity,
  ProcessTreeOwnershipResolution,
  ProcessTreeTerminationResult,
  ProcessTreeTerminatorOptions,
  ProcessTreeTerminatorWaitOptions,
} from "#src/process/processTreeTypes.js";

export {
  captureProcessGroupSnapshot,
  captureExitedRootDescendantsSnapshot,
  captureProcessTreeSnapshot,
} from "#src/process/processTreeSnapshot.js";
export {
  captureExitedRootDescendantsSnapshotAsync,
  captureProcessTreeSnapshotAsync,
  filterCurrentProcessIdentitiesAsync,
} from "#src/process/processTreeSnapshotAsync.js";
export type {
  ProcessIdentity,
  ProcessTreeSnapshot,
  ProcessTreeTerminationResult,
  ProcessTreeTerminatorLogger,
  ProcessTreeTerminatorOptions,
  ProcessTreeTerminatorWaitOptions,
  WindowsTaskkillRequest,
  WindowsTaskkillResult,
  WindowsTaskkillRunner,
} from "#src/process/processTreeTypes.js";

const POSIX_TERMINATION_SIGNAL = "SIGTERM";
const POSIX_FORCE_SIGNAL = "SIGKILL";
const WINDOWS_TASKKILL_TIMEOUT_MS = 2_000;
const WINDOWS_FORCE_IDENTITY_RECHECK_BUDGET_MS = 750;
const DEFAULT_FORCE_AFTER_MS = 2_000;

interface InternalProcessTreeTerminatorOptions extends ProcessTreeTerminatorOptions {
  knownIdentities?: readonly ProcessIdentity[];
  onForceCleanup?: (result: ForceCleanupResult) => void;
  onForceTimerScheduled?: (timer: ReturnType<typeof setTimeout>) => void;
  onGracefulCleanupScheduled?: (flight: Promise<void>) => void;
  resolvedOwnership?: ProcessTreeOwnershipResolution;
  /** Process identity lookup failed; only the original ChildProcess is observed and sending taskkill to a bare PID is forbidden. */
  unverifiedRootOnly?: boolean;
}

interface ForceCleanupResult {
  identities: ProcessIdentity[];
  unverifiedRootPid?: number;
}

export function shouldSpawnInDetachedProcessGroup(): boolean {
  return process.platform !== "win32";
}

function warn(options: ProcessTreeTerminatorOptions, message: string, ...args: unknown[]): void {
  options.log?.warn(options.traceId, message, ...args);
}

function debug(options: ProcessTreeTerminatorOptions, message: string, ...args: unknown[]): void {
  options.log?.debug?.(options.traceId, message, ...args);
}

function getErrorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

function isMissingProcessError(error: unknown): boolean {
  return getErrorCode(error) === "ESRCH";
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function scheduleForceCleanup(
  callback: () => void,
  timeoutMs: number,
  keepTimerRef: boolean,
): ReturnType<typeof setTimeout> {
  const timer = setTimeout(callback, Math.max(timeoutMs, 0));
  if (!keepTimerRef) {
    timer.unref();
  }
  return timer;
}

function killPid(
  pid: number,
  signal: NodeJS.Signals,
  options: ProcessTreeTerminatorOptions,
): boolean {
  try {
    process.kill(pid, signal);
    return true;
  } catch (error) {
    if (!isMissingProcessError(error)) {
      warn(
        options,
        `failed to send runtime process termination signal pid=${pid} signal=${signal}:`,
        error,
      );
    }
    return false;
  }
}

function killPosixProcessGroup(
  pid: number,
  signal: NodeJS.Signals,
  options: ProcessTreeTerminatorOptions,
): boolean {
  try {
    process.kill(-pid, signal);
    return true;
  } catch (error) {
    if (!isMissingProcessError(error)) {
      warn(
        options,
        `failed to send runtime process group termination signal pgid=${pid} signal=${signal}:`,
        error,
      );
    }
    return false;
  }
}

async function runWindowsTaskkill(
  pid: number,
  force: boolean,
  options: ProcessTreeTerminatorOptions,
): Promise<void> {
  const timeoutMs = Math.max(options.windowsTaskkillTimeoutMs ?? WINDOWS_TASKKILL_TIMEOUT_MS, 1);
  const runner = options.windowsTaskkillRunner ?? defaultWindowsTaskkillRunner;
  const startedAt = Date.now();
  debug(options, "Windows runtime process tree taskkill started", { force, pid, timeoutMs });
  let result;
  try {
    result = await runner({ force, pid, timeoutMs });
  } catch (error) {
    result = { error };
  }
  debug(options, "Windows runtime process tree taskkill completed", {
    durationMs: Date.now() - startedAt,
    force,
    pid,
    success: !result.error,
  });
  if (result.error && isPidAlive(pid)) {
    warn(
      options,
      `${force ? "forced cleanup" : "requested"} runtime process tree exit failed pid=${pid} status=${String(
        typeof result.error === "object" && result.error !== null && "code" in result.error
          ? ((result.error as { code?: unknown }).code ?? "unknown")
          : "unknown",
      )}:`,
      result.error,
      result.stderr,
    );
  }
}

async function forceTerminateWindowsProcessTree(
  child: ChildProcess,
  knownIdentities: readonly ProcessIdentity[],
  options: ProcessTreeTerminatorOptions,
  verifiedOwnership?: ProcessTreeOwnershipResolution,
  deadlineSnapshotOnly = false,
  deadlineVerifiedIdentities: readonly ProcessIdentity[] = [],
): Promise<ForceCleanupResult> {
  const { childStillOwned, currentIdentities } =
    verifiedOwnership ??
    (await resolveCurrentOwnedIdentitiesAsync(child, knownIdentities, options, false));
  // Neither the old snapshot nor the lagging Node exitCode can prove that the PID still belongs to the original process tree at the deadline.
  // The deadline path only allows root/descendants whose CreationDate has been rechecked within the reservation window; the query fails
  // The old identity will continue to be handed over to the waiter to report the residue, but will never be used as a /F target to avoid accidental killing by PID reuse.
  const targets = new Set(
    deadlineSnapshotOnly
      ? deadlineVerifiedIdentities.map((identity) => identity.pid)
      : currentIdentities.map((identity) => identity.pid),
  );
  const unverifiedRootOnly = (options as InternalProcessTreeTerminatorOptions).unverifiedRootOnly;
  if (childStillOwned && child.pid != null && !unverifiedRootOnly && !deadlineSnapshotOnly) {
    targets.add(child.pid);
  }
  // Directed CIM review timeouts should not leave root still held by the ChildProcess handle permanently.
  // After the handle confirms that the root is still alive, taskkill /T will only target the root and will not claim a new PID based on the expired snapshot.
  if (
    deadlineSnapshotOnly &&
    !unverifiedRootOnly &&
    child.pid != null &&
    typeof child.kill === "function" &&
    child.exitCode === null &&
    child.signalCode === null &&
    isPidAlive(child.pid)
  ) {
    targets.add(child.pid);
  }
  await Promise.all([...targets].map((targetPid) => runWindowsTaskkill(targetPid, true, options)));
  const hasVerifiedRoot = currentIdentities.some((identity) => identity.pid === child.pid);
  return {
    identities: currentIdentities,
    ...(childStillOwned && !hasVerifiedRoot ? { unverifiedRootPid: child.pid } : {}),
  };
}

function terminateWindowsProcessTreeWithOwnership(
  child: ChildProcess,
  options: ProcessTreeTerminatorOptions,
  ownership: ProcessTreeOwnershipResolution,
  startedAtMs: number,
): void {
  const pid = child.pid!;
  const internalOptions = options as InternalProcessTreeTerminatorOptions;
  const childHandleOwnsLiveRoot =
    !internalOptions.unverifiedRootOnly &&
    typeof child.kill === "function" &&
    child.exitCode === null &&
    child.signalCode === null &&
    isPidAlive(pid);
  const gracefulTargets =
    ownership.childStillOwned && !internalOptions.unverifiedRootOnly
      ? [pid]
      : ownership.currentIdentities.map((identity) => identity.pid);
  // CIM queries may exceed a cleanup deadline under high system load, but still survive
  // The ChildProcess handle can prove that root belongs to the current Host. At this time, you are allowed to use root /T as a safety net.
  // Only expands to the live process corresponding to the handle, without rediscovering or claiming the process tree along the naked PID.
  if (gracefulTargets.length === 0 && childHandleOwnsLiveRoot) gracefulTargets.push(pid);
  const gracefulFlight = Promise.all(
    [...new Set(gracefulTargets)].map((targetPid) => runWindowsTaskkill(targetPid, false, options)),
  ).then(() => undefined);
  // Waiting for cleanup, just wait for the force window after graceful taskkill fire-and-forget.
  // When the taskkill callback/ChildProcess exit arrives later, the normal exit will be mistakenly reported as the remaining PID.
  // Non-awaited calls still do not await; awaited waiters include the same flight into the completion barrier through callbacks.
  internalOptions.onGracefulCleanupScheduled?.(gracefulFlight);
  void gracefulFlight;
  const forceDelayMs = Math.max(
    (options.forceAfterMs ?? DEFAULT_FORCE_AFTER_MS) - (Date.now() - startedAtMs),
    0,
  );
  const identitiesToRecheck = ownership.currentIdentities.filter(
    (identity) => !internalOptions.unverifiedRootOnly || identity.pid !== pid,
  );
  const canRecheckIdentitiesWithinDeadline =
    identitiesToRecheck.length > 0 && forceDelayMs >= WINDOWS_FORCE_IDENTITY_RECHECK_BUDGET_MS;
  const forceTimer = scheduleForceCleanup(
    () => {
      // Non-waiting shutdown does not inject observation callbacks; forced recycling must be executed independently first.
      // It cannot be used as a parameter of optional call, otherwise the parameter will not be evaluated when the callback is missing.
      void (async () => {
        // Directed review and killing root is not enough: when graceful /T fails or the descendant has
        // When reparented, MCP/runtime descendants are known to never have force flight. This is reserved before force
        // Concurrently review all known identities within the same budget, without increasing the total deadline; each PID has only CreationDate
        // Enter /F only when there is still a match this time. If the query fails, continue fail-closed.
        const deadlineVerifiedIdentities = canRecheckIdentitiesWithinDeadline
          ? (
              await Promise.all(
                identitiesToRecheck.map(async (identity) =>
                  (await verifyWindowsProcessIdentityAsync(
                    identity,
                    WINDOWS_FORCE_IDENTITY_RECHECK_BUDGET_MS,
                    options,
                  ))
                    ? identity
                    : undefined,
                ),
              )
            ).filter((identity): identity is ProcessIdentity => identity !== undefined)
          : [];
        return await forceTerminateWindowsProcessTree(
          child,
          ownership.knownIdentities,
          options,
          ownership,
          true,
          deadlineVerifiedIdentities,
        );
      })().then((result) => internalOptions.onForceCleanup?.(result));
    },
    canRecheckIdentitiesWithinDeadline
      ? forceDelayMs - WINDOWS_FORCE_IDENTITY_RECHECK_BUDGET_MS
      : forceDelayMs,
    Boolean(options.keepForceTimerRef),
  );
  internalOptions.onForceTimerScheduled?.(forceTimer);
}

function terminateWindowsProcessTree(
  child: ChildProcess,
  options: ProcessTreeTerminatorOptions,
): void {
  const internalOptions = options as InternalProcessTreeTerminatorOptions;
  const startedAtMs = Date.now();
  if (internalOptions.resolvedOwnership) {
    terminateWindowsProcessTreeWithOwnership(
      child,
      options,
      internalOptions.resolvedOwnership,
      startedAtMs,
    );
    return;
  }
  void resolveCurrentOwnedIdentitiesAsync(
    child,
    internalOptions.knownIdentities ?? [],
    options,
  ).then((ownership) => {
    terminateWindowsProcessTreeWithOwnership(child, options, ownership, startedAtMs);
  });
}

function forceTerminatePosixProcessTree(
  child: ChildProcess,
  knownIdentities: readonly ProcessIdentity[],
  options: ProcessTreeTerminatorOptions,
): ForceCleanupResult {
  const pid = child.pid!;
  const { childStillOwned, currentIdentities } = resolveCurrentOwnedIdentities(
    child,
    knownIdentities,
    options,
    false,
  );
  const canSignalOwnedGroup =
    childStillOwned || currentIdentities.some((identity) => identity.processGroupId === pid);
  if (canSignalOwnedGroup) {
    killPosixProcessGroup(pid, POSIX_FORCE_SIGNAL, options);
  }
  for (const identity of currentIdentities.toReversed()) {
    if (identity.pid !== pid) {
      killPid(identity.pid, POSIX_FORCE_SIGNAL, options);
    }
  }
  if (!canSignalOwnedGroup) {
    const rootIdentity = currentIdentities.find((identity) => identity.pid === pid);
    if (rootIdentity) {
      killPid(rootIdentity.pid, POSIX_FORCE_SIGNAL, options);
    }
  }
  const hasVerifiedRoot = currentIdentities.some((identity) => identity.pid === pid);
  return {
    identities: currentIdentities,
    ...(childStillOwned && !hasVerifiedRoot ? { unverifiedRootPid: pid } : {}),
  };
}

function terminatePosixProcessTree(
  child: ChildProcess,
  options: ProcessTreeTerminatorOptions,
): void {
  const pid = child.pid!;
  const internalOptions = options as InternalProcessTreeTerminatorOptions;
  const ownership =
    internalOptions.resolvedOwnership ??
    resolveCurrentOwnedIdentities(child, internalOptions.knownIdentities ?? [], options);
  const canSignalOwnedGroup =
    ownership.childStillOwned ||
    ownership.currentIdentities.some((identity) => identity.processGroupId === pid);
  const signaledProcessGroup = canSignalOwnedGroup
    ? killPosixProcessGroup(pid, POSIX_TERMINATION_SIGNAL, options)
    : false;

  // detached runtime/MCP descendants are not in the root process group; only creation IDs still match
  // The lifetime snapshot member sends a signal to prevent delayed recycling from accidentally killing the reused process with the same PID as an old descendant.
  for (const identity of ownership.currentIdentities) {
    if (identity.pid !== pid) {
      killPid(identity.pid, POSIX_TERMINATION_SIGNAL, options);
    }
  }
  if (!signaledProcessGroup && ownership.childStillOwned) {
    killPid(pid, POSIX_TERMINATION_SIGNAL, options);
  }

  const forceTimer = scheduleForceCleanup(
    () => {
      // Non-waiting shutdown does not inject observation callbacks; forced recycling must be executed independently first.
      // It cannot be used as a parameter of optional call, otherwise the parameter will not be evaluated when the callback is missing.
      const result = forceTerminatePosixProcessTree(child, ownership.knownIdentities, options);
      internalOptions.onForceCleanup?.(result);
    },
    options.forceAfterMs ?? DEFAULT_FORCE_AFTER_MS,
    Boolean(options.keepForceTimerRef),
  );
  internalOptions.onForceTimerScheduled?.(forceTimer);
}

export function terminateProcessTree(
  child: ChildProcess,
  options: ProcessTreeTerminatorOptions = {},
): void {
  if (child.pid == null) {
    // Test doubles or very early spawn failure scenarios may not get pid.
    // At this time, it is not possible to drill down by process group/process tree, but the old child.kill() shutdown semantics are still retained.
    try {
      child.kill(POSIX_TERMINATION_SIGNAL);
    } catch (error) {
      warn(options, "failed to send runtime process termination signal pid=unknown:", error);
    }
    return;
  }

  if (process.platform === "win32") {
    terminateWindowsProcessTree(child, options);
    return;
  }
  terminatePosixProcessTree(child, options);
}

export async function terminateProcessTreeAndWait(
  child: ChildProcess,
  options: ProcessTreeTerminatorWaitOptions = {},
): Promise<ProcessTreeTerminationResult> {
  if (child.pid == null) return { remainingPids: [] };
  const cleanupSnapshot =
    options.snapshot?.rootPid === child.pid
      ? options.snapshot
      : options.ownedProcessGroupId === child.pid
        ? captureProcessGroupSnapshot(options.ownedProcessGroupId, options)
        : process.platform === "win32"
          ? await captureExitedRootDescendantsSnapshotAsync(child.pid, options)
          : captureExitedRootDescendantsSnapshot(child.pid, options);
  const snapshotIdentities = cleanupSnapshot?.identities ?? [];
  const identityVerificationUnavailable = cleanupSnapshot?.identityVerification === "unavailable";
  // The asynchronous snapshot just taken has fixed the Windows creation flag to avoid repeating it immediately before EOF.
  // Costly CIM queries. In the force phase, the identity will still be checked asynchronously to prevent accidental killing due to PID reuse.
  const initialOwnership =
    process.platform === "win32" &&
    cleanupSnapshot &&
    child.exitCode === null &&
    child.signalCode === null
      ? {
          // Query failure does not mean that the process does not exist. Leave unauthenticated root and let waiter run the entire
          // Observes ChildProcess within a bounded budget and reports failure via remainingPids if still alive.
          childStillOwned:
            identityVerificationUnavailable ||
            snapshotIdentities.some((identity) => identity.pid === child.pid),
          currentIdentities: [...snapshotIdentities],
          knownIdentities: [...snapshotIdentities],
        }
      : await resolveCurrentOwnedIdentitiesAsync(child, snapshotIdentities, options);
  return await waitForProcessTreeTermination(
    child,
    identityVerificationUnavailable
      ? ({ ...options, unverifiedRootOnly: true } as ProcessTreeTerminatorWaitOptions)
      : options,
    initialOwnership,
    // graceful/force of terminator when identity query fails and there is no verified identity
    // targets are all empty. Command timeouts are reserved for taskkill flight only if there is a real signal target; otherwise
    // The case maintains full budget, prohibiting aggressive shortening of the bounds by the Promise's instantaneous settle state.
    initialOwnership.currentIdentities.length > 0 ||
      (!identityVerificationUnavailable && initialOwnership.childStillOwned),
    terminateProcessTree,
  );
}
