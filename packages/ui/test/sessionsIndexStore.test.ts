import assert from "node:assert/strict";
import test from "node:test";
import { sessionsIndexTopic } from "@zcode/shared/zcode-protocol-v4";
import type {
  ConversationResyncParams,
  SessionsIndexTopicFrame,
  TopicFrameDeliveryKind,
  V4ConversationResyncResult,
  V4SessionsIndexSubscribeResult,
} from "@zcode/shared/zcode-protocol-v4";
import { SessionsIndexStore } from "../src/v4/sessionsIndexStore.js";
import type { SessionsIndexTransport } from "../src/v4/agentSessionsIndexTransport.js";

const RUNTIME_UNAVAILABLE_CODE = "ZCODE_AGENT_RUNTIME_UNAVAILABLE";

function runtimeUnavailableError(): Error & { code: string } {
  const error = new Error("ZCode Agent runtime is not running.") as Error & { code: string };
  error.code = RUNTIME_UNAVAILABLE_CODE;
  return error;
}

interface FakeTransportState {
  subscribeError?: unknown;
  emittedFrames: Array<{ frame: SessionsIndexTopicFrame; deliveryKind?: TopicFrameDeliveryKind }>;
  lifecycleListeners: Array<(state: "available" | "unavailable") => void>;
}

/**
 * Minimal faithful fake of SessionsIndexTransport: subscribe can be made to reject (the
 * runtime-unavailable path), and frames are delivered through the registered onFrame listener.
 */
function createFakeTransport(
  state: FakeTransportState,
  subscriptionId = "sub-1",
): SessionsIndexTransport {
  const frameListeners = new Set<
    (frame: SessionsIndexTopicFrame, context?: { deliveryKind: TopicFrameDeliveryKind }) => void
  >();
  return {
    subscribe: async (): Promise<V4SessionsIndexSubscribeResult> => {
      if (state.subscribeError) throw state.subscribeError;
      return {
        ack: { subscriptionId, mode: "snapshot", logEpoch: "epoch-1" },
      } as V4SessionsIndexSubscribeResult;
    },
    activate: () => {},
    resync: async (_params: ConversationResyncParams): Promise<V4ConversationResyncResult> => {
      throw new Error("resync not used in this test");
    },
    unsubscribe: async () => {},
    onFrame: (listener) => {
      frameListeners.add(listener);
      return () => frameListeners.delete(listener);
    },
    onAssemblyFault: () => () => {},
    onRuntimeRestart: () => () => {},
    onRuntimeLifecycle: (listener) => {
      state.lifecycleListeners.push(listener);
      return () => {
        const index = state.lifecycleListeners.indexOf(listener);
        if (index >= 0) state.lifecycleListeners.splice(index, 1);
      };
    },
  };
}

function snapshotFrame(subscriptionId: string, sessionIds: string[]): SessionsIndexTopicFrame {
  const workspaceId = "ws-1";
  return {
    topic: sessionsIndexTopic(workspaceId),
    subscriptionId,
    fromSeq: 0,
    toSeq: 1,
    sentAt: 1 as never,
    payload: {
      kind: "snapshot",
      snapshot: {
        protocolVersion: 1,
        workspaceId,
        logEpoch: "epoch-1",
        sessions: sessionIds.map((sessionId) => ({
          sessionId,
          workspaceId,
          title: sessionId,
          phase: "running",
          sessionEnded: false,
          hasBackgroundWork: false,
          lastActivityAt: 1,
          createdAt: 1,
        })),
      },
    },
  } as unknown as SessionsIndexTopicFrame;
}

test("fresh store is idle with no snapshot", () => {
  const store = new SessionsIndexStore();
  assert.equal(store.getStatus(), "idle");
  assert.equal(store.getState().workspaceId, null);
});

test("a runtime-unavailable subscribe parks the store in dormant and emits", async () => {
  const store = new SessionsIndexStore();
  let emits = 0;
  store.subscribe(() => {
    emits += 1;
  });
  const state: FakeTransportState = {
    subscribeError: runtimeUnavailableError(),
    emittedFrames: [],
    lifecycleListeners: [],
  };
  await store.connect(createFakeTransport(state), { forceSnapshot: true });
  assert.equal(store.getStatus(), "dormant");
  assert.equal(store.getState().workspaceId, null);
  assert.ok(emits >= 1, "dormant transition must emit for subscribers");
});

test("a snapshot frame makes the store live and populates the list", async () => {
  const store = new SessionsIndexStore();
  const state: FakeTransportState = {
    emittedFrames: [],
    lifecycleListeners: [],
  };
  await store.connect(createFakeTransport(state, "sub-1"), { forceSnapshot: true });
  assert.equal(store.getStatus(), "live");
  store.handleFrame(snapshotFrame("sub-1", ["s1", "s2"]));
  assert.equal(store.getState().workspaceId, "ws-1");
  assert.deepEqual(
    store
      .getSessions()
      .map((session) => session.sessionId)
      .sort(),
    ["s1", "s2"],
  );
});

test("an unavailable lifecycle event clears a live snapshot back to dormant", async () => {
  const store = new SessionsIndexStore();
  const state: FakeTransportState = {
    emittedFrames: [],
    lifecycleListeners: [],
  };
  await store.connect(createFakeTransport(state, "sub-1"), { forceSnapshot: true });
  store.handleFrame(snapshotFrame("sub-1", ["s1"]));
  assert.equal(store.getState().workspaceId, "ws-1");

  for (const listener of state.lifecycleListeners) listener("unavailable");
  assert.equal(store.getStatus(), "dormant");
  assert.equal(store.getState().workspaceId, null);
  assert.deepEqual(store.getSessions(), []);
});
