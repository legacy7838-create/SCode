/**
 * The tool-result byte budget — Rust.
 *
 * Spec: docs/specs/subagent-rust-port.md (Phase 4).
 *
 * Split out of `subagentProfile.ts` because that file reached the repository's maximum file
 * length. This is the primitive that decides how much of a tool result reaches the model; the
 * JavaScript original clipped at code-point boundaries, so the naive Rust translation would
 * panic on a boundary or split one.
 */

import { loadNative } from "./loader.js";

/** Which end to keep when a tool result does not fit. */
export type BudgetDirection = "head" | "tail";

interface NativeResultBudgetModule {
  fitStringToBytesJson(value: string, maxBytes: number, direction: string): string;
  fitContentWithSuffixJson(content: string, maxBytes: number, suffix: string, direction: string): string;
}

let cachedResultBudget: NativeResultBudgetModule | null = null;

function resultBudgetModule(): NativeResultBudgetModule {
  cachedResultBudget ??= loadNative<NativeResultBudgetModule>("zcode-subagent-profile");
  return cachedResultBudget;
}

/**
 * Fit a tool result to a UTF-8 byte budget, never splitting a code point.
 *
 * Owned by Rust (`docs/specs/subagent-rust-port.md` Phase 4). The budget decides how much of a
 * tool result reaches the model, and the JavaScript original walks code points — the naive Rust
 * translation would panic on a boundary or, worse, split one. `result-budget-golden.json` pins
 * 307 cases, most of them Unicode, for exactly that.
 */
export function fitStringToBytes(value: string, maxBytes: number, direction: BudgetDirection): string {
  return resultBudgetModule().fitStringToBytesJson(value, maxBytes, direction);
}

/**
 * Fit a tool result to a byte budget with a truncation notice. The notice is reserved FIRST and
 * always taken from the head, so it can never itself be cut off.
 */
export function fitContentWithSuffix(
  content: string,
  maxBytes: number,
  suffix: string,
  direction: BudgetDirection,
): string {
  return resultBudgetModule().fitContentWithSuffixJson(content, maxBytes, suffix, direction);
}
