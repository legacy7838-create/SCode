/**
 * `@zcode/rust/model-option-map` — the Node consumer surface of the ported
 * `packages/model-option-map`, over the `zcode-model-option-map` binary.
 *
 * Spec: `docs/specs/rust-native-model-option-map.md`.
 *
 * The restricted-CEL engine (tokenizer/parser/evaluator), the ordered
 * merge-patch application and every error string live in Rust; there is no
 * TypeScript implementation left, so `loadNative` throwing is the only failure
 * this module allows (invariant 1 — no fallback).
 *
 * Two shapes cross the boundary for compiled maps:
 *
 * - `applyJson(bodyJson, valuesJson)` returns the patched body **as text**.
 *   This is the measured fast path (spec §3.3): the request path already
 *   holds the body as a string, so no JS-side `JSON.parse` / `JSON.stringify`
 *   is paid at all.
 * - `apply(body, values)` takes and returns objects, matching the deleted TS
 *   interface for callers that genuinely hold objects (tests, captures).
 */
import { loadNative } from "./loader.js";

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | readonly JsonValue[];

export interface JsonObject {
  readonly [key: string]: JsonValue;
}

export type RestrictedCelValue = string | number;
export type ModelOptionName = "reasoningLevel" | "maxOutputTokens";

export interface ModelOptionMapSpecs {
  readonly reasoningLevel: { readonly map: string };
  readonly maxOutputTokens: { readonly map: string };
}

export interface ModelOptionValues {
  readonly reasoningLevel: string;
  readonly maxOutputTokens: number;
}

export interface ModelOptionMapProgram {
  readonly source: string;
  evaluate(input: RestrictedCelValue): JsonObject;
}

export interface CompiledModelOptionMaps {
  apply(body: JsonObject, values: ModelOptionValues): JsonObject;
  /** The string-level fast path: one JSON text in, one JSON text out. */
  applyJson(bodyJson: string, values: ModelOptionValues): string;
}

interface NativeModelOptionMapProgram {
  readonly source: string;
  evaluate(input: JsonValue): JsonObject;
}

interface NativeCompiledModelOptionMaps {
  apply(bodyJson: string, valuesJson: string): string;
}

interface NativeModelOptionMapModule {
  compileModelOptionMap(source: string, variable: ModelOptionName): NativeModelOptionMapProgram;
  compileModelOptionMaps(specsJson: string): NativeCompiledModelOptionMaps;
  applyOrderedJsonMergePatches(bodyJson: string, patchesJson: string): string;
}

let cached: NativeModelOptionMapModule | null = null;

function native(): NativeModelOptionMapModule {
  cached ??= loadNative<NativeModelOptionMapModule>("zcode-model-option-map");
  return cached;
}

/**
 * Compiles one model-option map. Compile once per model — the program holds
 * its AST, exactly like the deleted TS `programCache`.
 *
 * A bad expression throws `Error` with the TS `RestrictedCelError` message
 * (`{message} at offset {offset}`), which is what the zod superRefine used to
 * surface.
 */
export function compileModelOptionMap(
  source: string,
  variable: ModelOptionName,
): ModelOptionMapProgram {
  const program = native().compileModelOptionMap(source, variable);
  return {
    get source(): string {
      return program.source;
    },
    evaluate(input: RestrictedCelValue): JsonObject {
      return program.evaluate(input);
    },
  };
}

/**
 * Compiles the `reasoningLevel` + `maxOutputTokens` pair and returns the
 * object that applies them to a request body in order, with conflict
 * detection — the deleted `option-maps.ts` contract.
 */
export function compileModelOptionMaps(specs: ModelOptionMapSpecs): CompiledModelOptionMaps {
  const compiled = native().compileModelOptionMaps(JSON.stringify(specs));
  return Object.freeze({
    apply(body: JsonObject, values: ModelOptionValues): JsonObject {
      return JSON.parse(compiled.apply(JSON.stringify(body), JSON.stringify(values))) as JsonObject;
    },
    applyJson(bodyJson: string, values: ModelOptionValues): string {
      return compiled.apply(bodyJson, JSON.stringify(values));
    },
  });
}

/**
 * Applies ordered JSON merge patches with conflict detection: two maps may not
 * write overlapping JSON paths, and a `null` patch value deletes the key.
 */
export function applyOrderedJsonMergePatches(
  body: JsonObject,
  patches: readonly { readonly option: string; readonly patch: JsonObject }[],
): JsonObject {
  return JSON.parse(
    native().applyOrderedJsonMergePatches(JSON.stringify(body), JSON.stringify(patches)),
  ) as JsonObject;
}
