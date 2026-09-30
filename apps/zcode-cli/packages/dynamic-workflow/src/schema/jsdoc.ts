import ts from "typescript";
import type { JsonSchema, JsonValue } from "./types.js";

/**
 * JSDoc harvesting: turns the doc comments on a symbol (interface member, type alias, ask result type) and the
 * supported constraint tags into a JSON Schema fragment.
 *
 * - Doc body → `description`.
 * - Tag subset → constraint keywords: `@minimum @maximum @exclusiveMinimum @exclusiveMaximum
 *   @minLength @maxLength @pattern @format @minItems @maxItems @default`.
 *
 * Tags outside the subset are silently ignored (not an error).
 */

/** Tag that takes a numeric value → the corresponding numeric keyword name. */
const NUMERIC_TAGS: Record<string, keyof JsonSchema> = {
  exclusiveMaximum: "exclusiveMaximum",
  exclusiveMinimum: "exclusiveMinimum",
  maximum: "maximum",
  maxItems: "maxItems",
  maxLength: "maxLength",
  minimum: "minimum",
  minItems: "minItems",
  minLength: "minLength",
};

/** Tag that takes a string → the corresponding string keyword name. */
const STRING_TAGS: Record<string, keyof JsonSchema> = {
  format: "format",
  pattern: "pattern",
};

/**
 * Harvests the description and constraint tags of one symbol and returns a schema fragment containing only the relevant keywords,
 * for the synthesis side to merge into that symbol's schema.
 */
export function harvestConstraints(symbol: ts.Symbol, checker: ts.TypeChecker): Partial<JsonSchema> {
  const out: Partial<JsonSchema> = {};

  const doc = ts.displayPartsToString(symbol.getDocumentationComment(checker)).trim();
  if (doc.length > 0) out.description = doc;

  for (const tag of symbol.getJsDocTags(checker)) applyTag(out, tag);
  return out;
}

function applyTag(out: Partial<JsonSchema>, tag: ts.JSDocTagInfo): void {
  const raw = ts.displayPartsToString(tag.text).trim();

  const numericKey = NUMERIC_TAGS[tag.name];
  if (numericKey !== undefined) {
    const value = Number(raw);
    if (Number.isFinite(value)) (out as Record<string, unknown>)[numericKey] = value;
    return;
  }

  const stringKey = STRING_TAGS[tag.name];
  if (stringKey !== undefined) {
    if (raw.length > 0) (out as Record<string, unknown>)[stringKey] = raw;
    return;
  }

  if (tag.name === "default") {
    out.default = parseDefault(raw);
  }
  // Tags outside the subset: ignored.
}

/** The value of `@default` is first parsed as JSON (number/boolean/object/array/quoted string); on failure it is treated as a bare string. */
function parseDefault(raw: string): JsonValue {
  if (raw.length === 0) return "";
  try {
    return JSON.parse(raw) as JsonValue;
  } catch {
    return raw;
  }
}

/** Merges the harvested fragment into an existing schema: constraint keywords are added, and description does not overwrite an existing value. */
export function mergeConstraints(schema: JsonSchema, extra: Partial<JsonSchema>): JsonSchema {
  const merged: JsonSchema = { ...schema };
  for (const [key, value] of Object.entries(extra)) {
    if (value === undefined) continue;
    if (key === "description" && merged.description !== undefined) continue;
    (merged as Record<string, unknown>)[key] = value;
  }
  return merged;
}
