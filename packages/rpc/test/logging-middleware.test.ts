import assert from "node:assert/strict";
import test from "node:test";
import { LoggingChannelClient, LoggingChannelServer } from "../src/logging-middleware.js";
import type { IChannel, IChannelClient, IChannelServer, IServerChannel } from "../src/channels.js";
import { Emitter } from "../src/foundation.js";

const RUNTIME_UNAVAILABLE = "ZCODE_AGENT_RUNTIME_UNAVAILABLE";

function codedError(code: string): Error & { code: string } {
  const error = new Error("ZCode Agent runtime is not running.") as Error & { code: string };
  error.code = code;
  return error;
}

function isRuntimeUnavailable(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === RUNTIME_UNAVAILABLE
  );
}

/** Inner server that keeps the wrapped channels so the test can invoke them. */
function createInnerServer(): { server: IChannelServer; channels: Map<string, IServerChannel> } {
  const channels = new Map<string, IServerChannel>();
  return {
    channels,
    server: {
      registerChannel(name, channel) {
        channels.set(name, channel);
      },
    },
  };
}

function failingChannel(code: string): IServerChannel {
  return {
    call: async () => {
      throw codedError(code);
    },
    listen: () => new Emitter<never>().event,
  };
}

test("expected error is not logged as FAIL when no expectedLogger is supplied", async () => {
  const logs: string[] = [];
  const inner = createInnerServer();
  const logged = new LoggingChannelServer(inner.server, (message) => logs.push(message), {
    isExpectedError: isRuntimeUnavailable,
  });
  logged.registerChannel("zcode-agent", failingChannel(RUNTIME_UNAVAILABLE));

  await assert.rejects(inner.channels.get("zcode-agent")!.call("subscribe"));
  assert.equal(
    logs.some((message) => message.includes("FAIL")),
    false,
  );
});

test("expected error is routed to expectedLogger, never to the FAIL sink", async () => {
  const failLogs: string[] = [];
  const expectedLogs: string[] = [];
  const inner = createInnerServer();
  const logged = new LoggingChannelServer(inner.server, (message) => failLogs.push(message), {
    isExpectedError: isRuntimeUnavailable,
    expectedLogger: (message) => expectedLogs.push(message),
  });
  logged.registerChannel("zcode-agent", failingChannel(RUNTIME_UNAVAILABLE));

  await assert.rejects(inner.channels.get("zcode-agent")!.call("subscribe"));
  assert.equal(
    failLogs.some((message) => message.includes("FAIL")),
    false,
  );
  assert.ok(expectedLogs.some((message) => message.includes("expected")));
});

test("unclassified errors still log as FAIL", async () => {
  const logs: string[] = [];
  const inner = createInnerServer();
  const logged = new LoggingChannelServer(inner.server, (message) => logs.push(message), {
    isExpectedError: isRuntimeUnavailable,
  });
  logged.registerChannel("zcode-agent", failingChannel("SOME_OTHER_CODE"));

  await assert.rejects(inner.channels.get("zcode-agent")!.call("subscribe"));
  assert.ok(logs.some((message) => message.includes("FAIL")));
});

test("default options keep the original FAIL behavior", async () => {
  const logs: string[] = [];
  const inner = createInnerServer();
  const logged = new LoggingChannelServer(inner.server, (message) => logs.push(message));
  logged.registerChannel("zcode-agent", failingChannel(RUNTIME_UNAVAILABLE));

  await assert.rejects(inner.channels.get("zcode-agent")!.call("subscribe"));
  assert.ok(logs.some((message) => message.includes("FAIL")));
});

test("client middleware classifies expected errors the same way", async () => {
  const logs: string[] = [];
  const channel: IChannel = {
    call: async () => {
      throw codedError(RUNTIME_UNAVAILABLE);
    },
    listen: () => new Emitter<never>().event,
  };
  const innerClient: IChannelClient = {
    getChannel: () => channel,
  };
  const logged = new LoggingChannelClient(innerClient, (message) => logs.push(message), {
    isExpectedError: isRuntimeUnavailable,
  });

  await assert.rejects(logged.getChannel("zcode-agent").call("subscribe"));
  assert.equal(
    logs.some((message) => message.includes("FAIL")),
    false,
  );
});
