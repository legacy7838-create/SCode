import type { ChildProcess } from "node:child_process";
import {
  captureExitedRootDescendantsSnapshot,
  captureProcessTreeSnapshot,
  filterCurrentProcessIdentities,
} from "#src/process/processTreeSnapshot.js";
import type {
  ProcessIdentity,
  ProcessTreeSnapshot,
  ProcessTreeTerminatorOptions,
} from "#src/process/processTreeTypes.js";
import { readWindowsProcessListAsync } from "#src/process/windowsProcessListAsync.js";

export { verifyWindowsProcessIdentityAsync } from "#src/process/windowsProcessListAsync.js";

const WINDOWS_START_TIME_PREFIX = "windows-utc-us:";

function parseWindowsCreationTimeMs(startTime: string): number | undefined {
  if (!startTime.startsWith(WINDOWS_START_TIME_PREFIX)) return undefined;
  try {
    const microseconds = BigInt(startTime.slice(WINDOWS_START_TIME_PREFIX.length));
    const timestamp = Number(microseconds / 1_000n);
    return Number.isSafeInteger(timestamp) ? timestamp : undefined;
  } catch {
    return undefined;
  }
}

function collectDescendants(
  rootPid: number,
  identities: readonly ProcessIdentity[],
): ProcessIdentity[] {
  const childrenByParentPid = new Map<number, ProcessIdentity[]>();
  for (const identity of identities) {
    const children = childrenByParentPid.get(identity.parentPid) ?? [];
    children.push(identity);
    childrenByParentPid.set(identity.parentPid, children);
  }
  const descendants: ProcessIdentity[] = [];
  const seen = new Set<number>([rootPid]);
  const visit = (pid: number) => {
    for (const child of childrenByParentPid.get(pid) ?? []) {
      if (seen.has(child.pid)) continue;
      seen.add(child.pid);
      descendants.push(child);
      visit(child.pid);
    }
  };
  visit(rootPid);
  return descendants;
}

export async function filterCurrentProcessIdentitiesAsync(
  identities: readonly ProcessIdentity[],
  options: ProcessTreeTerminatorOptions,
): Promise<ProcessIdentity[]> {
  if (process.platform !== "win32") {
    return filterCurrentProcessIdentities(identities, options);
  }
  if (identities.length === 0) return [];
  const trackedPids = new Set(identities.map((identity) => identity.pid));
  const currentByPid = new Map(
    (await readWindowsProcessListAsync(options))
      .filter((identity) => trackedPids.has(identity.pid))
      .map((identity) => [identity.pid, identity]),
  );
  return identities.filter((identity) => {
    const current = currentByPid.get(identity.pid);
    return current?.startTime === identity.startTime;
  });
}

export async function captureProcessTreeSnapshotAsync(
  child: ChildProcess,
  options: ProcessTreeTerminatorOptions = {},
): Promise<ProcessTreeSnapshot | undefined> {
  if (process.platform !== "win32") return captureProcessTreeSnapshot(child, options);
  if (child.pid == null) return undefined;
  const processList = await readWindowsProcessListAsync(options);
  const childExitedDuringQuery = child.exitCode !== null || child.signalCode !== null;
  const ownedProcessExitedAtMs =
    options.ownedProcessExitedAtMs ?? options.resolveOwnedProcessExitedAtMs?.();
  const rootIdentity = processList.find((identity) => identity.pid === child.pid);
  // After the original root exits during the query, the PID may be between the Node exit callback and CIM return
  // be reused. The query completion time is not the exit time of the managed process; once the child exit has been observed, only use
  // The trusted exit upper bound recorded by the caller restores the old descendants, and the current process with the same PID must not be recognized as the original root.
  const identities =
    rootIdentity && !childExitedDuringQuery
      ? [rootIdentity, ...collectDescendants(child.pid, processList)]
      : collectExitedRootDescendants(
          child.pid,
          processList,
          options.ownedProcessStartedAtMs,
          ownedProcessExitedAtMs,
        );
  if (identities.length === 0) return undefined;
  return {
    rootPid: child.pid,
    descendantPids: identities
      .filter((identity) => identity.pid !== child.pid)
      .map((identity) => identity.pid),
    identities,
  };
}

function collectExitedRootDescendants(
  rootPid: number,
  processList: readonly ProcessIdentity[],
  startedAtMs: number | undefined,
  exitedAtMs: number | undefined,
): ProcessIdentity[] {
  if (
    typeof startedAtMs !== "number" ||
    !Number.isFinite(startedAtMs) ||
    typeof exitedAtMs !== "number" ||
    !Number.isFinite(exitedAtMs)
  ) {
    return [];
  }
  const lifecycleCandidates = processList.filter((identity) => {
    const createdAtMs = parseWindowsCreationTimeMs(identity.startTime);
    return createdAtMs !== undefined && createdAtMs >= startedAtMs && createdAtMs < exitedAtMs;
  });
  return collectDescendants(rootPid, lifecycleCandidates);
}

export async function captureExitedRootDescendantsSnapshotAsync(
  rootPid: number,
  options: ProcessTreeTerminatorOptions = {},
): Promise<ProcessTreeSnapshot | undefined> {
  if (process.platform !== "win32") {
    return captureExitedRootDescendantsSnapshot(rootPid, options);
  }
  const startedAtMs = options.ownedProcessStartedAtMs;
  const exitedAtMs = options.ownedProcessExitedAtMs;
  if (
    !Number.isInteger(rootPid) ||
    rootPid <= 0 ||
    typeof startedAtMs !== "number" ||
    !Number.isFinite(startedAtMs) ||
    typeof exitedAtMs !== "number" ||
    !Number.isFinite(exitedAtMs)
  ) {
    return undefined;
  }
  const identities = collectExitedRootDescendants(
    rootPid,
    await readWindowsProcessListAsync(options),
    startedAtMs,
    exitedAtMs,
  );
  return identities.length === 0
    ? undefined
    : {
        rootPid,
        descendantPids: identities.map((identity) => identity.pid),
        identities,
      };
}
