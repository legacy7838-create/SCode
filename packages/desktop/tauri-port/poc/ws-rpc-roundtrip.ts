/*
 * Headless PoC: prove the transport-agnostic RPC (@zcode/rpc) works over a plain
 * localhost WebSocket, so a future Tauri Local-Host sidecar can reuse it verbatim
 * — no Electron MessagePort, no GUI.
 *
 * It mirrors packages/server/src/http.ts on the server side (wrapWebSocket ->
 * SocketProtocol -> ChannelServer -> registerChannel) and uses the real
 * connectViaWebSocket client factory from packages/client/src/websocket.ts.
 *
 * Service chosen: the REAL ISubagentsService descriptor channelName (so we
 * exercise the exact service seam named in SIDECAR-TRANSPORT.md step 5), but
 * backed by a minimal stub `list()` implementation — keeps it self-contained and
 * avoids dragging in the whole ServiceCollection.
 */
import { WebSocketServer, type WebSocket } from "ws";
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

// Copy of http.ts:44-81 — wrap a Node `ws` socket into an ISocket.
function wrapWebSocket(ws: WebSocket): ISocket {
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

async function main(): Promise<void> {
  // Trivial echo service implementing the same channel/method the client proxy calls.
  const echoService = {
    list: async (params: unknown): Promise<unknown[]> => [
      { kind: "echo", received: params, ok: true },
    ],
  };

  const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>((resolve) => wss.once("listening", () => resolve()));
  const address = wss.address();
  if (typeof address === "string" || address === null) {
    throw new Error(`Unexpected WS server address: ${JSON.stringify(address)}`);
  }
  const port = address.port;

  // Per-connection wiring, mirroring setupChannelServer in http.ts.
  wss.on("connection", (ws: WebSocket) => {
    const socket = wrapWebSocket(ws);
    const protocol = new SocketProtocol(socket);
    const server = new ChannelServer(protocol, "poc");
    server.registerChannel(ISubagentsService.channelName, ProxyChannel.fromService(echoService));
    socket.onClose(() => server.dispose());
  });

  const client = await connectViaWebSocket(`ws://127.0.0.1:${port}`);
  const service = client.subagentsService;

  const t0 = performance.now();
  const result = (await service.list({ probe: "hello" })) as unknown;
  const elapsed = Math.round(performance.now() - t0);

  const arr = result as Array<{ kind?: string; received?: { probe?: string }; ok?: boolean }>;
  const row = Array.isArray(result) ? arr[0] : undefined;
  const passed =
    row !== undefined &&
    row.kind === "echo" &&
    row.ok === true &&
    row.received?.probe === "hello";

  wss.close();

  if (!passed) {
    console.error(`POC BLOCKED: round-trip returned unexpected value: ${JSON.stringify(result)}`);
    process.exit(1);
  }

  console.log(`POC PASS: ${elapsed}ms round-trip`);
  process.exit(0);
}

main().catch((err: unknown) => {
  const e = err as Error;
  console.error(`POC BLOCKED: ${e?.stack ?? e}`);
  console.error("DIAGNOSIS: transport seam failed — see exact error above for the blocking layer.");
  process.exit(1);
});
