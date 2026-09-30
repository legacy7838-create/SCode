import type { ChildProcess } from "node:child_process";
import type {
  ProcessIdentity,
  ProcessTreeOwnershipResolution,
  ProcessTreeTerminationResult,
  ProcessTreeTerminatorOptions,
  ProcessTreeTerminatorWaitOptions,
} from "#src/process/processTreeTypes.js";

const DEFAULT_FORCE_AFTER_MS = 2_000;
const DEFAULT_WAIT_AFTER_FORCE_MS = 250;
const DEFAULT_WINDOWS_TASKKILL_TIMEOUT_MS = 2_000;
const WINDOWS_LATE_EXIT_OBSERVATION_MS = 750;

interface WaitInternalOptions extends ProcessTreeTerminatorWaitOptions {
  knownIdentities?: readonly ProcessIdentity[];
  onForceCleanup?: (result: ForceCleanupResult) => void;
  onForceTimerScheduled?: (timer: ReturnType<typeof setTimeout>) => void;
  onGracefulCleanupScheduled?: (flight: Promise<void>) => void;
  resolvedOwnership?: ProcessTreeOwnershipResolution;
}

interface ForceCleanupResult {
  identities: ProcessIdentity[];
  unverifiedRootPid?: number;
}

type TerminateProcessTree = (child: ChildProcess, options: ProcessTreeTerminatorOptions) => void;

function warn(options: ProcessTreeTerminatorWaitOptions, message: string): void {
  options.log?.warn(options.traceId, message);
}

function debug(
  options: ProcessTreeTerminatorWaitOptions,
  message: string,
  context?: Record<string, unknown>,
): void {
  options.log?.debug?.(options.traceId, message, context);
}

function hasChildExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function waitForProcessTreeTermination(
  child: ChildProcess,
  options: ProcessTreeTerminatorWaitOptions,
  initialOwnership: ProcessTreeOwnershipResolution,
  hasWindowsTaskkillTargets: boolean,
  terminateProcessTree: TerminateProcessTree,
): Promise<ProcessTreeTerminationResult> {
  if (child.pid == null) {
    return { remainingPids: [] };
  }

  const waiterStartedAtMs = Date.now();
  const forceAfterMs = Math.max(options.forceAfterMs ?? DEFAULT_FORCE_AFTER_MS, 0);
  const waitAfterForceMs = Math.max(options.waitAfterForceMs ?? DEFAULT_WAIT_AFTER_FORCE_MS, 0);
  const isWindows = process.platform === "win32";
  const windowsTaskkillBudgetMs = hasWindowsTaskkillTargets
    ? Math.max(options.windowsTaskkillTimeoutMs ?? DEFAULT_WINDOWS_TASKKILL_TIMEOUT_MS, 1)
    : 0;
  // Windows' graceful taskkill concurrency with force timer; conservatively as long as there is a verified signal target
  // Keep a copy of the final taskkill cap. When the identity is unavailable and the target set is empty, both taskkill flights are necessary
  // If it is empty, continuing to reserve the command timeout will only cause the Host to wait in vain without being able to perform any action.
  const windowsRelativeDeadlineMs = forceAfterMs + windowsTaskkillBudgetMs + waitAfterForceMs;
  const windowsTransportDeadlineRemainingMs =
    options.windowsCleanupDeadlineAtMs === undefined
      ? windowsRelativeDeadlineMs
      : Math.max(options.windowsCleanupDeadlineAtMs - waiterStartedAtMs, 0);
  // The transport only deducts forceAfterMs when the slow CIM is exhausted. Once the 2s force window is exhausted, the waiter
  // The full taskkill + exit grace will be re-appended, causing the total cleanup to break through the Host 3.5s phase. Put here
  // The relative bounds of waiter are sandwiched within the absolute bounds of transport fixed from the cleanup starting point; deductions only come from the determined
  // Wall-clock consumption, does not rely on the instantaneous settlement state of Promise.
  // The final retry cannot obtain a verifiable identity when there is no taskkill target and the transport cannot be
  // The remaining observation budget is compressed into waitAfterForceMs (production is 250ms), and the subsequent exit with code=0
  // False positives become persistent residues. This path does not send naked PID signals and only continues to observe within the existing absolute deadline;
  // The 750ms upper limit also ensures that the combination of the new pure observation path and the first 3.25s cleanup does not exceed the 4s kill point.
  const windowsObservationDeadlineMs = Math.max(
    windowsRelativeDeadlineMs,
    WINDOWS_LATE_EXIT_OBSERVATION_MS,
  );
  const windowsCleanupDeadlineMs =
    !hasWindowsTaskkillTargets && options.windowsCleanupDeadlineAtMs !== undefined
      ? Math.min(windowsObservationDeadlineMs, windowsTransportDeadlineRemainingMs)
      : Math.min(windowsRelativeDeadlineMs, windowsTransportDeadlineRemainingMs);
  const knownIdentities = initialOwnership.knownIdentities;

  // Exiting the root child does not mean that the detached MCP has exited; wait boundaries only use live snapshots.
  // The kill callback will replace the trace set with the verified identity, disabling waiting or re-claiming the naked PID.
  return await new Promise<ProcessTreeTerminationResult>((resolve) => {
    let settled = false;
    let trackedIdentities = initialOwnership.currentIdentities;
    let unverifiedRootPid =
      initialOwnership.childStillOwned &&
      !trackedIdentities.some((identity) => identity.pid === child.pid)
        ? child.pid
        : undefined;
    let forceTimer: ReturnType<typeof setTimeout> | undefined;
    let forceWaitTimer: ReturnType<typeof setTimeout> | undefined;
    let cleanupDeadlineTimer: ReturnType<typeof setTimeout> | undefined;
    let treePollTimer: ReturnType<typeof setInterval> | undefined;

    const cleanup = () => {
      child.off?.("exit", onExit);
      if (forceTimer) clearTimeout(forceTimer);
      if (forceWaitTimer) clearTimeout(forceWaitTimer);
      if (cleanupDeadlineTimer) clearTimeout(cleanupDeadlineTimer);
      if (treePollTimer) clearInterval(treePollTimer);
      forceTimer = undefined;
      forceWaitTimer = undefined;
      cleanupDeadlineTimer = undefined;
      treePollTimer = undefined;
    };
    const settle = (remainingPids: number[] = []) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({ remainingPids });
    };
    const settleIfTreeExited = () => {
      const hasRunningVerifiedProcess = trackedIdentities.some((identity) =>
        isPidAlive(identity.pid),
      );
      const hasRunningUnverifiedRoot =
        unverifiedRootPid !== undefined && !hasChildExited(child) && isPidAlive(unverifiedRootPid);
      if (!hasRunningVerifiedProcess && !hasRunningUnverifiedRoot) {
        // The Windows taskkill callback may precede the Node ChildProcess exit event.
        // When the OS no longer has a PID, continue to wait for a round of exit delivery to avoid transport/lifecycle cleaning up Promise
        // The old state will still be seen after returning; if the exit is lost, the absolute deadline will still be successfully closed according to the OS fact.
        if (isWindows && !hasChildExited(child)) return;
        settle();
      }
    };
    const startTreePolling = () => {
      if (!treePollTimer && !settled) {
        treePollTimer = setInterval(settleIfTreeExited, 25);
      }
    };
    const collectRemainingPids = (): number[] => {
      const remainingPids = trackedIdentities
        .filter((identity) => isPidAlive(identity.pid))
        .map((identity) => identity.pid);
      if (
        unverifiedRootPid !== undefined &&
        !hasChildExited(child) &&
        isPidAlive(unverifiedRootPid)
      ) {
        remainingPids.push(unverifiedRootPid);
      }
      return remainingPids;
    };
    const onExit = () => {
      unverifiedRootPid = undefined;
      // Synchronously refreshing the CIM process table in the Windows exit callback will block the Host deadline again.
      // Here we only observe whether the fixed identity PID is still alive; the creation of the identity will still be reviewed before actually sending force.
      settleIfTreeExited();
      if (!settled) startTreePolling();
    };
    const scheduleForceWait = () => {
      if (forceWaitTimer || settled) return;
      if (waitAfterForceMs === 0) {
        settle(collectRemainingPids());
        return;
      }
      forceWaitTimer = setTimeout(() => {
        const remainingPids = collectRemainingPids();
        if (remainingPids.length > 0) {
          warn(
            options,
            `runtime process tree still has leftovers after forced cleanup pid=${remainingPids.join(",")}`,
          );
        }
        settle(remainingPids);
      }, waitAfterForceMs);
    };
    const scheduleWindowsCleanupDeadline = () => {
      if (!isWindows || cleanupDeadlineTimer || settled) return;
      debug(options, "Windows runtime process tree cleanup deadline scheduled", {
        forceAfterMs,
        hasWindowsTaskkillTargets,
        waitAfterForceMs,
        windowsRelativeDeadlineMs,
        windowsTaskkillBudgetMs,
        windowsCleanupDeadlineMs,
        windowsCleanupDeadlineAtMs: options.windowsCleanupDeadlineAtMs,
      });
      cleanupDeadlineTimer = setTimeout(() => {
        const remainingPids = collectRemainingPids();
        if (remainingPids.length > 0) {
          warn(
            options,
            `runtime process tree still has leftovers after the absolute deadline pid=${remainingPids.join(",")}`,
          );
        }
        settle(remainingPids);
      }, windowsCleanupDeadlineMs);
    };
    const onForceCleanup = (result: ForceCleanupResult) => {
      debug(options, "Windows runtime process tree force cleanup completed", {
        trackedPids: result.identities.map((identity) => identity.pid),
        unverifiedRootPid: result.unverifiedRootPid,
      });
      // This must be replaced rather than merged: the old snapshot identity may have expired, and continuing to retain it will destroy the new process.
      // Mistaken as residue and causing subsequent waits/logs to lose process ownership semantics.
      trackedIdentities = result.identities;
      unverifiedRootPid = result.unverifiedRootPid;
      settleIfTreeExited();
      if (!settled) {
        startTreePolling();
        if (!isWindows) scheduleForceWait();
      }
    };

    child.once("exit", onExit);
    const waitOptions: WaitInternalOptions = {
      ...options,
      forceAfterMs,
      keepForceTimerRef: true,
      knownIdentities,
      resolvedOwnership: initialOwnership,
      onForceCleanup,
      onForceTimerScheduled: (timer) => {
        forceTimer = timer;
      },
      onGracefulCleanupScheduled: (flight) => {
        // The runner itself has timeout and runWindowsTaskkill will normalize rejection; regardless of the command result,
        // After the flight settles, the OS/ChildProcess fact is re-observed, and the final failure is still determined by the absolute deadline.
        void flight.then(() => {
          debug(options, "Windows runtime process tree graceful cleanup flight settled");
          settleIfTreeExited();
          if (!settled) startTreePolling();
        });
      },
    };
    scheduleWindowsCleanupDeadline();
    terminateProcessTree(child, waitOptions);

    settleIfTreeExited();
    if (!settled && hasChildExited(child)) {
      startTreePolling();
    }
  });
}
