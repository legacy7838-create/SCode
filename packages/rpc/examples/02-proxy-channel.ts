/**
 * Example 2: ProxyChannel – a service proxy with zero boilerplate code
 *
 * Compare the handwritten CalculatorChannel in Example 1, where ProxyChannel is used
 * One line of code can expose a service as a channel, and another line of code can restore it to a service.
 *
 * This is the secret why hundreds of services in VS Code can easily communicate across processes.
 */

import {
  Emitter,
  Event,
  DisposableStore,
  ChannelServer,
  ChannelClient,
  ProxyChannel,
  createQueuePair,
} from "../src/index.js";

// ============================================================================
// Define service interface and implementation
// ============================================================================

/** File system service interface */
interface IFileService {
  onDidChangeFile: Event<{ path: string; type: string }>;
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
  listFiles(dir: string): Promise<string[]>;
}

/** Simulated file system implementation */
class InMemoryFileService implements IFileService {
  private files = new Map<string, string>();
  private readonly _onDidChangeFile = new Emitter<{ path: string; type: string }>();
  readonly onDidChangeFile = this._onDidChangeFile.event;

  async readFile(path: string): Promise<string> {
    const content = this.files.get(path);
    if (content === undefined) {
      throw new Error(`File not found: ${path}`);
    }
    return content;
  }

  async writeFile(path: string, content: string): Promise<void> {
    const isNew = !this.files.has(path);
    this.files.set(path, content);
    this._onDidChangeFile.fire({
      path,
      type: isNew ? "created" : "changed",
    });
  }

  async listFiles(dir: string): Promise<string[]> {
    return [...this.files.keys()].filter((p) => p.startsWith(dir));
  }
}

// ============================================================================
// Demo ProxyChannel
// ============================================================================

async function main() {
  const [protocolA, protocolB] = createQueuePair();
  const disposables = new DisposableStore();

  // ========== Server ==========
  const fileService = new InMemoryFileService();

  // One line of code: turn service into channel!
  // ProxyChannel.fromService will automatically:
  // - Map readFile, writeFile, listFiles to call
  // - Map onDidChangeFile to listen
  const channel = ProxyChannel.fromService<string>(fileService, disposables);

  const server = new ChannelServer(protocolB, "server");
  server.registerChannel("fileService", channel);

  // ========== Client ==========
  const client = new ChannelClient(protocolA);
  await Event.toPromise(client.onDidInitialize);

  // One line of code: restore the channel to a type-safe service!
  // Using ES6 Proxy, calling remoteFS.readFile(...) will automatically become channel.call('readFile', [...])
  const remoteFS = ProxyChannel.toService<IFileService>(client.getChannel("fileService"));

  // ========== Use remote services (just like calling local methods!) ==========
  console.log("--- ProxyChannel Demo ---");
  console.log("(Note: All calls are serialized → transferred → deserialized)\n");

  // Listen for file change events
  const eventDisposable = remoteFS.onDidChangeFile((e) => {
    console.log(`  [file event] ${e.type}: ${e.path}`);
  });

  // write file
  await remoteFS.writeFile("/src/main.ts", 'console.log("hello")');
  await remoteFS.writeFile("/src/util.ts", "export function add(a, b) { return a + b; }");
  await remoteFS.writeFile("/src/main.ts", 'console.log("hello world")'); // Modify

  // read file
  const content = await remoteFS.readFile("/src/main.ts");
  console.log(`\nreadFile('/src/main.ts') = "${content}"`);

  // List files
  const files = await remoteFS.listFiles("/src");
  console.log(`listFiles('/src') = ${JSON.stringify(files)}`);

  // Test error propagation
  try {
    await remoteFS.readFile("/nonexistent");
  } catch (err: any) {
    console.log(`readFile('/nonexistent') → Error: ${err.message}`);
  }

  // clean up
  eventDisposable.dispose();
  client.dispose();
  server.dispose();
  disposables.dispose();

  console.log("\nDone!");
}

main().catch(console.error);
