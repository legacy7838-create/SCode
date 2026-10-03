import { z } from "zod";
import { sparseShape } from "./config-schema.js";

/**
 * `map` is a restricted-CEL expression. Its compile validation is **owned by
 * the native boundary** (`zcode-provider-config`'s `check_model_option_map`
 * runs it on every config decode and every persisted write), so this schema —
 * which the renderer bundles — keeps only the shape constraints. The renderer
 * cannot load a `.node` (invariant 9) and never executed the compile step
 * itself: invalid maps are rejected natively with the same
 * `{message} at offset {offset}` string the removed superRefine surfaced.
 * Spec: docs/specs/rust-native-model-option-map.md §3.1.
 */
function optionMapSchema() {
  return z.string().min(1);
}

export const completeEnumOptionSpecDataSchema = z
  .object({
    /** Arranged in order of semantic intensity from low to high; the first item is the lowest public level available for auxiliary calls. */
    values: z
      .array(
        z
          .string()
          .refine(
            (value) => value.trim().length > 0,
            "reasoningLevel.values must be non-empty strings",
          ),
      )
      .min(1, "reasoningLevel.values must not be empty")
      .refine(
        (values) => new Set(values).size === values.length,
        "reasoningLevel.values must not contain duplicates",
      )
      .readonly(),
    map: optionMapSchema(),
  })
  .strict();

export const completeLimitOptionSpecDataSchema = z
  .object({
    max: z.number().int().positive(),
    map: optionMapSchema(),
  })
  .strict();

export const enumOptionSpecDataSchema = z
  .object(sparseShape(completeEnumOptionSpecDataSchema.shape))
  .strict();
export const limitOptionSpecDataSchema = z
  .object(sparseShape(completeLimitOptionSpecDataSchema.shape))
  .strict();

export const completeModelInputFormatDataSchema = z
  .object({
    supportsText: z.boolean(),
    supportsImage: z.boolean(),
    supportsVideo: z.boolean(),
    supportsAudio: z.boolean(),
    supportsPdf: z.boolean(),
  })
  .strict();
export const completeModelOutputFormatDataSchema = z.object({ supportsText: z.boolean() }).strict();
export const modelInputFormatDataSchema = z
  .object(sparseShape(completeModelInputFormatDataSchema.shape))
  .strict();
export const modelOutputFormatDataSchema = z
  .object(sparseShape(completeModelOutputFormatDataSchema.shape))
  .strict();

export const completeModelPropertiesDataSchema = z
  .object({
    requiresMfjsToolSchema: z.boolean(),
    contextWindow: z.number().int().positive(),
    inputFormat: completeModelInputFormatDataSchema,
    outputFormat: completeModelOutputFormatDataSchema,
    supportsToolCall: z.boolean(),
    supportsJsonSchemaOutput: z.boolean(),
    supportsNativeWebSearch: z.boolean(),
    supportsMidConversationSystem: z.boolean(),
  })
  .strict();
export const modelPropertiesDataSchema = z
  .object({
    ...sparseShape(completeModelPropertiesDataSchema.shape),
    inputFormat: modelInputFormatDataSchema.nullable().optional(),
    outputFormat: modelOutputFormatDataSchema.nullable().optional(),
  })
  .strict();

export const completeModelOptionSpecsDataSchema = z
  .object({
    reasoningLevel: completeEnumOptionSpecDataSchema,
    maxOutputTokens: completeLimitOptionSpecDataSchema,
  })
  .strict();
export const modelOptionSpecsDataSchema = z
  .object({
    ...sparseShape(completeModelOptionSpecsDataSchema.shape),
    reasoningLevel: enumOptionSpecDataSchema.nullable().optional(),
    maxOutputTokens: limitOptionSpecDataSchema.nullable().optional(),
  })
  .strict();

export const completeModelConfigDataSchema = z
  .object({
    enabled: z.boolean(),
    properties: completeModelPropertiesDataSchema,
    optionSpecs: completeModelOptionSpecsDataSchema,
  })
  .strict();
export const modelConfigDataSchema = z
  .object({
    ...sparseShape(completeModelConfigDataSchema.shape),
    properties: modelPropertiesDataSchema.nullable().optional(),
    optionSpecs: modelOptionSpecsDataSchema.nullable().optional(),
  })
  .strict();

// Only data contracts are shared across layers; Provider behavior classes and IO do not enter the public Schema.
export type ModelInputFormatData = z.infer<typeof completeModelInputFormatDataSchema>;
export type ModelOutputFormatData = z.infer<typeof completeModelOutputFormatDataSchema>;
export type ModelPropertiesData = z.infer<typeof completeModelPropertiesDataSchema>;
export type EnumOptionSpecData = z.infer<typeof completeEnumOptionSpecDataSchema>;
export type LimitOptionSpecData = z.infer<typeof completeLimitOptionSpecDataSchema>;
export type ModelOptionSpecsData = z.infer<typeof completeModelOptionSpecsDataSchema>;
