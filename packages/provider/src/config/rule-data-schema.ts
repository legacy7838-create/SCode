import { z } from "zod";
import { modelConfigDataSchema } from "@zcode/shared/model-config";
import { manualModelConfigSchema } from "./manual-model-config.js";
export { manualModelConfigSchema, type ManualModelConfig } from "./manual-model-config.js";
import {
  apiKeyAccessDataSchema,
  personalProviderApiDataSchema,
  providerConfigDataSchema,
  providerGroupDataSchema,
  providerTemplateDataSchema,
} from "./provider-data-schema.js";

const idSchema = z.string().min(1);
const patternSchema = z
  .string()
  .min(1)
  .refine((pattern) => {
    try {
      new RegExp(`^(?:${pattern})$`);
      return true;
    } catch {
      return false;
    }
  }, "Invalid match pattern");

export const modelMatchConfigRuleSchema = z
  .object({
    modelMatch: patternSchema,
    config: modelConfigDataSchema,
  })
  .strict();
export const modelApiMatchConfigRuleSchema = modelMatchConfigRuleSchema.extend({
  apiTypeMatch: patternSchema,
});
export const providerSiteMatchConfigRuleSchema = modelMatchConfigRuleSchema.extend({
  baseUrlMatch: patternSchema,
  apiTypeMatch: patternSchema.optional(),
});
export const templateModelConfigRuleSchema = z
  .object({
    templateId: idSchema,
    modelId: idSchema,
    config: modelConfigDataSchema,
  })
  .strict();
export const providerModelConfigRuleSchema = templateModelConfigRuleSchema
  .omit({ templateId: true })
  .extend({
    providerId: idSchema,
  });
export const manualProviderModelConfigRuleSchema = providerModelConfigRuleSchema.extend({
  config: manualModelConfigSchema,
});

export const builtinModelConfigRulesSchema = z
  .object({
    modelRules: z.array(modelMatchConfigRuleSchema),
    modelApiRules: z.array(modelApiMatchConfigRuleSchema),
    providerSiteRules: z.array(providerSiteMatchConfigRuleSchema),
    templateModelRules: z.array(templateModelConfigRuleSchema),
    builtinProviderModelRules: z.array(providerModelConfigRuleSchema),
  })
  .strict();
export const personalModelConfigRulesSchema = z
  .object({
    providerModelRules: z.array(providerModelConfigRuleSchema),
    manualProviderModelRules: z.array(manualProviderModelConfigRuleSchema),
  })
  .strict()
  .superRefine((rules, context) => {
    // Contradictory patterns cannot be masked by the last override; identities are encoded in tuples to avoid collisions with the separators of model IDs.
    const smartIds = new Set(
      rules.providerModelRules.map((rule) => JSON.stringify([rule.providerId, rule.modelId])),
    );
    rules.manualProviderModelRules.forEach((rule, index) => {
      if (smartIds.has(JSON.stringify([rule.providerId, rule.modelId]))) {
        context.addIssue({
          code: "custom",
          path: ["manualProviderModelRules", index],
          message: "The same Provider/Model cannot declare both smart and manual config",
        });
      }
    });
  });

// Identities, template references, and instance names belong to rules and are no longer leaves that can be stacked into execution configurations.
export const providerConfigRuleSchema = z
  .object({
    providerId: idSchema,
    templateId: idSchema.nullable().optional(),
    providerName: idSchema.nullable().optional(),
    enabled: z.boolean().optional(),
    config: providerConfigDataSchema,
  })
  .strict();
export const providerTemplateConfigRuleSchema = providerTemplateDataSchema.extend({
  config: providerConfigDataSchema
    .pick({ logo: true, access: true, api: true, builtinModelIds: true })
    .extend({
      access: apiKeyAccessDataSchema.omit({ apiKey: true }).nullable().optional(),
    }),
});
export const builtinProviderConfigRuleSchema = providerConfigRuleSchema.extend({
  config: providerConfigDataSchema.omit({ personalModelIds: true, modelOrder: true }).extend({
    group: providerGroupDataSchema.exclude(["standard-personal"]),
  }),
});
const personalProviderConfigRuleSchema = providerConfigRuleSchema
  .extend({
    config: providerConfigDataSchema.omit({ builtinModelIds: true }).extend({
      group: providerGroupDataSchema.extract(["standard-personal"]).nullable().optional(),
      api: personalProviderApiDataSchema.nullable().optional(),
    }),
  })
  .superRefine((rule, context) => {
    if (rule.providerId.startsWith("account:") && rule.config.access !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["config", "access"],
        message:
          "Access for a pinned Account Provider can only be declared by the ZCode Built-in Config",
      });
    }
  });
export const builtinProviderConfigRulesSchema = z
  .object({
    templateRules: z.array(providerTemplateConfigRuleSchema),
    providerRules: z.array(builtinProviderConfigRuleSchema),
  })
  .strict()
  .superRefine((rules, context) => {
    checkUniqueIds(
      rules.templateRules.map((rule) => rule.templateId),
      "templateRules",
      "templateId",
      context,
    );
    checkUniqueIds(
      rules.providerRules.map((rule) => rule.providerId),
      "providerRules",
      "providerId",
      context,
    );
  });
export const personalProviderConfigRulesSchema = z
  .object({
    providerRules: z.array(personalProviderConfigRuleSchema),
  })
  .strict()
  .superRefine((rules, context) => {
    checkUniqueIds(
      rules.providerRules.map((rule) => rule.providerId),
      "providerRules",
      "providerId",
      context,
    );
  });

function checkUniqueIds(
  ids: readonly string[],
  group: string,
  key: string,
  context: z.RefinementCtx,
): void {
  const seen = new Set<string>();
  ids.forEach((id, index) => {
    if (seen.has(id))
      context.addIssue({
        code: "custom",
        path: [group, index, key],
        message: `Duplicate ${key}: ${id}`,
      });
    seen.add(id);
  });
}

export type ModelMatchConfigRuleData = z.infer<typeof modelMatchConfigRuleSchema>;
export type ModelApiMatchConfigRuleData = z.infer<typeof modelApiMatchConfigRuleSchema>;
export type ProviderSiteMatchConfigRuleData = z.infer<typeof providerSiteMatchConfigRuleSchema>;
export type TemplateModelConfigRuleData = z.infer<typeof templateModelConfigRuleSchema>;
export type ProviderModelConfigRuleData = z.infer<typeof providerModelConfigRuleSchema>;
export type ManualProviderModelConfigRuleData = z.infer<typeof manualProviderModelConfigRuleSchema>;
export type BuiltinModelConfigRulesData = z.infer<typeof builtinModelConfigRulesSchema>;
export type PersonalModelConfigRulesData = z.infer<typeof personalModelConfigRulesSchema>;
export type ProviderConfigRuleData = z.infer<typeof providerConfigRuleSchema>;
export type ProviderTemplateConfigRuleData = z.infer<typeof providerTemplateConfigRuleSchema>;
