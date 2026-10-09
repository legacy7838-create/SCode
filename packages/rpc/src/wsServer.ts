/**
 * Server-side WebSocket → `ISocket` transport adapter.
 *
 * This is the framing-correct glue that lets a `ChannelServer` serve RPC over a plain
 * `WebSocket`. It was previously hand-rolled in two places (`packages/server`,
 * `packages/zcode-server-cli`); it lives here so the Tauri Host sidecar and every future
 * WS `ChannelServer` share one implementation.
 *
 * Dependency-free by design: `@zcode/rpc` stays transport-agnostic and never imports `ws`
 * (or any WebSocket lib). Callers pass a structurally-typed {@link WebSocketLike}; the Node
 * `ws` server socket, `@hono/node-ws` socket, or a test fake all satisfy it.
 *
 * Pairing: `wrapWebSocket(ws)` → `new SocketProtocol(socket)` → `new ChannelServer(protocol, …)`.
 */
import { Emitter } from "./foundation.js";
import { VSBuffer } from "./buffer.js";
import type { ISocket } from "./protocol.js";

/** Minimal structural surface of a server-side WebSocket, duck-typed to avoid a `ws` import. */
export interface WebSocketLike {
  /** `ws.OPEN` readyState constant (1). */
  readonly OPEN: number;
  readonly readyState: number;
  on(event: "message", listener: (raw: RawMessageLike) => void): void;
  on(event: "close" | "error", listener: () => void): void;
  send(data: Uint8Array | ArrayBuffer): void;
  close(): void;
}

/** A message payload as delivered by a WebSocket `message` event. */
export type RawMessageLike = Uint8Array | ArrayBuffer | ArrayBufferView | readonly Uint8Array[];

/**
 * Normalize a WebSocket message payload to a single, **owned** `Uint8Array`.
 *
 * The result is always a copy detached from the transport's receive buffer: `VSBuffer.wrap` takes
 * ownership of the passed array, and a `ws` server socket may reuse/zero its internal buffer after the
 * `message` event returns, so returning a live view would corrupt subsequent frames.
 */
function toUint8Array(raw: RawMessageLike): Uint8Array {
  if (raw instanceof Uint8Array) {
    // Includes Node `Buffer` (a Uint8Array subclass). Copy into a PLAIN Uint8Array: `raw.slice()`
    // would return a Buffer, which the RPC serializer JSON-encodes as {type:"Buffer",…} and breaks
    // binary round-trips. `new Uint8Array(...)` copies bytes and keeps the value a plain view.
    return new Uint8Array(raw);
  }
  if (
    Array.isArray(raw) ||
    (typeof raw === "object" && "length" in raw && !(raw instanceof ArrayBuffer))
  ) {
    // Node `ws` may deliver a `Buffer[]` fragment list for a single message; merge into one owned copy.
    const parts = raw as readonly Uint8Array[];
    const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
    const merged = new Uint8Array(total);
    let offset = 0;
    for (const part of parts) {
      merged.set(part, offset);
      offset += part.byteLength;
    }
    return merged;
  }
  if (ArrayBuffer.isView(raw)) {
    const view = raw as ArrayBufferView;
    return new Uint8Array(view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength));
  }
  return new Uint8Array((raw as ArrayBuffer).slice(0));
}

/**
 * Adapt a server-side WebSocket to an {@link ISocket} so the RPC `SocketProtocol` can frame it.
 *
 * # Parameters
 *
 * * `ws` — a live WebSocket connection on the server/sidecar side.
 *
 * # Returns
 *
 * An `ISocket` whose `onData` fires for each inbound message and whose `write` sends framed bytes
 * while the socket is `OPEN`. `onClose`/`onEnd` fire on the `close` or `error` event.
 */
export function wrapWebSocket(ws: WebSocketLike): ISocket {
  const onData = new Emitter<VSBuffer>();
  const onClose = new Emitter<void>();
  const onEnd = new Emitter<void>();

  ws.on("message", (raw) => {
    onData.fire(VSBuffer.wrap(toUint8Array(raw)));
  });
  ws.on("close", () => {
    onClose.fire();
    onEnd.fire();
  });
  ws.on("error", () => {
    onClose.fire();
    onEnd.fire();
  });

  return {
    onData: onData.event,
    onClose: onClose.event,
    onEnd: onEnd.event,
    write(buffer: VSBuffer): void {
      if (ws.readyState === ws.OPEN) {
        ws.send(buffer.buffer);
      }
    },
    end(): void {
      ws.close();
    },
    drain(): Promise<void> {
      return Promise.resolve();
    },
    dispose(): void {
      ws.close();
    },
  };
}
