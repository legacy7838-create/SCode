/**
 * Example 4: Remote remote connection - simulate the complete process of SSH/WSL
 *
 * This example simulates the complete architecture of VS Code Remote:
 *
 * [Client (Local VS Code)]
 *     ↓ authority = "ssh+myserver"
 * [RemoteAuthorityResolver] → { host: "192.168.1.100", port: 8080 }
 *     ↓
 * [RemoteSocketFactory] → Create socket connection
 *     ↓
 * [PersistentProtocol] → Add ACK + heartbeat + reconnect
 *     ↓
 * [IPCClient] → channel.call('readFile', ...)
 *     ↓ (transmitted via socket)
 * [Server (remote machine)]
 *     ↓
 * [ChannelServer] → fileService.readFile(...)
 *     ↓ (read remote file system)
 * Return results
 *
 * Also demonstrates URI conversion:
 *   Client: vscode-remote://ssh+myserver/home/user/file.txt
 *   Server: file:///home/user/file.txt
 */

import {
  Emitter,
  Event,
  VSBuffer,
  ISocket,
  DisposableStore,
  ChannelServer,
  ChannelClient,
  IMessagePassingProtocol,
  ProxyChannel,
  RemoteConnectionType,
  WebSocketRemoteConnection,
  IRemoteAuthorityResolver,
  RemoteAuthorityResolverService,
  ISocketFactory,
  RemoteSocketFactoryService,
  ResolvedAuthority,
  RemoteConnection,
  createURITransformer,
} from "../src/index.js";

// ============================================================================
// Simulated Socket implementation (bidirectional channel in memory)
// ============================================================================

class MockSocket implements ISocket {
  private _onData = new Emitter<VSBuffer>();
  private _onClose = new Emitter<void>();
  private _onEnd = new Emitter<void>();

  readonly onData = this._onData.event;
  readonly onClose = this._onClose.event;
  readonly onEnd = this._onEnd.event;

  private peer: MockSocket | null = null;

  static createPair(): [MockSocket, MockSocket] {
    const a = new MockSocket();
    const b = new MockSocket();
    a.peer = b;
    b.peer = a;
    return [a, b];
  }

  write(buffer: VSBuffer): void {
    // Simulate network latency
    setTimeout(() => {
      this.peer?._onData.fire(buffer);
    }, 1);
  }

  end(): void {
    this._onEnd.fire();
  }

  async drain(): Promise<void> {}

  dispose(): void {
    this._onClose.fire();
    this._onData.dispose();
    this._onClose.dispose();
    this._onEnd.dispose();
  }
}

// ============================================================================
// Simulate SSH Resolver
// ============================================================================

/**
 * SSH Authority Resolver - emulates the Remote-SSH extension
 *
 * In a real scenario, this would be:
 * 1. Parse SSH config to obtain the host address
 * 2. Establish an SSH tunnel
 * 3. Start code-server remotely
 * 4. Return the local port of the tunnel
 */
class SSHAuthorityResolver implements IRemoteAuthorityResolver {
  // Simulated SSH host configuration
  private hosts: Record<string, { host: string; port: number }> = {
    "ssh+myserver": { host: "192.168.1.100", port: 8080 },
    "ssh+devbox": { host: "10.0.0.50", port: 8080 },
  };

  async resolve(authority: string): Promise<ResolvedAuthority> {
    const config = this.hosts[authority];
    if (!config) {
      throw new Error(`Unknown SSH host: ${authority}`);
    }

    console.log(`  [SSH Resolver] Resolving "${authority}" → ${config.host}:${config.port}`);

    return {
      authority,
      connectTo: new WebSocketRemoteConnection(config.host, config.port),
      connectionToken: "mock-token-" + authority,
    };
  }
}

// ============================================================================
// Emulate Socket Factory
// ============================================================================

/** Save the socket reference of the "server" to simulate a network connection */
const pendingServerSockets: MockSocket[] = [];

class MockWebSocketFactory implements ISocketFactory<RemoteConnectionType.WebSocket> {
  supports(connectTo: RemoteConnection & { type: RemoteConnectionType.WebSocket }): boolean {
    return true;
  }

  async connect(
    connectTo: WebSocketRemoteConnection,
    path: string,
    query: string,
  ): Promise<ISocket> {
    console.log(
      `  [Socket Factory] Connecting to ${connectTo.host}:${connectTo.port}${path}?${query}`,
    );

    const [clientSocket, serverSocket] = MockSocket.createPair();
    pendingServerSockets.push(serverSocket);
    return clientSocket;
  }
}

// ============================================================================
// Simulating a remote service
// ============================================================================

interface IRemoteFileService {
  onDidChangeFile: Event<{ path: string; type: string }>;
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
  stat(path: string): Promise<{ size: number; isDirectory: boolean }>;
}

class RemoteFileServiceImpl implements IRemoteFileService {
  private files = new Map<string, string>([
    ["/home/user/project/main.ts", 'console.log("Hello from remote!")'],
    ["/home/user/project/package.json", '{"name": "my-project", "version": "1.0.0"}'],
    ["/home/user/project/README.md", "# My Project\nRunning on remote server."],
  ]);

  private readonly _onDidChangeFile = new Emitter<{ path: string; type: string }>();
  readonly onDidChangeFile = this._onDidChangeFile.event;

  async readFile(path: string): Promise<string> {
    const content = this.files.get(path);
    if (content === undefined) {
      throw new Error(`ENOENT: ${path}`);
    }
    return content;
  }

  async writeFile(path: string, content: string): Promise<void> {
    this.files.set(path, content);
    this._onDidChangeFile.fire({ path, type: "changed" });
  }

  async stat(path: string): Promise<{ size: number; isDirectory: boolean }> {
    const content = this.files.get(path);
    if (content === undefined) {
      throw new Error(`ENOENT: ${path}`);
    }
    return { size: content.length, isDirectory: false };
  }
}

// ============================================================================
// Main process
// ============================================================================

async function main() {
  console.log("=== Remote connection Demo ===\n");
  const disposables = new DisposableStore();

  // ──────── 1. Set up Remote infrastructure ────────

  console.log("[1] Setting up Remote infrastructure...");

  const resolverService = new RemoteAuthorityResolverService();
  resolverService.registerResolver("ssh", new SSHAuthorityResolver());

  const socketFactory = new RemoteSocketFactoryService();
  socketFactory.register(RemoteConnectionType.WebSocket, new MockWebSocketFactory());

  // ──────── 2. Analyze Remote Authority ────────

  console.log('\n[2] Resolving remote authority "ssh+myserver"...');
  const resolved = await resolverService.resolveAuthority("ssh+myserver");
  console.log(`  Result: ${resolved.connectTo}, token: ${resolved.connectionToken}`);

  // ──────── 3. Establish Socket connection ────────

  console.log("\n[3] Establishing socket connection...");
  const clientSocket = await socketFactory.connect(
    resolved.connectTo,
    "/",
    `token=${resolved.connectionToken}`,
  );

  // Get the simulated server socket
  const serverSocket = pendingServerSockets.pop()!;

  // ──────── 4. Server settings ────────

  console.log("\n[4] Setting up remote server...");

  // Simplification: Use ChannelServer + ChannelClient directly (without the ctx handshake of IPCServer/IPCClient)
  // In a real scenario, there will be a complete handshake and authentication process.

  // Create a simple protocol (without using PersistentProtocol to simplify the demonstration)
  const serverOnMsg = new Emitter<VSBuffer>();
  const clientOnMsg = new Emitter<VSBuffer>();

  const serverProtocol: IMessagePassingProtocol = {
    send: (buf: VSBuffer) => setTimeout(() => clientOnMsg.fire(buf), 1),
    onMessage: serverOnMsg.event,
  };
  const clientProtocol: IMessagePassingProtocol = {
    send: (buf: VSBuffer) => setTimeout(() => serverOnMsg.fire(buf), 1),
    onMessage: clientOnMsg.event,
  };

  // The server registers the remote file system channel
  const remoteFileService = new RemoteFileServiceImpl();
  const server = new ChannelServer(serverProtocol, "server");
  server.registerChannel(
    "remoteFilesystem",
    ProxyChannel.fromService<string>(remoteFileService, disposables),
  );

  // ──────── 5. Client uses remote service ────────

  console.log("\n[5] Client using remote file service...");

  const client = new ChannelClient(clientProtocol);
  await Event.toPromise(client.onDidInitialize);

  const remoteFS = ProxyChannel.toService<IRemoteFileService>(
    client.getChannel("remoteFilesystem"),
  );

  // Subscribe to remote file change events
  const sub = remoteFS.onDidChangeFile((e) => {
    console.log(`  [remote event] ${e.type}: ${e.path}`);
  });

  // Read remote file
  const mainTs = await remoteFS.readFile("/home/user/project/main.ts");
  console.log(`  readFile → "${mainTs}"`);

  const stat = await remoteFS.stat("/home/user/project/package.json");
  console.log(`  stat → size: ${stat.size}, isDirectory: ${stat.isDirectory}`);

  // Write to remote file
  await remoteFS.writeFile(
    "/home/user/project/main.ts",
    'console.log("Updated from local VS Code!")',
  );

  const updated = await remoteFS.readFile("/home/user/project/main.ts");
  console.log(`  readFile after write → "${updated}"`);

  // ──────── 6. URI conversion demonstration ────────

  console.log("\n[6] URI Transformation...");

  const transformer = createURITransformer("ssh+myserver");

  const remoteURI = {
    scheme: "vscode-remote",
    authority: "ssh+myserver",
    path: "/home/user/file.txt",
  };
  const localURI = transformer.transformIncoming(remoteURI);
  console.log(`  Client → Server:`);
  console.log(`    ${remoteURI.scheme}://${remoteURI.authority}${remoteURI.path}`);
  console.log(`    → ${localURI.scheme}://${localURI.path}`);

  const fileURI = { scheme: "file", authority: "", path: "/home/user/file.txt" };
  const clientURI = transformer.transformOutgoing(fileURI);
  console.log(`  Server → Client:`);
  console.log(`    ${fileURI.scheme}://${fileURI.path}`);
  console.log(`    → ${clientURI.scheme}://${clientURI.authority}${clientURI.path}`);

  // clean up
  sub.dispose();
  client.dispose();
  server.dispose();
  clientSocket.dispose();
  serverSocket.dispose();
  disposables.dispose();

  console.log("\nDone!");
}

main().catch(console.error);
