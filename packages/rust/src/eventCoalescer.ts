import { loadNative } from "./loader.js";

export interface NativeEventCoalescerModule {
    getCoalesceKey(event: unknown): string | null;
    mergeSessionEvents(current: unknown, next: unknown): unknown;
}

let _cached: NativeEventCoalescerModule | null = null;

export function loadEventCoalescer(): NativeEventCoalescerModule {
    if (!_cached) {
        _cached = loadNative<NativeEventCoalescerModule>("zcode-event-coalescer");
    }
    return _cached;
}

export function getCoalesceKey(event: unknown): string | null {
    return loadEventCoalescer().getCoalesceKey(event);
}

export function mergeSessionEvents(current: unknown, next: unknown): unknown {
    return loadEventCoalescer().mergeSessionEvents(current, next);
}
