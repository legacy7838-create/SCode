/**
 * `@zcode/rust/projection` — loader + typed wrappers for the zcode-projection native binary.
 *
 * INVARIANT: there is NO JavaScript fallback. Hard-throw when binary missing.
 */
import { loadNative } from "./loader.js";

export interface NativeProjectionModule {
    applyDelta(snapshot: unknown, delta: unknown): unknown;
    applyDeltas(snapshot: unknown, deltas: unknown[]): unknown;
    applyDeltasBatch(snapshot: unknown, deltaBatches: unknown[][]): unknown[];
    appendToRow(row: unknown, path: string, append: string): unknown;
    mergeOlderRows(window: unknown[], fetched: unknown[]): unknown[] | null;
    applyWorkflowRunUpdated(state: unknown, delta: unknown): unknown;
    applyWorkflowRunRemoved(state: unknown, delta: unknown): unknown;
    mergeWorkflowRunUpdates(earlier: unknown, later: unknown): unknown;
}

let _cached: NativeProjectionModule | null = null;

export function loadProjection(): NativeProjectionModule {
    if (!_cached) {
        _cached = loadNative<NativeProjectionModule>("zcode-projection");
    }
    return _cached;
}

// Convenience re-exports
export function applyDelta(snapshot: unknown, delta: unknown): unknown {
    return loadProjection().applyDelta(snapshot, delta);
}

export function applyDeltas(snapshot: unknown, deltas: unknown[]): unknown {
    return loadProjection().applyDeltas(snapshot, deltas);
}

export function applyDeltasBatch(snapshot: unknown, deltaBatches: unknown[][]): unknown[] {
    return loadProjection().applyDeltasBatch(snapshot, deltaBatches);
}

export function appendToRow(row: unknown, path: string, append: string): unknown {
    return loadProjection().appendToRow(row, path, append);
}

export function mergeOlderRows(window: unknown[], fetched: unknown[]): unknown[] | null {
    return loadProjection().mergeOlderRows(window, fetched);
}
