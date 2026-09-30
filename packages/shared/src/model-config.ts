import { z } from "zod";
import { compileModelOptionMap } from "@zcode/model-option-map";
import { sparseShape } from "./config-schema.js";

function optionMapSchema(variableName: "reasoningLevel" | "maxOutputTokens") {
  return z
    .string()
    .min(1)
    .superRefine((source, context) => {
      try {
        compileModelOptionMap(source, variableName);
      } catch (error) {
        context.addIssue({
          code: "custom",
          message: error instanceof Error ? error.message : "Option map could not be compiled",
        });
      }
    });
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
    map: optionMapSchema("reasoningLevel"),
  })
  .strict();

export const completeLimitOptionSpecDataSchema = z
  .object({
    max: z.number().int().positive(),
    map: optionMapSchema("maxOutputTokens"),
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
