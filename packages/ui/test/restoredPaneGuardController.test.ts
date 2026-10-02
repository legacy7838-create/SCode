import assert from "node:assert/strict";
import test from "node:test";
import {
  createRestoredPaneGuardController,
  type RestoredPaneGuardControllerOptions,
} from "../src/v4/restoredPaneGuardController.js";
import type { SessionsIndexStoreStatus } from "../src/v4/sessionsIndexStore.js";

// The controller only touches getState/getStatus/getSessions, so the store is stubbed structurally.
type FakeStore = RestoredPaneGuardControllerOptions["store"];

function makeStore(input: {
  workspaceId: string | null;
  status: SessionsIndexStoreStatus;
  sessionIds?: string[];
}): FakeStore {
  const sessions = (input.sessionIds ?? []).map((sessionId) => ({ sessionId }) as never);
  return {
    getState: () => ({ workspaceId: input.workspaceId }) as never,
    getStatus: () => input.status,
    getSessions: () => sessions,
  };
}

/** Deterministic fake timers: schedule/cancel are recorded, firing is manual. */
function makeFakeTimers() {
  let nextId = 1;
  const pending = new Map<number, () => void>();
  return {
    setTimeoutFn: ((handler: () => void) => {
      const id = nextId++;
      pending.set(id, handler);
      return id as never;
    }) as typeof setTimeout,
    clearTimeoutFn: ((id: number) => {
      pending.delete(id);
    }) as typeof clearTimeout,
    get size() {
      return pending.size;
    },
    fireAll() {
      // JS Map iteration tolerates deletion during iteration, so a fired handler can clear itself.
      for (const [, handler] of pending) handler();
    },
  };
}

function makeHarness(input: {
  workspaceId: string | null;
  status: SessionsIndexStoreStatus;
  sessionIds?: string[];
  sessionId?: string;
  graceMs?: number;
}) {
  const store = makeStore(input);
  const timers = makeFakeTimers();
  const confirmed: string[] = [];
  const missing: string[] = [];
  const sessionId = input.sessionId ?? "s1";
  const controller = createRestoredPaneGuardController({
    store,
    sessionId,
    onConfirmed: (id) => confirmed.push(id),
    onMissing: (id) => missing.push(id),
    graceMs: input.graceMs ?? 4_000,
    setTimeoutFn: timers.setTimeoutFn,
    clearTimeoutFn: timers.clearTimeoutFn,
  });
  return { controller, timers, confirmed, missing, sessionId };
}

test("connecting stays patient: no verdict and no grace timer", () => {
  const h = makeHarness({ workspaceId: null, status: "connecting" });
  h.controller.evaluate();
  assert.deepEqual(h.confirmed, []);
  assert.deepEqual(h.missing, []);
  assert.equal(h.timers.size, 0);
  h.controller.dispose();
});

test("idle stays patient: no verdict and no grace timer", () => {
  const h = makeHarness({ workspaceId: null, status: "idle" });
  h.controller.evaluate();
  assert.deepEqual(h.confirmed, []);
  assert.deepEqual(h.missing, []);
  assert.equal(h.timers.size, 0);
  h.controller.dispose();
});

test("dormant starts a grace timer and does not settle before it fires", () => {
  const h = makeHarness({ workspaceId: null, status: "dormant" });
  h.controller.evaluate();
  assert.equal(h.timers.size, 1);
  assert.deepEqual(h.confirmed, []);
  assert.deepEqual(h.missing, []);
  h.controller.dispose();
});

test("dormant + elapsed grace settles as kept (confirmed), never missing", () => {
  const h = makeHarness({ workspaceId: null, status: "dormant" });
  h.controller.evaluate();
  h.timers.fireAll();
  assert.deepEqual(h.confirmed, [h.sessionId]);
  assert.deepEqual(h.missing, []);
  h.controller.dispose();
});

test("error + elapsed grace settles as kept (confirmed)", () => {
  const h = makeHarness({ workspaceId: null, status: "error" });
  h.controller.evaluate();
  h.timers.fireAll();
  assert.deepEqual(h.confirmed, [h.sessionId]);
  assert.deepEqual(h.missing, []);
  h.controller.dispose();
});

test("snapshot present confirms the pane", () => {
  const h = makeHarness({
    workspaceId: "ws-1",
    status: "live",
    sessionIds: ["s1", "s2"],
  });
  h.controller.evaluate();
  assert.deepEqual(h.confirmed, [h.sessionId]);
  assert.deepEqual(h.missing, []);
  h.controller.dispose();
});

test("snapshot absent collapses the pane (missing)", () => {
  const h = makeHarness({
    workspaceId: "ws-1",
    status: "live",
    sessionIds: ["other"],
  });
  h.controller.evaluate();
  assert.deepEqual(h.confirmed, []);
  assert.deepEqual(h.missing, [h.sessionId]);
  h.controller.dispose();
});

test("a snapshot arriving while grace is pending clears the timer and yields one verdict", () => {
  // First evaluate while dormant starts the timer...
  const store: FakeStore = {
    getState: (() => {
      return { workspaceId: storeWorkspaceId } as never;
    }) as never,
    getStatus: (() => storeStatus) as never,
    getSessions: (() => storeSessions as never) as never,
  };
  let storeWorkspaceId: string | null = null;
  let storeStatus: SessionsIndexStoreStatus = "dormant";
  let storeSessions: Array<{ sessionId: string }> = [];
  const timers = makeFakeTimers();
  const confirmed: string[] = [];
  const missing: string[] = [];
  const controller = createRestoredPaneGuardController({
    store,
    sessionId: "s1",
    onConfirmed: (id) => confirmed.push(id),
    onMissing: (id) => missing.push(id),
    setTimeoutFn: timers.setTimeoutFn,
    clearTimeoutFn: timers.clearTimeoutFn,
  });

  controller.evaluate();
  assert.equal(timers.size, 1);

  // ...then the snapshot lands and the store emits.
  storeWorkspaceId = "ws-1";
  storeStatus = "live";
  storeSessions = [{ sessionId: "s1" }];
  controller.evaluate();

  assert.deepEqual(confirmed, ["s1"]);
  assert.deepEqual(missing, []);
  assert.equal(timers.size, 0, "grace timer must be cleared once the snapshot settles the pane");

  // Firing the (now-cleared) grace must not produce a second verdict.
  timers.fireAll();
  assert.deepEqual(confirmed, ["s1"]);
  controller.dispose();
});

test("dispose before grace fires yields no callback, and repeated evaluates start one timer", () => {
  const h = makeHarness({ workspaceId: null, status: "dormant" });
  h.controller.evaluate();
  h.controller.evaluate();
  h.controller.evaluate();
  assert.equal(h.timers.size, 1, "repeated evaluates must not stack timers");
  h.controller.dispose();
  assert.equal(h.timers.size, 0, "dispose must clear the pending timer");
  h.timers.fireAll();
  assert.deepEqual(h.confirmed, []);
  assert.deepEqual(h.missing, []);
});

test("after settling, further evaluates are no-ops (single verdict)", () => {
  const h = makeHarness({
    workspaceId: "ws-1",
    status: "live",
    sessionIds: ["s1"],
  });
  h.controller.evaluate();
  h.controller.evaluate();
  assert.deepEqual(h.confirmed, [h.sessionId]);
  h.controller.dispose();
});
