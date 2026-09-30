/**
 * Example 1: Basic IPC - demonstrating a complete RPC call via an in-memory Queue
 *
 * Demonstrates the core process:
 * 1. Create a memory transfer pair (QueueProtocol)
 * 2. Register a channel on the server
 * 3. The client obtains the channel and calls methods/listens for events
 *
 * Data flow:
 *   client.call('add', [1, 2])
 *       ↓ serialize → send
 *   [protocol A] ──buffer──→ [protocol B]
 *       ↓ deserialize → dispatch
 *   channel.call(ctx, 'add', [1, 2])
 *       ↓ return 3
 *   [protocol B] ──buffer──→ [protocol A]
 *       ↓ deserialize → resolve promise
 *   result = 3
 */

import {
  Emitter,
  Event,
  IServerChannel,
  ChannelServer,
  ChannelClient,
  createQueuePair,
} from "../src/index.js";

// ============================================================================
// Step 1: Define a service (normal TypeScript object)
// ============================================================================

class CalculatorService {
  private readonly _onDidCompute = new Emitter<{ op: string; result: number }>();
  readonly onDidCompute = this._onDidCompute.event;

  add(a: number, b: number): number {
    const result = a + b;
    this._onDidCompute.fire({ op: `${a} + ${b}`, result });
    return result;
  }

  multiply(a: number, b: number): number {
    const result = a * b;
    this._onDidCompute.fire({ op: `${a} * ${b}`, result });
    return result;
  }

  async divide(a: number, b: number): Promise<number> {
    if (b === 0) {
      throw new Error("Division by zero");
    }
    const result = a / b;
    this._onDidCompute.fire({ op: `${a} / ${b}`, result });
    return result;
  }
}

// ============================================================================
// Step 2: Handwrite IServerChannel (later examples will be automated using ProxyChannel)
// ============================================================================

class CalculatorChannel implements IServerChannel {
  constructor(private service: CalculatorService) {}

  call(_ctx: string, command: string, arg?: any): Promise<any> {
    switch (command) {
      case "add":
        return Promise.resolve(this.service.add(arg[0], arg[1]));
      case "multiply":
        return Promise.resolve(this.service.multiply(arg[0], arg[1]));
      case "divide":
        return this.service.divide(arg[0], arg[1]);
      default:
        throw new Error(`Unknown command: ${command}`);
    }
  }

  listen(_ctx: string, event: string): Event<any> {
    switch (event) {
      case "onDidCompute":
        return this.service.onDidCompute;
      default:
        throw new Error(`Unknown event: ${event}`);
    }
  }
}

// ============================================================================
// Step 3: Establish connection and perform RPC
// ============================================================================

async function main() {
  // Create a memory transfer pair
  const [protocolA, protocolB] = createQueuePair();

  // Server: Register channel on protocolB
  const service = new CalculatorService();
  const server = new ChannelServer(protocolB, "server-ctx");
  server.registerChannel("calculator", new CalculatorChannel(service));

  // Client: Get channel through protocolA
  const client = new ChannelClient(protocolA);

  // Wait for initialization to complete
  await Event.toPromise(client.onDidInitialize);

  const calculator = client.getChannel("calculator");

  // Subscribe to events
  const disposable = calculator.listen<{ op: string; result: number }>("onDidCompute")((e) => {
    console.log(`  [event] ${e.op} = ${e.result}`);
  });

  // call method
  console.log("--- Basic IPC Demo ---");

  const sum = await calculator.call<number>("add", [10, 20]);
  console.log(`add(10, 20) = ${sum}`);

  const product = await calculator.call<number>("multiply", [6, 7]);
  console.log(`multiply(6, 7) = ${product}`);

  const quotient = await calculator.call<number>("divide", [100, 3]);
  console.log(`divide(100, 3) = ${quotient}`);

  // Test error propagation
  try {
    await calculator.call("divide", [1, 0]);
  } catch (err: any) {
    console.log(`divide(1, 0) → Error: ${err.message}`);
  }

  // clean up
  disposable.dispose();
  client.dispose();
  server.dispose();

  console.log("\nDone!");
}

main().catch(console.error);
