import type {
  ProviderFamilyConnectionSelectionSettings,
  ProviderFamilyDomain,
} from "@zcode/shared";
import { readFile } from "node:fs/promises";

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export interface LegacyTeamConnection {
  readonly family: ProviderFamilyDomain;
  readonly productId: string;
  readonly projectId: string;
}

/** Only the migrator interprets the legacy keys; organization info is injected by the Host's read-only OAuth query. Delete once the legacy version is retired. */
export function readIncompleteLegacyTeamConnections(value: unknown): LegacyTeamConnection[] {
  if (!needsLegacyAccountConnectionMigration(value)) return [];
  const raw = record(value);
  const modes = record(raw.modelProviderFamilyModes);
  const keys = record(raw.modelProviderFamilySelectedKeys);
  return (["zai", "bigmodel"] as const).flatMap((family) => {
    if (modes[family] === "apiKey") return [];
    const prefix = `team-plan:builtin:${family}-coding-plan:`;
    const key = typeof keys[family] === "string" ? keys[family].trim() : "";
    if (!key.startsWith(prefix)) return [];
    try {
      const parts = key
        .slice(prefix.length)
        .split(":")
        .map((part) => decodeURIComponent(part).trim());
      if (parts.length !== 2 || parts.some((part) => !part)) return [];
      return [{ family, productId: parts[0]!, projectId: parts[1]! }];
    } catch {
      return [];
    }
  });
}

export async function readLegacyAccountConnectionSettingsFile(
  filePath: string,
): Promise<Record<string, unknown>> {
  try {
    return record(JSON.parse(await readFile(filePath, "utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
}

export function needsLegacyAccountConnectionMigration(value: unknown): boolean {
  const raw = record(value);
  return (
    !Object.hasOwn(raw, "providerFamilyConnectionSelections") &&
    (Object.hasOwn(raw, "modelProviderFamilySelectedKeys") ||
      Object.hasOwn(raw, "modelProviderFamilyModes"))
  );
}

/** Legacy connections are imported only at the settings file read boundary; runtime code must no longer interpret legacy navigation keys. */
export function migrateLegacyAccountConnectionSettings(value: unknown): unknown {
  if (!needsLegacyAccountConnectionMigration(value)) return value;
  const raw = record(value);
  const modes = record(raw.modelProviderFamilyModes);
  const keys = record(raw.modelProviderFamilySelectedKeys);
  const selections: ProviderFamilyConnectionSelectionSettings = {};
  for (const family of ["zai", "bigmodel"] as const) {
    // API instances are responsible for provider configuration migration; the old API model is not an account package.
    if (modes[family] === "apiKey") continue;
    const key = typeof keys[family] === "string" ? keys[family].trim() : "";
    if (key === `coding-plan:builtin:${family}-start-plan`) {
      selections[family] = { kind: "start-plan" };
    } else if (key === `coding-plan:builtin:${family}-coding-plan`) {
      selections[family] = { kind: "individual-coding-plan" };
    } else {
      const prefix = `team-plan:builtin:${family}-coding-plan:`;
      if (!key.startsWith(prefix)) continue;
      try {
        const parts = key
          .slice(prefix.length)
          .split(":")
          .map((part) => decodeURIComponent(part).trim());
        // The old project-only key cannot determine the organization, so keep the original fields instead of fabricating the new Team identity.
        if (parts.length !== 3 || parts.some((part) => !part)) continue;
        const [productId, organizationId, projectId] = parts as [string, string, string];
        selections[family] = { kind: "team-coding-plan", productId, organizationId, projectId };
      } catch {
        // The broken encoding only affects this one item and cannot make the entire setting.json fall back to the default value.
      }
    }
  }
  return { ...raw, providerFamilyConnectionSelections: selections };
}

/** The legacy fields exist only for rollback; they must never be exposed back into AppSettings or take part in current runtime decisions. Delete once the legacy version is retired. */
export function retainLegacyAccountConnectionFields(value: unknown): Record<string, unknown> {
  const raw = record(value);
  return Object.fromEntries(
    ["modelProviderFamilyModes", "modelProviderFamilySelectedKeys"]
      .filter((key) => Object.hasOwn(raw, key))
      .map((key) => [key, raw[key]]),
  );
}
