/*
 * Layer A1 — WS RPC round-trip.
 *
 * Promotes the proven PoC (`poc/ws-rpc-roundtrip.ts`) into a `node:test`. It
 * asserts the transport/protocol seam: a production `@zcode/client` WebSocket
 * proxy call reaches a `@zcode/rpc` `ChannelServer` over a localhost `ws` socket
 * and echoes the exact payload back, within a bounded time. This is the smallest
 * end-to-end proof named in `SIDECAR-TRANSPORT.md` §6 step 5.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { startWsRpcHost } from "./_host.ts";

/** Generous wall-clock bound for a localhost round-trip (PoC measured ~4ms). */
const ROUNDTRIP_BUDGET_MS = 2_000;

test("A1: subagents.list round-trips over the localhost WS host transport", async () => {
  const echoService = {
    list: async (params: unknown): Promise<unknown[]> => [
      { kind: "echo", received: params, ok: true },
    ],
  };

  const { client, dispose } = await startWsRpcHost(echoService);
  try {
    const t0 = performance.now();
    const result = (await client.subagentsService.list({ probe: "hello" } as never)) as unknown;
    const elapsed = performance.now() - t0;

    assert.ok(Array.isArray(result), "round-trip result must be an array");
    const row = (result as Array<Record<string, unknown>>)[0];
    assert.equal(row?.kind, "echo");
    assert.equal(row?.ok, true);
    assert.deepEqual(row?.received, { probe: "hello" });
    assert.ok(
      elapsed < ROUNDTRIP_BUDGET_MS,
      `round-trip exceeded ${ROUNDTRIP_BUDGET_MS}ms budget (${Math.round(elapsed)}ms)`,
    );
  } finally {
    await dispose();
  }
});
