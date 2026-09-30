import { loadNative } from "./loader.js";

export interface NativeReassemblyModule {
    reassembleWireFrames(wires: unknown[], maxAssemblyBytes?: number): {
        kind: string;
        frameJson: string | null;
        deliveryKind: string | null;
        logicalFrameId: string | null;
        missingIndexes: number[] | null;
        reasonCode: string | null;
    };
}

let _cached: NativeReassemblyModule | null = null;

export function loadReassembly(): NativeReassemblyModule {
    if (!_cached) {
        _cached = loadNative<NativeReassemblyModule>("zcode-reassembly");
    }
    return _cached;
}
