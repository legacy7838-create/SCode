import { connectViaWebSocket } from "@zcode/client";

import { spawnTauriSidecarDiscoverPort } from "./tauriBridge.js";

/**
 * Renderer ⇄ Local-Host sidecar connection bridge — the transport glue from
 * `../tauri-port/SIDECAR-TRANSPORT.md §6` step 4.
 *
 * The Tauri shell runs the Local Host as a Node sidecar bound to an OS-ephemeral loopback port
 * (`spawn_sidecar_echo_discover_port`, slice 31, proves the discovery path). This module turns that
 * discovered port into a `connectViaWebSocket` call — the exact `@zcode/client` factory already
 * production-tested on the web/phone path and driven end-to-end by `test/layer-a/a1-ws-rpc.test.ts`.
 * So this is NOT a new transport; it is the ~5 lines of glue joining the verified port-discovery
 * command to the verified WS-RPC client.
 *
 * Additive and NOT wired into the Electron factory yet: the runtime factory will call this only under
 * `isTauriRuntime()` once the Host externalBin is packaged (SIDECAR-TRANSPORT §6 steps 1–3, gated on
 * the `GO-NO-GO.md` decisions). Until then it is a complete, tested building block.
 *
 * Auth: `connectViaWebSocket` opens a plain browser `WebSocket`; the loopback shared-secret gate
 * (SIDECAR-TRANSPORT §4) attaches the token to the URL at the server handshake. Browser WebSockets
 * cannot set headers, so a real token would be appended here (`?secret=`) once the Rust core hands it
 * to the renderer — that secret handoff is a gated follow-on, not faked here.
 */

/** Injectable dependencies so the sequencing is unit-testable without a live sidecar/websocket. */
export interface TauriHostConnectionDeps {
  /** Resolves the ephemeral port the Host sidecar bound (defaults to the discover-port command). */
  discoverPort: typeof spawnTauriSidecarDiscoverPort;
  /** Opens the RPC connection over WS (defaults to the production `@zcode/client` factory). */
  connect: typeof connectViaWebSocket;
}

const realDeps: TauriHostConnectionDeps = {
  discoverPort: spawnTauriSidecarDiscoverPort,
  connect: connectViaWebSocket,
};

/**
 * Build the loopback host WebSocket URL for an ephemeral port. Kept pure so the 127.0.0.1-only rule
 * (SIDECAR-TRANSPORT §4: never expose beyond loopback) is directly unit-testable.
 *
 * @param port - The TCP port the Host sidecar bound.
 * @returns A `ws://127.0.0.1:<port>` URL string.
 */
export function hostWsUrl(port: number): string {
  return `ws://127.0.0.1:${port}`;
}

/**
 * Discover the running Host sidecar's port and connect the renderer to it over the reused WS-RPC
 * transport, returning the service accessor.
 *
 * @param deps - Injectable port-discovery + connect functions; defaults to the real command + client.
 * @returns The `@zcode/client` service accessor (the RPC surface the platform adapter consumes).
 */
export function connectTauriHost(
  deps: TauriHostConnectionDeps = realDeps,
): Promise<Awaited<ReturnType<typeof connectViaWebSocket>>> {
  return deps.discoverPort().then((port) => deps.connect(hostWsUrl(port)));
}
