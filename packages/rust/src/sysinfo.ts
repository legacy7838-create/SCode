/**
 * Typed wrapper over the zcode-sysinfo napi binary
 * (spec: docs/specs/rust-native-sysinfo.md).
 *
 * One surface, one purpose: the machine-wide process resource table and its
 * cputime-delta sampler. That is the only part of
 * `packages/services/src/{system,process}/` that clears the 0.095 µs FFI floor —
 * 7.303 ms of work for 313 PIDs, measured. Every other function in those
 * directories is listed with its measurement and its keep decision in spec §2.
 *
 * `sample()` is a Promise because the round is ~1.2 ms of parallel procfs reads
 * plus accounting (spec invariant 4: never synchronous on the event loop).
 *
 * Load errors are thrown loudly by loadNative — there is no JS fallback here.
 */
import { loadNative } from "./loader.js";

/** One sampled process. The key names are the wire contract (spec invariant 3). */
export interface NativeProcessResourceSample {
    pid: number;
    ppid: number;
    /** Resident set size, kilobytes. */
    rssKb: number;
    /** Machine-wide normalised percentage; 100 means every logical core is saturated. */
    cpuPercent: number;
    command: string;
}

export interface NativeProcessResourceSampler {
    /**
     * Resolves to the sample set, or to `null` when the round could not be completed
     * (an unreadable process table, or a cancel that raced the read). It is never a
     * partial table.
     *
     * `nowMs` is `Date.now()`, supplied by the caller so a test can pin the clock.
     */
    sample(nowMs: number): Promise<NativeProcessResourceSample[] | null>;
    /** Abandons the in-flight round; the pending `sample()` resolves to `null`. */
    cancel(): void;
}

export interface NativeSysinfoModule {
    ProcessResourceSampler: new (logicalCpuCount: number) => NativeProcessResourceSampler;
}

let _cached: NativeSysinfoModule | null = null;

export function loadSysinfo(): NativeSysinfoModule {
    if (!_cached) {
        _cached = loadNative<NativeSysinfoModule>("zcode-sysinfo");
    }
    return _cached;
}

