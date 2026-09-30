/**
 * `@zcode/rust/coalesce` — loader + typed wrappers for the zcode-coalesce native binary.
 *
 * INVARIANT: there is NO JavaScript fallback. Hard-throw when binary missing.
 */
import { loadNative } from "./loader.js";

export interface NativeCoalesceModule {
    coalesceDeltas(deltas: unknown[]): unknown[];
}

let _cached: NativeCoalesceModule | null = null;

export function loadCoalesce(): NativeCoalesceModule {
    if (!_cached) {
        _cached = loadNative<NativeCoalesceModule>("zcode-coalesce");
    }
    return _cached;
}

export function coalesceDeltas(deltas: unknown[]): unknown[] {
    return loadCoalesce().coalesceDeltas(deltas);
}
