// ============================================================
// Bounded input for world-read / world-run nodes
// ============================================================
// `inputHash` only answers "Is it the same input?"; the workspace transcript answers "What is the input?". Put here
// `{op, args}` pushes 4 KB: most inputs (a path, a pattern, an argv) are far smaller than the upper limit,
// Drop it into the library as it is; only `world.run("node", ["-e", <a large piece of code>])` will be intercepted. Truncation is **termwise
// String preview** instead of discarding it entirely - "ran node -e ... (intercepted)" is much more useful in auditing than a NULL.

import { WORLD_READ_INPUT_MAX_BYTES, type WorldReadInput } from "./types.js";

/** The maximum number of characters a single argument keeps in truncation mode: 4 KB divided evenly among at most 8 arguments, leaving room for serialization overhead. */
const TRUNCATED_ARG_MAX_CHARS = 400;
const MAX_ARGS_KEPT = 8;

/** UTF-8 byte count. Uses `TextEncoder` rather than `Buffer`: this package keeps zero Node built-in dependencies (the same discipline as engine.ts). */
function utf8Length(text: string): number {
  return new TextEncoder().encode(text).length;
}

/** A string preview of one argument: strings as-is, everything else as JSON; over-long ones are tail-cut with an ellipsis. */
function previewArg(value: unknown): string {
  let text: string;
  if (typeof value === "string") text = value;
  else {
    try {
      text = JSON.stringify(value) ?? String(value);
    } catch {
      text = String(value);
    }
  }
  return text.length > TRUNCATED_ARG_MAX_CHARS
    ? `${text.slice(0, TRUNCATED_ARG_MAX_CHARS)}…`
    : text;
}

/**
 * Compresses `{op, args}` within {@link WORLD_READ_INPUT_MAX_BYTES}.
 *
 * Fast path: if the serialization does not exceed the limit it is returned as-is (the arguments keep their original
 * types — the opts object of `world.run` and the number of `git.log` are still themselves). Slow path: each argument
 * is replaced by a string preview, at most 8 of them, and `truncated` is set. Non-serializable arguments (cycles, BigInt) take the same slow path — they could not be represented in the journal in the first place.
 */
export function boundWorldReadInput(op: string, args: readonly unknown[]): WorldReadInput {
  const plain: WorldReadInput = { op, args: [...args] };
  try {
    const text = JSON.stringify(plain);
    if (text !== undefined && utf8Length(text) <= WORLD_READ_INPUT_MAX_BYTES) return plain;
  } catch {
    // Drop into the preview path below.
  }
  return {
    op,
    args: args.slice(0, MAX_ARGS_KEPT).map(previewArg),
    truncated: true,
  };
}
