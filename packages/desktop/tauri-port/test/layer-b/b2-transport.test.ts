/*
 * Layer B2 — renderer↔Host connection bridge (transport sequencing, headless).
 *
 * Proves `SIDECAR-TRANSPORT.md §6` step 4's glue without a live sidecar/websocket: the pure
 * `hostWsUrl` enforces the loopback-only rule (127.0.0.1), and `connectTauriHost` MUST discover the
 * ephemeral port FIRST, then open the reused `connectViaWebSocket` at `ws://127.0.0.1:<port>`. The
 * real WS-RPC round-trip over that transport is already proven in Layer A (`a1-ws-rpc.test.ts`); this
 * test pins the ORDER + URL construction that the gated runtime factory will depend on.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  connectTauriHost,
  hostWsUrl,
  type TauriHostConnectionDeps,
} from "../../../src/renderer/src/tauriHostConnection.ts";

test("B2: hostWsUrl is loopback-only for any port", () => {
  assert.equal(hostWsUrl(8123), "ws://127.0.0.1:8123");
  assert.equal(hostWsUrl(0), "ws://127.0.0.1:0");
  assert.equal(hostWsUrl(65535), "ws://127.0.0.1:65535");
});

test("B2: connectTauriHost discovers the port then connects at the loopback URL", async () => {
  const seen: string[] = [];
  const accessor = { __fake: true };
  const deps = {
    discoverPort: async () => {
      seen.push("discover");
      return 5555;
    },
    connect: async (url: string) => {
      seen.push(`connect:${url}`);
      return accessor;
    },
    // The fake `connect` returns a sentinel, not a real IServiceAccessor; cast for the test seam.
  } as unknown as TauriHostConnectionDeps;

  const result = await connectTauriHost(deps);

  // Discover strictly before connect, and connect to the loopback URL for the discovered port.
  assert.deepEqual(seen, ["discover", "connect:ws://127.0.0.1:5555"]);
  assert.equal(result, accessor);
});
