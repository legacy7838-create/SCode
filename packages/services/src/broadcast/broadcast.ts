import type { Event } from "@zcode/rpc";
import { ServiceChannels } from "@zcode/shared";
import { createServiceDescriptor } from "../descriptors.js";

/**
 * Broadcast message
 *
 * Used for cross-window state sync. After being emitted from the Renderer it travels host → main → other hosts → the matching Renderer.
 */
export interface BroadcastMessage {
  /** Channel name, e.g. "state:theme", "state:locale" */
  channel: string;
  /** Message payload */
  payload: unknown;
  /** Source window ID of the sender (filled in by BroadcastHub; receivers can use it to skip themselves) */
  sourceWindowId?: number;
}

/** Temporary reservation for a cross-window opaque claim; the token is used for a safe commit/release. */
export interface BroadcastClaimLease {
  key: string;
  token: string;
}

export type BroadcastClaimAcquireResult =
  | { status: "acquired"; lease: BroadcastClaimLease }
  | { status: "busy"; retryAfterMs: number }
  | { status: "committed" }
  | { status: "unavailable" };

/**
 * Broadcast service interface
 *
 * Path: Renderer → (RPC call) → Host → (parentPort) → Main(BroadcastHub)
 *       → (postMessage) → other Hosts → (RPC event onMessage) → the matching Renderer
 */
export interface IBroadcastService {
  /** Send a broadcast message */
  send(message: BroadcastMessage): Promise<void>;
  /** Acquire a token-bearing temporary reservation; busy can be retried after retryAfterMs. */
  acquireClaim(key: string): Promise<BroadcastClaimAcquireResult>;
  /** Commit the reservation into a permanent claim for the lifetime of the app process. */
  commitClaim(lease: BroadcastClaimLease): Promise<void>;
  /** Release a not-yet-committed reservation by token; a late token does not affect the later winner. */
  releaseClaim(lease: BroadcastClaimLease): Promise<void>;
  /** Atomically claim an opaque key within the current app process; only the first call for a key returns true. */
  tryClaim(key: string): Promise<boolean>;
  /** Broadcasts received from other windows */
  onMessage: Event<BroadcastMessage>;
}

export const IBroadcastService = createServiceDescriptor<IBroadcastService>(
  ServiceChannels.Broadcast,
);
