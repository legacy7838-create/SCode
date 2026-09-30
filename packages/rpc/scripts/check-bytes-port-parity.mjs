#!/usr/bin/env node
/**
 * Byte-port parity gate: the Rust binding and the TypeScript binding must be byte-identical.
 *
 * 背景（bug fix 说明）：`@zcode/rpc` ka byte port do platform bindings rakhta hai — Node par
 * Rust (`zcode-codec` / `zcode-buffer`), renderer par TypeScript. Ye dono "fallback" nahi hain,
 * do alag platforms ke hain; isliye dono ka output **exactly** same hona zaroori hai, warna ek
 * platform par wire bytes badal jayenge aur dusre par protocol toot jayega.
 *
 * Ye script dono bindings ko same inputs deta hai aur har primitive par compare karti hai.
 * Native binding Node-only hai, isliye ye gate Node me chalta hai.
 *
 * 用法：node_modules/.bin/tsx packages/rpc/scripts/check-bytes-port-parity.mjs
 * （tsx is required because `@zcode/rust` package exports point at its TypeScript sources.）
 */
import assert from "node:assert/strict";

const { TS_BYTES_PORT } = await import("../src/bytes-port.ts");
const { installNativeRpcBytesPort } = await import("../src/native/bytes-port-native.ts");
const { rpcBytesPort } = await import("../src/bytes-port.ts");

installNativeRpcBytesPort();
const NATIVE = rpcBytesPort();
if (NATIVE === TS_BYTES_PORT) {
  throw new Error("installNativeRpcBytesPort() did not bind the native port");
}

let checks = 0;
const failures = [];
function same(name, tsFn, nativeFn) {
  checks += 1;
  try {
    const a = tsFn();
    const b = nativeFn();
    assert.deepStrictEqual(b, a);
    process.stdout.write(`  ok  ${name}\n`);
  } catch (error) {
    failures.push(name);
    process.stdout.write(`  FAIL ${name}: ${error.message.split("\n")[0]}\n`);
  }
}

const encoder = new TextEncoder();

// Deterministic pseudo-random bytes so the sweep is reproducible.
function pseudoBytes(length, seed) {
  const out = new Uint8Array(length);
  let state = seed >>> 0;
  for (let i = 0; i < length; i += 1) {
    state = (state * 1664525 + 1013904223) >>> 0;
    out[i] = (state >>> 24) & 0xff;
  }
  return out;
}

const samples = [
  new Uint8Array(0),
  Uint8Array.of(0),
  Uint8Array.of(127),
  Uint8Array.of(128),
  Uint8Array.of(255),
  encoder.encode("hello"),
  encoder.encode("héllo — 世界 🌍"),
  pseudoBytes(1, 7),
  pseudoBytes(63, 11),
  pseudoBytes(64, 13),
  pseudoBytes(1024, 17),
  pseudoBytes(65_536, 19),
];

// ---- zcode-codec ----
for (const bytes of samples) {
  const label = `len=${bytes.length}`;
  same(
    `base64Encode roundtrip ${label}`,
    () => TS_BYTES_PORT.base64Encode(bytes),
    () => NATIVE.base64Encode(bytes),
  );
  same(
    `base64Decode roundtrip ${label}`,
    () => {
      const text = TS_BYTES_PORT.base64Encode(bytes);
      return Array.from(TS_BYTES_PORT.base64Decode(text));
    },
    () => {
      const text = NATIVE.base64Encode(bytes);
      return Array.from(NATIVE.base64Decode(text));
    },
  );
}

for (const value of [0, 1, 127, 128, 300, 16_383, 16_384, 1_000_000, 0xffff_ffff]) {
  same(
    `vqlWrite(${value})`,
    () => Array.from(TS_BYTES_PORT.vqlWrite(value)),
    () => Array.from(NATIVE.vqlWrite(value)),
  );
  const encoded = Array.from(TS_BYTES_PORT.vqlWrite(value));
  same(
    `vqlRead(${value})`,
    () => TS_BYTES_PORT.vqlRead(Uint8Array.from(encoded), 0),
    () => NATIVE.vqlRead(Uint8Array.from(encoded), 0),
  );
  // Offset handling: a 3-byte prefix must be skipped identically on both sides.
  const withPrefix = new Uint8Array([9, 9, 9, ...encoded]);
  same(
    `vqlRead(${value}) at offset 3`,
    () => TS_BYTES_PORT.vqlRead(withPrefix, 3),
    () => NATIVE.vqlRead(withPrefix, 3),
  );
}

// ---- zcode-buffer ----
same(
  "alloc",
  () => Array.from(TS_BYTES_PORT.alloc(37)),
  () => Array.from(NATIVE.alloc(37)),
);
same(
  "concat",
  () => Array.from(TS_BYTES_PORT.concat(samples.slice(2, 6))),
  () => Array.from(NATIVE.concat(samples.slice(2, 6))),
);
same(
  "concat totalLength",
  () => Array.from(TS_BYTES_PORT.concat(samples.slice(2, 5), 9)),
  () => Array.from(NATIVE.concat(samples.slice(2, 5), 9)),
);
same(
  "slice",
  () => Array.from(TS_BYTES_PORT.slice(samples[8], 3, 11)),
  () => Array.from(NATIVE.slice(samples[8], 3, 11)),
);
same(
  "slice open-ended",
  () => Array.from(TS_BYTES_PORT.slice(samples[8], 1000)),
  () => Array.from(NATIVE.slice(samples[8], 1000)),
);
same(
  "slice past end (must not panic)",
  () => Array.from(TS_BYTES_PORT.slice(samples[8], 60, 9999)),
  () => Array.from(NATIVE.slice(samples[8], 60, 9999)),
);
same(
  "slice inverted range",
  () => Array.from(TS_BYTES_PORT.slice(samples[8], 10, 2)),
  () => Array.from(NATIVE.slice(samples[8], 10, 2)),
);
same(
  "slice empty",
  () => Array.from(TS_BYTES_PORT.slice(samples[0], 0)),
  () => Array.from(NATIVE.slice(samples[0], 0)),
);
same(
  "concat budget smaller than input",
  () => Array.from(TS_BYTES_PORT.concat(samples.slice(2, 6), 4)),
  () => Array.from(NATIVE.concat(samples.slice(2, 6), 4)),
);
same(
  "concat budget 0",
  () => Array.from(TS_BYTES_PORT.concat(samples.slice(2, 6), 0)),
  () => Array.from(NATIVE.concat(samples.slice(2, 6), 0)),
);
same(
  "concat empty",
  () => Array.from(TS_BYTES_PORT.concat([])),
  () => Array.from(NATIVE.concat([])),
);
same(
  "readUInt32BE",
  () => TS_BYTES_PORT.readUInt32BE(samples[8], 5),
  () => NATIVE.readUInt32BE(samples[8], 5),
);
// Out-of-range must degrade like `Uint8Array` indexing (reads as 0) on both sides. A Rust panic
// inside a napi call aborts the process, so these cases are asserted explicitly.
same(
  "readUInt32BE past end",
  () => TS_BYTES_PORT.readUInt32BE(samples[8], 100),
  () => NATIVE.readUInt32BE(samples[8], 100),
);
same(
  "readUInt32BE empty",
  () => TS_BYTES_PORT.readUInt32BE(samples[0], 0),
  () => NATIVE.readUInt32BE(samples[0], 0),
);
same(
  "writeUInt32BE",
  () => {
    const b = samples[9].slice();
    TS_BYTES_PORT.writeUInt32BE(b, 0xdeadbeef, 4);
    return Array.from(b);
  },
  () => {
    const b = samples[9].slice();
    NATIVE.writeUInt32BE(b, 0xdeadbeef, 4);
    return Array.from(b);
  },
);
// In-place write must not grow the buffer (the two bindings used to disagree here).
same(
  "writeUInt32BE on too-small buffer",
  () => {
    const b = samples[7].slice();
    TS_BYTES_PORT.writeUInt32BE(b, 0xdeadbeef, 4);
    return Array.from(b);
  },
  () => {
    const b = samples[7].slice();
    NATIVE.writeUInt32BE(b, 0xdeadbeef, 4);
    return Array.from(b);
  },
);
same(
  "stringToBytes",
  () => Array.from(TS_BYTES_PORT.stringToBytes("héllo — 世界")),
  () => Array.from(NATIVE.stringToBytes("héllo — 世界")),
);
same(
  "bytesToString",
  () => TS_BYTES_PORT.bytesToString(encoder.encode("héllo")),
  () => NATIVE.bytesToString(encoder.encode("héllo")),
);
same(
  "bytesToString invalid utf8",
  () => TS_BYTES_PORT.bytesToString(Uint8Array.of(0xff, 0xfe)),
  () => NATIVE.bytesToString(Uint8Array.of(0xff, 0xfe)),
);

// ---- crc32: the one primitive that must be byte-identical AND fast ----
// The new slicing-by-4 JavaScript must agree with the hardware-CRC32 Rust on every alignment,
// length and tail combination, otherwise wire checksums would diverge per platform.
for (const bytes of samples) {
  same(
    `crc32Hex len=${bytes.length}`,
    () => TS_BYTES_PORT.crc32Hex(bytes),
    () => NATIVE.crc32Hex(bytes),
  );
}
for (let len = 0; len <= 40; len += 1) {
  const bytes = pseudoBytes(len, 31);
  same(
    `crc32Hex len=${len} sweep`,
    () => TS_BYTES_PORT.crc32Hex(bytes),
    () => NATIVE.crc32Hex(bytes),
  );
}
// Known-good ISO 3309 vectors.
same(
  "crc32Hex '123456789' = cbf43926",
  () => TS_BYTES_PORT.crc32Hex(encoder.encode("123456789")),
  () => NATIVE.crc32Hex(encoder.encode("123456789")),
);
same(
  "crc32Hex empty = 00000000",
  () => TS_BYTES_PORT.crc32Hex(new Uint8Array(0)),
  () => NATIVE.crc32Hex(new Uint8Array(0)),
);

if (failures.length > 0) {
  process.stdout.write(`\n${failures.length}/${checks} parity checks FAILED\n`);
  process.exit(1);
}
process.stdout.write(
  `\nall ${checks} byte-port parity checks passed (TS binding === Rust binding)\n`,
);
