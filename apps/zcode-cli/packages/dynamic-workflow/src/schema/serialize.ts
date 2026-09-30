import type { JsonSchema } from "./types.js";

/**
 * Deterministic serialization: recursively sort a schema's object keys before JSON.stringify, so snapshots
 * stay stable regardless of the insertion order at emit time. Arrays (enum/required/prefixItems/anyOf etc.)
 * keep their existing order, because their order is meaningful (and is determined by the checker's
 * property/member order).
 */

export function serializeSchema(schema: JsonSchema): string {
  return `${JSON.stringify(canonicalize(schema), null, 2)}\n`;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[key] = canonicalize((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}
