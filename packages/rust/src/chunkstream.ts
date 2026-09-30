/**
 * `@zcode/rust/chunkstream` — loader + typed wrapper for the zcode-chunkstream native binary.
 *
 * INVARIANT: there is NO JavaScript fallback. Hard-throw when binary missing.
 */
import { loadNative } from "./loader.js";

export interface NativeChunkStreamHandle {
  byteLength(): number;
  acceptChunk(chunk: Uint8Array): void;
  peek(byteCount: number): Uint8Array | null;
  skip(byteCount: number): boolean;
  read(byteCount: number): Uint8Array | null;
}

export interface NativeChunkStreamModule {
  createChunkStream(): NativeChunkStreamHandle;
}

let _cached: NativeChunkStreamModule | null = null;

export function loadChunkStream(): NativeChunkStreamModule {
  if (!_cached) {
    _cached = loadNative<NativeChunkStreamModule>("zcode-chunkstream");
  }
  return _cached;
}

export function createChunkStream(): NativeChunkStreamHandle {
  return loadChunkStream().createChunkStream();
}
