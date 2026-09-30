import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { serve } from "@hono/node-server";
import { createNodeWebSocket } from "@hono/node-ws";
import { Hono } from "hono";
import type { WebSocket } from "ws";
import type { WebSocketServer } from "ws";
import {
  Emitter,
  VSBuffer,
  SocketProtocol,
  ChannelServer,
  LoggingChannelServer,
  type ISocket,
} from "@zcode/rpc";
import {
  createZCodeAgentConnectionScope,
  IZCodeAgentService,
  ServiceCollection,
} from "@zcode/services";
import { createServiceLogger } from "@zcode/services/node";
import {
  SERVER_REMOTE_PROTOCOL_VERSION,
  ZCODE_RPC_HOST_CAPABILITY_HEADER,
  ZCODE_VERSION,
  type ServerRemoteInfo,
} from "@zcode/shared";
import { createHostCapabilityStore, type HostCapabilityStore } from "./hostCapability.js";

interface CoreHttpServer {
  host: string;
  port: number;
  close: () => Promise<void>;
}

const WEBSOCKET_DRAIN_TIMEOUT_MS = 250;
const log = createServiceLogger("server-core");

async function closeWebSocketServer(wss: WebSocketServer): Promise<void> {
  for (const client of wss.clients) {
    // HTTP server.close() will not converge upgraded WebSocket, active desktop
    // A continuous connection will prevent Core's shutdown ack from being sent forever. Send close frame to normal first
    // The client has a short emptying window and then terminates to ensure that the Supervisor can release resources within the budget.
    client.close(1001, "Server shutting down");
  }
  const deadline = Date.now() + WEBSOCKET_DRAIN_TIMEOUT_MS;
  while (wss.clients.size > 0 && Date.now() < deadline) {
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  for (const client of wss.clients) client.terminate();
  await new Promise<void>((resolve, reject) => {
    wss.close((error?: Error) => (error ? reject(error) : resolve()));
  });
}

function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase();
  return normalized === "127.0.0.1" || normalized === "::1" || normalized === "localhost";
}

function wrapWebSocket(ws: WebSocket): ISocket {
  const data = new Emitter<VSBuffer>();
  const close = new Emitter<void>();
  ws.on("message", (raw) =>
    data.fire(VSBuffer.wrap(Buffer.isBuffer(raw) ? raw : Buffer.from(raw as ArrayBuffer))),
  );
  ws.on("close", () => close.fire());
  ws.on("error", () => close.fire());
  return {
    onData: data.event,
    onClose: close.event,
    onEnd: close.event,
    write(buffer) {
      if (ws.readyState === ws.OPEN) ws.send(buffer.buffer);
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

function exposeWebSocket(
  ws: WebSocket,
  services: ServiceCollection,
  clientMode: "desktop-continuous" | "web-remote-replayable",
): void {
  const socket = wrapWebSocket(ws);
  const protocol = new SocketProtocol(socket);
  const rawServer = new ChannelServer(protocol, "server");
  const server = new LoggingChannelServer(rawServer, (...args) => log.debug(undefined, ...args));
  const agentService = services.getOptional(IZCodeAgentService);
  const scope = agentService
    ? createZCodeAgentConnectionScope(agentService, {
        connectionId: `server-core-ws-${randomUUID()}`,
        clientMode,
        role: clientMode === "desktop-continuous" ? "trusted-host-relay" : "terminal-client",
      })
    : undefined;
  services.exposeOnChannelServer(
    server,
    scope ? new Map([[IZCodeAgentService.channelName, scope.service]]) : new Map(),
  );
  socket.onClose(() => {
    void scope?.dispose();
    rawServer.dispose();
  });
}

export async function createCoreHttpServer(
  services: ServiceCollection,
  options: {
    host?: string;
    port?: number;
    serverId?: string;
    hostCapabilityStore?: HostCapabilityStore;
  } = {},
): Promise<CoreHttpServer> {
  const app = new Hono();
  const { injectWebSocket, upgradeWebSocket, wss } = createNodeWebSocket({ app });
  const host = options.host ?? "127.0.0.1";
  if (!isLoopbackHost(host)) {
    // Currently, there is only the local machine/SSH tunnel entrance, and Core has not yet connected to the token middleware; external monitoring must be fail-closed.
    throw new Error(
      `Non-loopback host ${host} requires authentication before the server can listen`,
    );
  }
  const info: ServerRemoteInfo = {
    serverId: options.serverId ?? hostname() ?? "zcode-server",
    version: ZCODE_VERSION,
    protocolVersion: SERVER_REMOTE_PROTOCOL_VERSION,
    authRequired: false,
    workspaces: [],
    capabilities: {
      desktopContinuous: true,
      websocketRpc: true,
      processResourceTelemetry: true,
    },
  };
  // A naked Set cannot implement expiresAt, and unconsumed capabilities will always be valid and continue to accumulate.
  // Use a packages/server-compatible TTL one-time store so that the validity period and consumption semantics are consistent with the returned information.
  const capabilities = options.hostCapabilityStore ?? createHostCapabilityStore();
  app.get("/api/server-info", (context) => context.json(info));
  app.get(
    "/ws",
    upgradeWebSocket(() => ({
      onOpen(_event, socket) {
        exposeWebSocket(socket.raw as WebSocket, services, "web-remote-replayable");
      },
    })),
  );
  app.use("/ws/host", async (context, next) => {
    const capability = context.req.header(ZCODE_RPC_HOST_CAPABILITY_HEADER);
    if (!capabilities.consume(capability)) {
      return context.json({ error: "Invalid or expired host capability" }, 401);
    }
    await next();
  });
  app.get(
    "/ws/host",
    upgradeWebSocket(() => ({
      onOpen(_event, socket) {
        exposeWebSocket(socket.raw as WebSocket, services, "desktop-continuous");
      },
    })),
  );
  app.post("/api/rpc-host-capability", (context) => context.json(capabilities.issue()));
  let resolveListening: (value: { port: number }) => void = () => undefined;
  const listening = new Promise<{ port: number }>((resolve) => {
    resolveListening = resolve;
  });
  const server = serve({ fetch: app.fetch, hostname: host, port: options.port ?? 0 }, () => {
    const address = server.address();
    resolveListening({
      port: typeof address === "object" && address ? address.port : (options.port ?? 0),
    });
  });
  injectWebSocket(server);
  const { port } = await listening;
  return {
    host,
    port,
    close: async () => {
      await closeWebSocketServer(wss);
      await new Promise<void>((resolve, reject) =>
        server.close((error?: Error) => (error ? reject(error) : resolve())),
      );
    },
  };
}
