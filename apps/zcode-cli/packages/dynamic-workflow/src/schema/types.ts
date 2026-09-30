/**
 * The shared vocabulary of the schema subsystem: the subset type of JSON Schema that we "emit", and the violation
 * model the validator produces. {@link JsonSchema} here is not general-purpose JSON Schema -- it
 * corresponds exactly to the set of keywords {@link synthesizeAskSchemas} can produce, and the validator only understands this subset.
 */

/** Any valid JSON value. Literals appearing in const/enum/default are all expressed with it. */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

/** The base type tags of the JSON Schema we emit. `integer` is supported by the validator but never produced proactively by the synthesis side. */
export type JsonSchemaType =
  | "string"
  | "number"
  | "integer"
  | "boolean"
  | "null"
  | "array"
  | "object";

/**
 * The subset of JSON Schema we emit. The fields are a union of optional keywords: a concrete schema only uses the few
 * of them that are relevant to its shape (an object schema uses properties/required/additionalProperties,
 * while a union uses enum or anyOf). The validator only handles the keywords that appear here.
 */
export interface JsonSchema {
  // structure
  type?: JsonSchemaType | JsonSchemaType[];
  const?: JsonValue;
  enum?: JsonValue[];
  anyOf?: JsonSchema[];
  // object
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: boolean | JsonSchema;
  // array / tuple
  items?: JsonSchema;
  prefixItems?: JsonSchema[];
  minItems?: number;
  maxItems?: number;
  // string constraint
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  format?: string;
  // number constraints
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number;
  exclusiveMaximum?: number;
  // annotation
  description?: string;
  default?: JsonValue;
  // Recursive types: reference and definition tables
  $ref?: string;
  $defs?: Record<string, JsonSchema>;
}

/**
 * A single violation produced by the validator, designed to go straight into the tool_result used for repairs: one per line, containing
 * the JSON path, the expectation (expected), and what was actually got (got).
 */
export interface Violation {
  /** The JSON path of where the violation sits, of the form `$`, `$.foo`, `$.items[0]`. */
  path: string;
  /** A short description of the expected shape/value. */
  expected: string;
  /** A short description of the value actually got. */
  got: string;
}

/** A synthesis-side diagnostic code. 9001 is already taken by the facade-siting rule (see analysis/sites.ts). */
export const SCHEMA_DIAGNOSTIC_CODE = 9002;

/**
 * The cap on the number of union members. Past it the union counts as "pathologically wide" and a diagnostic is reported at the ask site.
 *
 * 100 is picked so that it both accommodates a reasonable enum (common enums such as status codes or country codes stay far below it) and still catches
 * cases that are obviously out of control. It applies to the member count of both literal unions (-> enum) and ordinary unions (-> anyOf).
 *
 * In practice what trips it is usually not a hand-written giant union but the cartesian product produced after the checker expands a template literal type (template
 * literal type) -- for example `` `${Dir}-${Size}` `` expands into a literal union of
 * every combination, and as soon as a few dimensions cross it explodes.
 */
export const MAX_UNION_MEMBERS = 100;
