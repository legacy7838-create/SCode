#!/usr/bin/env node
/**
 * Byte-port benchmark: TypeScript binding vs Rust binding.
 *
 * Ye script is baat ko measurable banata hai. Iska ek important result hai (2026-09-29, is repo
 * par): `@zcode/rpc` ke byte primitives (vql / base64 / alloc / slice) Rust se **slower** hain
 * Node par, kyunki:
 *   1. `base64` Node ka built-in `Buffer.from(...).toString("base64")` already C++ me hai —
 *      Rust crate add karke humein FFI boundary + ek extra copy milti hai, compute kam nahi hota.
 *   2. `vqlRead` 1–2 byte varint decode karta hai; TS me wo ek tight loop me zero allocation ke
 *      saath hota hai, jabki native call par napi `create_reference` + `Buffer` construction
 *      ka fixed cost (>0.5us) dominate karta hai.
 *
 * Isliye in primitives ka native binding **default me install nahi** kiya gaya. Ye port tabhi
 * profitable hai jab payload itna bada ho ki compute, FFI cost se kaafi upar ho (image / diff /
 * git jaise full-payload ports me).
 *
 * 用法：node_modules/.bin/tsx packages/rpc/scripts/bench-bytes-port.mjs
 */
import { installNativeRpcBytesPort } from "../src/native/bytes-port-native.ts";
import { TS_BYTES_PORT } from "../src/bytes-port.ts";

installNativeRpcBytesPort();
const { rpcBytesPort } = await import("../src/bytes-port.ts");
const NATIVE = rpcBytesPort();

const encoder = new TextEncoder();

function timeMicroseconds(fn, iterations) {
  for (let i = 0; i < Math.max(1, iterations / 10); i += 1) fn(); // warmup
  const start = process.hrtime.bigint();
  for (let i = 0; i < iterations; i += 1) fn();
  return Number(process.hrtime.bigint() - start) / 1e3 / iterations;
}

function row(label, ts, native, iterations) {
  const tsUs = timeMicroseconds(ts, iterations);
  const nativeUs = timeMicroseconds(native, iterations);
  const ratio = nativeUs / tsUs;
  const verdict = ratio < 1 ? "RUST FASTER" : ratio < 1.15 ? "even" : "RUST SLOWER";
  process.stdout.write(
    `${label.padEnd(32)} TS ${tsUs.toFixed(2).padStart(8)}us   RUST ${nativeUs
      .toFixed(2)
      .padStart(8)}us   ${ratio.toFixed(2).padStart(6)}x  ${verdict}\n`,
  );
}

process.stdout.write("byte-port benchmark (lower is better)\n\n");
for (const size of [16, 256, 4096, 65536, 1_000_000]) {
  const bytes = encoder.encode("x".repeat(size));
  row(
    `base64Encode len=${size}`,
    () => TS_BYTES_PORT.base64Encode(bytes),
    () => NATIVE.base64Encode(bytes),
    size > 100_000 ? 200 : 2000,
  );
}
const twoByteVarint = Uint8Array.of(0xac, 0x02);
row(
  "vqlRead (2-byte varint)",
  () => TS_BYTES_PORT.vqlRead(twoByteVarint, 0),
  () => NATIVE.vqlRead(twoByteVarint, 0),
  20_000,
);
const frame = encoder.encode("y".repeat(20_000));
row(
  "vqlRead offset on 20KB",
  () => TS_BYTES_PORT.vqlRead(frame, 1),
  () => NATIVE.vqlRead(frame, 1),
  20_000,
);
row(
  "alloc 4096",
  () => TS_BYTES_PORT.alloc(4096),
  () => NATIVE.alloc(4096),
  20_000,
);
row(
  "slice len=4096",
  () => TS_BYTES_PORT.slice(frame, 0, 4096),
  () => NATIVE.slice(frame, 0, 4096),
  20_000,
);
row(
  "concat 8x4KB",
  () => TS_BYTES_PORT.concat(new Array(8).fill(frame.subarray(0, 4096))),
  () => NATIVE.concat(new Array(8).fill(frame.subarray(0, 4096))),
  20_000,
);

process.stdout.write("\ncrc32Hex (the primitive Rust actually wins)\n\n");
for (const size of [256, 4096, 65_536, 1_000_000]) {
  const bytes = encoder.encode("z".repeat(size));
  row(
    `crc32Hex len=${size}`,
    () => TS_BYTES_PORT.crc32Hex(bytes),
    () => NATIVE.crc32Hex(bytes),
    size > 100_000 ? 100 : 2000,
  );
}

process.stdout.write(
  "\nConclusion: only crc32 (and any full-payload compute) is worth porting; the byte\n" +
    "primitives are not, because the napi boundary cost exceeds their decode cost.\n" +
    "See docs/specs/rust-native-ports.md invariant 10 before changing this decision.\n",
);
