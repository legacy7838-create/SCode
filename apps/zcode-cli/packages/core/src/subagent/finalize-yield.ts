// ============================================================
// Structured-yield finalization for subagents
// ============================================================
//
// State owner: this module is pure. The child runtime owns the collected yield
// items; the parent-facing Agent tool owns rendering. Nothing here holds state
// between calls, so there is exactly one write path for a yield result.
//
// Contract (see docs/specs/subagent-result-contract.md):
//   - array-typed sections accumulate across multiple Yield calls
//   - scalar sections replace (last write wins)
//   - the merged object is validated once, against the profile outputSchema
//   - a schema failure is a REPORTED FAILURE (ok:false), never a silent
//     downgrade to raw text

import type { JsonSchema } from "@zcode/contracts";
import { validateJsonSchemaValue } from "../tool/json-schema.js";

const SUBAGENT_WARNING_NULL_YIELD =
  "SUBAGENT_NULL_YIELD: subagent returned no Yield result";
export const SUBAGENT_WARNING_YIELD_TOOL_DISALLOWED =
  "SUBAGENT_YIELD_TOOL_DISALLOWED: profile declared yield but the Yield tool was disallowed";
export const SUBAGENT_WARNING_SCHEMA_OVERRIDDEN =
  "SUBAGENT_YIELD_SCHEMA_OVERRIDDEN: Yield schema stayed invalid after the retry budget";

/** One accepted Yield call, as recorded by the child-side tool. */
interface SubagentYieldItem {
  /** Array-typed sections are appended; scalar sections replace. */
  readonly data: unknown;
  /** Retry attempts the model burned before this call was accepted. */
  readonly attempts?: number;
}

interface FinalizedSubagentYield {
  readonly ok: boolean;
  /** Present only when ok is true. */
  readonly data?: unknown;
  warnings?: string[];
  /** Populated when ok is false because the merged data broke the schema. */
  issues?: string[];
}

export function finalizeSubagentYield(input: {
  readonly items: readonly SubagentYieldItem[];
  readonly schema: JsonSchema | undefined;
}): FinalizedSubagentYield {
  const { items, schema } = input;
  // An accepted-with-override item is schema-invalid by construction, so the
  // merge can still fail; the warning must survive BOTH branches, otherwise a
  // spent retry budget becomes invisible to the parent on the failure path.
  const maxAttempts = Math.max(0, ...items.map((item) => item.attempts ?? 0));
  const warnings: string[] = items.length === 0 ? [SUBAGENT_WARNING_NULL_YIELD] : [];
  if (maxAttempts > 0) {
    warnings.push(SUBAGENT_WARNING_SCHEMA_OVERRIDDEN);
  }
  const withWarnings = <T extends object>(base: T): T & { warnings?: string[] } =>
    warnings.length > 0 ? { ...base, warnings } : base;

  if (items.length === 0) {
    return withWarnings({ ok: false });
  }

  const merged = mergeYieldData(items.map((item) => item.data));
  const validation = validateJsonSchemaValue(merged, schema);
  if (!validation.valid) {
    return withWarnings({ ok: false, issues: validation.errors });
  }

  return withWarnings({ ok: true, data: merged });
}

/**
 * Fold yield payloads in call order.
 * Objects merge key-by-key so a child can yield one section per call; arrays
 * append so repeated calls extend a list instead of overwriting it. A
 * non-object payload replaces the accumulated value outright, because there is
 * no key structure to merge on.
 *
 * This is the ONE merge rule. The child-side Yield tool imports it (see
 * `tool/handlers/yield.ts`) instead of keeping a second copy: two copies had
 * already diverged on non-object payloads, which is exactly the disagreement
 * that would let the tool accept a payload the finalizer then rejects.
 */
export function mergeYieldData(payloads: readonly unknown[]): unknown {
  let accumulator: Record<string, unknown> | undefined;
  let scalar: unknown;

  for (const payload of payloads) {
    if (!isPlainObject(payload)) {
      scalar = payload;
      continue;
    }
    const next: Record<string, unknown> = { ...(accumulator ?? {}) };
    for (const [key, value] of Object.entries(payload)) {
      const existing = next[key];
      next[key] = Array.isArray(existing) && Array.isArray(value) ? [...existing, ...value] : value;
    }
    accumulator = next;
  }

  return accumulator ?? scalar;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
