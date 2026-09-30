/**
 * `@zcode/rust/profiles` — loader + typed wrapper for the zcode-profiles native binary.
 *
 * INVARIANT: there is NO JavaScript fallback. Hard-throw when binary missing.
 */
import { loadNative } from "./loader.js";

export interface NativeProfilesModule {
  filterDeltasForProfile(deltas: unknown[], streamPaths: string[]): unknown[];
}

let _cached: NativeProfilesModule | null = null;

export function loadProfiles(): NativeProfilesModule {
  if (!_cached) {
    _cached = loadNative<NativeProfilesModule>("zcode-profiles");
  }
  return _cached;
}

export function filterDeltasForProfile(
  deltas: unknown[],
  streamPaths: string[],
): unknown[] {
  return loadProfiles().filterDeltasForProfile(deltas, streamPaths);
}
