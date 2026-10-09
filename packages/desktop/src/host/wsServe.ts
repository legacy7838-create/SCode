/**
 * Host-side WebSocket RPC serving core for the Tauri sidecar transport.
 *
 * This is the WS counterpart of the Electron-era `exposeServicesOnMessagePort`: given a live
 * server-side WebSocket connection and a `ServiceCollection`, it wires the transport-agnostic
 * `SocketProtocol` into the `ChannelServer` + logging/telemetry middleware so the renderer
 * (`connectViaWebSocket`) can reach the Host's channels. The Electron `MessagePort`/`parentPort`
 * transport is gone; this is the single serving path the Tauri Local Host stands up per connection.
 *
 * Kept dependency-light and side-effect-free: it imports only `@zcode/rpc`. Callers supply the
 * service collection, capability overrides, and connection scope via {@link WsChannelServerOptions}
 * or by registering channels on the returned `server`.
 */
import {
  wrapWebSocket,
  SocketProtocol,
  ChannelServer,
  LoggingChannelServer,
  NetworkTelemetryChannelServer,
  type IChannelServer,
  type WebSocketLike,
} from "@zcode/rpc";

/** Options for a per-connection Host ChannelServer. */
export interface WsChannelServerOptions {
  /** ChannelServer label (telemetry/log identity). Defaults to `"host"`. */
  name?: string;
  /** Unknown-channel timeout in ms. Defaults to 1000 (matches the Electron host). */
  timeoutDelay?: number;
  /**
   * Defer the `Initialize` handshake until {@link WsChannelServerHandle.ready}. Remote/WS build-up
   * needs time; local attach should initialize immediately (defaults false).
   */
  deferInit?: boolean;
  /** Optional RPC logger; wraps the raw server in `LoggingChannelServer` when provided. */
  log?: (message: string, ...args: unknown[]) => void;
  /** Wrap in `NetworkTelemetryChannelServer` to observe RPC/LLM network traffic. Default true. */
  telemetry?: boolean;
}

/** A live per-connection server handle plus a hard teardown. */
export interface WsChannelServerHandle {
  /** The middleware-wrapped server to expose services on (`services.exposeOnChannelServer(server)`). */
  readonly server: IChannelServer;
  /** Signal the deferred `Initialize` (no-op when `deferInit` is false). */
  readonly ready: () => void;
  /** Dispose the server and close the socket. Idempotent. */
  readonly dispose: () => void;
}

/**
 * Stand up a Host `ChannelServer` over a live WebSocket connection.
 *
 * # Parameters
 *
 * * `ws` — an accepted server-side WebSocket connection (any `WebSocketLike`: Node `ws`, hono, fake).
 * * `options` — see {@link WsChannelServerOptions}.
 *
 * # Returns
 *
 * A {@link WsChannelServerHandle}; the caller MUST expose services on `handle.server` and dispose on
 * close. Teardown is auto-wired to the socket's `onClose`.
 */
export function createWsChannelServer(
  ws: WebSocketLike,
  options: WsChannelServerOptions = {},
): WsChannelServerHandle {
  const socket = wrapWebSocket(ws);
  const protocol = new SocketProtocol(socket);
  const rawServer = new ChannelServer(
    protocol,
    options.name ?? "host",
    options.timeoutDelay ?? 1000,
    options.deferInit ?? false,
  );

  let server: IChannelServer = rawServer;
  if (options.log) {
    server = new LoggingChannelServer(server, options.log);
  }
  if (options.telemetry ?? true) {
    server = new NetworkTelemetryChannelServer(server);
  }

  let disposed = false;
  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    rawServer.dispose();
    socket.dispose();
  };
  socket.onClose(dispose);

  return {
    server,
    ready: () => rawServer.ready(),
    dispose,
  };
}
