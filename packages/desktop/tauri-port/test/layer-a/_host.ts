/*
 * Shared fixture for Layer A (transport / protocol seam).
 *
 * This lifts the wiring proven in `poc/ws-rpc-roundtrip.ts` into a reusable,
 * disposable host so the assertions in `a1-ws-rpc.test.ts` / `a2-framing.test.ts`
 * never touch `process.exit` and always tear the ephemeral server down.
 *
 * Design note (mirrors `packages/server/src/http.ts`): a Node `ws` socket is
 * wrapped into an `ISocket`, driven by `SocketProtocol`, and a `ChannelServer`
 * registers the real `ISubagentsService.channelName`. The client side uses the
 * production `connectViaWebSocket` factory, so the assertion exercises the exact
 * transport seam the Tauri Local-Host sidecar is expected to reuse verbatim.
 */
import { once } from "node:events";
import { WebSocketServer, type WebSocket as NodeWebSocket } from "ws";
import {
  Emitter,
  VSBuffer,
  SocketProtocol,
  ChannelServer,
  ProxyChannel,
  type ISocket,
} from "@zcode/rpc";
import { ISubagentsService } from "@zcode/services";
import { connectViaWebSocket } from "@zcode/client";

/** Wrap a Node `ws` connection into the RPC framework's `ISocket` abstraction. */
function wrapWebSocket(ws: NodeWebSocket): ISocket {
  const onData = new Emitter<VSBuffer>();
  const onClose = new Emitter<void>();
  const onEnd = new Emitter<void>();

  ws.on("message", (raw: Buffer | ArrayBuffer | Buffer[]) => {
    const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as ArrayBuffer);
    onData.fire(VSBuffer.wrap(new Uint8Array(buf)));
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
    write(buffer: VSBuffer) {
      if (ws.readyState === ws.OPEN) {
        ws.send(buffer.buffer);
      }
    },
    end() {
      ws.close();
    },
    drain() {
      return Promise.resolve();
    },
    dispose() {
      ws.close();
    },
  };
}

/** A live host fixture: an authenticated client accessor plus a hard teardown. */
export interface WsRpcFixture {
  /** Service accessor returned by the production WS client factory. */
  readonly client: Awaited<ReturnType<typeof connectViaWebSocket>>;
  /** Close the client socket and the server, then resolve once fully torn down. */
  readonly dispose: () => Promise<void>;
}

/**
 * Start an ephemeral localhost-WS RPC host exposing `service` on the real
 * `ISubagentsService` channel and connect a production WS client to it.
 *
 * # Arguments
 *
 * * `service` - Object whose methods are proxied onto the subagents channel
 *   (e.g. `{ list: async (params) => [...] }`).
 *
 * # Returns
 *
 * A `WsRpcFixture`; callers MUST await `dispose()` in teardown so the test
 * process can exit.
 */
export async function startWsRpcHost(service: Record<string, unknown>): Promise<WsRpcFixture> {
  const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(wss, "listening");
  const address = wss.address();
  if (typeof address === "string" || address === null) {
    throw new Error(`Unexpected WS server address: ${JSON.stringify(address)}`);
  }
  const port = address.port;

  // Track server-side connections so teardown can terminate them explicitly;
  // `wss.close()` alone only stops listening and leaves live sockets open.
  const connections = new Set<NodeWebSocket>();
  let clientSocket: WebSocket | undefined;

  wss.on("connection", (ws: NodeWebSocket) => {
    connections.add(ws);
    ws.on("close", () => connections.delete(ws));
    const socket = wrapWebSocket(ws);
    const protocol = new SocketProtocol(socket);
    const server = new ChannelServer(protocol, "layer-a");
    server.registerChannel(ISubagentsService.channelName, ProxyChannel.fromService(service));
    socket.onClose(() => server.dispose());
  });

  const client = await connectViaWebSocket(`ws://127.0.0.1:${port}`, {
    onOpenSocket: (ws) => {
      clientSocket = ws;
    },
  });

  const dispose = async (): Promise<void> => {
    clientSocket?.close();
    for (const ws of connections) {
      ws.terminate();
    }
    connections.clear();
    await new Promise<void>((resolve) => {
      wss.close(() => resolve());
    });
  };

  return { client, dispose };
}
