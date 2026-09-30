import { loadNative } from "./loader.js";

export interface NativeAssemblerModule {
    createAssembler(
        maxAssemblyBytes: number, maxFragments: number,
        maxConcurrent: number, maxStagedBytes: number,
        timeoutMs: number, maxPhysicalFrameBytes: number
    ): NativeAssemblerHandle;
}

export interface NativeAssemblerHandle {
    accept(wire: unknown, now: number): AssemblerEvent[];
    discard(topic: string, subscriptionId: string): void;
    abort(topic: string, subscriptionId: string): void;
    dispose(): void;
    getStats(): AssemblerStats;
    nextExpiryAt(): number;
}

export interface AssemblerEvent {
    kind: string;
    frameJson: string | null;
    deliveryKind: string | null;
    reasonCode: string | null;
    logicalFrameId: string;
    logicalFrameOrdinal: number;
    topic: string;
    subscriptionId: string;
}

export interface AssemblerStats {
    assemblies: number;
    stagedDecodedBytes: number;
}

let _cached: NativeAssemblerModule | null = null;

export function loadAssembler(): NativeAssemblerModule {
    if (!_cached) {
        _cached = loadNative<NativeAssemblerModule>("zcode-assembler");
    }
    return _cached;
}
