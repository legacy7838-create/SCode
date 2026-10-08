/*
 * Layer A2 — binary framing sanity over the same WS RPC stack.
 *
 * Per `TEST-HARNESS.md` §6, the RPC framing (`packages/rpc/src/serialization.ts`)
 * tags binary payloads (`DataType.Buffer`) and base64-marks/restores nested
 * `Uint8Array`s inside objects. A truthiness-only round-trip would hide a framing
 * regression, so these assertions check BYTE-LEVEL equality and that binary stays
 * binary (not degraded to `{ "0": .., "1": .. }` object form) across the wire.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { startWsRpcHost } from "./_host.ts";

/**
 * Echo service that returns whatever single argument it was called with, wrapped
 * in the `subagents.list` result row shape. ProxyChannel serializes the argument
 * on the way in and the result on the way out, exercising both framing paths.
 */
const echoService = {
  list: async (params: unknown): Promise<unknown[]> => [
    { kind: "echo", received: params, ok: true },
  ],
};

/** Bytes that a naive JSON expansion or latin1/locale round-trip would corrupt. */
const TRICKY_BYTES: number[] = [0x00, 0x01, 0x7f, 0x80, 0xff, 0xfe, 0x41, 0x0a, 0x0d];

function firstRow(result: unknown): Record<string, unknown> {
  assert.ok(Array.isArray(result), "round-trip result must be an array");
  const row = (result as Array<Record<string, unknown>>)[0];
  assert.ok(row, "result array must contain a row");
  return row;
}

test("A2: a top-level binary (Uint8Array) argument survives the WS framing unchanged", async () => {
  const { client, dispose } = await startWsRpcHost(echoService);
  try {
    const payload = new Uint8Array(TRICKY_BYTES);
    const row = firstRow(await client.subagentsService.list(payload as never));

    assert.equal(row.kind, "echo");
    assert.equal(row.ok, true);
    // Framing must return a real Uint8Array — not a JSON-degraded plain object.
    assert.ok(
      row.received instanceof Uint8Array,
      `expected Uint8Array, got ${typeof row.received} (${JSON.stringify(row.received)})`,
    );
    assert.equal((row.received as Uint8Array).byteLength, TRICKY_BYTES.length);
    assert.deepEqual(
      Array.from(row.received as Uint8Array),
      TRICKY_BYTES,
      "binary bytes must round-trip byte-for-byte",
    );
  } finally {
    await dispose();
  }
});

test("A2: a nested Uint8Array inside a non-trivial object round-trips byte-exact", async () => {
  const { client, dispose } = await startWsRpcHost(echoService);
  try {
    const payload = {
      name: "archive.bin",
      meta: { depth: 2, tags: ["a", "b"], ok: true },
      blob: new Uint8Array(TRICKY_BYTES),
    };
    const row = firstRow(await client.subagentsService.list(payload as never));

    assert.equal(row.kind, "echo");
    const received = row.received as typeof payload;
    // Sibling non-binary structure is preserved unchanged.
    assert.equal(received.name, "archive.bin");
    assert.deepEqual(received.meta, { depth: 2, tags: ["a", "b"], ok: true });
    // Nested binary is restored as a Uint8Array (base64 marker path), byte-equal.
    assert.ok(
      received.blob instanceof Uint8Array,
      `nested blob lost binary type: ${JSON.stringify(received.blob)}`,
    );
    assert.equal(Buffer.compare(Buffer.from(received.blob), Buffer.from(TRICKY_BYTES)), 0);
  } finally {
    await dispose();
  }
});
