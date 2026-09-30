/**
 * `@zcode/rpc/native` — Node-only binding of the RPC byte port to the Rust crates.
 *
 * 这个 subpath **只能**被 Node entrypoint import（desktop host / CLI / server / zcode-server-cli）。
 * renderer 与 browser bundle kabhi is module ko touch nahi karte, warna Vite `node:fs`
 * externalize karke renderer crash kar dega (docs/specs/rust-native-ports.md invariant 9)。
 * `packages/shared/scripts/check-native-graph.mjs` isko jaan-boojh kar chhodta hai, kyunki ye
 * directory sirf Node-only entrypoints se可达 hai.
 *
 * 为什么不走 "zero JS fallback" 的反面：这里没有任何 runtime 选择。process start par Node
 * entrypoint `installNativeRpcBytesPort()` call karta hai, uske baad port deterministically
 * native rehta hai; renderer me TS binding rehta hai. Dono ek hi implementation hoti hai per
 * process — kabhi "native fail hua to JS" jaisa switch nahi hota。
 */
import { loadCodec, type NativeCodecModule } from "@zcode/rust/codec";
import { bindRpcBytesPort, TS_BYTES_PORT, type IRpcBytesPort } from "../bytes-port.js";

let codec: NativeCodecModule | null = null;

function codecModule(): NativeCodecModule {
  codec ??= loadCodec();
  return codec;
}

/**
 * Node ka binding.
 *
 * Ye "native vs JS" switch nahi hai — ye **platform binding** hai, aur iske andar har primitive ka
 * implementation wahi hai jo us machine par sabse tez hai (docs/specs/rust-native-ports.md
 * invariant 10):
 *
 *   - `crc32Hex` → Rust `crc32fast` (x86-64 CRC32 instruction). Table-driven JavaScript se
 *     **28x–72x** tez (64 KB: 195 µs → 2.9 µs), aur bitwise loop se ~790x. Output byte-identical
 *     hai — parity gate yehi assert karta hai.
 *   - `base64*` → Node ka apna C++ `Buffer` codec, ye jaan-boojh kar port nahi kiya: SIMD
 *     `base64` crate bhi Node se slow nikla (64 KB par 0.42x), to port karna sirf regression hota.
 *   - `vql*`, `alloc`, `slice`, `concat` → inmein compute itna chhota hai (sub-microsecond) ki napi
 *     boundary ka fixed cost dominate karta hai (vqlRead par 21x–29x slower), isliye inhe port nahi
 *     kiya. Ye Rust fallback nahi hai: inke liye platform ka implementation hi sahi hai.
 *
 * Is module ka import sirf Node entrypoints karte hain, kabhi renderer nahi.
 */
const NODE_BYTES_PORT: IRpcBytesPort = {
  ...TS_BYTES_PORT,

  // Only the measured win is ported; everything else is inherited from the platform binding,
  // because each of those primitives measured *slower* through the napi boundary.
  crc32Hex: (bytes) => codecModule().crc32Hex(bytes),
};

/**
 * Binds the RPC byte primitives for Node. Call once at Node startup, before any RPC traffic.
 * Throws loudly when a binary is missing — there is deliberately no JavaScript fallback here
 * (spec invariant 1).
 */
export function installNativeRpcBytesPort(): void {
  // Fail fast at startup rather than on the first frame.
  codecModule();
  bindRpcBytesPort(NODE_BYTES_PORT);
}
