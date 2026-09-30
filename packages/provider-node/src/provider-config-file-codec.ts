import { z } from "zod";
import { modelSelectionSchema } from "@zcode/shared/model-selection";
import { completeModelConfigDataSchema, modelConfigDataSchema } from "@zcode/shared/model-config";
import {
  parsePersonalModelConfigRules,
  parsePersonalProviderConfigMap,
  extractManualModelConfig,
  manualModelConfigSchema,
  type ProviderConfigLayerUpdate,
} from "@zcode/provider";

const CURRENT_SCHEMA_VERSION = 1 as const;

type ProviderConfigFileMigration = (input: unknown) => unknown;

const migrations: ReadonlyMap<number, ProviderConfigFileMigration> = new Map();

const storedProviderConfigSchema = z
  .object({
    schemaVersion: z.literal(CURRENT_SCHEMA_VERSION),
    config: z
      .object({
        providerOrder: z.array(z.string().min(1)).optional(),
        providerConfigRules: z.unknown(),
        modelConfigRules: z.unknown(),
        defaultModelSelection: modelSelectionSchema.optional(),
      })
      .strict(),
  })
  .strict();

export class UnsupportedProviderConfigVersionError extends Error {
  readonly version: number | null;

  constructor(message: string, version: number | null) {
    super(message);
    this.name = "UnsupportedProviderConfigVersionError";
    this.version = version;
  }
}

export function decodeProviderConfigFile(input: unknown): ProviderConfigLayerUpdate {
  let candidate = input;
  let version = readSchemaVersion(candidate);
  if (version === null) {
    throw new UnsupportedProviderConfigVersionError(
      "Provider Config is missing schemaVersion",
      null,
    );
  }
  if (version > CURRENT_SCHEMA_VERSION) {
    throw new UnsupportedProviderConfigVersionError(
      `Provider Config schemaVersion ${version} is newer than the currently supported ${CURRENT_SCHEMA_VERSION}`,
      version,
    );
  }
  while (version < CURRENT_SCHEMA_VERSION) {
    const migration = migrations.get(version);
    if (!migration) {
      throw new UnsupportedProviderConfigVersionError(
        `Missing Provider Config migrator from schemaVersion ${version} to ${version + 1}`,
        version,
      );
    }
    candidate = migration(candidate);
    const nextVersion = requireSchemaVersion(candidate);
    if (nextVersion !== version + 1) {
      throw new Error(
        `Provider Config migrator must migrate from schemaVersion ${version} to ${version + 1}`,
      );
    }
    version = nextVersion;
  }
  const parsed = storedProviderConfigSchema.parse(candidate);
  return Object.freeze({
    providers: parsePersonalProviderConfigMap(parsed.config.providerConfigRules),
    models: parsePersonalModelConfigRules(
      normalizeLegacyManualRules(parsed.config.modelConfigRules),
    ),
    providerOrder: parsed.config.providerOrder,
    ...(parsed.config.defaultModelSelection === undefined
      ? {}
      : { defaultModelSelection: parsed.config.defaultModelSelection }),
  });
}

const legacyCompleteManualSchema = completeModelConfigDataSchema.extend({
  enabled: modelConfigDataSchema.shape.enabled,
});

// The old editor used to treat MFJS as a manual requirement; when hidden it only recognized old legal shapes at file boundaries.
// Extract current editable fields to prevent the entire personal configuration from failing to load or continuing to freeze system capabilities.
const legacyEditableManualSchema = manualModelConfigSchema.extend({
  properties: manualModelConfigSchema.shape.properties.extend({
    requiresMfjsToolSchema:
      completeModelConfigDataSchema.shape.properties.shape.requiresMfjsToolSchema,
  }),
});

function normalizeLegacyManualRules(input: unknown): unknown {
  if (!isRecord(input) || !Array.isArray(input.manualProviderModelRules)) return input;
  return {
    ...input,
    manualProviderModelRules: input.manualProviderModelRules.map((rule: unknown) => {
      if (!isRecord(rule) || manualModelConfigSchema.safeParse(rule.config).success) return rule;
      // Only old complete shapes are recognized, and unknown/corrupted configurations are not disguised as success by deleting fields; the public write entry still strictly refuses to hide leaves.
      const legacy = z
        .union([legacyCompleteManualSchema, legacyEditableManualSchema])
        .safeParse(rule.config);
      return legacy.success ? { ...rule, config: extractManualModelConfig(legacy.data) } : rule;
    }),
  };
}

export function encodeProviderConfigFile(update: ProviderConfigLayerUpdate) {
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    config: {
      ...(update.providerOrder === undefined ? {} : { providerOrder: update.providerOrder }),
      providerConfigRules: { providerRules: update.providers.toJSON() },
      modelConfigRules: update.models.toPersonalJSON(),
      ...(update.defaultModelSelection === undefined
        ? {}
        : { defaultModelSelection: update.defaultModelSelection }),
    },
  };
}

function readSchemaVersion(input: unknown): number | null {
  if (!isRecord(input) || !("schemaVersion" in input)) return null;
  const version = input.schemaVersion;
  if (!Number.isInteger(version) || (version as number) < 0) {
    throw new UnsupportedProviderConfigVersionError(
      "Provider Config schemaVersion must be a non-negative integer",
      null,
    );
  }
  return version as number;
}

function requireSchemaVersion(input: unknown): number {
  const version = readSchemaVersion(input);
  if (version === null) {
    throw new UnsupportedProviderConfigVersionError(
      "Provider Config migrator must produce a versioned file",
      null,
    );
  }
  return version;
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}
