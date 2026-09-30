import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  isProviderProvisioningAccountCredentialKey,
  providerProvisioningEnvelopeSchema,
  type ProviderProvisioningCredentialEntry,
  type ProviderProvisioningEnvelope,
} from "@zcode/shared";
import type {
  PersonalProviderConfigRepository,
  ProviderConfigLayerSnapshot,
} from "@zcode/provider";
import { decodeProviderConfigFile, encodeProviderConfigFile } from "@zcode/provider-node";
import {
  createCredentialCipherProvider,
  type CredentialCipherProvider,
} from "../credential/providers/credentialCipherProvider.js";
import type { ISettingService } from "../setting/setting.js";

const CREDENTIAL_FILE_NAME = "credentials.json";
export const PROVIDER_PROVISIONING_OAUTH_CREDENTIAL_KEYS = [
  "oauth:active_provider",
  "oauth:zai:access_token",
  "oauth:zai:refresh_token",
  "oauth:zai:user_info",
  "oauth:bigmodel:access_token",
  "oauth:bigmodel:refresh_token",
  "oauth:bigmodel:user_info",
  "zcodejwttoken",
] as const;

export interface ProviderProvisioningSource {
  read(syncId: string): Promise<ProviderProvisioningEnvelope>;
}

export interface ProviderProvisioningSourceOptions {
  readonly personalRepository: PersonalProviderConfigRepository;
  readonly settingService: ISettingService;
  readonly credentialFilePath: string;
  readonly personalConfigFilePath: string;
  readonly cipherProvider?: CredentialCipherProvider;
}

/** Reads the provisionable facts from the Local Environment; it never reads or exports a full Registry Snapshot. */
export function createProviderProvisioningSource(
  options: ProviderProvisioningSourceOptions,
): ProviderProvisioningSource {
  return {
    async read(syncId: string): Promise<ProviderProvisioningEnvelope> {
      const [personal, settings, credentials] = await Promise.all([
        readProvisionablePersonalConfig(options.personalRepository, options.personalConfigFilePath),
        options.settingService.get(),
        readProvisioningCredentials(options.credentialFilePath, options.cipherProvider),
      ]);
      // The default and the rules come from the same lock-holding read, and the values ​​read twice cannot be combined into a non-existent configuration version.
      const personalConfig = encodeProviderConfigFile(personal).config;
      const accountSettings = {
        providerFamilyDomain: settings.providerFamilyDomain ?? null,
        providerFamilyConnectionSelections: settings.providerFamilyConnectionSelections ?? {},
      };
      return providerProvisioningEnvelopeSchema.parse({
        schemaVersion: 1,
        syncId,
        personalConfig,
        accountSettings,
        credentials,
      });
    },
  };
}

/** Distribution reads must not treat an in-memory fallback for a corrupt file as authoritative; Source and Target share the same strict-read constraint. */
export async function readProvisionablePersonalConfig(
  repository: PersonalProviderConfigRepository,
  filePath: string,
): Promise<ProviderConfigLayerSnapshot> {
  const personal = await repository.read();
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (error) {
    if (isFileNotFound(error)) {
      const rules = personal.models.toPersonalJSON();
      // If there is no Personal file for the first time, it is a legal empty configuration; after the existing content, the file disappears and old snapshots cannot be exported.
      if (
        personal.providers.keys().length === 0 &&
        rules.providerModelRules.length === 0 &&
        rules.manualProviderModelRules.length === 0 &&
        !personal.providerOrder?.length &&
        personal.defaultModelSelection === undefined
      )
        return personal;
    }
    throw new Error(`local Personal Provider Config cannot be synced: ${filePath}`, {
      cause: error,
    });
  }
  try {
    const decoded = decodeProviderConfigFile(JSON.parse(raw) as unknown);
    const actualRevision = createHash("sha256")
      .update(JSON.stringify(encodeProviderConfigFile(decoded)))
      .digest("hex");
    if (actualRevision !== personal.revision) {
      throw new Error("Personal Provider Config changed while being read");
    }
    return personal;
  } catch (error) {
    throw new Error(`local Personal Provider Config cannot be synced: ${filePath}`, {
      cause: error,
    });
  }
}

async function readProvisioningCredentials(
  credentialFilePath: string,
  cipherProvider?: CredentialCipherProvider,
): Promise<ProviderProvisioningCredentialEntry[]> {
  let raw: string;
  try {
    raw = await readFile(credentialFilePath, "utf8");
  } catch (error) {
    if (isFileNotFound(error)) return [];
    throw error;
  }
  const parsed = JSON.parse(raw) as unknown;
  if (!isRecord(parsed)) {
    throw new Error("Credential Store must be a JSON object");
  }
  const cipher = cipherProvider ?? createCredentialCipherProvider();
  const allowedKeys = new Set<string>(PROVIDER_PROVISIONING_OAUTH_CREDENTIAL_KEYS);
  const entries: ProviderProvisioningCredentialEntry[] = [];
  // The Credential Store may also contain historical records that are not part of the Provisioning allowlist;
  // These records are not the facts of this synchronization, and the synchronization of legitimate account credentials cannot be blocked because their values are damaged.
  // Entries in the allowlist still maintain string and decryption verification to avoid unknown content being transmitted as Secret.
  for (const [key, encrypted] of Object.entries(parsed)) {
    const scope = allowedKeys.has(key)
      ? ("oauth-session" as const)
      : isProviderProvisioningAccountCredentialKey(key)
        ? ("account-provider" as const)
        : undefined;
    if (!scope) continue;
    if (typeof encrypted !== "string") {
      throw new Error(`Credential allowlist value must be a string: ${key}`);
    }
    const value = cipher.decrypt(encrypted);
    if (!value.trim()) continue;
    entries.push({ scope, key, value });
  }
  return entries;
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}

function isFileNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

export function resolveCredentialFilePath(appConfigDir: string): string {
  return join(appConfigDir, CREDENTIAL_FILE_NAME);
}

/** Enumerates only the physical keys of the Provisioning allowlist, so the target end can implement replace-allowlist deletion semantics. */
export async function listProviderProvisioningCredentialKeys(
  credentialFilePath: string,
): Promise<readonly string[]> {
  let raw: string;
  try {
    raw = await readFile(credentialFilePath, "utf8");
  } catch (error) {
    if (isFileNotFound(error)) return [];
    throw error;
  }
  const parsed = JSON.parse(raw) as unknown;
  if (!isRecord(parsed)) throw new Error("Credential Store must be a JSON object");
  const oauthKeys = new Set<string>(PROVIDER_PROVISIONING_OAUTH_CREDENTIAL_KEYS);
  return Object.keys(parsed).filter(
    (key) => oauthKeys.has(key) || isProviderProvisioningAccountCredentialKey(key),
  );
}
