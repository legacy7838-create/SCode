import type { UtilityProcess as ElectronUtilityProcess } from "electron";
import { randomUUID } from "node:crypto";
import {
  HostMessageTypes,
  type HostResourceUsageProcess,
  type HostResourceUsageSnapshotResultResponse,
} from "@zcode/shared";

/**
 * Resource Manager main → Host sampling fan-out.
 * Each snapshot sends a request to each surviving Host according to the requestId; when the timeout expires, the last round result of the Host is used to avoid the list from emptying.
 */

/** Host sampling fan-out waiting limit */
const HOST_SNAPSHOT_TIMEOUT_MS = 900;

interface PendingHostRequest {
  label: string;
  cancel: () => void;
  resolve: (result: HostResourceUsageSnapshotResultResponse) => void;
}

const pendingHostRequests = new Map<string, PendingHostRequest>();
const requestIdByHost = new Map<string, string>();
const lastHostResults = new Map<string, HostResourceUsageProcess[]>();

/** Called by desktopHostProcess when the Host replies */
export function resolveHostResourceUsageResult(
  label: string,
  result: HostResourceUsageSnapshotResultResponse,
): void {
  const pending = pendingHostRequests.get(result.requestId);
  // Old results after closing/reopening must not be written back to the new sampling session; the requestId must also belong to the reply Host.
  if (!pending || pending.label !== label) return;
  lastHostResults.set(label, result.processes);
  pending.resolve(result);
}

/** Drops a Host's fallback cache when it exits */
export function forgetHostResourceUsage(label: string): void {
  const requestId = requestIdByHost.get(label);
  if (requestId) pendingHostRequests.get(requestId)?.cancel();
  lastHostResults.delete(label);
}

export function requestHostResourceUsage(
  label: string,
  child: Pick<ElectronUtilityProcess, "postMessage">,
  timeoutMs: number = HOST_SNAPSHOT_TIMEOUT_MS,
  signal?: AbortSignal,
): Promise<HostResourceUsageProcess[]> {
  if (signal?.aborted) return Promise.resolve([]);
  // The same round of sampling is still reused after the display wait times out; it is not possible to continuously add requests to the slow Host according to the UI beat.
  if (requestIdByHost.has(label)) return Promise.resolve(lastHostResults.get(label) ?? []);
  return new Promise((resolve) => {
    const requestId = randomUUID();
    const timer = setTimeout(() => {
      resolve(lastHostResults.get(label) ?? []);
    }, timeoutMs);
    const finish = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", cancel);
      pendingHostRequests.delete(requestId);
      if (requestIdByHost.get(label) === requestId) requestIdByHost.delete(label);
    };
    const cancel = () => {
      finish();
      lastHostResults.delete(label);
      try {
        child.postMessage({ type: HostMessageTypes.ResourceUsageSnapshotCancel, requestId });
      } catch {
        /* The host has exited and there is no need to continue canceling. */
      }
      resolve([]);
    };
    requestIdByHost.set(label, requestId);
    pendingHostRequests.set(requestId, {
      label,
      cancel,
      resolve: (result) => {
        finish();
        resolve(result.processes);
      },
    });
    signal?.addEventListener("abort", cancel, { once: true });
    try {
      child.postMessage({ type: HostMessageTypes.ResourceUsageSnapshotRequest, requestId });
    } catch {
      finish();
      resolve(lastHostResults.get(label) ?? []);
    }
  });
}
