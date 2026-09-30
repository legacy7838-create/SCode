import type { TraceId } from "@zcode/shared";

export interface ProcessTreeTerminatorLogger {
  debug?: (traceId: TraceId | undefined, ...args: unknown[]) => void;
  warn: (traceId: TraceId | undefined, ...args: unknown[]) => void;
}

export interface WindowsTaskkillRequest {
  force: boolean;
  pid: number;
  timeoutMs: number;
}

export interface WindowsTaskkillResult {
  error?: unknown;
  stderr?: string;
}

export type WindowsTaskkillRunner = (
  request: WindowsTaskkillRequest,
) => Promise<WindowsTaskkillResult>;

export interface ProcessTreeTerminatorOptions {
  traceId?: TraceId;
  log?: ProcessTreeTerminatorLogger;
  forceAfterMs?: number;
  keepForceTimerRef?: boolean;
  /** Independent process group owned by POSIX Host when spawn(detached=true); used only in cleanup boundaries. */
  ownedProcessGroupId?: number;
  /** The time when Windows Host initiates spawn; together with the exit time, it constrains the ownership of descendants after root exits. */
  ownedProcessStartedAtMs?: number;
  /** The time Windows root was observed exiting; new descendants created by the reused PID thereafter are prohibited from claiming. */
  ownedProcessExitedAtMs?: number;
  /** Reads the real exit event time of the managed ChildProcess when the asynchronous query completes. */
  resolveOwnedProcessExitedAtMs?: () => number | undefined;
  /** Windows taskkill dependency injection; production still uses asynchronous execFile by default, deterministic timing testing can be replaced. */
  windowsTaskkillRunner?: WindowsTaskkillRunner;
  /** Windows taskkill single command budget; default 2 seconds, test can be shortened. */
  windowsTaskkillTimeoutMs?: number;
  /** Windows cleanup full link absolute deadline (Unix epoch ms); covers snapshot, EOF, taskkill and exit observations. */
  windowsCleanupDeadlineAtMs?: number;
}

export interface ProcessIdentity {
  parentPid: number;
  pid: number;
  processGroupId?: number;
  startTime: string;
}

export interface ProcessTreeOwnershipResolution {
  childStillOwned: boolean;
  currentIdentities: ProcessIdentity[];
  knownIdentities: ProcessIdentity[];
}

export interface ProcessTreeTerminationResult {
  remainingPids: number[];
}

export interface ProcessTreeSnapshot {
  rootPid: number;
  descendantPids: readonly number[];
  identities: readonly ProcessIdentity[];
  /** When the Windows process table query fails, empty identities do not mean that the process tree has exited. */
  identityVerification?: "verified" | "unavailable";
}

export interface ProcessTreeTerminatorWaitOptions extends ProcessTreeTerminatorOptions {
  snapshot?: ProcessTreeSnapshot;
  waitAfterForceMs?: number;
}
