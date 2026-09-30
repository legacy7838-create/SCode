import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { atomicWritePrivateTextFile, withFileLock } from "@zcode/shared/node";
import type { NodeZCodeBuiltinProviderConfigSource } from "./zcode-builtin-provider-config-source.js";
import type { ZCodeBuiltinRelease } from "./zcode-builtin-release.js";

const HOUR_MS = 60 * 60 * 1_000;

export type ZCodeBuiltinRefreshResult =
  | "updated"
  | "unchanged"
  | "stale"
  | "missing"
  | "skipped"
  | "disposed";

export interface ZCodeBuiltinRemoteSynchronizerOptions {
  readonly source: NodeZCodeBuiltinProviderConfigSource;
  readonly controlFilePath: string;
  readonly resolveEndpointKey: () => string | Promise<string>;
  readonly fetchRelease: (
    endpointKey: string,
    signal: AbortSignal,
  ) => Promise<ZCodeBuiltinRelease | null>;
  readonly onRefreshResult?: (event: ZCodeBuiltinRefreshEvent) => void;
  readonly now?: () => number;
  readonly successIntervalMs?: number;
  readonly leaseDurationMs?: number;
  readonly failureBaseDelayMs?: number;
  readonly failureMaxDelayMs?: number;
}

export interface ZCodeBuiltinRefreshEvent {
  readonly result: ZCodeBuiltinRefreshResult;
  readonly reason?: "lease-held" | "not-due" | "endpoint-changed";
  readonly revision?: number;
}

interface RefreshControl {
  readonly schemaVersion: 1;
  readonly endpointKey: string;
  readonly leaseId?: string;
  readonly leaseUntil: number;
  readonly nextEligibleAt: number;
  readonly failureCount: number;
}

/** The shared Environment control file coalesces refreshes from multiple processes; no file lock is held while the network call is in flight. */
export class ZCodeBuiltinRemoteSynchronizer {
  readonly #options: ZCodeBuiltinRemoteSynchronizerOptions;
  readonly #now: () => number;
  #inFlight: Promise<ZCodeBuiltinRefreshResult> | null = null;
  #disposed = false;
  #abortController: AbortController | null = null;

  constructor(options: ZCodeBuiltinRemoteSynchronizerOptions) {
    this.#options = options;
    this.#now = options.now ?? Date.now;
  }

  refresh(options: { readonly force?: boolean } = {}): Promise<ZCodeBuiltinRefreshResult> {
    if (this.#disposed) return Promise.resolve("disposed");
    if (this.#inFlight) return this.#inFlight;
    const controller = new AbortController();
    this.#abortController = controller;
    const refresh = this.#refresh(options.force === true, controller.signal).finally(() => {
      if (this.#inFlight === refresh) {
        this.#inFlight = null;
        this.#abortController = null;
      }
    });
    this.#inFlight = refresh;
    return refresh;
  }

  dispose(): void {
    this.#disposed = true;
    this.#abortController?.abort();
  }

  async #refresh(force: boolean, signal: AbortSignal): Promise<ZCodeBuiltinRefreshResult> {
    const endpointKey = (await this.#options.resolveEndpointKey()).trim();
    if (this.#disposed) return "disposed";
    if (!endpointKey) throw new Error("ZCode Built-in remote Endpoint must not be empty");
    const leaseId = randomUUID();
    const acquired = await withFileLock(this.#options.controlFilePath, async () => {
      const now = this.#now();
      const current = await readControl(this.#options.controlFilePath);
      const sameEndpoint = current.endpointKey === endpointKey;
      if (sameEndpoint && current.leaseUntil > now) return "lease-held" as const;
      if (!force && sameEndpoint && current.nextEligibleAt > now) return "not-due" as const;
      await writeControl(this.#options.controlFilePath, {
        schemaVersion: 1,
        endpointKey,
        leaseId,
        leaseUntil: now + (this.#options.leaseDurationMs ?? 30_000),
        nextEligibleAt: sameEndpoint ? current.nextEligibleAt : 0,
        failureCount: sameEndpoint ? current.failureCount : 0,
      });
      return true;
    });
    if (acquired !== true) {
      this.#report({ result: "skipped", reason: acquired });
      return "skipped";
    }

    try {
      signal.throwIfAborted();
      const release = await this.#options.fetchRelease(endpointKey, signal);
      if (this.#disposed) {
        await this.#finishLease(endpointKey, leaseId, "cancelled");
        return "disposed";
      }
      const currentEndpointKey = (await this.#options.resolveEndpointKey()).trim();
      signal.throwIfAborted();
      if (currentEndpointKey !== endpointKey) {
        await this.#finishLease(endpointKey, leaseId, true);
        this.#report({ result: "skipped", reason: "endpoint-changed" });
        return "skipped";
      }
      const result = release ? await this.#options.source.applyRemoteRelease(release) : "missing";
      await this.#finishLease(endpointKey, leaseId, true);
      this.#report({ result, ...(release ? { revision: release.revision } : {}) });
      return result;
    } catch (error) {
      await this.#finishLease(endpointKey, leaseId, this.#disposed ? "cancelled" : false);
      if (this.#disposed) return "disposed";
      throw error;
    }
  }

  #report(event: ZCodeBuiltinRefreshEvent): void {
    if (this.#disposed) return;
    try {
      this.#options.onRefreshResult?.(event);
    } catch {
      /* The log cannot change successful application to failed download. */
    }
  }

  async #finishLease(
    endpointKey: string,
    leaseId: string,
    success: boolean | "cancelled",
  ): Promise<void> {
    await withFileLock(this.#options.controlFilePath, async () => {
      const current = await readControl(this.#options.controlFilePath);
      if (current.endpointKey !== endpointKey || current.leaseId !== leaseId) return;
      const failureCount =
        success === "cancelled" ? current.failureCount : success ? 0 : current.failureCount + 1;
      const delay =
        success === "cancelled"
          ? 0
          : success
            ? (this.#options.successIntervalMs ?? HOUR_MS)
            : Math.min(
                (this.#options.failureBaseDelayMs ?? 60_000) * 2 ** Math.max(0, failureCount - 1),
                this.#options.failureMaxDelayMs ?? HOUR_MS,
              );
      await writeControl(this.#options.controlFilePath, {
        schemaVersion: 1,
        endpointKey,
        leaseUntil: 0,
        nextEligibleAt: this.#now() + delay,
        failureCount,
      });
    });
  }
}

async function readControl(filePath: string): Promise<RefreshControl> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (error) {
    if (isFileNotFound(error)) return emptyControl();
    throw error;
  }
  try {
    const input = JSON.parse(raw) as unknown;
    return isRefreshControl(input) ? input : emptyControl();
  } catch {
    // The control file is not a business fact; damaged content left behind by a process crash is rebuilt within the lock and cannot permanently block refreshes.
    return emptyControl();
  }
}

function emptyControl(): RefreshControl {
  return { schemaVersion: 1, endpointKey: "", leaseUntil: 0, nextEligibleAt: 0, failureCount: 0 };
}

function writeControl(filePath: string, control: RefreshControl): Promise<void> {
  return atomicWritePrivateTextFile(filePath, JSON.stringify(control, null, 2));
}

function isRefreshControl(input: unknown): input is RefreshControl {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return false;
  const value = input as Record<string, unknown>;
  return (
    value.schemaVersion === 1 &&
    typeof value.endpointKey === "string" &&
    (value.leaseId === undefined || typeof value.leaseId === "string") &&
    typeof value.leaseUntil === "number" &&
    typeof value.nextEligibleAt === "number" &&
    Number.isInteger(value.failureCount) &&
    (value.failureCount as number) >= 0
  );
}

function isFileNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}
