import { stat } from "node:fs/promises";
import { session as electronSession } from "electron";
import type {
  ChromeBrowserDataImportError,
  ChromeBrowserDataImportResult,
  EmbeddedBrowserDataClearResult,
} from "@zcode/shared";
import {
  importChromeCookies,
  type ChromeCookieDatabaseBackup,
  type ChromeCookieHelper,
} from "./chromeCookieManager.js";
import {
  ChromeCookieAccessDeniedError,
  type MacChromeSafeStorageSecretReader,
} from "./chromeCredentialManager.js";
import {
  emptyChromeLocalStorageImportStats,
  importChromeLocalStorage,
  type ChromeLocalStorageImportStats,
} from "./chromeLocalStorageManager.js";
import {
  discoverChromeProfile,
  resolveChromeExecutablePath,
  type ChromeProfileDiscoveryResult,
} from "./chromeProfileDiscovery.js";
import type { LinuxChromePasswordStore } from "./chromeInstallationCandidates.js";
import type { WindowsChromeAppBoundKeyReader } from "./windowsChromeAppBoundKey.js";

export const EMBEDDED_BROWSER_PARTITION = "persist:zcode-embedded-browser";
const CACHE_STORAGE_TYPES: Electron.ClearStorageDataOptions["storages"] = [
  "shadercache",
  "serviceworkers",
  "cachestorage",
];

interface BrowserSessionLike {
  clearCache(): Promise<void>;
  clearStorageData(options?: Electron.ClearStorageDataOptions): Promise<void>;
  cookies: {
    set(details: Electron.CookiesSetDetails): Promise<void>;
    flushStore(): Promise<void>;
  };
}

interface BrowserDataLogger {
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
}

function toSafeBrowserDataError(error: unknown): { name: string; code?: string } {
  if (!(error instanceof Error)) return { name: "UnknownError" };
  const code = "code" in error && typeof error.code === "string" ? error.code : undefined;
  return { name: error.name || "Error", ...(code ? { code } : {}) };
}

function pathExists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

function emptyImportResult(error?: ChromeBrowserDataImportError): ChromeBrowserDataImportResult {
  return {
    success: false,
    cookies: { imported: 0, skipped: 0, failed: 0 },
    localStorage: emptyChromeLocalStorageImportStats(),
    ...(error ? { error } : {}),
  };
}

export async function importChromeBrowserData(options: {
  allowElevatedChromeDecryption?: boolean;
  chromeCookieDatabaseBackup?: ChromeCookieDatabaseBackup;
  chromeCookieHelper?: ChromeCookieHelper;
  chromeExecutableDiscovery?: () => Promise<string | null>;
  chromeExecutablePath?: string;
  chromePasswordStore?: LinuxChromePasswordStore;
  chromeProfileDiscovery?: () => Promise<ChromeProfileDiscoveryResult>;
  logger: BrowserDataLogger;
  macChromeSafeStorageSecretReader?: MacChromeSafeStorageSecretReader;
  profilePath?: string;
  platform?: NodeJS.Platform;
  targetSession?: BrowserSessionLike;
  windowsChromeAppBoundKeyReader?: WindowsChromeAppBoundKeyReader;
  localStorageImporter?: (options: {
    profilePath: string;
    targetSession: Electron.Session;
    logger: BrowserDataLogger;
    platform?: NodeJS.Platform;
    chromeExecutablePath?: string;
  }) => Promise<ChromeLocalStorageImportStats>;
}): Promise<ChromeBrowserDataImportResult> {
  const platform = options.platform ?? process.platform;
  let detectedChromeExecutablePath = options.chromeExecutablePath;
  if (platform !== "win32" && !options.profilePath && !detectedChromeExecutablePath) {
    detectedChromeExecutablePath =
      (await (
        options.chromeExecutableDiscovery ?? (() => resolveChromeExecutablePath({ platform }))
      )()) ?? undefined;
    if (!detectedChromeExecutablePath) {
      // In the past, the default Profile was scanned first, causing "Chrome not installed" to be mistakenly reported as a missing Profile.
      // Browsers registered in non-default directories will also not be recognized. Executable discovery is completed first, and source data is not accessed on failure.
      return emptyImportResult("chrome_executable_not_found");
    }
  }
  const discovered = options.profilePath
    ? null
    : await (options.chromeProfileDiscovery ?? (() => discoverChromeProfile({ platform })))();
  if (discovered && !discovered.success) return emptyImportResult(discovered.error);

  const profilePath = options.profilePath ?? discovered?.source.profilePath;
  if (!profilePath || !(await pathExists(profilePath))) {
    return emptyImportResult("chrome_profile_not_found");
  }
  const chromeExecutablePath =
    options.chromeExecutablePath ??
    discovered?.source.executablePath ??
    detectedChromeExecutablePath;
  const chromePasswordStore = options.chromePasswordStore ?? discovered?.source.passwordStore;
  const targetSession =
    options.targetSession ?? electronSession.fromPartition(EMBEDDED_BROWSER_PARTITION);
  const result: ChromeBrowserDataImportResult = {
    success: false,
    cookies: { imported: 0, skipped: 0, failed: 0 },
    localStorage: emptyChromeLocalStorageImportStats(),
  };
  const issues = new Set<ChromeBrowserDataImportError>();

  try {
    options.logger.info("[browser-data] starting Chrome browser data import", {
      browser: discovered?.source.browser ?? "explicit-profile",
      profile: discovered?.source.profileDirectory ?? "explicit-profile",
    });
    const cookieImport = await importChromeCookies({
      allowElevatedChromeDecryption: options.allowElevatedChromeDecryption,
      databaseBackup: options.chromeCookieDatabaseBackup,
      chromeCookieHelper: options.chromeCookieHelper,
      chromeExecutablePath,
      chromePasswordStore,
      logger: options.logger,
      macChromeSafeStorageSecretReader: options.macChromeSafeStorageSecretReader,
      platform,
      profilePath,
      targetSession,
      windowsChromeAppBoundKeyReader: options.windowsChromeAppBoundKeyReader,
    });
    result.cookies = cookieImport.stats;
    for (const issue of cookieImport.issues) issues.add(issue);

    const localStorageImporter = options.localStorageImporter ?? importChromeLocalStorage;
    options.logger.info("[browser-data] starting Chrome LocalStorage import");
    result.localStorage = await localStorageImporter({
      profilePath,
      targetSession: targetSession as Electron.Session,
      logger: options.logger,
      platform,
      chromeExecutablePath,
    });
    if (result.localStorage.error) issues.add(result.localStorage.error);

    result.success =
      (cookieImport.databaseFound && cookieImport.rowCount === 0) ||
      result.cookies.imported > 0 ||
      result.localStorage.originsImported > 0;
    if (!result.success) {
      result.error = [
        "chrome_cookie_elevation_required",
        "chrome_cookie_elevation_cancelled",
        "chrome_cookie_helper_verification_failed",
        "chrome_cookie_app_bound_decryption_failed",
        "chrome_cookie_protection_unsupported",
      ].find((issue) => issues.has(issue as ChromeBrowserDataImportError)) as
        | ChromeBrowserDataImportError
        | undefined;
      result.error ??= result.localStorage.error ?? "chrome_browser_data_import_unavailable";
    }
    if (issues.size > 0) result.issues = [...issues];
    options.logger.info("[browser-data] Chrome data import completed", {
      importedCount: result.cookies.imported,
      skippedCount: result.cookies.skipped,
      failedCount: result.cookies.failed,
      importedLocalStorageOrigins: result.localStorage.originsImported,
      importedLocalStorageEntries: result.localStorage.entriesImported,
      skippedLocalStorageOrigins: result.localStorage.originsSkipped,
      failedLocalStorageOrigins: result.localStorage.originsFailed,
    });
    return result;
  } catch (error) {
    if (error instanceof ChromeCookieAccessDeniedError) {
      // After a macOS user denies keychain authorization, the import must stop as a whole and cannot be entered again
      // LocalStorage stage; returns a stable error code to the renderer to display a clear prompt.
      options.logger.warn(
        "[browser-data] Chrome data import cancelled: macOS keychain authorization was denied",
      );
      return {
        ...result,
        error: "chrome_cookie_access_denied",
      };
    }
    // Only error types/error codes are logged, cookies, LocalStorage values ​​or absolute Profile paths are not logged.
    options.logger.warn("[browser-data] Chrome data import failed", toSafeBrowserDataError(error));
    return {
      ...result,
      ...(issues.size > 0 ? { issues: [...issues] } : {}),
      error: "chrome_data_import_failed",
    };
  }
}

export async function clearEmbeddedBrowserData(options: {
  logger: BrowserDataLogger;
  mode: "cache" | "all";
  targetSession?: BrowserSessionLike;
}): Promise<EmbeddedBrowserDataClearResult> {
  const targetSession =
    options.targetSession ?? electronSession.fromPartition(EMBEDDED_BROWSER_PARTITION);
  try {
    await targetSession.clearCache();
    if (options.mode === "all") {
      await targetSession.clearStorageData();
    } else {
      // Ordinary cache cleaning cannot delete LocalStorage/IndexedDB that hosts login status.
      await targetSession.clearStorageData({ storages: CACHE_STORAGE_TYPES });
    }
    options.logger.info("[browser-data] embedded browser data cleanup completed", {
      mode: options.mode,
    });
    return { success: true };
  } catch {
    options.logger.warn("[browser-data] embedded browser data cleanup failed", {
      mode: options.mode,
    });
    return { success: false, error: "embedded_browser_clear_failed" };
  }
}
