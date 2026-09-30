import { access, readFile, mkdir, rename } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import type {
  AppSettings,
  ProviderFamilyDomain,
  ProviderFamilyConnectionSelectionSettings,
} from "@zcode/shared";
import {
  appSettingsPatchSchema,
  appSettingsSchema,
  formatLogPrefix,
  formatZodError,
} from "@zcode/shared";
import type { ISettingService } from "./setting.js";
import { normalizeSettingsPatch } from "#src/setting/normalizeSettingsPatch.js";
import { copyDataDirectory, getDataBaseDir, validateDataBaseDirTarget } from "../paths.js";
import { isEffectiveDevelopmentNodeEnv } from "../runtime-tools/nodeEnv.js";
import { maybeThrowInjectedFsFault } from "../fs/fsFaultInjection.js";
import { atomicWriteText } from "../fs/atomicFileUtils.js";
import { withSettingsWriteQueueTimeout } from "./settingsWriteQueue.js";
import {
  migrateLegacyAccountConnectionSettings,
  needsLegacyAccountConnectionMigration,
  readLegacyAccountConnectionSettingsFile,
  readIncompleteLegacyTeamConnections,
  retainLegacyAccountConnectionFields,
  type LegacyTeamConnection,
} from "#src/setting/legacyAccountConnectionSettings.js";
const MAX_RECENT_PROJECTS = 10;
const DEFAULT_PROJECT_NAME = "ZCodeProject";
const SETTINGS_PARSE_RETRY_DELAY_MS = 300;
const SETTINGS_PARSE_RETRY_COUNT = 3;

const log = (...args: unknown[]) =>
  console.log(formatLogPrefix("settingService", process.pid), ...args);
const debugLog = (...args: unknown[]) => {
  // NODE_ENV will mislead the service layer debug switch when coming from the user shell; use ZCODE_RUNTIME_ENV uniformly.
  if (!isEffectiveDevelopmentNodeEnv()) {
    return;
  }
  console.debug(formatLogPrefix("settingService", process.pid), ...args);
};

function resolveUserHomeDir() {
  // The independent desktop Dev instance has set its own home, and the service settings still reflect the real HOME.
  // Causes startup migrations and appearance operations to pollute other instances. Consistent with Electron's explicit home override.
  const envHome =
    process.env.ZCODE_DESKTOP_HOME_DIR?.trim() ||
    process.env.HOME?.trim() ||
    process.env.USERPROFILE?.trim();
  return envHome && envHome.length > 0 ? envHome : homedir();
}

function getSettingsDir() {
  return join(resolveUserHomeDir(), ".zcode", "v2");
}

function getSettingsFile() {
  return join(getSettingsDir(), "setting.json");
}

function defaultSettings(): AppSettings {
  return appSettingsSchema.parse({}) as AppSettings;
}

function buildCorruptSettingsBackupPath(settingsFile: string): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `${settingsFile}.corrupt-${timestamp}`;
}

async function quarantineCorruptSettingsFile(settingsFile: string, error: unknown): Promise<void> {
  const backupPath = buildCorruptSettingsBackupPath(settingsFile);
  try {
    // Manual editing by users or remote disk abnormalities may write setting.json as non-JSON (for example, ":wq").
    // If you only return the default value and do not isolate bad files, parsing will fail repeatedly every time you start it. Keep the backup here and let subsequent updates rebuild the legal configuration.
    maybeThrowInjectedFsFault({ operation: "rename", path: settingsFile });
    await rename(settingsFile, backupPath);
    log("invalid settings json backed up:", backupPath, "error:", error);
  } catch (renameError) {
    if (
      renameError &&
      typeof renameError === "object" &&
      "code" in renameError &&
      (renameError as { code?: string }).code === "ENOENT"
    ) {
      // Multiple services may read the same bad setting.json at the same time during startup.
      // After the first read has completed isolation, subsequent reads will encounter ENOENT when renamed; this is an expected result under concurrency, and the error log should not be flushed based on backup failure.
      log("invalid settings json already quarantined by another reader, returning defaults");
      return;
    }
    log("invalid settings json backup failed, returning defaults. error:", renameError);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function shouldPersistSettingsMigrations(rawValue: unknown): boolean {
  if (!rawValue || typeof rawValue !== "object" || Array.isArray(rawValue)) return false;
  const raw = rawValue as Record<string, unknown>;
  return (
    (needsLegacyAccountConnectionMigration(rawValue) &&
      readIncompleteLegacyTeamConnections(rawValue).length === 0) ||
    raw.closeToTrayOnWindowsMigrationInitialized !== true ||
    raw.messageStreamShowReasoningMigrationInitialized !== true
  );
}

interface ReadSettingsResult {
  settings: AppSettings;
  needsMigrationPersist: boolean;
}

async function readSettingsWithMeta(): Promise<ReadSettingsResult> {
  const settingsFile = getSettingsFile();
  try {
    // settingService.get() will be called frequently by UI and remote sessions.
    // In the past, the complete configuration was written to the production log every time it was read, causing the log to explode and expose path/configuration details; normal reads only retained development debug.
    debugLog("reading settings from:", settingsFile);
    const raw = await readFile(settingsFile, "utf-8");
    let rawValue: unknown;
    try {
      rawValue = JSON.parse(raw);
    } catch (parseError) {
      let lastParseError: unknown = parseError;
      // setting.json may be being overwritten by another update, and readers will briefly read half of the JSON.
      // Perform short retries first, and isolate bad files only after continuous failures to avoid accidentally clearing normal session configurations to default values.
      for (let retryAttempt = 1; retryAttempt <= SETTINGS_PARSE_RETRY_COUNT; retryAttempt += 1) {
        await delay(SETTINGS_PARSE_RETRY_DELAY_MS);
        try {
          rawValue = JSON.parse(await readFile(settingsFile, "utf-8"));
          break;
        } catch (retryParseError) {
          lastParseError = retryParseError;
        }
      }
      if (rawValue === undefined) {
        await quarantineCorruptSettingsFile(settingsFile, lastParseError);
        return {
          settings: defaultSettings(),
          needsMigrationPersist: false,
        };
      }
    }
    const result = appSettingsSchema.safeParse(migrateLegacyAccountConnectionSettings(rawValue));
    if (!result.success) {
      log(
        "read failed schema validation, returning defaults. error:",
        formatZodError(result.error),
      );
      return {
        settings: defaultSettings(),
        needsMigrationPersist: false,
      };
    }
    debugLog("read result:", JSON.stringify(result.data));
    return {
      settings: result.data as AppSettings,
      needsMigrationPersist: shouldPersistSettingsMigrations(rawValue),
    };
  } catch (err) {
    if (
      err &&
      typeof err === "object" &&
      "code" in err &&
      (err as { code?: string }).code === "ENOENT"
    ) {
      debugLog("settings file missing, using defaults");
      return {
        settings: defaultSettings(),
        needsMigrationPersist: false,
      };
    }

    // File parsing failure and other exceptions will return to the default value.
    log("read failed, returning defaults. error:", err);
    return {
      settings: defaultSettings(),
      needsMigrationPersist: false,
    };
  }
}

async function readSettings(): Promise<AppSettings> {
  return (await readSettingsWithMeta()).settings;
}

async function writeSettings(
  settings: AppSettings,
  shouldCommit: () => boolean = () => true,
  runExclusiveCommit: (commit: () => Promise<void>) => Promise<void> = (commit) => commit(),
  enterCommitPhase: () => void = () => undefined,
  commitAccountSelection = false,
): Promise<void> {
  const settingsDir = getSettingsDir();
  const settingsFile = getSettingsFile();
  // The test under Windows only changed HOME. If the top-level constants of the module are fixed in homedir() when imported,
  // Subsequent reads and writes will still go to the real user directory. Here it is changed to parse the configuration path according to the current environment each time to ensure that both local and testing are stable.
  log("writing settings to:", settingsFile, JSON.stringify(settings));
  maybeThrowInjectedFsFault({ operation: "mkdir", path: settingsDir });
  await mkdir(settingsDir, { recursive: true });
  if (!shouldCommit()) return;
  maybeThrowInjectedFsFault({ operation: "writeFile", path: settingsFile });
  const raw = await readLegacyAccountConnectionSettingsFile(settingsFile);
  const rollbackFields = retainLegacyAccountConnectionFields(raw);
  const persisted = { ...rollbackFields, ...settings };
  // When the old Team is yet to be reorganized by OAuth, the default {} for the schema is not the new choice for users.
  // Ordinary preference saves must leave new fields absent; old imports will only end if the migration is submitted or the user explicitly chooses to connect.
  if (!commitAccountSelection && readIncompleteLegacyTeamConnections(raw).length > 0) {
    delete persisted.providerFamilyConnectionSelections;
  }
  await atomicWriteText(settingsFile, JSON.stringify(persisted, null, 2), {
    beforeRename: () => {
      if (!shouldCommit()) {
        // Old writes that time out before committing can only clean up temporary files and cannot be renamed late to overwrite the new language preference.
        throw new Error("stale settings write skipped before atomic rename");
      }
      enterCommitPhase();
    },
    runRename: (renameFile) =>
      runExclusiveCommit(async () => {
        if (!shouldCommit()) throw new Error("stale settings write skipped before atomic rename");
        await renameFile();
      }),
  });
  log("write done");
}

export function createSettingService(): ISettingService {
  return createSettingServiceWithMigrations().service;
}

/** Host-private migration entry point, not added to the Setting RPC; ordinary get/update never wait for OAuth queries. */
export function createSettingServiceWithMigrations(): {
  service: ISettingService;
  prepareLegacyAccountConnections: (
    resolveOrganization: (connection: LegacyTeamConnection) => Promise<string | null>,
  ) => Promise<readonly ProviderFamilyDomain[]>;
} {
  let updateQueue = Promise.resolve();
  let commitQueue = Promise.resolve();
  let writeQueueGeneration = 0;

  const runSettingsCommit = async (commit: () => Promise<void>) => {
    const queued = commitQueue.then(commit, commit);
    commitQueue = queued.catch(() => {});
    await queued;
  };

  const enqueueSettingsWrite = async (
    runUpdate: (shouldCommit: () => boolean, enterCommitPhase: () => void) => Promise<void>,
  ) => {
    const runCurrentUpdate = () => {
      const currentGeneration = ++writeQueueGeneration;
      const shouldCommit = () => currentGeneration === writeQueueGeneration;
      return withSettingsWriteQueueTimeout(
        (enterCommitPhase) => runUpdate(shouldCommit, enterCommitPhase),
        () => {
          if (writeQueueGeneration === currentGeneration) {
            writeQueueGeneration += 1;
          }
        },
      );
    };
    const queued = updateQueue.then(
      () => runCurrentUpdate(),
      () => runCurrentUpdate(),
    );
    updateQueue = queued.catch(() => {});
    await queued;
  };

  const service: ISettingService = {
    async get(): Promise<AppSettings> {
      // Session may be created or cold restored immediately after setting switching; if the read exceeds the queued write,
      // The runtime will fix the old switch value. Wait for the existing write queue first to ensure that the startup preference reads the submitted selection.
      await updateQueue;
      const result = await readSettingsWithMeta();
      if (!result.needsMigrationPersist) {
        return result.settings;
      }

      await enqueueSettingsWrite(async (shouldCommit, enterCommitPhase) => {
        const latest = await readSettingsWithMeta();
        if (!latest.needsMigrationPersist) {
          return;
        }

        // Reason for initialization: The old version settings may have placed default values ​​that cannot distinguish the source; after the upgrade, they will be migrated uniformly according to the schema.
        // Migrating disks must enter the updateQueue and reread the latest files in the queue to avoid overwriting other settings saved concurrently.
        await writeSettings(latest.settings, shouldCommit, runSettingsCommit, enterCommitPhase);
      });

      return readSettings();
    },

    async update(patch: Partial<AppSettings>, expectedAccountSettings): Promise<void> {
      const runUpdate = async (shouldCommit: () => boolean, enterCommitPhase: () => void) => {
        const validatedPatch = appSettingsPatchSchema.parse(normalizeSettingsPatch(patch));
        const current = await readSettings();
        if (expectedAccountSettings) {
          // The user may have manually switched during account query. Verification must be in the same write queue and cannot rely on the caller to read first and then write.
          const expected = appSettingsPatchSchema.parse(expectedAccountSettings);
          if (
            current.providerFamilyDomain !== expected.providerFamilyDomain ||
            JSON.stringify(current.providerFamilyConnectionSelections ?? {}) !==
              JSON.stringify(expected.providerFamilyConnectionSelections ?? {})
          ) {
            throw new Error("Account connection settings changed");
          }
        }
        const merged = appSettingsSchema.parse({
          ...current,
          ...validatedPatch,
        });

        // After opening the workspace, recentProjects and lastWorkspaceSession will be written almost simultaneously.
        // The previous two updates directly overwrote and wrote back based on the old settings they read respectively.
        // The patch written later will completely erase the previous field, causing the session to not be restored the next time it is started.
        // Here, the writes are serialized, so that each patch continues to be merged based on the latest state after the last real placement.
        if (merged.recentProjects) {
          merged.recentProjects = [...new Set(merged.recentProjects)].slice(0, MAX_RECENT_PROJECTS);
        }

        await writeSettings(
          merged as AppSettings,
          shouldCommit,
          runSettingsCommit,
          enterCommitPhase,
          Object.hasOwn(patch, "providerFamilyConnectionSelections"),
        );
      };

      await enqueueSettingsWrite(runUpdate);
    },

    async updateDataBaseDir(newDir: string | undefined): Promise<void> {
      const currentBaseDir = getDataBaseDir();
      const targetBaseDir = newDir?.trim() || homedir();
      const validation = validateDataBaseDirTarget(targetBaseDir);
      if (!validation.ok) {
        // The Windows installation directory is managed by the installer/automatic updates. Putting .zcode/v2 in it may be overwritten during upgrades.
        // Intercept at the service layer before migration to prevent UI entry changes or RPC calls from bypassing front-end judgment.
        const error = new Error(`${validation.code}: ${validation.forbiddenDir}`);
        (error as Error & { code: string }).code = validation.code;
        throw error;
      }

      if (currentBaseDir !== targetBaseDir) {
        log("copying data directory from", currentBaseDir, "to", targetBaseDir);
        await copyDataDirectory(currentBaseDir, targetBaseDir);
        log("data directory copy done");
      }

      await this.update({ dataBaseDir: newDir });
    },

    async ensureDefaultProject(userHomeDir: string): Promise<{ path: string; created: boolean }> {
      const path = join(userHomeDir, DEFAULT_PROJECT_NAME);
      let existedBefore = true;

      try {
        await access(path).catch(() => {
          existedBefore = false;
        });
        maybeThrowInjectedFsFault({ operation: "mkdir", path });
        await mkdir(path, { recursive: true });
      } catch (error) {
        log("ensureDefaultProject failed:", error);
        throw error;
      }

      return { path, created: !existedBefore };
    },
  };

  let inFlight: Promise<readonly ProviderFamilyDomain[]> | null = null;
  let migrationComplete = false;
  return {
    service,
    prepareLegacyAccountConnections(resolveOrganization) {
      // After the import is completed, the migration file will not be read repeatedly for each authentication request. Restoring old backups requires restarting the Host.
      if (migrationComplete) return Promise.resolve([]);
      if (inFlight) return inFlight;
      const run = async (): Promise<readonly ProviderFamilyDomain[]> => {
        await service.get();
        const original = await readLegacyAccountConnectionSettingsFile(getSettingsFile());
        const incomplete = readIncompleteLegacyTeamConnections(original);
        if (incomplete.length === 0) return [];
        // The network is outside the write queue: proxy setting reading and user operations can continue without forming a get -> HTTP -> get loop.
        const resolved = await Promise.all(
          incomplete.map(async (connection) => ({
            ...connection,
            organizationId: await resolveOrganization(connection).catch(() => null),
          })),
        );
        await enqueueSettingsWrite(async (shouldCommit, enterCommitPhase) => {
          const latest = await readLegacyAccountConnectionSettingsFile(getSettingsFile());
          // Only the migration input is checked, legitimate results are not lost due to changes in common language/window settings, and the user's new account intention is not overridden.
          if (
            Object.hasOwn(latest, "providerFamilyConnectionSelections") ||
            latest.providerFamilyDomain !== original.providerFamilyDomain ||
            JSON.stringify(retainLegacyAccountConnectionFields(latest)) !==
              JSON.stringify(retainLegacyAccountConnectionFields(original))
          )
            return;
          if (resolved.some((entry) => !entry.organizationId?.trim())) return;
          const migrated = appSettingsSchema.parse(migrateLegacyAccountConnectionSettings(latest));
          const selections: ProviderFamilyConnectionSelectionSettings = {
            ...migrated.providerFamilyConnectionSelections,
          };
          for (const { family, productId, projectId, organizationId } of resolved) {
            selections[family] = {
              kind: "team-coding-plan",
              productId,
              projectId,
              organizationId: organizationId!.trim(),
            };
          }
          await writeSettings(
            { ...migrated, providerFamilyConnectionSelections: selections } as AppSettings,
            shouldCommit,
            runSettingsCommit,
            enterCommitPhase,
            true,
          );
        });
        return readIncompleteLegacyTeamConnections(
          await readLegacyAccountConnectionSettingsFile(getSettingsFile()),
        ).map((entry) => entry.family);
      };
      const pending = run();
      inFlight = pending;
      void pending.then(
        (unresolved) => {
          migrationComplete = unresolved.length === 0;
          if (inFlight === pending) inFlight = null;
        },
        () => {
          if (inFlight === pending) inFlight = null;
        },
      );
      return pending;
    },
  };
}
