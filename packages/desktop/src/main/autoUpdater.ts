/* eslint-disable max-lines -- autoUpdater centralizes Electron events, menu state and IPC interaction; splitting it any further would make the update state flow harder to trace */
import type { ISettingService } from "@zcode/services";
import {
  DEFAULT_LOCALE,
  DEFAULT_ZCODE_ENDPOINT_ORIGIN,
  desktopMenuMessageIds,
  formatDesktopMenuMessage,
  getDesktopMenuMessage,
  PlatformChannels,
  resolveRuntimeZCodeEndpointOrigin,
  ZCODE_VERSION,
  type ElectronReleaseChannel,
  type Locale,
  type PostUpdateReleaseNotesPayload,
  type UpdateCheckResultPayload,
  type UpdateStatePayload,
} from "@zcode/shared";
import { app, BrowserWindow, ipcMain, Menu } from "electron";
import pkg, { CancellationToken } from "electron-updater";
import semver from "semver";
import { logger } from "./logger.js";
import { getElectronReleasePlatform, ManifestUpdateProvider } from "./manifestUpdateProvider.js";
const { autoUpdater } = pkg;

export const CHECK_FOR_UPDATE_MENU_ID = "check-for-update";
const AUTO_UPDATE_POLL_INTERVAL_MS = 60 * 60 * 1000;
const UPDATE_FEED_URL_ENV = "ZCODE_UPDATE_FEED_URL";
const UPDATE_FEED_URL_SWITCH = "--zcode-update-feed-url";
const DEV_AUTO_UPDATE_ENV = "ZCODE_AUTO_UPDATE_DEV";
const DEV_AUTO_UPDATE_SWITCH = "--zcode-auto-update-dev";
const DEV_AUTO_UPDATE_VERSION_ENV = "ZCODE_AUTO_UPDATE_DEV_VERSION";
const DEV_AUTO_UPDATE_VERSION_SWITCH = "--zcode-auto-update-dev-version";
let readyUpdateVersion: string | null = null;
let readyUpdateReleaseNotes: PostUpdateReleaseNotesPayload | null = null;
let readyUpdateRestoredFromPendingReleaseNotes = false;
let manualCheckWebContentsId: number | null = null;
let pendingPostUpdateReleaseNotes: PostUpdateReleaseNotesPayload | null = null;
let deliveredPostUpdateReleaseNotesWebContentsId: number | null = null;
let autoUpdatePollTimer: NodeJS.Timeout | null = null;
let checkForUpdatesInFlight = false;
let autoUpdateCheckGeneration = 0;
let activeAutoUpdateCheckId: number | null = null;
let activeAutoUpdateCheckChannel: ElectronReleaseChannel | null = null;
let settlingAutoUpdateCheckId: number | null = null;
let availableUpdateReleaseNotes: PostUpdateReleaseNotesPayload | null = null;
let availableUpdateChannel: ElectronReleaseChannel = "stable";
let downloadingUpdateVersion: string | null = null;
let downloadingUpdateReleaseNotes: PostUpdateReleaseNotesPayload | null = null;
let downloadingUpdateChannel: ElectronReleaseChannel | null = null;
let downloadCancellationToken: CancellationToken | null = null;
let readyUpdateChannel: ElectronReleaseChannel | null = null;
let pendingManifestReleaseChannelRefresh: ElectronReleaseChannel | null = null;
let onBeforeQuitAndInstall: (() => void | Promise<void>) | undefined;
const acknowledgedPostUpdateReleaseNotesVersions = new Set<string>();
const cancelledDownloadTokens = new WeakSet<CancellationToken>();
let pendingCancelledDownloadErrorCount = 0;
let autoUpdaterSettingService: SettingServiceLike | undefined;
// initAutoUpdater({ enabled: false }) only clears polling and returns, the electron-updater instance remains unconfigured
// (Placeholder feed, autoDownload default value). If any entry that has not been changed to be judged by identity still calls for manual inspection,
// All requests will be made to the placeholder feed. Remember here that "this flavor is disabled" and let the manual check fail-closed inside the module.
let autoUpdaterDisabledForProductFlavor = false;

type SettingServiceLike = Pick<ISettingService, "get" | "update">;

type ReleaseNoteInfoLike = {
  note?: string | null;
  version?: string | null;
};

type UpdateDownloadedInfoLike = {
  version: string;
  path?: string | null;
  files?: Array<{ url?: string | null } | null> | null;
  packages?: Record<string, { path?: string | null } | null> | null;
  zcodeReleaseChannel?: ElectronReleaseChannel | null;
  releaseName?: string | null;
  releaseNotes?: string | ReleaseNoteInfoLike[] | null;
  releaseDate?: string | Date | null;
  releaseNotesByLocale?: Partial<
    Record<
      Locale,
      | string
      | {
          title?: string | null;
          markdown?: string | null;
          releaseNotes?: string | ReleaseNoteInfoLike[] | null;
        }
      | null
    >
  > | null;
};

type RuntimeUpdateFeedSource = { url: string };

type AutoUpdaterMenuState = UpdateStatePayload;
let menuState: AutoUpdaterMenuState = { kind: "idle", enabled: true };

export type ForceAutoUpdateState =
  | { kind: "checking" }
  | { kind: "downloading"; version?: string; progress?: string }
  | { kind: "ready"; version?: string }
  | { kind: "installing" }
  | { kind: "error"; message: string }
  | { kind: "dev-skipped"; message?: string };

let activeForceAutoUpdateListener: ((state: ForceAutoUpdateState) => void) | null = null;
const autoUpdaterStateListeners = new Set<(state: UpdateStatePayload) => void>();
let forceAutoUpdateLastLoggedProgressBucket: number | null = null;

interface InitAutoUpdaterOptions {
  enabled?: boolean;
  onBeforeQuitAndInstall?: () => void | Promise<void>;
  settingService?: SettingServiceLike;
  updateFeedSource?: RuntimeUpdateFeedSource;
  deviceMid?: string;
  resolveEndpointOrigin?: () => string | Promise<string>;
}

let quitAndInstallInFlight = false;
let devAutoUpdateVersionOverride: string | null = null;

type MutableAutoUpdaterForDev = typeof autoUpdater & {
  currentVersion?: semver.SemVer;
  forceDevUpdateConfig?: boolean;
};

function isTruthyRuntimeFlag(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
}

function readCommandLineSwitchValue(name: string): string | null {
  const prefix = `${name}=`;
  for (const arg of process.argv) {
    if (arg === name) {
      return "";
    }
    if (arg.startsWith(prefix)) {
      return arg.slice(prefix.length);
    }
  }
  return null;
}

function isDevAutoUpdateEnabled(): boolean {
  return (
    isTruthyRuntimeFlag(process.env[DEV_AUTO_UPDATE_ENV]) ||
    readCommandLineSwitchValue(DEV_AUTO_UPDATE_SWITCH) !== null
  );
}

function canUseAutoUpdaterInCurrentRuntime(): boolean {
  return app.isPackaged || isDevAutoUpdateEnabled();
}

function shouldRelaunchForDevAutoUpdateInstall(): boolean {
  return !app.isPackaged && isDevAutoUpdateEnabled();
}

function getCurrentAppVersionForUpdate(): string {
  return devAutoUpdateVersionOverride ?? app.getVersion();
}

function resolveDevAutoUpdateVersion(): string | null {
  const configuredVersion =
    process.env[DEV_AUTO_UPDATE_VERSION_ENV]?.trim() ||
    readCommandLineSwitchValue(DEV_AUTO_UPDATE_VERSION_SWITCH)?.trim() ||
    ZCODE_VERSION;
  const parsed = semver.parse(configuredVersion);
  if (!parsed) {
    logger.warn(`[auto-update] ignore invalid dev update version=${configuredVersion}`);
    return null;
  }
  return parsed.format();
}

function applyDevAutoUpdateRuntimeOverrides(): void {
  devAutoUpdateVersionOverride = null;
  if (app.isPackaged || !isDevAutoUpdateEnabled()) {
    return;
  }

  const devVersion = resolveDevAutoUpdateVersion();
  const parsedVersion = devVersion ? semver.parse(devVersion) : null;
  const mutableAutoUpdater = autoUpdater as MutableAutoUpdaterForDev;
  mutableAutoUpdater.forceDevUpdateConfig = true;
  if (parsedVersion) {
    devAutoUpdateVersionOverride = parsedVersion.format();
    // Electron development app.getVersion() reads the desktop running shell version.
    // It may not be consistent with the product version. When verifying automatic updates, you need to explicitly add electron-updater
    // Change currentVersion to the product version, otherwise the 3.3.1 -> 3.3.2 process cannot be reproduced.
    mutableAutoUpdater.currentVersion = parsedVersion;
  }

  logger.info(
    `[auto-update] dev update enabled version=${devAutoUpdateVersionOverride ?? app.getVersion()}`,
  );
}

function normalizeVersionForCompare(version: string): string | null {
  return semver.valid(semver.coerce(version.trim()));
}

function isVersionGreaterThan(candidateVersion: string, baselineVersion: string): boolean {
  const candidate = normalizeVersionForCompare(candidateVersion);
  const baseline = normalizeVersionForCompare(baselineVersion);
  if (candidate && baseline) {
    return semver.gt(candidate, baseline);
  }

  return candidateVersion.trim() !== baselineVersion.trim();
}

function shouldDownloadAvailableUpdate(version: string): boolean {
  if (readyUpdateRestoredFromPendingReleaseNotes) {
    return true;
  }

  return !readyUpdateVersion || isVersionGreaterThan(version, readyUpdateVersion);
}

function canPollForUpdatesFromState(state: AutoUpdaterMenuState): boolean {
  return state.kind === "idle" || state.kind === "update-downloaded";
}

function getAutoUpdaterReleaseChannelForCurrentState(): ElectronReleaseChannel {
  switch (menuState.kind) {
    case "update-available":
      return menuState.channel ?? availableUpdateChannel;
    case "download-progress":
      return menuState.channel ?? downloadingUpdateChannel ?? availableUpdateChannel;
    case "update-downloaded":
      return menuState.channel ?? readyUpdateChannel ?? availableUpdateChannel;
    default:
      return availableUpdateChannel;
  }
}

function readUpdateInfoReleaseChannel(
  info: UpdateDownloadedInfoLike,
): ElectronReleaseChannel | null {
  return info.zcodeReleaseChannel === "preview" || info.zcodeReleaseChannel === "stable"
    ? info.zcodeReleaseChannel
    : null;
}

function beginAutoUpdateCheck(): number {
  checkForUpdatesInFlight = true;
  autoUpdateCheckGeneration += 1;
  activeAutoUpdateCheckId = autoUpdateCheckGeneration;
  activeAutoUpdateCheckChannel = availableUpdateChannel;
  settlingAutoUpdateCheckId = null;
  return activeAutoUpdateCheckId;
}

function completeAutoUpdateCheck(reason: string, checkId: number | null): void {
  if (checkId !== null && activeAutoUpdateCheckId !== checkId) {
    return;
  }

  checkForUpdatesInFlight = false;
  activeAutoUpdateCheckId = null;
  activeAutoUpdateCheckChannel = null;
  settlingAutoUpdateCheckId = null;

  const pendingChannel = pendingManifestReleaseChannelRefresh;
  if (!pendingChannel) {
    return;
  }

  pendingManifestReleaseChannelRefresh = null;
  refreshAutoUpdaterReleaseChannel(
    pendingChannel === "preview",
    `${reason} pending release channel refresh`,
  );
}

function finishAutoUpdateCheck(reason: string, checkId: number | null): void {
  if (
    checkId !== null &&
    activeAutoUpdateCheckId === checkId &&
    settlingAutoUpdateCheckId === checkId
  ) {
    return;
  }

  completeAutoUpdateCheck(reason, checkId);
}

function settleAutoUpdateCheckResult(
  reason: string,
  work: () => Promise<void> | void,
): Promise<void> {
  const checkId = activeAutoUpdateCheckId;
  if (!checkForUpdatesInFlight || checkId === null) {
    return Promise.resolve(work());
  }

  settlingAutoUpdateCheckId = checkId;
  try {
    return Promise.resolve(work()).finally(() => {
      // electron-updater's checkForUpdates() Promise only represents the request return.
      // It will not wait for asynchronous status processing such as reading settings, skipping versions, and automatic downloads in update-available.
      // Here, the mutually exclusive scope of a check covers "request + result processing" to avoid channel refresh or manual check from starting before the old result is written to the status.
      completeAutoUpdateCheck(reason, checkId);
    });
  } catch (error) {
    completeAutoUpdateCheck(reason, checkId);
    return Promise.reject(error);
  }
}

function shouldIgnoreStaleAvailableUpdate(infoChannel: ElectronReleaseChannel | null): boolean {
  const expectedChannel = activeAutoUpdateCheckChannel ?? availableUpdateChannel;
  return Boolean(infoChannel && infoChannel !== expectedChannel);
}

function buildUpdateDownloadedState(version: string): AutoUpdaterMenuState {
  return {
    kind: "update-downloaded",
    enabled: true,
    version,
    ...(readyUpdateChannel ? { channel: readyUpdateChannel } : {}),
    ...(readyUpdateReleaseNotes ? { releaseNotes: readyUpdateReleaseNotes } : {}),
  };
}

function buildUpdateAvailableState(
  version: string,
  releaseNotes: PostUpdateReleaseNotesPayload | null,
  channel: ElectronReleaseChannel,
): AutoUpdaterMenuState {
  return {
    kind: "update-available",
    enabled: true,
    version,
    channel,
    ...(releaseNotes ? { releaseNotes } : {}),
  };
}

function notifyForceAutoUpdate(state: ForceAutoUpdateState) {
  activeForceAutoUpdateListener?.(state);
}

function getForceAutoUpdateNoUpdateMessage(): string {
  return "No installable update was found. Use manual update instead.";
}

function normalizeProgressPercent(progress: unknown): string | undefined {
  if (typeof progress !== "object" || progress === null || !("percent" in progress)) {
    return undefined;
  }

  const percent = Number((progress as { percent?: unknown }).percent);
  if (!Number.isFinite(percent)) {
    return undefined;
  }

  return Math.max(0, Math.min(100, percent)).toFixed(0);
}

function logForceAutoUpdateProgress(progress: string | undefined) {
  if (!progress) {
    return;
  }

  const bucket = Math.floor(Number(progress) / 10) * 10;
  if (bucket === forceAutoUpdateLastLoggedProgressBucket) {
    return;
  }
  forceAutoUpdateLastLoggedProgressBucket = bucket;
  logger.info(`[force-update] automatic update download progress ${progress}%`);
}

function buildDownloadProgressState(
  progress: string,
  byteProgress?: { transferredBytes: number; totalBytes: number },
): AutoUpdaterMenuState {
  return {
    kind: "download-progress",
    enabled: false,
    progress,
    ...(byteProgress ? byteProgress : {}),
    ...(downloadingUpdateVersion ? { version: downloadingUpdateVersion } : {}),
    ...(downloadingUpdateChannel ? { channel: downloadingUpdateChannel } : {}),
    ...(downloadingUpdateReleaseNotes ? { releaseNotes: downloadingUpdateReleaseNotes } : {}),
  };
}

async function quitAndInstallUpdate(rejectUnavailable = false) {
  if (
    menuState.kind === "update-downloaded" &&
    readyUpdateVersion &&
    readyUpdateRestoredFromPendingReleaseNotes
  ) {
    const restoredVersion = readyUpdateVersion;
    const restoredReleaseNotes = readyUpdateReleaseNotes;
    const restoredChannel = readyUpdateChannel ?? availableUpdateChannel;
    logger.warn(
      `[auto-update] restage restored pending update before install version=${restoredVersion}`,
    );
    clearReadyUpdateState();
    availableUpdateReleaseNotes = restoredReleaseNotes;
    setAutoUpdaterMenuState(
      buildUpdateAvailableState(restoredVersion, restoredReleaseNotes, restoredChannel),
    );
    if (await shouldAutoDownloadAndInstallUpdates(autoUpdaterSettingService)) {
      downloadAvailableUpdate("restored-pending-install");
    }
    return;
  }

  if (menuState.kind !== "update-downloaded" || !readyUpdateVersion) {
    // The renderer may show "restart to update" due to old UpdateReady cache remaining,
    // But main has cleared ready after staging error. At this time, no more exit preparations or calls can be executed.
    // quitAndInstall, otherwise the host process will be killed but no installer will take over, causing the button to become unresponsive.
    logger.warn(`[auto-update] ignore quitAndInstall request: state=${menuState.kind}`);
    if (rejectUnavailable) {
      throw new Error(`Update is not ready to install: state=${menuState.kind}`);
    }
    return;
  }

  if (quitAndInstallInFlight) {
    logger.info("[auto-update] quitAndInstall already in flight");
    return;
  }
  quitAndInstallInFlight = true;
  logger.info("[auto-update] user requested quit and install");
  // On macOS, quitAndInstall() will not execute app.before-quit before closing the window.
  // If we still only rely on before-quit to release the window close, the existing "traffic light close = hide window" logic will block the exit.
  // The interface disappears after clicking update but the process does not exit and the installation process does not continue.
  // Here, the main process is first notified to enter the "allow real window closing" state, and then control is given to the updater.
  try {
    // Windows updates will replace packaged resources such as resources/glm;
    // If quitAndInstall finishes exiting before the host/agent child process, the installer may start overwriting the file while it is still occupied.
    // Finally, the semi-updated state of "the application can be started but the bundled agent is missing" is left.
    // Here we explicitly wait for the main process to complete exit preparations before entering the installer, and try to straighten the timing of resource replacement and child process recycling.
    await onBeforeQuitAndInstall?.();
  } catch (error) {
    // Exit preparation before installation is a hard prerequisite for releasing the host/agent and resources/glm file locks.
    // If the installer is still launched after this fails, Windows may overwrite the installation directory while resources are still occupied, resulting in a semi-update.
    quitAndInstallInFlight = false;
    handleAutoUpdateFailure(error, "prepare quit and install failed");
    if (rejectUnavailable) {
      throw error;
    }
    return;
  }

  try {
    if (shouldRelaunchForDevAutoUpdateInstall()) {
      // The development state is only used to verify the server manifest, download progress and installation entrance UI closed loop.
      // Unpackaged applications do not have a real release package context that can be taken over by the installer. Here we restart the current dev app instead.
      // Avoid clicking "Restart to update" to perform exit preparation and then stop in an unresponsive state.
      logger.info("[auto-update] dev update install fallback: relaunch app");
      app.relaunch();
      app.exit(0);
      return;
    }

    // Custom PowerShell delayed launcher for Windows 3.3.0 in detached/hidden
    // In this mode, powershell.exe may only be created, but it will not be executed stably until the installer starts. The user will see that the application is closed but the version remains unchanged.
    // The electron-updater native installation entry is restored here to avoid mistaking "launcher process created successfully" as the update has been taken over.
    autoUpdater.quitAndInstall();
  } finally {
    quitAndInstallInFlight = false;
  }
}

function updateMenuItemLabel(label: string, enabled: boolean) {
  const menu = Menu.getApplicationMenu();
  const item = menu?.getMenuItemById(CHECK_FOR_UPDATE_MENU_ID);
  if (item) {
    item.label = label;
    item.enabled = enabled;
  }
}

function getMenuItemLabel(state: AutoUpdaterMenuState): string {
  switch (state.kind) {
    case "checking":
      return getDesktopMenuMessage(desktopMenuMessageIds.helpCheckingForUpdates);
    case "update-available":
      return formatDesktopMenuMessage(desktopMenuMessageIds.helpUpdateAvailableVersion, {
        version: state.version,
      });
    case "download-progress":
      return formatDesktopMenuMessage(desktopMenuMessageIds.helpDownloadingUpdateProgress, {
        progress: state.progress,
      });
    case "update-downloaded":
      return formatDesktopMenuMessage(desktopMenuMessageIds.helpRestartToUpdate, {
        version: state.version,
      });
    case "idle":
    default:
      return getDesktopMenuMessage(desktopMenuMessageIds.helpCheckForUpdates);
  }
}

/** The menu template only carries the static "Check for Updates" text; every updater state change rewrites the menu item once more. */
export function syncAutoUpdaterMenuItemState() {
  updateMenuItemLabel(getMenuItemLabel(menuState), menuState.enabled);
}

function isSameAutoUpdaterMenuState(left: AutoUpdaterMenuState, right: AutoUpdaterMenuState) {
  if (left.kind !== right.kind || left.enabled !== right.enabled) {
    return false;
  }

  switch (left.kind) {
    case "update-available":
      return (
        right.kind === left.kind &&
        right.version === left.version &&
        right.channel === left.channel &&
        JSON.stringify(right.releaseNotes ?? null) === JSON.stringify(left.releaseNotes ?? null)
      );
    case "update-downloaded":
      return (
        right.kind === left.kind &&
        right.version === left.version &&
        right.channel === left.channel &&
        JSON.stringify(right.releaseNotes ?? null) === JSON.stringify(left.releaseNotes ?? null)
      );
    case "download-progress":
      return (
        right.kind === left.kind &&
        right.progress === left.progress &&
        right.version === left.version &&
        right.channel === left.channel &&
        JSON.stringify(right.releaseNotes ?? null) === JSON.stringify(left.releaseNotes ?? null)
      );
    case "idle":
    case "checking":
    default:
      return true;
  }
}

function broadcastAutoUpdaterState() {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send(PlatformChannels.UpdateStateChanged, menuState);
    }
  }
}

export function onAutoUpdaterStateChanged(listener: (state: UpdateStatePayload) => void) {
  autoUpdaterStateListeners.add(listener);
  return () => {
    autoUpdaterStateListeners.delete(listener);
  };
}

function setAutoUpdaterMenuState(nextState: AutoUpdaterMenuState) {
  if (isSameAutoUpdaterMenuState(menuState, nextState)) {
    return;
  }

  menuState = nextState;
  syncAutoUpdaterMenuItemState();
  broadcastAutoUpdaterState();
  for (const listener of autoUpdaterStateListeners) {
    listener(menuState);
  }
}

function findLiveWindowByWebContentsId(webContentsId: number | null) {
  if (webContentsId == null) {
    return null;
  }

  return (
    BrowserWindow.getAllWindows().find(
      (win) => !win.isDestroyed() && win.webContents.id === webContentsId,
    ) ?? null
  );
}

function deriveReleaseNotesTitle(markdown: string, version: string) {
  const firstHeading = markdown
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.startsWith("# ") && line.length > 2);

  return firstHeading ? firstHeading.slice(2).trim() : `Release v${version}`;
}

function normalizeReleaseNotesMarkdown(
  releaseNotes: UpdateDownloadedInfoLike["releaseNotes"],
): string | null {
  if (typeof releaseNotes === "string") {
    const markdown = releaseNotes.trim();
    return markdown === "" ? null : markdown;
  }

  if (!Array.isArray(releaseNotes)) {
    return null;
  }

  const markdown = releaseNotes
    .map((item) => (typeof item?.note === "string" ? item.note.trim() : ""))
    .filter((item) => item.length > 0)
    .join("\n\n")
    .trim();

  return markdown === "" ? null : markdown;
}

function normalizeLocalizedReleaseNotes(
  version: string,
  releaseNotesByLocale: UpdateDownloadedInfoLike["releaseNotesByLocale"],
): PostUpdateReleaseNotesPayload["releaseNotesByLocale"] | undefined {
  if (!releaseNotesByLocale || typeof releaseNotesByLocale !== "object") {
    return undefined;
  }

  const entry = releaseNotesByLocale[DEFAULT_LOCALE];
  if (!entry) {
    return undefined;
  }

  const markdown =
    typeof entry === "string"
      ? normalizeReleaseNotesMarkdown(entry)
      : normalizeReleaseNotesMarkdown(entry.markdown ?? entry.releaseNotes);
  if (!markdown) {
    return undefined;
  }

  return {
    [DEFAULT_LOCALE]: {
      title:
        typeof entry === "object" && entry.title?.trim()
          ? entry.title.trim()
          : deriveReleaseNotesTitle(markdown, version),
      markdown,
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

function redactUpdateFeedUrlForLog(value: string): string {
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    if (url.search) {
      url.search = "?<redacted>";
    }
    url.hash = "";
    return url.toString();
  } catch {
    return "<invalid-url>";
  }
}

function readSwitchValue(argv: readonly string[], switchName: string): string | undefined {
  const equalsPrefix = `${switchName}=`;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg) {
      continue;
    }
    if (arg.startsWith(equalsPrefix)) {
      return arg.slice(equalsPrefix.length).trim() || undefined;
    }
    if (arg === switchName) {
      const next = argv[index + 1];
      if (next && !next.startsWith("--")) {
        return next.trim() || undefined;
      }
      return undefined;
    }
  }
  return undefined;
}

export function resolveUpdateFeedSourceFromStartupConfig(
  options: {
    argv?: readonly string[];
    env?: Record<string, string | undefined>;
  } = {},
): RuntimeUpdateFeedSource | undefined {
  const argv = options.argv ?? process.argv;
  const env = options.env ?? process.env;
  const feedUrl = readSwitchValue(argv, UPDATE_FEED_URL_SWITCH) ?? env[UPDATE_FEED_URL_ENV]?.trim();
  if (!feedUrl) {
    return undefined;
  }
  // Update source coverage is only for development and build joint debugging; official packages are ignored by isPackaged to avoid update requests being redirected by environment variables/startup parameters.
  if (app.isPackaged) {
    logger.warn(
      `[auto-update] ignore update feed override in packaged app: ${redactUpdateFeedUrlForLog(feedUrl)}`,
    );
    return undefined;
  }
  return { url: feedUrl };
}

async function resolveUpdateReleaseChannel(
  settingService: SettingServiceLike | undefined,
): Promise<ElectronReleaseChannel> {
  if (!settingService) {
    return "stable";
  }

  try {
    const settings = await settingService.get();
    return settings.receivePreviewUpdates === true ? "preview" : "stable";
  } catch (error) {
    logger.warn("[auto-update] read preview update setting failed:", error);
    return "stable";
  }
}

async function syncAutoUpdateCheckChannelFromSettings(
  checkId: number,
  settingService: SettingServiceLike | undefined,
  reason: string,
): Promise<void> {
  const nextChannel = await resolveUpdateReleaseChannel(settingService);
  if (activeAutoUpdateCheckId !== checkId) {
    return;
  }

  if (availableUpdateChannel !== nextChannel) {
    logger.info(
      `[auto-update] ${reason}: check channel ${availableUpdateChannel} -> ${nextChannel}`,
    );
  }
  // The server manifest provider will read preview settings inside checkForUpdates.
  // If the default stable is still used as the expected channel in the begin phase, the cold start preview result will be misjudged as stale.
  availableUpdateChannel = nextChannel;
  activeAutoUpdateCheckChannel = nextChannel;
}

function applyManifestUpdateProvider(options: InitAutoUpdaterOptions): void {
  const manifestUrl = options.updateFeedSource?.url.trim();
  autoUpdater.setFeedURL({
    provider: "custom",
    updateProvider: ManifestUpdateProvider,
    endpointOrigin: DEFAULT_ZCODE_ENDPOINT_ORIGIN,
    ...(manifestUrl ? { manifestUrl } : {}),
    releasePlatform: getElectronReleasePlatform(),
    deviceMid: options.deviceMid,
    resolveEndpointOrigin:
      options.resolveEndpointOrigin ?? (() => resolveRuntimeZCodeEndpointOrigin(process.env)),
    resolveReleaseChannel: async () => {
      availableUpdateChannel = await resolveUpdateReleaseChannel(options.settingService);
      return availableUpdateChannel;
    },
  });
  logger.info(
    manifestUrl
      ? `[auto-update] service manifest provider applied platform=${getElectronReleasePlatform()} manifestUrl=${redactUpdateFeedUrlForLog(manifestUrl)}`
      : `[auto-update] service manifest provider applied platform=${getElectronReleasePlatform()}`,
  );
}

function pickFallbackReleaseNotesMarkdown(
  localized: PostUpdateReleaseNotesPayload["releaseNotesByLocale"] | undefined,
): string | null {
  return localized?.[DEFAULT_LOCALE]?.markdown ?? null;
}

function normalizeReleaseDate(
  releaseDate: UpdateDownloadedInfoLike["releaseDate"],
): string | undefined {
  if (releaseDate instanceof Date && !Number.isNaN(releaseDate.getTime())) {
    return releaseDate.toISOString();
  }
  if (typeof releaseDate !== "string") {
    return undefined;
  }
  const trimmed = releaseDate.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function toPostUpdateReleaseNotesPayload(
  info: UpdateDownloadedInfoLike,
): PostUpdateReleaseNotesPayload | null {
  const releaseNotesByLocale = normalizeLocalizedReleaseNotes(
    info.version,
    info.releaseNotesByLocale,
  );
  const markdown =
    normalizeReleaseNotesMarkdown(info.releaseNotes) ??
    pickFallbackReleaseNotesMarkdown(releaseNotesByLocale);
  if (!markdown) {
    return null;
  }

  const title = info.releaseName?.trim() || deriveReleaseNotesTitle(markdown, info.version);
  const releaseDate = normalizeReleaseDate(info.releaseDate);
  return {
    version: info.version,
    title,
    markdown,
    ...(releaseDate ? { releaseDate } : {}),
    ...(releaseNotesByLocale ? { releaseNotesByLocale } : {}),
  };
}

async function persistPendingPostUpdateReleaseNotes(
  settingService: SettingServiceLike,
  payload: PostUpdateReleaseNotesPayload,
  reason: string,
) {
  if (acknowledgedPostUpdateReleaseNotesVersions.has(payload.version)) {
    logger.info(
      `[auto-update] skip persisting acknowledged post-update release notes (${reason}) version=${payload.version}`,
    );
    return;
  }

  await settingService.update({ pendingPostUpdateReleaseNotes: payload });
  pendingPostUpdateReleaseNotes = payload;
  deliveredPostUpdateReleaseNotesWebContentsId = null;
  logger.info(
    `[auto-update] persisted post-update release notes (${reason}) version=${payload.version}`,
  );
}

/**
 * The version in the description to be displayed comes from the "downloaded installation package"; the current process version may still be an old version before the installation is completed.
 * At this time, the version to be displayed is higher than the currently running version, which is a normal intermediate state and cannot be discarded.
 * If the user skips the automatic update link (official website installation package, etc.) and directly upgrades to a higher version, there may still be pending files downloaded and written earlier on the disk.
 * The version to be displayed at this time is lower than the installed version and should be discarded at startup, otherwise the old version update instructions will pop up.
 */
function shouldDiscardStalePendingReleaseNotes(
  pendingVersion: string,
  appVersion: string,
): boolean {
  const pending = pendingVersion.trim();
  const current = appVersion.trim();
  if (pending === current) {
    return false;
  }

  const pendingCoerced = semver.valid(semver.coerce(pending));
  const appCoerced = semver.valid(semver.coerce(current));
  if (!pendingCoerced || !appCoerced) {
    return false;
  }

  return semver.lt(pendingCoerced, appCoerced);
}

function isPendingReleaseNotesForFutureVersion(payload: PostUpdateReleaseNotesPayload): boolean {
  return isVersionGreaterThan(payload.version, getCurrentAppVersionForUpdate());
}

function isDevSquirrelReadyError(error: unknown): boolean {
  if (
    app.isPackaged ||
    !isDevAutoUpdateEnabled() ||
    process.platform !== "darwin" ||
    !isRecord(error)
  ) {
    return false;
  }

  return error.domain === "SQRLUpdaterErrorDomain" && error.code === 2;
}

async function clearPendingPostUpdateReleaseNotes(
  settingService: SettingServiceLike,
  reason: string,
) {
  if (!pendingPostUpdateReleaseNotes) {
    return;
  }

  const version = pendingPostUpdateReleaseNotes.version;
  await settingService.update({ pendingPostUpdateReleaseNotes: undefined });
  pendingPostUpdateReleaseNotes = null;
  deliveredPostUpdateReleaseNotesWebContentsId = null;
  logger.info(`[auto-update] cleared post-update release notes (${reason}) version=${version}`);
}

function sendManualCheckResult(payload: UpdateCheckResultPayload) {
  const webContentsId = manualCheckWebContentsId;
  if (webContentsId == null) return;
  manualCheckWebContentsId = null;

  const win = findLiveWindowByWebContentsId(webContentsId);
  if (!win) {
    logger.info(
      `[auto-update] manual check result dropped, target webContents ${webContentsId} gone`,
    );
    return;
  }
  logger.info(`[auto-update] manual check result → wc=${webContentsId}: ${payload.kind}`);
  win.webContents.send(PlatformChannels.UpdateCheckResult, payload);
}

function clearAvailableUpdateState() {
  availableUpdateReleaseNotes = null;
}

function clearDownloadingUpdateState() {
  downloadingUpdateVersion = null;
  downloadingUpdateReleaseNotes = null;
  downloadingUpdateChannel = null;
}

function clearReadyUpdateState() {
  readyUpdateVersion = null;
  readyUpdateReleaseNotes = null;
  readyUpdateChannel = null;
  readyUpdateRestoredFromPendingReleaseNotes = false;
}

function clearPersistedPostUpdateReleaseNotesForVersion(version: string, reason: string) {
  if (pendingPostUpdateReleaseNotes?.version === version) {
    pendingPostUpdateReleaseNotes = null;
    deliveredPostUpdateReleaseNotesWebContentsId = null;
  }

  const settingService = autoUpdaterSettingService;
  if (!settingService) {
    return;
  }

  void (async () => {
    try {
      const settings = await settingService.get();
      if (settings.pendingPostUpdateReleaseNotes?.version !== version) {
        return;
      }

      await settingService.update({ pendingPostUpdateReleaseNotes: undefined });
      logger.info(`[auto-update] cleared post-update release notes (${reason}) version=${version}`);
    } catch (error) {
      logger.warn(`[auto-update] clear post-update release notes (${reason}) failed:`, error);
    }
  })();
}

function isCancelledDownload(cancellationToken: CancellationToken, error: unknown): boolean {
  return (
    cancelledDownloadTokens.has(cancellationToken) ||
    (cancellationToken.cancelled && isDownloadCancellationError(error))
  );
}

function isDownloadCancellationError(error: unknown): boolean {
  return error instanceof Error && error.message === "cancelled";
}

function markCancelledDownload(cancellationToken: CancellationToken) {
  cancelledDownloadTokens.add(cancellationToken);
  pendingCancelledDownloadErrorCount += 1;
}

function shouldIgnoreCancelledDownloadError(error: unknown): boolean {
  if (pendingCancelledDownloadErrorCount <= 0 || !isDownloadCancellationError(error)) {
    return false;
  }

  pendingCancelledDownloadErrorCount -= 1;
  return true;
}

function handleAutoUpdateFailure(error: unknown, source: string) {
  const message = error instanceof Error ? error.message : String(error);
  const failedDownload =
    menuState.kind === "download-progress"
      ? {
          version: downloadingUpdateVersion ?? menuState.version,
          releaseNotes: downloadingUpdateReleaseNotes ?? menuState.releaseNotes ?? null,
          channel: downloadingUpdateChannel ?? menuState.channel ?? availableUpdateChannel,
        }
      : downloadCancellationToken && downloadingUpdateVersion
        ? {
            version: downloadingUpdateVersion,
            releaseNotes: downloadingUpdateReleaseNotes ?? null,
            channel: downloadingUpdateChannel ?? availableUpdateChannel,
          }
        : null;
  if (
    menuState.kind === "update-downloaded" &&
    readyUpdateVersion &&
    isDevSquirrelReadyError(error)
  ) {
    // When verifying the real test environment manifest in development mode, macOS Squirrel may still be
    // update-downloaded is followed by a code=2 staging error. The production package must clear the failed ready.
    // However, the development state needs to retain the ready state to verify the "restart to update" interactive closed loop.
    logger.warn(
      `[auto-update] ignore dev Squirrel ready error after ${source} version=${readyUpdateVersion}: ${message}`,
    );
    setAutoUpdaterMenuState(buildUpdateDownloadedState(readyUpdateVersion));
    return;
  }

  logger.error(`[auto-update] ${source}:`, error);
  if (menuState.kind === "update-downloaded" && readyUpdateVersion) {
    const failedReadyVersion = readyUpdateVersion;
    // macOS Squirrel may find that the package cannot be staged after update-downloaded.
    // If you continue to keep the ready cache, the renderer will always display "Restart to update", and clicking again will only call a failed installation context.
    clearReadyUpdateState();
    clearPersistedPostUpdateReleaseNotesForVersion(
      failedReadyVersion,
      `${source}-after-ready-error`,
    );
    logger.info(`[auto-update] cleared ready update after ${source} version=${failedReadyVersion}`);
  }
  clearAvailableUpdateState();
  clearDownloadingUpdateState();
  if (failedDownload?.version && !readyUpdateVersion && !activeForceAutoUpdateListener) {
    // If the download starts or staging fails quickly after the user clicks "Download Updates",
    // Clearing available/downloading and broadcasting idle will cause the renderer entry and pop-up window to disappear at the same time.
    // Failure does not mean that the user skipped the version, and should be returned to the "Update Found" state so that the user can see and retry the download.
    availableUpdateReleaseNotes = failedDownload.releaseNotes;
    availableUpdateChannel = failedDownload.channel;
    setAutoUpdaterMenuState(
      buildUpdateAvailableState(
        failedDownload.version,
        failedDownload.releaseNotes,
        failedDownload.channel,
      ),
    );
  } else {
    setAutoUpdaterMenuState(
      readyUpdateVersion
        ? buildUpdateDownloadedState(readyUpdateVersion)
        : { kind: "idle", enabled: true },
    );
  }
  notifyForceAutoUpdate({ kind: "error", message });
  sendManualCheckResult({ kind: "error", message });
}

async function isSkippedUpdateVersion(
  version: string,
  channel: ElectronReleaseChannel,
  settingService: SettingServiceLike | undefined,
): Promise<boolean> {
  if (!settingService || activeForceAutoUpdateListener) {
    return false;
  }

  // Users manually checking for updates represents a renewed focus on skipped versions.
  // Even if the persistence cleanup has not yet been implemented, this round cannot continue to hide the same version updates as up-to-date.
  if (manualCheckWebContentsId != null) {
    return false;
  }

  try {
    const settings = await settingService.get();
    return settings.skippedElectronUpdateVersions?.[channel]?.trim() === version.trim();
  } catch (error) {
    logger.warn("[auto-update] read skipped update version failed:", error);
    return false;
  }
}

async function shouldAutoDownloadAndInstallUpdates(
  settingService: SettingServiceLike | undefined,
): Promise<boolean> {
  if (!settingService) {
    return false;
  }

  try {
    return (await settingService.get()).autoDownloadAndInstallUpdates === true;
  } catch (error) {
    logger.warn("[auto-update] read auto download preference failed:", error);
    return false;
  }
}

async function skipAvailableUpdateVersion(
  version: string,
  settingService: SettingServiceLike | undefined,
): Promise<void> {
  if (activeForceAutoUpdateListener) {
    logger.info(`[auto-update] ignore skip version=${version}: force update active`);
    return;
  }

  if (
    (menuState.kind !== "update-available" && menuState.kind !== "download-progress") ||
    menuState.version !== version
  ) {
    logger.info(`[auto-update] ignore skip version=${version}: state=${menuState.kind}`);
    return;
  }

  const channel =
    menuState.channel ??
    (menuState.kind === "download-progress" ? downloadingUpdateChannel : availableUpdateChannel) ??
    availableUpdateChannel;
  if (downloadCancellationToken) {
    markCancelledDownload(downloadCancellationToken);
    downloadCancellationToken.cancel();
    logger.info(
      `[auto-update] skipped downloading version; cancel active download channel=${channel} version=${version}`,
    );
  }

  // Download pop-ups still need to allow users to skip the current version.
  // If main only accepts update-available, clicking "Skip this version" in the UI will become no-op;
  // Here, the current download is canceled before persistence is skipped, and the download status is cleared to prevent the background from continuing to pull the skipped version.
  clearAvailableUpdateState();
  clearDownloadingUpdateState();
  setAutoUpdaterMenuState(
    readyUpdateVersion
      ? buildUpdateDownloadedState(readyUpdateVersion)
      : { kind: "idle", enabled: true },
  );

  if (!settingService) {
    logger.warn(
      `[auto-update] skipped version not persisted because setting service is missing version=${version}`,
    );
    return;
  }

  try {
    const settings = await settingService.get();
    await settingService.update({
      skippedElectronUpdateVersions: {
        ...settings.skippedElectronUpdateVersions,
        [channel]: version,
      },
    });
    logger.info(`[auto-update] skipped version persisted channel=${channel} version=${version}`);
  } catch (error) {
    logger.error("[auto-update] persist skipped update version failed:", error);
  }
}

async function clearSkippedUpdateVersionForManualCheck(
  channel: ElectronReleaseChannel,
  settingService: SettingServiceLike | undefined,
): Promise<void> {
  if (!settingService) {
    return;
  }

  try {
    const settings = await settingService.get();
    const skippedVersions = settings.skippedElectronUpdateVersions;
    const skippedVersion = skippedVersions?.[channel]?.trim();
    if (!skippedVersion) {
      return;
    }

    const nextSkippedVersions = { ...skippedVersions };
    delete nextSkippedVersions[channel];
    await settingService.update({
      skippedElectronUpdateVersions: nextSkippedVersions,
    });
    logger.info(
      `[auto-update] manual check cleared skipped update channel=${channel} version=${skippedVersion}`,
    );
  } catch (error) {
    logger.warn("[auto-update] clear skipped update version failed:", error);
  }
}

function downloadAvailableUpdate(reason = "renderer") {
  if (!canUseAutoUpdaterInCurrentRuntime()) {
    logger.info(`[auto-update] skip ${reason} download: not packaged`);
    return;
  }

  if (menuState.kind === "update-downloaded") {
    logger.info(`[auto-update] skip ${reason} download: update already ready`);
    return;
  }

  if (menuState.kind === "download-progress") {
    logger.info(`[auto-update] skip ${reason} download: download already in progress`);
    return;
  }

  if (downloadCancellationToken) {
    logger.info(`[auto-update] skip ${reason} download: download already requested`);
    return;
  }

  if (menuState.kind !== "update-available") {
    logger.info(`[auto-update] skip ${reason} download: state=${menuState.kind}`);
    return;
  }

  downloadingUpdateVersion = menuState.version;
  downloadingUpdateReleaseNotes = menuState.releaseNotes ?? availableUpdateReleaseNotes;
  downloadingUpdateChannel = menuState.channel ?? availableUpdateChannel;
  // If electron-updater hits the local downloaded cache, it will be triggered directly within downloadUpdate()
  // update-downloaded. You cannot broadcast 0% download status here first, otherwise the user will see "Downloading" first.
  // Then jump to "Downloaded"; the actual download status is driven by the first download-progress event.
  notifyForceAutoUpdate({
    kind: "downloading",
    version: downloadingUpdateVersion,
    progress: "0",
  });

  const cancellationToken = new CancellationToken();
  downloadCancellationToken = cancellationToken;
  void autoUpdater
    .downloadUpdate(cancellationToken)
    .catch((error) => {
      if (isCancelledDownload(cancellationToken, error)) {
        logger.info(`[auto-update] ${reason} download cancelled`);
        return;
      }
      // The download is explicitly triggered by the user clicking or changing the gate, and the Promise reject must also be fed back immediately.
      // You cannot just rely on electron-updater to trigger an additional error event later, otherwise the UI will be stuck in the download state.
      handleAutoUpdateFailure(error, "download update failed");
    })
    .finally(() => {
      if (downloadCancellationToken === cancellationToken) {
        downloadCancellationToken = null;
      }
      cancellationToken.dispose();
    });
}

function cancelDownloadingUpdate(reason = "renderer") {
  if (activeForceAutoUpdateListener) {
    logger.info(`[auto-update] skip ${reason} cancel download: force update active`);
    return;
  }

  if (menuState.kind !== "download-progress" || !downloadCancellationToken) {
    logger.info(`[auto-update] skip ${reason} cancel download: state=${menuState.kind}`);
    return;
  }

  const version = downloadingUpdateVersion;
  const releaseNotes = downloadingUpdateReleaseNotes;
  const channel = downloadingUpdateChannel ?? availableUpdateChannel;
  const cancellationToken = downloadCancellationToken;
  markCancelledDownload(cancellationToken);
  cancellationToken.cancel();
  logger.info(
    `[auto-update] ${reason}: cancel download channel=${channel} version=${version ?? "unknown"}`,
  );

  // Canceling the download does not skip the version, but only goes back to the update discovery state, retaining the same manifest information so that the user can try again later.
  clearDownloadingUpdateState();
  if (version) {
    availableUpdateReleaseNotes = releaseNotes;
    availableUpdateChannel = channel;
    setAutoUpdaterMenuState(buildUpdateAvailableState(version, releaseNotes, channel));
    return;
  }

  setAutoUpdaterMenuState(
    readyUpdateVersion
      ? buildUpdateDownloadedState(readyUpdateVersion)
      : { kind: "idle", enabled: true },
  );
}

export async function hydratePendingPostUpdateReleaseNotes(settingService: SettingServiceLike) {
  const settings = await settingService.get();
  pendingPostUpdateReleaseNotes = settings.pendingPostUpdateReleaseNotes ?? null;
  deliveredPostUpdateReleaseNotesWebContentsId = null;

  if (pendingPostUpdateReleaseNotes) {
    logger.info(
      `[auto-update] hydrated pending post-update release notes version=${pendingPostUpdateReleaseNotes.version}`,
    );
  }

  if (
    pendingPostUpdateReleaseNotes &&
    shouldDiscardStalePendingReleaseNotes(
      pendingPostUpdateReleaseNotes.version,
      getCurrentAppVersionForUpdate(),
    )
  ) {
    logger.info(
      `[auto-update] discard stale post-update release notes pending=${pendingPostUpdateReleaseNotes.version} app=${getCurrentAppVersionForUpdate()}`,
    );
    await clearPendingPostUpdateReleaseNotes(
      settingService,
      "hydrate-pending-older-than-installed-app",
    );
  }

  if (
    pendingPostUpdateReleaseNotes &&
    isPendingReleaseNotesForFutureVersion(pendingPostUpdateReleaseNotes)
  ) {
    // When the user restarts the application after downloading it but not yet installing it, the memory ready state of electron-updater will be lost.
    // But the local pending package and version notes are still there. Here, use "pending version higher than current version" to restore the pending installation state.
    // Avoid being prompted to "download updates" when there is already a cache, and then being returned to idle with a dev staging error after clicking on it.
    readyUpdateVersion = pendingPostUpdateReleaseNotes.version;
    readyUpdateReleaseNotes = pendingPostUpdateReleaseNotes;
    readyUpdateRestoredFromPendingReleaseNotes = true;
    setAutoUpdaterMenuState(buildUpdateDownloadedState(readyUpdateVersion));
    logger.info(
      `[auto-update] restored ready update from pending release notes version=${readyUpdateVersion}`,
    );
  }
}

export function syncReadyUpdateToWindow(win: BrowserWindow) {
  if (!readyUpdateVersion || win.isDestroyed()) {
    return;
  }

  // update-downloaded may occur before the renderer React effect is hung up.
  // Happens even before the window reloads/opens a new window. Here "installable updates are available" is considered a persistent state.
  // Reissue once when the window is ready to prevent the button from being lost based on that transient event.
  logger.info(
    `[auto-update] sync ready update to window ${win.webContents.id}: ${readyUpdateVersion}`,
  );
  win.webContents.send(PlatformChannels.UpdateReady, readyUpdateVersion);
}

export function getAutoUpdaterState(): UpdateStatePayload {
  return menuState;
}

export function refreshAutoUpdaterReleaseChannel(
  receivePreviewUpdates: boolean,
  reason = "settings receivePreviewUpdates changed",
) {
  const nextChannel: ElectronReleaseChannel = receivePreviewUpdates ? "preview" : "stable";

  if (!canUseAutoUpdaterInCurrentRuntime()) {
    logger.info(`[auto-update] skip ${reason}: not packaged`);
    return;
  }

  if (menuState.kind === "download-progress" || menuState.kind === "update-downloaded") {
    logger.info(`[auto-update] skip ${reason}: state=${menuState.kind} channel=${nextChannel}`);
    return;
  }

  if (checkForUpdatesInFlight) {
    // The user may toggle the preview switch while the startup check has not yet completed.
    // AvailableUpdateChannel cannot be changed immediately, otherwise the old channel version will be marked as the new channel when the old request returns;
    // Only the channels to be refreshed are recorded here, and the manifest will be requested again after the current check is closed.
    pendingManifestReleaseChannelRefresh = nextChannel;
    logger.info(
      `[auto-update] defer ${reason}: check already in flight, next channel=${nextChannel}`,
    );
    return;
  }

  const currentChannel = getAutoUpdaterReleaseChannelForCurrentState();
  if (currentChannel === nextChannel) {
    logger.info(`[auto-update] skip ${reason}: channel unchanged (${nextChannel})`);
    return;
  }

  logger.info(
    `[auto-update] ${reason}: refresh manifest channel ${currentChannel} -> ${nextChannel}`,
  );
  availableUpdateChannel = nextChannel;
  clearAvailableUpdateState();
  setAutoUpdaterMenuState({ kind: "checking", enabled: false });
  const checkId = beginAutoUpdateCheck();
  autoUpdater
    .checkForUpdates()
    .catch((err) => {
      logger.error(`[auto-update] ${reason} check failed:`, err);
      setAutoUpdaterMenuState(
        readyUpdateVersion
          ? buildUpdateDownloadedState(readyUpdateVersion)
          : { kind: "idle", enabled: true },
      );
    })
    .finally(() => {
      finishAutoUpdateCheck(reason, checkId);
    });
}

export function syncAutoUpdaterStateToWindow(win: BrowserWindow) {
  if (win.isDestroyed()) {
    return;
  }

  win.webContents.send(PlatformChannels.UpdateStateChanged, menuState);
}

export function syncPostUpdateReleaseNotesToWindow(win: BrowserWindow) {
  if (!pendingPostUpdateReleaseNotes || win.isDestroyed()) {
    return;
  }

  if (isPendingReleaseNotesForFutureVersion(pendingPostUpdateReleaseNotes)) {
    // Pending release notes are written when the download is completed; if the version is still higher than the current app,
    // Note that the update has not yet been installed and cannot be sent to the renderer silently ack in advance as "post-installation notes".
    return;
  }

  const assignedWindow = findLiveWindowByWebContentsId(
    deliveredPostUpdateReleaseNotesWebContentsId,
  );
  if (assignedWindow && assignedWindow.webContents.id !== win.webContents.id) {
    return;
  }

  deliveredPostUpdateReleaseNotesWebContentsId = win.webContents.id;
  logger.info(
    `[auto-update] sync post-update release notes to window ${win.webContents.id}: ${pendingPostUpdateReleaseNotes.version}`,
  );
  win.webContents.send(PlatformChannels.PostUpdateReleaseNotes, pendingPostUpdateReleaseNotes);
}

export async function acknowledgePostUpdateReleaseNotes(
  version: string,
  settingService: SettingServiceLike,
) {
  if (!pendingPostUpdateReleaseNotes) {
    logger.info(
      `[auto-update] ignore release notes ack without pending payload version=${version}`,
    );
    return;
  }

  if (pendingPostUpdateReleaseNotes.version !== version) {
    logger.warn(
      `[auto-update] ignore release notes ack version mismatch expected=${pendingPostUpdateReleaseNotes.version} actual=${version}`,
    );
    return;
  }

  acknowledgedPostUpdateReleaseNotesVersions.add(version);
  await clearPendingPostUpdateReleaseNotes(settingService, "renderer-acknowledged");
}

export async function initAutoUpdater(options: InitAutoUpdaterOptions = {}): Promise<void> {
  if (options.enabled === false) {
    autoUpdaterDisabledForProductFlavor = true;
    if (autoUpdatePollTimer) {
      clearInterval(autoUpdatePollTimer);
      autoUpdatePollTimer = null;
    }
    logger.info("[auto-update] disabled for this desktop product flavor");
    return;
  }
  autoUpdaterDisabledForProductFlavor = false;
  if (!canUseAutoUpdaterInCurrentRuntime()) return;

  onBeforeQuitAndInstall = options.onBeforeQuitAndInstall;
  autoUpdaterSettingService = options.settingService;

  if (autoUpdatePollTimer) {
    clearInterval(autoUpdatePollTimer);
    autoUpdatePollTimer = null;
  }
  checkForUpdatesInFlight = false;
  activeAutoUpdateCheckId = null;
  activeAutoUpdateCheckChannel = null;
  settlingAutoUpdateCheckId = null;
  pendingManifestReleaseChannelRefresh = null;
  devAutoUpdateVersionOverride = null;
  availableUpdateChannel = "stable";
  clearAvailableUpdateState();
  clearDownloadingUpdateState();
  applyDevAutoUpdateRuntimeOverrides();

  logger.info(`[auto-update] initializing, current version: ${getCurrentAppVersionForUpdate()}`);

  // After the old version has been downloaded, when the feed continues to advance to a higher version, the main process must first compare the remote version and the ready version.
  // Then decide whether to download. If you continue to let electron-updater download automatically, it will only judge based on the current app version.
  // As a result, `3.1.3` may be downloaded repeatedly for each poll when `3.1.2` is ready `3.1.3`.
  autoUpdater.autoDownload = false;
  // Windows/NSIS will start the installation asynchronously after the window is closed; if the user shuts down immediately, the installer may be interrupted by the system.
  // Leaving a half-updated state and causing the next startup to fail.
  // Here, "automatic installation on exit" is only turned off on Windows, requiring the user to explicitly click update; other platforms maintain the original behavior to avoid changing the existing upgrade link.
  autoUpdater.autoInstallOnAppQuit = process.platform !== "win32";
  autoUpdater.logger = logger;
  applyManifestUpdateProvider(options);

  const triggerCheckForUpdates = (reason: string) => {
    if (checkForUpdatesInFlight) {
      logger.info(`[auto-update] skip ${reason}: check already in flight`);
      return;
    }

    // Even if the publishing link is changed to "install the package first, then the latest", the CDN may still take effect later than the client's polling rhythm.
    // If the checking/downloading phase continues to trigger checkForUpdates concurrently, the same update stream will be started repeatedly.
    // Causes invalid requests, noisy logs, and even overwrites the menu status seen by the user, so automatic polling only occurs when idle or
    // The update-downloaded state is entered; the latter continues to poll in order to discover a new version that replaces the downloaded version.
    if (reason === "poll" && !canPollForUpdatesFromState(menuState)) {
      logger.info(`[auto-update] skip ${reason}: state=${menuState.kind}`);
      return;
    }

    const checkId = beginAutoUpdateCheck();
    const checkForUpdatesPromise = options.settingService
      ? (async () => {
          await syncAutoUpdateCheckChannelFromSettings(checkId, options.settingService, reason);
          await autoUpdater.checkForUpdates();
        })()
      : autoUpdater.checkForUpdates();

    checkForUpdatesPromise
      .catch((err) => {
        // The strong update pop-up window may reuse the background check during the startup period; if checkForUpdates directly rejects and there is no subsequent error event,
        // Just writing the log will cause the pop-up window to stop at checking. Here, the failed convergence logic is reused to restore the state and feed it back to the strong update monitor.
        handleAutoUpdateFailure(err, `${reason} check failed`);
      })
      .finally(() => {
        finishAutoUpdateCheck(reason, checkId);
      });
  };

  autoUpdater.on("checking-for-update", () => {
    logger.info("[auto-update] checking for update...");
    setAutoUpdaterMenuState({ kind: "checking", enabled: false });
  });

  autoUpdater.on("update-available", (info: UpdateDownloadedInfoLike) => {
    logger.info(`[auto-update] new version available: ${info.version}`);
    const infoChannel = readUpdateInfoReleaseChannel(info);
    if (shouldIgnoreStaleAvailableUpdate(infoChannel)) {
      // When the user switches "Receive preview version", the manifest request from the old channel may be returned later than the new request.
      // If you continue to write menuState for old results, or end the current generation early, the independent update pop-up window will continue to display the old version/old release notes.
      logger.info(
        `[auto-update] ignore stale update channel=${infoChannel} expected=${activeAutoUpdateCheckChannel ?? availableUpdateChannel} version=${info.version}`,
      );
      return;
    }

    void settleAutoUpdateCheckResult("update available", async () => {
      if (!shouldDownloadAvailableUpdate(info.version)) {
        const readyVersion = readyUpdateVersion ?? info.version;
        logger.info(
          `[auto-update] keep downloaded update version=${readyVersion}; remote=${info.version}`,
        );
        setAutoUpdaterMenuState(buildUpdateDownloadedState(readyVersion));
        sendManualCheckResult({ kind: "ready", version: readyVersion });
        return;
      }

      const channel = infoChannel ?? availableUpdateChannel;
      if (await isSkippedUpdateVersion(info.version, channel, options.settingService)) {
        logger.info(
          `[auto-update] ignore skipped update channel=${channel} version=${info.version}`,
        );
        clearAvailableUpdateState();
        setAutoUpdaterMenuState({ kind: "idle", enabled: true });
        sendManualCheckResult({
          kind: "up-to-date",
          currentVersion: getCurrentAppVersionForUpdate(),
        });
        return;
      }

      availableUpdateReleaseNotes = toPostUpdateReleaseNotesPayload(info);
      if (readyUpdateRestoredFromPendingReleaseNotes) {
        // pendingPostUpdateReleaseNotes can only prove that "the download has been completed and the version notes have been persisted",
        // Unable to restore electron-updater downloadedUpdateHelper and Squirrel.Mac proxy server in the current process
        // or native staged update. When you encounter the manifest and confirm again that the same version is available, you must clear the pseudo ready.
        // Re-downloadUpdate to allow the cache hit/re-downloaded update-downloaded to establish the real installation context.
        clearReadyUpdateState();
      }
      setAutoUpdaterMenuState(
        buildUpdateAvailableState(info.version, availableUpdateReleaseNotes, channel),
      );

      if (activeForceAutoUpdateListener) {
        downloadAvailableUpdate("force-update");
        return;
      }

      if (await shouldAutoDownloadAndInstallUpdates(options.settingService)) {
        // Function reason: The automatic download preference belongs to the main process update state machine and cannot depend on whether the renderer pop-up window is open.
        // After an update is detected, the manual download entry is reused to keep cancellation, cache hit, and failure recovery behaviors completely consistent.
        downloadAvailableUpdate("auto-download");
        return;
      }

      sendManualCheckResult({
        kind: "available",
        version: info.version,
        channel,
        ...(availableUpdateReleaseNotes ? { releaseNotes: availableUpdateReleaseNotes } : {}),
      });
    }).catch((error) => {
      handleAutoUpdateFailure(error, "update available failed");
    });
  });

  autoUpdater.on("update-not-available", (info) => {
    void settleAutoUpdateCheckResult("update not available", () => {
      logger.info(
        `[auto-update] already up to date (local=${getCurrentAppVersionForUpdate()}, remote=${info.version})`,
      );
      if (readyUpdateVersion) {
        setAutoUpdaterMenuState(buildUpdateDownloadedState(readyUpdateVersion));
        sendManualCheckResult({ kind: "ready", version: readyUpdateVersion });
        return;
      }

      clearAvailableUpdateState();
      clearDownloadingUpdateState();
      setAutoUpdaterMenuState({ kind: "idle", enabled: true });
      // When the forced upgrade pop-up window reuses the startup check, it must also give closed-loop feedback when no updates are available to avoid stopping at checking.
      notifyForceAutoUpdate({
        kind: "error",
        message: getForceAutoUpdateNoUpdateMessage(),
      });
      sendManualCheckResult({
        kind: "up-to-date",
        currentVersion: getCurrentAppVersionForUpdate(),
      });
    });
  });

  autoUpdater.on("download-progress", (progress) => {
    // After the user quickly cancels the download, the electron-updater may also reissue the progress of the old download stream.
    // If you continue to receive this stale event, the UI will be pushed back from "updatable" to "downloading", which will look like it is stuck after cancellation.
    if (!downloadCancellationToken || downloadCancellationToken.cancelled) {
      return;
    }

    if (menuState.kind !== "download-progress" && menuState.kind !== "update-available") {
      return;
    }

    const normalizedProgress = normalizeProgressPercent(progress) ?? progress.percent.toFixed(0);
    logger.info(
      `[auto-update] download progress: ${progress.percent.toFixed(1)}% (${(progress.bytesPerSecond / 1024).toFixed(0)} KB/s, ${(progress.transferred / 1024 / 1024).toFixed(1)}/${(progress.total / 1024 / 1024).toFixed(1)} MB)`,
    );
    if (menuState.kind === "update-available") {
      clearAvailableUpdateState();
    }
    setAutoUpdaterMenuState(
      buildDownloadProgressState(normalizedProgress, {
        transferredBytes: progress.transferred,
        totalBytes: progress.total,
      }),
    );
    logForceAutoUpdateProgress(normalizedProgress);
    notifyForceAutoUpdate({
      kind: "downloading",
      ...(downloadingUpdateVersion ? { version: downloadingUpdateVersion } : {}),
      progress: normalizedProgress,
    });
  });

  autoUpdater.on("update-downloaded", (info: UpdateDownloadedInfoLike) => {
    readyUpdateVersion = info.version;
    readyUpdateRestoredFromPendingReleaseNotes = false;
    readyUpdateChannel = downloadingUpdateChannel ?? availableUpdateChannel;
    readyUpdateReleaseNotes =
      toPostUpdateReleaseNotesPayload(info) ?? downloadingUpdateReleaseNotes;
    clearAvailableUpdateState();
    clearDownloadingUpdateState();
    logger.info(
      `[auto-update] downloaded: ${info.version}, ${process.platform === "win32" ? "waiting for explicit install" : "ready to install on quit or explicit install"}`,
    );
    setAutoUpdaterMenuState(buildUpdateDownloadedState(info.version));
    notifyForceAutoUpdate({ kind: "ready", version: info.version });

    if (activeForceAutoUpdateListener) {
      notifyForceAutoUpdate({ kind: "installing" });
      void quitAndInstallUpdate();
    }

    if (options.settingService) {
      const releaseNotesPayload = readyUpdateReleaseNotes;
      const persistTask = releaseNotesPayload
        ? persistPendingPostUpdateReleaseNotes(
            options.settingService,
            releaseNotesPayload,
            "update-downloaded",
          )
        : clearPendingPostUpdateReleaseNotes(
            options.settingService,
            "update-downloaded-without-release-notes",
          );

      void persistTask.catch((error) => {
        logger.error("[auto-update] persist post-update release notes failed:", error);
      });
    }

    for (const win of BrowserWindow.getAllWindows()) {
      syncReadyUpdateToWindow(win);
    }
  });

  autoUpdater.on("error", (err) => {
    if (shouldIgnoreCancelledDownloadError(err)) {
      // electron-updater may reissue error("cancelled") asynchronously after canceling the download.
      // User cancellation has restored the status to retryable update-available, and late cancellation events can no longer clear the entry.
      logger.info("[auto-update] ignore delayed error from cancelled download");
      return;
    }

    void settleAutoUpdateCheckResult("error", () => {
      handleAutoUpdateFailure(err, "error");
    });
  });

  ipcMain.handle(PlatformChannels.QuitAndInstallUpdate, () =>
    // The renderer only knows that the installer is not taking over if IPC rejects. ready failed or
    // Failure to exit preparation cannot return a successful ACK, otherwise "restart to update" will remain pending forever.
    quitAndInstallUpdate(true),
  );
  ipcMain.on(PlatformChannels.QuitAndInstallUpdate, () => {
    void quitAndInstallUpdate();
  });
  ipcMain.handle(PlatformChannels.DownloadUpdate, () => {
    downloadAvailableUpdate("renderer");
  });
  ipcMain.handle(PlatformChannels.CancelUpdateDownload, () => {
    cancelDownloadingUpdate("renderer");
  });
  ipcMain.handle(PlatformChannels.SkipUpdateVersion, async (_event, version: unknown) => {
    const validatedVersion = typeof version === "string" ? version.trim() : "";
    if (!validatedVersion) {
      logger.warn("[auto-update] ignore empty skipped update version");
      return;
    }
    await skipAvailableUpdateVersion(validatedVersion, options.settingService);
  });

  triggerCheckForUpdates("startup");

  autoUpdatePollTimer = setInterval(() => {
    triggerCheckForUpdates("poll");
  }, AUTO_UPDATE_POLL_INTERVAL_MS);
  autoUpdatePollTimer.unref?.();
}

export function requestForceAutoUpdate(
  onStateChange: (state: ForceAutoUpdateState) => void,
  reason = "force-update",
  _minimumVersion?: string,
) {
  const dispose = () => {
    if (activeForceAutoUpdateListener === onStateChange) {
      activeForceAutoUpdateListener = null;
    }
  };

  activeForceAutoUpdateListener = onStateChange;
  forceAutoUpdateLastLoggedProgressBucket = null;
  logger.info(`[force-update] automatic update started reason=${reason}`);
  onStateChange({ kind: "checking" });

  if (!canUseAutoUpdaterInCurrentRuntime()) {
    const message = "not packaged";
    logger.info(`[force-update] automatic update skipped: ${message}`);
    onStateChange({ kind: "dev-skipped", message });
    return dispose;
  }

  if (menuState.kind === "update-downloaded") {
    onStateChange({ kind: "installing" });
    void quitAndInstallUpdate();
    return dispose;
  }

  if (menuState.kind === "update-available") {
    downloadAvailableUpdate("force-update");
    return dispose;
  }

  if (menuState.kind === "download-progress") {
    onStateChange({
      kind: "downloading",
      ...("version" in menuState && menuState.version ? { version: menuState.version } : {}),
      progress: menuState.progress,
    });
    return dispose;
  }

  if (checkForUpdatesInFlight) {
    logger.info(`[force-update] automatic update reused the in-flight update check`);
    return dispose;
  }

  const checkId = beginAutoUpdateCheck();
  setAutoUpdaterMenuState({ kind: "checking", enabled: false });
  autoUpdater
    .checkForUpdates()
    .catch((err) => {
      const message = err instanceof Error ? err.message : String(err);
      logger.error(`[auto-update] ${reason} check failed:`, err);
      setAutoUpdaterMenuState(
        readyUpdateVersion
          ? buildUpdateDownloadedState(readyUpdateVersion)
          : { kind: "idle", enabled: true },
      );
      onStateChange({ kind: "error", message });
    })
    .finally(() => {
      finishAutoUpdateCheck(reason, checkId);
    });

  return () => {
    if (activeForceAutoUpdateListener === onStateChange) {
      activeForceAutoUpdateListener = null;
    }
  };
}

export function checkForUpdateMenuClick(originWindow?: BrowserWindow | null) {
  logger.info("[auto-update] user clicked Check for Updates");

  const targetWindow =
    originWindow && !originWindow.isDestroyed()
      ? originWindow
      : (BrowserWindow.getFocusedWindow() ??
        BrowserWindow.getAllWindows().find((w) => !w.isDestroyed()) ??
        null);

  if (!targetWindow) {
    logger.warn("[auto-update] manual check: no target window to report to");
    return;
  }

  if (!canUseAutoUpdaterInCurrentRuntime()) {
    logger.info("[auto-update] skip manual check: not packaged");
    targetWindow.webContents.send(PlatformChannels.UpdateCheckResult, {
      kind: "dev-skipped",
    } satisfies UpdateCheckResultPayload);
    return;
  }

  if (autoUpdaterDisabledForProductFlavor) {
    // The entrance should have been hidden by product identity; this is the last gate to prevent uninitialized updater instances from making requests to the placeholder feed.
    logger.info("[auto-update] skip manual check: updater disabled for this product flavor");
    targetWindow.webContents.send(PlatformChannels.UpdateCheckResult, {
      kind: "dev-skipped",
    } satisfies UpdateCheckResultPayload);
    return;
  }

  if (menuState.kind === "update-downloaded") {
    // The menu text has been switched to "Restart to update". If it still only sends ready toast,
    // The update will not be installed when the user clicks on the system menu, but will be installed on the top button. The semantics of the two entries are inconsistent.
    // The installation logic behind the button is reused here, so that menu clicks actually trigger a restart of the installation.
    void quitAndInstallUpdate();
    return;
  }
  if (menuState.kind === "download-progress") {
    targetWindow.webContents.send(PlatformChannels.UpdateCheckResult, {
      kind: "already-downloading",
      version: downloadingUpdateVersion ?? readyUpdateVersion ?? "",
      progress: menuState.progress,
    } satisfies UpdateCheckResultPayload);
    return;
  }
  if (menuState.kind === "update-available") {
    targetWindow.webContents.send(PlatformChannels.UpdateCheckResult, {
      kind: "available",
      version: menuState.version,
      ...(menuState.channel ? { channel: menuState.channel } : {}),
      ...(menuState.releaseNotes ? { releaseNotes: menuState.releaseNotes } : {}),
    } satisfies UpdateCheckResultPayload);
    return;
  }

  if (checkForUpdatesInFlight) {
    logger.info("[auto-update] skip manual check: check already in flight");
    targetWindow.webContents.send(PlatformChannels.UpdateCheckResult, {
      kind: "error",
      message: "Update check already in progress.",
    } satisfies UpdateCheckResultPayload);
    return;
  }

  manualCheckWebContentsId = targetWindow.webContents.id;
  const manualCheckChannel = getAutoUpdaterReleaseChannelForCurrentState();
  // Windows self-drawn menus cannot just wait for the checking event of electron-updater.
  // In some environments, the menu will be reopened after the user clicks it. If the event has not yet been sent to the renderer, "Check for Updates" will still be displayed.
  // Here, before initiating manual inspection, a stable state is first set, and then download-progress is overwritten as a percentage.
  setAutoUpdaterMenuState({ kind: "checking", enabled: false });
  const checkId = beginAutoUpdateCheck();
  void (async () => {
    await clearSkippedUpdateVersionForManualCheck(manualCheckChannel, autoUpdaterSettingService);
    await autoUpdater.checkForUpdates();
  })()
    .catch((err) => {
      logger.error("[auto-update] manual check failed:", err);
      sendManualCheckResult({
        kind: "error",
        message: err instanceof Error ? err.message : String(err),
      });
    })
    .finally(() => {
      finishAutoUpdateCheck("manual check", checkId);
    });
}
