/**
 * Typed wrapper over the zcode-diff napi binary (spec: docs/specs/rust-native-diff.md).
 * Load errors are thrown loudly by loadNative — there is no JS fallback here.
 */
import { loadNative } from "./loader.js";

export interface NativeDiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: string[];
}

export interface NativeDiffApi {
  structuredPatch(oldContent: string, newContent: string, context?: number): NativeDiffHunk[];
  levenshtein(left: string, right: string): number;
  lineSimilarity(left: string, right: string): number;
  averageMiddleSimilarity(actual: string[], expected: string[]): number;
}

export function loadDiff(): NativeDiffApi {
  return loadNative<NativeDiffApi>("zcode-diff");
}
