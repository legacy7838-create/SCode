#!/usr/bin/env node
/**
 * Byte-boundary smoke test for the native `.node` modules.
 *
 * 背景（bug fix 说明）：TS 侧 wrapper 声明的参数/返回类型统一是 `Uint8Array`，但 napi 3 的
 * `Vec<u8>` 绑定走的是 `Vec<T> -> Array::from_napi_value -> napi_get_array_length`，只接受
 * 真正的 JS `Array<number>`。传入 `Uint8Array` 会抛 `ArrayExpected: Failed to get Array
 * length`（即 desktop 日志里 `measureTopicNotificationEnvelopeBytes` 报错的根因）；返回时
 * 同样给出普通 Array 而不是 Uint8Array。
 *
 * 本脚本按生产调用方式（TextEncoder/Uint8Array/subarray/Buffer）直接加载 `.node` 冒烟，
 * 覆盖所有跨边界收发字节的入口，锁定 `Uint8Array` 契约。规范见
 * docs/specs/rust-native-ports.md 的 "Byte boundary" 一节。
 *
 * 用法：node packages/rust/scripts/smoke-byte-boundary.mjs
 */
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const require = createRequire(import.meta.url);
const rustRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

function load(crate) {
  const { nativePlatformTarget } = require(join(rustRoot, "dist/loader.js"));
  return require(join(rustRoot, `${crate}.${nativePlatformTarget()}.node`));
}

const failures = [];
function check(name, fn) {
  try {
    fn();
    process.stdout.write(`  ok  ${name}\n`);
  } catch (error) {
    failures.push({ name, error });
    process.stdout.write(`  FAIL ${name}: ${error?.code ?? ""} ${error?.message}\n`);
  }
}

/** Every byte value crossing the boundary must be a Uint8Array, never a plain Array. */
function assertUint8Array(value, label) {
  assert.ok(
    value instanceof Uint8Array,
    `${label} must be a Uint8Array, got ${value?.constructor?.name}`,
  );
}

const encoder = new TextEncoder();
const utf8 = (text) => encoder.encode(text);

// ---------------------------------------------------------------------------
// zcode-codec
// ---------------------------------------------------------------------------
const codec = load("zcode-codec");
const wireJson = utf8(JSON.stringify({ wireVersion: 1, kind: "complete", topic: "t" }));

check("codec.measureEnvelopeBytes accepts Uint8Array", () => {
  const m = codec.measureEnvelopeBytes(wireJson, 204, 13);
  assert.equal(typeof m.maxBytes, "number");
  assert.ok(m.maxBytes > 0);
});

check("codec.measureTopicEnvelopeBytes accepts Uint8Array", () => {
  const m = codec.measureTopicEnvelopeBytes(wireJson);
  assert.ok(m.maxBytes > 0);
});

check("codec.crc32Hex accepts Uint8Array", () => {
  assert.match(codec.crc32Hex(wireJson), /^[0-9a-f]{8}$/);
});

check("codec.base64Encode accepts Uint8Array and subarray views", () => {
  assert.equal(codec.base64Encode(wireJson.subarray(0, 3)), "eyJ3");
});

check("codec.base64Decode returns Uint8Array", () => {
  const decoded = codec.base64Decode("aGk=");
  assertUint8Array(decoded, "base64Decode result");
  assert.equal(Buffer.from(decoded).toString(), "hi");
});

check("codec.base64Decode accepts Buffer input roundtrip", () => {
  const decoded = codec.base64Decode(codec.base64Encode(wireJson));
  assertUint8Array(decoded, "base64Decode(Buffer) result");
  assert.equal(Buffer.from(decoded).toString("utf8"), Buffer.from(wireJson).toString("utf8"));
});

check("codec.vqlRead accepts Uint8Array and vqlWrite returns Uint8Array", () => {
  const written = codec.vqlWrite(300);
  assertUint8Array(written, "vqlWrite result");
  const [value, consumed] = codec.vqlRead(written, 0);
  assert.equal(value, 300);
  assert.equal(consumed, written.byteLength);
});

check("codec.vqlRead accepts Buffer", () => {
  const [value] = codec.vqlRead(Buffer.from(codec.vqlWrite(127)), 0);
  assert.equal(value, 127);
});

check("codec.rpcSerialize returns Uint8Array / rpcDeserialize accepts it", () => {
  const encoded = codec.rpcSerialize([1, "two", { three: true }]);
  assertUint8Array(encoded, "rpcSerialize result");
  const decoded = codec.rpcDeserialize(encoded);
  assert.deepEqual(decoded, [1, "two", { three: true }]);
});

check("codec.rpcDeserializeBatch accepts Uint8Array", () => {
  const encoded = codec.rpcSerializeBatch([1, "two"]);
  assertUint8Array(encoded, "rpcSerializeBatch result");
  const decoded = codec.rpcDeserializeBatch(encoded, 2);
  assert.deepEqual(decoded, [1, "two"]);
});

check("codec.crc32Batch accepts Uint8Array[]", () => {
  const results = codec.crc32Batch([wireJson, wireJson]);
  assert.equal(results.length, 2);
  assert.match(results[0], /^[0-9a-f]{8}$/);
});

check("codec.base64EncodeBatch accepts Uint8Array[]", () => {
  const results = codec.base64EncodeBatch([wireJson]);
  assert.equal(results[0], Buffer.from(wireJson).toString("base64"));
});

check("codec.base64DecodeBatch returns Uint8Array[]", () => {
  const results = codec.base64DecodeBatch([Buffer.from(wireJson).toString("base64")]);
  assert.equal(results.length, 1);
  assertUint8Array(results[0], "base64DecodeBatch result");
});

check("codec.encodeWireFrames accepts Uint8Array", () => {
  const frames = codec.encodeWireFrames(
    wireJson,
    "complete",
    "fid",
    0,
    "t",
    "sub",
    1 << 20,
    1 << 22,
  );
  assert.ok(Array.isArray(frames));
  assert.ok(frames.length > 0);
});

// ---------------------------------------------------------------------------
// 已删除的 crate 段落（bug fix 说明）
//
// 原来这里还有 zcode-buffer / zcode-protocol / zcode-chunkstream / zcode-channel 四段。
// 6e896ec 把这 4 个 v4-wire crate 连同它们的 wrapper 一起删除（零消费者、每平台 5 MB 的
// 死代码），但当时没有同步更新本脚本，导致脚本在加载 .node 时 MODULE_NOT_FOUND 直接崩溃 ——
// invariant 8 的验收门禁形同虚设。
//
// 修复：移除这 4 段，而不是把 crate 加回来。它们的 renderer TS 孪生实现
//（packages/shared/src/zcode-protocol-v4/）是无法承载 .node 的平台上的唯一实现
//（invariant 9：这不是 fallback），那里已经没有跨边界的字节可冒烟；仍然跨边界收发字节的
// 只剩 zcode-codec（wire 路径），由上面的段落覆盖。zcode-fs / zcode-image 的字节契约由
// 各自 port spec 的 direct-load smoke 验收（见 rust-native-ports.md invariant 8）。

if (failures.length > 0) {
  process.stdout.write(`\n${failures.length} byte-boundary check(s) failed\n`);
  process.exit(1);
}
process.stdout.write("\nall byte-boundary checks passed\n");
