/* eslint-disable max-lines -- Provisioning target keeps transaction and rollback invariants together. */
import { readFile } from "node:fs/promises";
import { atomicWritePrivateTextFile, withFileLock } from "@zcode/shared/node";
import {
  type PersonalProviderConfigRepository,
  type ProviderConfigLayerUpdate,
} from "@zcode/provider";
import { decodeProviderConfigFile, encodeProviderConfigFile } from "@zcode/rust/provider-node";
import {
  providerProvisioningEnvelopeSchema,
  providerProvisioningResultSchema,
  isProviderProvisioningAccountCredentialKey,
  type ProviderProvisioningEnvelope,
  type ProviderProvisioningResult,
} from "@zcode/shared";
import type { ICredentialService } from "../credential/credential.js";
import type { ISettingService } from "../setting/setting.js";
import type { ProviderRuntime } from "./providerRuntime.js";
import type { AccountProviderService } from "@zcode/provider";
import type { IProviderProvisioningTargetService } from "./providerProvisioning.js";
import {
  PROVIDER_PROVISIONING_OAUTH_CREDENTIAL_KEYS,
  readProvisionablePersonalConfig,
} from "./providerProvisioningSource.js";

const PROVISIONING_SCHEMA_VERSION = 1 as const;

const OAUTH_CREDENTIAL_KEYS = new Set<string>(PROVIDER_PROVISIONING_OAUTH_CREDENTIAL_KEYS);

export interface ProviderProvisioningTargetOptions {
  readonly providerRuntime: ProviderRuntime;
  readonly personalRepository: PersonalProviderConfigRepository;
  readonly accountProviderSource: AccountProviderService;
  readonly credentialService: ICredentialService;
  readonly settingService: ISettingService;
  readonly personalConfigFilePath: string;
  readonly stateFilePath: string;
  readonly listProvisioningCredentialKeys?: () => Promise<readonly string[]>;
}

interface ProvisioningStateRecord {
  readonly syncId: string;
  readonly result: ProviderProvisioningResult;
}

interface ProvisioningStateFile {
  readonly schemaVersion: typeof PROVISIONING_SCHEMA_VERSION;
  readonly records: readonly ProvisioningStateRecord[];
}

/** Provisioning target that runs inside the target Environment; responsible for writing the real Store and rolling back on failure. */
export function createProviderProvisioningTarget(
  options: ProviderProvisioningTargetOptions,
): IProviderProvisioningTargetService {
  return {
    async apply(input: ProviderProvisioningEnvelope): Promise<ProviderProvisioningResult> {
      const envelope = providerProvisioningEnvelopeSchema.parse(input);
      return withFileLock(options.stateFilePath, async () => {
        const previousState = await readStateFile(options.stateFilePath);
        const previousResult = previousState?.records.find(
          (record) => record.syncId === envelope.syncId,
        );
        if (previousResult) {
          return {
            ...previousResult.result,
            status: "already-applied",
          } satisfies ProviderProvisioningResult;
        }

        validateCredentialEntries(envelope);
        await options.providerRuntime.start();
        const before = await captureBeforeState(envelope, options);
        const personalUpdate = parsePersonalConfig(envelope);
        const applied: AppliedProvisioningState = {
          settings: false,
          settingsExpected: envelope.accountSettings,
          credentials: [],
          personalConfig: false,
          personalConfigExpected: personalUpdate,
        };

        try {
          // Register first and then write: Even if the underlying atomic write throws an error after the replacement is completed, it must enter the rollback set.
          applied.settings = true;
          await options.settingService.update({
            providerFamilyDomain: envelope.accountSettings.providerFamilyDomain ?? undefined,
            providerFamilyConnectionSelections:
              envelope.accountSettings.providerFamilyConnectionSelections,
          });

          const incomingCredentials = new Map(
            envelope.credentials.map((credential) => [credential.key, credential.value]),
          );
          for (const key of before.credentials.keys()) {
            const value = incomingCredentials.get(key);
            applied.credentials.push({ key, value: value ?? null });
            if (value === undefined) await options.credentialService.delete(key);
            else await options.credentialService.save(key, value);
          }

          applied.personalConfig = true;
          await options.personalRepository.update((current) => {
            // Personal may have been edited while other fields were being written; the check and replacement must be within the same file lock.
            if (!samePersonalConfig(current, before.personal)) {
              throw new Error(
                "Personal Provider Config was modified by another operation during sync",
              );
            }
            return personalUpdate;
          });

          await options.accountProviderSource.refresh("provider-provisioning");
          const snapshot =
            await options.providerRuntime.registryService.refresh("provider-provisioning");
          if (
            personalUpdate.defaultModelSelection &&
            !options.providerRuntime.registryService.validateSelection(
              personalUpdate.defaultModelSelection,
            ).ok
          ) {
            throw new Error("The synced remote registry does not support the local default model");
          }

          const result = {
            syncId: envelope.syncId,
            status: "applied" as const,
            personalProviderCount: personalUpdate.providers.keys().length,
            credentialCount: envelope.credentials.length,
            configRevision: snapshot.sourceRevisions.config,
            rolledBack: false,
          } satisfies ProviderProvisioningResult;
          await writeStateFile(options.stateFilePath, appendStateRecord(previousState, result));
          return result;
        } catch (error) {
          // Perform CAS verification on each domain before rolling back; if there are other writes during the period, it is better to report
          // rollback_failed, and the user's new configuration cannot be overwritten or deleted with expired snapshots.
          const rollbackError = await rollback(before, applied, options);
          if (rollbackError) {
            return {
              syncId: envelope.syncId,
              status: "rollback_failed",
              personalProviderCount: before.personal.providers.keys().length,
              credentialCount: envelope.credentials.length,
              errorMessage: `${formatError(error)}; rollback failed: ${formatError(rollbackError)}`,
              rolledBack: false,
            } satisfies ProviderProvisioningResult;
          }
          return {
            syncId: envelope.syncId,
            status: "failed",
            personalProviderCount: before.personal.providers.keys().length,
            credentialCount: envelope.credentials.length,
            errorMessage: formatError(error),
            rolledBack: true,
          } satisfies ProviderProvisioningResult;
        }
      });
    },
  };
}

interface BeforeState {
  readonly personal: ProviderConfigLayerUpdate;
  readonly settings: Awaited<ReturnType<ISettingService["get"]>>;
  readonly credentials: ReadonlyMap<string, string | null>;
}

interface AppliedProvisioningState {
  settings: boolean;
  settingsExpected: ProviderProvisioningEnvelope["accountSettings"];
  credentials: Array<{ key: string; value: string | null }>;
  personalConfig: boolean;
  personalConfigExpected: ProviderConfigLayerUpdate;
}

function parsePersonalConfig(envelope: ProviderProvisioningEnvelope): ProviderConfigLayerUpdate {
  // Envelopes and local storage reuse the official Personal codec, without creating additional field lists or mode judgments on the receiving end.
  return decodeProviderConfigFile({ schemaVersion: 1, config: envelope.personalConfig });
}

async function captureBeforeState(
  envelope: ProviderProvisioningEnvelope,
  options: ProviderProvisioningTargetOptions,
): Promise<BeforeState> {
  const [personal, settings] = await Promise.all([
    readProvisionablePersonalConfig(options.personalRepository, options.personalConfigFilePath),
    options.settingService.get(),
  ]);
  const credentials = new Map<string, string | null>();
  const credentialKeys = new Set<string>([
    ...OAUTH_CREDENTIAL_KEYS,
    ...((await options.listProvisioningCredentialKeys?.()) ?? []),
    ...envelope.credentials.map((entry) => entry.key),
  ]);
  for (const key of credentialKeys) {
    if (!OAUTH_CREDENTIAL_KEYS.has(key) && !isProviderProvisioningAccountCredentialKey(key)) {
      continue;
    }
    credentials.set(key, await options.credentialService.load(key));
  }
  return {
    personal,
    settings,
    credentials,
  };
}

async function rollback(
  before: BeforeState,
  applied: AppliedProvisioningState,
  options: ProviderProvisioningTargetOptions,
): Promise<Error | undefined> {
  const errors: unknown[] = [];
  if (applied.personalConfig) {
    try {
      await options.personalRepository.update((current) => {
        if (samePersonalConfig(current, before.personal)) return current;
        if (!samePersonalConfig(current, applied.personalConfigExpected)) {
          throw new Error(
            "Personal Provider Config was modified by another operation during sync, skipping rollback",
          );
        }
        // The default selection shares a CAS with the Provider/Model; it is not possible to individually roll back the blended state or overwrite the new selection.
        return before.personal;
      });
    } catch (error) {
      errors.push(error);
    }
  }
  for (const { key, value } of applied.credentials) {
    try {
      const previous = before.credentials.get(key) ?? null;
      const current = await options.credentialService.load(key);
      if (current === previous) {
        continue;
      }
      if (current !== value) {
        errors.push(
          new Error(
            `Credential ${key} was modified by another operation during sync, skipping rollback`,
          ),
        );
        continue;
      }
      if (previous === null) {
        await options.credentialService.delete(key);
      } else {
        await options.credentialService.save(key, previous);
      }
    } catch (error) {
      errors.push(error);
    }
  }
  if (applied.settings) {
    try {
      const current = await options.settingService.get();
      const previousSettings = toProvisioningAccountSettings(before.settings);
      if (sameAccountSettings(current, previousSettings)) {
        // The write failure occurred before disk placement, and the target was already in the state before rollback.
      } else if (!sameAccountSettings(current, applied.settingsExpected)) {
        errors.push(
          new Error(
            "Account Settings were modified by another operation during sync, skipping rollback",
          ),
        );
      } else {
        await options.settingService.update({
          providerFamilyDomain: before.settings.providerFamilyDomain,
          providerFamilyConnectionSelections: before.settings.providerFamilyConnectionSelections,
        });
      }
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length > 0) {
    return new Error(errors.map(formatError).join(";"));
  }
  try {
    await options.accountProviderSource.refresh("provider-provisioning-rollback");
    await options.providerRuntime.registryService.refresh("provider-provisioning-rollback");
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
  return undefined;
}

function samePersonalConfig(
  left: ProviderConfigLayerUpdate,
  right: ProviderConfigLayerUpdate,
): boolean {
  return (
    JSON.stringify(encodeProviderConfigFile(left)) ===
    JSON.stringify(encodeProviderConfigFile(right))
  );
}

function toProvisioningAccountSettings(
  settings: Awaited<ReturnType<ISettingService["get"]>>,
): ProviderProvisioningEnvelope["accountSettings"] {
  return {
    providerFamilyDomain: settings.providerFamilyDomain ?? null,
    providerFamilyConnectionSelections: settings.providerFamilyConnectionSelections ?? {},
  };
}

function sameAccountSettings(
  current: Awaited<ReturnType<ISettingService["get"]>>,
  expected: ProviderProvisioningEnvelope["accountSettings"],
): boolean {
  return JSON.stringify(toProvisioningAccountSettings(current)) === JSON.stringify(expected);
}

function validateCredentialEntries(envelope: ProviderProvisioningEnvelope): void {
  const seen = new Set<string>();
  for (const entry of envelope.credentials) {
    if (seen.has(entry.key)) throw new Error(`Duplicate provisioning credential key: ${entry.key}`);
    seen.add(entry.key);
    const allowed =
      (entry.scope === "oauth-session" && OAUTH_CREDENTIAL_KEYS.has(entry.key)) ||
      (entry.scope === "account-provider" && isProviderProvisioningAccountCredentialKey(entry.key));
    if (!allowed) throw new Error(`Credential key is not allowed to sync: ${entry.key}`);
  }
}

async function readStateFile(filePath: string): Promise<ProvisioningStateFile | null> {
  try {
    const parsed = JSON.parse(await readFile(filePath, "utf8")) as Record<string, unknown>;
    if (parsed.schemaVersion !== PROVISIONING_SCHEMA_VERSION) {
      return null;
    }
    const rawRecords = Array.isArray(parsed.records)
      ? parsed.records
      : parsed.syncId && parsed.result
        ? [{ syncId: parsed.syncId, result: parsed.result }]
        : [];
    const records = rawRecords.flatMap((record) => {
      if (typeof record !== "object" || record === null) return [];
      const candidate = record as Record<string, unknown>;
      if (typeof candidate.syncId !== "string" || !candidate.syncId.trim()) return [];
      const result = providerProvisioningResultSchema.safeParse(candidate.result);
      return result.success ? [{ syncId: candidate.syncId, result: result.data }] : [];
    });
    return { schemaVersion: PROVISIONING_SCHEMA_VERSION, records };
  } catch (error) {
    if (isFileNotFound(error)) return null;
    return null;
  }
}

function appendStateRecord(
  previousState: ProvisioningStateFile | null,
  result: ProviderProvisioningResult,
): ProvisioningStateFile {
  const records = [
    ...(previousState?.records ?? []).filter((record) => record.syncId !== result.syncId),
    { syncId: result.syncId, result },
  ];
  return {
    schemaVersion: PROVISIONING_SCHEMA_VERSION,
    records,
  };
}

function writeStateFile(filePath: string, state: ProvisioningStateFile): Promise<void> {
  return atomicWritePrivateTextFile(filePath, `${JSON.stringify(state, null, 2)}\n`);
}

function isFileNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
