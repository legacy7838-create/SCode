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
// zcode-buffer
// ---------------------------------------------------------------------------
const buffer = load("zcode-buffer");

check("buffer.alloc returns Uint8Array", () => {
  assertUint8Array(buffer.alloc(8), "alloc result");
});

check("buffer.concat accepts Uint8Array[] and returns Uint8Array", () => {
  const joined = buffer.concat([wireJson, wireJson]);
  assertUint8Array(joined, "concat result");
  assert.equal(joined.byteLength, wireJson.byteLength * 2);
});

check("buffer.slice returns Uint8Array", () => {
  assertUint8Array(buffer.slice(wireJson, 0, 2), "slice result");
});

check("buffer.copyInto / readUint32Be / writeUint32Be accept Uint8Array", () => {
  const written = buffer.writeUint32Be(wireJson, 0x11223344, 0);
  assertUint8Array(written, "writeUint32Be result");
  assert.equal(buffer.readUint32Be(written, 0), 0x11223344);
  const copied = buffer.copyInto(wireJson, wireJson.subarray(0, 2), 4);
  assertUint8Array(copied, "copyInto result");
});

check("buffer.stringToBytes returns Uint8Array and bytesToString accepts it", () => {
  const bytes = buffer.stringToBytes("héllo");
  assertUint8Array(bytes, "stringToBytes result");
  assert.equal(buffer.bytesToString(bytes), "héllo");
});

// ---------------------------------------------------------------------------
// zcode-protocol
// ---------------------------------------------------------------------------
const protocol = load("zcode-protocol");

check("protocol.writeProtocolMessage accepts Uint8Array and returns Uint8Array", () => {
  const raw = protocol.writeProtocolMessage(0, 7, 0, wireJson);
  assertUint8Array(raw, "writeProtocolMessage result");
  const parsed = protocol.parseProtocolHeader(raw, 0);
  assert.equal(parsed.id, 7);
  assert.equal(parsed.bodyLength, wireJson.byteLength);
});

check("protocol.parseProtocolHeader accepts Buffer", () => {
  const raw = protocol.writeProtocolMessage(0, 9, 3, Buffer.from(wireJson));
  assertUint8Array(raw, "writeProtocolMessage(Buffer) result");
  assert.equal(protocol.parseProtocolHeader(Buffer.from(raw), 0).ack, 3);
});

// ---------------------------------------------------------------------------
// zcode-chunkstream
// ---------------------------------------------------------------------------
const chunkstream = load("zcode-chunkstream");

check("chunkstream accepts Uint8Array and returns Uint8Array", () => {
  const stream = chunkstream.createChunkStream();
  stream.acceptChunk(wireJson.subarray(0, 2));
  stream.acceptChunk(Buffer.from(wireJson.subarray(2)));
  assert.equal(stream.byteLength(), wireJson.byteLength);
  assertUint8Array(stream.peek(4), "chunkstream.peek result");
  assert.equal(stream.skip(4), true);
  const rest = stream.read(wireJson.byteLength - 4);
  assertUint8Array(rest, "chunkstream.read result");
  assert.equal(
    Buffer.from(rest).toString("hex"),
    Buffer.from(wireJson.subarray(4)).toString("hex"),
  );
});

// ---------------------------------------------------------------------------
// zcode-channel
// ---------------------------------------------------------------------------
const channel = load("zcode-channel");

check("channel.buildRequest returns Uint8Array / parseServerRequest accepts it", () => {
  const raw = channel.buildRequest(1, 4, "chan", "method", JSON.stringify({ a: 1 }));
  assertUint8Array(raw, "buildRequest result");
  const parsed = channel.parseServerRequest(raw);
  assert.equal(parsed.channelName, "chan");
  assert.equal(parsed.methodName, "method");
  assert.equal(parsed.id, 4);
});

check("channel.buildResponse returns Uint8Array / parseClientResponse accepts it", () => {
  const raw = channel.buildResponse(2, 5, JSON.stringify({ ok: true }));
  assertUint8Array(raw, "buildResponse result");
  const parsed = channel.parseClientResponse(raw);
  assert.equal(parsed.id, 5);
  assert.deepEqual(JSON.parse(parsed.dataJson), { ok: true });
});

if (failures.length > 0) {
  process.stdout.write(`\n${failures.length} byte-boundary check(s) failed\n`);
  process.exit(1);
}
process.stdout.write("\nall byte-boundary checks passed\n");
