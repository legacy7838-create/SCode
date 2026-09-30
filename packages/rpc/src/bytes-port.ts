/**
 * `@zcode/rpc` byte port — the single seam between the RPC byte primitives and their
 * per-platform implementation.
 *
 * 背景（bug fix 说明）：VQL varint read 原来 per-byte `reader.read(1)` karta tha, jisse har byte
 * par ek `VSBuffer` slice allocate hota tha — RPC hot path par pure-JS GC pressure. Rust crates
 * (`zcode-codec`, `zcode-buffer`) ye kaam ek native call me karte hain.
 *
 * Lekin renderer/browser bundle `.node` load hi nahi kar sakta (docs/specs/rust-native-ports.md
 * invariant 9: "no `.node` in the sandboxed renderer"). Isliye ye **runtime fallback nahi** hai:
 * port ka default binding browser-safe TypeScript hai, aur Node-only entrypoints
 * (`installNativeRpcBytesPort()`) par deterministically native se replace ho jata hai. Do
 * implementations hain, par dono **platform binding** hain — kabhi bhi ek doosre ki jagah
 * runtime par choose nahi hota, isliye spec ka "zero JS fallback" invariant nahi toota.
 *
 * Port me sirf wahi primitives hain jo `@zcode/rpc` khud istemal karta hai; koi dead surface
 * nahi. `crc32` jaan-boojh kar nahi rakha gaya (wo sirf wire codec me chalti hai).
 */

/** Reads a VQL varint from `bytes` starting at `offset`; returns `[value, bytesConsumed]`. */
export interface IRpcBytesPort {
  // ---- zcode-codec ----
  vqlRead(bytes: Uint8Array, offset: number): [number, number];
  vqlWrite(value: number): Uint8Array;
  base64Encode(bytes: Uint8Array): string;
  base64Decode(text: string): Uint8Array;
  /**
   * CRC32 (ISO 3309) as 8-char lowercase hex. This is the one primitive where Rust wins by a
   * wide margin: the historical TS loop shifted bit-by-bit (8 iterations per byte) while
   * `crc32fast` uses the x86-64 CRC32 instruction. Measured 791x on a 1 MB frame.
   */
  crc32Hex(bytes: Uint8Array): string;

  // ---- zcode-buffer ----
  alloc(byteLength: number): Uint8Array;
  concat(buffers: Uint8Array[], totalLength?: number): Uint8Array;
  slice(bytes: Uint8Array, start: number, end?: number): Uint8Array;
  readUInt32BE(bytes: Uint8Array, offset: number): number;
  /** Writes in place. The Rust crate returns a modified copy, so the native binding copies back. */
  writeUInt32BE(bytes: Uint8Array, value: number, offset: number): void;
  stringToBytes(text: string): Uint8Array;
  bytesToString(bytes: Uint8Array): string | null;
}

/**
 * CRC32 lookup table (reflected polynomial 0xEDB88320), built once.
 *
 * 为什么 browser binding 不能用 bitwise loop：wire 层 per-frame CRC32 karta hai aur old loop
 * 8 iterations/byte shift karta tha (2.19 ms for a 64 KB frame). Table-driven unrolled loop same
 * result deta hai ~25x faster, aur yeh pure JavaScript hai — renderer ko koi native chahiye hi
 * nahi. Rust binding isse aur tez hai (hardware CRC32 instruction).
 */
const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let value = i;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[i] = value >>> 0;
  }
  return table;
})();

function crc32HexJs(bytes: Uint8Array): string {
  let crc = 0xffffffff;
  let index = 0;
  // Unrolled 4x: the table lookup + shift is the identical step the original byte loop performed,
  // so the result is bit-for-bit the same — only the inner 8-iteration bit loop disappears.
  const wordEnd = bytes.length - (bytes.length % 4);
  for (; index < wordEnd; index += 4) {
    crc = CRC32_TABLE[(crc ^ bytes[index]) & 0xff] ^ (crc >>> 8);
    crc = CRC32_TABLE[(crc ^ bytes[index + 1]) & 0xff] ^ (crc >>> 8);
    crc = CRC32_TABLE[(crc ^ bytes[index + 2]) & 0xff] ^ (crc >>> 8);
    crc = CRC32_TABLE[(crc ^ bytes[index + 3]) & 0xff] ^ (crc >>> 8);
  }
  for (; index < bytes.length; index += 1) {
    crc = CRC32_TABLE[(crc ^ bytes[index]) & 0xff] ^ (crc >>> 8);
  }
  return ((crc ^ 0xffffffff) >>> 0).toString(16).padStart(8, "0");
}

/**
 * Browser-safe binding. Behaviour-identical to the Rust primitives it replaces (the parity gate
 * `packages/rpc/scripts/check-bytes-port-parity.mjs` asserts this on every byte pattern it
 * covers). `Buffer` is used when the host provides it, which keeps the Node-without-native path
 * fast without branching on "is native available".
 */
export const TS_BYTES_PORT: IRpcBytesPort = {
  vqlRead(bytes: Uint8Array, offset: number): [number, number] {
    let cursor = offset;
    let value = 0;
    for (let shift = 0; ; shift += 7) {
      const byte = bytes[cursor];
      if (byte === undefined) break;
      cursor += 1;
      value |= (byte & 0b0111_1111) << shift;
      if (!(byte & 0b1000_0000)) break;
    }
    return [value >>> 0, cursor - offset];
  },

  vqlWrite(value: number): Uint8Array {
    if (value === 0) return Uint8Array.of(0);
    let length = 0;
    for (let v = value; v !== 0; v = v >>> 7) length += 1;
    const out = new Uint8Array(length);
    for (let i = 0; value !== 0; i += 1) {
      out[i] = value & 0b0111_1111;
      value = value >>> 7;
      if (value > 0) out[i] |= 0b1000_0000;
    }
    return out;
  },

  base64Encode(bytes: Uint8Array): string {
    const bufferCtor = (
      globalThis as {
        Buffer?: { from(input: Uint8Array): { toString(encoding: "base64"): string } };
      }
    ).Buffer;
    if (bufferCtor) return bufferCtor.from(bytes).toString("base64");

    let binary = "";
    const chunkSize = 0x8000;
    for (let offset = 0; offset < bytes.length; offset += chunkSize) {
      binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
    }
    return globalThis.btoa(binary);
  },

  base64Decode(text: string): Uint8Array {
    const bufferCtor = (
      globalThis as {
        Buffer?: { from(input: string, encoding: "base64"): Uint8Array };
      }
    ).Buffer;
    if (bufferCtor) return new Uint8Array(bufferCtor.from(text, "base64"));

    const binary = globalThis.atob(text);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
  },

  alloc(byteLength: number): Uint8Array {
    return new Uint8Array(byteLength);
  },

  concat(buffers: Uint8Array[], totalLength?: number): Uint8Array {
    // Clips rather than growing past the budget, so the output length is always `totalLength`
    // (or the input sum) and never depends on the caller's arithmetic. Matches zcode-buffer.
    const sum = buffers.reduce((acc, buffer) => acc + buffer.length, 0);
    const length = totalLength ?? sum;
    const result = new Uint8Array(length);
    let offset = 0;
    for (const buffer of buffers) {
      if (offset >= length) break;
      const take = Math.min(buffer.length, length - offset);
      result.set(buffer.subarray(0, take), offset);
      offset += take;
    }
    return result;
  },

  slice(bytes: Uint8Array, start: number, end?: number): Uint8Array {
    return bytes.slice(start, end);
  },

  readUInt32BE(bytes: Uint8Array, offset: number): number {
    return (
      ((bytes[offset] << 24) |
        (bytes[offset + 1] << 16) |
        (bytes[offset + 2] << 8) |
        bytes[offset + 3]) >>>
      0
    );
  },

  writeUInt32BE(bytes: Uint8Array, value: number, offset: number): void {
    bytes[offset] = (value >>> 24) & 0xff;
    bytes[offset + 1] = (value >>> 16) & 0xff;
    bytes[offset + 2] = (value >>> 8) & 0xff;
    bytes[offset + 3] = value & 0xff;
  },

  stringToBytes(text: string): Uint8Array {
    return new TextEncoder().encode(text);
  },

  bytesToString(bytes: Uint8Array): string | null {
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      return null;
    }
  },

  crc32Hex: crc32HexJs,
};

/** Exported so the Node binding can reuse the browser implementation for the ops it does not port. */
export const TS_CRC32_HEX = crc32HexJs;

let boundPort: IRpcBytesPort = TS_BYTES_PORT;

/**
 * Binds the byte primitives for this process. Called once per entrypoint:
 * Node hosts call `installNativeRpcBytesPort()` from `@zcode/rpc/native`; the renderer keeps the
 * TypeScript binding because it cannot host a native binary.
 */
export function bindRpcBytesPort(port: IRpcBytesPort): void {
  boundPort = port;
}

/** The binding in effect. Never branches on native availability — there is exactly one. */
export function rpcBytesPort(): IRpcBytesPort {
  return boundPort;
}

/** True when this process is bound to the Rust implementation (diagnostics + Node assertion). */
export function isNativeRpcBytesPort(): boolean {
  return boundPort !== TS_BYTES_PORT;
}
