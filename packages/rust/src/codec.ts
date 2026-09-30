/**
 * `@zcode/rust/codec` — loader + typed wrappers for the zcode-codec native binary.
 *
 * INVARIANT: there is NO JavaScript fallback. Hard-throw when binary missing.
 */
import { loadNative } from "./loader.js";

export interface NativeCodecModule {
    vqlRead(data: Uint8Array, offset: number): [number, number];
    vqlWrite(value: number): Uint8Array;
    vqlByteLength(value: number): number;
    rpcSerialize(data: unknown): Uint8Array;
    rpcDeserialize(data: Uint8Array): unknown;
    rpcSerializeBatch(items: unknown[]): Uint8Array;
    rpcDeserializeBatch(data: Uint8Array, count: number): unknown[];
    crc32Hex(data: Uint8Array): string;
    base64Encode(data: Uint8Array): string;
    base64Decode(encoded: string): Uint8Array;
    measureEnvelopeBytes(
        wireJson: Uint8Array,
        channelEventResponseType: number,
        socketProtocolHeaderBytes: number,
    ): {
        cliNdjsonBytes: number;
        channelSocketBytes: number;
        mobileRelayBytes: number;
        maxBytes: number;
    };
    crc32Batch(inputs: Uint8Array[]): string[];
    base64EncodeBatch(inputs: Uint8Array[]): string[];
    base64DecodeBatch(inputs: string[]): Uint8Array[];
}

let _cached: NativeCodecModule | null = null;

export function loadCodec(): NativeCodecModule {
    if (!_cached) {
        _cached = loadNative<NativeCodecModule>("zcode-codec");
    }
    return _cached;
}

// Convenience re-exports
export function rpcSerialize(data: unknown): Uint8Array {
    return loadCodec().rpcSerialize(data);
}

export function rpcDeserialize(data: Uint8Array): unknown {
    return loadCodec().rpcDeserialize(data);
}

export function rpcSerializeBatch(items: unknown[]): Uint8Array {
    return loadCodec().rpcSerializeBatch(items);
}

export function rpcDeserializeBatch(data: Uint8Array, count: number): unknown[] {
    return loadCodec().rpcDeserializeBatch(data, count);
}

export function crc32Hex(data: Uint8Array): string {
    return loadCodec().crc32Hex(data);
}

export function base64Encode(data: Uint8Array): string {
    return loadCodec().base64Encode(data);
}

export function base64Decode(encoded: string): Uint8Array {
    return loadCodec().base64Decode(encoded);
}
