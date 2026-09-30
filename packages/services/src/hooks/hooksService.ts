import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import type {
  Hook,
  HookEvent,
  SettingsDirectoryLocation,
  SettingsDirectorySource,
} from "@zcode/shared";
import {
  buildWorkspaceHookBundleSnapshot,
  createWorkspaceHookSourceInput,
  readWorkspaceHookProjectSources,
  resolveWorkspaceHookRuntimeRoot,
  workspaceHooksConfigSchema,
  type WorkspaceHookBundleSnapshotData,
  type WorkspaceHookSourceInput,
  type WorkspaceHooksConfig,
} from "@zcode/shared/workspace-hook-discovery";
import { parseWorkspaceHookTrustStoreContent } from "@zcode/shared/workspace-hook-trust-store-file";
import { createServiceLogger, type ServiceLogger } from "#src/logger/serviceLogger.js";
import type { IHooksService } from "./hooks.js";
import { atomicWriteWorkspaceHookConfig } from "./workspaceHookConfigMutation.js";
import {
  fromLegacyHooksConfig,
  fromProjectSnapshot,
  fromUserZCodeSource,
  resolveNextRootEnabled,
  toZCodeHooksEvents,
  type LegacyHooksConfig,
} from "./workspaceHookSettingsModel.js";

const SETTINGS_FILE = "settings.json";
const ZCODE_CONFIG_FILE = "config.json";
const HOOK_EVENTS: readonly HookEvent[] = [
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "PermissionRequest",
  "PostToolUse",
  "PostToolUseFailure",
  "Stop",
];

interface ZCodeConfigFile {
  hooks?: WorkspaceHooksConfig;
  [key: string]: unknown;
}

function resolveUserHomeDir(): string {
  const envHome = process.env.HOME?.trim() || process.env.USERPROFILE?.trim();
  return envHome && envHome.length > 0 ? envHome : homedir();
}

function getRootDir(source: SettingsDirectorySource, workspacePath?: string): string {
  const baseDir = workspacePath ?? resolveUserHomeDir();
  if (source === "zcode") {
    return workspacePath ? join(baseDir, ".zcode") : join(baseDir, ".zcode", "cli");
  }
  return join(baseDir, source === "agents" ? ".agents" : ".claude");
}

function getConfigPath(source: SettingsDirectorySource, workspacePath?: string): string {
  return join(
    getRootDir(source, workspacePath),
    source === "zcode" ? ZCODE_CONFIG_FILE : SETTINGS_FILE,
  );
}

function buildLocation(
  source: SettingsDirectorySource,
  workspacePath?: string,
): SettingsDirectoryLocation {
  return {
    source,
    scope: workspacePath ? "project" : "user",
    directoryPath: getRootDir(source, workspacePath),
    ...(workspacePath ? { projectPath: workspacePath } : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isHookEvent(value: string): value is HookEvent {
  return (HOOK_EVENTS as readonly string[]).includes(value);
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}

async function readJsonFile<T>(filePath: string): Promise<T | null> {
  try {
    if (!existsSync(filePath)) return null;
    const parsed = JSON.parse(await readFile(filePath, "utf8")) as unknown;
    return isRecord(parsed) ? (parsed as T) : null;
  } catch {
    return null;
  }
}

async function readUserZCodeSource(): Promise<WorkspaceHookSourceInput | undefined> {
  const path = getConfigPath("zcode");
  const config = await readJsonFile<Record<string, unknown>>(path);
  const parsed = workspaceHooksConfigSchema.safeParse(config?.hooks);
  if (!parsed.success) return undefined;
  return {
    ...createWorkspaceHookSourceInput({
      path,
      workingDirectory: resolveUserHomeDir(),
      hooks: parsed.data,
      discoveryOrder: 0,
      explicitProjectConfig: true,
    }),
    editable: true,
  };
}

async function loadLegacyHooksFromLocation(
  source: "agents" | "claude",
  workspacePath?: string,
): Promise<Hook[]> {
  return fromLegacyHooksConfig({
    legacyConfig: await readJsonFile<LegacyHooksConfig>(getConfigPath(source, workspacePath)),
    location: buildLocation(source, workspacePath),
    isHookEvent,
  });
}

/**
 * Read the persistent workspace hook trust digest collection.
 *
 * The entire function cannot be wrapped in `try { ... } catch { return new Set(); }`:
 * Corrupted/unreadable files are indistinguishable from "no trust records" and have zero diagnostics. Root cause: Trust store read failed and was
 * After swallowing, the caller can only mark all hooks as `pending_trust` ("requires review"), and the Runtime side
 * Explicit detection of trust store corruption and hard blocking with `blocked_untrusted` - user sees an audit entry
 * But no matter how it is approved, Runtime will not release it. This is a presentation/runtime divergence (both sides are fail-closed).
 *
 * Handwritten local field verification (isRecord + digest regular) and runtime/adapters
 * The complete strict schema used leads to inconsistent conclusions - "JSON is legal but the structure is illegal" (missing schemaVersion,
 * Files with illegal decisions, illegal timestamps, unknown fields, etc.) will be regarded as partially credible by this layer, but the runtime will determine
 * Corrupt blocks everything, the UI displays "Trusted" and the Hook never executes. The trust store is the permission boundary, and all consumers
 * readers must come to the same conclusion about the same file: use shared instead
 * parseWorkspaceHookTrustStoreContent (single authoritative sinking implementation of contracts schema),
 * Any parse failure will be corrupt + fail-closed and no partial digest will be returned.
 *
 * Note: Storage directory resolution (~/ of storage.dir, relative path processing) and Runtime side
 * resolveWorkspaceHookTrustStorePath (adapters) are logically equivalent but are inline - architectural services
 * There should be no reverse dependence on adapters. Unification needs to sink to the shared layer. Only the duplication is recorded here.
 */
async function readPersistentWorkspaceHookTrustDigests(
  workspaceIdentity: string,
  logger: ServiceLogger,
): Promise<{ digests: Set<string>; corrupt: boolean }> {
  const userConfig = (await readJsonFile<Record<string, unknown>>(getConfigPath("zcode"))) ?? {};
  const storage = isRecord(userConfig.storage) ? userConfig.storage : {};
  const configured = typeof storage.dir === "string" ? storage.dir.trim() : "";
  const home = resolveUserHomeDir();
  const storageRoot = configured
    ? configured.startsWith("~/")
      ? join(home, configured.slice(2))
      : isAbsolute(configured)
        ? resolve(configured)
        : resolve(home, configured)
    : join(home, ".zcode");
  const trustFilePath = join(storageRoot, "security", "workspace-hook-trust-v1.json");

  // Asynchronous reading + ENOENT distinction: no existsSync preflight required - synchronous calls will block the service
  // thread, and there is a TOCTOU window between "Check→Read"; the ENOENT of readFile itself is
  // The authoritative "file does not exist" signal.
  let content: string;
  try {
    content = await readFile(trustFilePath, "utf8");
  } catch (error) {
    if (isNodeError(error, "ENOENT")) {
      // File does not exist ⇒ Reasonable no record, returns empty set and does not mark corrupt.
      return { digests: new Set<string>(), corrupt: false };
    }
    // The services layer directly console.warn and cannot enter the unified service log file, nor can it
    // Inject sink in test. Use an injectable ServiceLogger instead; this is a low-frequency reversible downgrade, use warn.
    logger.warn(
      undefined,
      "Workspace Hook Trust store is unreadable, failing closed and ignoring all persisted trust records",
      {
        path: trustFilePath,
        error: error instanceof Error ? error.message : String(error),
      },
    );
    return { digests: new Set<string>(), corrupt: true };
  }

  // JSON syntax errors and schema verification failures are collectively judged as corrupt (the same as runtime/adapters).
  const parsedStore = parseWorkspaceHookTrustStoreContent(content);
  if (parsedStore.status === "invalid") {
    logger.warn(
      undefined,
      "Workspace Hook Trust store does not match the schema, failing closed and ignoring all persisted trust records",
      { path: trustFilePath },
    );
    return { digests: new Set<string>(), corrupt: true };
  }

  const digests = new Set<string>(
    parsedStore.file.records
      .filter((record) => record.workspaceIdentity === workspaceIdentity)
      .map((record) => record.hookDeclarationDigest),
  );
  return { digests, corrupt: false };
}

async function loadHooksImpl(
  params: {
    workspaceIdentity?: string;
    workspacePath: string;
  },
  logger: ServiceLogger,
): Promise<{
  hooks: Hook[];
  hooksEnabled: boolean;
  workspaceHookSnapshot?: WorkspaceHookBundleSnapshotData;
}> {
  const workspacePath = resolve(params.workspacePath);
  const workspaceIdentity = params.workspaceIdentity?.trim() || workspacePath;
  const [{ sources: projectSources }, userSource] = await Promise.all([
    readWorkspaceHookProjectSources({ workingDirectory: workspacePath }),
    readUserZCodeSource(),
  ]);
  const runtimeRoot = resolveWorkspaceHookRuntimeRoot([
    userSource?.hooks,
    ...projectSources.map((source) => source.hooks),
  ]);
  const workspaceHookSnapshot = buildWorkspaceHookBundleSnapshot({
    workspaceIdentity,
    workspacePath,
    sources: projectSources,
    runtimeRoot,
  });
  const persistentTrust = await readPersistentWorkspaceHookTrustDigests(workspaceIdentity, logger);
  const persistentTrustedDigests = persistentTrust.digests;
  const hooks = [
    ...fromProjectSnapshot({
      sources: projectSources,
      snapshot: workspaceHookSnapshot,
      workspaceIdentity,
      workspacePath,
      persistentTrustedDigests,
    }),
    ...(await loadLegacyHooksFromLocation("agents", workspacePath)),
    ...(await loadLegacyHooksFromLocation("claude", workspacePath)),
    ...fromUserZCodeSource({
      source: userSource,
      runtimeRoot,
      workspacePath,
      location: buildLocation("zcode"),
    }),
    ...(await loadLegacyHooksFromLocation("agents")),
    ...(await loadLegacyHooksFromLocation("claude")),
  ];
  return {
    hooks,
    hooksEnabled: hooks.some((hook) => hook.enabled),
    ...(workspaceHookSnapshot ? { workspaceHookSnapshot } : {}),
    ...(persistentTrust.corrupt ? { trustStoreCorrupt: true } : {}),
  };
}

async function writeZCodeHooksConfig(
  workspacePath: string | undefined,
  hooks: Hook[],
): Promise<void> {
  const configPath = getConfigPath("zcode", workspacePath);
  const existingConfig = (await readJsonFile<ZCodeConfigFile>(configPath)) ?? {};
  const enabled = resolveNextRootEnabled(existingConfig.hooks?.enabled, hooks);
  await atomicWriteWorkspaceHookConfig(configPath, {
    ...existingConfig,
    hooks: {
      ...existingConfig.hooks,
      ...(enabled !== undefined ? { enabled } : {}),
      events: toZCodeHooksEvents(hooks),
    },
  });
}

async function saveHooksImpl(params: {
  workspaceIdentity?: string;
  workspacePath: string;
  hooks: Hook[];
}): Promise<void> {
  const currentProjectConfigPath = resolve(params.workspacePath, ".zcode", "config.json");
  const userHooks = params.hooks.filter(
    (hook) =>
      hook.editable !== false &&
      (!hook.location || (hook.location.source === "zcode" && hook.location.scope === "user")),
  );
  const projectHooks = params.hooks.filter(
    (hook) =>
      hook.editable !== false &&
      hook.location?.source === "zcode" &&
      hook.location.scope === "project" &&
      (!hook.configuredState ||
        resolve(hook.configuredState.sourcePath) === currentProjectConfigPath),
  );
  await writeZCodeHooksConfig(undefined, userHooks);
  await writeZCodeHooksConfig(params.workspacePath, projectHooks);
}

export function createHooksService(
  options: {
    logger?: ServiceLogger;
    grantWorkspaceHookTrust?: NonNullable<IHooksService["grantWorkspaceHookTrust"]>;
  } = {},
): IHooksService {
  const logger = options.logger ?? createServiceLogger("hooks-service");
  return {
    loadHooks: (params) => loadHooksImpl(params, logger),
    saveHooks: saveHooksImpl,
    ...(options.grantWorkspaceHookTrust
      ? { grantWorkspaceHookTrust: options.grantWorkspaceHookTrust }
      : {}),
  };
}
