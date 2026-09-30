import type { ChildProcess } from "node:child_process";
import {
  captureProcessTreeSnapshot,
  filterCurrentProcessIdentities,
} from "#src/process/processTreeSnapshot.js";
import {
  captureProcessTreeSnapshotAsync,
  filterCurrentProcessIdentitiesAsync,
} from "#src/process/processTreeSnapshotAsync.js";
import type {
  ProcessIdentity,
  ProcessTreeOwnershipResolution,
  ProcessTreeTerminatorOptions,
} from "#src/process/processTreeTypes.js";

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

function mergeIdentities(...groups: readonly (readonly ProcessIdentity[])[]): ProcessIdentity[] {
  const identitiesByPid = new Map<number, ProcessIdentity>();
  for (const identities of groups) {
    for (const identity of identities) {
      identitiesByPid.set(identity.pid, identity);
    }
  }
  return [...identitiesByPid.values()];
}

function captureLiveIdentities(
  child: ChildProcess,
  options: ProcessTreeTerminatorOptions,
): ProcessIdentity[] {
  if (hasChildExited(child)) {
    return [];
  }
  return [...(captureProcessTreeSnapshot(child, options)?.identities ?? [])];
}

function isSameProcessIdentity(left: ProcessIdentity, right: ProcessIdentity): boolean {
  return (
    left.pid === right.pid &&
    left.startTime === right.startTime &&
    left.processGroupId === right.processGroupId
  );
}

export function resolveCurrentOwnedIdentities(
  child: ChildProcess,
  knownIdentities: readonly ProcessIdentity[],
  options: ProcessTreeTerminatorOptions,
  allowRootDiscovery = true,
): ProcessTreeOwnershipResolution {
  const rootPid = child.pid!;
  const knownRootIdentity = knownIdentities.find((identity) => identity.pid === rootPid);
  const childHasNotExited = !hasChildExited(child);
  // The root PID may also enter the delayed recycling window before the exit callback falls to JS.
  // When there is no fixed root identity or the lifetime identity no longer matches, it is prohibited to grab the fresh tree along the bare PID.
  if (!childHasNotExited) {
    return {
      childStillOwned: false,
      currentIdentities: filterCurrentProcessIdentities(knownIdentities, options),
      knownIdentities: [...knownIdentities],
    };
  }

  if (knownRootIdentity) {
    const rootIdentityStillCurrent =
      filterCurrentProcessIdentities([knownRootIdentity], options).length === 1;
    if (!rootIdentityStillCurrent) {
      return {
        childStillOwned: false,
        currentIdentities: filterCurrentProcessIdentities(knownIdentities, options),
        knownIdentities: [...knownIdentities],
      };
    }
  }

  if (!knownRootIdentity && !allowRootDiscovery) {
    // If the identity is re-established along the rootPid in the force timer after the first query fails,
    // When the original PID has been reused, the irrelevant process tree will be claimed as a runtime; this cycle of recycling must be permanently fail closed.
    return {
      childStillOwned: false,
      currentIdentities: [],
      knownIdentities: [],
    };
  }

  const freshIdentities = captureLiveIdentities(child, options);
  const freshRootIdentity = freshIdentities.find((identity) => identity.pid === rootPid);
  if (!knownRootIdentity && !freshRootIdentity) {
    return {
      childStillOwned: false,
      currentIdentities: [],
      knownIdentities: [],
    };
  }
  if (
    knownRootIdentity &&
    freshRootIdentity &&
    !isSameProcessIdentity(knownRootIdentity, freshRootIdentity)
  ) {
    return {
      childStillOwned: false,
      currentIdentities: filterCurrentProcessIdentities(knownIdentities, options),
      knownIdentities: [...knownIdentities],
    };
  }
  const mergedIdentities = mergeIdentities(
    knownIdentities,
    freshRootIdentity ? freshIdentities : [],
  );
  const currentIdentities = filterCurrentProcessIdentities(mergedIdentities, options);
  return {
    // root may exit between the previous identity check and fresh capture; only the final
    // The review set must still contain root to signal the root PID/PGID, disallowing trust in expired boolean states.
    childStillOwned: currentIdentities.some((identity) => identity.pid === rootPid),
    currentIdentities,
    knownIdentities: mergedIdentities,
  };
}

export async function resolveCurrentOwnedIdentitiesAsync(
  child: ChildProcess,
  knownIdentities: readonly ProcessIdentity[],
  options: ProcessTreeTerminatorOptions,
  allowRootDiscovery = true,
): Promise<ProcessTreeOwnershipResolution> {
  if (process.platform !== "win32") {
    return resolveCurrentOwnedIdentities(child, knownIdentities, options, allowRootDiscovery);
  }

  const rootPid = child.pid!;
  const knownRootIdentity = knownIdentities.find((identity) => identity.pid === rootPid);
  if (hasChildExited(child)) {
    if (!knownIdentities.some((identity) => isPidAlive(identity.pid))) {
      return {
        childStillOwned: false,
        currentIdentities: [],
        knownIdentities: [...knownIdentities],
      };
    }
    return {
      childStillOwned: false,
      currentIdentities: await filterCurrentProcessIdentitiesAsync(knownIdentities, options),
      knownIdentities: [...knownIdentities],
    };
  }
  if (knownRootIdentity) {
    const currentIdentities = await filterCurrentProcessIdentitiesAsync(knownIdentities, options);
    return {
      childStillOwned: currentIdentities.some((identity) => identity.pid === rootPid),
      currentIdentities,
      knownIdentities: [...knownIdentities],
    };
  }
  if (!allowRootDiscovery) {
    return {
      childStillOwned: false,
      currentIdentities: [],
      knownIdentities: [],
    };
  }

  const freshIdentities = [
    ...((await captureProcessTreeSnapshotAsync(child, options))?.identities ?? []),
  ];
  const freshRootIdentity = freshIdentities.find((identity) => identity.pid === rootPid);
  return {
    childStillOwned: Boolean(freshRootIdentity),
    currentIdentities: freshRootIdentity ? freshIdentities : [],
    knownIdentities: freshRootIdentity ? freshIdentities : [],
  };
}
