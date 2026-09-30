import { loadNative } from "./loader.js";

export interface NativeRpcBufferModule {
  alloc(byteLength: number): Uint8Array;
  concat(buffers: Uint8Array[], totalLength?: number): Uint8Array;
  slice(buffer: Uint8Array, start: number, end?: number): Uint8Array;
  copyInto(target: Uint8Array, source: Uint8Array, offset: number): Uint8Array;
  readUint32Be(buffer: Uint8Array, offset: number): number;
  writeUint32Be(buffer: Uint8Array, value: number, offset: number): Uint8Array;
  stringToBytes(s: string): Uint8Array;
  bytesToString(buffer: Uint8Array): string | null;
}

let _cached: NativeRpcBufferModule | null = null;
export function loadRpcBuffer(): NativeRpcBufferModule {
  if (!_cached) _cached = loadNative<NativeRpcBufferModule>("zcode-buffer");
  return _cached;
}
